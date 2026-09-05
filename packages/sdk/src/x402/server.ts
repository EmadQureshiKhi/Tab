/**
 * The x402 server side: build what a `402` must carry, and take a signed
 * payment through a facilitator.
 *
 * ## The flow, and why the order is fixed
 *
 * x402's default `authorization` flow is verify, then resource, then settle:
 * the facilitator confirms the signature and the balance before the work is
 * done, and moves the funds only after the work succeeded. {@link handlePrepaidRequest}
 * runs exactly that. It never settles a payment for a response that was not a
 * delivery, for the same reason the post-paid plugin never meters one: an
 * Agent is not charged for a call that failed.
 *
 * ## What a Tab Service does with this
 *
 * A Tab Service delivers on credit and refuses on `LimitExceeded` alone. With
 * this module, that refusal can also carry a `PAYMENT-REQUIRED` naming the same
 * charge as an x402 `exact` requirement, so an Agent that has no headroom and
 * would rather not settle first can pay for the one call. When it does, the
 * call is prepaid in full, the facilitator moves the Asset to the Service's
 * Collection address, and nothing lands on the Open Tab, because nothing is
 * owed.
 *
 * ## Official and hand-rolled
 *
 * The facilitator client is `@x402/core`'s `HTTPFacilitatorClient`, wrapped so
 * a thrown `VerifyError` or `SettleError` comes back as a `Result` carrying the
 * facilitator's reason. Requirement construction and the request handling are
 * this package's own, because the official server middleware gates every
 * request on payment, which is the model Tab exists to replace.
 *
 * Specification: x402-specification-v2.md sections 5, 6.1 and 7, transports-v2/http.md.
 */

import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { causeOf, isAddress, ok, wrap, type Address, type Result, type TabError } from "@tabai/shared";

import { fail, tabError, validationError } from "../errors.js";
import { defaultLogger, type Logger } from "../logger.js";
import type { AssetRef } from "../payments/strategy.js";
import {
  X402_HEADER,
  X402_SCHEME_EXACT,
  X402_VERSION,
  encodePaymentRequired,
  encodePaymentResponse,
  networkOf,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
  type SettleResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "./wire.js";

/** Monad's facilitator, which settles `exact` and `upto` on Mainnet and Testnet. */
export const MONAD_FACILITATOR_URL = "https://x402-facilitator.molandak.org";

/** How long an authorization stays valid when the Service does not say. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 300;

/**
 * What verifies and settles payments.
 *
 * `@x402/core`'s interface, re-exported so a fake in a test and the HTTP client
 * in production are the same type. The methods throw, as `@x402/core`'s do;
 * {@link verifyPayment} and {@link settlePayment} are the zero-throw doors.
 */
export type X402FacilitatorClient = FacilitatorClient;

export interface X402FacilitatorOptions {
  /** Defaults to {@link MONAD_FACILITATOR_URL}. */
  readonly url?: string;
  /** Per-request timeout. Defaults to `@x402/core`'s 90 seconds. */
  readonly timeoutMs?: number;
}

/** `@x402/core`'s HTTP client over a facilitator's `/verify`, `/settle` and `/supported`. */
export function createX402Facilitator(options: X402FacilitatorOptions = {}): X402FacilitatorClient {
  return new HTTPFacilitatorClient({
    url: options.url ?? MONAD_FACILITATOR_URL,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

/** The EIP-712 domain of the two USDC deployments Monad's facilitator settles. */
const KNOWN_DOMAINS: Readonly<Record<string, { readonly name: string; readonly version: string }>> = {
  USDC: { name: "USDC", version: "2" },
  // The Testnet mock's constructor names it `USDC` v2 to match Circle's; the
  // rail calls it `mUSDC` so the two are never confused on a page.
  MUSDC: { name: "USDC", version: "2" },
};

export interface ExactRequirementOptions {
  readonly chainId: bigint;
  /** The token. `symbol` picks the EIP-712 domain when `extra` is not given. */
  readonly asset: Pick<AssetRef, "address" | "symbol">;
  /** Atomic units of the token. */
  readonly amount: bigint;
  /** Where the facilitator sends the funds: the Service's Collection address for the Asset. */
  readonly payTo: Address;
  readonly maxTimeoutSeconds?: number;
  /**
   * The requirement's `extra`. Must carry the token's EIP-712 domain `name` and
   * `version`, which EIP-3009 signing needs. Defaults to USDC's when the Asset's
   * symbol is `USDC`, and is required otherwise.
   */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** One `exact` requirement, EIP-3009, on an EVM chain. */
export function exactRequirementFor(options: ExactRequirementOptions): Result<PaymentRequirements> {
  if (typeof options.chainId !== "bigint" || options.chainId <= 0n) {
    return validationError("X402_REQUIREMENTS_INVALID", "chainId must be a positive bigint");
  }
  if (!isAddress(options.asset.address)) {
    return validationError("X402_REQUIREMENTS_INVALID", `asset \`${String(options.asset.address)}\` is not a 20-byte address`);
  }
  if (!isAddress(options.payTo)) {
    return validationError("X402_REQUIREMENTS_INVALID", `payTo \`${String(options.payTo)}\` is not a 20-byte address`);
  }
  if (typeof options.amount !== "bigint" || options.amount <= 0n) {
    return validationError("X402_REQUIREMENTS_INVALID", "amount must be a positive bigint of atomic units, never a number");
  }
  const timeout = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    return validationError("X402_REQUIREMENTS_INVALID", "maxTimeoutSeconds must be a positive integer");
  }
  const extra = options.extra ?? KNOWN_DOMAINS[options.asset.symbol.toUpperCase()];
  if (extra === undefined || typeof extra["name"] !== "string" || typeof extra["version"] !== "string") {
    return validationError(
      "X402_DOMAIN_MISSING",
      `no EIP-712 domain is known for ${options.asset.symbol}; pass extra: { name, version } from the token contract`,
      { details: { asset: options.asset.address, symbol: options.asset.symbol } },
    );
  }
  return ok({
    scheme: X402_SCHEME_EXACT,
    network: networkOf(options.chainId),
    amount: options.amount.toString(10),
    asset: options.asset.address,
    payTo: options.payTo,
    maxTimeoutSeconds: timeout,
    extra: { ...extra },
  });
}

export interface PaymentRequiredOptions {
  readonly resource: ResourceInfo;
  readonly accepts: readonly PaymentRequirements[];
  /** Why payment is being asked for, for a person reading the header. */
  readonly error?: string;
}

/** The object a `402` carries in `PAYMENT-REQUIRED`. */
export const paymentRequiredFor = (options: PaymentRequiredOptions): PaymentRequired => ({
  x402Version: X402_VERSION,
  ...(options.error === undefined ? {} : { error: options.error }),
  resource: options.resource,
  accepts: [...options.accepts],
});

/** The `PAYMENT-REQUIRED` header, ready to merge onto a response. */
export function paymentRequiredHeaders(required: PaymentRequired): Result<Record<string, string>> {
  const encoded = encodePaymentRequired(required);
  if (!encoded.ok) return encoded;
  return ok({ [X402_HEADER.paymentRequired]: encoded.value });
}

/** The `PAYMENT-RESPONSE` header, ready to merge onto a response. */
export function paymentResponseHeaders(settlement: SettleResponse): Result<Record<string, string>> {
  const encoded = encodePaymentResponse(settlement);
  if (!encoded.ok) return encoded;
  return ok({ [X402_HEADER.paymentResponse]: encoded.value });
}

/** What a thrown facilitator error carries, read without depending on its class. */
interface ThrownFacilitatorError {
  readonly invalidReason?: unknown;
  readonly errorReason?: unknown;
  readonly invalidMessage?: unknown;
  readonly errorMessage?: unknown;
  readonly payer?: unknown;
  readonly transaction?: unknown;
  readonly statusCode?: unknown;
}

const facilitatorFailure = (what: "verify" | "settle") => (error: unknown): TabError => {
  const thrown = (typeof error === "object" && error !== null ? error : {}) as ThrownFacilitatorError;
  const reason = [thrown.invalidReason, thrown.errorReason].find((value) => typeof value === "string") as string | undefined;
  const detail = [thrown.invalidMessage, thrown.errorMessage].find((value) => typeof value === "string") as string | undefined;
  return tabError(
    reason === undefined ? "UPSTREAM" : "LIMIT",
    reason === undefined ? `X402_FACILITATOR_${what.toUpperCase()}_FAILED` : `X402_${what.toUpperCase()}_REJECTED`,
    reason === undefined
      ? `the facilitator could not ${what} the payment`
      : `the facilitator refused to ${what} the payment: ${reason}${detail === undefined ? "" : ` (${detail})`}`,
    {
      retryable: reason === undefined,
      details: {
        ...(reason === undefined ? {} : { reason }),
        ...(typeof thrown.payer === "string" ? { payer: thrown.payer } : {}),
        ...(typeof thrown.transaction === "string" && thrown.transaction.length > 0 ? { transaction: thrown.transaction } : {}),
        ...(typeof thrown.statusCode === "number" ? { statusCode: thrown.statusCode } : {}),
      },
      cause: causeOf(error),
    },
  );
};

/** `POST /verify`, as a `Result`. An invalid payment is a `LIMIT` error naming the facilitator's reason. */
export async function verifyPayment(
  facilitator: X402FacilitatorClient,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<Result<VerifyResponse>> {
  const verified = await wrap(async () => facilitator.verify(payload, requirements), facilitatorFailure("verify"));
  if (!verified.ok) return verified;
  if (verified.value.isValid !== true) {
    const reason = verified.value.invalidReason ?? "invalid_payload";
    return fail("LIMIT", "X402_VERIFY_REJECTED", `the facilitator refused to verify the payment: ${reason}`, {
      retryable: false,
      details: { reason, ...(verified.value.payer === undefined ? {} : { payer: verified.value.payer }) },
    });
  }
  return verified;
}

/** `POST /settle`, as a `Result`. A failed settlement carries the facilitator's reason and any broadcast hash. */
export async function settlePayment(
  facilitator: X402FacilitatorClient,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<Result<SettleResponse>> {
  const settled = await wrap(async () => facilitator.settle(payload, requirements), facilitatorFailure("settle"));
  if (!settled.ok) return settled;
  if (settled.value.success !== true) {
    const reason = settled.value.errorReason ?? "unexpected_settle_error";
    return fail(
      reason === "settlement_pending" ? "UNAVAILABLE" : "LIMIT",
      "X402_SETTLE_REJECTED",
      `the facilitator did not settle the payment: ${reason}`,
      {
        retryable: reason === "settlement_pending",
        details: {
          reason,
          transaction: settled.value.transaction,
          network: settled.value.network,
          ...(settled.value.payer === undefined ? {} : { payer: settled.value.payer }),
        },
      },
    );
  }
  return settled;
}

/** `GET /supported`, as a `Result`. */
export const facilitatorSupports = (facilitator: X402FacilitatorClient): Promise<Result<SupportedResponse>> =>
  wrap(async () => facilitator.getSupported(), (error) =>
    tabError("UPSTREAM", "X402_FACILITATOR_UNREACHABLE", "the facilitator did not answer /supported", {
      retryable: true,
      cause: causeOf(error),
    }),
  );

/**
 * Checks that what the client says it accepted is what this server requires.
 *
 * The facilitator verifies the signature against the server's requirements, so
 * a mismatch would be caught there; catching it here saves the round trip and
 * names the field. `extra` and `maxTimeoutSeconds` are not compared: they are
 * the server's inputs to signing and the facilitator reads them from the
 * server's copy, never the client's.
 */
export function matchAccepted(accepted: PaymentRequirements, requirements: PaymentRequirements): Result<void> {
  const mismatches: string[] = [];
  if (accepted.scheme !== requirements.scheme) mismatches.push(`scheme ${accepted.scheme} is not ${requirements.scheme}`);
  if (accepted.network !== requirements.network) mismatches.push(`network ${accepted.network} is not ${requirements.network}`);
  if (accepted.asset.toLowerCase() !== requirements.asset.toLowerCase()) mismatches.push(`asset ${accepted.asset} is not ${requirements.asset}`);
  if (accepted.payTo.toLowerCase() !== requirements.payTo.toLowerCase()) mismatches.push(`payTo ${accepted.payTo} is not ${requirements.payTo}`);
  if (BigInt(accepted.amount) !== BigInt(requirements.amount)) mismatches.push(`amount ${accepted.amount} is not ${requirements.amount}`);
  if (mismatches.length === 0) return ok(undefined);
  return fail("LIMIT", "X402_ACCEPTED_MISMATCH", `the signed payment does not match this call's requirement: ${mismatches.join(", ")}`, {
    retryable: false,
    details: { mismatches: mismatches.join("; ") },
  });
}

/** The response, reduced to what the billability decision needs. */
export interface X402DeliveredResponse {
  readonly status: number;
}

export interface PrepaidRequestOptions {
  readonly facilitator: X402FacilitatorClient;
  /** The decoded `PAYMENT-SIGNATURE`. */
  readonly payload: PaymentPayload;
  /** What this call costs, built by the server and never taken from the client. */
  readonly requirements: PaymentRequirements;
  readonly resource: ResourceInfo;
  /** The work. Runs only after the payment verified. */
  readonly deliver: () => Promise<Response> | Response;
  /** Whether a response is a delivery worth settling for. Defaults to `status < 400`. */
  readonly billable?: (response: X402DeliveredResponse) => boolean;
  readonly logger?: Logger;
}

export type PrepaidOutcome =
  /** Verified, delivered, settled. The response carries `PAYMENT-RESPONSE`. */
  | { readonly kind: "paid"; readonly response: Response; readonly settlement: SettleResponse; readonly payer: string | undefined }
  /** The payment did not verify. The response is a `402` carrying `PAYMENT-REQUIRED` with the reason. */
  | { readonly kind: "rejected"; readonly response: Response; readonly error: TabError }
  /** The work was not a delivery, so nothing was settled and the handler's own response goes out. */
  | { readonly kind: "not-delivered"; readonly response: Response }
  /** The handler threw. Nothing was settled. */
  | { readonly kind: "handler-failed"; readonly thrown: unknown; readonly error: TabError }
  /** Delivered, but the facilitator would not settle. The response is a `402` carrying the failed `PAYMENT-RESPONSE`. */
  | { readonly kind: "settlement-failed"; readonly response: Response; readonly error: TabError };

/**
 * Takes one prepaid request through verify, deliver, settle.
 *
 * Never throws and never rejects. A thrown handler is an outcome, not an
 * exception, so a host adapter can re-raise it the way its framework expects.
 */
export async function handlePrepaidRequest(options: PrepaidRequestOptions): Promise<PrepaidOutcome> {
  const logger = options.logger ?? defaultLogger;
  const billable = options.billable ?? ((response: X402DeliveredResponse) => response.status < 400);
  const required = paymentRequiredFor({ resource: options.resource, accepts: [options.requirements] });

  const rejected = (error: TabError): PrepaidOutcome => ({
    kind: "rejected",
    response: paymentRequiredResponse({ ...required, error: error.message }, error),
    error,
  });

  const matched = matchAccepted(options.payload.accepted, options.requirements);
  if (!matched.ok) return rejected(matched.error);

  const verified = await verifyPayment(options.facilitator, options.payload, options.requirements);
  if (!verified.ok) return rejected(verified.error);

  let response: Response;
  try {
    response = await options.deliver();
  } catch (thrown) {
    logger.debug("x402 prepaid call settled nothing because the handler failed");
    return {
      kind: "handler-failed",
      thrown,
      error: tabError("INTERNAL", "HANDLER_FAILED", "the handler failed, so the verified payment was not settled", {
        details: { settled: false },
        cause: causeOf(thrown),
      }),
    };
  }

  let deliverable: boolean;
  try {
    deliverable = billable(response) === true;
  } catch (thrown) {
    logger.error("x402 billable predicate threw and was read as not billable", causeOf(thrown));
    deliverable = false;
  }
  if (!deliverable) return { kind: "not-delivered", response };

  const settled = await settlePayment(options.facilitator, options.payload, options.requirements);
  if (!settled.ok) {
    discard(response, logger);
    const failure: SettleResponse = {
      success: false,
      errorReason: String(settled.error.details?.["reason"] ?? settled.error.code),
      transaction: String(settled.error.details?.["transaction"] ?? ""),
      network: options.requirements.network,
      ...(typeof settled.error.details?.["payer"] === "string" ? { payer: settled.error.details["payer"] } : {}),
    };
    return { kind: "settlement-failed", response: settlementFailedResponse(failure, settled.error), error: settled.error };
  }

  const headers = paymentResponseHeaders(settled.value);
  if (!headers.ok) {
    // The funds moved and the work is delivered; a header that will not encode
    // costs the caller the receipt and nothing else.
    logger.error("x402 settlement succeeded but PAYMENT-RESPONSE would not encode", { code: headers.error.code });
    return { kind: "paid", response, settlement: settled.value, payer: settled.value.payer };
  }
  return { kind: "paid", response: withHeaders(response, headers.value, logger), settlement: settled.value, payer: settled.value.payer };
}

/** A `402` carrying `PAYMENT-REQUIRED` and a JSON body naming the error. */
export function paymentRequiredResponse(required: PaymentRequired, error: TabError, extraHeaders: Readonly<Record<string, string>> = {}): Response {
  const encoded = paymentRequiredHeaders(required);
  return new Response(JSON.stringify({ ok: false, error }), {
    status: 402,
    headers: {
      ...extraHeaders,
      ...(encoded.ok ? encoded.value : {}),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

/** A `402` carrying a failed `PAYMENT-RESPONSE`, as the HTTP transport specification shows. */
function settlementFailedResponse(failure: SettleResponse, error: TabError): Response {
  const encoded = paymentResponseHeaders(failure);
  return new Response(JSON.stringify({ ok: false, error }), {
    status: 402,
    headers: { ...(encoded.ok ? encoded.value : {}), "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Puts headers on a response, copying it when its headers are immutable. */
function withHeaders(response: Response, headers: Readonly<Record<string, string>>, logger: Logger): Response {
  try {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  } catch {
    logger.debug("response headers were immutable, so PAYMENT-RESPONSE went onto a copy");
    const merged = new Headers(response.headers);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
  }
}

function discard(response: Response, logger: Logger): void {
  const body = response.body;
  if (body === null || response.bodyUsed) return;
  try {
    body.cancel().catch((error: unknown) => logger.debug("discarded response body could not be cancelled", causeOf(error)));
  } catch (error) {
    logger.debug("discarded response body could not be cancelled", causeOf(error));
  }
}
