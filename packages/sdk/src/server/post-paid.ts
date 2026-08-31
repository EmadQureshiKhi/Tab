/**
 * The server-side post-paid plugin: it accrues, and it never gates.
 *
 * ## The inversion, stated once
 *
 * The handler runs. The handler produces its response. The response goes out.
 * Only then is the delivered work metered into the Open Tab. Nothing in this file
 * awaits a payment, a Settlement, a proof, or a signature before a response is
 * released, because a plugin that did would be the prepay model this rail exists
 * to replace. Metering is a record of work already delivered (R23.3, R12.1).
 *
 * Two orderings ship, and the difference is exactly one `await`:
 *
 * | `release` | what happens | can this request see a 402? |
 * | --- | --- | --- |
 * | `after-metering` (default) | handler resolves, the delivery is recorded, then the response is released carrying its charge headers | yes |
 * | `before-metering` | handler resolves, the response is released, the delivery is recorded behind it | no — the response has already gone |
 *
 * `after-metering` is the default because a `LimitExceeded` refusal can only reach
 * the caller on the request that caused it, and design section 9.5 asks for that
 * refusal. What it holds the response for is a single credit record, not a
 * payment, and it holds it for nothing else: if metering fails for any reason
 * that is not the Agent's to fix, the handler's own response is delivered
 * unchanged. A Service whose billing is broken pays for the delivery. It does not
 * hand the cost to the caller.
 *
 * `before-metering` is there for a Service that will not accept even that much
 * latency, and it is the shape that makes the guarantee observable: the response
 * is returned while the metering promise is still pending.
 *
 * ## 402 is the exception, not the path
 *
 * The normal path is 200, delivery recorded, charge headers attached. `402`
 * happens on `LimitExceeded` alone — the Agent's Open Tab for the Asset has no
 * headroom for this charge, which is a credit decision and not a prepayment
 * demand. When it happens the body carries the required amount and the current
 * headroom, and the same figures go out as headers, so the 402 client of design
 * section 9.4 reads a refusal with the identical parser it uses on a success.
 *
 * Two other refusals also reach the Agent, because only the Agent can clear them:
 * a missing, lapsed, or spent spending authorisation (403), and a tab that went
 * past its Settlement Window (409). Neither is a 402. Every other refusal in
 * `metering.ts`'s table is the Service's to fix and never changes what the caller
 * receives.
 *
 * ## Header contract
 *
 * The wire format is defined once, in `src/http/headers.ts`, and this plugin is
 * its emitting half: every header it writes goes through `formatChargeHeaders`,
 * which is the same module the 402 client parses with. So there is one definition
 * of `Tab-Charge-Amount`, one of `Tab-Charge-Asset`, and no second string-building
 * routine here to drift away from it. Three consequences are this side's to state:
 *
 * **The six charge headers are one all-or-nothing block.** `Tab-Charge-Amount`,
 * `Tab-Charge-Asset`, `Tab-Charge-Service`, `Tab-Charge-Tool`, `Tab-Open-Tab`, and
 * `Tab-Headroom` go out together or not at all, because a client cannot complete a
 * partial block by guessing and a missing header is not a zero. A response with
 * none of them is simply not a metered response.
 *
 * **A `402` carries the whole block, which is why the metering seam has a second
 * method.** `LimitExceeded` reverts with the requested amount and the headroom and
 * says nothing about the Open Tab, so the plugin reads it through
 * `TabBookClient.openTabOf` — a view call, truthful precisely because the metering
 * transaction reverted and moved nothing. Where that read fails, the refusal goes
 * out with no charge headers rather than with an invented figure, and its body
 * still names the required amount and the headroom.
 *
 * **A 403 or 409 refusal carries no charge block.** `AuthorisationMissing`,
 * `AuthorisationExpired`, `AuthorisationExceeded`, and `TabIsDelinquent` revert
 * with no headroom figure, so there is no complete block to send. The body carries
 * the required amount, the reason, and the action.
 *
 * `Tab-Agent` and `Tab-Authorisation` are read from the request. Both are claims,
 * and neither is an authentication. `TabBook` derives the authKey itself from
 * `(agent, serviceId, asset)`, so `Tab-Authorisation` cannot redirect a charge: it
 * is the Agent's statement about which authorisation it expects to be metered
 * against, available on the charge for logging and carrying no authority. Metering
 * is bounded by the on-chain authorisation the Agent set, and a Service that needs
 * the `Tab-Agent` claim authenticated does that in `agentOf`.
 *
 * Requirements: 23.3, 12.1, 12.2, 12.3, 21.5
 */

import { isAddress, isBytes32, type Address, type Bytes32, type Hex, type TabError } from "@tabai/shared";
import { defaultLogger, type Logger } from "../logger.js";
import { tabError } from "../errors.js";
import type { AssetRef } from "../payments/strategy.js";
import {
  TAB_HEADER,
  chargedAssetKey,
  formatChargeHeaders,
  type ChargeBlock,
  type ChargedAsset,
  type HeaderReader,
} from "../http/headers.js";
import {
  classifyRecordDeliveryRevert,
  detailAmount,
  dispositionOf,
  refusalStatusOf,
  type DeliveryReceipt,
  type MeteredDelivery,
  type TabBookClient,
} from "./metering.js";

/**
 * The request, reduced to what pricing and Agent identification need.
 *
 * Structural, and the body is not part of it. A web-standard `Request` satisfies
 * this as it stands, and the Express adapter builds one from `req` without
 * touching the stream — because buffering a request body to price it would take
 * the body away from the framework that owns it.
 */
export interface MeteredRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: HeaderReader;
}

/**
 * The response, reduced to what the billability decision needs.
 *
 * A web-standard `Response` satisfies it, and so does an Express `res`, which is
 * why the metering core never mentions `Response` at all.
 */
export interface DeliveredResponse {
  readonly status: number;
}

/**
 * What the Service charges for this call.
 *
 * A deliberate superset of design section 9.5's `{ tool, units }`.
 * `recordDelivery` takes an `expectedUnitPrice` and reverts
 * `PriceListChangedMidCall` when it disagrees with the applied price list, so a
 * plugin that cannot state the price it quoted cannot call the contract at all.
 * The field is required rather than optional for the same reason: there is no
 * sensible default, and a zero would be read as a free tool.
 */
export interface PriceQuote {
  /** The named priced unit, as the 32-byte word the applied price list is keyed by. */
  readonly tool: Bytes32;
  /** Count of priced units. A positive integer inside `uint32`. */
  readonly units: number;
  /** Base units per unit of `tool`, exactly as quoted to the Agent. */
  readonly unitPrice: bigint;
}

/** One recorded charge, as the Service's own logging and hooks see it. */
export interface MeteredCharge {
  readonly agent: Address;
  readonly serviceId: Bytes32;
  readonly asset: AssetRef;
  /**
   * The 32-byte word the applied price list is keyed by, and what
   * `Tab-Charge-Tool` carries. The word rather than a decoded name, because it is
   * what round-trips back into a contract call unchanged.
   */
  readonly tool: Bytes32;
  readonly units: number;
  readonly unitPrice: bigint;
  /** `units * unitPrice`, as the contract computed it. */
  readonly amount: bigint;
  readonly openTabAfter: bigint;
  readonly headroomAfter: bigint;
  /** Whatever the Agent claimed in `Tab-Authorisation`, when it claimed anything. */
  readonly authorisationClaim?: string;
  readonly creditcoinTxHash?: Hex;
  readonly recordedAt: number;
}

/** Why a request was not metered. Never an error: none of these is a failure. */
export type NotMeteredReason =
  /** No `Tab-Agent` header and no `agentOf`, so there is nobody to charge. */
  | "no-agent"
  /** `Tab-Agent` was present and was not a 20-byte address. */
  | "agent-malformed"
  /** `priceOf` returned nothing: the Service does not charge for this request. */
  | "not-priced"
  /** `priceOf` returned a quote that cannot be metered, such as zero units. */
  | "price-invalid"
  /** `billable` said this response is not a delivery — by default, any status at or above 400. */
  | "not-billable"
  /** The handler threw, so no delivery happened and nothing is charged for. */
  | "handler-failed";

export interface ChargedOutcome {
  readonly kind: "charged";
  readonly charge: MeteredCharge;
  readonly receipt: DeliveryReceipt;
  /** The `Tab-*` headers this charge puts on the response. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface NotMeteredOutcome {
  readonly kind: "not-metered";
  readonly reason: NotMeteredReason;
  readonly detail: string;
}

/** The body of a refusal. Amounts are decimal integer base-unit strings. */
export interface RefusalBody {
  readonly ok: false;
  readonly error: {
    readonly category: string;
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly agent: Address;
  readonly serviceId: Bytes32;
  readonly asset: string;
  readonly tool: string;
  /** Base units this call needed. Present on every refusal: it is the charge that was refused. */
  readonly requiredBaseUnits: string;
  /** Base units of headroom left. Present when the refusal reported one. */
  readonly headroomBaseUnits?: string;
  /** What the Agent has to do about it. */
  readonly action: string;
}

/** A refusal the Agent has to clear. The response is replaced by it. */
export interface RefusedOutcome {
  readonly kind: "refused";
  readonly error: TabError;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: RefusalBody;
  readonly context: RefusalContext;
}

/** Metering failed and the response is delivered anyway. */
export interface MeteringFailedOutcome {
  readonly kind: "failed";
  readonly error: TabError;
}

export type MeteringOutcome =
  | ChargedOutcome
  | NotMeteredOutcome
  | RefusedOutcome
  | MeteringFailedOutcome;

/** Everything a refusal handler needs to write its own response. */
export interface RefusalContext {
  readonly request: MeteredRequest;
  readonly agent: Address;
  readonly serviceId: Bytes32;
  readonly asset: AssetRef;
  readonly quote: PriceQuote;
  /** Base units this call needed: `units * unitPrice`. */
  readonly requiredBaseUnits: bigint;
  /** Base units of headroom the refusal reported, when it reported one. */
  readonly headroomBaseUnits?: bigint;
  readonly error: TabError;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: RefusalBody;
}

/** A `LimitExceeded` refusal, where the headroom is always known. */
export interface LimitExceededContext extends RefusalContext {
  readonly headroomBaseUnits: bigint;
}

/** A metering failure the caller never sees. The Service does. */
export interface MeteringFailureContext {
  readonly request: MeteredRequest;
  readonly error: TabError;
  readonly agent?: Address;
  readonly quote?: PriceQuote;
}

/** When the delivered response is released relative to the metering call. */
export type ReleaseOrder = "after-metering" | "before-metering";

export interface TabPostPaidOptions {
  readonly serviceId: Bytes32;
  readonly asset: AssetRef;
  /**
   * What this request costs, or nothing when the Service does not charge for it.
   *
   * Called once, after the handler has produced its response, with the method,
   * URL, and headers of the request. Consumer code, so a throw is caught and read
   * as "not priced" rather than allowed to take down a delivered response.
   */
  readonly priceOf: (request: MeteredRequest) => PriceQuote | undefined | null;
  readonly tabBook: TabBookClient;
  /** Defaults to `after-metering`, the only ordering in which a 402 can reach this request. */
  readonly release?: ReleaseOrder;
  /**
   * Identifies the Agent. Defaults to the `Tab-Agent` request header.
   *
   * Supply this to authenticate the claim — a signature, a session, an API key
   * mapped to a bound address. The plugin does not authenticate it, and a Service
   * that needs it authenticated does it here.
   */
  readonly agentOf?: (request: MeteredRequest) => string | undefined | null;
  /**
   * Whether a response counts as a delivery worth charging for. Defaults to
   * `status < 400`.
   *
   * The policy this default states: an Agent is not charged for a response that
   * failed. A 5xx is the Service's fault and a 4xx delivered nothing the Agent
   * asked for. A Service that meters attempts rather than deliveries — a rate
   * limiter, say — overrides it.
   */
  readonly billable?: (response: DeliveredResponse, request: MeteredRequest) => boolean;
  readonly onCharge?: (charge: MeteredCharge) => void;
  /** Replaces the default 402. Called only for `LimitExceeded`. */
  readonly onLimitExceeded?: (context: LimitExceededContext) => Response;
  /** Replaces the default response for any other refusal the Agent must clear. */
  readonly onRefused?: (context: RefusalContext) => Response | undefined;
  /** Where a metering failure the caller never sees is reported. */
  readonly onMeteringFailed?: (context: MeteringFailureContext) => void;
  readonly logger?: Logger;
  /** Injectable clock, so `recordedAt` is testable. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * What `execute` did.
 *
 * `delivered` is the ordinary outcome and covers every case in which the
 * handler's own response is what goes out: charged, not metered, and metering
 * failed. `metering` resolves when the recording finished, which under
 * `before-metering` is after the response was already returned.
 */
export type PostPaidExecution =
  | {
      readonly kind: "delivered";
      readonly response: Response;
      readonly metering: Promise<MeteringOutcome>;
    }
  | {
      readonly kind: "refused";
      readonly response: Response;
      readonly outcome: RefusedOutcome;
    }
  | {
      readonly kind: "handler-failed";
      readonly thrown: unknown;
      readonly error: TabError;
    };

/** The framework-free plugin the three adapters are thin wrappers over. */
export interface PostPaidPlugin {
  readonly serviceId: Bytes32;
  readonly asset: AssetRef;
  readonly release: ReleaseOrder;
  /**
   * Records the delivery for a response the caller already holds.
   *
   * Never throws and never rejects, whatever a consumer callback or a
   * {@link TabBookClient} does.
   */
  meter(request: MeteredRequest, response: DeliveredResponse): Promise<MeteringOutcome>;
  /**
   * Runs the handler, then meters. The handler is awaited to completion before
   * any metering call is made, always.
   */
  execute(request: MeteredRequest, handler: () => Response | Promise<Response>): Promise<PostPaidExecution>;
  /** The `Tab-*` headers an outcome puts on a response. Empty when there are none. */
  headersFor(outcome: MeteringOutcome): Readonly<Record<string, string>>;
  /** The response a refusal is served with, through the consumer's override when there is one. */
  refusalResponseFor(outcome: RefusedOutcome): Response;
}

/**
 * Builds the plugin.
 *
 * Construction is total: it cannot fail and returns a {@link PostPaidPlugin}
 * rather than a `Result`. Everything fallible belongs to the call that meters,
 * because that is the only place a caller can do anything about it.
 */
export function tabPostPaid(options: TabPostPaidOptions): PostPaidPlugin {
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => Date.now());
  const release = options.release ?? "after-metering";
  const { serviceId, asset, tabBook } = options;
  const billable = options.billable ?? ((response: DeliveredResponse) => response.status < 400);

  const notMetered = (reason: NotMeteredReason, detail: string): NotMeteredOutcome => ({
    kind: "not-metered",
    reason,
    detail,
  });

  const failed = (error: TabError, context: Omit<MeteringFailureContext, "error">): MeteringFailedOutcome => {
    logger.warn("post-paid metering failed and the response was delivered anyway", {
      serviceId,
      code: error.code,
      category: error.category,
      message: error.message,
    });
    call(() => options.onMeteringFailed?.({ ...context, error }), "onMeteringFailed", logger);
    return { kind: "failed", error };
  };

  const meter = async (
    request: MeteredRequest,
    response: DeliveredResponse,
  ): Promise<MeteringOutcome> => {
    const deliverable = call(() => billable(response, request), "billable", logger);
    if (!deliverable.ok) {
      return failed(
        tabError("INTERNAL", "BILLABLE_THREW", "the billable predicate threw, so nothing was metered", {
          cause: deliverable.cause,
        }),
        { request },
      );
    }
    if (deliverable.value !== true) {
      return notMetered(
        "not-billable",
        `status ${response.status} is not a delivery this Service charges for`,
      );
    }

    const agent = resolveAgent(request, options.agentOf, logger);
    if (agent.kind !== "ok") return notMetered(agent.kind, agent.detail);

    const quote = resolveQuote(request, options.priceOf, logger);
    if (quote.kind !== "ok") return notMetered(quote.kind, quote.detail);

    const required = BigInt(quote.value.units) * quote.value.unitPrice;
    const delivery: MeteredDelivery = {
      agent: agent.value,
      serviceId,
      asset,
      tool: quote.value.tool,
      units: quote.value.units,
      expectedUnitPrice: quote.value.unitPrice,
    };
    const recorded = await callAsync(
      () => tabBook.recordDelivery(delivery),
      "tabBook.recordDelivery",
      logger,
    );

    if (!recorded.ok) {
      // A `TabBookClient` is not supposed to throw. One that does is treated as a
      // revert of unknown shape, which lands on `deliver-anyway`.
      return failed(classifyRecordDeliveryRevert(recorded.thrown), {
        request,
        agent: agent.value,
        quote: quote.value,
      });
    }

    if (!recorded.value.ok) {
      const error = recorded.value.error;
      if (dispositionOf(error) !== "refuse-request") {
        return failed(error, { request, agent: agent.value, quote: quote.value });
      }
      return refuse({
        request,
        agent: agent.value,
        asset,
        serviceId,
        quote: quote.value,
        required,
        error,
        // Read only where the refusal reports a headroom, because the charge block
        // needs both figures or neither. `LimitExceeded` is that case.
        openTab:
          detailAmount(error, "headroom") === undefined
            ? undefined
            : await openTabFor(delivery),
        logger,
      });
    }

    const receipt = recorded.value.value;
    const claim = claimOf(request);
    const charge: MeteredCharge = {
      agent: agent.value,
      serviceId,
      asset,
      tool: quote.value.tool,
      units: quote.value.units,
      unitPrice: quote.value.unitPrice,
      amount: receipt.charged,
      openTabAfter: receipt.openAfter,
      headroomAfter: receipt.headroomAfter,
      ...(claim === undefined ? {} : { authorisationClaim: claim }),
      ...(receipt.creditcoinTxHash === undefined ? {} : { creditcoinTxHash: receipt.creditcoinTxHash }),
      recordedAt: receipt.recordedAt,
    };

    call(() => options.onCharge?.(charge), "onCharge", logger);

    return { kind: "charged", charge, receipt, headers: chargeHeaders(charge, logger) };
  };

  /**
   * The Open Tab the refusal reports, or undefined when it could not be read.
   *
   * A failed read costs the refusal its charge headers and nothing else: the body
   * still names the required amount and the headroom, and no figure is invented to
   * fill the block.
   */
  const openTabFor = async (delivery: MeteredDelivery): Promise<bigint | undefined> => {
    const figure = await callAsync(() => tabBook.openTabOf(delivery), "tabBook.openTabOf", logger);
    if (!figure.ok) return undefined;
    if (!figure.value.ok) {
      logger.warn("post-paid could not read the Open Tab, so the refusal carries no charge headers", {
        serviceId,
        code: figure.value.error.code,
      });
      return undefined;
    }
    return figure.value.value;
  };

  /**
   * The response a refusal is served with.
   *
   * The `?? 0n` below is unreachable in practice: `LimitExceeded` reverts with a
   * headroom, which is what put the figure on the context. It exists so
   * {@link LimitExceededContext} can promise a `bigint` rather than making every
   * consumer of the hook handle an absence that the revert set does not produce.
   */
  const refusalResponseFor = (outcome: RefusedOutcome): Response => {
    const override =
      outcome.error.code === "LIMIT_EXCEEDED" && options.onLimitExceeded !== undefined
        ? call(
            () =>
              options.onLimitExceeded?.({
                ...outcome.context,
                headroomBaseUnits: outcome.context.headroomBaseUnits ?? 0n,
              }),
            "onLimitExceeded",
            logger,
          )
        : options.onRefused !== undefined
          ? call(() => options.onRefused?.(outcome.context), "onRefused", logger)
          : { ok: true as const, value: undefined };

    if (override.ok && override.value !== undefined) return override.value;
    return jsonResponse(outcome.status, outcome.headers, outcome.body);
  };

  const plugin: PostPaidPlugin = {
    serviceId,
    asset,
    release,

    meter,

    async execute(request, handler) {
      // The handler runs first and runs to completion. Nothing above this line
      // touches the chain, and nothing below it runs until the response exists.
      let response: Response;
      try {
        response = await handler();
      } catch (thrown) {
        // No response means no delivery, and a delivery that did not happen is
        // not charged for. Deliberate, and not configurable.
        logger.debug("post-paid metered nothing because the handler failed", { serviceId });
        return {
          kind: "handler-failed",
          thrown,
          error: tabError("INTERNAL", "HANDLER_FAILED", "the handler failed, so no delivery was metered", {
            details: { metered: false },
            cause: causeOf(thrown),
          }),
        };
      }

      if (release === "before-metering") {
        // The response is handed back now. The metering promise is still pending,
        // and a caller with a host lifetime hook — `waitUntil`, `after` — passes
        // it there so the runtime does not tear down underneath it.
        return { kind: "delivered", response, metering: meter(request, response) };
      }

      const outcome = await meter(request, response);
      if (outcome.kind === "refused") {
        return { kind: "refused", response: refusalResponseFor(outcome), outcome };
      }
      return {
        kind: "delivered",
        response: attachHeaders(response, plugin.headersFor(outcome), logger),
        metering: Promise.resolve(outcome),
      };
    },

    headersFor(outcome) {
      if (outcome.kind === "charged") return outcome.headers;
      if (outcome.kind === "refused") return outcome.headers;
      return {};
    },

    refusalResponseFor,
  };

  return plugin;
}

/**
 * The six charge headers a recorded charge puts on the response.
 *
 * Formatted by `src/http/headers.ts`, which is also what the 402 client parses
 * with, so the two halves of the wire format cannot disagree. A block that will
 * not format is dropped rather than half-written — the client treats a partial
 * block as an error, and correctly.
 */
export function chargeHeaders(
  charge: MeteredCharge,
  logger: Logger = defaultLogger,
): Readonly<Record<string, string>> {
  return blockHeaders(
    {
      amount: charge.amount,
      asset: chargedAssetOf(charge.asset),
      serviceId: charge.serviceId,
      tool: charge.tool,
      openTab: charge.openTabAfter,
      headroom: charge.headroomAfter,
    },
    logger,
  );
}

/** The Asset as the header contract carries it: a chainKey and an address. */
const chargedAssetOf = (asset: AssetRef): ChargedAsset => ({
  chainKey: asset.chainKey,
  address: asset.address,
});

/** Formats one charge block, or nothing at all if it would be malformed. */
function blockHeaders(block: ChargeBlock, logger: Logger): Readonly<Record<string, string>> {
  const formatted = formatChargeHeaders(block);
  if (formatted.ok) return formatted.value;
  logger.error("post-paid built a charge block that will not format, so no charge headers were sent", {
    code: formatted.error.code,
    message: formatted.error.message,
  });
  return {};
}

/**
 * Builds the refusal: its status, its headers, and its body.
 *
 * The status comes from the error's category and from nothing else, which is why
 * `LIMIT` is the only category that can produce a 402 here.
 *
 * The charge headers go out as the complete six-header block or not at all. That
 * needs both a headroom, which only `LimitExceeded` reverts with, and an Open Tab,
 * which no revert carries and which the caller read through `openTabOf`. Where
 * either is missing the block is dropped, and the body — which always names the
 * required amount, and names the headroom whenever the refusal reported one —
 * carries the refusal on its own.
 */
function refuse(input: {
  readonly request: MeteredRequest;
  readonly agent: Address;
  readonly serviceId: Bytes32;
  readonly asset: AssetRef;
  readonly quote: PriceQuote;
  readonly required: bigint;
  readonly error: TabError;
  /** The Open Tab as read on the refusal path, absent when it could not be read. */
  readonly openTab: bigint | undefined;
  readonly logger: Logger;
}): RefusedOutcome {
  const { error, quote, required, openTab } = input;
  const status = refusalStatusOf(error);
  const headroom = detailAmount(error, "headroom");

  const headers =
    headroom === undefined || openTab === undefined
      ? {}
      : blockHeaders(
          {
            amount: required,
            asset: chargedAssetOf(input.asset),
            serviceId: input.serviceId,
            tool: quote.tool,
            openTab,
            headroom,
          },
          input.logger,
        );

  const body: RefusalBody = {
    ok: false,
    error: {
      category: error.category,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
    agent: input.agent,
    serviceId: input.serviceId,
    asset: chargedAssetKey(chargedAssetOf(input.asset)),
    tool: quote.tool,
    requiredBaseUnits: required.toString(10),
    ...(headroom === undefined ? {} : { headroomBaseUnits: headroom.toString(10) }),
    action: actionOf(error),
  };

  const context: RefusalContext = {
    request: input.request,
    agent: input.agent,
    serviceId: input.serviceId,
    asset: input.asset,
    quote,
    requiredBaseUnits: required,
    ...(headroom === undefined ? {} : { headroomBaseUnits: headroom }),
    error,
    status,
    headers,
    body,
  };

  return { kind: "refused", error, status, headers, body, context };
}

/** A JSON response carrying the refusal, with its `Tab-*` headers. */
export function jsonResponse(
  status: number,
  headers: Readonly<Record<string, string>>,
  body: unknown,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Puts the charge headers on the delivered response.
 *
 * Mutation first, because that keeps the handler's own response object — and a
 * test asserting the delivered response is the handler's response is asserting
 * something worth keeping true. A `Response` that came back from `fetch` guards
 * its headers as immutable, so the fallback rebuilds it around the same body
 * stream rather than reading the body into memory.
 */
export function attachHeaders(
  response: Response,
  headers: Readonly<Record<string, string>>,
  logger: Logger = defaultLogger,
): Response {
  const entries = Object.entries(headers);
  if (entries.length === 0) return response;
  try {
    for (const [name, value] of entries) response.headers.set(name, value);
    return response;
  } catch {
    logger.debug("response headers were immutable, so the charge headers went onto a copy");
    const merged = new Headers(response.headers);
    for (const [name, value] of entries) merged.set(name, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: merged,
    });
  }
}

/** The action text a refusal body carries, taken from the classified message. */
function actionOf(error: TabError): string {
  const separator = error.message.indexOf(": ");
  return separator === -1 ? error.message : error.message.slice(separator + 2);
}

/** The `Tab-Authorisation` claim, when the Agent made one. */
const claimOf = (request: MeteredRequest): string | undefined => {
  const raw = read(request.headers, TAB_HEADER.authorisation);
  return raw === undefined || raw.length === 0 ? undefined : raw;
};

/** Reads one header, tolerating a reader that throws or returns null. */
function read(headers: HeaderReader, name: string): string | undefined {
  try {
    const value = headers.get(name);
    return typeof value === "string" ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

type Resolved<T> = { kind: "ok"; value: T } | { kind: NotMeteredReason; detail: string };

/** The Agent to charge, from `agentOf` or from `Tab-Agent`. */
function resolveAgent(
  request: MeteredRequest,
  agentOf: TabPostPaidOptions["agentOf"],
  logger: Logger,
): Resolved<Address> {
  let raw: string | undefined;
  if (agentOf !== undefined) {
    const supplied = call(() => agentOf(request), "agentOf", logger);
    if (!supplied.ok) return { kind: "no-agent", detail: "agentOf threw" };
    raw = supplied.value === null || supplied.value === undefined ? undefined : supplied.value.trim();
  } else {
    raw = read(request.headers, TAB_HEADER.agent);
  }

  if (raw === undefined || raw.length === 0) {
    return {
      kind: "no-agent",
      detail: `no ${TAB_HEADER.agent} header, so there is no Agent to charge`,
    };
  }
  if (!isAddress(raw)) {
    return {
      kind: "agent-malformed",
      detail: `${TAB_HEADER.agent} carried \`${raw}\`, which is not a 20-byte 0x address`,
    };
  }
  return { kind: "ok", value: raw };
}

/** The price of this call, validated into something `recordDelivery` accepts. */
function resolveQuote(
  request: MeteredRequest,
  priceOf: TabPostPaidOptions["priceOf"],
  logger: Logger,
): Resolved<PriceQuote> {
  const quoted = call(() => priceOf(request), "priceOf", logger);
  if (!quoted.ok) return { kind: "not-priced", detail: "priceOf threw" };
  const quote = quoted.value;
  if (quote === undefined || quote === null) {
    return { kind: "not-priced", detail: "priceOf returned nothing, so this request is not charged for" };
  }
  if (!isBytes32(quote.tool)) {
    return { kind: "price-invalid", detail: "quote.tool must be a 32-byte 0x word" };
  }
  if (!Number.isInteger(quote.units) || quote.units <= 0 || quote.units > 4_294_967_295) {
    return {
      kind: "price-invalid",
      detail: `quote.units must be a positive integer inside uint32, received ${String(quote.units)}`,
    };
  }
  if (typeof quote.unitPrice !== "bigint" || quote.unitPrice <= 0n) {
    return {
      kind: "price-invalid",
      detail: "quote.unitPrice must be a positive bigint count of Asset base units, never a number",
    };
  }
  return { kind: "ok", value: quote };
}

type Called<T> = { ok: true; value: T } | { ok: false; cause: { code: string; message: string } };

/** Runs consumer code without letting it throw into the metering path. */
function call<T>(fn: () => T, what: string, logger: Logger): Called<T> {
  try {
    return { ok: true, value: fn() };
  } catch (thrown) {
    const cause = causeOf(thrown);
    logger.error(`post-paid ${what} threw and was ignored`, cause);
    return { ok: false, cause };
  }
}

type CalledAsync<T> = { ok: true; value: T } | { ok: false; thrown: unknown };

/** The asynchronous sibling, keeping a rejected promise out of the metering path. */
async function callAsync<T>(
  fn: () => Promise<T>,
  what: string,
  logger: Logger,
): Promise<CalledAsync<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (thrown) {
    logger.error(`post-paid ${what} threw and was treated as a refusal of unknown shape`, causeOf(thrown));
    return { ok: false, thrown };
  }
}

/** Narrows a caught value into the `cause` shape a `TabError` accepts. */
function causeOf(thrown: unknown): { code: string; message: string } {
  if (thrown instanceof Error) return { code: thrown.name, message: thrown.message };
  return { code: "UNKNOWN", message: String(thrown) };
}
