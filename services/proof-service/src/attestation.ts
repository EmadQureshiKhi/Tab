/**
 * The attested frontier, read from the ChainInfo Precompile.
 *
 * This is the check that decides whether a request can be served at all, and R22.5
 * makes it the one refusal that must name figures rather than a reason: a Source
 * Chain height that is not yet attested comes back naming the requested height and
 * the current attested height, with **zero** Metered Delivery recorded. An Agent
 * that is told only "not yet" has to poll blindly; an Agent that is told it asked
 * for 25,876,970 against a frontier of 25,876,900 knows exactly how far behind the
 * frontier is and can wait the right amount of time.
 *
 * ## Three properties of this ABI are load-bearing
 *
 * 1. **Method names are `snake_case`, and a name is a selector.**
 *    `get_latest_attestation_height_and_hash(uint64)` is the real name; the
 *    camelCase spelling an EVM developer reaches for first was called against the
 *    live precompile and reverted `"Unknown selector"`. Aliasing is not cosmetic
 *    here, it makes every call fail.
 * 2. **Every non-trivial return is a struct, and field order is wire order.**
 *    Decoding below is positional for that reason. Reordering a field still
 *    compiles and silently mis-decodes.
 * 3. **`exists` and `isAttestation` are different questions.** `exists: false`
 *    means no record at all. `isAttestation: false` means the record is a
 *    *checkpoint* on the coarser grid rather than an attestation. A frontier that
 *    is only a checkpoint is still a frontier proof material can be built below,
 *    which is why this module reports both flags rather than collapsing them.
 *
 * ## Why the precompile rather than the Proof Builder
 *
 * The Proof Builder publishes an attested height too, and the Watcher corroborates
 * against it because a builder that has not ingested a height yet answers a miss
 * for a height that is genuinely attested. The authority is the other way round for
 * a refusal: this Service refuses to charge for a height the **chain** has not
 * attested, so the figure in the refusal is the chain's own. The builder's view is
 * carried alongside when it is available, as corroboration and never as the test.
 *
 * Requirements: 22.1, 22.5, 20.1, 20.12
 */

import { Interface, type JsonRpcProvider } from "ethers";

import { causeOf, err, ok, type Result, type TabError } from "@tabai/shared";

/**
 * Names probed against the live precompile that do **not** exist, each having
 * reverted with `"Unknown selector"`, paired with the name that does.
 */
export const ASSUMED_NAMES_THAT_DO_NOT_EXIST: Readonly<Record<string, string>> = {
  "latestAttestedHeight(uint64)": "get_latest_attestation_height_and_hash(uint64)",
  "supportedChains()": "get_supported_chains()",
};

/** The one method this refusal needs. Component order is wire order. */
export const CHAIN_INFO_ABI = [
  {
    type: "function",
    name: "get_latest_attestation_height_and_hash",
    stateMutability: "view",
    inputs: [{ name: "chainKey", type: "uint64" }],
    outputs: [
      {
        name: "result",
        type: "tuple",
        components: [
          { name: "height", type: "uint64" },
          { name: "hash", type: "bytes32" },
          { name: "isAttestation", type: "bool" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
] as const;

export const CHAIN_INFO_INTERFACE = new Interface(CHAIN_INFO_ABI);

/** The attested frontier of one Source Chain. */
export interface AttestationFrontier {
  readonly height: bigint;
  readonly digest: string;
  /** False when the record is a checkpoint rather than an attestation. */
  readonly isAttestation: boolean;
  /** False when the chain has no attestation record at all. */
  readonly exists: boolean;
}

/** The precompile surface this Service depends on, narrow enough to fake. */
export interface AttestationReader {
  latestAttestation(chainKey: bigint): Promise<Result<AttestationFrontier>>;
}

/** A revert naming an unknown selector means the ABI has drifted, not that the node is down. */
function readError(error: unknown): TabError {
  const cause = causeOf(error);
  const unknownSelector = /unknown selector/i.test(cause.message);
  return {
    category: unknownSelector ? "CHAIN" : "UPSTREAM",
    code: unknownSelector ? "CHAININFO_SELECTOR_UNKNOWN" : "CHAININFO_READ_FAILED",
    message: unknownSelector
      ? "the ChainInfo Precompile does not expose `get_latest_attestation_height_and_hash`, so the pinned ABI no longer matches the chain"
      : "the ChainInfo Precompile did not answer `get_latest_attestation_height_and_hash`",
    retryable: !unknownSelector,
    cause,
  };
}

function decodeError(detail: string): TabError {
  return {
    category: "CHAIN",
    code: "CHAININFO_DECODE_FAILED",
    message: `\`get_latest_attestation_height_and_hash\` returned a shape this ABI cannot read: ${detail}`,
    retryable: false,
  };
}

/**
 * Reads the precompile through `ethers` at one pinned block tag.
 *
 * The block tag rides on the same object as the calldata, so a read at the wrong
 * tag is not expressible here.
 */
export function createPrecompileAttestationReader(
  provider: JsonRpcProvider,
  address: string,
  blockTag: string | number,
): AttestationReader {
  return {
    async latestAttestation(chainKey: bigint): Promise<Result<AttestationFrontier>> {
      let returnData: string;
      try {
        returnData = await provider.call({
          to: address,
          data: CHAIN_INFO_INTERFACE.encodeFunctionData("get_latest_attestation_height_and_hash", [
            chainKey,
          ]),
          blockTag,
        });
      } catch (error) {
        return err(readError(error));
      }

      let fields: readonly unknown[];
      try {
        const decoded = CHAIN_INFO_INTERFACE.decodeFunctionResult(
          "get_latest_attestation_height_and_hash",
          returnData,
        );
        fields = decoded[0] as readonly unknown[];
      } catch (error) {
        return err(decodeError(causeOf(error).message));
      }

      if (!Array.isArray(fields) || fields.length < 4) {
        return err(decodeError("the result is not a 4-field tuple"));
      }
      return ok({
        height: BigInt(fields[0] as bigint),
        digest: String(fields[1]),
        isAttestation: fields[2] === true,
        exists: fields[3] === true,
      });
    },
  };
}

/** What one attestation check concluded, whichever way it went. */
export interface AttestationVerdict {
  readonly chainKey: bigint;
  readonly requestedHeight: bigint;
  readonly attestedHeight: bigint;
  /** How many blocks the frontier is short of the request. Zero when attested. */
  readonly blocksBehind: bigint;
  readonly attested: boolean;
  /** False when the frontier is a checkpoint rather than an attestation. */
  readonly frontierIsAttestation: boolean;
}

/**
 * The structured refusal R22.5 prescribes, naming both heights.
 *
 * Category `UNAVAILABLE` rather than `NOT_FOUND` or `VALIDATION`, and the choice
 * carries the meaning: the request is well formed and the transaction exists, the
 * chain has simply not attested that far yet, so the right answer is 503 and a
 * retry rather than 400 and a correction. `retryable` is true for the same reason,
 * and `details` carries both figures as decimal strings so a caller reads them
 * without parsing prose.
 */
export function heightNotAttested(verdict: AttestationVerdict): TabError {
  return {
    category: "UNAVAILABLE",
    code: "HEIGHT_NOT_ATTESTED",
    message: `the requested Source Chain block height ${verdict.requestedHeight.toString(10)} on chainKey ${verdict.chainKey.toString(10)} is not yet attested: the current attested height is ${verdict.attestedHeight.toString(10)}, which is ${verdict.blocksBehind.toString(10)} blocks short, so no proof can be built and nothing has been metered`,
    retryable: true,
    details: {
      chainKey: verdict.chainKey.toString(10),
      requestedHeight: verdict.requestedHeight.toString(10),
      attestedHeight: verdict.attestedHeight.toString(10),
      blocksBehind: verdict.blocksBehind.toString(10),
      metered: false,
    },
  };
}

/** The refusal for a chain the precompile holds no attestation record for at all. */
export function chainNotAttesting(chainKey: bigint, requestedHeight: bigint): TabError {
  return {
    category: "UNAVAILABLE",
    code: "CHAIN_NOT_ATTESTING",
    message: `the ChainInfo Precompile holds no attestation record for chainKey ${chainKey.toString(10)}, so height ${requestedHeight.toString(10)} cannot be shown attested and nothing has been metered`,
    retryable: true,
    details: {
      chainKey: chainKey.toString(10),
      requestedHeight: requestedHeight.toString(10),
      metered: false,
    },
  };
}

/**
 * Decides whether one height may be served.
 *
 * A height **at** the frontier is attested; the comparison is `>` and not `>=`,
 * because the frontier is the highest height the chain has attested rather than the
 * first it has not. Getting that boundary wrong would refuse exactly the freshest
 * request that can be served, which is the one an Agent is most likely to make.
 */
export async function checkHeightAttested(
  reader: AttestationReader,
  chainKey: bigint,
  requestedHeight: bigint,
): Promise<Result<AttestationVerdict>> {
  const frontier = await reader.latestAttestation(chainKey);
  if (!frontier.ok) return frontier;

  if (!frontier.value.exists) {
    return err(chainNotAttesting(chainKey, requestedHeight));
  }

  const attested = frontier.value.height >= requestedHeight;
  const verdict: AttestationVerdict = {
    chainKey,
    requestedHeight,
    attestedHeight: frontier.value.height,
    blocksBehind: attested ? 0n : requestedHeight - frontier.value.height,
    attested,
    frontierIsAttestation: frontier.value.isAttestation,
  };
  if (!attested) return err(heightNotAttested(verdict));
  return ok(verdict);
}
