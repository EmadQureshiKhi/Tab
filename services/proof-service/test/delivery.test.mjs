/**
 * The delivery, which is the thing being sold and the thing being ordered.
 *
 * The ordering claim worth a test rather than a comment is that a stated block
 * height gates **before** the Proof Builder is called: the fetch counter below is
 * asserted to be zero on the unattested path, so an Agent asking for a height the
 * chain has not reached costs one `eth_call` rather than a network round trip, and
 * nothing downstream ever sees material it must not sell.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createProofDeliverer, validateProofRequest } from "../dist/delivery.js";

const TX = "0x02f8b10182";
const S0 = `0x${"11".repeat(32)}`;
const S1 = `0x${"22".repeat(32)}`;
const ROOT = "0x0514dac2cdb08d956a4c0a294ef3db963bca76edf4e6b9c310b267a77d7dca69";
const HASH = `0x${"e6".repeat(32)}`;

const material = (overrides = {}) => ({
  chainKey: 3n,
  blockHeight: 25_876_970n,
  txIndexFromSource: 1n,
  sourceTxHash: HASH,
  encodedTransaction: TX,
  merkleProof: { root: ROOT, siblings: [{ hash: S0, isLeft: true }, { hash: S1, isLeft: false }] },
  continuityProof: { lowerEndpointDigest: `0x${"33".repeat(32)}`, roots: [`0x${"44".repeat(32)}`] },
  cached: false,
  ...overrides,
});

const sourceThat = (result) => {
  const calls = { fetches: 0 };
  return {
    calls,
    source: {
      describe: "a test double",
      fetchProof: async () => {
        calls.fetches += 1;
        return result;
      },
      latestAttestedHeight: async () => ({ ok: true, value: undefined }),
    },
  };
};

const attestedAt = (height) => ({
  latestAttestation: async () => ({
    ok: true,
    value: { height, digest: `0x${"ab".repeat(32)}`, isAttestation: true, exists: true },
  }),
});

test("a chainKey this rail does not settle on is refused", () => {
  const validated = validateProofRequest({ chainKey: 9n, sourceTxHash: HASH });
  assert.equal(validated.ok, false);
  assert.equal(validated.error.code, "CHAIN_KEY_UNSUPPORTED");
});

test("a reference that is not a 32-byte hash is refused", () => {
  const validated = validateProofRequest({ chainKey: 3n, sourceTxHash: "0x1234" });
  assert.equal(validated.ok, false);
  assert.equal(validated.error.code, "SOURCE_TX_HASH_MALFORMED");
});

test("a negative height is refused", () => {
  const validated = validateProofRequest({ chainKey: 3n, sourceTxHash: HASH, blockHeight: -1n });
  assert.equal(validated.ok, false);
  assert.equal(validated.error.code, "BLOCK_HEIGHT_NEGATIVE");
});

test("a reference is lowercased so the digest and the fetch agree on one spelling", () => {
  const validated = validateProofRequest({ chainKey: 3n, sourceTxHash: HASH.toUpperCase().replace("0X", "0x") });
  assert.equal(validated.value.sourceTxHash, HASH);
});

test("a stated unattested height refuses before the Proof Builder is called at all", async () => {
  const { calls, source } = sourceThat({ ok: true, value: material() });
  const deliverer = createProofDeliverer({ source, attestation: attestedAt(25_876_900n) });
  const delivered = await deliverer.deliver({ chainKey: 3n, sourceTxHash: HASH, blockHeight: 25_876_970n });
  assert.equal(delivered.ok, false);
  assert.equal(delivered.error.code, "HEIGHT_NOT_ATTESTED");
  assert.equal(delivered.error.details.attestedHeight, "25876900");
  assert.equal(calls.fetches, 0, "the builder must not be asked for material that cannot exist yet");
});

test("with no stated height the builder's own height is what the gate reads", async () => {
  const { calls, source } = sourceThat({ ok: true, value: material() });
  const deliverer = createProofDeliverer({ source, attestation: attestedAt(25_876_900n) });
  const delivered = await deliverer.deliver({ chainKey: 3n, sourceTxHash: HASH });
  assert.equal(delivered.ok, false);
  assert.equal(delivered.error.code, "HEIGHT_NOT_ATTESTED");
  assert.equal(delivered.error.details.requestedHeight, "25876970");
  assert.equal(calls.fetches, 1);
});

test("a stated height that disagrees with the builder is refused rather than served", async () => {
  const { source } = sourceThat({ ok: true, value: material() });
  const deliverer = createProofDeliverer({ source, attestation: attestedAt(30_000_000n) });
  const delivered = await deliverer.deliver({ chainKey: 3n, sourceTxHash: HASH, blockHeight: 25_876_969n });
  assert.equal(delivered.ok, false);
  assert.equal(delivered.error.code, "BLOCK_HEIGHT_DISAGREES");
});

test("a failed fetch is passed through with its own code", async () => {
  const { source } = sourceThat({
    ok: false,
    error: { category: "NOT_FOUND", code: "PROOF_MATERIAL_NOT_FOUND", message: "no", retryable: false },
  });
  const deliverer = createProofDeliverer({ source, attestation: attestedAt(30_000_000n) });
  const delivered = await deliverer.deliver({ chainKey: 3n, sourceTxHash: HASH });
  assert.equal(delivered.ok, false);
  assert.equal(delivered.error.code, "PROOF_MATERIAL_NOT_FOUND");
});

test("material whose root does not fold is refused after the gate and before the sale", async () => {
  const { source } = sourceThat({
    ok: true,
    value: material({ merkleProof: { root: `0x${"ff".repeat(32)}`, siblings: [{ hash: S0, isLeft: true }] } }),
  });
  const deliverer = createProofDeliverer({ source, attestation: attestedAt(30_000_000n) });
  const delivered = await deliverer.deliver({ chainKey: 3n, sourceTxHash: HASH });
  assert.equal(delivered.ok, false);
  assert.equal(delivered.error.code, "MERKLE_ROOT_MISMATCH");
});

test("an attested height delivers all three pieces a verifyAndEmit call needs", async () => {
  const { source } = sourceThat({ ok: true, value: material() });
  const deliverer = createProofDeliverer({ source, attestation: attestedAt(25_876_970n) });
  const delivered = await deliverer.deliver({ chainKey: 3n, sourceTxHash: HASH, blockHeight: 25_876_970n });
  assert.equal(delivered.ok, true);
  assert.equal(delivered.value.encodedTransaction, TX);
  assert.equal(delivered.value.merkleProof.root, ROOT);
  assert.equal(delivered.value.merkleProof.siblings.length, 2);
  assert.equal(delivered.value.continuityProof.roots.length, 1);
  assert.equal(delivered.value.blockHeight, "25876970");
  assert.equal(delivered.value.attestation.attestedHeight, "25876970");
  assert.equal(delivered.value.check.derivedRoot, ROOT);
  assert.equal(delivered.value.txIndex, "1");
});

test("every figure on the response is a decimal string, so nothing is lost to JSON", async () => {
  const { source } = sourceThat({ ok: true, value: material() });
  const deliverer = createProofDeliverer({ source, attestation: attestedAt(30_000_000n) });
  const delivered = await deliverer.deliver({ chainKey: 3n, sourceTxHash: HASH });
  const round = JSON.parse(JSON.stringify(delivered.value));
  assert.equal(round.blockHeight, "25876970");
  assert.equal(round.chainKey, "3");
  assert.equal(round.txIndexFromSource, "1");
});

test("a precompile failure refuses the delivery rather than serving unchecked material", async () => {
  const { source } = sourceThat({ ok: true, value: material() });
  const failing = {
    latestAttestation: async () => ({
      ok: false,
      error: { category: "UPSTREAM", code: "CHAININFO_READ_FAILED", message: "down", retryable: true },
    }),
  };
  const deliverer = createProofDeliverer({ source, attestation: failing });
  const delivered = await deliverer.deliver({ chainKey: 3n, sourceTxHash: HASH });
  assert.equal(delivered.ok, false);
  assert.equal(delivered.error.code, "CHAININFO_READ_FAILED");
});
