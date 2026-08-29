/**
 * Continuity Proofs derived locally from one batch response.
 *
 * ## Why this module exists
 *
 * R9.6 asks the Watcher to obtain the Continuity Proof for every member of a
 * batch in one `getBatchProof` round trip, and R9.1 requires that every member
 * carry its own proof, because the precompile reads a Continuity Proof's first
 * root as the root of the height under proof, so one proof shared across a batch
 * verifies only the lowest height. The batch endpoint returns exactly one proof
 * for the whole span. Those two facts are reconciled here, without a second round
 * trip, because the attested digest is a deterministic chain and the batch
 * response carries every root the chain needs.
 *
 * ## The digest is a chain, measured rather than assumed
 *
 * The attested digest of a height is
 *
 * ```text
 * digest(h) = keccak256(abi.encodePacked(uint64(h), merkleRoot(h), digest(h - 1)))
 * ```
 *
 * which is the pinned client library's `computeDigestOf`, and it was reproduced
 * byte for byte against the live network on 2026-09-06: chaining a Proof Builder
 * proof's `lowerEndpointDigest` through its roots from Sepolia height 11644696
 * produced `0x29d00b37...4ac8` at 11644700, exactly the digest
 * `get_attestation_bounds` reports for that endpoint. So a batch response whose
 * chain starts at `digest(fromHeader - 1)` lets the Watcher compute `digest(h - 1)`
 * for any member height `h` in the span, and a member's own proof is that digest
 * plus the roots from `h` up to the attestation endpoint at or above `h`.
 *
 * ## The cut is at the endpoint above the member, not at the end of the batch
 *
 * The per-transaction proof the service builds for a height runs from that height
 * to the first attestation endpoint at or above it and stops there. This module
 * cuts at the same place, so a member's derived proof is identical to what a
 * per-transaction request would have returned, and the two are compared live in
 * `test/continuity.test.mjs`. Running the roots past an attested endpoint is not
 * known to be accepted by the precompile and is not attempted.
 *
 * Requirements: 9.1, 9.6, 16.6
 */

import { keccak256, solidityPacked } from "ethers";

import { err, ok, type Result, type TabError } from "@tabai/shared";

import type { ContinuityProof } from "./proof.js";

const WORD = /^0x[0-9a-fA-F]{64}$/;

/** The attested digest of a height, from its root and the previous digest. */
export function computeDigestOf(height: bigint, merkleRoot: string, prevDigest: string): string {
  return keccak256(solidityPacked(["uint64", "bytes32", "bytes32"], [height, merkleRoot, prevDigest]));
}

/** A batch response's continuity material, as the Proof Builder returns it. */
export interface BatchContinuity {
  /** Lowest height the roots cover; `roots[0]` is its root. */
  readonly fromHeader: bigint;
  readonly lowerEndpointDigest: string;
  /** One root per height from `fromHeader` upward, contiguous. */
  readonly roots: readonly string[];
}

/** One height's digest, as chained from the batch's lower endpoint. */
export interface ChainedDigest {
  readonly height: bigint;
  readonly digest: string;
}

function continuityError(code: string, message: string): TabError {
  return { category: "PROOF", code, message, retryable: false };
}

function validate(batch: BatchContinuity): TabError | undefined {
  if (!WORD.test(batch.lowerEndpointDigest)) {
    return continuityError("CONTINUITY_DIGEST_MALFORMED", "the batch's lowerEndpointDigest is not a 32-byte word");
  }
  if (batch.roots.length === 0) {
    return continuityError("CONTINUITY_ROOTS_EMPTY", "the batch carries no roots, so no height can be chained");
  }
  for (const [position, root] of batch.roots.entries()) {
    if (!WORD.test(root)) {
      return continuityError("CONTINUITY_ROOT_MALFORMED", `roots[${position}] is not a 32-byte word`);
    }
  }
  return undefined;
}

/**
 * The digest of every height the batch covers, in order.
 *
 * The last entry is the digest of the batch's upper endpoint, which is what the
 * precompile reports for that height through `get_attestation_bounds`; comparing
 * the two is the check that the chain was reproduced correctly.
 */
export function chainDigests(batch: BatchContinuity): Result<readonly ChainedDigest[]> {
  const problem = validate(batch);
  if (problem !== undefined) return err(problem);

  const chained: ChainedDigest[] = [];
  let previous = batch.lowerEndpointDigest;
  for (const [offset, root] of batch.roots.entries()) {
    const height = batch.fromHeader + BigInt(offset);
    const digest = computeDigestOf(height, root, previous);
    chained.push({ height, digest });
    previous = digest;
  }
  return ok(chained);
}

/** The last height the batch's roots cover. */
export const highestCoveredHeight = (batch: BatchContinuity): bigint =>
  batch.fromHeader + BigInt(batch.roots.length) - 1n;

/**
 * The Continuity Proof of one member height, cut from the batch.
 *
 * @param batch the batch response's continuity material
 * @param height the member's Source Chain height
 * @param endpointAbove the attestation endpoint at or above `height`, from
 * `get_attestation_bounds(chainKey, height).childHeight`
 */
export function continuityProofFor(
  batch: BatchContinuity,
  height: bigint,
  endpointAbove: bigint,
): Result<ContinuityProof> {
  const problem = validate(batch);
  if (problem !== undefined) return err(problem);

  const highest = highestCoveredHeight(batch);
  if (height < batch.fromHeader || height > highest) {
    return err(
      continuityError(
        "CONTINUITY_HEIGHT_OUTSIDE_BATCH",
        `height ${height} is outside the batch's covered span ${batch.fromHeader} to ${highest}`,
      ),
    );
  }
  if (endpointAbove < height) {
    return err(
      continuityError(
        "CONTINUITY_ENDPOINT_BELOW_HEIGHT",
        `the attestation endpoint ${endpointAbove} is below height ${height}, which no proof can bridge`,
      ),
    );
  }
  if (endpointAbove > highest) {
    return err(
      continuityError(
        "CONTINUITY_ENDPOINT_OUTSIDE_BATCH",
        `the attestation endpoint ${endpointAbove} for height ${height} lies past the batch's last root at ${highest}, so the batch cannot bridge this member`,
      ),
    );
  }

  const start = Number(height - batch.fromHeader);
  const end = Number(endpointAbove - batch.fromHeader);

  let lowerEndpointDigest = batch.lowerEndpointDigest;
  for (let offset = 0; offset < start; offset += 1) {
    const root = batch.roots[offset];
    if (root === undefined) break;
    lowerEndpointDigest = computeDigestOf(batch.fromHeader + BigInt(offset), root, lowerEndpointDigest);
  }

  return ok({ lowerEndpointDigest, roots: batch.roots.slice(start, end + 1) });
}
