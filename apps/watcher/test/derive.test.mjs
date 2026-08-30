/**
 * Local Merkle re-derivation.
 *
 * The anchor case is the real thing: the genuine Ethereum Mainnet proof material
 * the live suite recorded in `packages/contracts/test/live/results.json`. Asserting
 * against generated trees alone would only prove this file agrees with itself, and
 * the whole value of the derivation is that it agrees with the chain.
 *
 * Run against the built output, so what is tested is what the pipeline imports.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { keccak256 } from "@tabai/shared";

import { MAX_SIBLING_PATH, checkDerivedRoot, deriveRoot, hashLeaf } from "../dist/derive.js";

const live = JSON.parse(
  readFileSync(new URL("../../../packages/contracts/test/live/results.json", import.meta.url), "utf8"),
);

/**
 * The `forged-merkle-root` case carries a genuine `encodedTransaction`, a genuine
 * sibling path, and a genuine Continuity Proof; only the root was replaced. So the
 * genuine root is the mutation's `genuine` field, and every other field is real.
 */
const recorded = live.cases["forged-merkle-root"];
const GENUINE_ROOT = recorded.mutation.genuine;
const ENCODED = recorded.submitted.encodedTransaction;
const SIBLINGS = recorded.submitted.merkleProof.siblings;
const SOURCE_TX = recorded.target.sourceTxHash;
const TX_INDEX = BigInt(recorded.proofMaterial.txIndexFromProofBuilder);

const bytes32 = (byte) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const toBytes = (hex) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));

test("the genuine Mainnet material re-derives its recorded root and index", () => {
  const derived = deriveRoot(ENCODED, SIBLINGS);
  assert.equal(derived.ok, true);
  assert.equal(derived.value.root, GENUINE_ROOT);
  assert.equal(derived.value.txIndex, TX_INDEX);
  assert.equal(derived.value.depth, SIBLINGS.length);
});

test("the untagged fold design section 8.4 printed does not reach the real root", () => {
  // This is the assertion that stops anybody "simplifying" back to the design's
  // pseudocode. The untagged derivation is self-consistent and wrong, which is the
  // dangerous kind of wrong: it would have withheld every Settlement forever.
  let plain = keccak256(toBytes(ENCODED));
  for (const sibling of SIBLINGS) {
    const joined = new Uint8Array(64);
    joined.set(toBytes(sibling.isLeft ? sibling.hash : plain), 0);
    joined.set(toBytes(sibling.isLeft ? plain : sibling.hash), 32);
    plain = keccak256(joined);
  }
  assert.notEqual(plain, GENUINE_ROOT);
  assert.equal(plain, "0x9ee830892e5f5a5d889a0b91477ad934ea804594063eb54932bf04a4fdd40bbb");
});

test("a left sibling sets the index bit at its own level", () => {
  const one = bytes32(0xaa);
  // Bit 0 only.
  const lowest = deriveRoot("0x", [{ hash: one, isLeft: true }, { hash: one, isLeft: false }]);
  assert.equal(lowest.ok, true);
  assert.equal(lowest.value.txIndex, 1n);

  // Bit 1 only.
  const next = deriveRoot("0x", [{ hash: one, isLeft: false }, { hash: one, isLeft: true }]);
  assert.equal(next.ok, true);
  assert.equal(next.value.txIndex, 2n);

  // The recorded path is three left siblings then six right ones, which is 7.
  assert.equal(TX_INDEX, 7n);
});

test("an empty path derives the tagged leaf itself, at index zero", () => {
  const derived = deriveRoot(ENCODED, []);
  assert.equal(derived.ok, true);
  assert.equal(derived.value.root, hashLeaf(toBytes(ENCODED)));
  assert.equal(derived.value.txIndex, 0n);
  assert.equal(derived.value.depth, 0);
});

test("tampering with the payload changes the root", () => {
  // The live suite proved the same thing on chain by flipping byte 912. One byte
  // anywhere is enough, so the first one does.
  const derived = deriveRoot(`0xff${ENCODED.slice(4)}`, SIBLINGS);
  assert.equal(derived.ok, true);
  assert.notEqual(derived.value.root, GENUINE_ROOT);
});

test("flipping one laterality bit changes both answers", () => {
  const flipped = SIBLINGS.map((sibling, index) =>
    index === 0 ? { ...sibling, isLeft: !sibling.isLeft } : sibling,
  );
  const derived = deriveRoot(ENCODED, flipped);
  assert.equal(derived.ok, true);
  assert.notEqual(derived.value.root, GENUINE_ROOT);
  assert.notEqual(derived.value.txIndex, TX_INDEX);
});

test("malformed material fails with a reason rather than a wrong root", () => {
  assert.equal(deriveRoot("not hex", []).ok, false);
  assert.equal(deriveRoot("0xabc", []).ok, false, "odd-length hex is not bytes");
  assert.equal(deriveRoot("0x", [{ hash: "0x1234", isLeft: true }]).ok, false);
  assert.equal(deriveRoot("0x", [{ hash: bytes32(1), isLeft: "yes" }]).ok, false);

  const tooDeep = Array.from({ length: MAX_SIBLING_PATH + 1 }, () => ({ hash: bytes32(2), isLeft: false }));
  const refused = deriveRoot("0x", tooDeep);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "DERIVE_PATH_TOO_DEEP");
});

test("checkDerivedRoot passes the genuine material and names the transaction", () => {
  const check = checkDerivedRoot({
    sourceTxHash: SOURCE_TX,
    encodedTransaction: ENCODED,
    merkleProof: { root: GENUINE_ROOT, siblings: SIBLINGS },
    txIndexFromPrecompile: TX_INDEX,
  });
  assert.equal(check.outcome, "MATCH");
  assert.ok(check.detail.includes(SOURCE_TX));
});

test("the forged root the live suite submitted is refused, and logged with the hash", () => {
  const check = checkDerivedRoot({
    sourceTxHash: SOURCE_TX,
    encodedTransaction: ENCODED,
    // This is the root that was actually broadcast and reverted on chain.
    merkleProof: { root: recorded.mutation.submitted, siblings: SIBLINGS },
  });
  assert.equal(check.outcome, "ROOT_MISMATCH");
  assert.equal(check.derived.root, GENUINE_ROOT);
  // R20.5: the log must carry the Source Chain transaction hash.
  assert.ok(check.detail.includes(SOURCE_TX));
});

test("a matching root with a disagreeing index still withholds", () => {
  const check = checkDerivedRoot({
    sourceTxHash: SOURCE_TX,
    encodedTransaction: ENCODED,
    merkleProof: { root: GENUINE_ROOT, siblings: SIBLINGS },
    txIndexFromPrecompile: TX_INDEX + 1n,
  });
  assert.equal(check.outcome, "TX_INDEX_MISMATCH");
  assert.ok(check.detail.includes(SOURCE_TX));
});

test("material that cannot be folded is UNDERIVABLE rather than a mismatch", () => {
  const check = checkDerivedRoot({
    sourceTxHash: SOURCE_TX,
    encodedTransaction: "0xabc",
    merkleProof: { root: GENUINE_ROOT, siblings: SIBLINGS },
  });
  assert.equal(check.outcome, "UNDERIVABLE");
  assert.equal(check.derived, undefined);
});

test("root comparison ignores hex casing and nothing else", () => {
  const upper = checkDerivedRoot({
    sourceTxHash: SOURCE_TX,
    encodedTransaction: ENCODED,
    merkleProof: { root: `0x${GENUINE_ROOT.slice(2).toUpperCase()}`, siblings: SIBLINGS },
  });
  assert.equal(upper.outcome, "MATCH");

  const truncated = checkDerivedRoot({
    sourceTxHash: SOURCE_TX,
    encodedTransaction: ENCODED,
    merkleProof: { root: GENUINE_ROOT.slice(0, 64), siblings: SIBLINGS },
  });
  assert.equal(truncated.outcome, "ROOT_MISMATCH");
});
