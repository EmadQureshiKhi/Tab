/**
 * The ERC-8004 agent card: the registration file an `agentURI` resolves to,
 * fetched over HTTP with a short timeout and a small cache.
 *
 * ## What is fetched, and what is not
 *
 * The specification allows any URI scheme. Three are served here: `https:`,
 * fetched as is; `data:application/json`, decoded in process, which is how a
 * fully on-chain card is stored; and `ipfs:`, rewritten to a public gateway. Any
 * other scheme, `http:` included, is reported as unsupported rather than fetched,
 * because this process makes outbound requests on a caller's behalf and an
 * unencrypted one carries whatever a network in between wants it to.
 *
 * The body is capped and parsed as JSON. A card is served as whatever JSON it
 * was, not validated against the registration schema: the registry proves that
 * the URI belongs to the agent, and this service reports what was found there.
 * Validating it would turn a malformed card into an absent one, which hides
 * rather than informs.
 *
 * ## The cache
 *
 * In memory, keyed by URI, for ten minutes on success and one minute on failure.
 * A card is descriptive and slow-moving, and a Dashboard reloading an Agent page
 * should not turn into a fetch per reload against somebody else's origin.
 * Failures are remembered briefly for the same reason in the other direction: an
 * origin that is down should not be hammered by every page view.
 */

import { causeOf } from "@tabai/shared";

/** Why a card could not be served. Every code names one specific cause. */
export type CardUnavailableCode =
  | "CARD_URI_EMPTY"
  | "CARD_SCHEME_UNSUPPORTED"
  | "CARD_TIMEOUT"
  | "CARD_FETCH_FAILED"
  | "CARD_HTTP_ERROR"
  | "CARD_TOO_LARGE"
  | "CARD_NOT_JSON";

export interface CardUnavailable {
  readonly code: CardUnavailableCode;
  readonly message: string;
}

export type CardResult =
  | { readonly ok: true; readonly value: unknown; readonly fetchedAt: string }
  | { readonly ok: false; readonly error: CardUnavailable };

export interface CardFetcher {
  fetch(uri: string): Promise<CardResult>;
}

export interface CardFetcherOptions {
  /** `globalThis.fetch` unless a test supplies its own. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly successTtlMs?: number;
  readonly failureTtlMs?: number;
  readonly ipfsGateway?: string;
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_SUCCESS_TTL_MS = 10 * 60 * 1000;
const DEFAULT_FAILURE_TTL_MS = 60 * 1000;
const DEFAULT_IPFS_GATEWAY = "https://ipfs.io/ipfs/";

const unavailable = (code: CardUnavailableCode, message: string): CardResult => ({
  ok: false,
  error: { code, message },
});

/**
 * Decodes a `data:` URI carrying JSON, base64 or percent-encoded, or explains why
 * it could not be.
 */
export function decodeDataUri(uri: string): CardResult {
  const match = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(uri);
  if (match === null) return unavailable("CARD_NOT_JSON", "data: URI is malformed");
  const mediaType = (match[1] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && mediaType !== "") {
    return unavailable("CARD_NOT_JSON", `data: URI carries ${mediaType}, not application/json`);
  }
  const payload = match[3] ?? "";
  try {
    const text = match[2] === undefined ? decodeURIComponent(payload) : Buffer.from(payload, "base64").toString("utf8");
    return { ok: true, value: JSON.parse(text) as unknown, fetchedAt: new Date().toISOString() };
  } catch (error) {
    return unavailable("CARD_NOT_JSON", `data: URI did not decode to JSON: ${causeOf(error).message}`);
  }
}

/** The URL a card URI is fetched from, or `null` when the scheme is not one this service fetches. */
export function fetchableUrl(uri: string, ipfsGateway: string): string | null {
  if (/^https:\/\//i.test(uri)) return uri;
  const ipfs = /^ipfs:\/\/(.+)$/i.exec(uri);
  if (ipfs !== null) return `${ipfsGateway}${ipfs[1]}`;
  return null;
}

export function createCardFetcher(options: CardFetcherOptions = {}): CardFetcher {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const successTtl = options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS;
  const failureTtl = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
  const gateway = options.ipfsGateway ?? DEFAULT_IPFS_GATEWAY;
  const now = options.now ?? (() => Date.now());

  const cache = new Map<string, { readonly until: number; readonly result: CardResult }>();
  const inFlight = new Map<string, Promise<CardResult>>();

  const remember = (uri: string, result: CardResult): CardResult => {
    cache.set(uri, { until: now() + (result.ok ? successTtl : failureTtl), result });
    return result;
  };

  const fetchOnce = async (uri: string): Promise<CardResult> => {
    if (uri.trim().length === 0) return unavailable("CARD_URI_EMPTY", "the agent has no URI set");
    if (/^data:/i.test(uri)) return decodeDataUri(uri);
    const url = fetchableUrl(uri, gateway);
    if (url === null) {
      return unavailable("CARD_SCHEME_UNSUPPORTED", "only https:, ipfs: and data:application/json URIs are fetched");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
        redirect: "follow",
      });
      if (!response.ok) {
        return unavailable("CARD_HTTP_ERROR", `the card's origin answered ${response.status}`);
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > maxBytes) {
        return unavailable("CARD_TOO_LARGE", `the card is ${declared} bytes and the cap is ${maxBytes}`);
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) {
        return unavailable("CARD_TOO_LARGE", `the card exceeds the ${maxBytes} byte cap`);
      }
      try {
        return { ok: true, value: JSON.parse(text) as unknown, fetchedAt: new Date().toISOString() };
      } catch {
        return unavailable("CARD_NOT_JSON", "the card's body is not JSON");
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return unavailable("CARD_TIMEOUT", `the card's origin did not answer within ${timeoutMs} ms`);
      }
      return unavailable("CARD_FETCH_FAILED", `the card could not be fetched: ${causeOf(error).message}`);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async fetch(uri: string): Promise<CardResult> {
      const cached = cache.get(uri);
      if (cached !== undefined && cached.until > now()) return cached.result;
      const pending = inFlight.get(uri);
      if (pending !== undefined) return pending;
      const promise = fetchOnce(uri)
        .then((result) => remember(uri, result))
        .finally(() => inFlight.delete(uri));
      inFlight.set(uri, promise);
      return promise;
    },
  };
}
