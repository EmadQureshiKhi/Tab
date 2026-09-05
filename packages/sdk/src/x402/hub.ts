/**
 * Monad's API Hub, read as a list of tools a fronting Service can sell on credit.
 *
 * The Hub fronts pay-per-request providers behind one x402 endpoint,
 * `POST https://x402.monid.ai/v1/run`, and publishes what each provider offers
 * at `https://api.monid.ai/public/v1/endpoints?provider=<provider>`. Every
 * endpoint there carries a display name, a description, a USD price and the
 * networks its payment is accepted on. This module fetches that manifest and
 * reduces it to what `tab_discover` shows: the Hub endpoints as tools of the
 * Service fronting them.
 *
 * ## Prices are the Hub's word, not Tab's
 *
 * A Hub price is a decimal USD figure. The Asset a fronting Service meters in is
 * a six-decimal dollar stablecoin, so the figure is also rendered as base units
 * of one, for a per-call price. A per-result or per-unit price depends on the
 * response and is reported with the rate alone: the metered amount is whatever
 * the upstream's `402` asks for on the day, plus the Service's margin, and the
 * manifest is a catalogue, never a quote.
 */

import { causeOf, ok, wrap, type Result } from "@tabai/shared";

import { upstreamError, validationError } from "../errors.js";
import { asArray, asNumber, asRecord, asString, asStringOrNull, field, isRecord } from "../mcp/json.js";

/** Where the Hub publishes its manifest. */
export const API_HUB_MANIFEST_URL = "https://api.monid.ai/public/v1/endpoints";

/** The one x402 endpoint every Hub provider is called through. */
export const API_HUB_RUN_URL = "https://x402.monid.ai/v1/run";

/** How a Hub endpoint is priced. The Hub may add kinds; unknown ones are carried as they came. */
export type HubPriceType = "PER_CALL" | "PER_RESULT" | "PER_UNIT" | "PER_UNIT_MATRIX" | (string & {});

export interface HubEndpoint {
  readonly provider: string;
  readonly providerName: string | null;
  /** The provider-relative path, for example `/get_current_weather`. */
  readonly endpoint: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly priceType: HubPriceType;
  /** The manifest's decimal USD figure, as text. Null when the manifest carries none. */
  readonly priceUsd: string | null;
  /** The same figure in six-decimal base units, for a per-call price. Null otherwise. */
  readonly priceBaseUnits: string | null;
  /** CAIP-2 networks the Hub accepts payment on, for example `eip155:143`. */
  readonly networks: readonly string[];
  readonly categories: readonly string[];
  readonly tags: readonly string[];
}

export interface HubManifest {
  readonly provider: string;
  readonly endpoints: readonly HubEndpoint[];
  /** What the manifest said it holds for the provider, which may exceed the pages fetched. */
  readonly total: number;
}

/** The little of a fetch this module needs. */
export interface HubFetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type HubFetch = (url: string, init: { readonly method: "GET"; readonly headers: Readonly<Record<string, string>> }) => Promise<HubFetchResponse>;

export interface FetchHubManifestOptions {
  readonly provider: string;
  /** Defaults to {@link API_HUB_MANIFEST_URL}. */
  readonly manifestUrl?: string;
  readonly fetchImpl?: HubFetch;
  /** Pages followed through the manifest's cursor. Defaults to 5, at 100 endpoints a page. */
  readonly maxPages?: number;
}

/** Fetches one provider's manifest, following its cursor. */
export async function fetchHubManifest(options: FetchHubManifestOptions): Promise<Result<HubManifest>> {
  const provider = options.provider.trim();
  if (provider.length === 0 || !/^[a-z0-9][a-z0-9._-]*$/i.test(provider)) {
    return validationError("HUB_PROVIDER_INVALID", `\`${options.provider}\` is not a Hub provider slug`, {
      details: { provider: options.provider },
    });
  }
  const send = options.fetchImpl ?? hostFetch();
  if (send === undefined) {
    return upstreamError("FETCH_UNAVAILABLE", "this host has no global fetch; supply fetchImpl, or run on Node 20.10 or later");
  }
  const base = options.manifestUrl ?? API_HUB_MANIFEST_URL;
  const maxPages = options.maxPages ?? 5;

  const endpoints: HubEndpoint[] = [];
  let total = 0;
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const url = pageUrl(base, provider, cursor);
    if (!url.ok) return url;
    const fetched = await wrap(
      async () => send(url.value, { method: "GET", headers: { accept: "application/json" } }),
      (error) => ({
        category: "UPSTREAM" as const,
        code: "HUB_MANIFEST_UNREACHABLE",
        message: `the API Hub manifest at ${base} did not answer`,
        retryable: true,
        details: { provider },
        cause: causeOf(error),
      }),
    );
    if (!fetched.ok) return fetched;
    if (fetched.value.status < 200 || fetched.value.status >= 300) {
      return upstreamError("HUB_MANIFEST_REFUSED", `the API Hub manifest answered ${fetched.value.status} for provider ${provider}`, {
        retryable: fetched.value.status >= 500,
        details: { provider, status: fetched.value.status },
      });
    }
    const body = await wrap(
      async () => fetched.value.json(),
      (error) => ({
        category: "UPSTREAM" as const,
        code: "HUB_MANIFEST_INVALID",
        message: "the API Hub manifest is not JSON",
        retryable: false,
        details: { provider },
        cause: causeOf(error),
      }),
    );
    if (!body.ok) return body;
    if (!isRecord(body.value) || !Array.isArray(body.value["items"])) {
      return upstreamError("HUB_MANIFEST_INVALID", "the API Hub manifest carries no `items` array", { details: { provider } });
    }
    total = asNumber(body.value["total"], total);
    for (const item of asArray(body.value["items"])) {
      const endpoint = toHubEndpoint(item, provider);
      if (endpoint !== undefined) endpoints.push(endpoint);
    }
    const next = asStringOrNull(body.value["cursor"]);
    if (next === null || next.length === 0) break;
    cursor = next;
  }
  return ok({ provider, endpoints, total: Math.max(total, endpoints.length) });
}

function pageUrl(base: string, provider: string, cursor: string | undefined): Result<string> {
  try {
    const url = new URL(base);
    url.searchParams.set("provider", provider);
    url.searchParams.set("limit", "100");
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    return ok(url.toString());
  } catch {
    return validationError("HUB_MANIFEST_URL_INVALID", `\`${base}\` is not an absolute URL`, { details: { manifestUrl: base } });
  }
}

/** One manifest item, or nothing when it names no endpoint. */
function toHubEndpoint(item: unknown, provider: string): HubEndpoint | undefined {
  const endpoint = asString(field(item, "endpoint"), "");
  if (endpoint.length === 0) return undefined;
  const price = asRecord(field(item, "price"));
  const priceType = asString(price["type"], "PER_CALL");
  const priceUsd = usdText(field(price["amount"], "value"));
  return {
    provider: asString(field(item, "provider"), provider),
    providerName: asStringOrNull(field(item, "providerDisplayName")),
    endpoint,
    name: asStringOrNull(field(item, "displayName")),
    description: asStringOrNull(field(item, "displayDescription")),
    priceType,
    priceUsd,
    priceBaseUnits: priceType === "PER_CALL" && priceUsd !== null ? usdToBaseUnits(priceUsd) : null,
    networks: asArray(field(item, "supportedX402Networks")).map((entry) => asString(entry, "")).filter((entry) => entry.length > 0),
    categories: asArray(field(item, "categories")).map((entry) => asString(entry, "")).filter((entry) => entry.length > 0),
    tags: asArray(field(item, "tags")).map((entry) => asString(entry, "")).filter((entry) => entry.length > 0),
  };
}

/**
 * The manifest's price as plain decimal text.
 *
 * A JSON number smaller than a millionth prints with an exponent, `1e-7`, and
 * an exponent is not a price anyone can read or parse into base units. Twelve
 * fixed decimals cover any USD figure the Hub lists, and the trailing zeros go.
 */
function usdText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Number.isInteger(value) ? value.toString(10) : value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (typeof value === "string" && /^[0-9]+(\.[0-9]+)?$/.test(value.trim())) return value.trim();
  return null;
}

/**
 * A decimal USD figure as six-decimal base units, as text.
 *
 * String arithmetic, because the figure came out of JSON as a double and this
 * is the last place it can be turned into an exact integer before it is shown
 * beside a Tab price that always was one. Anything finer than six decimals is
 * rounded up: a catalogue must not understate a price.
 */
export function usdToBaseUnits(usd: string): string | null {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(usd.trim());
  if (match === null || match[1] === undefined) return null;
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "").padEnd(6, "0");
  const kept = BigInt(fraction.slice(0, 6));
  const remainder = fraction.slice(6);
  const roundUp = /[1-9]/.test(remainder) ? 1n : 0n;
  return (whole * 1_000_000n + kept + roundUp).toString(10);
}

function hostFetch(): HubFetch | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as HubFetch) : undefined;
}
