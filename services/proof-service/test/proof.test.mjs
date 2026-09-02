/**
 * Proof material: decoding it, folding it, and refusing it.
 *
 * The fixture below is a two-level tree built with the domain tags the tree
 * actually uses - `leaf = keccak256(0x00 ‖ bytes)` and
 * `node = keccak256(0x01 ‖ left ‖ right)`. Folding without those tags reproduces a
 * root that matches nothing, which is the trap the Watcher measured against genuine
 * Mainnet material, so the untagged fold is asserted to differ rather than left
 * implicit.
 *
 * The laterality is the other load-bearing part: `isLeft` describes the *sibling*,
 * so a left sibling means our node is the right child and sets that level's index
 * bit. A source that omits it would fold as an all-right path and produce a
 * plausible wrong root.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { concat, keccak256 } from "ethers";

import {
  checkMaterial,
  createProofBuilderApiSource,
  deriveRoot,
  hashInner,
  hashLeaf,
  normaliseProofMaterial,
  MAX_SIBLING_PATH,
  PROOF_BUILDER_PATHS,
  PROOF_BUILDER_TIMEOUT_MS,
} from "../dist/proof.js";

const TX = "0x02f8b10182";
const LEAF = "0xceae4b8404c6773f3a80b387769a7b839919d852ab9339026af31ec8138d87bf";
const S0 = `0x${"11".repeat(32)}`;
const S1 = `0x${"22".repeat(32)}`;
const ROOT = "0x0514dac2cdb08d956a4c0a294ef3db963bca76edf4e6b9c310b267a77d7dca69";
const HASH = `0x${"e6".repeat(32)}`;

const BODY = {
  headerNumber: 25876970,
  txIndex: 1,
  txHash: HASH,
  txBytes: TX,
  merkleProof: { root: ROOT, siblings: [{ hash: S0, isLeft: true }, { hash: S1, isLeft: false }] },
  continuityProof: { lowerEndpointDigest: `0x${"33".repeat(32)}`, roots: [`0x${"44".repeat(32)}`] },
  cached: true,
};

const bytes = (hex) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));

test("the leaf and the inner node are domain-tagged, and dropping the tags changes the root", () => {
  assert.equal(hashLeaf(bytes(TX)), LEAF);

  // The untagged forms, computed the way design section 8.4's pseudocode reads.
  // They are different values, which is why following that text reproduces a root
  // matching nothing.
  const untaggedLeaf = keccak256(bytes(TX));
  assert.notEqual(untaggedLeaf, LEAF);

  const tagged = hashInner(bytes(S0), bytes(LEAF));
  const untaggedNode = keccak256(concat([bytes(S0), bytes(LEAF)]));
  assert.notEqual(untaggedNode, tagged);
});

test("the path folds to the stated root and reads the index out of the laterality", () => {
  const derived = deriveRoot(TX, BODY.merkleProof.siblings);
  assert.equal(derived.ok, true);
  assert.equal(derived.value.root, ROOT);
  assert.equal(derived.value.leaf, LEAF);
  assert.equal(derived.value.depth, 2);
  // sibling 0 on the left sets bit 0; sibling 1 on the right leaves bit 1 clear.
  assert.equal(derived.value.txIndex, 1n);
});

test("flipping one laterality changes both the root and the index", () => {
  const flipped = deriveRoot(TX, [{ hash: S0, isLeft: false }, { hash: S1, isLeft: false }]);
  assert.equal(flipped.ok, true);
  assert.notEqual(flipped.value.root, ROOT);
  assert.equal(flipped.value.txIndex, 0n);
});

test("a non-hex payload is refused rather than hashed as an empty leaf", () => {
  const derived = deriveRoot("0xnothex", []);
  assert.equal(derived.ok, false);
  assert.equal(derived.error.code, "DERIVE_ENCODED_TRANSACTION_MALFORMED");
});

test("an odd-length payload is refused", () => {
  const derived = deriveRoot("0x123", []);
  assert.equal(derived.ok, false);
  assert.equal(derived.error.code, "DERIVE_ENCODED_TRANSACTION_MALFORMED");
});

test("a path deeper than a uint64 index can address is refused", () => {
  const siblings = Array.from({ length: MAX_SIBLING_PATH + 1 }, () => ({ hash: S0, isLeft: false }));
  const derived = deriveRoot(TX, siblings);
  assert.equal(derived.ok, false);
  assert.equal(derived.error.code, "DERIVE_PATH_TOO_DEEP");
});

test("a sibling that is not a 32-byte word is refused", () => {
  const derived = deriveRoot(TX, [{ hash: "0x1234", isLeft: false }]);
  assert.equal(derived.ok, false);
  assert.equal(derived.error.code, "DERIVE_SIBLING_MALFORMED");
});

test("a sibling with no boolean laterality is refused rather than assumed right", () => {
  const derived = deriveRoot(TX, [{ hash: S0, isLeft: "yes" }]);
  assert.equal(derived.ok, false);
  assert.equal(derived.error.code, "DERIVE_LATERALITY_MISSING");
});

test("well formed material normalises with every field carried through", () => {
  const material = normaliseProofMaterial(3n, HASH, BODY);
  assert.equal(material.ok, true);
  assert.equal(material.value.blockHeight, 25_876_970n);
  assert.equal(material.value.txIndexFromSource, 1n);
  assert.equal(material.value.cached, true);
  assert.equal(material.value.merkleProof.siblings.length, 2);
  assert.equal(material.value.continuityProof.roots.length, 1);
});

test("decimal-string and number forms of an integer both decode", () => {
  const material = normaliseProofMaterial(3n, HASH, { ...BODY, headerNumber: "25876970", txIndex: "1" });
  assert.equal(material.value.blockHeight, 25_876_970n);
  assert.equal(material.value.txIndexFromSource, 1n);
});

test("every malformed shape is named rather than defaulted", () => {
  const cases = [
    ["not an object", "a string"],
    ["headerNumber", { ...BODY, headerNumber: "x" }],
    ["txIndex", { ...BODY, txIndex: 1.5 }],
    ["txBytes", { ...BODY, txBytes: "nothex" }],
    ["merkleProof.root", { ...BODY, merkleProof: { siblings: [] } }],
    ["merkleProof.siblings", { ...BODY, merkleProof: { root: ROOT, siblings: "none" } }],
    ["a sibling pair", { ...BODY, merkleProof: { root: ROOT, siblings: [{ hash: S0 }] } }],
    ["lowerEndpointDigest", { ...BODY, continuityProof: { roots: [S0] } }],
    ["empty roots", { ...BODY, continuityProof: { lowerEndpointDigest: S0, roots: [] } }],
    ["a non-hex root", { ...BODY, continuityProof: { lowerEndpointDigest: S0, roots: ["nope"] } }],
  ];
  for (const [name, body] of cases) {
    const material = normaliseProofMaterial(3n, HASH, body);
    assert.equal(material.ok, false, `${name} should be refused`);
    assert.equal(material.error.code, "PROOF_MATERIAL_MALFORMED");
    assert.equal(material.error.category, "PROOF");
  }
});

test("material for a different transaction than the one asked for is refused", () => {
  const material = normaliseProofMaterial(3n, HASH, { ...BODY, txHash: `0x${"aa".repeat(32)}` });
  assert.equal(material.ok, false);
  assert.match(material.error.message, /not the requested/);
});

test("material whose root this service reproduces is sellable", () => {
  const material = normaliseProofMaterial(3n, HASH, BODY);
  const check = checkMaterial(material.value);
  assert.equal(check.ok, true);
  assert.equal(check.value.derivedRoot, ROOT);
  assert.equal(check.value.derivedTxIndex, "1");
  assert.equal(check.value.txIndexAgrees, true);
  assert.equal(check.value.depth, 2);
});

test("a forged root is refused before an Agent is charged for it", () => {
  const material = normaliseProofMaterial(3n, HASH, {
    ...BODY,
    merkleProof: { ...BODY.merkleProof, root: `0x${"ff".repeat(32)}` },
  });
  const check = checkMaterial(material.value);
  assert.equal(check.ok, false);
  assert.equal(check.error.code, "MERKLE_ROOT_MISMATCH");
  assert.equal(check.error.details.derivedRoot, ROOT);
  assert.match(check.error.message, /is not sold/);
});

test("a stated index that disagrees with the path is reported, not refused", () => {
  const material = normaliseProofMaterial(3n, HASH, { ...BODY, txIndex: 7 });
  const check = checkMaterial(material.value);
  assert.equal(check.ok, true);
  assert.equal(check.value.txIndexAgrees, false);
  assert.equal(check.value.derivedTxIndex, "1");
});

test("the API source asks the documented path and normalises the answer", async () => {
  const seen = [];
  const source = createProofBuilderApiSource({
    baseUrl: "https://prover.example/",
    fetchImpl: async (url) => {
      seen.push(url);
      return new Response(JSON.stringify(BODY), { status: 200 });
    },
  });
  const material = await source.fetchProof(3n, HASH);
  assert.equal(material.ok, true);
  assert.equal(seen[0], `https://prover.example${PROOF_BUILDER_PATHS.proofByTx}/3/${HASH}`);
});

test("a 404 is not found and is not retryable", async () => {
  const source = createProofBuilderApiSource({
    baseUrl: "https://prover.example",
    fetchImpl: async () => new Response("", { status: 404 }),
  });
  const material = await source.fetchProof(3n, HASH);
  assert.equal(material.ok, false);
  assert.equal(material.error.code, "PROOF_MATERIAL_NOT_FOUND");
  assert.equal(material.error.category, "NOT_FOUND");
  assert.equal(material.error.retryable, false);
});

test("a 503 is upstream and is retryable", async () => {
  const source = createProofBuilderApiSource({
    baseUrl: "https://prover.example",
    fetchImpl: async () => new Response("", { status: 503 }),
  });
  const material = await source.fetchProof(3n, HASH);
  assert.equal(material.ok, false);
  assert.equal(material.error.code, "PROOF_BUILDER_REFUSED");
  assert.equal(material.error.retryable, true);
});

test("a body that is not JSON is named as such", async () => {
  const source = createProofBuilderApiSource({
    baseUrl: "https://prover.example",
    fetchImpl: async () => new Response("<html>", { status: 200 }),
  });
  const material = await source.fetchProof(3n, HASH);
  assert.equal(material.ok, false);
  assert.equal(material.error.code, "PROOF_BUILDER_UNPARSEABLE");
});

test("a timeout is distinguished from an unreachable endpoint", async () => {
  const timeout = createProofBuilderApiSource({
    baseUrl: "https://prover.example",
    fetchImpl: async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    },
  });
  const timedOut = await timeout.fetchProof(3n, HASH);
  assert.equal(timedOut.error.code, "PROOF_BUILDER_TIMEOUT");
  assert.match(timedOut.error.message, new RegExp(String(PROOF_BUILDER_TIMEOUT_MS)));

  const down = createProofBuilderApiSource({
    baseUrl: "https://prover.example",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const unreachable = await down.fetchProof(3n, HASH);
  assert.equal(unreachable.error.code, "PROOF_BUILDER_UNREACHABLE");
});

test("the builder's own attested height is read as corroboration", async () => {
  const source = createProofBuilderApiSource({
    baseUrl: "https://prover.example",
    fetchImpl: async () => new Response(JSON.stringify({ attestedHeight: "25877000" }), { status: 200 }),
  });
  const height = await source.latestAttestedHeight(3n);
  assert.equal(height.ok, true);
  assert.equal(height.value, 25_877_000n);
});

test("an attested-height body with no figure reads as unknown rather than zero", async () => {
  const source = createProofBuilderApiSource({
    baseUrl: "https://prover.example",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  const height = await source.latestAttestedHeight(3n);
  assert.equal(height.ok, true);
  assert.equal(height.value, undefined);
});
