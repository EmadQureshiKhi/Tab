/**
 * Nansen address labels, the off-chain risk overlay on the Agent read.
 *
 * ## What it is and where it sits
 *
 * Nansen labels addresses by what they are known to be: an exchange deposit, a
 * fund, a bridge, a contract deployer, a behavioural pattern. None of that is
 * on chain and none of it is checkable against Monad, so it is served as exactly
 * what it is, an overlay with a named source and a fetch time, beside the indexed
 * facts and never mixed into them. A reader deciding whether to extend credit to
 * an address gets the chain's own history from the rest of the response and this
 * as context.
 *
 * ## The endpoint
 *
 * ## Labels are the credits door, and there is another
 *
 * Nansen's API has two. Most of it takes an API key against a credit balance,
 * and `/profiler/address/labels` is behind that one only: without a key it
 * answers `401 … This endpoint does not support paid access`, and with a spent
 * one it answers `403 insufficient_credits`, which this module reports as
 * itself rather than as a rejected key.
 *
 * Several other endpoints answer `402` with an x402 offer instead, payable in
 * USDC on Monad Mainnet at a cent a call, with no account and no credits. That
 * is the door the gateway's `/hub/nansen` mount fronts for an Agent, and
 * `scripts/nansen-x402.mjs` walks it directly. Labels are not on it, so this
 * module stays on the key.
 *
 * `POST https://api.nansen.ai/api/v1/profiler/address/labels` with the key in
 * the `apikey` header, as Nansen's authentication guide names it, and a body of
 * `{ address, chain, pagination }`. `chain` is one of Nansen's slugs; `all`
 * searches every chain that shares the address format, which for an EVM key is
 * the useful question, because an address known as an exchange on Ethereum is
 * the same key on Monad. The response is `{ pagination, data: [{ label,
 * category?, kind? }] }`, and a label whose `kind` includes `entity` names the
 * entity the address belongs to.
 *
 * ## What is served
 *
 * `{ source: "nansen", chain, fetchedAt, labels, entity? }` on success, and
 * `{ source: "nansen", unavailable: { code, message } }` on anything else,
 * including the absence of a key. An empty `labels` array is served only when
 * Nansen answered and had nothing to say, which is a fact about the address; an
 * unanswered question is never served as an empty list.
 *
 * ## The cache and the key
 *
 * Answers are cached in memory for ten minutes per address, and failures for
 * thirty seconds so a rate limit or an outage is not amplified by page views.
 * The key is read once into a closure and appears in no log line, no error
 * message and no response: every message built here is built from the status and
 * the body, never from the request.
 */

import { causeOf } from "@tabai/shared";

export const NANSEN_LABELS_URL = "https://api.nansen.ai/api/v1/profiler/address/labels";

/**
 * The machine-readable reason inside a refusal body, where there is one.
 *
 * Read defensively: the body is another service's and may be anything, and a
 * refusal that cannot be parsed is still a refusal. Returns undefined rather
 * than guessing.
 */
async function creditCode(response: { json(): Promise<unknown> }): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body?.code === "string" ? body.code : undefined;
  } catch {
    return undefined;
  }
}

export type NansenUnavailableCode =
  | "NANSEN_KEY_MISSING"
  | "NANSEN_UNAUTHORISED"
  | "NANSEN_NO_CREDITS"
  | "NANSEN_RATE_LIMITED"
  | "NANSEN_UPSTREAM_ERROR"
  | "NANSEN_TIMEOUT"
  | "NANSEN_FETCH_FAILED"
  | "NANSEN_MALFORMED_RESPONSE";

export interface NansenLabel {
  readonly label: string;
  readonly category?: string;
  readonly kind?: readonly string[];
}

export type LabelsView =
  | {
      readonly source: "nansen";
      readonly chain: string;
      readonly fetchedAt: string;
      readonly labels: readonly NansenLabel[];
      readonly entity?: string;
    }
  | {
      readonly source: "nansen";
      readonly unavailable: { readonly code: NansenUnavailableCode; readonly message: string };
    };

export interface LabelSource {
  labelsFor(address: string): Promise<LabelsView>;
}

export interface NansenOptions {
  readonly apiKey: string;
  /** Nansen's chain slug, `all` for every chain sharing the address format. */
  readonly chain: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly successTtlMs?: number;
  readonly failureTtlMs?: number;
  readonly now?: () => number;
  readonly url?: string;
}

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_SUCCESS_TTL_MS = 10 * 60 * 1000;
const DEFAULT_FAILURE_TTL_MS = 30 * 1000;
/** Nansen pages at 100 by default; a single address rarely carries more, and 1000 is the cap. */
const PER_PAGE = 1000;

/** The source served when no key is configured. A constant, so it can never be confused with an answer. */
export const NANSEN_KEY_MISSING: LabelSource = {
  async labelsFor(): Promise<LabelsView> {
    return {
      source: "nansen",
      unavailable: {
        code: "NANSEN_KEY_MISSING",
        message: "no NANSEN_API_KEY is configured, so no labels were looked up",
      },
    };
  },
};

const unavailable = (code: NansenUnavailableCode, message: string): LabelsView => ({
  source: "nansen",
  unavailable: { code, message },
});

/**
 * Narrows the response body to the documented shape, or returns `null`.
 *
 * Only `label` is required by Nansen's schema. `category` and `kind` are carried
 * when present and typed as documented; anything else is dropped rather than
 * passed through, so the served shape is the one this module promises.
 */
export function parseLabelsBody(body: unknown): readonly NansenLabel[] | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const labels: NansenLabel[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as { label?: unknown; category?: unknown; kind?: unknown };
    if (typeof record.label !== "string") return null;
    const label: NansenLabel = {
      label: record.label,
      ...(typeof record.category === "string" ? { category: record.category } : {}),
      ...(Array.isArray(record.kind) && record.kind.every((kind) => typeof kind === "string")
        ? { kind: record.kind as string[] }
        : {}),
    };
    labels.push(label);
  }
  return labels;
}

/** The entity a label set names, when one of its labels is of kind `entity`. */
export function entityOf(labels: readonly NansenLabel[]): string | undefined {
  return labels.find((label) => label.kind?.includes("entity"))?.label;
}

export function createNansenLabels(options: NansenOptions): LabelSource {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const successTtl = options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS;
  const failureTtl = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const url = options.url ?? NANSEN_LABELS_URL;
  const chain = options.chain;
  // Held in the closure and nowhere else. Nothing below interpolates it.
  const apiKey = options.apiKey;

  const cache = new Map<string, { readonly until: number; readonly view: LabelsView }>();
  const inFlight = new Map<string, Promise<LabelsView>>();

  const fetchOnce = async (address: string): Promise<LabelsView> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json", apikey: apiKey },
        body: JSON.stringify({ address, chain, pagination: { page: 1, per_page: PER_PAGE } }),
      });
      if (response.status === 401 || response.status === 403) {
        // A 403 is two different facts wearing one status: a key Nansen does
        // not accept, and a key it accepts with nothing left to spend. They
        // need different things done about them, so the body's own code is
        // read and each is reported as itself. A body that says neither is
        // reported as the status, which is all that can honestly be said.
        const reason = await creditCode(response);
        if (reason === "insufficient_credits") {
          return unavailable(
            "NANSEN_NO_CREDITS",
            "Nansen answered 403: the key is accepted and has no credits left to spend on this endpoint",
          );
        }
        return unavailable("NANSEN_UNAUTHORISED", `Nansen answered ${response.status}: the configured key was not accepted`);
      }
      if (response.status === 429) {
        return unavailable("NANSEN_RATE_LIMITED", "Nansen answered 429: the key's rate limit is exhausted");
      }
      if (!response.ok) {
        return unavailable("NANSEN_UPSTREAM_ERROR", `Nansen answered ${response.status}`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return unavailable("NANSEN_MALFORMED_RESPONSE", "Nansen's body was not JSON");
      }
      const labels = parseLabelsBody(body);
      if (labels === null) {
        return unavailable("NANSEN_MALFORMED_RESPONSE", "Nansen's body did not carry a data array of labels");
      }
      const entity = entityOf(labels);
      return {
        source: "nansen",
        chain,
        fetchedAt: new Date(now()).toISOString(),
        labels,
        ...(entity === undefined ? {} : { entity }),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return unavailable("NANSEN_TIMEOUT", `Nansen did not answer within ${timeoutMs} ms`);
      }
      // The error's class only, never its message: a transport error can quote
      // the request it was building, and the request carries the key.
      return unavailable("NANSEN_FETCH_FAILED", `Nansen could not be reached (${causeOf(error).code})`);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async labelsFor(address: string): Promise<LabelsView> {
      const key = address.toLowerCase();
      const cached = cache.get(key);
      if (cached !== undefined && cached.until > now()) return cached.view;
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
      const promise = fetchOnce(key)
        .then((view) => {
          cache.set(key, { until: now() + ("unavailable" in view ? failureTtl : successTtl), view });
          return view;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    },
  };
}
