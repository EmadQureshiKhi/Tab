/**
 * Dual proof sourcing.
 *
 * The Proof Builder client is driven with an injected `fetch`, so the 30-second
 * deadline and the fallback it triggers are asserted without a network. The
 * material the stubs serve is the genuine Mainnet material the live suite recorded,
 * so a "match" here means the same thing it means on chain.
 *
 * Run against the built output, so what is tested is what the pipeline imports.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_PROOF_BUILDER_URL,
  KNOWN_PRECOMPILE_REFUSALS,
  PROOF_BUILDER_TIMEOUT_MS,
  PROOF_MATERIAL_PERISHES,
  classifyPrecompileRefusal,
  createProofBuilderApiSource,
  createRawProofBuilderSource,
  normaliseProofMaterial,
  proofBuilderUrlFromEnv,
  sourceVerifiedProofMaterial,
} from "../dist/proof.js";

const live = JSON.parse(
  readFileSync(new URL("../../../packages/contracts/test/live/results.json", import.meta.url), "utf8"),
);
const recorded = live.cases["forged-merkle-root"];
const SOURCE_TX = recorded.target.sourceTxHash;
const GENUINE_ROOT = recorded.mutation.genuine;

/** The API response shape both paths return, with the genuine root restored. */
const genuineResponse = () => ({
  chainKey: 3,
  headerNumber: recorded.submitted.blockHeight,
  txIndex: recorded.proofMaterial.txIndexFromProofBuilder,
  txHash: SOURCE_TX,
  txBytes: recorded.submitted.encodedTransaction,
  merkleProof: { root: GENUINE_ROOT, siblings: recorded.submitted.merkleProof.siblings },
  continuityProof: recorded.submitted.continuityProof,
  cached: true,
  generatedAt: recorded.proofMaterial.generatedAt,
});

/** The response as the live suite actually submitted it: the root was forged. */
const forgedResponse = () => ({
  ...genuineResponse(),
  merkleProof: { root: recorded.mutation.submitted, siblings: recorded.submitted.merkleProof.siblings },
});

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

test("the 30-second timeout is a named constant, because R20.3 fixes it", () => {
  assert.equal(PROOF_BUILDER_TIMEOUT_MS, 30 * 1000);
  assert.equal(DEFAULT_PROOF_BUILDER_URL, "https://prover.cc3-testnet.creditcoin.network");
});

test("the builder URL comes from the environment, falling back to this network's", () => {
  assert.equal(proofBuilderUrlFromEnv({}), DEFAULT_PROOF_BUILDER_URL);
  assert.equal(proofBuilderUrlFromEnv({ PROOF_BUILDER_URL: "  " }), DEFAULT_PROOF_BUILDER_URL);
  assert.equal(proofBuilderUrlFromEnv({ PROOF_BUILDER_URL: "https://elsewhere" }), "https://elsewhere");
});

test("the API source fetches, normalises, and carries its own Continuity Proof", async () => {
  const seen = [];
  const source = createProofBuilderApiSource({
    baseUrl: "https://prover.example/",
    fetchImpl: async (url, init) => {
      seen.push({ url, signal: init.signal });
      return jsonResponse(genuineResponse());
    },
  });

  const fetched = await source.fetchProof(3, SOURCE_TX);
  assert.equal(fetched.ok, true);
  assert.equal(fetched.value.source, "PROOF_BUILDER");
  assert.equal(fetched.value.merkleProof.root, GENUINE_ROOT);
  assert.equal(fetched.value.blockHeight, BigInt(recorded.submitted.blockHeight));
  assert.equal(fetched.value.txIndexFromSource, 7n);
  // One Continuity Proof per height, travelling with its own Settlement.
  assert.equal(fetched.value.continuityProof.roots.length, 1);
  assert.equal(seen[0].url, `https://prover.example/api/v1/proof-by-tx/3/${SOURCE_TX}`);
  assert.ok(seen[0].signal, "the deadline rides on the request");
});

test("the API source doubles as the attested-height corroborator", async () => {
  const source = createProofBuilderApiSource({
    baseUrl: "https://prover.example",
    fetchImpl: async () => jsonResponse({ attestedHeight: 25913780 }),
  });
  const height = await source.latestAttestedHeight(3);
  assert.equal(height.ok, true);
  assert.equal(height.value, 25913780n);
});

test("a timeout is reported as a timeout, and is retryable", async () => {
  const source = createProofBuilderApiSource({
    baseUrl: "https://prover.example",
    fetchImpl: async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    },
  });
  const fetched = await source.fetchProof(3, SOURCE_TX);
  assert.equal(fetched.ok, false);
  assert.equal(fetched.error.code, "PROOF_BUILDER_TIMEOUT");
  assert.equal(fetched.error.retryable, true);
});

test("a 4xx is not retryable and a 5xx is", async () => {
  const at = async (status) => {
    const source = createProofBuilderApiSource({
      baseUrl: "https://prover.example",
      fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }),
    });
    return (await source.fetchProof(3, SOURCE_TX)).error;
  };
  assert.equal((await at(404)).retryable, false);
  assert.equal((await at(503)).retryable, true);
});

test("material for a different transaction is refused rather than folded", () => {
  const wrong = normaliseProofMaterial("PROOF_BUILDER", 3, `0x${"11".repeat(32)}`, genuineResponse());
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, "PROOF_MATERIAL_MALFORMED");
});

test("a sibling missing its laterality is refused, not defaulted", () => {
  // Defaulting `isLeft` would fold an all-right path and produce a plausible wrong
  // root, which is the one failure mode the local derivation cannot catch.
  const response = genuineResponse();
  const stripped = {
    ...response,
    merkleProof: {
      root: response.merkleProof.root,
      siblings: response.merkleProof.siblings.map(({ hash }) => ({ hash })),
    },
  };
  const refused = normaliseProofMaterial("PROOF_BUILDER", 3, SOURCE_TX, stripped);
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /isLeft/);
});

test("an empty Continuity Proof is refused, because roots[0] is the proved height", () => {
  const response = { ...genuineResponse(), continuityProof: { lowerEndpointDigest: `0x${"00".repeat(32)}`, roots: [] } };
  const refused = normaliseProofMaterial("RAW_BUILDER", 3, SOURCE_TX, response);
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /roots/);
});

// ------------------------------------------------------------------- sourcing

const stubSource = (id, outcome) => ({
  id,
  describe: `stub ${id}`,
  fetchProof: async (chainKey, sourceTxHash) => {
    if (outcome === "unreachable") {
      return {
        ok: false,
        error: { category: "UPSTREAM", code: "PROOF_BUILDER_TIMEOUT", message: "no answer", retryable: true },
      };
    }
    return normaliseProofMaterial(
      id,
      chainKey,
      sourceTxHash,
      outcome === "genuine" ? genuineResponse() : forgedResponse(),
    );
  },
});

test("a verified match from the primary is READY and never asks the fallback", async () => {
  const fallback = stubSource("RAW_BUILDER", "genuine");
  let fallbackCalls = 0;
  const counted = { ...fallback, fetchProof: async (...args) => (fallbackCalls += 1, fallback.fetchProof(...args)) };

  const result = await sourceVerifiedProofMaterial({
    chainKey: 3,
    sourceTxHash: SOURCE_TX,
    primary: stubSource("PROOF_BUILDER", "genuine"),
    fallback: counted,
  });
  assert.equal(result.nextState, "READY");
  assert.equal(result.material.source, "PROOF_BUILDER");
  assert.equal(result.check.outcome, "MATCH");
  assert.equal(result.attempts.length, 1);
  assert.equal(fallbackCalls, 0);
});

test("a primary timeout falls through to the independent builder (R20.3)", async () => {
  const result = await sourceVerifiedProofMaterial({
    chainKey: 3,
    sourceTxHash: SOURCE_TX,
    primary: stubSource("PROOF_BUILDER", "unreachable"),
    fallback: stubSource("RAW_BUILDER", "genuine"),
  });
  assert.equal(result.nextState, "READY");
  assert.equal(result.material.source, "RAW_BUILDER");
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].error.code, "PROOF_BUILDER_TIMEOUT");
});

test("a root mismatch retries the alternate builder rather than submitting (R20.5)", async () => {
  const result = await sourceVerifiedProofMaterial({
    chainKey: 3,
    sourceTxHash: SOURCE_TX,
    primary: stubSource("PROOF_BUILDER", "forged"),
    fallback: stubSource("RAW_BUILDER", "genuine"),
  });
  assert.equal(result.nextState, "READY");
  assert.equal(result.material.source, "RAW_BUILDER");
  assert.equal(result.attempts[0].check.outcome, "ROOT_MISMATCH");
  // The Source Chain transaction hash must be in the log line for the mismatch.
  assert.ok(result.attempts[0].detail.includes(SOURCE_TX));
});

test("both builders disagreeing with the local fold halts rather than looping", async () => {
  const result = await sourceVerifiedProofMaterial({
    chainKey: 3,
    sourceTxHash: SOURCE_TX,
    primary: stubSource("PROOF_BUILDER", "forged"),
    fallback: stubSource("RAW_BUILDER", "forged"),
  });
  assert.equal(result.nextState, "HALTED");
  assert.equal(result.material, undefined);
  assert.equal(result.attempts.length, 2);
});

test("one source that cannot answer withholds rather than halting", async () => {
  const result = await sourceVerifiedProofMaterial({
    chainKey: 3,
    sourceTxHash: SOURCE_TX,
    primary: stubSource("PROOF_BUILDER", "unreachable"),
  });
  assert.equal(result.nextState, "WITHHELD");
  assert.equal(result.attempts.length, 1);
});

test("a failing index cross-check does not withhold a Settlement whose root matched", async () => {
  const result = await sourceVerifiedProofMaterial({
    chainKey: 3,
    sourceTxHash: SOURCE_TX,
    primary: stubSource("PROOF_BUILDER", "genuine"),
    txIndexReader: {
      async calculateTxIndex() {
        return {
          ok: false,
          error: { category: "UPSTREAM", code: "BLOCKPROVER_READ_FAILED", message: "no answer", retryable: true },
        };
      },
    },
  });
  assert.equal(result.nextState, "READY");
  assert.equal(result.check.txIndexFromPrecompile, undefined);
});

test("a precompile index that disagrees withholds even on a matching root", async () => {
  const result = await sourceVerifiedProofMaterial({
    chainKey: 3,
    sourceTxHash: SOURCE_TX,
    primary: stubSource("PROOF_BUILDER", "genuine"),
    txIndexReader: {
      async calculateTxIndex() {
        return { ok: true, value: 504n };
      },
    },
  });
  assert.equal(result.nextState, "WITHHELD");
  assert.equal(result.attempts[0].check.outcome, "TX_INDEX_MISMATCH");
});

test("the raw builder source reports a refusal without throwing", async () => {
  const refusing = createRawProofBuilderSource({
    async getProof() {
      return { success: false, error: "block 25876970 not found" };
    },
  });
  const refused = await refusing.fetchProof(3, SOURCE_TX);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "RAW_BUILDER_REFUSED");

  const throwing = createRawProofBuilderSource({
    async getProof() {
      throw new Error("endpoint rate limited");
    },
  });
  const caught = await throwing.fetchProof(3, SOURCE_TX);
  assert.equal(caught.ok, false);
  assert.equal(caught.error.code, "RAW_BUILDER_FAILED");
});

test("the raw builder source normalises the same shape as the API", async () => {
  const source = createRawProofBuilderSource({
    async getProof() {
      return { success: true, data: genuineResponse() };
    },
  });
  const fetched = await source.fetchProof(3, SOURCE_TX);
  assert.equal(fetched.ok, true);
  assert.equal(fetched.value.source, "RAW_BUILDER");
  assert.equal(fetched.value.merkleProof.root, GENUINE_ROOT);
});

// -------------------------------------------------- refusal classification

test("the observed proof-material refusal retries the alternate builder", () => {
  // The exact string the live suite recorded on chain, twice.
  const observed = classifyPrecompileRefusal("Merkle proof validation failed");
  assert.equal(observed.recognised, true);
  assert.equal(observed.action, "RETRY_ALTERNATE_BUILDER");
});

test("expired proof material is a re-fetch, not a corrupt-material verdict", () => {
  const stale = classifyPrecompileRefusal(PROOF_MATERIAL_PERISHES.observedRefusal);
  assert.equal(stale.recognised, true);
  assert.equal(stale.action, "RETRY_ALTERNATE_BUILDER");
  // Measured: the same target needed 1 root when fresh and 31 later.
  assert.equal(PROOF_MATERIAL_PERISHES.observedRootCounts.whenBuilt, 1);
  assert.equal(PROOF_MATERIAL_PERISHES.observedRootCounts.monthsLater, 31);
});

test("a shared Continuity Proof across a batch is skipped, not retried", () => {
  const shared = classifyPrecompileRefusal("Merkle root mismatch");
  assert.equal(shared.action, "SKIP_AND_FLAG");
});

test("an unrecognised string revert is SKIP-and-flag, never a retryable builder fault", () => {
  const unknown = classifyPrecompileRefusal("something nobody has seen before");
  assert.equal(unknown.recognised, false);
  assert.equal(unknown.action, "SKIP_AND_FLAG");
  assert.ok(unknown.detail.includes("unrecognised"));
});

test("classification is case-insensitive and tolerates surrounding text", () => {
  const wrapped = classifyPrecompileRefusal('execution reverted: "MERKLE PROOF VALIDATION FAILED"');
  assert.equal(wrapped.recognised, true);
  assert.equal(wrapped.action, KNOWN_PRECOMPILE_REFUSALS["merkle proof validation failed"]);
});
