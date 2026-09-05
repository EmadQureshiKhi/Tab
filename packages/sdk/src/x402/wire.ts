/**
 * The x402 V2 wire format, as this package reads and writes it.
 *
 * x402 is the prepaid model: a resource server answers `402` with a
 * `PAYMENT-REQUIRED` header naming what it accepts, the client signs a payment
 * and repeats the request with `PAYMENT-SIGNATURE`, and the server returns the
 * resource with `PAYMENT-RESPONSE` once a facilitator has settled it on chain.
 * Tab is the opposite model, and the two meet in exactly two places: a Tab
 * Service that has refused an Agent on credit can offer x402 as the way to pay
 * for that one call, and a Tab Service can front an x402 upstream and buy on the
 * Agent's behalf. This module is the shared vocabulary for both.
 *
 * ## What is official and what is not
 *
 * The types and the three header codecs come from `@x402/core`, the official
 * implementation, so a `PaymentRequired` built here is what an x402 client
 * elsewhere decodes and a `PaymentPayload` decoded here is what one sent. The
 * codecs throw on malformed input; every wrapper below turns that into a
 * `Result`, because nothing exported from this package throws.
 *
 * {@link selectExactRequirement} is this package's own: which of a server's
 * `accepts` an Agent can actually sign. It is narrow on purpose. The only
 * scheme signed here is `exact` with the EIP-3009 asset transfer method, the
 * default the exact EVM scheme names, and the only networks are `eip155:*`.
 *
 * Specification: x402-specification-v2.md sections 5 and 11.1, transports-v2/http.md.
 */

import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { causeOf, isAddress, ok, wrapSync, type Address, type Result } from "@tabai/shared";

import { validationError } from "../errors.js";
import { headerReaderOf, type HeaderReader, type HeaderRecord } from "../http/headers.js";

export type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
};

/** The protocol version this package speaks. V1 is not read and not written. */
export const X402_VERSION = 2 as const;

/** The three transport headers, in the casing the HTTP transport specification uses. */
export const X402_HEADER = {
  paymentRequired: "PAYMENT-REQUIRED",
  paymentSignature: "PAYMENT-SIGNATURE",
  paymentResponse: "PAYMENT-RESPONSE",
} as const;

/** The `exact` scheme, the only one this package signs. */
export const X402_SCHEME_EXACT = "exact" as const;

/** The asset transfer method this package signs: `transferWithAuthorization`. */
export const X402_TRANSFER_METHOD_EIP3009 = "eip3009" as const;

/** The CAIP-2 network for an EVM chain id. */
export const networkOf = (chainId: bigint | number): Network => `eip155:${chainId.toString()}`;

/** The EVM chain id a CAIP-2 network names, or an error for anything that is not `eip155:<id>`. */
export function chainIdOfNetwork(network: string): Result<bigint> {
  const match = /^eip155:([0-9]+)$/.exec(network.trim());
  if (match === null || match[1] === undefined) {
    return validationError(
      "X402_NETWORK_UNSUPPORTED",
      `\`${network}\` is not an EVM network; this package signs on eip155:<chainId> alone`,
      { details: { network } },
    );
  }
  return ok(BigInt(match[1]));
}

const decodeFailed = (header: string, code: string) => (error: unknown) => ({
  category: "VALIDATION" as const,
  code,
  message: `${header} does not decode to the x402 object it should carry: base64 of a JSON document`,
  retryable: false,
  details: { header },
  cause: causeOf(error),
});

/** Decodes a `PAYMENT-REQUIRED` header value. */
export const decodePaymentRequired = (value: string): Result<PaymentRequired> =>
  wrapSync(() => decodePaymentRequiredHeader(value), decodeFailed(X402_HEADER.paymentRequired, "X402_PAYMENT_REQUIRED_INVALID"));

/** Decodes a `PAYMENT-SIGNATURE` header value. */
export const decodePaymentSignature = (value: string): Result<PaymentPayload> =>
  wrapSync(() => decodePaymentSignatureHeader(value), decodeFailed(X402_HEADER.paymentSignature, "X402_PAYMENT_SIGNATURE_INVALID"));

/** Decodes a `PAYMENT-RESPONSE` header value. */
export const decodePaymentResponse = (value: string): Result<SettleResponse> =>
  wrapSync(() => decodePaymentResponseHeader(value), decodeFailed(X402_HEADER.paymentResponse, "X402_PAYMENT_RESPONSE_INVALID"));

const encodeFailed = (header: string, code: string) => (error: unknown) => ({
  category: "VALIDATION" as const,
  code,
  message: `${header} could not be encoded; the object is not serialisable`,
  retryable: false,
  details: { header },
  cause: causeOf(error),
});

/** Encodes a `PaymentRequired` as the `PAYMENT-REQUIRED` header value. */
export const encodePaymentRequired = (required: PaymentRequired): Result<string> =>
  wrapSync(() => encodePaymentRequiredHeader(required), encodeFailed(X402_HEADER.paymentRequired, "X402_PAYMENT_REQUIRED_INVALID"));

/** Encodes a `PaymentPayload` as the `PAYMENT-SIGNATURE` header value. */
export const encodePaymentSignature = (payload: PaymentPayload): Result<string> =>
  wrapSync(() => encodePaymentSignatureHeader(payload), encodeFailed(X402_HEADER.paymentSignature, "X402_PAYMENT_SIGNATURE_INVALID"));

/** Encodes a `SettleResponse` as the `PAYMENT-RESPONSE` header value. */
export const encodePaymentResponse = (settlement: SettleResponse): Result<string> =>
  wrapSync(() => encodePaymentResponseHeader(settlement), encodeFailed(X402_HEADER.paymentResponse, "X402_PAYMENT_RESPONSE_INVALID"));

/** Reads one header, tolerating a reader that throws. */
function read(headers: HeaderReader, name: string): string | undefined {
  try {
    const value = headers.get(name);
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

/**
 * The `PaymentRequired` a response carries, `ok(undefined)` when it carries none.
 *
 * Absence is not an error: a Tab `402` without this header is an ordinary credit
 * decision, and a `200` never carries one.
 */
export function readPaymentRequired(source: HeaderReader | HeaderRecord): Result<PaymentRequired | undefined> {
  const raw = read(headerReaderOf(source), X402_HEADER.paymentRequired);
  if (raw === undefined) return ok(undefined);
  const decoded = decodePaymentRequired(raw);
  if (!decoded.ok) return decoded;
  return validatePaymentRequired(decoded.value);
}

/** The `PaymentPayload` a request carries, `ok(undefined)` when it carries none. */
export function readPaymentSignature(source: HeaderReader | HeaderRecord): Result<PaymentPayload | undefined> {
  const raw = read(headerReaderOf(source), X402_HEADER.paymentSignature);
  if (raw === undefined) return ok(undefined);
  const decoded = decodePaymentSignature(raw);
  if (!decoded.ok) return decoded;
  return validatePaymentPayload(decoded.value);
}

/** The `SettleResponse` a response carries, `ok(undefined)` when it carries none. */
export function readPaymentResponse(source: HeaderReader | HeaderRecord): Result<SettleResponse | undefined> {
  const raw = read(headerReaderOf(source), X402_HEADER.paymentResponse);
  if (raw === undefined) return ok(undefined);
  const decoded = decodePaymentResponse(raw);
  if (!decoded.ok) return decoded;
  return ok(decoded.value);
}

/**
 * The shape check the codec does not do.
 *
 * `@x402/core`'s decoder parses JSON and nothing more, so a header carrying
 * `{"x402Version":2}` decodes without complaint. The fields checked here are
 * the ones the rest of this package reads, and a document missing one is
 * refused by name rather than dereferenced.
 */
export function validatePaymentRequired(value: unknown): Result<PaymentRequired> {
  if (typeof value !== "object" || value === null) {
    return validationError("X402_PAYMENT_REQUIRED_INVALID", "PaymentRequired must be an object");
  }
  const candidate = value as Partial<PaymentRequired>;
  if (candidate.x402Version !== X402_VERSION) {
    return validationError(
      "X402_VERSION_UNSUPPORTED",
      `PaymentRequired carries x402Version ${String(candidate.x402Version)}; this package speaks version ${X402_VERSION} alone`,
      { details: { x402Version: String(candidate.x402Version) } },
    );
  }
  if (typeof candidate.resource !== "object" || candidate.resource === null || typeof candidate.resource.url !== "string") {
    return validationError("X402_PAYMENT_REQUIRED_INVALID", "PaymentRequired.resource.url must be a string");
  }
  if (!Array.isArray(candidate.accepts) || candidate.accepts.length === 0) {
    return validationError("X402_PAYMENT_REQUIRED_INVALID", "PaymentRequired.accepts must be a non-empty array");
  }
  for (const [index, entry] of candidate.accepts.entries()) {
    const checked = validatePaymentRequirements(entry, `accepts[${index}]`);
    if (!checked.ok) return checked;
  }
  return ok(candidate as PaymentRequired);
}

/** Checks one `PaymentRequirements` object field by field. */
export function validatePaymentRequirements(value: unknown, label = "PaymentRequirements"): Result<PaymentRequirements> {
  if (typeof value !== "object" || value === null) {
    return validationError("X402_REQUIREMENTS_INVALID", `${label} must be an object`);
  }
  const candidate = value as Partial<PaymentRequirements>;
  for (const field of ["scheme", "network", "amount", "asset", "payTo"] as const) {
    if (typeof candidate[field] !== "string" || candidate[field].length === 0) {
      return validationError("X402_REQUIREMENTS_INVALID", `${label}.${field} must be a non-empty string`, {
        details: { field },
      });
    }
  }
  if (!/^[0-9]+$/.test(candidate.amount as string)) {
    return validationError(
      "X402_REQUIREMENTS_INVALID",
      `${label}.amount must be a decimal integer of atomic units, received \`${String(candidate.amount)}\``,
      { details: { field: "amount" } },
    );
  }
  if (typeof candidate.maxTimeoutSeconds !== "number" || !Number.isFinite(candidate.maxTimeoutSeconds) || candidate.maxTimeoutSeconds <= 0) {
    return validationError("X402_REQUIREMENTS_INVALID", `${label}.maxTimeoutSeconds must be a positive number`, {
      details: { field: "maxTimeoutSeconds" },
    });
  }
  if (candidate.extra !== undefined && (typeof candidate.extra !== "object" || candidate.extra === null)) {
    return validationError("X402_REQUIREMENTS_INVALID", `${label}.extra must be an object when present`, {
      details: { field: "extra" },
    });
  }
  return ok({ ...candidate, extra: candidate.extra ?? {} } as PaymentRequirements);
}

/** Checks a decoded `PaymentPayload` down to the EIP-3009 fields the server reads. */
export function validatePaymentPayload(value: unknown): Result<PaymentPayload> {
  if (typeof value !== "object" || value === null) {
    return validationError("X402_PAYMENT_SIGNATURE_INVALID", "PaymentPayload must be an object");
  }
  const candidate = value as Partial<PaymentPayload>;
  if (candidate.x402Version !== X402_VERSION) {
    return validationError(
      "X402_VERSION_UNSUPPORTED",
      `PaymentPayload carries x402Version ${String(candidate.x402Version)}; this package speaks version ${X402_VERSION} alone`,
      { details: { x402Version: String(candidate.x402Version) } },
    );
  }
  const accepted = validatePaymentRequirements(candidate.accepted, "PaymentPayload.accepted");
  if (!accepted.ok) return accepted;
  if (typeof candidate.payload !== "object" || candidate.payload === null) {
    return validationError("X402_PAYMENT_SIGNATURE_INVALID", "PaymentPayload.payload must be an object");
  }
  return ok({ ...candidate, accepted: accepted.value } as PaymentPayload);
}

/** How {@link selectExactRequirement} narrows a server's `accepts`. */
export interface RequirementFilter {
  /** Accept only this chain. Omitted accepts any `eip155:*` network. */
  readonly chainId?: bigint;
  /** Accept only this token, compared case-insensitively. Omitted accepts any. */
  readonly asset?: Address;
  /** Refuse a requirement above this many atomic units. Omitted sets no ceiling. */
  readonly maxAmount?: bigint;
}

/** Why one `accepts` entry was passed over, for the error when none is usable. */
interface Skipped {
  readonly index: number;
  readonly reason: string;
}

/**
 * The first `accepts` entry this package can sign, in the server's order.
 *
 * The server's order is its preference and is kept. An entry is passed over
 * when it is not `exact`, not on an EVM chain, names a transfer method other
 * than EIP-3009, declares a payment flow other than `authorization`, or fails
 * the caller's filter. Every reason is carried on the error when nothing
 * matches, because "no usable requirement" is not actionable and "the server
 * accepts Base only and this Agent signs on Monad" is.
 */
export function selectExactRequirement(
  required: PaymentRequired,
  filter: RequirementFilter = {},
): Result<PaymentRequirements> {
  const skipped: Skipped[] = [];
  for (const [index, entry] of required.accepts.entries()) {
    const reason = disqualify(entry, filter);
    if (reason === undefined) return ok(entry);
    skipped.push({ index, reason });
  }
  return validationError(
    "X402_NO_USABLE_REQUIREMENT",
    `none of the ${required.accepts.length} payment options for ${required.resource.url} can be signed here: ${skipped
      .map((entry) => `accepts[${entry.index}] ${entry.reason}`)
      .join("; ")}`,
    {
      details: {
        url: required.resource.url,
        options: required.accepts.length,
        ...(filter.chainId === undefined ? {} : { chainId: filter.chainId.toString(10) }),
        ...(filter.asset === undefined ? {} : { asset: filter.asset.toLowerCase() }),
      },
    },
  );
}

function disqualify(entry: PaymentRequirements, filter: RequirementFilter): string | undefined {
  if (entry.scheme !== X402_SCHEME_EXACT) return `uses scheme \`${entry.scheme}\`, and only \`exact\` is signed here`;
  const chainId = chainIdOfNetwork(entry.network);
  if (!chainId.ok) return `is on \`${entry.network}\`, which is not an EVM network`;
  if (filter.chainId !== undefined && chainId.value !== filter.chainId) {
    return `is on chain ${chainId.value.toString(10)} and the signer is on chain ${filter.chainId.toString(10)}`;
  }
  const method = entry.extra?.["assetTransferMethod"];
  if (method !== undefined && method !== X402_TRANSFER_METHOD_EIP3009) {
    return `needs asset transfer method \`${String(method)}\`, and only \`${X402_TRANSFER_METHOD_EIP3009}\` is signed here`;
  }
  const flow = entry.extra?.["paymentFlow"];
  if (flow !== undefined && flow !== "authorization") {
    return `declares payment flow \`${String(flow)}\`, and only \`authorization\` is signed here`;
  }
  if (!isAddress(entry.asset)) return `names asset \`${entry.asset}\`, which is not a 20-byte address`;
  if (filter.asset !== undefined && entry.asset.toLowerCase() !== filter.asset.toLowerCase()) {
    return `is priced in ${entry.asset.toLowerCase()} and the signer pays in ${filter.asset.toLowerCase()}`;
  }
  if (!isAddress(entry.payTo)) return `names payTo \`${entry.payTo}\`, which is not a 20-byte address`;
  if (typeof entry.extra?.["name"] !== "string" || typeof entry.extra?.["version"] !== "string") {
    return "carries no EIP-712 domain name and version in extra, which EIP-3009 signing needs";
  }
  if (filter.maxAmount !== undefined && BigInt(entry.amount) > filter.maxAmount) {
    return `asks ${entry.amount} atomic units, above the ceiling of ${filter.maxAmount.toString(10)}`;
  }
  return undefined;
}
