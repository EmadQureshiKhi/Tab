/**
 * Buy now, pay later for x402 APIs: a Tab Service fronts a pay-per-request
 * upstream, pays it with the Service operator's own key, and meters the Agent's
 * Open Tab for what it paid.
 *
 * ## The shape
 *
 * ```text
 * Agent  --(Tab-Agent)-->  fronting proxy  --(request)-->  x402 upstream
 *                                          <--(402, PAYMENT-REQUIRED)--
 *                            operator signs EIP-3009 for the quoted amount
 *                                          --(PAYMENT-SIGNATURE)-->
 *                                          <--(200, PAYMENT-RESPONSE)--
 *        post-paid plugin meters upstream price + margin onto the Open Tab
 * Agent  <--(200, Tab-Charge-*)--
 * ```
 *
 * The Agent never signs and never holds the upstream's currency. It buys on
 * credit, from a Service it already has a tab with, and settles later exactly
 * as it settles every other Tab charge. The Service is the one taking the
 * upstream's price risk, which is what the margin is for.
 *
 * ## The price is known only after the upstream's 402
 *
 * `tabPostPaid` asks `priceOf(request)` once the response exists, which is
 * after the forward. So the forward records what it paid, keyed by the request
 * object, and {@link X402UpstreamPricing.priceOf} reads it back for the same
 * object. `createTabProxy` hands its `fetchImpl` that request for this reason.
 *
 * ## Before the operator's funds move
 *
 * An upstream paid for a delivery the Agent then cannot be metered for is the
 * operator's loss. `preflight` runs between the upstream's `402` and the
 * signature, with the quoted amount in hand, so a Service can simulate the
 * delivery against `TabBook` and refuse an Agent with no headroom before paying.
 * A refusal is answered at its category's status, `402` for `LIMIT`, and the
 * upstream is not paid.
 */

import { causeOf, ok, type Address, type Bytes32, type Result, type TabError } from "@tabai/shared";

import { tabError } from "../errors.js";
import { TAB_HEADER } from "../http/headers.js";
import { defaultLogger, type Logger } from "../logger.js";
import type { AssetRef } from "../payments/strategy.js";
import { createTabProxy, errorResponse, type ProxyFetch, type TabProxy, type TabProxyOptions } from "../proxy/proxy.js";
import type { MeteredRequest, PriceQuote } from "../server/post-paid.js";
import { createX402Client, type X402Fetch, type X402PaymentReceipt, type X402Signer } from "./client.js";
import type { PaymentRequired, PaymentRequirements } from "./wire.js";

/** What the Service adds on top of the upstream's price. Both parts optional; both default to nothing. */
export interface X402UpstreamMargin {
  /** Basis points of the upstream amount, rounded down. `500n` is five percent. */
  readonly bps?: bigint;
  /** A flat count of Asset base units per call. */
  readonly flatBaseUnits?: bigint;
}

export interface X402UpstreamPricingOptions {
  /** The tool key the fronted calls are metered under, as the applied price list holds it. */
  readonly tool: Bytes32;
  readonly margin?: X402UpstreamMargin;
  /**
   * What one unit of this tool costs on chain, as `ServiceRegistry` holds it.
   *
   * A fronted call's price is not known until the upstream answers, and
   * `TabBook.recordDelivery` refuses any unit price that is not the one in the
   * applied price list. So the varying amount rides in the **unit count**, not
   * in the unit price: a Service publishes a small fixed unit and a call
   * consumes as many of them as it cost. One base unit, the default, makes the
   * charge exact; a coarser unit rounds up, never down, so the Service is
   * never left short by its own rounding.
   *
   * The published price and this number must be the same, or every fronted
   * delivery reverts `PriceListChangedMidCall` and the Service pays the
   * upstream for work it bills nobody.
   */
  readonly unitBaseUnits?: bigint;
}

/** One fronted call's economics: what the operator paid and what the Agent is metered. */
export interface X402UpstreamCharge {
  readonly upstreamAmount: bigint;
  readonly margin: bigint;
  /** `upstreamAmount + margin`: what lands on the Open Tab. */
  readonly amount: bigint;
  readonly payment: X402PaymentReceipt;
}

/**
 * The price book a fronting proxy writes and its post-paid plugin reads.
 *
 * Built once and shared: the plugin takes `priceOf` at construction, and the
 * proxy takes the whole object so it can `record` into it. Keyed weakly by the
 * request, so nothing is retained after the request is gone.
 */
export interface X402UpstreamPricing {
  readonly tool: Bytes32;
  /** For `tabPostPaid({ priceOf })`. Nothing when no upstream payment was made for this request. */
  priceOf(request: MeteredRequest): PriceQuote | undefined;
  chargeOf(request: MeteredRequest): X402UpstreamCharge | undefined;
  record(request: MeteredRequest, payment: X402PaymentReceipt): X402UpstreamCharge;
  /** The Agent's price for an upstream amount, margin applied. */
  amountFor(upstreamAmount: bigint): bigint;
  /** What one unit costs on chain: the unit price every quote carries. */
  readonly unitBaseUnits: bigint;
}

/** `TabBook.recordDelivery` takes the unit count as a `uint32`. */
const MAX_UNITS = 4_294_967_295n;

export function createX402UpstreamPricing(options: X402UpstreamPricingOptions): X402UpstreamPricing {
  const book = new WeakMap<object, X402UpstreamCharge>();
  const bps = options.margin?.bps ?? 0n;
  const flat = options.margin?.flatBaseUnits ?? 0n;
  const unitBaseUnits = options.unitBaseUnits ?? 1n;
  if (unitBaseUnits <= 0n) throw new RangeError("unitBaseUnits must be a positive count of Asset base units");
  const marginOf = (upstreamAmount: bigint): bigint => (upstreamAmount * bps) / 10_000n + flat;
  return {
    tool: options.tool,
    unitBaseUnits,
    amountFor: (upstreamAmount) => upstreamAmount + marginOf(upstreamAmount),
    record(request, payment) {
      const margin = marginOf(payment.amount);
      const charge: X402UpstreamCharge = { upstreamAmount: payment.amount, margin, amount: payment.amount + margin, payment };
      book.set(request, charge);
      return charge;
    },
    chargeOf: (request) => book.get(request),
    priceOf(request) {
      const charge = book.get(request);
      if (charge === undefined || charge.amount <= 0n) return undefined;
      // Rounded up, so a coarse unit never leaves the Service short of what it
      // paid the upstream. A charge past `uint32` units is not priced at all:
      // the delivery would revert on chain, and refusing here means the
      // Service learns why from its own log instead of from a mined failure.
      const units = (charge.amount + unitBaseUnits - 1n) / unitBaseUnits;
      if (units > MAX_UNITS) return undefined;
      return { tool: options.tool, units: Number(units), unitPrice: unitBaseUnits };
    },
  };
}

/** What `preflight` is told before the operator signs. */
export interface X402PreflightQuote {
  /** The Agent named by `Tab-Agent`, when the request named one. */
  readonly agent: Address | undefined;
  readonly tool: Bytes32;
  /** What the Agent will be metered: upstream amount plus margin. */
  readonly amount: bigint;
  readonly upstreamAmount: bigint;
  readonly requirement: PaymentRequirements;
  readonly required: PaymentRequired;
}

/**
 * Where an upstream is paid, when that is not the Service's own chain and Asset.
 *
 * The API Hub takes USDC on Monad Mainnet and nothing else, and a Service on
 * Testnet meters in a Testnet Asset, so the two sides of a fronted call can sit
 * on different chains. This names the paying side. The signer is the one that
 * holds funds there, and defaults to the proxy's own; the amount the Agent is
 * metered is the upstream's base units passed through `pricing`, which is right
 * only when both Assets are six-decimal dollar stablecoins, and a Service that
 * fronts anything else states its own conversion in `pricing`.
 */
export interface X402UpstreamPayment {
  readonly chainId: bigint;
  readonly asset: Address;
  readonly signer?: X402Signer;
}

export interface X402FrontedProxyOptions extends Omit<TabProxyOptions, "fetchImpl"> {
  /** The Service operator's key: what pays the upstream. */
  readonly signer: X402Signer;
  readonly pricing: X402UpstreamPricing;
  /** The Asset the Service meters in. The upstream is paid in it, on its chain, unless `upstreamPayment` says otherwise. */
  readonly asset: Pick<AssetRef, "chainId" | "address">;
  /** The chain, Asset and key the upstream is paid with, where they differ from the Service's own. */
  readonly upstreamPayment?: X402UpstreamPayment;
  /** The `fetch` the paying client sends with. Defaults to the host's. */
  readonly fetchImpl?: X402Fetch<Response>;
  /** Refuse any upstream price above this many atomic units. Omitted sets no ceiling. */
  readonly maxUpstreamAmount?: bigint;
  /** Runs after the upstream's 402 and before the signature. An `err` stops the payment. */
  readonly preflight?: (quote: X402PreflightQuote, request: Request) => Promise<Result<void>> | Result<void>;
  /** Replaces the response a `preflight` refusal is answered with. */
  readonly onRefused?: (error: TabError, quote: X402PreflightQuote, request: Request) => Response | undefined;
  readonly onPayment?: (receipt: X402PaymentReceipt, request: Request) => void;
  /** Seconds since the epoch, for `validBefore`. A test passes a fixed clock. */
  readonly nowSeconds?: () => number;
}

export interface X402FrontedProxy extends TabProxy {
  readonly pricing: X402UpstreamPricing;
  /** Every upstream payment made, oldest first. */
  payments(): readonly X402PaymentReceipt[];
}

/**
 * Builds the fronting proxy: `createTabProxy` with a forward that pays.
 *
 * Everything `createTabProxy` does, hooks, header hygiene, the metering plugin
 * around the forward, streaming of the response, holds. The one thing it gives
 * up is streaming of the *request* body: an upstream that answers `402` has to
 * be sent the same body twice, so a streamed body is read into memory before
 * the first attempt.
 */
export function createX402FrontedProxy(options: X402FrontedProxyOptions): X402FrontedProxy {
  const logger = options.logger ?? defaultLogger;
  const payments: X402PaymentReceipt[] = [];
  const { signer, pricing, asset, upstreamPayment, preflight, onRefused, onPayment, maxUpstreamAmount, nowSeconds, fetchImpl, ...proxyOptions } = options;
  const paying = {
    signer: upstreamPayment?.signer ?? signer,
    chainId: upstreamPayment?.chainId ?? asset.chainId,
    asset: upstreamPayment?.asset ?? asset.address,
  };

  const quoteFor = (request: Request, requirement: PaymentRequirements, required: PaymentRequired): X402PreflightQuote => {
    const upstreamAmount = BigInt(requirement.amount);
    const claimed = request.headers.get(TAB_HEADER.agent)?.trim().toLowerCase();
    return {
      agent: claimed !== undefined && /^0x[0-9a-f]{40}$/.test(claimed) ? (claimed as Address) : undefined,
      tool: pricing.tool,
      amount: pricing.amountFor(upstreamAmount),
      upstreamAmount,
      requirement,
      required,
    };
  };

  const payingFetch: ProxyFetch = async (url, init, request) => {
    const buffered = await bufferBody(init.body);
    if (!buffered.ok) return errorResponse(buffered.error);

    let refused: { error: TabError; quote: X402PreflightQuote } | undefined;
    const client = createX402Client<Response>({
      signer: paying.signer,
      chainId: paying.chainId,
      asset: paying.asset,
      ...(maxUpstreamAmount === undefined ? {} : { maxAmount: maxUpstreamAmount }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      ...(nowSeconds === undefined ? {} : { nowSeconds }),
      logger,
      authorise: async (requirement, required) => {
        if (preflight === undefined) return ok(undefined);
        const quote = quoteFor(request, requirement, required);
        const verdict = await preflight(quote, request);
        if (!verdict.ok) refused = { error: verdict.error, quote };
        return verdict;
      },
    });

    const { body: _body, duplex: _duplex, ...rest } = init;
    const result = await client.fetch(url, {
      ...rest,
      headers: init.headers,
      ...(buffered.value === undefined ? {} : { body: buffered.value }),
    });

    if (!result.ok) {
      if (refused !== undefined) {
        const override = call(() => onRefused?.(refused?.error as TabError, refused?.quote as X402PreflightQuote, request), logger);
        if (override !== undefined) return override;
      }
      logger.warn("the fronted upstream could not be paid, so the request was not delivered", {
        url,
        code: result.error.code,
        message: result.error.message,
      });
      return errorResponse(result.error);
    }

    if (result.value.payment !== undefined) {
      pricing.record(request, result.value.payment);
      payments.push(result.value.payment);
      call(() => onPayment?.(result.value.payment as X402PaymentReceipt, request), logger);
    }
    return result.value.response;
  };

  const proxy = createTabProxy({ ...proxyOptions, logger, fetchImpl: payingFetch });
  return Object.assign(proxy, { pricing, payments: () => [...payments] });
}

/** Runs a consumer callback without letting it throw into the forward. */
function call<T>(fn: () => T, logger: Logger): T | undefined {
  try {
    return fn();
  } catch (error) {
    logger.warn("a fronted-proxy callback threw and was ignored", causeOf(error));
    return undefined;
  }
}

/**
 * Reads a streamed request body into bytes so it can be sent twice.
 *
 * Anything that is not a stream is passed through as it is: a string, a byte
 * view, a `URLSearchParams`, a `FormData`, or nothing.
 */
async function bufferBody(body: unknown): Promise<Result<unknown>> {
  if (body === undefined || body === null || typeof body !== "object") return ok(body);
  const candidate = body as { getReader?: unknown; [Symbol.asyncIterator]?: unknown };
  if (typeof candidate.getReader !== "function" && typeof candidate[Symbol.asyncIterator] !== "function") return ok(body);
  try {
    const bytes = await new Response(body as ReadableStream).arrayBuffer();
    return ok(new Uint8Array(bytes));
  } catch (error) {
    return {
      ok: false,
      error: tabError("VALIDATION", "REQUEST_BODY_UNREADABLE", "the request body could not be read for forwarding", {
        cause: causeOf(error),
      }),
    };
  }
}
