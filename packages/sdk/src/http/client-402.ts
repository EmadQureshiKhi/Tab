/**
 * The HTTP 402 client wrapper (R23.2).
 *
 * ## Tab is post-paid, so a 402 is not a demand for prepayment
 *
 * This is the one thing to understand about this file. A `402` from a Tab Service
 * does not mean "pay now and I will then serve you". Work is delivered first and
 * metered after (R23.3); the charge lands on the Open Tab as an accrual, and the
 * Agent settles later, asynchronously, on Ethereum, with its own keys, through
 * the payment-strategy seam. So:
 *
 * - the **normal** metered response is a `200` carrying the charge block, and
 *   this client records the accrual and hands the response straight back;
 * - a `402` is issued on `LimitExceeded` alone — the Agent has no headroom left
 *   for that Asset. It is a credit decision, not an invoice;
 * - on a `402` the client records what the Service says the call requires, sends
 *   the original request **once** more carrying `Tab-Agent` and
 *   `Tab-Authorisation`, and stops. Not a retry loop, and not a backoff.
 *
 * **Nothing in this file settles.** There is no signer here, no strategy call, no
 * transaction, and no allowance. A settlement step inside the 402 handler would
 * be the prepay model Tab exists to replace, and it would also be wrong on the
 * facts: a Settlement is only useful once it has been proven on Creditcoin, which
 * takes an attestation and cannot happen inside one request.
 *
 * ## Why a repeat at all, if the charge already landed
 *
 * Two cases, and the repeat serves both. On the ordinary path the first attempt
 * may have reached a Service that could not identify the Agent — a caller that
 * built its own headers, a proxy that dropped them — and the repeat carries the
 * identity headers explicitly. On the `LimitExceeded` path an accrual may have
 * cleared between the two attempts: a Provisional Clearing restores headroom the
 * moment the Watcher observes a Settlement, well before it is confirmed
 * (R15.1), so the second attempt is genuinely a different question rather than
 * the same one asked louder. Exactly one repeat, because a second `402` means the
 * headroom is not coming back within the life of this request, and looping would
 * only meter the Service's rejection path.
 *
 * ## Zero-throw, everywhere
 *
 * Every fallible call returns a `Result` (R21.5, design section 13.1). A transport
 * failure, a response object that is not one, a malformed header, a partial charge
 * block, an unreplayable request body, a `402` that stands after the repeat — all
 * of them are `err` values carrying an error category. Nothing here throws,
 * including the consumer's own `onCharge` callback, which is called inside a guard
 * so a consumer's bug cannot fail a request that succeeded.
 *
 * Requirements: 23.2, 21.5
 */

import { causeOf, isAddress, isBytes32, ok, wrap, type Address, type Bytes32, type Result } from "@tabai/shared";
import { defaultLogger, type Logger } from "../logger.js";
import { fail, upstreamError, validationError } from "../errors.js";
import {
  agentRequestHeaders,
  chargedAssetKey,
  headerReaderOf,
  parseChargeHeaders,
  type ChargeBlock,
  type ChargedAsset,
  type HeaderReader,
  type HeaderRecord,
} from "./headers.js";

/**
 * What the caller may put on a request.
 *
 * A near-mirror of the standard `RequestInit` rather than an import of it, because
 * `@tabai/sdk` compiles against the ES2023 library alone and must not acquire a DOM
 * or `undici` type dependency to describe a request. The index signature carries
 * every option this client does not read — `signal`, `redirect`, `cache`,
 * `keepalive`, a dispatcher — through to the host `fetch` untouched.
 */
export interface Tab402RequestInit {
  readonly method?: string;
  /** A plain object, a `Headers`, or an array of pairs. Merged with the Tab headers. */
  readonly headers?: HeaderReader | HeaderRecord | readonly (readonly [string, string])[];
  readonly body?: unknown;
  readonly [option: string]: unknown;
}

/** The request this client hands to its `fetch`: the caller's options, with headers resolved. */
export interface Tab402FetchInit {
  readonly headers: Readonly<Record<string, string>>;
  readonly [option: string]: unknown;
}

/**
 * The little of a response this client reads.
 *
 * Structural for the same reason as {@link Tab402RequestInit}, and loose on
 * purpose: `body` and `bodyUsed` are `unknown` and duck-checked at runtime, so a
 * real `Response` from any host satisfies this without the two type worlds having
 * to agree. Widen it through the type parameter of {@link createTab402Client} when
 * the caller supplies a typed `fetch`, and `client.fetch` then returns
 * `Result<Response>` with every method of the real thing intact.
 */
export interface Tab402Response {
  readonly status: number;
  readonly headers: HeaderReader | HeaderRecord;
  readonly body?: unknown;
  readonly bodyUsed?: unknown;
}

/** The `fetch` this client calls. The host's global `fetch` is the default. */
export type Tab402Fetch<Res extends Tab402Response> = (
  url: string,
  init: Tab402FetchInit,
) => Promise<Res>;

/** Whether the charge the Service reported landed on the Open Tab. */
export type ChargeOutcome =
  /** The call was served and metered. The Open Tab now carries this amount. */
  | "accrued"
  /**
   * `LimitExceeded`: the amount is what the call *requires* and it did not land,
   * because the Agent's headroom for the Asset does not cover it.
   */
  | "declined";

/** One charge block, read off one response, in the client's own terms. */
export interface ChargeAccrued {
  /** The Agent this call was metered against. */
  readonly agent: Address;
  /** The absolute URL that was called. */
  readonly url: string;
  /** The HTTP status the charge block arrived on. */
  readonly status: number;
  readonly outcome: ChargeOutcome;
  /** Integer Asset base units: charged on `accrued`, required on `declined`. */
  readonly amount: bigint;
  readonly asset: ChargedAsset;
  readonly serviceId: Bytes32;
  readonly tool: Bytes32;
  /** The Open Tab the Service reported after this call. */
  readonly openTab: bigint;
  /** The headroom the Service reported for this Agent and Asset. */
  readonly headroom: bigint;
  readonly authorisation?: Bytes32;
  /**
   * The strategy the Agent intends to settle this Asset through, if the client was
   * given one. Carried for the later, separate settlement path and used by nothing
   * here.
   */
  readonly strategyId?: string;
  /** `1` for the original request, `2` for the repeat. */
  readonly attempt: 1 | 2;
  /** Milliseconds since the epoch, when the header was read. */
  readonly observedAt: number;
}

/** What this client believes about one Asset's tab, from headers alone. */
export interface TabSnapshot {
  readonly asset: ChargedAsset;
  /** The Open Tab most recently reported for this Asset. */
  readonly openTab: bigint;
  /** The headroom most recently reported for this Asset. */
  readonly headroom: bigint;
  /** Sum of every charge that landed, across the client's lifetime. */
  readonly accrued: bigint;
  /** Sum of every charge refused for want of headroom. Never part of {@link accrued}. */
  readonly declined: bigint;
  readonly accruedCount: number;
  readonly declinedCount: number;
  readonly observedAt: number;
}

export interface Tab402ClientOptions<Res extends Tab402Response = Tab402Response> {
  /** Absolute base URL. A relative path handed to `fetch` resolves against it. */
  readonly baseUrl: string;
  /** The Agent's Creditcoin address, sent as `Tab-Agent`. */
  readonly agent: Address;
  /** The authKey to meter against, sent as `Tab-Authorisation` when supplied. */
  readonly authorisation?: Bytes32;
  /** Called for every charge block read, on the 200 path and the 402 path alike. */
  readonly onCharge?: (charge: ChargeAccrued) => void;
  /**
   * `1` repeats the original request once after a `402`; `0` repeats nothing.
   *
   * Typed as the two values it can hold rather than as a `number`, because "repeat
   * once" is the semantics rather than a default: a caller who wrote `5` would be
   * asking for a retry loop against a credit decision, and a number that silently
   * clamped to `1` would leave them believing they had one.
   */
  readonly maxRetries?: 0 | 1;
  /** Recorded on each accrual for the later settlement path. Never used to settle here. */
  readonly strategyId?: string;
  /** Defaults to the host's global `fetch`. */
  readonly fetchImpl?: Tab402Fetch<Res>;
  readonly logger?: Logger;
  /** Injectable clock, so `observedAt` is testable. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * How many accruals {@link Tab402Client.charges} keeps. Defaults to 128.
   *
   * Trimming the list never touches the totals in {@link TabSnapshot}, which are
   * running sums, so a long-lived client keeps exact accounting on bounded memory.
   */
  readonly maxChargeHistory?: number;
}

export interface Tab402Client<Res extends Tab402Response = Tab402Response> {
  /**
   * Sends a request, records whatever charge the response reports, and repeats
   * once on a `402`.
   *
   * `input` may be absolute or relative to `baseUrl`. Returns the response the
   * Service produced — this client never rewrites a status, so a `500` from the
   * Service comes back as `ok(response)` for the caller to read. The `err` cases
   * are this client's own: a bad URL, a malformed charge block, a transport
   * failure, or a `402` that still stands after the repeat.
   */
  fetch(input: string, init?: Tab402RequestInit): Promise<Result<Res>>;
  /** Every charge block read, oldest first, up to `maxChargeHistory`. */
  charges(): readonly ChargeAccrued[];
  /** One snapshot per Asset seen, in first-seen order. */
  tabs(): readonly TabSnapshot[];
  tabOf(asset: ChargedAsset): TabSnapshot | undefined;
}

interface LedgerEntry {
  asset: ChargedAsset;
  openTab: bigint;
  headroom: bigint;
  accrued: bigint;
  declined: bigint;
  accruedCount: number;
  declinedCount: number;
  observedAt: number;
}

/**
 * Builds the client.
 *
 * Construction is total: it cannot fail and returns a client, not a `Result`.
 * Every fallible thing — an unusable `baseUrl`, an `agent` that is not an
 * address, a host with no `fetch` — is reported by the call that needs it, which
 * is the only place a caller can act on it. This matches
 * `createEthereumUsdcStrategy` and keeps the SDK's two factories the same shape.
 */
export function createTab402Client<Res extends Tab402Response = Tab402Response>(
  options: Tab402ClientOptions<Res>,
): Tab402Client<Res> {
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => Date.now());
  const maxRetries = options.maxRetries ?? 1;
  const historyLimit = options.maxChargeHistory ?? 128;

  const history: ChargeAccrued[] = [];
  const ledger = new Map<string, LedgerEntry>();

  const record = (
    block: ChargeBlock,
    outcome: ChargeOutcome,
    url: string,
    status: number,
    attempt: 1 | 2,
  ): ChargeAccrued => {
    const observedAt = now();
    const charge: ChargeAccrued = {
      agent: options.agent,
      url,
      status,
      outcome,
      amount: block.amount,
      asset: block.asset,
      serviceId: block.serviceId,
      tool: block.tool,
      openTab: block.openTab,
      headroom: block.headroom,
      ...(options.authorisation === undefined ? {} : { authorisation: options.authorisation }),
      ...(options.strategyId === undefined ? {} : { strategyId: options.strategyId }),
      attempt,
      observedAt,
    };

    const key = chargedAssetKey(block.asset);
    const entry = ledger.get(key) ?? {
      asset: block.asset,
      openTab: 0n,
      headroom: 0n,
      accrued: 0n,
      declined: 0n,
      accruedCount: 0,
      declinedCount: 0,
      observedAt,
    };
    // The Open Tab and the headroom are the Service's figures, not sums of ours:
    // a Settlement or a Provisional Clearing moves both without this client
    // seeing a request, so the latest report replaces rather than adds.
    entry.openTab = block.openTab;
    entry.headroom = block.headroom;
    entry.observedAt = observedAt;
    if (outcome === "accrued") {
      entry.accrued += block.amount;
      entry.accruedCount += 1;
    } else {
      entry.declined += block.amount;
      entry.declinedCount += 1;
    }
    ledger.set(key, entry);

    history.push(charge);
    if (history.length > historyLimit && historyLimit >= 0) {
      history.splice(0, history.length - historyLimit);
    }

    if (options.onCharge !== undefined) {
      // A consumer callback is code this package did not write, and a throw from
      // it must not fail a call that otherwise succeeded.
      try {
        options.onCharge(charge);
      } catch (error) {
        logger.warn("onCharge threw and the charge was recorded anyway", {
          url,
          outcome,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return charge;
  };

  const attempt = async (
    url: string,
    init: Tab402FetchInit,
    send: Tab402Fetch<Res>,
    ordinal: 1 | 2,
  ): Promise<Result<{ readonly response: Res; readonly charge?: ChargeAccrued }>> => {
    const sent = await wrap(
      async () => send(url, init),
      (error) => ({
        category: "UPSTREAM",
        code: "FETCH_FAILED",
        message: `the request to ${url} did not complete`,
        retryable: true,
        details: { url, attempt: ordinal },
        cause: causeOf(error),
      }),
    );
    if (!sent.ok) return sent;

    const response = sent.value;
    if (!looksLikeResponse(response)) {
      return upstreamError(
        "FETCH_RESPONSE_INVALID",
        `the fetch given to this client returned something that is not a response for ${url}`,
        { details: { url, attempt: ordinal } },
      );
    }

    const block = parseChargeHeaders(headerReaderOf(response.headers));
    if (!block.ok) {
      discard(response, logger);
      return block;
    }

    if (block.value === undefined) {
      if (response.status === 402) {
        discard(response, logger);
        return validationError(
          "CHARGE_HEADERS_MISSING",
          `${url} answered 402 with no Tab charge headers; a 402 on this rail is a LimitExceeded credit decision and must name the required amount and the current headroom`,
          { details: { url, attempt: ordinal, status: 402 } },
        );
      }
      return ok({ response });
    }

    const charge = record(
      block.value,
      response.status === 402 ? "declined" : "accrued",
      url,
      response.status,
      ordinal,
    );
    return ok({ response, charge });
  };

  return {
    async fetch(input: string, init: Tab402RequestInit = {}): Promise<Result<Res>> {
      if (maxRetries !== 0 && maxRetries !== 1) {
        return validationError(
          "MAX_RETRIES_UNSUPPORTED",
          `maxRetries is ${String(maxRetries)}; this client repeats a 402 exactly once or not at all, because a 402 here is a credit decision and no number of immediate retries clears it`,
        );
      }
      if (!isAddress(options.agent)) {
        return validationError(
          "AGENT_INVALID",
          `agent must be the Agent's 20-byte 0x Creditcoin address, received \`${String(options.agent)}\``,
        );
      }
      if (options.authorisation !== undefined && !isBytes32(options.authorisation)) {
        return validationError(
          "AUTHORISATION_INVALID",
          `authorisation must be a 32-byte 0x authKey, received \`${String(options.authorisation)}\``,
        );
      }

      const url = resolveUrl(options.baseUrl, input);
      if (!url.ok) return url;

      const identity = agentRequestHeaders(options.agent, options.authorisation);
      if (!identity.ok) return identity;

      const supplied = normaliseHeaders(init.headers);
      if (!supplied.ok) return supplied;

      const send = options.fetchImpl ?? hostFetch<Res>();
      if (typeof send !== "function") {
        return upstreamError(
          "FETCH_UNAVAILABLE",
          "this host has no global fetch; supply fetchImpl, or run on Node 20.10 or later",
        );
      }

      // The caller's own headers win over the Tab headers: a caller metering a
      // second Agent on one call said so deliberately, and silently overriding it
      // would charge the wrong tab.
      const headers = { ...identity.value, ...supplied.value };
      const requestInit: Tab402FetchInit = { ...init, headers };

      const first = await attempt(url.value, requestInit, send, 1);
      if (!first.ok) return first;
      if (first.value.response.status !== 402) return ok(first.value.response);

      const declined = first.value.charge;
      if (maxRetries === 0) {
        discard(first.value.response, logger);
        return limitExceeded(url.value, declined, 1);
      }

      if (!isReplayable(init.body)) {
        discard(first.value.response, logger);
        return validationError(
          "REQUEST_BODY_NOT_REPLAYABLE",
          `${url.value} answered 402 and the request body is a stream, which cannot be sent a second time; buffer the body before calling, or set maxRetries to 0 and handle the credit decision yourself`,
          { details: { url: url.value } },
        );
      }

      // The 402's body is of no use to anyone and would otherwise hold a socket.
      discard(first.value.response, logger);

      const second = await attempt(url.value, requestInit, send, 2);
      if (!second.ok) return second;
      if (second.value.response.status !== 402) return ok(second.value.response);

      discard(second.value.response, logger);
      return limitExceeded(url.value, second.value.charge ?? declined, 2);
    },

    charges: () => [...history],

    tabs: () => [...ledger.values()].map(snapshotOf),

    tabOf(asset: ChargedAsset): TabSnapshot | undefined {
      const entry = ledger.get(chargedAssetKey(asset));
      return entry === undefined ? undefined : snapshotOf(entry);
    },
  };
}

/** The read-only view of one ledger entry. */
const snapshotOf = (entry: LedgerEntry): TabSnapshot => ({
  asset: entry.asset,
  openTab: entry.openTab,
  headroom: entry.headroom,
  accrued: entry.accrued,
  declined: entry.declined,
  accruedCount: entry.accruedCount,
  declinedCount: entry.declinedCount,
  observedAt: entry.observedAt,
});

/**
 * Whether what the `fetch` returned is a response at all.
 *
 * A duck check rather than an `instanceof`: a caller's `fetch` may come from
 * `undici`, from a test double, or from a runtime whose `Response` is a different
 * class than this process's, and none of those should be refused. Only `status`
 * and `headers` are checked, because they are the only two fields this client
 * reads.
 */
function looksLikeResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { status?: unknown; headers?: unknown };
  return (
    typeof candidate.status === "number" &&
    typeof candidate.headers === "object" &&
    candidate.headers !== null
  );
}

/**
 * The `LIMIT` failure a standing `402` becomes.
 *
 * `retryable` is false, and deliberately: the condition does clear, but it clears
 * when the Agent settles and the Watcher observes it, not after an interval. A
 * caller told to retry would spin against a Service that is answering correctly.
 * The detail keys are the ones the MCP tools report on `LIMIT_EXCEEDED` (R21.5).
 */
function limitExceeded(url: string, charge: ChargeAccrued | undefined, attempts: 1 | 2): Result<never> {
  const detail =
    charge === undefined
      ? {}
      : {
          requiredBaseUnits: charge.amount.toString(10),
          headroomBaseUnits: charge.headroom.toString(10),
          openTabBaseUnits: charge.openTab.toString(10),
          asset: chargedAssetKey(charge.asset),
          serviceId: charge.serviceId,
          tool: charge.tool,
        };
  const shortfall =
    charge === undefined
      ? ""
      : ` It requires ${charge.amount.toString(10)} base units of ${chargedAssetKey(charge.asset)} and the Agent has ${charge.headroom.toString(10)} of headroom left.`;
  return fail(
    "LIMIT",
    "LIMIT_EXCEEDED",
    `${url} answered 402 after ${attempts === 1 ? "one attempt with no repeat requested" : "both attempts"}.${shortfall} Settle an Open Tab to restore headroom; repeating the request will not.`,
    { retryable: false, details: { url, attempts, ...detail } },
  );
}

/** Resolves `input` against `baseUrl`, accepting an absolute `input` unchanged. */
function resolveUrl(baseUrl: string, input: string): Result<string> {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
    return validationError("BASE_URL_INVALID", "baseUrl must be a non-empty absolute URL");
  }
  if (typeof input !== "string" || input.length === 0) {
    return validationError("REQUEST_URL_INVALID", "fetch() needs a URL or a path relative to baseUrl");
  }
  const base = safeUrl(baseUrl, undefined);
  if (base === undefined) {
    return validationError(
      "BASE_URL_INVALID",
      `baseUrl \`${baseUrl}\` is not an absolute URL; it needs a scheme and a host`,
      { details: { baseUrl } },
    );
  }
  const resolved = safeUrl(input, base);
  if (resolved === undefined) {
    return validationError(
      "REQUEST_URL_INVALID",
      `\`${input}\` does not resolve to a URL against baseUrl \`${baseUrl}\``,
      { details: { baseUrl, input } },
    );
  }
  return ok(resolved);
}

/** The one place a `URL` constructor's throw is contained. */
function safeUrl(value: string, base: string | undefined): string | undefined {
  try {
    return base === undefined ? new URL(value).toString() : new URL(value, base).toString();
  } catch {
    return undefined;
  }
}

/**
 * Flattens whatever header shape the caller passed into a plain object.
 *
 * Three shapes are accepted because all three are what a caller already holds: a
 * plain object, a `Headers` instance, and an array of pairs. Anything else is a
 * `VALIDATION` error rather than a silent drop, because a dropped `Content-Type`
 * turns a working request into a puzzling one.
 */
function normaliseHeaders(value: unknown): Result<Record<string, string>> {
  if (value === undefined || value === null) return ok({});

  const flat: Record<string, string> = {};

  if (Array.isArray(value)) {
    for (const [index, pair] of (value as readonly unknown[]).entries()) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        return validationError(
          "REQUEST_HEADERS_INVALID",
          `init.headers[${index}] is not a [name, value] pair`,
          { details: { index } },
        );
      }
      const name: unknown = pair[0];
      const headerValue: unknown = pair[1];
      if (typeof name !== "string" || typeof headerValue !== "string") {
        return validationError(
          "REQUEST_HEADERS_INVALID",
          `init.headers[${index}] must be a pair of strings`,
          { details: { index } },
        );
      }
      flat[name] = headerValue;
    }
    return ok(flat);
  }

  if (typeof value !== "object") {
    return validationError(
      "REQUEST_HEADERS_INVALID",
      `init.headers must be an object, a Headers, or an array of [name, value] pairs, received ${typeof value}`,
    );
  }

  const iterable = value as { forEach?: unknown };
  if (typeof iterable.forEach === "function") {
    // A `Headers`: iteration yields (value, name), in that order.
    const failed = collectHeaders(value as HeadersLike, flat);
    if (failed !== undefined) return failed;
    return ok(flat);
  }

  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (headerValue === undefined || headerValue === null) continue;
    if (Array.isArray(headerValue)) {
      flat[name] = headerValue.join(", ");
      continue;
    }
    if (typeof headerValue !== "string" && typeof headerValue !== "number" && typeof headerValue !== "bigint") {
      return validationError(
        "REQUEST_HEADERS_INVALID",
        `init.headers[${JSON.stringify(name)}] must be a string, received ${typeof headerValue}`,
        { details: { header: name } },
      );
    }
    flat[name] = String(headerValue);
  }
  return ok(flat);
}

interface HeadersLike {
  forEach(callback: (value: string, name: string) => void): void;
}

/** Drains a `Headers`-like into `flat`, returning an error result if it throws. */
function collectHeaders(headers: HeadersLike, flat: Record<string, string>): Result<never> | undefined {
  try {
    headers.forEach((headerValue, name) => {
      flat[name] = headerValue;
    });
    return undefined;
  } catch (error) {
    return upstreamError("REQUEST_HEADERS_INVALID", "init.headers could not be read", {
      cause: causeOf(error),
    });
  }
}

/**
 * Whether a body can be sent a second time.
 *
 * A string, a byte view, a `URLSearchParams`, a `Blob`, a `FormData`, and nothing
 * at all all replay. A `ReadableStream` and an async iterable do not: the first
 * attempt consumed them, and a repeat would send an empty body while the Service
 * answered as if the caller had meant it. So the repeat is refused with a reason
 * instead.
 */
function isReplayable(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body !== "object") return true;
  const candidate = body as { getReader?: unknown; [Symbol.asyncIterator]?: unknown };
  if (typeof candidate.getReader === "function") return false;
  if (typeof candidate[Symbol.asyncIterator] === "function") return false;
  return true;
}

/**
 * Releases a response this client is not handing back.
 *
 * A discarded response with an unread body holds its connection open until the
 * runtime collects it, which on a busy Agent is a socket leak rather than an
 * inconvenience. Failure to cancel is logged and swallowed: the request already
 * has its answer.
 */
function discard(response: Tab402Response, logger: Logger): void {
  const body = response.body as { cancel?: unknown } | null | undefined;
  if (body === null || body === undefined || typeof body.cancel !== "function") return;
  if (response.bodyUsed === true) return;
  try {
    const cancelled = (body.cancel as () => unknown)();
    if (typeof (cancelled as { catch?: unknown })?.catch === "function") {
      (cancelled as Promise<unknown>).catch((error: unknown) => {
        logger.debug("discarded response body could not be cancelled", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  } catch (error) {
    logger.debug("discarded response body could not be cancelled", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The host's global `fetch`.
 *
 * The single cast in this module, and the reason it is needed: this package
 * compiles against the ES2023 library alone, so the global `fetch` has no type
 * here to line up with {@link Tab402Fetch}. The runtime check above the cast is
 * what makes it safe, and a host without `fetch` becomes an `UPSTREAM` error
 * rather than a `TypeError`.
 */
function hostFetch<Res extends Tab402Response>(): Tab402Fetch<Res> | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== "function") return undefined;
  return candidate as Tab402Fetch<Res>;
}
