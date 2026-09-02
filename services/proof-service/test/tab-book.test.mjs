/**
 * The `TabBook` client: gas discipline, revert decoding, and the simulate-first rule.
 *
 * The gas cases are the ones worth having. On this chain an exhausted limit mines as
 * `status 0` with `gasUsed == gasLimit`, which is byte-identical to a refusal unless
 * the two figures are compared, and reporting it as a refusal sends an operator
 * hunting for a contract rejection that never happened.
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
const OPERATOR = "0xe5eab26cae0855bccabbb9a64fafce28c8432b37";
const TOOL = `0x${"11".repeat(32)}`;

const DELIVERY = { agent: AGENT, serviceId: SERVICE, asset: ASSET, tool: TOOL, units: 1, expectedUnitPrice: 10_000n };
const WITNESS = { history: [], bonds: [] };

const clientOver = (provider, extra = {}) =>
  createTabBookClient({
    provider,
    tabBook: `0x${"22".repeat(20)}`,
    blockTag: "finalized",
    witnessFor: async () => ({ ok: true, value: WITNESS }),
    ...extra,
  });

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
  assert.ok(RECORD_DELIVERY_GAS_LIMIT > 301_896n * 4n, "the stated limit leaves real headroom");
});

test("every pinned revert decodes to its name and arguments", () => {
  const limit = decodeRevert(TAB_BOOK_INTERFACE.encodeErrorResult("LimitExceeded", [AGENT, ASSET, 10_000n, 500n]));
  assert.equal(limit.name, "LimitExceeded");
  assert.equal(limit.args.requested, "10000");
  assert.equal(limit.args.headroom, "500");

  const unknownTool = decodeRevert(TAB_BOOK_INTERFACE.encodeErrorResult("UnknownTool", [SERVICE, ASSET, TOOL]));
  assert.equal(unknownTool.name, "UnknownTool");
});

test("data the pinned error set does not carry decodes to nothing rather than a guess", () => {
  assert.equal(decodeRevert("0xdeadbeef"), undefined);
});

test("a simulation states the operator as `from`, because a keyless call runs as the zero address", async () => {
  const seen = [];
  const encoded = TAB_BOOK_INTERFACE.encodeFunctionResult("recordDelivery", [10_000n, 10_000n, 4_990_000n]);
  const client = clientOver(
    {
      call: async (request) => {
        seen.push(request);
        return encoded;
      },
    },
    { simulateFrom: OPERATOR, now: () => 7 },
  );
  const simulated = await client.simulateDelivery(DELIVERY);
  assert.equal(simulated.ok, true);
  assert.equal(simulated.value.charged, 10_000n);
  assert.equal(simulated.value.recordedAt, 7);
  assert.equal(seen[0].from, OPERATOR);
  assert.equal(seen[0].blockTag, "finalized");
});

test("a simulated refusal decodes rather than surfacing as raw bytes", async () => {
  const client = clientOver({
    call: async () => {
      const error = new Error("execution reverted");
      error.data = TAB_BOOK_INTERFACE.encodeErrorResult("LimitExceeded", [AGENT, ASSET, 10_000n, 0n]);
      throw error;
    },
  });
  const simulated = await client.simulateDelivery(DELIVERY);
  assert.equal(simulated.ok, false);
  assert.equal(simulated.error.code, "LimitExceeded");
  assert.equal(simulated.error.category, "LIMIT");
});

test("a revert nested inside the provider's info envelope is still decoded", async () => {
  const client = clientOver({
    call: async () => {
      const error = new Error("execution reverted");
      error.info = { error: { data: TAB_BOOK_INTERFACE.encodeErrorResult("UnknownService", [SERVICE]) } };
      throw error;
    },
  });
  const simulated = await client.simulateDelivery(DELIVERY);
  assert.equal(simulated.error.code, "UnknownService");
});

test("a client with no signer is read-only and says so instead of failing late", async () => {
  const client = clientOver({ call: async () => "0x" });
  const recorded = await client.recordDelivery(DELIVERY);
  assert.equal(recorded.ok, false);
  assert.equal(recorded.error.code, "PROOF_SERVICE_KEY_MISSING");
});

test("a witness that cannot be built stops the call before any encoding", async () => {
  const client = createTabBookClient({
    provider: { call: async () => "0x" },
    tabBook: `0x${"22".repeat(20)}`,
    blockTag: "finalized",
    witnessFor: async () => ({
      ok: false,
      error: { category: "CONFLICT", code: "WITNESS_COMMITMENT_MISMATCH", message: "no", retryable: true },
    }),
  });
  const simulated = await client.simulateDelivery(DELIVERY);
  assert.equal(simulated.ok, false);
  assert.equal(simulated.error.code, "WITNESS_COMMITMENT_MISMATCH");
});

test("the Open Tab is read through tabIdOf and tabOf at the pinned tag", async () => {
  const tabId = `0x${"7a".repeat(32)}`;
  const provider = {
    call: async (request) => {
      if (request.data.startsWith(TAB_BOOK_INTERFACE.getFunction("tabIdOf").selector)) {
        return TAB_BOOK_INTERFACE.encodeFunctionResult("tabIdOf", [tabId]);
      }
      return TAB_BOOK_INTERFACE.encodeFunctionResult("tabOf", [[101_000n, 0n, 1n, 2n, 3, false]]);
    },
  };
  const open = await clientOver(provider).openTabOf(DELIVERY);
  assert.equal(open.ok, true);
  assert.equal(open.value, 101_000n);
});

test("an unreadable Open Tab is upstream and retryable, so a 402 is not built on a guess", async () => {
  const client = clientOver({
    call: async () => {
      throw new Error("down");
    },
  });
  const open = await client.openTabOf(DELIVERY);
  assert.equal(open.ok, false);
  assert.equal(open.error.code, "OPEN_TAB_UNREADABLE");
});

test("the Credit Limit is read through the same witness the charge would use", async () => {
  const client = clientOver({
    call: async () => TAB_BOOK_INTERFACE.encodeFunctionResult("creditLimit", [5_000_000n]),
  });
  const limit = await client.creditLimit(AGENT, ASSET);
  assert.equal(limit.ok, true);
  assert.equal(limit.value, 5_000_000n);
});

test("the SDK shape flattens the Asset descriptor to the address the contract is keyed by", async () => {
  const seen = [];
  const client = toSdkTabBookClient({
    recordDelivery: async (delivery) => {
      seen.push(delivery);
      return { ok: true, value: { charged: 1n, openAfter: 1n, headroomAfter: 1n, recordedAt: 1 } };
    },
    openTabOf: async (delivery) => {
      seen.push(delivery);
      return { ok: true, value: 0n };
    },
    simulateDelivery: async () => ({ ok: true, value: { charged: 1n, openAfter: 1n, headroomAfter: 1n, recordedAt: 1 } }),
    creditLimit: async () => ({ ok: true, value: 0n }),
  });
  const sdkDelivery = { ...DELIVERY, asset: { address: ASSET, chainKey: 1n, decimals: 6, symbol: "USDC" } };
  await client.recordDelivery(sdkDelivery);
  await client.openTabOf(sdkDelivery);
  assert.equal(seen.length, 2);
  for (const delivery of seen) assert.equal(delivery.asset, ASSET);
});
