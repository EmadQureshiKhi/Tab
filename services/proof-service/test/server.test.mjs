/**
 * The HTTP surface, where the ordering requirement is either true or it is not.
 *
 * R22.3 says the Metered Delivery is recorded before the proof material is
 * returned, and R22.5 says an unattested height records zero. Both are asserted here
 * by observation rather than by reading the plugin's documentation: the doubles
 * append to one ordered log, so "metered" appearing before the response is read is a
 * fact the test can see.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Wallet, encodeBytes32String } from "ethers";

import { createApp, referenceFromPath, withholdingReason, PROOF_TOOL_NAME } from "../dist/server.js";
import { ISSUED_AT_HEADER, SIGNATURE_HEADER, proofRequestDigest } from "../dist/authorisation.js";

const SERVICE = "0x7461622e70726f6f662d73657276696365000000000000000000000000000000";
const TOOL = encodeBytes32String(PROOF_TOOL_NAME);
const HASH = `0x${"e6".repeat(32)}`;
const ROOT = "0x0514dac2cdb08d956a4c0a294ef3db963bca76edf4e6b9c310b267a77d7dca69";

const ASSET = {
  chainKey: 1n,
  address: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  decimals: 6,
  symbol: "USDC",
};

const MATERIAL = {
  chainKey: "3",
  sourceTxHash: HASH,
  blockHeight: "25876970",
  txIndex: "1",
  txIndexFromSource: "1",
  encodedTransaction: "0x02f8b10182",
  merkleProof: { root: ROOT, siblings: [{ hash: `0x${"11".repeat(32)}`, isLeft: true }] },
  continuityProof: { lowerEndpointDigest: `0x${"33".repeat(32)}`, roots: [`0x${"44".repeat(32)}`] },
  attestation: { attestedHeight: "25877000", frontierIsAttestation: true },
  check: { derivedRoot: ROOT, derivedTxIndex: "1", txIndexAgrees: true, depth: 1 },
  cached: false,
};

const harness = (overrides = {}) => {
  const order = [];
  const calls = { records: 0 };
  const deliverer = {
    deliver: async () => {
      order.push("delivered");
      return overrides.delivery ?? { ok: true, value: MATERIAL };
    },
  };
  const tabBook = {
    recordDelivery: async () => {
      order.push("metered");
      calls.records += 1;
      return (
        overrides.record ?? {
          ok: true,
          value: { charged: 10_000n, openAfter: 10_000n, headroomAfter: 4_990_000n, recordedAt: 1 },
        }
      );
    },
    openTabOf: async () => ({ ok: true, value: 0n }),
    simulateDelivery: async () => ({ ok: true, value: { charged: 10_000n, openAfter: 0n, headroomAfter: 0n, recordedAt: 1 } }),
    creditLimit: async () => ({ ok: true, value: 5_000_000n }),
  };
  const app = createApp({
    serviceId: SERVICE,
    asset: ASSET,
    tool: TOOL,
    unitPrice: 10_000n,
    tabBook,
    deliverer,
    requireSignature: false,
    now: () => 1_700_000_000_000,
    ...overrides.options,
  });
  return { app, order, calls };
};

const AGENT_KEY = `0x${"1a".repeat(32)}`;
const agentWallet = new Wallet(AGENT_KEY);

const call = (app, path, headers = {}) =>
  app.request(path, { method: "POST", headers: { "Tab-Agent": agentWallet.address, ...headers } });

test("the path parser accepts exactly the documented shape", () => {
  assert.deepEqual(referenceFromPath(`/proof/3/${HASH}`), { chainKey: 3n, sourceTxHash: HASH });
  assert.equal(referenceFromPath("/proof/3"), undefined);
  assert.equal(referenceFromPath(`/proof/3/${HASH}/extra`), undefined);
  assert.equal(referenceFromPath(`/proof/x/${HASH}`), undefined);
  assert.equal(referenceFromPath("/proof/3/0x1234"), undefined);
  assert.equal(referenceFromPath(`/other/3/${HASH}`), undefined);
});

test("the liveness probe is unauthenticated, unmetered, and states the price", async () => {
  const { app, calls } = harness();
  const response = await app.request("/healthz");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.serviceId, SERVICE);
  assert.equal(body.unitPriceBaseUnits, "10000");
  assert.equal(calls.records, 0);
});

test("a delivered proof is metered before the response is read", async () => {
  const { app, order, calls } = harness();
  const response = await call(app, `/proof/3/${HASH}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  order.push("read");
  assert.deepEqual(order, ["delivered", "metered", "read"]);
  assert.equal(calls.records, 1);
  assert.equal(body.proof.merkleProof.root, ROOT);
  assert.equal(body.proof.encodedTransaction, "0x02f8b10182");
  assert.equal(body.proof.continuityProof.roots.length, 1);
});

test("a charged response carries the Tab charge headers", async () => {
  const { app } = harness();
  const response = await call(app, `/proof/3/${HASH}`);
  assert.equal(response.headers.get("Tab-Charge-Amount"), "10000");
  assert.equal(response.headers.get("Tab-Charge-Tool"), TOOL);
});

test("an unattested height is a 503 naming both heights and records zero delivery", async () => {
  const { app, order, calls } = harness({
    delivery: {
      ok: false,
      error: {
        category: "UNAVAILABLE",
        code: "HEIGHT_NOT_ATTESTED",
        message: "the requested Source Chain block height 25876970 is not yet attested: the current attested height is 25876900",
        retryable: true,
        details: { requestedHeight: "25876970", attestedHeight: "25876900", metered: false },
      },
    },
  });
  const response = await call(app, `/proof/3/${HASH}`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "HEIGHT_NOT_ATTESTED");
  assert.equal(body.error.details.requestedHeight, "25876970");
  assert.equal(body.error.details.attestedHeight, "25876900");
  assert.equal(calls.records, 0, "an unattested height must record zero Metered Delivery");
  assert.deepEqual(order, ["delivered"]);
});

test("material built but not metered is withheld rather than given away", async () => {
  const { app } = harness({
    record: {
      ok: false,
      error: { category: "CHAIN", code: "RECORD_DELIVERY_REVERTED", message: "refused", retryable: false },
    },
  });
  const response = await call(app, `/proof/3/${HASH}`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "DELIVERY_NOT_METERED");
  assert.equal(body.error.details.meteringCode, "RECORD_DELIVERY_REVERTED");
  assert.equal(body.proof, undefined);
});

test("withholding can be switched off, and then the SDK's own disposition stands", async () => {
  const { app } = harness({
    record: {
      ok: false,
      error: { category: "CHAIN", code: "RECORD_DELIVERY_REVERTED", message: "refused", retryable: false },
    },
    options: { withholdUnmetered: false },
  });
  const response = await call(app, `/proof/3/${HASH}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.proof.merkleProof.root, ROOT);
});

test("a LimitExceeded refusal replaces the response with the SDK's 402", async () => {
  const { app } = harness({
    record: {
      ok: false,
      error: {
        category: "LIMIT",
        code: "LimitExceeded",
        message: "the charge exceeds the Credit Limit: settle an Open Tab",
        retryable: false,
        details: { disposition: "refuse-request", requested: "10000", headroom: "0" },
      },
    },
  });
  const response = await call(app, `/proof/3/${HASH}`);
  assert.equal(response.status, 402);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.category, "LIMIT");
});

test("a request naming no Agent is refused before anything is built", async () => {
  const { app, order } = harness();
  const response = await app.request(`/proof/3/${HASH}`, { method: "POST" });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, "AGENT_HEADER_ABSENT");
  assert.deepEqual(order, []);
});

test("a malformed path is refused with the documented shape spelled out", async () => {
  const { app } = harness();
  const response = await call(app, "/proof/3/0x1234");
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "PROOF_PATH_MALFORMED");
});

test("a non-decimal height query is refused", async () => {
  const { app } = harness();
  const response = await call(app, `/proof/3/${HASH}?height=abc`);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "BLOCK_HEIGHT_MALFORMED");
});

test("with signatures required, an unsigned request is refused and nothing is built", async () => {
  const { app, order } = harness({ options: { requireSignature: true } });
  const response = await call(app, `/proof/3/${HASH}`);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, "PROOF_SIGNATURE_ABSENT");
  assert.deepEqual(order, []);
});

test("a request signed by the Agent it charges is served", async () => {
  const issuedAt = 1_700_000_000_000;
  const { app, calls } = harness({ options: { requireSignature: true } });
  const path = `/proof/3/${HASH}`;
  const signature = await agentWallet.signMessage(
    proofRequestDigest({
      method: "POST",
      path,
      agent: agentWallet.address,
      tool: TOOL,
      units: 1,
      chainKey: "3",
      sourceTxHash: HASH,
      issuedAt,
    }),
  );
  const response = await call(app, path, {
    [SIGNATURE_HEADER]: signature,
    [ISSUED_AT_HEADER]: String(issuedAt),
  });
  assert.equal(response.status, 200);
  assert.equal(calls.records, 1);
});

test("a signature by anyone other than the named Agent is refused", async () => {
  const issuedAt = 1_700_000_000_000;
  const stranger = new Wallet(`0x${"2b".repeat(32)}`);
  const { app } = harness({ options: { requireSignature: true } });
  const path = `/proof/3/${HASH}`;
  const signature = await stranger.signMessage(
    proofRequestDigest({
      method: "POST",
      path,
      agent: agentWallet.address,
      tool: TOOL,
      units: 1,
      chainKey: "3",
      sourceTxHash: HASH,
      issuedAt,
    }),
  );
  const response = await call(app, path, {
    [SIGNATURE_HEADER]: signature,
    [ISSUED_AT_HEADER]: String(issuedAt),
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, "PROOF_SIGNATURE_NOT_AGENT");
});

test("a signature over a different transaction does not buy this one", async () => {
  const issuedAt = 1_700_000_000_000;
  const { app } = harness({ options: { requireSignature: true } });
  const path = `/proof/3/${HASH}`;
  const signature = await agentWallet.signMessage(
    proofRequestDigest({
      method: "POST",
      path,
      agent: agentWallet.address,
      tool: TOOL,
      units: 1,
      chainKey: "3",
      sourceTxHash: `0x${"aa".repeat(32)}`,
      issuedAt,
    }),
  );
  const response = await call(app, path, {
    [SIGNATURE_HEADER]: signature,
    [ISSUED_AT_HEADER]: String(issuedAt),
  });
  assert.equal(response.status, 403);
});

test("the withholding rule keeps refusals and charges alone and catches the rest", () => {
  assert.equal(withholdingReason({ kind: "charged" }), undefined);
  assert.equal(withholdingReason({ kind: "refused" }), undefined);
  assert.equal(withholdingReason({ kind: "not-metered", reason: "not-billable", detail: "" }), undefined);
  assert.equal(withholdingReason({ kind: "not-metered", reason: "handler-failed", detail: "" }), undefined);
  const noAgent = withholdingReason({ kind: "not-metered", reason: "no-agent", detail: "none" });
  assert.equal(noAgent.code, "DELIVERY_NOT_METERED");
  assert.equal(noAgent.details.metered, false);
});
