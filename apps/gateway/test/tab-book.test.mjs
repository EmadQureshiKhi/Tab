/**
 * The `TabBook` client: gas discipline, revert decoding, and the simulate-first rule.
 *
 * The gas cases are the ones worth having. On this chain an exhausted limit mines
 * as `status 0` with `gasUsed == gasLimit`, which is byte-identical to a refusal
 * unless the two figures are compared, and reporting it as a refusal sends an
 * operator hunting for a contract rejection that never happened.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifySubmission,
  createTabBookClient,
  decodeRevert,
  toSdkTabBookClient,
  RECORD_DELIVERY_GAS_LIMIT,
  TAB_BOOK_INTERFACE,
} from "../dist/tab-book.js";

const AGENT = "0x1f6f797edc2eecb02bd54009b805fb2e99f80542";
const ASSET = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const SERVICE = "0x7461622e70726f6f662d73657276696365000000000000000000000000000000";
const TOOL = `0x${"11".repeat(32)}`;

const DELIVERY = { agent: AGENT, serviceId: SERVICE, asset: ASSET, tool: TOOL, units: 1, expectedUnitPrice: 10_000n };
const WITNESS = { history: [], bonds: [] };

test("a successful receipt is applied and reports what it consumed", () => {
  const verdict = classifySubmission(1, 301_896n, 2_000_000n, "0xabc");
  assert.equal(verdict.outcome, "APPLIED");
  assert.match(verdict.detail, /301896 gas of a stated 2000000/);
});

test("a failure that consumed its whole limit is an exhausted limit, not a refusal", () => {
  // The exact shape measured on this chain: a 300,000 limit met a 301,896 cost.
  const verdict = classifySubmission(0, 300_000n, 300_000n, "0xabc");
  assert.equal(verdict.outcome, "GAS_EXHAUSTED");
  assert.match(verdict.detail, /ran out of gas rather than being refused/);
});

test("a failure well under its limit is a refusal", () => {
  const verdict = classifySubmission(0, 120_000n, 2_000_000n, "0xabc");
  assert.equal(verdict.outcome, "REVERTED");
  assert.match(verdict.detail, /refused the delivery/);
});

test("the stated limit sits well above the measured cost of a smaller write", () => {
  // `authorise` cost 301,896 and writes far less than `recordDelivery` does.
  assert.ok(RECORD_DELIVERY_GAS_LIMIT > 301_896n * 4n, "the stated limit leaves real headroom");
});

test("a LimitExceeded revert decodes to its name and its figures", () => {
  const data = TAB_BOOK_INTERFACE.encodeErrorResult("LimitExceeded", [AGENT, ASSET, 10_000n, 500n]);
  const decoded = decodeRevert(data);
  assert.equal(decoded.name, "LimitExceeded");
  assert.equal(decoded.args.requested, "10000");
  assert.equal(decoded.args.headroom, "500");
});

test("an unknown revert decodes to nothing rather than to a wrong name", () => {
  assert.equal(decodeRevert(`0x${"de".repeat(36)}`), undefined);
});

/** A provider whose answers a test dictates. */
function fakeProvider({ callResult, callError }) {
  return {
    call: async () => {
      if (callError !== undefined) throw callError;
      return callResult;
    },
    waitForTransaction: async () => ({ status: 1, gasUsed: 400_000n }),
  };
}

const okReceipt = TAB_BOOK_INTERFACE.encodeFunctionResult("recordDelivery", [10_000n, 10_000n, 4_740_000n]);

test("a simulation returns the contract's own figures and spends nothing", async () => {
  const client = createTabBookClient({
    provider: fakeProvider({ callResult: okReceipt }),
    tabBook: `0x${"11".repeat(20)}`,
    blockTag: "finalized",
    witnessFor: async () => ({ ok: true, value: WITNESS }),
  });
  const simulated = await client.simulateDelivery(DELIVERY);
  assert.equal(simulated.ok, true);
  assert.equal(simulated.value.charged, 10_000n);
  assert.equal(simulated.value.openAfter, 10_000n);
  assert.equal(simulated.value.headroomAfter, 4_740_000n);
});

test("a refused simulation carries the decoded revert rather than raw bytes", async () => {
  const data = TAB_BOOK_INTERFACE.encodeErrorResult("AuthorisationMissing", [AGENT, SERVICE, ASSET]);
  const client = createTabBookClient({
    provider: fakeProvider({ callError: Object.assign(new Error("reverted"), { data }) }),
    tabBook: `0x${"11".repeat(20)}`,
    blockTag: "finalized",
    witnessFor: async () => ({ ok: true, value: WITNESS }),
  });
  const simulated = await client.simulateDelivery(DELIVERY);
  assert.equal(simulated.ok, false);
  // The code is the SDK's canonical one and the raw revert name is kept beside
  // it, so a caller can branch on the stable code and still read what the chain
  // actually said.
  assert.equal(simulated.error.code, "AUTHORISATION_MISSING");
  assert.equal(simulated.error.category, "AUTHORISATION");
  assert.equal(simulated.error.details.revert, "AuthorisationMissing");
  assert.equal(String(simulated.error.details.agent).toLowerCase(), AGENT.toLowerCase());
});

test("a refusal the Agent can fix carries the disposition that replaces the response", async () => {
  // The post-paid plugin reads `details.disposition` to decide whether a refusal
  // replaces the delivered response. Without it a LimitExceeded is treated as the
  // Service's fault and the response goes out as a 200 carrying no charge block,
  // which is the opposite of the one 402 this surface is meant to add.
  const data = TAB_BOOK_INTERFACE.encodeErrorResult("LimitExceeded", [AGENT, ASSET, 10_000n, 0n]);
  const client = createTabBookClient({
    provider: fakeProvider({ callError: Object.assign(new Error("reverted"), { data }) }),
    tabBook: `0x${"11".repeat(20)}`,
    blockTag: "finalized",
    witnessFor: async () => ({ ok: true, value: WITNESS }),
  });
  const simulated = await client.simulateDelivery(DELIVERY);
  assert.equal(simulated.ok, false);
  assert.equal(simulated.error.category, "LIMIT");
  assert.equal(simulated.error.details.disposition, "refuse-request");
  assert.equal(simulated.error.details.headroom, "0");
  assert.match(simulated.error.details.action, /settle the Open Tab/);
});

test("a revert the SDK table does not name still decodes, as a chain fault", async () => {
  // `AssetMismatch` is the one error in the pinned set the SDK's table does not
  // name, so it is the case that proves the fallback still decodes rather than
  // dropping to raw bytes.
  const data = TAB_BOOK_INTERFACE.encodeErrorResult("AssetMismatch", [ASSET, `0x${"99".repeat(20)}`]);
  const client = createTabBookClient({
    provider: fakeProvider({ callError: Object.assign(new Error("reverted"), { data }) }),
    tabBook: `0x${"11".repeat(20)}`,
    blockTag: "finalized",
    witnessFor: async () => ({ ok: true, value: WITNESS }),
  });
  const simulated = await client.simulateDelivery(DELIVERY);
  assert.equal(simulated.ok, false);
  assert.equal(simulated.error.category, "CHAIN");
  assert.equal(simulated.error.code, "AssetMismatch");
  assert.equal(simulated.error.details.disposition, undefined);
});

test("recording without a signer is refused before any encoding happens", async () => {
  const client = createTabBookClient({
    provider: fakeProvider({ callResult: okReceipt }),
    tabBook: `0x${"11".repeat(20)}`,
    blockTag: "finalized",
    witnessFor: async () => ({ ok: true, value: WITNESS }),
  });
  const recorded = await client.recordDelivery(DELIVERY);
  assert.equal(recorded.ok, false);
  assert.equal(recorded.error.code, "GATEWAY_KEY_MISSING");
});

test("a witness that cannot be built stops the call rather than encoding an empty one", async () => {
  const client = createTabBookClient({
    provider: fakeProvider({ callResult: okReceipt }),
    tabBook: `0x${"11".repeat(20)}`,
    blockTag: "finalized",
    witnessFor: async () => ({
      ok: false,
      error: { category: "CONFLICT", code: "WITNESS_COMMITMENT_MISMATCH", message: "stale", retryable: true },
    }),
  });
  const simulated = await client.simulateDelivery(DELIVERY);
  assert.equal(simulated.ok, false);
  assert.equal(simulated.error.code, "WITNESS_COMMITMENT_MISMATCH");
});

test("a broadcast simulates first, so a refusal never reaches the chain", async () => {
  const data = TAB_BOOK_INTERFACE.encodeErrorResult("LimitExceeded", [AGENT, ASSET, 10_000n, 0n]);
  let sent = 0;
  const client = createTabBookClient({
    provider: fakeProvider({ callError: Object.assign(new Error("reverted"), { data }) }),
    tabBook: `0x${"11".repeat(20)}`,
    blockTag: "finalized",
    witnessFor: async () => ({ ok: true, value: WITNESS }),
    signer: {
      getAddress: async () => `0x${"22".repeat(20)}`,
      sendTransaction: async () => {
        sent += 1;
        return { hash: "0xdead" };
      },
    },
  });
  const recorded = await client.recordDelivery(DELIVERY);
  assert.equal(recorded.ok, false);
  assert.equal(recorded.error.code, "LIMIT_EXCEEDED");
  assert.equal(recorded.error.details.revert, "LimitExceeded");
  assert.equal(sent, 0, "nothing was broadcast for a delivery the simulation already refused");
});

test("the SDK adapter flattens an AssetRef to the address the chain is keyed by", async () => {
  let seen;
  const adapted = toSdkTabBookClient({
    recordDelivery: async (delivery) => {
      seen = delivery;
      return { ok: true, value: { charged: 1n, openAfter: 1n, headroomAfter: 1n, recordedAt: 0 } };
    },
    openTabOf: async () => ({ ok: true, value: 7n }),
    simulateDelivery: async () => ({ ok: true, value: { charged: 1n, openAfter: 1n, headroomAfter: 1n, recordedAt: 0 } }),
    creditLimit: async () => ({ ok: true, value: 1n }),
  });

  await adapted.recordDelivery({
    agent: AGENT,
    serviceId: SERVICE,
    asset: { chainKey: 1n, address: ASSET, decimals: 6, symbol: "USDC" },
    tool: TOOL,
    units: 2,
    expectedUnitPrice: 10_000n,
  });
  assert.equal(seen.asset, ASSET, "the descriptor collapsed to its address");
  assert.equal(seen.units, 2);
  assert.equal((await adapted.openTabOf({ agent: AGENT, serviceId: SERVICE, asset: { address: ASSET }, tool: TOOL, units: 1, expectedUnitPrice: 1n })).value, 7n);
});
