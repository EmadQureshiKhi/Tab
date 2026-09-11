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
  RECEIPT_WAIT_MS,
  RECORD_DELIVERY_GAS_FLOOR,
  RECORD_DELIVERY_GAS_LIMIT,
  TAB_BOOK_INTERFACE,
} from "../dist/tab-book.js";
import { dispositionOf } from "@tabai/sdk";

const AGENT = "0x1f6f797edc2eecb02bd54009b805fb2e99f80542";
const ASSET = "0x534b2f3a21130d7a60830c2df862319e593943a3";
const SERVICE = "0x7461622e64656d6f000000000000000000000000000000000000000000000000";
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
    blockTag: "latest",
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
    blockTag: "latest",
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
    blockTag: "latest",
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
  // `AssetNotAccepted` is the one error in the pinned set the SDK's table does not
  // name, so it is the case that proves the fallback still decodes rather than
  // dropping to raw bytes.
  const data = TAB_BOOK_INTERFACE.encodeErrorResult("AssetNotAccepted", [`0x${"22".repeat(32)}`, ASSET]);
  const client = createTabBookClient({
    provider: fakeProvider({ callError: Object.assign(new Error("reverted"), { data }) }),
    tabBook: `0x${"11".repeat(20)}`,
    blockTag: "latest",
    witnessFor: async () => ({ ok: true, value: WITNESS }),
  });
  const simulated = await client.simulateDelivery(DELIVERY);
  assert.equal(simulated.ok, false);
  assert.equal(simulated.error.category, "CHAIN");
  assert.equal(simulated.error.code, "AssetNotAccepted");
  assert.equal(simulated.error.details.disposition, undefined);
});

test("the wait for a receipt stays under what a caller will wait, and a timeout still delivers", async () => {
  // The response is held until the charge is recorded, so a Service that waits
  // longer than its caller bills an Agent for work it never receives. The
  // SDK's tab_call allows 30s, so the default here must leave room under it.
  assert.equal(RECEIPT_WAIT_MS < 30_000, true, `${RECEIPT_WAIT_MS}ms must sit under the 30s tab_call default`);

  const waits = [];
  const provider = {
    call: async () => okReceipt,
    waitForTransaction: async (_hash, _confirmations, timeoutMs) => {
      waits.push(timeoutMs);
      return null; // no receipt inside the window
    },
  };
  const client = createTabBookClient({
    provider,
    tabBook: `0x${"11".repeat(20)}`,
    blockTag: "latest",
    witnessFor: async () => ({ ok: true, value: WITNESS }),
    signer: { sendTransaction: async () => ({ hash: `0x${"ab".repeat(32)}` }), getAddress: async () => AGENT },
    receiptWaitMs: 4_000,
  });

  const recorded = await client.recordDelivery(DELIVERY);
  assert.deepEqual(waits, [4_000], "the configured wait is the one used");
  assert.equal(recorded.ok, false);
  assert.equal(recorded.error.code, "RECORD_DELIVERY_UNCONFIRMED");
  assert.match(recorded.error.message, /within 4s/);
  // No disposition, so the plugin delivers the work anyway: an Agent that may
  // be charged must at least have what it paid for.
  assert.equal(dispositionOf(recorded.error), "deliver-anyway");
});

test("the gas a delivery states is an estimate, because Monad charges the limit", async () => {
  // A receipt for a delivery sent with a flat 2,000,000 reports gasUsed of
  // exactly 2,000,000, while the same contract's Settlements, sent with an
  // estimate, report 319,695. A generous limit is spent, not reserved, so a
  // Service paid ten times what metering costs it to bill for a cent.
  const cases = [
    { estimate: 220_000n, stated: 308_000n, name: "an ordinary estimate carries a 40% margin" },
    { estimate: 100_000n, stated: RECORD_DELIVERY_GAS_FLOOR, name: "a small estimate is lifted to the floor, for a cold write" },
    { estimate: 9_000_000n, stated: RECORD_DELIVERY_GAS_LIMIT, name: "a huge estimate is held at the ceiling" },
  ];
  for (const { estimate, stated, name } of cases) {
    const sent = [];
    const client = createTabBookClient({
      provider: {
        call: async () => okReceipt,
        estimateGas: async () => estimate,
        waitForTransaction: async () => ({ status: 1, gasUsed: stated }),
      },
      tabBook: `0x${"11".repeat(20)}`,
      blockTag: "latest",
      witnessFor: async () => ({ ok: true, value: WITNESS }),
      signer: {
        getAddress: async () => AGENT,
        sendTransaction: async (tx) => (sent.push(tx), { hash: `0x${"cd".repeat(32)}` }),
      },
    });
    const recorded = await client.recordDelivery(DELIVERY);
    assert.equal(recorded.ok, true, name);
    assert.equal(sent[0].gasLimit, stated, name);
  }

  // A provider that cannot estimate, and one whose estimate throws, both fall
  // back to the ceiling: never wrong, only dear.
  for (const provider of [
    { call: async () => okReceipt, waitForTransaction: async () => ({ status: 1, gasUsed: 1n }) },
    {
      call: async () => okReceipt,
      estimateGas: async () => {
        throw new Error("no estimate");
      },
      waitForTransaction: async () => ({ status: 1, gasUsed: 1n }),
    },
  ]) {
    const sent = [];
    const client = createTabBookClient({
      provider,
      tabBook: `0x${"11".repeat(20)}`,
      blockTag: "latest",
      witnessFor: async () => ({ ok: true, value: WITNESS }),
      signer: { getAddress: async () => AGENT, sendTransaction: async (tx) => (sent.push(tx), { hash: `0x${"cd".repeat(32)}` }) },
    });
    await client.recordDelivery(DELIVERY);
    assert.equal(sent[0].gasLimit, RECORD_DELIVERY_GAS_LIMIT);
  }

  // A limit given explicitly is stated as given, and nothing is estimated.
  const sent = [];
  let estimated = 0;
  const fixed = createTabBookClient({
    provider: {
      call: async () => okReceipt,
      estimateGas: async () => (estimated += 1, 100n),
      waitForTransaction: async () => ({ status: 1, gasUsed: 1n }),
    },
    tabBook: `0x${"11".repeat(20)}`,
    blockTag: "latest",
    witnessFor: async () => ({ ok: true, value: WITNESS }),
    signer: { getAddress: async () => AGENT, sendTransaction: async (tx) => (sent.push(tx), { hash: `0x${"cd".repeat(32)}` }) },
    gasLimit: 777_000n,
  });
  await fixed.recordDelivery(DELIVERY);
  assert.equal(sent[0].gasLimit, 777_000n);
  assert.equal(estimated, 0, "an explicit limit is not second-guessed");
});

test("recording without a signer is refused before any encoding happens", async () => {
  const client = createTabBookClient({
    provider: fakeProvider({ callResult: okReceipt }),
    tabBook: `0x${"11".repeat(20)}`,
    blockTag: "latest",
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
    blockTag: "latest",
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
    blockTag: "latest",
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
    asset: { chainId: 10143n, address: ASSET, decimals: 6, symbol: "USDC" },
    tool: TOOL,
    units: 2,
    expectedUnitPrice: 10_000n,
  });
  assert.equal(seen.asset, ASSET, "the descriptor collapsed to its address");
  assert.equal(seen.units, 2);
  assert.equal((await adapted.openTabOf({ agent: AGENT, serviceId: SERVICE, asset: { address: ASSET }, tool: TOOL, units: 1, expectedUnitPrice: 1n })).value, 7n);
});
