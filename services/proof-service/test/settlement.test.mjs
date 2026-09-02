/**
 * The Proof Service settling its own tabs, and the checks that come before money moves.
 *
 * The assertion that matters most is a negative one: no path in this module writes
 * to Creditcoin. The operator holds a key that could clear its own tabs by hand, and
 * R22.4 is the requirement that it does not. So the strategy double below records
 * every call, and the tests assert that settling produces a Source Chain payment and
 * a watch hint and nothing else.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createProofServiceSettler,
  createSettlementReader,
  modeFor,
  COLLECTION_INTERFACE,
  COLLECTION_KIND_BOND,
  COLLECTION_KIND_TAB,
} from "../dist/settlement.js";

const AGENT = "0xe5eab26cae0855bccabbb9a64fafce28c8432b37";
const SERVICE = "0x7461622e70726f6f662d73657276696365000000000000000000000000000000";
const COLLECTION = "0x952acc70e6f54ce87dca963193a5957bcb27729e";
const TAB_ID = `0x${"7a".repeat(32)}`;

const SEPOLIA_USDC = {
  chainKey: 1n,
  address: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  decimals: 6,
  symbol: "USDC",
};

const MAINNET_USDC = {
  chainKey: 3n,
  address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  decimals: 6,
  symbol: "USDC",
};

const readerWith = (tab = {}, collection = {}) => ({
  openTab: async () => ({
    ok: true,
    value: {
      tabId: TAB_ID,
      open: 101_000n,
      prepaid: 0n,
      oldestUnsettledAt: 1n,
      lastDeliveryAt: 2n,
      deliveryCount: 1,
      delinquent: false,
      ...tab,
    },
  }),
  collection: async () => ({
    ok: true,
    value: {
      serviceId: SERVICE,
      asset: SEPOLIA_USDC.address,
      chainKey: 1n,
      exists: true,
      kind: COLLECTION_KIND_TAB,
      ...collection,
    },
  }),
});

const strategyDouble = (overrides = {}) => {
  const calls = { settles: [], quotes: 0 };
  return {
    calls,
    strategy: {
      id: "ethereum-usdc",
      chainKeys: [1n, 3n],
      supports: () => true,
      quote: async (request) => {
        calls.quotes += 1;
        return { ok: true, value: { amount: request.amount, asset: request.asset, feeNote: "one for one" } };
      },
      settle: async (request) => {
        calls.settles.push(request);
        return {
          ok: true,
          value: {
            strategyId: "ethereum-usdc",
            chainKey: request.asset.chainKey,
            sourceTxHash: `0x${"5e".repeat(32)}`,
            asset: request.asset,
            amount: request.amount,
            payerAddress: AGENT,
            submittedAt: 1,
            mode: request.mode,
            collectionAddress: request.collectionAddress,
            tabId: request.tabId,
            emitter: request.asset.address,
          },
        };
      },
      settleBatch: async () => ({ ok: false, error: { category: "VALIDATION", code: "X", message: "x", retryable: false } }),
      watchHint: (receipt) => ({
        chainKey: receipt.chainKey,
        sourceTxHash: receipt.sourceTxHash,
        expectedEventSignature: `0x${"11".repeat(32)}`,
        expectedEmitter: receipt.emitter,
        expectedPayerTopic: `0x${"22".repeat(32)}`,
        expectedCollectionTopic: `0x${"33".repeat(32)}`,
        asset: receipt.asset,
        amount: receipt.amount,
      }),
      ...overrides,
    },
  };
};

test("the surface is chosen by chainKey, because it is a fact about where Tab deployed", () => {
  assert.equal(modeFor(3n).value, "direct-transfer");
  assert.equal(modeFor(1n).value, "settlement-contract");
  assert.equal(modeFor(9n).ok, false);
});

test("a plan reads the Open Tab, checks the recipient, and quotes the payment", async () => {
  const { calls, strategy } = strategyDouble();
  const settler = createProofServiceSettler({ agent: AGENT, reader: readerWith(), strategy });
  const plan = await settler.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: COLLECTION });
  assert.equal(plan.ok, true);
  assert.equal(plan.value.amount, 101_000n);
  assert.equal(plan.value.openTab, 101_000n);
  assert.equal(plan.value.tabId, TAB_ID);
  assert.equal(plan.value.mode, "settlement-contract");
  assert.equal(calls.quotes, 1);
  assert.equal(calls.settles.length, 0, "planning must move nothing");
});

test("a Mainnet plan settles by plain transfer, because Tab deploys nothing there", async () => {
  const { strategy } = strategyDouble();
  const reader = readerWith({}, { asset: MAINNET_USDC.address, chainKey: 3n });
  const settler = createProofServiceSettler({ agent: AGENT, reader, strategy });
  const plan = await settler.plan({ serviceId: SERVICE, asset: MAINNET_USDC, collectionAddress: COLLECTION });
  assert.equal(plan.ok, true);
  assert.equal(plan.value.mode, "direct-transfer");
});

test("nothing owed is not an error worth a payment", async () => {
  const { strategy } = strategyDouble();
  const settler = createProofServiceSettler({ agent: AGENT, reader: readerWith({ open: 0n }), strategy });
  const plan = await settler.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: COLLECTION });
  assert.equal(plan.ok, false);
  assert.equal(plan.error.code, "NO_OPEN_TAB");
});

test("a partial settlement is allowed and an overpayment is not", async () => {
  const { strategy } = strategyDouble();
  const settler = createProofServiceSettler({ agent: AGENT, reader: readerWith(), strategy });
  const partial = await settler.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: COLLECTION, amount: 1_000n });
  assert.equal(partial.value.amount, 1_000n);
  assert.equal(partial.value.openTab, 101_000n);

  const over = await settler.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: COLLECTION, amount: 200_000n });
  assert.equal(over.ok, false);
  assert.equal(over.error.code, "AMOUNT_EXCEEDS_OPEN_TAB");

  const zero = await settler.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: COLLECTION, amount: 0n });
  assert.equal(zero.ok, false);
  assert.equal(zero.error.code, "AMOUNT_NOT_POSITIVE");
});

test("a delinquent tab is planned and flagged rather than refused", async () => {
  const { strategy } = strategyDouble();
  const settler = createProofServiceSettler({ agent: AGENT, reader: readerWith({ delinquent: true }), strategy });
  const plan = await settler.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: COLLECTION });
  assert.equal(plan.ok, true);
  assert.equal(plan.value.delinquent, true);
});

test("an unregistered recipient is refused, because that payment is credited to nothing", async () => {
  const { calls, strategy } = strategyDouble();
  const settler = createProofServiceSettler({ agent: AGENT, reader: readerWith({}, { exists: false }), strategy });
  const plan = await settler.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: COLLECTION });
  assert.equal(plan.ok, false);
  assert.equal(plan.error.code, "COLLECTION_UNREGISTERED");
  assert.equal(calls.settles.length, 0);
});

test("a Bond collection is refused, because paying it credits stake rather than the tab", async () => {
  const { strategy } = strategyDouble();
  const settler = createProofServiceSettler({
    agent: AGENT,
    reader: readerWith({}, { kind: COLLECTION_KIND_BOND }),
    strategy,
  });
  const plan = await settler.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: COLLECTION });
  assert.equal(plan.ok, false);
  assert.equal(plan.error.code, "COLLECTION_KIND_WRONG");
  assert.match(plan.error.message, /Bond collection/);
});

test("a recipient that collects for another Service or another Asset is refused", async () => {
  const { strategy } = strategyDouble();
  const wrongService = createProofServiceSettler({
    agent: AGENT,
    reader: readerWith({}, { serviceId: `0x${"ab".repeat(32)}` }),
    strategy,
  });
  const one = await wrongService.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: COLLECTION });
  assert.equal(one.error.code, "COLLECTION_SERVICE_MISMATCH");

  const wrongAsset = createProofServiceSettler({
    agent: AGENT,
    reader: readerWith({}, { asset: MAINNET_USDC.address }),
    strategy,
  });
  const two = await wrongAsset.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: COLLECTION });
  assert.equal(two.error.code, "COLLECTION_ASSET_MISMATCH");
});

test("an Asset the strategy does not carry is refused before any read", async () => {
  const { strategy } = strategyDouble({ supports: () => false });
  const settler = createProofServiceSettler({ agent: AGENT, reader: readerWith(), strategy });
  const plan = await settler.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: COLLECTION });
  assert.equal(plan.ok, false);
  assert.equal(plan.error.code, "ASSET_NOT_SUPPORTED");
});

test("malformed identifiers are refused by name", async () => {
  const { strategy } = strategyDouble();
  const settler = createProofServiceSettler({ agent: AGENT, reader: readerWith(), strategy });
  const badService = await settler.plan({ serviceId: "0x12", asset: SEPOLIA_USDC, collectionAddress: COLLECTION });
  assert.equal(badService.error.code, "SERVICE_ID_MALFORMED");
  const badCollection = await settler.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: "0x12" });
  assert.equal(badCollection.error.code, "COLLECTION_ADDRESS_MALFORMED");
});

test("settling without the broadcast flag submits nothing and says why", async () => {
  const { calls, strategy } = strategyDouble();
  const settler = createProofServiceSettler({ agent: AGENT, reader: readerWith(), strategy });
  const plan = await settler.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: COLLECTION });
  const settled = await settler.settle(plan.value, { broadcast: false });
  assert.equal(settled.ok, false);
  assert.equal(settled.error.code, "BROADCAST_NOT_REQUESTED");
  assert.equal(settled.error.details.amount, "101000");
  assert.equal(calls.settles.length, 0);
});

test("settling goes through the strategy and hands the Watcher a hint, and writes no Creditcoin state", async () => {
  const { calls, strategy } = strategyDouble();
  const settler = createProofServiceSettler({ agent: AGENT, reader: readerWith(), strategy });
  const plan = await settler.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: COLLECTION });
  const settled = await settler.settle(plan.value, { broadcast: true });
  assert.equal(settled.ok, true);
  assert.equal(calls.settles.length, 1);
  assert.equal(calls.settles[0].tabId, TAB_ID);
  assert.equal(calls.settles[0].collectionAddress, COLLECTION);
  assert.equal(calls.settles[0].mode, "settlement-contract");
  assert.equal(settled.value.hint.chainKey, 1n);
  assert.equal(settled.value.hint.amount, 101_000n);
  // The settler holds no Creditcoin client at all, which is the structural form of
  // "the operator takes no shortcut".
  assert.equal(Object.keys(settler).sort().join(","), "plan,settle");
});

test("a strategy refusal is passed through rather than reported as a payment", async () => {
  const { strategy } = strategyDouble({
    settle: async () => ({
      ok: false,
      error: { category: "CHAIN", code: "SETTLEMENT_SUBMISSION_FAILED", message: "no", retryable: true },
    }),
  });
  const settler = createProofServiceSettler({ agent: AGENT, reader: readerWith(), strategy });
  const plan = await settler.plan({ serviceId: SERVICE, asset: SEPOLIA_USDC, collectionAddress: COLLECTION });
  const settled = await settler.settle(plan.value, { broadcast: true });
  assert.equal(settled.ok, false);
  assert.equal(settled.error.code, "SETTLEMENT_SUBMISSION_FAILED");
});

test("the reader decodes a CollectionRecord positionally, with the kind after exists", async () => {
  const encoded = COLLECTION_INTERFACE.encodeFunctionResult("collectionFor", [
    [SERVICE, SEPOLIA_USDC.address, 1n, true, COLLECTION_KIND_TAB],
  ]);
  const seen = [];
  const provider = {
    call: async (request) => {
      seen.push(request.blockTag);
      return encoded;
    },
  };
  const reader = createSettlementReader(
    provider,
    { tabBook: `0x${"11".repeat(20)}`, serviceRegistry: `0x${"22".repeat(20)}` },
    "finalized",
  );
  const record = await reader.collection(1n, COLLECTION);
  assert.equal(record.ok, true);
  assert.equal(record.value.serviceId, SERVICE);
  assert.equal(record.value.kind, COLLECTION_KIND_TAB);
  assert.deepEqual(seen, ["finalized"]);
});

test("a failed chain read is upstream and retryable rather than a wrong answer", async () => {
  const provider = {
    call: async () => {
      throw new Error("socket hang up");
    },
  };
  const reader = createSettlementReader(
    provider,
    { tabBook: `0x${"11".repeat(20)}`, serviceRegistry: `0x${"22".repeat(20)}` },
    "finalized",
  );
  const tab = await reader.openTab(AGENT, SERVICE, SEPOLIA_USDC.address);
  assert.equal(tab.ok, false);
  assert.equal(tab.error.code, "CHAIN_READ_FAILED");
  assert.equal(tab.error.retryable, true);
});
