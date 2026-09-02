/**
 * Who may be charged, and how the Service knows it is really them.
 *
 * The digest is the whole mechanism, so the tests are about what it binds. A
 * signature that does not bind the Agent is a bearer token that charges anyone; one
 * that does not bind the reference buys a different proof; one that does not bind
 * the units buys a hundred. Each of those is asserted to change the digest.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Wallet } from "ethers";

import {
  authorisationCovers,
  proofRequestDigest,
  readAuthorisation,
  verifyAgentRequest,
  AUTHORISATION_ABI,
  SIGNATURE_WINDOW_MS,
} from "../dist/authorisation.js";
import { Interface } from "ethers";

const wallet = new Wallet(`0x${"1a".repeat(32)}`);
const NOW = 1_700_000_000_000;

const CLAIM = {
  method: "POST",
  path: `/proof/3/0x${"e6".repeat(32)}`,
  agent: wallet.address,
  tool: `0x${"11".repeat(32)}`,
  units: 1,
  chainKey: "3",
  sourceTxHash: `0x${"e6".repeat(32)}`,
  issuedAt: NOW,
};

test("the digest is newline-separated and starts with its own domain string", () => {
  const lines = proofRequestDigest(CLAIM).split("\n");
  assert.equal(lines[0], "tab-proof-request");
  assert.equal(lines.length, 9);
});

test("every field the claim carries changes the digest", () => {
  const base = proofRequestDigest(CLAIM);
  const mutations = {
    method: "GET",
    path: "/proof/1/other",
    agent: `0x${"cc".repeat(20)}`,
    tool: `0x${"22".repeat(32)}`,
    units: 100,
    chainKey: "1",
    sourceTxHash: `0x${"aa".repeat(32)}`,
    issuedAt: NOW + 1,
  };
  for (const [field, value] of Object.entries(mutations)) {
    assert.notEqual(proofRequestDigest({ ...CLAIM, [field]: value }), base, `${field} is not bound`);
  }
});

test("case does not change the digest, so a checksummed address still verifies", () => {
  const upper = { ...CLAIM, agent: CLAIM.agent.toUpperCase().replace("0X", "0x"), method: "post" };
  assert.equal(proofRequestDigest(upper), proofRequestDigest(CLAIM));
});

test("a fresh signature by the named Agent verifies", async () => {
  const signature = await wallet.signMessage(proofRequestDigest(CLAIM));
  const verified = verifyAgentRequest(CLAIM, signature, NOW);
  assert.equal(verified.ok, true);
  assert.equal(verified.value.signer, wallet.address.toLowerCase());
});

test("a signature by anyone else is refused and names both addresses", async () => {
  const stranger = new Wallet(`0x${"2b".repeat(32)}`);
  const signature = await stranger.signMessage(proofRequestDigest(CLAIM));
  const verified = verifyAgentRequest(CLAIM, signature, NOW);
  assert.equal(verified.ok, false);
  assert.equal(verified.error.code, "PROOF_SIGNATURE_NOT_AGENT");
  assert.equal(verified.error.details.agent, CLAIM.agent);
});

test("the freshness window is two-sided, so a future timestamp is refused too", async () => {
  const signature = await wallet.signMessage(proofRequestDigest(CLAIM));
  const stale = verifyAgentRequest(CLAIM, signature, NOW + SIGNATURE_WINDOW_MS + 1000);
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "PROOF_SIGNATURE_STALE");

  const future = verifyAgentRequest(CLAIM, signature, NOW - SIGNATURE_WINDOW_MS - 1000);
  assert.equal(future.ok, false);
  assert.equal(future.error.code, "PROOF_SIGNATURE_STALE");
});

test("a non-numeric timestamp is stale rather than accepted as zero skew", () => {
  const verified = verifyAgentRequest({ ...CLAIM, issuedAt: Number.NaN }, "0x00", NOW);
  assert.equal(verified.ok, false);
  assert.equal(verified.error.code, "PROOF_SIGNATURE_STALE");
});

test("an unrecoverable signature is refused rather than thrown", () => {
  const verified = verifyAgentRequest(CLAIM, "0xnotasignature", NOW);
  assert.equal(verified.ok, false);
  assert.equal(verified.error.code, "PROOF_SIGNATURE_MALFORMED");
});

test("an authorisation is read positionally and reports what is left", async () => {
  const iface = new Interface([...AUTHORISATION_ABI]);
  const encoded = iface.encodeFunctionResult("authorisationOf", [[4_000_000n, 10_000n, 1_900_000_000n, true]]);
  const seen = [];
  const provider = {
    call: async (request) => {
      seen.push(request.blockTag);
      return encoded;
    },
  };
  const read = await readAuthorisation(provider, `0x${"11".repeat(20)}`, wallet.address, `0x${"22".repeat(32)}`, `0x${"33".repeat(20)}`, "finalized");
  assert.equal(read.ok, true);
  assert.equal(read.value.maxCumulative, 4_000_000n);
  assert.equal(read.value.spent, 10_000n);
  assert.equal(read.value.remaining, 3_990_000n);
  assert.deepEqual(seen, ["finalized"]);
});

test("a spent authorisation floors at zero rather than going negative", async () => {
  const iface = new Interface([...AUTHORISATION_ABI]);
  const encoded = iface.encodeFunctionResult("authorisationOf", [[10n, 20n, 1_900_000_000n, true]]);
  const read = await readAuthorisation({ call: async () => encoded }, `0x${"11".repeat(20)}`, wallet.address, `0x${"22".repeat(32)}`, `0x${"33".repeat(20)}`, "finalized");
  assert.equal(read.value.remaining, 0n);
});

test("a failed authorisation read is upstream and retryable", async () => {
  const read = await readAuthorisation(
    {
      call: async () => {
        throw new Error("down");
      },
    },
    `0x${"11".repeat(20)}`,
    wallet.address,
    `0x${"22".repeat(32)}`,
    `0x${"33".repeat(20)}`,
    "finalized",
  );
  assert.equal(read.ok, false);
  assert.equal(read.error.code, "AUTHORISATION_UNREADABLE");
  assert.equal(read.error.retryable, true);
});

test("each way an authorisation fails to cover a charge is named separately", () => {
  const base = { maxCumulative: 100n, spent: 0n, expiry: 2_000n, exists: true, remaining: 100n };
  assert.equal(authorisationCovers(base, 100n, 1_000n).ok, true);
  assert.equal(authorisationCovers({ ...base, exists: false }, 1n, 1_000n).error.code, "AUTHORISATION_MISSING");
  assert.equal(authorisationCovers(base, 1n, 2_000n).error.code, "AUTHORISATION_EXPIRED");
  assert.equal(authorisationCovers(base, 101n, 1_000n).error.code, "AUTHORISATION_EXCEEDED");
});
