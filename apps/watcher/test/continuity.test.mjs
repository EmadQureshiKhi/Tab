/**
 * Per-member Continuity Proofs, cut from one batch response (R9.1, R9.6).
 *
 * The reconciliation this module performs is the whole reason a batch is
 * affordable: `getBatchProof` returns one proof for a span, the precompile reads
 * a proof's first root as the root of the height under proof, and so every member
 * needs its own. Getting the cut wrong does not fail loudly. It produces a
 * well-formed proof for the wrong height, which the chain refuses with
 * `Merkle root mismatch` after the gas is spent, which is exactly the outcome
 * task 1.4 measured and Requirement 9 was corrected for.
 *
 * The anchor is real material. `packages/contracts/test/live/results.json` holds
 * the Continuity Proof that verified against the live precompile for Ethereum
 * Mainnet height 25876970, and its single root is the Merkle root of that block.
 * A batch containing that height must reproduce that proof exactly, which is the
 * strongest available check short of another live submission.
 *
 * Run against the built output, so what is tested is what the pipeline imports.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  chainDigests,
  computeDigestOf,
  continuityProofFor,
  highestCoveredHeight,
} from "../dist/continuity.js";

const live = JSON.parse(
  readFileSync(new URL("../../../packages/contracts/test/live/results.json", import.meta.url), "utf8"),
);
const recorded = live.cases["forged-merkle-root"].submitted;

const word = (byte) => `0x${byte.repeat(32)}`;
const ROOT_A = word("a1");
const ROOT_B = word("b2");
const ROOT_C = word("c3");
const ROOT_D = word("d4");
const LOWER = word("11");

/** A four-height batch starting at 1000, covering 1000 to 1003. */
const batch = (overrides = {}) => ({
  fromHeader: 1000n,
  lowerEndpointDigest: LOWER,
  roots: [ROOT_A, ROOT_B, ROOT_C, ROOT_D],
  ...overrides,
});

test("the recorded live proof is reproduced exactly from a batch containing its height", () => {
  // The recorded proof covers one height and stops at it, which is what a
  // per-transaction request returns when the height is itself an endpoint.
  const height = BigInt(recorded.blockHeight);
  const cut = continuityProofFor(
    {
      fromHeader: height,
      lowerEndpointDigest: recorded.continuityProof.lowerEndpointDigest,
      roots: recorded.continuityProof.roots,
    },
    height,
    height,
  );
  assert.equal(cut.ok, true);
  assert.equal(cut.value.lowerEndpointDigest, recorded.continuityProof.lowerEndpointDigest);
  assert.deepEqual(cut.value.roots, recorded.continuityProof.roots);
  // And the first root is the block's own Merkle root, which is the fact the whole
  // one-proof-per-height rule rests on.
  //
  // Compared against the *genuine* root from the mutation record, not against
  // `submitted.merkleProof.root`: this recorded case is the forged-root negative
  // path, so the root it submitted is invented by design and only the sibling
  // path, the encoded transaction, and the Continuity Proof are real. That the
  // continuity root equals the genuine root and not the forged one is itself the
  // evidence that `roots[0]` carries the proved block's Merkle root.
  const genuineRoot = live.cases["forged-merkle-root"].mutation.genuine;
  assert.equal(cut.value.roots[0], genuineRoot);
  assert.notEqual(cut.value.roots[0], recorded.merkleProof.root);
});

test("the digest chain is the library's rule: keccak(height, root, previous digest)", () => {
  const chained = chainDigests(batch());
  assert.equal(chained.ok, true);
  assert.equal(chained.value.length, 4);
  assert.equal(chained.value[0].height, 1000n);
  assert.equal(chained.value[0].digest, computeDigestOf(1000n, ROOT_A, LOWER));
  // Each link feeds the next, which is what makes a chain a chain.
  assert.equal(
    chained.value[1].digest,
    computeDigestOf(1001n, ROOT_B, chained.value[0].digest),
  );
  assert.equal(
    chained.value[3].digest,
    computeDigestOf(1003n, ROOT_D, chained.value[2].digest),
  );
});

test("the height is part of the digest, so two blocks with one root differ", () => {
  // Without the height in the preimage a replayed root would produce a replayed
  // digest, and the chain would no longer pin a position.
  assert.notEqual(computeDigestOf(1000n, ROOT_A, LOWER), computeDigestOf(1001n, ROOT_A, LOWER));
});

test("a member's proof starts at its own root and ends at its endpoint", () => {
  // Height 1002 with its endpoint at 1003: two roots, and the lower endpoint
  // digest is the chain walked up to but not including 1002.
  const cut = continuityProofFor(batch(), 1002n, 1003n);
  assert.equal(cut.ok, true);
  assert.deepEqual(cut.value.roots, [ROOT_C, ROOT_D]);

  const chained = chainDigests(batch());
  assert.equal(cut.value.lowerEndpointDigest, chained.value[1].digest);
});

test("the first member's proof reuses the batch's own lower endpoint unchanged", () => {
  const cut = continuityProofFor(batch(), 1000n, 1001n);
  assert.equal(cut.ok, true);
  assert.equal(cut.value.lowerEndpointDigest, LOWER);
  assert.deepEqual(cut.value.roots, [ROOT_A, ROOT_B]);
});

test("a member sitting on its endpoint gets a one-root proof", () => {
  const cut = continuityProofFor(batch(), 1001n, 1001n);
  assert.equal(cut.ok, true);
  assert.deepEqual(cut.value.roots, [ROOT_B]);
});

test("every member's proof re-chains to the same digest the batch does", () => {
  // The property that makes cutting safe: a cut proof, chained from its own lower
  // endpoint, reproduces the digest of its last height. If the cut dropped or
  // duplicated a root this would diverge.
  const whole = chainDigests(batch()).value;
  for (const [index, height] of [1000n, 1001n, 1002n, 1003n].entries()) {
    const cut = continuityProofFor(batch(), height, 1003n);
    assert.equal(cut.ok, true);
    const rechained = chainDigests({
      fromHeader: height,
      lowerEndpointDigest: cut.value.lowerEndpointDigest,
      roots: cut.value.roots,
    });
    assert.equal(rechained.ok, true);
    assert.equal(
      rechained.value[rechained.value.length - 1].digest,
      whole[whole.length - 1].digest,
      `member ${index} re-chains to the batch's last digest`,
    );
  }
});

test("the covered span is reported from the root count", () => {
  assert.equal(highestCoveredHeight(batch()), 1003n);
  assert.equal(highestCoveredHeight(batch({ roots: [ROOT_A] })), 1000n);
});

test("a height outside the batch is refused rather than cut from the wrong offset", () => {
  const below = continuityProofFor(batch(), 999n, 1003n);
  assert.equal(below.ok, false);
  assert.equal(below.error.code, "CONTINUITY_HEIGHT_OUTSIDE_BATCH");

  const above = continuityProofFor(batch(), 1004n, 1004n);
  assert.equal(above.ok, false);
  assert.equal(above.error.code, "CONTINUITY_HEIGHT_OUTSIDE_BATCH");
});

test("an endpoint below the member is refused, because no chain runs backwards", () => {
  const cut = continuityProofFor(batch(), 1002n, 1001n);
  assert.equal(cut.ok, false);
  assert.equal(cut.error.code, "CONTINUITY_ENDPOINT_BELOW_HEIGHT");
});

test("an endpoint past the batch's last root is refused rather than truncated", () => {
  // Truncating here would produce a proof that stops short of an attestation
  // endpoint, which the precompile has no reason to accept. Refusing sends the
  // member back for its own proof instead.
  const cut = continuityProofFor(batch(), 1002n, 1010n);
  assert.equal(cut.ok, false);
  assert.equal(cut.error.code, "CONTINUITY_ENDPOINT_OUTSIDE_BATCH");
});

test("malformed material is named rather than folded into a plausible digest", () => {
  const noRoots = chainDigests(batch({ roots: [] }));
  assert.equal(noRoots.ok, false);
  assert.equal(noRoots.error.code, "CONTINUITY_ROOTS_EMPTY");

  const badDigest = chainDigests(batch({ lowerEndpointDigest: "0xabc" }));
  assert.equal(badDigest.ok, false);
  assert.equal(badDigest.error.code, "CONTINUITY_DIGEST_MALFORMED");

  const badRoot = chainDigests(batch({ roots: [ROOT_A, "0x00"] }));
  assert.equal(badRoot.ok, false);
  assert.equal(badRoot.error.code, "CONTINUITY_ROOT_MALFORMED");

  // The cut validates the same way, so neither entry point folds bad material.
  const cut = continuityProofFor(batch({ roots: [ROOT_A, "0x00"] }), 1000n, 1000n);
  assert.equal(cut.ok, false);
  assert.equal(cut.error.code, "CONTINUITY_ROOT_MALFORMED");
});
