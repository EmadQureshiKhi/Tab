/**
 * Who may charge, and who may be charged.
 *
 * Two different questions, answered by two different mechanisms, and conflating
 * them is how a metering endpoint becomes a way to drain every Agent that ever
 * authorised the Service.
 *
 * ## The caller is authenticated by signature
 *
 * `TabBook.recordDelivery` is gated on the Service operator, so the gateway holds
 * that key and every request it accepts spends the operator's authority. An
 * unauthenticated metering endpoint would therefore let any stranger charge any
 * Agent up to that Agent's whole authorisation ceiling. The caller signs a request
 * digest with the Service operator key and {@link verifyMeteringRequest} recovers
 * the address, so the gateway charges only for requests the operator actually made.
 *
 * The digest binds the method, the path, the Agent, the tool, the unit count, and
 * a timestamp. Binding the Agent and the units is the point: a signature over the
 * path alone would be a bearer token that replays against a different Agent for a
 * different amount.
 *
 * ## The Agent is identified, and its consent is already on chain
 *
 * `Tab-Agent` is a claim and never an authentication, and it does not need to be
 * one. The Agent's consent is the on-chain spending authorisation it set itself
 * with `TabBook.authorise`, which fixes a cumulative ceiling and an expiry that no
 * header can widen. `TabBook` derives the authorisation key from
 * `(agent, serviceId, asset)` itself, so a forged `Tab-Authorisation` cannot
 * redirect a charge either. The worst a false `Tab-Agent` achieves is a charge
 * against an Agent that never authorised this Service, which reverts
 * `AuthorisationMissing` and moves nothing.
 *
 * Requirements: 12.1, 12.2, 12.3, 21.5
 */

import { Interface, verifyMessage, type JsonRpcProvider } from "ethers";

import { causeOf, err, ok, type Result } from "@tabai/shared";

/** How far a signed metering request may be from the gateway's clock. */
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** The authorisation read. Field order is wire order. */
export const AUTHORISATION_ABI = [
  "function authorisationOf(address agent, bytes32 serviceId, address asset) view returns ((uint128 maxCumulative, uint128 spent, uint64 expiry, bool exists) authorisation)",
] as const;

const AUTHORISATION_INTERFACE = new Interface([...AUTHORISATION_ABI]);

/** The fields a metering request signature binds. */
export interface MeteringRequestClaim {
  readonly method: string;
  readonly path: string;
  readonly agent: string;
  readonly tool: string;
  readonly units: number;
  /** Milliseconds since the epoch, as the caller stated it. */
  readonly issuedAt: number;
}

/**
 * The exact string the operator signs.
 *
 * Newline-separated and fully ordered, so two different claims can never produce
 * one digest. Written out rather than JSON-encoded because JSON key order is not
 * guaranteed across implementations and a signature over a reordered object would
 * fail for a caller who did nothing wrong.
 */
export function meteringDigest(claim: MeteringRequestClaim): string {
  return [
    "tab-metering-request",
    claim.method.toUpperCase(),
    claim.path,
    claim.agent.toLowerCase(),
    claim.tool.toLowerCase(),
    String(claim.units),
    String(claim.issuedAt),
  ].join("\n");
}

/**
 * Recovers the signer and checks it is the Service operator, inside the window.
 *
 * The freshness check is what stops a captured signature being replayed forever.
 * It is deliberately two-sided: a timestamp far in the future is refused as well,
 * because accepting one would let a caller mint a signature that stays valid long
 * after the operator key is rotated.
 */
export function verifyMeteringRequest(
  claim: MeteringRequestClaim,
  signature: string,
  operator: string,
  nowMs: number,
  windowMs: number = SIGNATURE_WINDOW_MS,
): Result<{ readonly signer: string }> {
  const skew = Math.abs(nowMs - claim.issuedAt);
  if (!Number.isFinite(claim.issuedAt) || skew > windowMs) {
    return err({
      category: "AUTHORISATION",
      code: "METERING_SIGNATURE_STALE",
      message: `the metering request is timestamped ${Math.round(skew / 1000)}s from this gateway's clock, past the ${windowMs / 1000}s window`,
      retryable: false,
    });
  }

  let recovered: string;
  try {
    recovered = verifyMessage(meteringDigest(claim), signature);
  } catch (error) {
    return err({
      category: "AUTHORISATION",
      code: "METERING_SIGNATURE_MALFORMED",
      message: "the metering request signature could not be recovered",
      retryable: false,
      cause: causeOf(error),
    });
  }

  if (recovered.toLowerCase() !== operator.toLowerCase()) {
    return err({
      category: "AUTHORISATION",
      code: "METERING_SIGNATURE_NOT_OPERATOR",
      message: `the metering request was signed by ${recovered}, which is not the Service operator ${operator}`,
      retryable: false,
      details: { recovered, operator },
    });
  }

  return ok({ signer: recovered.toLowerCase() });
}

/** One Agent's on-chain spending authorisation for a Service and Asset. */
export interface AgentAuthorisation {
  readonly maxCumulative: bigint;
  readonly spent: bigint;
  readonly expiry: bigint;
  readonly exists: boolean;
  /** `maxCumulative - spent`, floored at zero. */
  readonly remaining: bigint;
}

/**
 * Reads the Agent's authorisation, so a refusal can be explained before it is paid for.
 *
 * The contract checks this itself and reverts `AuthorisationMissing`,
 * `AuthorisationExpired`, or `AuthorisationExceeded`, so this read never gates
 * anything. It exists so the gateway can tell an Agent what it needs to do rather
 * than relaying a bare revert, and so a driver can say plainly that no
 * authorisation is set instead of failing at the last step.
 */
export async function readAuthorisation(
  provider: JsonRpcProvider,
  tabBook: string,
  agent: string,
  serviceId: string,
  asset: string,
  blockTag: string | number,
): Promise<Result<AgentAuthorisation>> {
  try {
    const data = AUTHORISATION_INTERFACE.encodeFunctionData("authorisationOf", [agent, serviceId, asset]);
    const returned = await provider.call({ to: tabBook, data, blockTag });
    const fields = AUTHORISATION_INTERFACE.decodeFunctionResult("authorisationOf", returned)[0] as readonly unknown[];
    const maxCumulative = BigInt(fields[0] as bigint);
    const spent = BigInt(fields[1] as bigint);
    return ok({
      maxCumulative,
      spent,
      expiry: BigInt(fields[2] as bigint),
      exists: fields[3] === true,
      remaining: maxCumulative > spent ? maxCumulative - spent : 0n,
    });
  } catch (error) {
    return err({
      category: "UPSTREAM",
      code: "AUTHORISATION_UNREADABLE",
      message: "the Agent's spending authorisation could not be read",
      retryable: true,
      cause: causeOf(error),
    });
  }
}

/** Whether an authorisation covers one charge, and what to say when it does not. */
export function authorisationCovers(
  authorisation: AgentAuthorisation,
  charge: bigint,
  nowSeconds: bigint,
): Result<void> {
  if (!authorisation.exists) {
    return err({
      category: "AUTHORISATION",
      code: "AUTHORISATION_MISSING",
      message:
        "this Agent has set no spending authorisation for this Service and Asset, so nothing may be charged; the Agent itself must call TabBook.authorise",
      retryable: false,
    });
  }
  if (authorisation.expiry <= nowSeconds) {
    return err({
      category: "AUTHORISATION",
      code: "AUTHORISATION_EXPIRED",
      message: `this Agent's spending authorisation expired at ${authorisation.expiry}; the Agent must set a fresh one`,
      retryable: false,
    });
  }
  if (charge > authorisation.remaining) {
    return err({
      category: "AUTHORISATION",
      code: "AUTHORISATION_EXCEEDED",
      message: `this charge of ${charge} exceeds the ${authorisation.remaining} left on the Agent's authorisation ceiling of ${authorisation.maxCumulative}`,
      retryable: false,
    });
  }
  return ok(undefined);
}
