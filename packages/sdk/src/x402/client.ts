/**
 * The x402 client: sign an EIP-3009 authorization for an `exact` requirement
 * and repeat the request with it.
 *
 * ## Where this sits in Tab
 *
 * Tab never asks an Agent to prepay. This client exists for the two moments a
 * prepayment is the right answer anyway: an Agent with no headroom that would
 * rather pay for one call than settle a tab first, and a Service fronting an
 * x402 upstream that has to pay the upstream before it can meter the Agent.
 * In both, the payment is one call's worth, signed by whoever holds the key,
 * and nothing about the Open Tab changes.
 *
 * ## The signing is hand-rolled, and here is the check on it
 *
 * `@x402/evm` is the official client for this scheme and it is built on viem.
 * This package signs with ethers, so pulling it in would ship a second EVM
 * library to sign one struct. The struct is small enough to state:
 *
 * - EIP-712 domain `{ name, version, chainId, verifyingContract }`, with `name`
 *   and `version` from `requirements.extra`, `chainId` from the CAIP-2 network,
 *   and `verifyingContract` the token (`scheme_exact_evm.md`, section 1);
 * - primary type `TransferWithAuthorization(address from, address to, uint256
 *   value, uint256 validAfter, uint256 validBefore, bytes32 nonce)` (EIP-3009);
 * - `validAfter` `0`, `validBefore` now plus `maxTimeoutSeconds`, and a random
 *   32-byte `nonce`, exactly as `@x402/evm`'s `createEIP3009Payload` builds them.
 *
 * The test suite recovers the signer from every signature this file produces
 * against that domain and struct, so a drift from the scheme fails a test.
 *
 * Specification: scheme_exact_evm.md section 1, x402-specification-v2.md section 5.2.
 */

import { getAddress, hexlify, randomBytes, type Signer } from "ethers";
import { causeOf, ok, wrap, type Address, type Hex, type Result } from "@tabai/shared";

import { fail, upstreamError, validationError } from "../errors.js";
import { headerReaderOf, type HeaderReader, type HeaderRecord } from "../http/headers.js";
import { defaultLogger, type Logger } from "../logger.js";
import {
  X402_HEADER,
  X402_VERSION,
  chainIdOfNetwork,
  encodePaymentSignature,
  readPaymentRequired,
  readPaymentResponse,
  selectExactRequirement,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type RequirementFilter,
  type SettleResponse,
} from "./wire.js";

/**
 * What signs an x402 payment.
 *
 * Structural rather than the `ethers` class, so a test double or any wallet
 * that can sign typed data satisfies it. An `ethers.Signer` does as it stands;
 * the assertion below fails to compile if that ever stops being true.
 */
export interface X402Signer {
  getAddress(): Promise<string>;
  signTypedData(
    domain: { name: string; version: string; chainId: bigint | number; verifyingContract: string },
    types: Record<string, readonly { name: string; type: string }[]>,
    value: Record<string, unknown>,
  ): Promise<string>;
}

type Assert<T extends true> = T;
type SignerIsAccepted = Assert<Signer extends X402Signer ? true : false>;
export type X402SignerAcceptsEthersSigner = SignerIsAccepted;

/**
 * A signer built only when a payment is about to be signed.
 *
 * Returning `undefined` means "not available here", the same answer a payment
 * strategy factory may give: the offer is declined and the `402` stands as the
 * credit decision it was. That is what keeps every read keyless: a config file
 * declares the factory, and nothing calls it until a prepayment is the answer.
 */
export type X402SignerFactory = () => X402Signer | undefined | Promise<X402Signer | undefined>;

/** A signer, or a factory that may produce one. */
export type X402SignerSource = X402Signer | X402SignerFactory;

/** Resolves a source. `ok(undefined)` is a factory declining; `err` is a factory that threw. */
export async function resolveX402Signer(source: X402SignerSource | undefined): Promise<Result<X402Signer | undefined>> {
  if (source === undefined) return ok(undefined);
  if (typeof source !== "function") return ok(source);
  const produced = await wrap(
    async () => (await source()) as unknown,
    (error) => ({
      category: "UPSTREAM" as const,
      code: "X402_SIGNER_FACTORY_FAILED",
      message: "the x402 signer factory threw",
      retryable: false,
      cause: causeOf(error),
    }),
  );
  if (!produced.ok) return produced;
  if (produced.value === undefined || produced.value === null) return ok(undefined);
  const candidate = produced.value as Partial<X402Signer>;
  if (typeof candidate.getAddress !== "function" || typeof candidate.signTypedData !== "function") {
    return validationError("X402_SIGNER_INVALID", "the x402 signer factory returned something without getAddress() and signTypedData()");
  }
  return ok(candidate as X402Signer);
}

/** The EIP-712 type of the struct EIP-3009 `transferWithAuthorization` verifies. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** The authorization as it goes on the wire: every number a decimal string. */
export interface Eip3009Authorization {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: Hex;
}

export interface SignExactPaymentOptions {
  readonly signer: X402Signer;
  /** The server's `PaymentRequired`, echoed into the payload as `resource` and `extensions`. */
  readonly required: PaymentRequired;
  /** The entry of `required.accepts` being paid. */
  readonly accepted: PaymentRequirements;
  /** Seconds since the epoch. Defaults to the wall clock. */
  readonly now?: () => number;
  /** A 32-byte nonce. Defaults to random. A test passes a fixed one. */
  readonly nonce?: () => Hex;
}

/** What a signature is for, kept beside the payload so a receipt can be built without re-reading it. */
export interface SignedExactPayment {
  readonly payload: PaymentPayload;
  readonly authorization: Eip3009Authorization;
  readonly chainId: bigint;
  readonly payer: Address;
}

/**
 * Signs one `exact` requirement.
 *
 * The domain and the struct are exactly what `@x402/evm` signs, so
 * the facilitator's recovery lands on `authorization.from`. The requirement is
 * re-validated here rather than trusted, because it arrived over the network.
 */
export async function signExactPayment(options: SignExactPaymentOptions): Promise<Result<SignedExactPayment>> {
  const { accepted } = options;
  const chainId = chainIdOfNetwork(accepted.network);
  if (!chainId.ok) return chainId;
  const name = accepted.extra?.["name"];
  const version = accepted.extra?.["version"];
  if (typeof name !== "string" || typeof version !== "string") {
    return validationError(
      "X402_DOMAIN_MISSING",
      `the requirement for ${accepted.asset} carries no EIP-712 domain name and version in extra, so an EIP-3009 authorization cannot be signed for it`,
      { details: { asset: accepted.asset, network: accepted.network } },
    );
  }
  if (!/^[0-9]+$/.test(accepted.amount)) {
    return validationError("X402_REQUIREMENTS_INVALID", `amount \`${accepted.amount}\` is not a decimal integer of atomic units`);
  }

  const from = await wrap(
    async () => options.signer.getAddress(),
    (error) => ({
      category: "UPSTREAM" as const,
      code: "X402_SIGNER_UNAVAILABLE",
      message: "the x402 signer could not report its address",
      retryable: false,
      cause: causeOf(error),
    }),
  );
  if (!from.ok) return from;

  const checksummed = wrapAddresses(from.value, accepted.payTo, accepted.asset);
  if (!checksummed.ok) return checksummed;
  const [payer, payTo, asset] = checksummed.value;

  const nowSeconds = options.now === undefined ? Math.floor(Date.now() / 1000) : options.now();
  const authorization: Eip3009Authorization = {
    from: payer,
    to: payTo,
    value: accepted.amount,
    validAfter: "0",
    validBefore: (nowSeconds + Math.floor(accepted.maxTimeoutSeconds)).toString(10),
    nonce: options.nonce === undefined ? (hexlify(randomBytes(32)) as Hex) : options.nonce(),
  };

  const signature = await wrap(
    async () =>
      options.signer.signTypedData(
        { name, version, chainId: chainId.value, verifyingContract: asset },
        TRANSFER_WITH_AUTHORIZATION_TYPES,
        {
          from: authorization.from,
          to: authorization.to,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce,
        },
      ),
    (error) => ({
      category: "UPSTREAM" as const,
      code: "X402_SIGNING_FAILED",
      message: "the x402 signer refused to sign the EIP-3009 authorization",
      retryable: false,
      cause: causeOf(error),
    }),
  );
  if (!signature.ok) return signature;

  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    resource: options.required.resource,
    accepted,
    payload: { signature: signature.value, authorization },
    // Echoed unchanged, as `@x402/evm` does: the server advertised
    // them and validates that what comes back carries at least what it sent.
    ...(options.required.extensions === undefined ? {} : { extensions: options.required.extensions }),
  };
  return ok({ payload, authorization, chainId: chainId.value, payer: payer.toLowerCase() as Address });
}

/** Checksums the three addresses a payload carries, or names the one that is not an address. */
function wrapAddresses(from: string, payTo: string, asset: string): Result<[string, string, string]> {
  const checked: string[] = [];
  for (const [label, value] of [
    ["signer address", from],
    ["payTo", payTo],
    ["asset", asset],
  ] as const) {
    try {
      checked.push(getAddress(value));
    } catch {
      return validationError("X402_REQUIREMENTS_INVALID", `${label} \`${value}\` is not a 20-byte address`, {
        details: { field: label, value },
      });
    }
  }
  return ok(checked as [string, string, string]);
}

/** One payment this client made, as the facilitator reported it back. */
export interface X402PaymentReceipt {
  /** The settlement transaction hash. Empty when the server reported success without one. */
  readonly txHash: string;
  readonly network: string;
  readonly chainId: bigint;
  /** Atomic units of `asset`, as the requirement priced it. */
  readonly amount: bigint;
  readonly asset: Address;
  readonly payTo: Address;
  readonly payer: Address;
  /** The absolute URL the payment bought. */
  readonly url: string;
  readonly requirement: PaymentRequirements;
  readonly settlement: SettleResponse;
  readonly observedAt: number;
}

/** The little of a response this client reads. Structural, as in `client-402.ts`. */
export interface X402Response {
  readonly status: number;
  readonly headers: HeaderReader | HeaderRecord;
  readonly body?: unknown;
  readonly bodyUsed?: unknown;
}

export interface X402FetchInit {
  readonly headers: Readonly<Record<string, string>>;
  readonly [option: string]: unknown;
}

export type X402Fetch<Res extends X402Response> = (url: string, init: X402FetchInit) => Promise<Res>;

export interface X402ClientOptions<Res extends X402Response = X402Response> extends RequirementFilter {
  readonly signer: X402Signer;
  readonly fetchImpl?: X402Fetch<Res>;
  /**
   * Consulted after the server's `402` and before anything is signed. A refusal
   * stops the payment and is returned as the error. This is where a Service
   * fronting an upstream checks that the Agent it will meter has the headroom
   * before the Service's own funds move.
   */
  readonly authorise?: (requirement: PaymentRequirements, required: PaymentRequired) => Promise<Result<void>> | Result<void>;
  readonly onPayment?: (receipt: X402PaymentReceipt) => void;
  readonly logger?: Logger;
  /** Milliseconds since the epoch, for `observedAt`. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Seconds since the epoch, for `validBefore`. Defaults to the wall clock. */
  readonly nowSeconds?: () => number;
  readonly nonce?: () => Hex;
}

/** What one call did: the response, and the payment that bought it if one did. */
export interface X402FetchResult<Res extends X402Response = X402Response> {
  readonly response: Res;
  readonly payment?: X402PaymentReceipt;
}

export interface X402Client<Res extends X402Response = X402Response> {
  /**
   * Sends the request; on a `402` carrying `PAYMENT-REQUIRED`, signs and sends
   * it once more with `PAYMENT-SIGNATURE`. Exactly once: a second `402` means
   * the payment was refused, and that is returned as an error naming why.
   */
  fetch(url: string, init?: X402FetchInit): Promise<Result<X402FetchResult<Res>>>;
  /**
   * Pays a `402` the caller already holds: the same second step, for a caller
   * that made the first request itself.
   */
  pay(url: string, init: X402FetchInit, required: PaymentRequired): Promise<Result<X402FetchResult<Res>>>;
  /** Every payment made, oldest first. */
  payments(): readonly X402PaymentReceipt[];
}

/**
 * Builds the client. Construction is total; every failure belongs to a call.
 */
export function createX402Client<Res extends X402Response = X402Response>(
  options: X402ClientOptions<Res>,
): X402Client<Res> {
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => Date.now());
  const history: X402PaymentReceipt[] = [];
  const filter: RequirementFilter = {
    ...(options.chainId === undefined ? {} : { chainId: options.chainId }),
    ...(options.asset === undefined ? {} : { asset: options.asset }),
    ...(options.maxAmount === undefined ? {} : { maxAmount: options.maxAmount }),
  };

  const send = async (url: string, init: X402FetchInit, attempt: 1 | 2): Promise<Result<Res>> => {
    const impl = options.fetchImpl ?? hostFetch<Res>();
    if (impl === undefined) {
      return upstreamError("FETCH_UNAVAILABLE", "this host has no global fetch; supply fetchImpl, or run on Node 20.10 or later");
    }
    const sent = await wrap(
      async () => impl(url, init),
      (error) => ({
        category: "UPSTREAM" as const,
        code: "FETCH_FAILED",
        message: `the request to ${url} did not complete`,
        retryable: true,
        details: { url, attempt },
        cause: causeOf(error),
      }),
    );
    if (!sent.ok) return sent;
    if (!looksLikeResponse(sent.value)) {
      return upstreamError("FETCH_RESPONSE_INVALID", `the fetch given to this client returned something that is not a response for ${url}`, {
        details: { url, attempt },
      });
    }
    return ok(sent.value);
  };

  const pay = async (url: string, init: X402FetchInit, required: PaymentRequired): Promise<Result<X402FetchResult<Res>>> => {
    const accepted = selectExactRequirement(required, filter);
    if (!accepted.ok) return accepted;

    if (options.authorise !== undefined) {
      const allowed = await wrap(
        async () => options.authorise?.(accepted.value, required),
        (error) => ({
          category: "INTERNAL" as const,
          code: "X402_AUTHORISE_THREW",
          message: "the authorise hook threw, so nothing was signed",
          retryable: false,
          cause: causeOf(error),
        }),
      );
      if (!allowed.ok) return allowed;
      if (allowed.value !== undefined && !allowed.value.ok) return allowed.value;
    }

    if (!isReplayable(init["body"])) {
      return validationError(
        "REQUEST_BODY_NOT_REPLAYABLE",
        `${url} asks for payment and the request body is a stream, which cannot be sent a second time; buffer the body before calling`,
        { details: { url } },
      );
    }

    const signed = await signExactPayment({
      signer: options.signer,
      required,
      accepted: accepted.value,
      ...(options.nowSeconds === undefined ? {} : { now: options.nowSeconds }),
      ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    });
    if (!signed.ok) return signed;

    const header = encodePaymentSignature(signed.value.payload);
    if (!header.ok) return header;

    const paid = await send(url, { ...init, headers: { ...init.headers, [X402_HEADER.paymentSignature]: header.value } }, 2);
    if (!paid.ok) return paid;
    const response = paid.value;

    const settlement = readPaymentResponse(headerReaderOf(response.headers));
    if (!settlement.ok) {
      discard(response, logger);
      return settlement;
    }

    if (response.status === 402) {
      discard(response, logger);
      const reason = settlement.value?.errorReason ?? readError(response.headers) ?? "the server did not say why";
      return fail("LIMIT", "X402_PAYMENT_REJECTED", `${url} refused the signed payment: ${reason}`, {
        retryable: false,
        details: {
          url,
          reason,
          amount: accepted.value.amount,
          asset: accepted.value.asset.toLowerCase(),
          network: accepted.value.network,
        },
      });
    }

    const receipt: X402PaymentReceipt = {
      txHash: settlement.value?.transaction ?? "",
      network: accepted.value.network,
      chainId: signed.value.chainId,
      amount: BigInt(accepted.value.amount),
      asset: accepted.value.asset.toLowerCase() as Address,
      payTo: accepted.value.payTo.toLowerCase() as Address,
      payer: signed.value.payer,
      url,
      requirement: accepted.value,
      settlement: settlement.value ?? { success: response.status < 400, transaction: "", network: accepted.value.network },
      observedAt: now(),
    };
    history.push(receipt);
    if (options.onPayment !== undefined) {
      try {
        options.onPayment(receipt);
      } catch (error) {
        logger.warn("onPayment threw and the payment was recorded anyway", { url, error: causeOf(error).message });
      }
    }
    return ok({ response, payment: receipt });
  };

  return {
    async fetch(url, init = { headers: {} }) {
      const first = await send(url, init, 1);
      if (!first.ok) return first;
      if (first.value.status !== 402) return ok({ response: first.value });

      const required = readPaymentRequired(headerReaderOf(first.value.headers));
      discard(first.value, logger);
      if (!required.ok) return required;
      if (required.value === undefined) {
        return fail("LIMIT", "X402_PAYMENT_REQUIRED_MISSING", `${url} answered 402 without a ${X402_HEADER.paymentRequired} header, so there is nothing to pay`, {
          retryable: false,
          details: { url },
        });
      }
      return pay(url, init, required.value);
    },
    pay,
    payments: () => [...history],
  };
}

/** The `error` field of a `PAYMENT-REQUIRED` a refusal may carry, when it carries one. */
function readError(headers: HeaderReader | HeaderRecord): string | undefined {
  const required = readPaymentRequired(headers);
  return required.ok ? required.value?.error : undefined;
}

function looksLikeResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { status?: unknown; headers?: unknown };
  return typeof candidate.status === "number" && typeof candidate.headers === "object" && candidate.headers !== null;
}

/** A stream cannot be sent twice; everything else can. */
function isReplayable(body: unknown): boolean {
  if (body === undefined || body === null || typeof body !== "object") return true;
  const candidate = body as { getReader?: unknown; [Symbol.asyncIterator]?: unknown };
  return typeof candidate.getReader !== "function" && typeof candidate[Symbol.asyncIterator] !== "function";
}

/** Releases a response that is not going out, so its connection does not wait for the collector. */
function discard(response: X402Response, logger: Logger): void {
  const body = response.body as { cancel?: unknown } | null | undefined;
  if (body === null || body === undefined || typeof body.cancel !== "function" || response.bodyUsed === true) return;
  try {
    const cancelled = (body.cancel as () => unknown)();
    if (typeof (cancelled as { catch?: unknown })?.catch === "function") {
      (cancelled as Promise<unknown>).catch((error: unknown) => {
        logger.debug("discarded response body could not be cancelled", causeOf(error));
      });
    }
  } catch (error) {
    logger.debug("discarded response body could not be cancelled", causeOf(error));
  }
}

function hostFetch<Res extends X402Response>(): X402Fetch<Res> | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as X402Fetch<Res>) : undefined;
}
