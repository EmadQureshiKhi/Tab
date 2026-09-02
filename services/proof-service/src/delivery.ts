/**
 * What this Service actually sells: one `verifyAndEmit` call's worth of material.
 *
 * The endpoint takes a Source Chain transaction reference and returns the three
 * things a `SettlementVerifier.verifyAndEmit` call cannot be made without - the
 * Merkle Proof, the Continuity Proof, and the encoded transaction (R22.1). This
 * module is the delivery itself, with no HTTP and no metering in it, so the
 * ordering rule in `server.ts` has something to order and a test can exercise every
 * refusal without a socket.
 *
 * ## The attestation gate runs first when it can, and always before a charge
 *
 * R22.5 is a rule about money as much as about proofs: an unattested height must
 * come back naming both heights and must record **zero** Metered Delivery. Two
 * orderings satisfy that and they differ in cost.
 *
 * When the caller states the block height, the gate runs against the ChainInfo
 * Precompile before the Proof Builder is called at all. The refusal is then exact
 * and free, and the builder is never asked for material that cannot exist yet.
 *
 * When the caller states only a transaction hash, the height is not known until the
 * builder answers, so the material is fetched first and the gate runs on the height
 * it reports. Nothing is charged either way, because metering happens above this
 * module and only for a delivered response.
 *
 * ## Material is folded locally before it is sold
 *
 * `checkMaterial` reproduces the stated Merkle root from the encoded transaction
 * and the sibling path. A mismatch is refused here rather than discovered on chain
 * by an Agent who has already paid for it.
 *
 * Requirements: 22.1, 22.3, 22.5
 */

import { err, ok, type Result, type TabError } from "@tabai/shared";

import { checkHeightAttested, type AttestationReader, type AttestationVerdict } from "./attestation.js";
import { checkMaterial, type MaterialCheck, type ProofMaterial, type ProofSource } from "./proof.js";

/** The Source Chain transaction reference an Agent asks with. */
export interface ProofRequest {
  /** The Attestcoin chainKey of the Source Chain. 1 is Sepolia, 3 is Mainnet. */
  readonly chainKey: bigint;
  readonly sourceTxHash: string;
  /**
   * The block the transaction sits in, when the caller knows it.
   *
   * Optional, and stating it is strictly better: the attestation gate then runs
   * before the Proof Builder is called, so an unattested height is refused without
   * a network round trip. When it is stated and disagrees with what the builder
   * reports, the request is refused rather than silently served, because the two
   * naming different blocks means one of them is about a different transaction.
   */
  readonly blockHeight?: bigint | undefined;
}

/** The material, with the evidence that this service checked it. */
export interface ProofDelivery {
  readonly chainKey: string;
  readonly sourceTxHash: string;
  readonly blockHeight: string;
  /** The index the Merkle path encodes, which is what the precompile recomputes. */
  readonly txIndex: string;
  /** The index the Proof Builder stated, carried so a disagreement stays visible. */
  readonly txIndexFromSource: string;
  readonly encodedTransaction: string;
  readonly merkleProof: {
    readonly root: string;
    readonly siblings: readonly { readonly hash: string; readonly isLeft: boolean }[];
  };
  readonly continuityProof: {
    readonly lowerEndpointDigest: string;
    readonly roots: readonly string[];
  };
  /** The attested frontier this material was checked against. */
  readonly attestation: {
    readonly attestedHeight: string;
    readonly frontierIsAttestation: boolean;
  };
  readonly check: MaterialCheck;
  /** Whether the Proof Builder served this from its cache. */
  readonly cached: boolean;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** Rejects a reference that is not a 32-byte transaction hash on a known chainKey. */
export function validateProofRequest(request: ProofRequest): Result<ProofRequest> {
  if (request.chainKey !== 1n && request.chainKey !== 3n) {
    return err({
      category: "VALIDATION",
      code: "CHAIN_KEY_UNSUPPORTED",
      message: `chainKey ${request.chainKey.toString(10)} is not a Source Chain this rail settles on; 1 is Ethereum Sepolia and 3 is Ethereum Mainnet`,
      retryable: false,
      details: { chainKey: request.chainKey.toString(10) },
    });
  }
  if (!HEX32.test(request.sourceTxHash)) {
    return err({
      category: "VALIDATION",
      code: "SOURCE_TX_HASH_MALFORMED",
      message: "the Source Chain transaction reference must be a 0x-prefixed 32-byte hash",
      retryable: false,
    });
  }
  if (request.blockHeight !== undefined && request.blockHeight < 0n) {
    return err({
      category: "VALIDATION",
      code: "BLOCK_HEIGHT_NEGATIVE",
      message: "a block height cannot be negative",
      retryable: false,
    });
  }
  return ok({ ...request, sourceTxHash: request.sourceTxHash.toLowerCase() });
}

function heightDisagrees(stated: bigint, reported: bigint, sourceTxHash: string): TabError {
  return {
    category: "VALIDATION",
    code: "BLOCK_HEIGHT_DISAGREES",
    message: `the request names block height ${stated.toString(10)} for source transaction ${sourceTxHash} and the Proof Builder reports ${reported.toString(10)}, so one of the two is about a different transaction and no material is sold`,
    retryable: false,
    details: {
      sourceTxHash,
      requestedHeight: stated.toString(10),
      reportedHeight: reported.toString(10),
    },
  };
}

export interface ProofDelivererOptions {
  readonly source: ProofSource;
  readonly attestation: AttestationReader;
}

/** The delivery, as `server.ts` mounts it under the metering plugin. */
export interface ProofDeliverer {
  deliver(request: ProofRequest): Promise<Result<ProofDelivery>>;
}

const shaped = (
  material: ProofMaterial,
  verdict: AttestationVerdict,
  check: MaterialCheck,
): ProofDelivery => ({
  chainKey: material.chainKey.toString(10),
  sourceTxHash: material.sourceTxHash,
  blockHeight: material.blockHeight.toString(10),
  txIndex: check.derivedTxIndex,
  txIndexFromSource: material.txIndexFromSource.toString(10),
  encodedTransaction: material.encodedTransaction,
  merkleProof: {
    root: material.merkleProof.root,
    siblings: material.merkleProof.siblings.map((entry) => ({
      hash: entry.hash,
      isLeft: entry.isLeft,
    })),
  },
  continuityProof: {
    lowerEndpointDigest: material.continuityProof.lowerEndpointDigest,
    roots: [...material.continuityProof.roots],
  },
  attestation: {
    attestedHeight: verdict.attestedHeight.toString(10),
    frontierIsAttestation: verdict.frontierIsAttestation,
  },
  check,
  cached: material.cached,
});

/**
 * Builds the deliverer.
 *
 * Construction is total and cannot fail. Everything fallible belongs to the call
 * that delivers, because that is the only place a caller can do anything about it.
 */
export function createProofDeliverer(options: ProofDelivererOptions): ProofDeliverer {
  return {
    async deliver(request: ProofRequest): Promise<Result<ProofDelivery>> {
      const validated = validateProofRequest(request);
      if (!validated.ok) return validated;
      const { chainKey, sourceTxHash, blockHeight } = validated.value;

      // The cheap path: a stated height is gated before the builder is called, so
      // an unattested height costs one `eth_call` and no network round trip.
      let verdict: AttestationVerdict | undefined;
      if (blockHeight !== undefined) {
        const gated = await checkHeightAttested(options.attestation, chainKey, blockHeight);
        if (!gated.ok) return gated;
        verdict = gated.value;
      }

      const material = await options.source.fetchProof(chainKey, sourceTxHash);
      if (!material.ok) return material;

      if (blockHeight !== undefined && material.value.blockHeight !== blockHeight) {
        return err(heightDisagrees(blockHeight, material.value.blockHeight, sourceTxHash));
      }

      // Re-gated on the reported height whenever the caller stated none, which is
      // the only case where the height was unknown until now.
      if (verdict === undefined) {
        const gated = await checkHeightAttested(
          options.attestation,
          chainKey,
          material.value.blockHeight,
        );
        if (!gated.ok) return gated;
        verdict = gated.value;
      }

      const check = checkMaterial(material.value);
      if (!check.ok) return check;

      return ok(shaped(material.value, verdict, check.value));
    },
  };
}
