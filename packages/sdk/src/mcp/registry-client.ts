/**
 * The keyless read client for the Tab registry read API.
 *
 * `tab_discover` and `tab_status` answer questions about chain state -- which
 * Services are registered, what each tool costs, what an Agent owes -- and every
 * one of those answers is a public fact. Nothing here signs, nothing here
 * authenticates, and nothing here writes. That is why `tab connect` can wire a
 * client up without ever touching a key, and why `tab doctor` can check a
 * deployment end to end from a laptop that holds none.
 *
 * ## Why the read API rather than the chain
 *
 * A Credit Limit is not a storage slot. It is `LimitLib` recomputed over an
 * Agent's committed Settlement history and the Bond ledger, cross-checked
 * against `TabBook.creditLimit` at the same block before it is served. A Bond
 * figure is a replay of `Bond`'s own events, checked against `Bond.ledgerOf`. An
 * MCP server that read the chain directly would have to restate both, and a
 * second restatement that drifts from the first is worse than one source of
 * truth: it would put two different Credit Limits in front of the same model.
 * So the figures come from the one process that already computes and checks
 * them, and this client's whole job is to fetch and not to interpret.
 *
 * The consequence is stated rather than hidden: with no registry read API
 * configured, `tab_discover` and `tab_status` fail with `UPSTREAM` and say so.
 * `tab_call` does not go through here at all -- it reads its figures off the
 * Service's own charge headers -- so a model can still call and be metered while
 * the index is down.
 *
 * ## Structural web types
 *
 * This package compiles against ES2023 with no DOM types, so `fetch`, its
 * response, and the abort signal are described by the shapes this module
 * touches, exactly as `client-402.ts` does. A host `fetch`, `undici`, and a test
 * closure all satisfy {@link RegistryFetch} without any of them being named.
 *
 * Requirements: 24.1, 24.4, 25.1, 25.3
 */

import type { Result, TabError } from "@tabai/shared";
import { ok } from "@tabai/shared";

import { tabError, upstreamError, validationError } from "../errors.js";
import { defaultLogger, type Logger } from "../logger.js";
import { asString, isRecord } from "./json.js";

/** The two fields of a response this client reads. */
export interface RegistryResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

/** The `fetch` this client calls. A host `fetch` satisfies it as it stands. */
export type RegistryFetch = (url: string, init: Readonly<Record<string, unknown>>) => Promise<RegistryResponse>;

export interface RegistryReadClientOptions {
  /** Absolute base URL of the read API, with or without a trailing slash. */
  readonly baseUrl: string;
  readonly fetchImpl?: RegistryFetch;
  /** How long one read may take. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

/** Every read `tab_discover` and `tab_status` make, and nothing else. */
export interface RegistryReadClient {
  /** The base URL reads go to, normalised, so an error message can name it. */
  readonly baseUrl: string;
  /** `GET /healthz`, which is what `doctor` asks before it trusts anything else. */
  health(): Promise<Result<unknown>>;
  /** A page of registered Services, hydrated with prices, collections and Bond. */
  services(limit: number): Promise<Result<unknown>>;
  /** One Service, or `NOT_FOUND` when nothing ever registered under the id. */
  service(serviceId: string): Promise<Result<unknown>>;
  /** One Agent's credit picture per Asset. An address with no history is a 200 with empty arrays. */
  agent(address: string): Promise<Result<unknown>>;
  /** Verified Settlements, newest first, filtered by Agent and optionally by Asset. */
  settlements(query: SettlementQuery): Promise<Result<unknown>>;
  /** One Verified Settlement with its clearing lineage, named by its replay key. */
  settlement(replayKey: string): Promise<Result<unknown>>;
}

export interface SettlementQuery {
  readonly agent: string;
  /** The token address alone, which is how the index keys an Asset. */
  readonly asset?: string;
  readonly limit: number;
}

/** Drops a trailing slash so path joining never produces a double one. */
export const normaliseBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

/**
 * An abort signal that fires after `ms`, when the host has one.
 *
 * Described structurally rather than typed as `AbortSignal`, for the same reason
 * `fetch` is: no DOM types here. A host without `AbortSignal.timeout` gets no
 * signal and the read runs to whatever timeout its transport imposes, which is
 * worse than a bounded read but better than a failure to construct one.
 */
const timeoutSignal = (ms: number): unknown => {
  const ctor = (globalThis as { AbortSignal?: { timeout?: (ms: number) => unknown } }).AbortSignal;
  return typeof ctor?.timeout === "function" ? ctor.timeout(ms) : undefined;
};

const hostFetch = (): RegistryFetch | undefined => {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as RegistryFetch) : undefined;
};

const CATEGORIES = ["VALIDATION", "NOT_FOUND", "CONFLICT", "UPSTREAM", "CHAIN", "TIMEOUT", "INTERNAL"] as const;

/**
 * Reads the read API's own error body back into a `TabError`.
 *
 * Every route there fails with `{ error: { category, code, message } }` in this
 * package's own vocabulary, so a 404 for an unregistered serviceId arrives here
 * as `NOT_FOUND` / `SERVICE_NOT_REGISTERED` and reaches the model unchanged.
 * Rewriting it as a generic upstream failure would throw away the one part a
 * caller can act on.
 */
function upstreamFailure(url: string, status: number, body: unknown): Result<never> {
  const error = isRecord(body) ? body["error"] : undefined;
  if (isRecord(error)) {
    const category = asString(error["category"], "");
    if ((CATEGORIES as readonly string[]).includes(category)) {
      return {
        ok: false,
        error: tabError(
          category as TabError["category"],
          asString(error["code"], "REGISTRY_READ_FAILED"),
          asString(error["message"], `the registry read API answered ${status} for ${url}`),
          { details: { url, status } },
        ),
      };
    }
  }
  return upstreamError(
    "REGISTRY_READ_FAILED",
    `the registry read API answered ${status} for ${url}`,
    { retryable: status >= 500, details: { url, status } },
  );
}

/**
 * Builds the client.
 *
 * Construction is total, like every other factory in this package: an unusable
 * base URL is reported by the first read, which is the only place a caller can
 * act on it.
 */
export function createRegistryReadClient(options: RegistryReadClientOptions): RegistryReadClient {
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const logger = options.logger ?? defaultLogger;

  const get = async (pathname: string, query: Readonly<Record<string, string | undefined>> = {}): Promise<Result<unknown>> => {
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) {
      return validationError(
        "REGISTRY_URL_INVALID",
        `the registry read API base URL must be an absolute http or https URL, received \`${options.baseUrl}\``,
        { details: { baseUrl: options.baseUrl } },
      );
    }
    const send = options.fetchImpl ?? hostFetch();
    if (send === undefined) {
      return upstreamError(
        "FETCH_UNAVAILABLE",
        "this host has no global fetch; supply fetchImpl, or run on Node 20.10 or later",
      );
    }

    const search = Object.entries(query)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    const url = `${baseUrl}${pathname}${search === "" ? "" : `?${search}`}`;

    const signal = timeoutSignal(timeoutMs);
    let response: RegistryResponse;
    try {
      response = await send(url, {
        method: "GET",
        headers: { accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A transport failure and a timeout are the same shape here and different
      // things to a caller, so the category splits on the abort name.
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      logger.warn("registry read failed", { url, reason });
      // Both are UPSTREAM: the category vocabulary has no timeout of its own, and a
      // read API that answered nothing in time is an upstream failure whichever way
      // it failed. The code is what tells the two apart, and both are retryable.
      return timedOut
        ? upstreamError(
            "REGISTRY_READ_TIMEOUT",
            `the registry read API at ${url} did not answer within ${timeoutMs}ms`,
            { retryable: true, details: { url, timeoutMs } },
          )
        : upstreamError("REGISTRY_UNREACHABLE", `the registry read API at ${url} could not be reached: ${reason}`, {
            retryable: true,
            details: { url },
          });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return upstreamError(
        "REGISTRY_BODY_UNREADABLE",
        `the registry read API at ${url} answered ${response.status} with a body that is not JSON: ${reason}`,
        { details: { url, status: response.status } },
      );
    }

    if (response.status < 200 || response.status >= 300) return upstreamFailure(url, response.status, body);
    return ok(body);
  };

  return {
    baseUrl,
    health: () => get("/healthz"),
    services: (limit) => get("/services", { limit: String(limit) }),
    service: (serviceId) => get(`/services/${encodeURIComponent(serviceId.toLowerCase())}`),
    agent: (address) => get(`/agents/${encodeURIComponent(address.toLowerCase())}`),
    settlements: (query) =>
      get("/settlements", {
        agent: query.agent.toLowerCase(),
        asset: query.asset?.toLowerCase(),
        limit: String(query.limit),
      }),
    settlement: (replayKey) => get(`/settlements/${encodeURIComponent(replayKey.toLowerCase())}`),
  };
}
