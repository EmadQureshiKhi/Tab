/**
 * Observation: target resolution, log decoding, and gap catch-up.
 *
 * The registry reader and the log reader are stand-ins, because the questions here
 * are about what the Watcher *decides* — which addresses it will read, which logs it
 * accepts, how it narrows a window an endpoint refuses — and a live chain cannot be
 * asked to refuse a range on demand. The live reads that confirm the registry ABI and
 * the endpoint behaviour are in `pnpm --filter @tabai/watcher observe`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  dropSupersededTransfers,
  addressTopic,
  chunkFor,
  describeTargets,
  growWindow,
  isRangeRejection,
  loadWatcherConfig,
  logFilterFor,
  observationFrom,
  receiptOrdinalOf,
  planCatchUp,
  resolveWatchTargets,
  scanChain,
  shrinkWindow,
} from "../dist/index.js";

const USDC_MAINNET = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_SEPOLIA = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const SETTLEMENT_SEPOLIA = "0x10619f16e1ac73aae41aa4c1619f1387687eed79";
const TAB_COLLECTION = "0x952acc70e6f54ce87dca963193a5957bcb27729e";
const BOND_COLLECTION = "0x9d6ad64ae2d000873ffdfc757808f24cf9cf67fc";
const SERVICE_ID = `0x${"7461622e70726f6f662d73657276696365".padEnd(64, "0")}`;
const AGENT = "0xb67c73fd513adf5d270d1102f04eb8327f218fe7";

const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function configWith(overrides = {}) {
  const result = loadWatcherConfig({
    ETHEREUM_SEPOLIA_RPC_URLS: "https://first.example,https://second.example",
    ETHEREUM_MAINNET_RPC_URLS: "https://first.example,https://second.example",
    SERVICE_REGISTRY_ADDRESS: "0xF6Bb0d068698e504e2F21ca61c48167634a1fcAC",
    TAB_BOOK_ADDRESS: "0x7974db23B02bA3c109994cc9337c1dBd900AC5Ba",
    MAINNET_USDC_ADDRESS: USDC_MAINNET,
    SEPOLIA_USDC_ADDRESS: USDC_SEPOLIA,
    SEPOLIA_SETTLEMENT_ADDRESS: SETTLEMENT_SEPOLIA,
    PROOF_SERVICE_COLLECTION_ADDRESS: TAB_COLLECTION,
    ...overrides,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  return result.value;
}

/** A registry that answers from two tables, mirroring the deployed registration. */
function registryOf(emitters, collections) {
  return {
    async emitterFor(chainKey, emitter) {
      const entry = emitters[`${chainKey}:${emitter.toLowerCase()}`];
      if (entry?.error !== undefined) return { ok: false, error: entry.error };
      return {
        ok: true,
        value: entry ?? { kind: "ASSET", asset: "0x" + "00".repeat(20), authorised: false },
      };
    },
    async collectionFor(chainKey, collection) {
      const entry = collections[`${chainKey}:${collection.toLowerCase()}`];
      if (entry?.error !== undefined) return { ok: false, error: entry.error };
      return {
        ok: true,
        value:
          entry ?? {
            serviceId: `0x${"00".repeat(32)}`,
            asset: `0x${"00".repeat(20)}`,
            chainKey: BigInt(chainKey),
            exists: false,
            kind: "TAB",
          },
      };
    },
  };
}

const assetEmitter = (asset) => ({ kind: "ASSET", asset, authorised: true });
const contractEmitter = (asset) => ({ kind: "SETTLEMENT_CONTRACT", asset, authorised: true });
const tabCollection = (chainKey, asset) => ({
  serviceId: SERVICE_ID,
  asset,
  chainKey: BigInt(chainKey),
  exists: true,
  kind: "TAB",
});

test("an authorised Asset emitter and a registered collection resolve to one Transfer target", async () => {
  const resolution = await resolveWatchTargets(
    registryOf(
      { ["3:" + USDC_MAINNET]: assetEmitter(USDC_MAINNET) },
      { ["3:" + TAB_COLLECTION]: tabCollection(3, USDC_MAINNET) },
    ),
    configWith(),
    [3],
  );
  assert.equal(resolution.ok, true);
  assert.equal(resolution.value.targets.length, 1);
  const [target] = resolution.value.targets;
  assert.equal(target.eventName, "Transfer");
  assert.equal(target.topic0, TRANSFER_TOPIC0);
  assert.equal(target.emitter, USDC_MAINNET);
  assert.equal(target.collection, TAB_COLLECTION);
  assert.equal(target.collectionKind, "TAB");
  assert.equal(target.serviceId, SERVICE_ID);
  assert.equal(resolution.value.unresolved.length, 0);
});

test("the settlement contract resolves to a TabSettled target, and the Asset is not the emitter", async () => {
  const resolution = await resolveWatchTargets(
    registryOf(
      { ["1:" + SETTLEMENT_SEPOLIA]: contractEmitter(USDC_SEPOLIA) },
      { ["1:" + TAB_COLLECTION]: tabCollection(1, USDC_SEPOLIA) },
    ),
    configWith({ SEPOLIA_USDC_ADDRESS: "" }),
    [1],
  );
  assert.equal(resolution.ok, true);
  const [target] = resolution.value.targets;
  assert.equal(target.eventName, "TabSettled");
  assert.equal(target.emitter, SETTLEMENT_SEPOLIA);
  assert.notEqual(target.asset, target.emitter);
  assert.equal(target.asset, USDC_SEPOLIA);
});

test("configuration cannot widen the watched set: an unauthorised emitter is named, not watched", async () => {
  const resolution = await resolveWatchTargets(
    registryOf({}, { ["3:" + TAB_COLLECTION]: tabCollection(3, USDC_MAINNET) }),
    configWith(),
    [3],
  );
  assert.equal(resolution.ok, true);
  assert.equal(resolution.value.targets.length, 0);
  const reasons = resolution.value.unresolved.map((entry) => entry.reason);
  assert.ok(reasons.includes("EMITTER_NOT_AUTHORISED"));
  const named = resolution.value.unresolved.find((entry) => entry.reason === "EMITTER_NOT_AUTHORISED");
  assert.equal(named.source, "MAINNET_USDC_ADDRESS");
  assert.match(describeTargets(resolution.value), /watching nothing/);
});

test("EmitterKind counts from None, so kind 1 is an Asset and kind 2 is a settlement contract", async () => {
  // The ordinals the deployed registry actually returns. A two-entry table starting
  // at Asset reads both of these one place out, and both mistakes are silent: the
  // wrong topic matches nothing.
  const byOrdinal = ["NONE", "ASSET", "SETTLEMENT_CONTRACT"];
  assert.equal(byOrdinal[1], "ASSET");
  assert.equal(byOrdinal[2], "SETTLEMENT_CONTRACT");

  const resolution = await resolveWatchTargets(
    registryOf(
      { ["1:" + USDC_SEPOLIA]: { kind: byOrdinal[1], asset: USDC_SEPOLIA, authorised: true } },
      { ["1:" + TAB_COLLECTION]: tabCollection(1, USDC_SEPOLIA) },
    ),
    configWith({ SEPOLIA_SETTLEMENT_ADDRESS: "" }),
    [1],
  );
  assert.equal(resolution.value.targets[0].eventName, "Transfer");
});

test("an emitter authorised with kind None names no event, so it is not watched", async () => {
  const resolution = await resolveWatchTargets(
    registryOf(
      { ["3:" + USDC_MAINNET]: { kind: "NONE", asset: USDC_MAINNET, authorised: true } },
      { ["3:" + TAB_COLLECTION]: tabCollection(3, USDC_MAINNET) },
    ),
    configWith(),
    [3],
  );
  assert.equal(resolution.value.targets.length, 0);
  assert.equal(resolution.value.unresolved[0].reason, "EMITTER_KIND_NONE");
});

test("an unregistered Collection Address is reported rather than watched", async () => {
  const resolution = await resolveWatchTargets(
    registryOf({ ["3:" + USDC_MAINNET]: assetEmitter(USDC_MAINNET) }, {}),
    configWith(),
    [3],
  );
  assert.equal(resolution.ok, true);
  assert.equal(resolution.value.targets.length, 0);
  assert.equal(resolution.value.unresolved[0].reason, "COLLECTION_NOT_REGISTERED");
});

test("an emitter and a collection denominating different Assets never pair", async () => {
  const resolution = await resolveWatchTargets(
    registryOf(
      { ["3:" + USDC_MAINNET]: assetEmitter(USDC_MAINNET) },
      { ["3:" + TAB_COLLECTION]: tabCollection(3, USDC_SEPOLIA) },
    ),
    configWith(),
    [3],
  );
  assert.equal(resolution.ok, true);
  assert.equal(resolution.value.targets.length, 0);
  assert.equal(resolution.value.unresolved[0].reason, "ASSET_DISAGREEMENT");
});

test("a Bond Collection Address is watched, and carries the kind that keeps it out of clearing", async () => {
  const resolution = await resolveWatchTargets(
    registryOf(
      { ["3:" + USDC_MAINNET]: assetEmitter(USDC_MAINNET) },
      {
        ["3:" + BOND_COLLECTION]: {
          serviceId: SERVICE_ID,
          asset: USDC_MAINNET,
          chainKey: 3n,
          exists: true,
          kind: "BOND",
        },
      },
    ),
    configWith({ PROOF_SERVICE_COLLECTION_ADDRESS: "", BOND_COLLECTION_ADDRESS: BOND_COLLECTION }),
    [3],
  );
  assert.equal(resolution.ok, true);
  assert.equal(resolution.value.targets.length, 1);
  assert.equal(resolution.value.targets[0].collectionKind, "BOND");
});

test("a record answering for another chainKey is refused", async () => {
  const resolution = await resolveWatchTargets(
    registryOf(
      { ["3:" + USDC_MAINNET]: assetEmitter(USDC_MAINNET) },
      { ["3:" + TAB_COLLECTION]: { ...tabCollection(3, USDC_MAINNET), chainKey: 1n } },
    ),
    configWith(),
    [3],
  );
  assert.equal(resolution.ok, true);
  assert.equal(resolution.value.unresolved[0].reason, "COLLECTION_CHAIN_KEY_MISMATCH");
});

test("one unreadable registry read costs its own candidate and nothing else", async () => {
  const unreadable = { error: { category: "UPSTREAM", code: "X", message: "timeout", retryable: true } };
  const resolution = await resolveWatchTargets(
    registryOf(
      { ["3:" + USDC_MAINNET]: assetEmitter(USDC_MAINNET), ["1:" + USDC_SEPOLIA]: unreadable },
      {
        ["3:" + TAB_COLLECTION]: tabCollection(3, USDC_MAINNET),
        ["1:" + TAB_COLLECTION]: tabCollection(1, USDC_SEPOLIA),
      },
    ),
    configWith({ SEPOLIA_SETTLEMENT_ADDRESS: "" }),
    [1, 3],
  );
  assert.equal(resolution.ok, true);
  assert.deepEqual(
    resolution.value.targets.map((target) => target.chainKey),
    [3],
  );
  assert.equal(resolution.value.unresolved.some((entry) => entry.reason === "EMITTER_UNREADABLE"), true);
});

// ---------------------------------------------------------------- decoding

const TARGET = {
  chainKey: 3,
  emitter: USDC_MAINNET,
  emitterKind: "ASSET",
  eventName: "Transfer",
  topic0: TRANSFER_TOPIC0,
  collection: TAB_COLLECTION,
  collectionTopic: addressTopic(TAB_COLLECTION),
  collectionKind: "TAB",
  asset: USDC_MAINNET,
  serviceId: SERVICE_ID,
};

const word = (value) => `0x${value.toString(16).padStart(64, "0")}`;

function logOf(overrides = {}) {
  return {
    address: USDC_MAINNET,
    topics: [TRANSFER_TOPIC0, addressTopic(AGENT), addressTopic(TAB_COLLECTION)],
    data: word(2_500_000n),
    blockNumber: 25913707,
    blockHash: `0x${"7b".repeat(32)}`,
    transactionHash: `0x${"aa".repeat(32)}`,
    transactionIndex: 42,
    index: 7,
    ...overrides,
  };
}

test("the filter matches topics[0] and topics[2], and leaves the payer position open", () => {
  const filter = logFilterFor(TARGET);
  assert.equal(filter.address, USDC_MAINNET);
  assert.equal(filter.topics.length, 3);
  assert.equal(filter.topics[0], TRANSFER_TOPIC0);
  assert.equal(filter.topics[1], null);
  assert.equal(filter.topics[2], addressTopic(TAB_COLLECTION));
});

test("a Transfer decodes with the payer from topics[1] and the amount from data", () => {
  const observation = observationFrom(TARGET, logOf(), 0);
  assert.equal(observation.ok, true);
  assert.equal(observation.value.payer, AGENT);
  assert.equal(observation.value.amount, 2_500_000n);
  assert.equal(observation.value.collection, TAB_COLLECTION);
  assert.equal(observation.value.asset, USDC_MAINNET);
  assert.equal(observation.value.blockDigest, `0x${"7b".repeat(32)}`);
  assert.equal(observation.value.observedTxIndex, 42n);
  // The replay key's ordinal is the receipt one, and the block-wide index the RPC
  // reported is kept beside it as provenance.
  assert.equal(observation.value.logIndex, 0n);
  assert.equal(observation.value.blockLogIndex, 7n);
});

test("the replay key packs chainKey, height, the observed transaction index, and the log index", () => {
  const observation = observationFrom(TARGET, logOf(), 0);
  assert.equal(observation.ok, true);
  const key = observation.value.replayKey;
  assert.equal(key.length, 66);
  assert.equal(key.slice(0, 18), "0x0000000000000003");
  assert.equal(BigInt("0x" + key.slice(18, 34)), 25913707n);
  assert.equal(BigInt("0x" + key.slice(34, 50)), 42n);
  assert.equal(BigInt("0x" + key.slice(50, 66)), 0n);
});

test("the replay key packs the receipt ordinal, never the block-wide log index", () => {
  // Measured, and the reason this distinction is pinned. `TabAscBase` sweeps
  // `receipt.receiptLogs` and uses the loop counter as the replay key's log index,
  // so a Watcher packing the block-wide index mints a key the chain never agrees
  // with: the Provisional Clearing is opened under an identity no Verified
  // Settlement can match, the clearing expires, and the Service's Bond is slashed
  // for a Settlement that did in fact verify. The live binding Settlement carried
  // block-wide indexes 3177 and 3178 for receipt ordinals 0 and 1, and a
  // submission for a transaction recorded at block-wide 3195 was refused
  // `AlreadyClaimed` naming ordinal 0.
  const observation = observationFrom(TARGET, logOf({ index: 3177 }), 0);
  assert.equal(observation.ok, true);
  assert.equal(observation.value.logIndex, 0n);
  assert.equal(observation.value.blockLogIndex, 3177n);
  assert.equal(BigInt("0x" + observation.value.replayKey.slice(50, 66)), 0n);
});

test("a log the receipt does not contain is refused rather than keyed on a guess", () => {
  // `receiptOrdinalOf` answers -1 when the two reads disagree, and a negative
  // ordinal cannot be packed. Refusing is the only honest answer: any substitute
  // produces an identity the chain will not recognise.
  const observation = observationFrom(TARGET, logOf(), receiptOrdinalOf([1, 2, 3], 99));
  assert.equal(observation.ok, false);
  assert.equal(observation.error.code, "MALFORMED_SETTLEMENT_LOG");
  assert.match(observation.error.message, /ordinal within its own receipt/);
});

test("the ordinal is resolved from the receipt's own log positions", () => {
  assert.equal(receiptOrdinalOf([3177, 3178], 3177), 0);
  assert.equal(receiptOrdinalOf([3177, 3178], 3178), 1);
  assert.equal(receiptOrdinalOf([3177, 3178], 3179), -1);
});

test("one receipt read serves every matching log of one transaction", async () => {
  // Two Settlements in one transaction is the live shape, and asking for the same
  // receipt twice is a round trip spent on nothing.
  let reads = 0;
  const receipts = {
    async blockLogIndexes() {
      reads += 1;
      return { ok: true, value: [7, 8] };
    },
  };
  const scan = await scanChain({
    chainKey: 3,
    targets: [TARGET],
    lastProcessedBlock: 1000n,
    head: 1001n,
    window: { max: 10, min: 1 },
    reader: {
      async logs() {
        return { ok: true, value: [logOf({ index: 7 }), logOf({ index: 8 })] };
      },
    },
    receipts,
    commit: async () => ({ ok: true, value: 2 }),
  });
  assert.equal(scan.ok, true);
  assert.equal(reads, 1, "one receipt, however many of its logs matched");
});

test("a receipt that cannot be read skips the log rather than keying it wrongly", async () => {
  const scan = await scanChain({
    chainKey: 3,
    targets: [TARGET],
    lastProcessedBlock: 1000n,
    head: 1001n,
    window: { max: 10, min: 1 },
    reader: {
      async logs() {
        return { ok: true, value: [logOf()] };
      },
    },
    receipts: {
      async blockLogIndexes() {
        return {
          ok: false,
          error: { category: "UPSTREAM", code: "RECEIPT_READ_FAILED", message: "no", retryable: true },
        };
      },
    },
    commit: async (result) => ({ ok: true, value: result.observations.length }),
  });
  assert.equal(scan.ok, true);
  assert.equal(scan.value.observationsPersisted, 0);
  assert.equal(scan.value.malformedSkipped, 1);
});

test("two logs in one transaction take different identities", () => {
  const first = observationFrom(TARGET, logOf({ index: 7 }), 0);
  const second = observationFrom(TARGET, logOf({ index: 8 }), 1);
  assert.notEqual(first.value.replayKey, second.value.replayKey);
});

test("a log whose topics[2] is not the Collection Address is refused, filter or no filter", () => {
  const observation = observationFrom(
    TARGET,
    logOf({ topics: [TRANSFER_TOPIC0, addressTopic(AGENT), addressTopic(BOND_COLLECTION)] }),
    0,
  );
  assert.equal(observation.ok, false);
  assert.equal(observation.error.code, "MALFORMED_SETTLEMENT_LOG");
  assert.match(observation.error.message, /not the Collection Address/);
});

test("a zero-topic log is skipped rather than thrown on", () => {
  const observation = observationFrom(TARGET, logOf({ topics: [] }), 0);
  assert.equal(observation.ok, false);
  assert.equal(observation.error.code, "MALFORMED_SETTLEMENT_LOG");
});

test("a short amount word is refused rather than padded", () => {
  const observation = observationFrom(TARGET, logOf({ data: "0x01" }), 0);
  assert.equal(observation.ok, false);
  assert.match(observation.error.message, /amount word/);
});

test("a log from another contract is refused even if it carries the right topics", () => {
  const observation = observationFrom(TARGET, logOf({ address: USDC_SEPOLIA }), 0);
  assert.equal(observation.ok, false);
  assert.match(observation.error.message, /rather than the target emitter/);
});

test("a zero-value Transfer is a legal log and is observed, not discarded", () => {
  const observation = observationFrom(TARGET, logOf({ data: word(0n) }), 0);
  assert.equal(observation.ok, true);
  assert.equal(observation.value.amount, 0n);
});

test("TabSettled carries four topics, and three is refused", () => {
  const target = {
    ...TARGET,
    chainKey: 1,
    emitter: SETTLEMENT_SEPOLIA,
    emitterKind: "SETTLEMENT_CONTRACT",
    eventName: "TabSettled",
    topic0: "0x" + "00".repeat(32),
    asset: USDC_SEPOLIA,
  };
  const tabSettledTopic0 = logFilterFor(target).topics[0];
  const three = observationFrom(
    target,
    {
      ...logOf(),
      address: SETTLEMENT_SEPOLIA,
      topics: [tabSettledTopic0, addressTopic(AGENT), addressTopic(TAB_COLLECTION)],
    },
    0,
  );
  assert.equal(three.ok, false);
  assert.match(three.error.message, /carries 4 topics/);
});

// ---------------------------------------------------------------- catch-up

test("the catch-up plan covers the gap in 2000-block chunks by default", () => {
  const config = configWith();
  assert.equal(config.logChunk.max, 2000);
  const chunks = planCatchUp(1000n, 5500n, config.logChunk.max);
  assert.deepEqual(chunks, [
    { from: 1001n, to: 3000n },
    { from: 3001n, to: 5000n },
    { from: 5001n, to: 5500n },
  ]);
});

test("a cursor already at the head plans nothing, and the cursor block is not re-read", () => {
  assert.deepEqual(planCatchUp(5500n, 5500n, 2000), []);
  assert.deepEqual(chunkFor(5501n, 5500n, 2000), undefined);
  assert.deepEqual(chunkFor(5500n, 5500n, 2000), { from: 5500n, to: 5500n });
});

test("the window halves on refusal, never below the floor, and doubles back up to the ceiling", () => {
  assert.equal(shrinkWindow(2000, 1), 1000);
  assert.equal(shrinkWindow(1, 1), 1);
  assert.equal(shrinkWindow(50, 40), 40);
  assert.equal(growWindow(1000, 2000), 2000);
  assert.equal(growWindow(2000, 2000), 2000);
});

test("the measured refusals are recognised, and an unrelated fault is not", () => {
  // The three the configured Mainnet endpoints actually answer with. None of them
  // agrees with another about what kind of error a too-wide window is.
  assert.equal(
    isRangeRejection(
      new Error(
        'server response 400 Bad Request (info={ "responseBody": "{\\"error\\":{\\"message\\":\\"Can\'t route your request to suitable provider, if you specified certain providers revise the list\\"}}" })',
      ),
    ),
    true,
    "drpc refuses 250 blocks as a routing failure",
  );
  assert.equal(
    isRangeRejection(new Error("Archive requests require a personal token. Get one at: https://example")),
    true,
    "publicnode refuses 125 blocks as an archive-access problem",
  );
  assert.equal(
    isRangeRejection(new Error("You can make eth_getLogs requests with up to a 10 block range")),
    true,
    "blastapi refuses 50 blocks and states the cap",
  );
  assert.equal(isRangeRejection(new Error("eth_getLogs is limited to 0 - 50 blocks range")), true);
  assert.equal(isRangeRejection(new Error("query returned more than 10000 results")), true);
  assert.equal(isRangeRejection(new Error("nonce too low")), false);
  assert.equal(isRangeRejection(new Error("connect ETIMEDOUT")), false);
  assert.equal(isRangeRejection(new Error("invalid numeric value")), false);
});

/** A log reader that refuses anything wider than `cap` blocks. */
function cappedReader(cap, logsByBlock = {}) {
  const requests = [];
  return {
    requests,
    async logs(filter, from, to) {
      requests.push({ from, to, width: Number(to - from) + 1 });
      if (Number(to - from) + 1 > cap) {
        return {
          ok: false,
          error: {
            category: "UPSTREAM",
            code: "GET_LOGS_RANGE_REFUSED",
            message: `limited to 0 - ${cap} blocks range`,
            retryable: true,
          },
        };
      }
      const logs = [];
      for (let block = from; block <= to; block += 1n) {
        const entry = logsByBlock[String(block)];
        if (entry !== undefined) logs.push(entry);
      }
      return { ok: true, value: logs };
    },
  };
}

/**
 * A receipt reader over the fake chain. Every log the fake serves is the only log
 * of its transaction unless `byTx` says otherwise, so the default ordinal is 0,
 * which is what a one-log Settlement really has.
 */
function receiptsOf(byTx = {}) {
  return {
    async blockLogIndexes(txHash) {
      return { ok: true, value: byTx[txHash] ?? [7] };
    },
  };
}

test("a scan narrows to what the endpoint serves and still covers the whole gap", async () => {
  const reader = cappedReader(50);
  const committed = [];
  const scan = await scanChain({
    chainKey: 3,
    targets: [TARGET],
    lastProcessedBlock: 1000n,
    head: 1100n,
    window: { max: 2000, min: 1 },
    reader,
    receipts: receiptsOf(),
    commit: async (result) => {
      committed.push(result.chunk);
      return { ok: true, value: result.observations.length };
    },
  });
  assert.equal(scan.ok, true);
  assert.equal(scan.value.lastProcessedBlock, 1100n);
  assert.equal(scan.value.rangeRejections > 0, true);
  // Every committed chunk is within the cap, and together they cover 1001..1100
  // with no gap and no overlap.
  assert.equal(committed[0].from, 1001n);
  assert.equal(committed[committed.length - 1].to, 1100n);
  for (const [position, chunk] of committed.entries()) {
    assert.ok(Number(chunk.to - chunk.from) + 1 <= 50);
    if (position > 0) assert.equal(chunk.from, committed[position - 1].to + 1n);
  }
});

test("a refusal at the floor stops the scan instead of narrowing forever", async () => {
  const scan = await scanChain({
    chainKey: 3,
    targets: [TARGET],
    lastProcessedBlock: 0n,
    head: 10n,
    window: { max: 4, min: 4 },
    reader: cappedReader(1),
    receipts: receiptsOf(),
    commit: async () => ({ ok: true, value: 0 }),
  });
  assert.equal(scan.ok, true);
  assert.equal(scan.value.lastProcessedBlock, 0n);
  assert.equal(scan.value.stopped.code, "GET_LOGS_RANGE_REFUSED_AT_FLOOR");
});

test("a failed commit leaves the cursor where it was, so no block is skipped", async () => {
  const scan = await scanChain({
    chainKey: 3,
    targets: [TARGET],
    lastProcessedBlock: 1000n,
    head: 1010n,
    window: { max: 5, min: 1 },
    reader: cappedReader(1000),
    receipts: receiptsOf(),
    commit: async () => ({
      ok: false,
      error: { category: "UPSTREAM", code: "OBSERVATION_PERSIST_FAILED", message: "down", retryable: true },
    }),
  });
  assert.equal(scan.ok, true);
  assert.equal(scan.value.lastProcessedBlock, 1000n);
  assert.equal(scan.value.chunksCommitted, 0);
  assert.equal(scan.value.stopped.code, "OBSERVATION_PERSIST_FAILED");
});

test("a scan decodes what it finds, skips what it cannot, and reports both", async () => {
  const good = logOf({ blockNumber: 1002 });
  const bad = logOf({ blockNumber: 1003, data: "0x01" });
  const reader = cappedReader(1000, { 1002: good, 1003: bad });
  let persisted = 0;
  const scan = await scanChain({
    chainKey: 3,
    targets: [TARGET],
    lastProcessedBlock: 1000n,
    head: 1005n,
    window: { max: 10, min: 1 },
    reader,
    receipts: receiptsOf(),
    commit: async (result) => {
      persisted += result.observations.length;
      return { ok: true, value: result.observations.length };
    },
  });
  assert.equal(scan.ok, true);
  assert.equal(scan.value.logsSeen, 2);
  assert.equal(scan.value.observationsPersisted, 1);
  assert.equal(scan.value.malformedSkipped, 1);
  assert.equal(persisted, 1);
  assert.equal(scan.value.stopped, undefined);
});

test("a target on another chain is not read during this chain's scan", async () => {
  const reader = cappedReader(1000);
  const scan = await scanChain({
    chainKey: 1,
    targets: [TARGET],
    lastProcessedBlock: 0n,
    head: 10n,
    window: { max: 10, min: 1 },
    reader,
    receipts: receiptsOf(),
    commit: async () => ({ ok: true, value: 0 }),
  });
  assert.equal(scan.ok, true);
  assert.equal(reader.requests.length, 0);
  assert.equal(scan.value.lastProcessedBlock, 10n);
});

// ---------------------------------------------------------------- endpoint rotation
//
// The scan's second answer to a refusal (R20.11). Narrowing handles "too wide";
// these cover the two failures narrowing cannot fix, a refusal still standing at the
// one-block floor and a failure that was never about width at all.

/** A reader that refuses everything, standing in for an endpoint that stopped serving. */
function deadReader(code = "GET_LOGS_RANGE_REFUSED", message = "Can't route your request to suitable provider") {
  const requests = [];
  return {
    requests,
    async logs(_filter, from, to) {
      requests.push({ from, to });
      return { ok: false, error: { category: "UPSTREAM", code, message, retryable: true } };
    },
  };
}

/** Builds a `rotate` that hands out the given readers in order, then reports exhaustion. */
function rotationOf(readers) {
  const moves = [];
  let index = 0;
  return {
    moves,
    rotate: async () => {
      if (index >= readers.length) return undefined;
      const next = readers[index];
      index += 1;
      moves.push(index);
      return { reader: next, receipts: receiptsOf() };
    },
  };
}

test("a refusal at the one-block floor rotates to the next endpoint instead of stopping", async () => {
  // The first endpoint refuses everything down to one block, which is exactly the
  // measured drpc behaviour: the same routing message for a wide range and for a
  // single block. The second serves the whole gap.
  const good = cappedReader(1000);
  const { rotate, moves } = rotationOf([good]);
  const scan = await scanChain({
    chainKey: 3,
    targets: [TARGET],
    lastProcessedBlock: 1000n,
    head: 1010n,
    window: { max: 4, min: 1 },
    reader: deadReader(),
    receipts: receiptsOf(),
    rotate,
    endpointCount: 2,
    commit: async () => ({ ok: true, value: 0 }),
  });
  assert.equal(scan.ok, true);
  assert.equal(scan.value.stopped, undefined, "the scan reached the head");
  assert.equal(scan.value.lastProcessedBlock, 1010n);
  assert.equal(scan.value.rotations, 1);
  assert.deepEqual(moves, [1]);
  // The window is reset on rotation, because the new endpoint's limits are its own
  // and inheriting a floor narrowed for a different endpoint would be wrong.
  assert.equal(scan.value.windowSizes[0], 4);
});

test("a failure that was never a width refusal respects the threshold before moving on", async () => {
  const good = cappedReader(1000);
  const { rotate } = rotationOf([good]);
  const dead = deadReader("GET_LOGS_FAILED", "socket hang up");
  let notes = 0;
  const scan = await scanChain({
    chainKey: 3,
    targets: [TARGET],
    lastProcessedBlock: 1000n,
    head: 1002n,
    window: { max: 8, min: 1 },
    reader: dead,
    receipts: receiptsOf(),
    rotate,
    endpointCount: 2,
    // R20.11: three consecutive failures before the endpoint is abandoned.
    onFailure: async () => {
      notes += 1;
      return notes >= 3;
    },
    commit: async () => ({ ok: true, value: 0 }),
  });
  assert.equal(scan.ok, true);
  assert.equal(scan.value.stopped, undefined);
  assert.equal(notes, 3, "the threshold was counted rather than jumped");
  assert.equal(dead.requests.length, 3, "the same endpoint was retried until the threshold");
  assert.equal(scan.value.rotations, 1);
});

test("a full cycle of endpoints without progress ends the scan by name", async () => {
  // Every endpoint refuses, so the rotation wraps forever unless the cycle is bounded.
  const { rotate } = rotationOf([deadReader(), deadReader(), deadReader()]);
  const scan = await scanChain({
    chainKey: 3,
    targets: [TARGET],
    lastProcessedBlock: 1000n,
    head: 1010n,
    window: { max: 2, min: 1 },
    reader: deadReader(),
    receipts: receiptsOf(),
    rotate,
    endpointCount: 3,
    commit: async () => ({ ok: true, value: 0 }),
  });
  assert.equal(scan.ok, true);
  assert.equal(scan.value.stopped.code, "ALL_ENDPOINTS_REFUSED");
  assert.match(scan.value.stopped.message, /all 3 configured endpoints/);
  assert.equal(scan.value.lastProcessedBlock, 1000n, "no cursor moved");
  assert.equal(scan.value.rotations, 3);
});

test("a committed chunk earns the endpoint set a fresh cycle", async () => {
  // Serves the first chunk, then dies. Without resetting the no-progress count on a
  // commit, a long scan would exhaust its cycle budget on unrelated hiccups.
  let served = 0;
  const flaky = {
    async logs(_filter, from, to) {
      served += 1;
      if (served === 1) return { ok: true, value: [] };
      return {
        ok: false,
        error: { category: "UPSTREAM", code: "GET_LOGS_RANGE_REFUSED", message: "no", retryable: true },
      };
    },
  };
  const { rotate } = rotationOf([cappedReader(1000)]);
  const scan = await scanChain({
    chainKey: 3,
    targets: [TARGET],
    lastProcessedBlock: 1000n,
    head: 1004n,
    window: { max: 2, min: 1 },
    reader: flaky,
    receipts: receiptsOf(),
    rotate,
    endpointCount: 2,
    commit: async () => ({ ok: true, value: 0 }),
  });
  assert.equal(scan.ok, true);
  assert.equal(scan.value.stopped, undefined);
  assert.equal(scan.value.chunksCommitted > 1, true);
});

test("with no rotation wired the floor still ends the scan, exactly as before", async () => {
  const scan = await scanChain({
    chainKey: 3,
    targets: [TARGET],
    lastProcessedBlock: 0n,
    head: 10n,
    window: { max: 4, min: 4 },
    reader: cappedReader(1),
    receipts: receiptsOf(),
    commit: async () => ({ ok: true, value: 0 }),
  });
  assert.equal(scan.ok, true);
  assert.equal(scan.value.stopped.code, "GET_LOGS_RANGE_REFUSED_AT_FLOOR");
  assert.equal(scan.value.rotations, 0);
});

test("a single configured endpoint has nowhere to move, and says so rather than looping", async () => {
  const scan = await scanChain({
    chainKey: 3,
    targets: [TARGET],
    lastProcessedBlock: 0n,
    head: 10n,
    window: { max: 4, min: 1 },
    reader: deadReader(),
    receipts: receiptsOf(),
    rotate: async () => undefined,
    endpointCount: 1,
    commit: async () => ({ ok: true, value: 0 }),
  });
  assert.equal(scan.ok, true);
  assert.equal(scan.value.stopped.code, "GET_LOGS_RANGE_REFUSED_AT_FLOOR");
  assert.match(scan.value.stopped.message, /no other configured endpoint/);
});

test("a rotation rebinds the receipt reader too, not just the log reader", async () => {
  // The ordinal lookup must follow the rotation, or it keeps asking the endpoint the
  // scan just gave up on. The second endpoint's receipts answer a different ordinal,
  // and seeing it in the observation is what proves the rebind happened.
  const log = logOf({ blockNumber: 1001, index: 9, transactionHash: word(0xabc) });
  const good = cappedReader(1000, { 1001: log });
  const rotate = async () => ({
    reader: good,
    receipts: { async blockLogIndexes() { return { ok: true, value: [4, 9] }; } },
  });
  const committed = [];
  const scan = await scanChain({
    chainKey: 3,
    targets: [TARGET],
    lastProcessedBlock: 1000n,
    head: 1001n,
    window: { max: 2, min: 1 },
    reader: deadReader(),
    receipts: receiptsOf(),
    rotate,
    endpointCount: 2,
    commit: async ({ observations }) => {
      committed.push(...observations);
      return { ok: true, value: observations.length };
    },
  });
  assert.equal(scan.ok, true);
  assert.equal(committed.length, 1);
  // Ordinal 1, from the rotated-to endpoint's receipt, not the 0 the original would give.
  assert.equal(committed[0].logIndex, 1n);
});


// ---------------------------------------------------------------- one payment, one observation

/**
 * One `settle` call is one payment, so it must leave one observation.
 *
 * `TabSettlement.settle` emits an ERC-20 `Transfer` when it pulls the Asset and then its
 * own `TabSettled`, and the two arrive from two different watch targets. Persisting both
 * would create two Provisional Clearings for one payment, pledge the Service's Bond
 * twice, and leave the surplus clearing to expire and slash a Service that did nothing
 * wrong. The contract-side fix stops the double credit but cannot stop this, because the
 * Watcher pledges Bond long before any proof exists.
 */
const paymentObservation = (overrides) => ({
  replayKey: `0x${"00".repeat(32)}`,
  chainKey: 1,
  blockHeight: 100n,
  logIndex: 0n,
  observedTxIndex: 0n,
  sourceTxHash: `0x${"a1".repeat(32)}`,
  blockDigest: `0x${"bb".repeat(32)}`,
  emitter: `0x${"11".repeat(20)}`,
  eventName: "Transfer",
  asset: `0x${"22".repeat(20)}`,
  payer: `0x${"33".repeat(20)}`,
  collection: `0x${"44".repeat(20)}`,
  collectionKind: "TAB",
  serviceId: `0x${"55".repeat(32)}`,
  amount: 1000n,
  ...overrides,
});

test("a settle call's Transfer and TabSettled leave one observation", () => {
  const kept = dropSupersededTransfers([
    paymentObservation({ logIndex: 0n, eventName: "Transfer" }),
    paymentObservation({ logIndex: 1n, eventName: "TabSettled" }),
  ]);
  assert.equal(kept.length, 1, "one payment, one observation");
  assert.equal(kept[0].eventName, "TabSettled", "the statement of intent is the one kept");
});

test("two distinct settlements in one transaction both survive", () => {
  const kept = dropSupersededTransfers([
    paymentObservation({ logIndex: 0n, eventName: "Transfer", amount: 1000n }),
    paymentObservation({ logIndex: 1n, eventName: "TabSettled", amount: 1000n }),
    paymentObservation({ logIndex: 2n, eventName: "Transfer", amount: 2000n }),
    paymentObservation({ logIndex: 3n, eventName: "TabSettled", amount: 2000n }),
  ]);
  assert.equal(kept.length, 2, "two payments, two observations");
  assert.deepEqual(kept.map((o) => o.amount), [1000n, 2000n]);
});

test("a genuine Transfer beside an identical settle is not dropped", () => {
  const kept = dropSupersededTransfers([
    paymentObservation({ logIndex: 0n, eventName: "Transfer" }),
    paymentObservation({ logIndex: 1n, eventName: "TabSettled" }),
    paymentObservation({ logIndex: 2n, eventName: "Transfer" }),
  ]);
  assert.equal(kept.length, 2, "count matching keeps the second real payment");
});

test("a Transfer in a different transaction is never superseded", () => {
  const kept = dropSupersededTransfers([
    paymentObservation({ logIndex: 0n, eventName: "TabSettled" }),
    paymentObservation({ sourceTxHash: `0x${"c2".repeat(32)}`, eventName: "Transfer" }),
  ]);
  assert.equal(kept.length, 2, "the triple is scoped to one Source Chain transaction");
});
