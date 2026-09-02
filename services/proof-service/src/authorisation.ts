/**
 * Who may be charged, and how this Service knows it is really them.
 *
 * ## The Agent signs for itself, which the gateway's model could not do
 *
 * `apps/gateway/src/authorisation.ts` authenticates the **Service operator**,
 * because the gateway is called by the operator's own front end and the danger it
 * guards is a stranger charging an Agent through it. The Proof Service is a public
 * endpoint an Agent calls directly, so the same digest signed by the same party
 * would be nonsense here: the operator is not the caller.
 *
 * So the claim is signed by the Agent's own Creditcoin key and
 * {@link verifyAgentRequest} requires the recovered address to equal the `Tab-Agent`
 * header. That makes `Tab-Agent` an authentication rather than an assertion, and it
 * closes the one gap the gateway leaves open: a stranger cannot burn an Agent's
 * authorisation ceiling by naming it in a header.
 *
 * The digest binds the method, the path, the Agent, the tool, the unit count, the
 * Source Chain reference, and a timestamp. Binding the reference is what stops a
 * captured signature buying a different proof, and binding the units is what stops
 * it buying a hundred of them.
 *
 * ## Consent is on chain and no header can widen it
 *
 * Even authenticated, the charge is bounded by the spending authorisation the Agent
 * set itself with `TabBook.authorise`: a cumulative ceiling and an expiry.
 * `TabBook` derives the authorisation key from `(agent, serviceId, asset)` itself,
 * so nothing on the wire can redirect a charge. The reads below never gate the
 * contract, which checks all of this itself and reverts; they exist so this Service
 * can tell an Agent what it must do rather than relaying a bare revert.
 *
 * Requirements: 22.3, 12.1, 12.2, 12.3, 21.5
 */

import { Interface, verifyMessage, type JsonRpcProvider } from "ethers";

import { causeOf, err, ok, type Result } from "@tabai/shared";

/** How far a signed request may be from this Service's clock. */
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** Header carrying the Agent's signature over {@link proofRequestDigest}. */
export const SIGNATURE_HEADER = "Tab-Agent-Signature";

/** Header carrying the millisecond timestamp the signature was issued at. */
export const ISSUED_AT_HEADER = "Tab-Agent-Issued-At";

/** The authorisation read. Field order is wire order. */
export const AUTHORISATION_ABI = [
  "function authorisationOf(address agent, bytes32 serviceId, address asset) view returns ((uint128 maxCumulative, uint128 spent, uint64 expiry, bool exists) authorisation)",
] as const;

const AUTHORISATION_INTERFACE = new Interface([...AUTHORISATION_ABI]);

/** The fields a proof request signature binds. */
export interface ProofRequestClaim {
  readonly method: string;
  readonly path: string;
  readonly agent: string;
  readonly tool: string;
  readonly units: number;
  /** The Source Chain the proof is about, as a decimal chainKey. */
  readonly chainKey: string;
  /** The Source Chain transaction the proof is about. */
  readonly sourceTxHash: string;
  /** Milliseconds since the epoch, as the Agent stated it. */
  readonly issuedAt: number;
}

/**
 * The exact string the Agent signs.
 *
 * Newline-separated and fully ordered, so two different claims can never produce
 * one digest. Written out rather than JSON-encoded because JSON key order is not
 * guaranteed across implementations, and a signature over a reordered object would
 * fail for a caller who did nothing wrong.
 */
export function proofRequestDigest(claim: ProofRequestClaim): string {
  return [
    "tab-proof-request",
    claim.method.toUpperCase(),
    claim.path,
    claim.agent.toLowerCase(),
    claim.tool.toLowerCase(),
    String(claim.units),
    claim.chainKey,
    claim.sourceTxHash.toLowerCase(),
    String(claim.issuedAt),
  ].join("\n");
}

/**
 * Recovers the signer and requires it to be the Agent named in the claim.
 *
 * The freshness check is what stops a captured signature being replayed forever,
 * and it is deliberately two-sided: a timestamp far in the future is refused as
 * well, because accepting one would let a caller mint a signature that outlives any
 * key rotation.
 */
export function verifyAgentRequest(
  claim: ProofRequestClaim,
  signature: string,
  nowMs: number,
  windowMs: number = SIGNATURE_WINDOW_MS,
): Result<{ readonly signer: string }> {
  const skew = Math.abs(nowMs - claim.issuedAt);
  if (!Number.isFinite(claim.issuedAt) || skew > windowMs) {
    return err({
      category: "AUTHORISATION",
      code: "PROOF_SIGNATURE_STALE",
      message: `the proof request is timestamped ${Math.round(skew / 1000)}s from this service's clock, past the ${windowMs / 1000}s window`,
      retryable: false,
    });
  }

  let recovered: string;
  try {
    recovered = verifyMessage(proofRequestDigest(claim), signature);
  } catch (error) {
    return err({
      category: "AUTHORISATION",
      code: "PROOF_SIGNATURE_MALFORMED",
      message: "the proof request signature could not be recovered",
      retryable: false,
      cause: causeOf(error),
    });
  }

  if (recovered.toLowerCase() !== claim.agent.toLowerCase()) {
    return err({
      category: "AUTHORISATION",
      code: "PROOF_SIGNATURE_NOT_AGENT",
      message: `the proof request names Agent ${claim.agent} and was signed by ${recovered}, so the caller is not the Agent it would charge`,
      retryable: false,
      details: { recovered, agent: claim.agent },
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
 * anything.
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
    const data = AUTHORISATION_INTERFACE.encodeFunctionData("authorisationOf", [
      agent,
      serviceId,
      asset,
    ]);
    const returned = await provider.call({ to: tabBook, data, blockTag });
    const fields = AUTHORISATION_INTERFACE.decodeFunctionResult(
      "authorisationOf",
      returned,
    )[0] as readonly unknown[];
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
      message: `this Agent's spending authorisation expired at ${authorisation.expiry.toString(10)}; the Agent must set a fresh one`,
      retryable: false,
    });
  }
  if (charge > authorisation.remaining) {
    return err({
      category: "AUTHORISATION",
      code: "AUTHORISATION_EXCEEDED",
      message: `this charge of ${charge.toString(10)} exceeds the ${authorisation.remaining.toString(10)} left on the Agent's authorisation ceiling of ${authorisation.maxCumulative.toString(10)}`,
      retryable: false,
    });
  }
  return ok(undefined);
}
