/**
 * The Attestcoin proof hook (R23.5) and the verifier client it reads through.
 *
 * Checked here: a hint matches a `SettlementRecorded` record only when every
 * shared fact agrees; the match is attached to the context and to the proxy
 * result with its Blockscout link; `onVerified` fires once per Settlement;
 * a matched hint is retired from its store; the Asset filter and the per-Agent
 * throttle hold; a verifier failure is a skipped hook and not a failed request;
 * and the `ethers`-backed client decodes a real encoded log through the same
 * event declaration the contract carries.
 *
 * Requirements: 23.5, 24.2
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface } from "ethers";
import { packReplayKey } from "@tabai/shared";
import { TAB_HEADER } from "../dist/http/index.js";
import { addressTopic, eventSignatureFor } from "../dist/payments/index.js";
import { tabPostPaid } from "../dist/server/index.js";
import {
  SETTLEMENT_RECORDED_EVENT,
  SETTLEMENT_RECORDED_TOPIC0,
  blockscoutTxUrl,
  createAttestcoinProofHook,
  createEthersSettlementVerifierClient,
  createFakeSettlementVerifierClient,
  createSettlementHintStore,
  createTabProxy,
  hintMatches,
} from "../dist/proxy/index.js";

const AGENT = "0x00000000000000000000000000000000000000a1";
const OTHER_AGENT = "0x00000000000000000000000000000000000000a2";
const PAYER = "0xa302940db97345c5adaf8da23ff46ae63613d728";
const COLLECTION = "0x952acc70e6f54ce87dca963193a5957bcb27729e";
const SERVICE_ID = `0x${"11".repeat(32)}`;
const TOOL = `0x${"22".repeat(32)}`;
const TAB_ID = `0x${"33".repeat(32)}`;
const USDC_MAINNET = { chainKey: 3n, address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, symbol: "USDC" };
const USDC_SEPOLIA = { chainKey: 1n, address: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238", decimals: 6, symbol: "USDC" };
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const ZERO_WORD = `0x${"00".repeat(32)}`;

/**
 * Renders a `Result` for an assertion message.
 *
 * An assertion message is evaluated eagerly, whether or not the assertion
 * fails, and `JSON.stringify` throws on a `bigint`. Every settlement coordinate
 * here is one, so a bare `JSON.stringify` fails the test it was written to
 * explain. Bigints render with an `n` suffix, so a reader can tell `5n` from a
 * string carrying digits.
 */
const explain = (result) =>
  JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? `${value}n` : value));

function record(overrides = {}) {
  const position = { chainKey: 3n, blockHeight: 25_900_001n, txIndex: 7n, logIndex: 2n, ...overrides.position };
  return {
    replayKey: packReplayKey(position),
    ...position,
    agent: AGENT,
    serviceId: SERVICE_ID,
    asset: USDC_MAINNET.address,
    amount: 5_000_000n,
    payerAddress: PAYER,
    sourceTabId: ZERO_WORD,
    creditcoin: { blockNumber: 5_500_000, txHash: `0x${"cc".repeat(32)}`, logIndex: 0 },
    ...overrides,
  };
}

function transferHint(overrides = {}) {
  return {
    chainKey: 3n,
    sourceTxHash: `0x${"ee".repeat(32)}`,
    expectedEventSignature: eventSignatureFor("direct-transfer"),
    expectedEmitter: USDC_MAINNET.address,
    expectedPayerTopic: addressTopic(PAYER),
    expectedCollectionTopic: addressTopic(COLLECTION),
    asset: USDC_MAINNET,
    amount: 5_000_000n,
    ...overrides,
  };
}

function tabSettledHint(overrides = {}) {
  return {
    ...transferHint({ chainKey: 1n, asset: USDC_SEPOLIA, expectedEventSignature: eventSignatureFor("settlement-contract") }),
    expectedEmitter: "0x10619f16e1ac73aae41aa4c1619f1387687eed79",
    expectedTabIdTopic: TAB_ID,
    ...overrides,
  };
}

function acceptingTabBook() {
  return {
    async recordDelivery(delivery) {
      return { ok: true, value: { charged: 1_000_000n * BigInt(delivery.units), openAfter: 1n, headroomAfter: 1n, recordedAt: 1 } };
    },
    async openTabOf() {
      return { ok: true, value: 0n };
    },
  };
}

function meteringFor(asset = USDC_MAINNET) {
  return tabPostPaid({
    serviceId: SERVICE_ID,
    asset,
    tabBook: acceptingTabBook(),
    priceOf: () => ({ tool: TOOL, units: 1, unitPrice: 1_000_000n }),
    logger: silent,
  });
}

const request = (agent = AGENT) =>
  new Request("https://service.example/v1/thing", { method: "POST", headers: { [TAB_HEADER.agent]: agent } });

const upstream = async () => new Response("ok", { status: 200 });

test("a Transfer hint matches on chainKey, Asset, amount, and payer, and nothing else", () => {
  const rec = record();
  assert.equal(hintMatches(transferHint(), rec), true);
  assert.equal(hintMatches(transferHint({ chainKey: 1n }), rec), false);
  assert.equal(hintMatches(transferHint({ amount: 5_000_001n }), rec), false);
  assert.equal(hintMatches(transferHint({ asset: USDC_SEPOLIA }), rec), false);
  assert.equal(hintMatches(transferHint({ expectedPayerTopic: addressTopic(OTHER_AGENT) }), rec), false);
  // The transaction hash is not matched on: the event does not carry one.
  assert.equal(hintMatches(transferHint({ sourceTxHash: `0x${"ff".repeat(32)}` }), rec), true);
  // A hint that already knows its replay key matches on that alone.
  assert.equal(hintMatches({ ...transferHint({ amount: 1n }), replayKey: rec.replayKey }, rec), true);
  assert.equal(hintMatches({ ...transferHint(), replayKey: `0x${"01".repeat(32)}` }, rec), false);
});

test("a TabSettled hint also requires the tabId", () => {
  const sepolia = record({ position: { chainKey: 1n, blockHeight: 11_600_000n, txIndex: 0n, logIndex: 1n }, asset: USDC_SEPOLIA.address, sourceTabId: TAB_ID });
  assert.equal(hintMatches(tabSettledHint(), sepolia), true);
  assert.equal(hintMatches(tabSettledHint({ expectedTabIdTopic: `0x${"44".repeat(32)}` }), sepolia), false);
});

test("the hook attaches the matched Settlement with its Blockscout link, reports it once, and retires the hint", async () => {
  const store = createSettlementHintStore();
  store.add(AGENT, transferHint());
  const verifier = createFakeSettlementVerifierClient([record()]);
  const verified = [];
  const hook = createAttestcoinProofHook({
    verifier,
    hints: store,
    onVerified: (view) => verified.push(view),
    explorerUrl: "https://creditcoin-testnet.blockscout.com/",
    minRefreshMs: 0,
    logger: silent,
  });
  const proxy = createTabProxy({ upstream: "https://upstream.example", hooks: [hook], metering: meteringFor(), fetchImpl: upstream, logger: silent });

  const first = await proxy.proxy(request());
  assert.equal(first.response.status, 200);
  assert.ok(first.settlement, "the Verified Settlement is attached to the result");
  assert.equal(first.settlement.replayKey, record().replayKey);
  assert.equal(first.settlement.chainKey, 3n);
  assert.equal(first.settlement.blockHeight, 25_900_001n);
  assert.equal(first.settlement.txIndex, 7n);
  assert.equal(first.settlement.logIndex, 2n);
  assert.equal(first.settlement.amount, 5_000_000n);
  assert.equal(first.settlement.blockscoutUrl, `https://creditcoin-testnet.blockscout.com/tx/0x${"cc".repeat(32)}`);
  assert.equal(first.settlement.matchedHint.sourceTxHash, transferHint().sourceTxHash);
  assert.equal(verified.length, 1);
  assert.deepEqual(store.open(AGENT), [], "a matched hint is retired");
  assert.equal(first.state.get("attestcoin-proof").matches.length, 1);
  assert.equal(first.state.get("attestcoin-proof").refreshed, true);

  // With no open hint the verifier is not asked again and nothing is reported twice.
  const second = await proxy.proxy(request());
  assert.equal(second.settlement, undefined);
  assert.equal(verifier.queries.length, 1);
  assert.equal(verified.length, 1);
});

test("the Agent comes from the metered charge, so an unmetered request falls back to Tab-Agent", async () => {
  const store = createSettlementHintStore();
  store.add(AGENT, transferHint());
  const verifier = createFakeSettlementVerifierClient([record()]);
  const hook = createAttestcoinProofHook({ verifier, hints: store, minRefreshMs: 0, logger: silent });
  // A GET is priced by the plugin too, so use a plugin that prices nothing.
  const unpriced = tabPostPaid({ serviceId: SERVICE_ID, asset: USDC_MAINNET, tabBook: acceptingTabBook(), priceOf: () => undefined, logger: silent });
  const proxy = createTabProxy({ upstream: "https://upstream.example", hooks: [hook], metering: unpriced, fetchImpl: upstream, logger: silent });
  const result = await proxy.proxy(request());
  assert.equal(result.charge, undefined);
  assert.ok(result.settlement, "matched off the Tab-Agent claim");
  assert.equal(verifier.queries[0].agent, AGENT);

  // No Agent at all: nothing to look up, nothing asked.
  const anonymous = await proxy.proxy(new Request("https://service.example/v1/thing", { method: "POST" }));
  assert.equal(anonymous.settlement, undefined);
  assert.equal(verifier.queries.length, 1);
});

test("the Asset narrows matching: a hint in another Asset is neither matched nor retired", async () => {
  const store = createSettlementHintStore();
  store.add(AGENT, tabSettledHint());
  const verifier = createFakeSettlementVerifierClient([record()]);
  const hook = createAttestcoinProofHook({ verifier, hints: store, minRefreshMs: 0, logger: silent });
  const proxy = createTabProxy({ upstream: "https://upstream.example", hooks: [hook], metering: meteringFor(USDC_MAINNET), fetchImpl: upstream, logger: silent });
  const result = await proxy.proxy(request());
  assert.equal(result.settlement, undefined);
  assert.equal(verifier.queries.length, 0, "no candidate hint in the charged Asset, so the chain is not asked");
  assert.equal(store.open(AGENT).length, 1);
});

test("verifier reads are throttled per Agent, and a fresh read is taken once the window passes", async () => {
  const store = createSettlementHintStore();
  store.add(AGENT, transferHint());
  store.add(AGENT, transferHint({ amount: 7_000_000n }));
  const verifier = createFakeSettlementVerifierClient([record()]);
  let clock = 1_000;
  const hook = createAttestcoinProofHook({ verifier, hints: store, minRefreshMs: 15_000, now: () => clock, logger: silent });
  const proxy = createTabProxy({ upstream: "https://upstream.example", hooks: [hook], metering: meteringFor(), fetchImpl: upstream, logger: silent });

  await proxy.proxy(request());
  assert.equal(verifier.queries.length, 1);
  assert.equal(store.open(AGENT).length, 1, "the 5 USDC hint matched and retired; the 7 USDC one is open");

  clock += 5_000;
  const throttled = await proxy.proxy(request());
  assert.equal(verifier.queries.length, 1, "inside the window the cached read answers");
  assert.equal(throttled.state.get("attestcoin-proof").refreshed, false);

  verifier.set([record(), record({ position: { chainKey: 3n, blockHeight: 25_900_002n, txIndex: 0n, logIndex: 0n }, amount: 7_000_000n })]);
  clock += 15_000;
  const refreshed = await proxy.proxy(request());
  assert.equal(verifier.queries.length, 2);
  assert.equal(refreshed.settlement.amount, 7_000_000n);
  assert.deepEqual(store.open(AGENT), []);
});

test("a verifier failure is a skipped hook and the delivery still goes out", async () => {
  const store = createSettlementHintStore();
  store.add(AGENT, transferHint());
  const verifier = createFakeSettlementVerifierClient([]);
  verifier.fail({ category: "UPSTREAM", code: "VERIFIER_LOGS_UNREADABLE", message: "rpc down", retryable: true });
  const hook = createAttestcoinProofHook({ verifier, hints: store, minRefreshMs: 0, logger: silent });
  const proxy = createTabProxy({ upstream: "https://upstream.example", hooks: [hook], metering: meteringFor(), fetchImpl: upstream, logger: silent });
  const result = await proxy.proxy(request());
  assert.equal(result.kind, "delivered");
  assert.equal(result.response.status, 200);
  assert.equal(result.hookFailures.length, 1);
  assert.equal(result.hookFailures[0].error.code, "VERIFIER_LOGS_UNREADABLE");
  assert.equal(result.hookFailures[0].critical, false);
  assert.equal(store.open(AGENT).length, 1);
});

test("hints are keyed by Agent, deduplicated, and capped per Agent", () => {
  const store = createSettlementHintStore({ maxPerAgent: 2 });
  store.add(AGENT, transferHint());
  store.add(AGENT, transferHint());
  store.add(AGENT.toUpperCase().replace("0X", "0x"), transferHint({ amount: 1n }));
  store.add(AGENT, transferHint({ amount: 2n }));
  assert.equal(store.open(AGENT).length, 2, "the oldest hint is dropped past the cap");
  assert.deepEqual(store.hintsFor(OTHER_AGENT, undefined), []);
  assert.equal(store.hintsFor(AGENT, USDC_SEPOLIA).length, 0);
  assert.equal(store.remove(AGENT, transferHint({ amount: 2n })), true);
  assert.equal(store.remove(AGENT, transferHint({ amount: 2n })), false);
  store.clear();
  assert.deepEqual(store.open(AGENT), []);
});

test("onVerified is consumer code and cannot fail the request", async () => {
  const store = createSettlementHintStore();
  store.add(AGENT, transferHint());
  const hook = createAttestcoinProofHook({
    verifier: createFakeSettlementVerifierClient([record()]),
    hints: store,
    minRefreshMs: 0,
    logger: silent,
    onVerified: () => {
      throw new Error("consumer bug");
    },
  });
  const proxy = createTabProxy({ upstream: "https://upstream.example", hooks: [hook], metering: meteringFor(), fetchImpl: upstream, logger: silent });
  const result = await proxy.proxy(request());
  assert.equal(result.kind, "delivered");
  assert.ok(result.settlement);
});

test("the ethers-backed client reads SettlementRecorded for the Agent through one filtered getLogs and decodes it", async () => {
  const iface = new Interface([SETTLEMENT_RECORDED_EVENT]);
  const rec = record();
  const encoded = iface.encodeEventLog("SettlementRecorded", [
    rec.replayKey, rec.chainKey, rec.blockHeight, rec.txIndex, rec.logIndex,
    rec.agent, rec.serviceId, rec.asset, rec.amount, rec.payerAddress, rec.sourceTabId,
  ]);
  const filters = [];
  const provider = {
    async getBlockNumber() {
      return 5_500_100;
    },
    async getLogs(filter) {
      filters.push(filter);
      return [{ topics: encoded.topics, data: encoded.data, blockNumber: 5_500_000, transactionHash: `0x${"cc".repeat(32)}`, index: 0 }];
    },
  };
  const client = createEthersSettlementVerifierClient({ provider, address: "0xc5c83782f315b321Cd8e18B4C2e05df4050C3854", lookbackBlocks: 100, floorBlock: 5_407_360 });
  const read = await client.recordedSettlements({ agent: AGENT });
  assert.ok(read.ok, explain(read));
  assert.equal(read.value.length, 1);
  assert.deepEqual(read.value[0], rec);
  assert.equal(filters[0].address, "0xc5c83782f315b321Cd8e18B4C2e05df4050C3854");
  assert.deepEqual(filters[0].topics, [SETTLEMENT_RECORDED_TOPIC0, null, addressTopic(AGENT)]);
  assert.equal(filters[0].fromBlock, 5_500_000, "head minus the lookback");
  assert.equal(filters[0].toBlock, "finalized");
  assert.equal(client.id, "ethers:0xc5c83782f315b321cd8e18b4c2e05df4050c3854");

  // An explicit fromBlock below the floor is lifted to the floor.
  await client.recordedSettlements({ agent: AGENT, fromBlock: 1 });
  assert.equal(filters[1].fromBlock, 5_407_360);
});

test("the ethers-backed client reports a failing provider and a bad address without throwing", async () => {
  const failing = {
    async getBlockNumber() {
      throw new Error("rpc down");
    },
    async getLogs() {
      return [];
    },
  };
  const client = createEthersSettlementVerifierClient({ provider: failing, address: "0xc5c83782f315b321Cd8e18B4C2e05df4050C3854" });
  const read = await client.recordedSettlements({ agent: AGENT });
  assert.equal(read.ok, false);
  assert.equal(read.error.code, "VERIFIER_HEAD_UNREADABLE");
  assert.equal(read.error.retryable, true);

  const badAddress = createEthersSettlementVerifierClient({ provider: failing, address: "0x1234" });
  assert.equal((await badAddress.recordedSettlements({ agent: AGENT })).error.code, "VERIFIER_ADDRESS_INVALID");
  assert.equal((await client.recordedSettlements({ agent: "nope" })).error.code, "AGENT_INVALID");

  const undecodable = {
    async getBlockNumber() {
      return 10;
    },
    async getLogs() {
      return [{ topics: [SETTLEMENT_RECORDED_TOPIC0], data: "0x", blockNumber: 5, transactionHash: `0x${"00".repeat(32)}`, index: 0 }];
    },
  };
  const drifted = createEthersSettlementVerifierClient({ provider: undecodable, address: "0xc5c83782f315b321Cd8e18B4C2e05df4050C3854" });
  assert.equal((await drifted.recordedSettlements({ agent: AGENT })).error.code, "SETTLEMENT_RECORDED_UNDECODABLE");
});

test("the Blockscout link is the transaction page under the explorer base", () => {
  assert.equal(blockscoutTxUrl(`0x${"ab".repeat(32)}`, "https://explorer.example/"), `https://explorer.example/tx/0x${"ab".repeat(32)}`);
  assert.match(blockscoutTxUrl(`0x${"ab".repeat(32)}`), /^https:\/\/creditcoin-testnet\.blockscout\.com\/tx\/0x/);
});
