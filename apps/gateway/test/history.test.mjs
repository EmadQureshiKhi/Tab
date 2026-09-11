/**
 * The history source: what a witness costs on the second call, on the first
 * sight of an Agent, and when the registry is down or wrong.
 *
 * Every test counts chain reads, because the module exists to make that number
 * small, and every one proves the witness still folds, because the module must
 * never make it wrong.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createHistorySource } from "../dist/history.js";
import { buildWitness, commitmentOf, HISTORY_INTERFACE } from "../dist/witness.js";

const AGENT = "0x1f6f797edc2eecb02bd54009b805fb2e99f80542";
const ASSET = "0x534b2f3a21130d7a60830c2df862319e593943a3";
const SERVICE = "0x7461622e64656d6f000000000000000000000000000000000000000000000000";
const DEPLOYED_AT = 100;

const record = (over = {}) => ({
  serviceId: SERVICE,
  asset: ASSET,
  amount: 101000n,
  settledAt: 1788680685n,
  firstDeliveryAt: 0n,
  curated: false,
  bonded: false,
  ...over,
});

function logAt(count, blockNumber, rec = record()) {
  const encoded = HISTORY_INTERFACE.encodeEventLog(HISTORY_INTERFACE.getEvent("HistoryExtended"), [
    AGENT,
    rec.asset,
    `0x${"00".repeat(32)}`,
    count,
    [rec.serviceId, rec.asset, rec.amount, rec.settledAt, rec.firstDeliveryAt, rec.curated, rec.bonded],
  ]);
  return { ...encoded, blockNumber, logIndex: 0 };
}

/**
 * A chain whose logs and commitment are whatever the test says, counting every
 * read. `commit()` appends a record: the log lands at the next block and the
 * commitment advances, which is what a Settlement does.
 */
function fakeChain({ records = [], head = 1_000 } = {}) {
  const logs = records.map((rec, index) => logAt(index + 1, DEPLOYED_AT + index * 10, rec));
  const state = { logs, head, reads: { historyLogs: 0, commitment: 0, scannedBlocks: 0 } };
  const history = () => logs.map((_, index) => records[index]);
  return {
    state,
    commit(rec) {
      records.push(rec);
      state.head += 1;
      logs.push(logAt(records.length, state.head, rec));
    },
    reader: {
      async historyLogs(_agent, _asset, range = {}) {
        state.reads.historyLogs += 1;
        const from = range.fromBlock ?? DEPLOYED_AT;
        const to = range.toBlock ?? state.head;
        state.reads.scannedBlocks += Math.max(0, to - from + 1);
        return { ok: true, value: logs.filter((log) => log.blockNumber >= from && log.blockNumber <= to) };
      },
      async commitment() {
        state.reads.commitment += 1;
        return { ok: true, value: commitmentOf(history()) };
      },
      async staked() {
        return { ok: true, value: 0n };
      },
      async operatorOf() {
        return { ok: true, value: "0x" };
      },
    },
    head: async () => ({ ok: true, value: state.head }),
  };
}

/** A registry serving the witness complete to `lastBlock`, or failing as told. */
function fakeRegistry({ records = [], lastBlock = 500, status = 200, fail = false, mangle = (body) => body, calls = [] } = {}) {
  return async (url) => {
    calls.push(String(url));
    if (fail) throw new Error("connect ECONNREFUSED");
    const body = mangle({
      index: { lastBlock },
      commitment: commitmentOf(records),
      history: records.map((rec) => ({
        serviceId: rec.serviceId,
        asset: rec.asset,
        amount: rec.amount.toString(),
        settledAt: rec.settledAt.toString(),
        firstDeliveryAt: rec.firstDeliveryAt.toString(),
        curated: rec.curated,
        bonded: rec.bonded,
      })),
    });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

const silent = { warn: () => undefined };

test("an Agent with no history costs one commitment read and no scan", async () => {
  const chain = fakeChain();
  const source = createHistorySource({ chain: chain.reader, fromBlock: DEPLOYED_AT, head: chain.head, logger: silent });

  const built = await buildWitness(source, AGENT, ASSET);
  assert.equal(built.ok, true);
  assert.equal(built.value.witness.history.length, 0);
  assert.equal(chain.state.reads.historyLogs, 0);
});

test("the second call for an Agent with history scans nothing when nothing landed", async () => {
  const chain = fakeChain({ records: [record(), record({ amount: 5n })] });
  const source = createHistorySource({ chain: chain.reader, fromBlock: DEPLOYED_AT, head: chain.head, logger: silent });

  const first = await buildWitness(source, AGENT, ASSET);
  assert.equal(first.ok, true);
  assert.equal(first.value.witness.history.length, 2);
  const scansAfterFirst = chain.state.reads.historyLogs;
  assert.equal(scansAfterFirst, 1);

  const second = await buildWitness(source, AGENT, ASSET);
  assert.equal(second.ok, true);
  assert.deepEqual(second.value.witness.history, first.value.witness.history);
  assert.equal(chain.state.reads.historyLogs, scansAfterFirst, "no scan ran");
});

test("a Settlement after the last call scans only the blocks since, and the witness still folds", async () => {
  const chain = fakeChain({ records: [record()], head: 1_000 });
  const source = createHistorySource({ chain: chain.reader, fromBlock: DEPLOYED_AT, head: chain.head, logger: silent });

  await buildWitness(source, AGENT, ASSET);
  const scanned = chain.state.reads.scannedBlocks;

  chain.commit(record({ amount: 7n }));
  const after = await buildWitness(source, AGENT, ASSET);
  assert.equal(after.ok, true);
  assert.equal(after.value.witness.history.length, 2);
  assert.equal(after.value.rebuilt.root, after.value.onChain.root);
  assert.equal(chain.state.reads.scannedBlocks - scanned, 1, "one new block was read");
});

test("first sight reads the registry and scans from its horizon, not from the deployment block", async () => {
  const records = [record(), record({ amount: 2n }), record({ amount: 3n })];
  const chain = fakeChain({ records, head: 5_000 });
  const calls = [];
  const source = createHistorySource({
    chain: chain.reader,
    fromBlock: DEPLOYED_AT,
    head: chain.head,
    registryUrl: "http://registry.test/",
    fetchImpl: fakeRegistry({ records, lastBlock: 4_990, calls }),
    logger: silent,
  });

  const built = await buildWitness(source, AGENT, ASSET);
  assert.equal(built.ok, true);
  assert.equal(built.value.witness.history.length, 3);
  assert.equal(built.value.rebuilt.root, built.value.onChain.root);
  assert.equal(calls[0], `http://registry.test/agents/${AGENT}/witness/${ASSET}`);
  assert.equal(chain.state.reads.scannedBlocks, 10, "only the blocks past the index horizon");
});

test("a registry that is down, refusing, behind or malformed falls back to the scan, and the witness is the same", async () => {
  const records = [record(), record({ amount: 2n })];
  const expected = commitmentOf(records);
  const cases = [
    { name: "down", fetchImpl: fakeRegistry({ fail: true }) },
    { name: "refusing", fetchImpl: fakeRegistry({ records, status: 503 }) },
    { name: "behind", fetchImpl: fakeRegistry({ records: records.slice(0, 1), lastBlock: 100 }) },
    { name: "malformed", fetchImpl: fakeRegistry({ records, mangle: (body) => ({ ...body, history: [{ serviceId: "nope" }] }) }) },
    { name: "miscounted", fetchImpl: fakeRegistry({ records, mangle: (body) => ({ ...body, commitment: { ...body.commitment, count: 9 } }) }) },
  ];
  for (const { name, fetchImpl } of cases) {
    const chain = fakeChain({ records: [...records], head: 1_000 });
    const warnings = [];
    const source = createHistorySource({
      chain: chain.reader,
      fromBlock: DEPLOYED_AT,
      head: chain.head,
      registryUrl: "http://registry.test",
      fetchImpl,
      logger: { warn: (message) => warnings.push(message) },
    });
    const built = await buildWitness(source, AGENT, ASSET);
    assert.equal(built.ok, true, name);
    assert.equal(built.value.rebuilt.root, expected.root, name);
    assert.equal(built.value.witness.history.length, 2, name);
    if (name !== "behind") assert.ok(warnings.length >= 1, `${name} was logged`);
  }
});

test("a registry behind by one Settlement is topped up from the chain rather than refused", async () => {
  const records = [record(), record({ amount: 2n })];
  const chain = fakeChain({ records: [...records], head: 1_000 });
  const source = createHistorySource({
    chain: chain.reader,
    fromBlock: DEPLOYED_AT,
    head: chain.head,
    registryUrl: "http://registry.test",
    // The registry knows the first record and was complete to block 105, so the
    // second, at block 110, is exactly what the scan since the horizon finds.
    fetchImpl: fakeRegistry({ records: records.slice(0, 1), lastBlock: 105 }),
    logger: silent,
  });
  const built = await buildWitness(source, AGENT, ASSET);
  assert.equal(built.ok, true);
  assert.equal(built.value.witness.history.length, 2);
  assert.equal(built.value.rebuilt.root, built.value.onChain.root);
  assert.equal(chain.state.reads.scannedBlocks, 1_000 - 105);
});

test("histories are held per Agent and Asset, never shared across them", async () => {
  const chain = fakeChain({ records: [record()] });
  const source = createHistorySource({ chain: chain.reader, fromBlock: DEPLOYED_AT, head: chain.head, logger: silent });
  const first = await buildWitness(source, AGENT, ASSET);
  assert.equal(first.ok, true);
  const other = await source.historyRecords(AGENT, `0x${"22".repeat(20)}`);
  assert.equal(other.ok, true);
  // The fake chain answers the same logs for any Asset, so the point is only
  // that the second Asset was fetched on its own rather than served from the
  // first's entry.
  assert.equal(chain.state.reads.historyLogs, 2);
});
