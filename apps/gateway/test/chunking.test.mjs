/**
 * The chunked history scan, and why it exists.
 *
 * The Creditcoin RPC bounds `eth_getLogs` by **time**, answering
 * `-32603: query timeout of 10 seconds exceeded`. Measured: one unchunked read from
 * the deployment block succeeded three times and failed once, and the span it covers
 * grows every block, so it degrades rather than settles. A timeout that loses the
 * whole scan means no witness, and no witness means no Agent can be metered.
 *
 * The cases below pin the two properties that matter: a timeout narrows and
 * **retries the same chunk** rather than stepping past it, and a scan that ever did
 * drop a record says which one instead of surfacing as a bare commitment mismatch.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWitness,
  createWitnessReader,
  growWindow,
  isNarrowable,
  shrinkWindow,
  HISTORY_CHUNK_MAX,
  HISTORY_CHUNK_MIN,
  HISTORY_INTERFACE,
  GET_LOGS_TIMEOUT_SECONDS,
} from "../dist/witness.js";

const AGENT = "0x1f6f797edc2eecb02bd54009b805fb2e99f80542";
const ASSET = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const SERVICE = "0x7461622e70726f6f662d73657276696365000000000000000000000000000000";
const TAB_BOOK = `0x${"11".repeat(20)}`;

const record = (over = {}) => ({
  serviceId: SERVICE,
  asset: ASSET,
  amount: 101000n,
  settledAt: 1788680685n,
  firstDeliveryAt: 0n,
  chainKey: 1n,
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
    [rec.serviceId, rec.asset, rec.amount, rec.settledAt, rec.firstDeliveryAt, rec.chainKey, rec.curated, rec.bonded],
  ]);
  return { ...encoded, blockNumber, logIndex: 0 };
}

/**
 * A provider that serves logs by block range and can be told to time out.
 *
 * `timeoutAbove` reproduces the real endpoint: a request wider than that many
 * blocks fails, narrower ones succeed.
 */
function fakeProvider({ logs = [], head = 10_000, timeoutAbove = Infinity, calls = [] }) {
  return {
    getBlock: async () => ({ number: head }),
    send: async (_method, [params]) => {
      const from = Number(params.fromBlock);
      const to = Number(params.toBlock);
      calls.push({ from, to, width: to - from + 1 });
      if (to - from + 1 > timeoutAbove) {
        throw Object.assign(new Error("query timeout of 10 seconds exceeded"), { code: -32603 });
      }
      return logs
        .filter((log) => log.blockNumber >= from && log.blockNumber <= to)
        .map((log) => ({ ...log, blockNumber: `0x${log.blockNumber.toString(16)}`, logIndex: "0x0" }));
    },
    call: async () => "0x",
  };
}

test("the measured timeout is recorded next to the code that works around it", () => {
  assert.equal(GET_LOGS_TIMEOUT_SECONDS, 10);
  assert.ok(HISTORY_CHUNK_MAX > HISTORY_CHUNK_MIN);
});

test("a query timeout is narrowable and an unrelated fault is not", () => {
  assert.equal(isNarrowable(new Error("query timeout of 10 seconds exceeded")), true);
  assert.equal(isNarrowable(new Error("Query timeout")), true);
  assert.equal(isNarrowable(new Error("block range is too wide")), true);
  assert.equal(isNarrowable(new Error("connection refused")), false);
  assert.equal(isNarrowable(new Error("invalid address")), false);
});

test("the window halves to a floor and doubles to a ceiling", () => {
  assert.equal(shrinkWindow(2000, 1), 1000);
  assert.equal(shrinkWindow(1, 1), 1, "never below the floor");
  assert.equal(growWindow(1000, 2000), 2000);
  assert.equal(growWindow(2000, 2000), 2000, "never above the ceiling");
});

test("a scan spanning many chunks collects every record", async () => {
  const calls = [];
  const logs = [logAt(1, 100), logAt(2, 4_500), logAt(3, 9_900)];
  const reader = createWitnessReader(
    fakeProvider({ logs, head: 10_000, calls }),
    { tabBook: TAB_BOOK, bond: TAB_BOOK, serviceRegistry: TAB_BOOK },
    "finalized",
    0,
  );
  const found = await reader.historyLogs(AGENT, ASSET);
  assert.equal(found.ok, true);
  assert.equal(found.value.length, 3, "records from three different chunks all arrived");
  assert.ok(calls.length > 1, "the scan was chunked rather than issued as one query");
  // Contiguous and non-overlapping, so nothing can be dropped or double counted.
  for (let i = 1; i < calls.length; i += 1) {
    assert.equal(calls[i].from, calls[i - 1].to + 1, "chunks abut exactly");
  }
});

test("a timeout narrows and retries the same chunk rather than stepping past it", async () => {
  const calls = [];
  // Every record sits in the first 2000 blocks, so a scan that skipped the timed-out
  // chunk instead of retrying it would silently return nothing.
  const logs = [logAt(1, 10), logAt(2, 20)];
  const reader = createWitnessReader(
    fakeProvider({ logs, head: 6_000, timeoutAbove: 500, calls }),
    { tabBook: TAB_BOOK, bond: TAB_BOOK, serviceRegistry: TAB_BOOK },
    "finalized",
    0,
  );
  const found = await reader.historyLogs(AGENT, ASSET);
  assert.equal(found.ok, true);
  assert.equal(found.value.length, 2, "narrowing recovered the records the wide query could not serve");

  const refused = calls.filter((c) => c.width > 500);
  assert.ok(refused.length > 0, "the first attempt was too wide");
  // Each refused attempt is followed by another attempt starting at the same block.
  for (const attempt of refused) {
    assert.ok(
      calls.some((c) => c.from === attempt.from && c.width <= 500),
      `the chunk at ${attempt.from} was retried narrower, not skipped`,
    );
  }
});

test("a refusal that narrowing cannot fix stops the scan and says so", async () => {
  const reader = createWitnessReader(
    {
      getBlock: async () => ({ number: 100 }),
      send: async () => {
        throw new Error("connection refused");
      },
      call: async () => "0x",
    },
    { tabBook: TAB_BOOK, bond: TAB_BOOK, serviceRegistry: TAB_BOOK },
    "finalized",
    0,
  );
  const found = await reader.historyLogs(AGENT, ASSET);
  assert.equal(found.ok, false);
  assert.match(found.error.message, /narrowing cannot fix/);
});

test("an endpoint that refuses even one block reports the floor rather than looping", async () => {
  const reader = createWitnessReader(
    fakeProvider({ head: 50, timeoutAbove: 0 }),
    { tabBook: TAB_BOOK, bond: TAB_BOOK, serviceRegistry: TAB_BOOK },
    "finalized",
    0,
  );
  const found = await reader.historyLogs(AGENT, ASSET);
  assert.equal(found.ok, false);
  assert.match(found.error.message, /which is the floor/);
});

test("the upper bound is resolved once, so the head cannot move under the scan", async () => {
  const calls = [];
  const reader = createWitnessReader(
    fakeProvider({ logs: [logAt(1, 10)], head: 5_000, calls }),
    { tabBook: TAB_BOOK, bond: TAB_BOOK, serviceRegistry: TAB_BOOK },
    "finalized",
    0,
  );
  await reader.historyLogs(AGENT, ASSET);
  // The measured failure was against a `latest` upper bound; every chunk here asks
  // for a pinned number instead.
  assert.ok(calls.every((c) => Number.isFinite(c.to)), "every chunk named a numeric toBlock");
  assert.equal(Math.max(...calls.map((c) => c.to)), 5_000);
});

// ------------------------------------------- the record run, checked explicitly

function readerOver(logs, commitment) {
  return {
    historyLogs: async () => ({ ok: true, value: logs }),
    commitment: async () => ({ ok: true, value: commitment }),
    staked: async () => ({ ok: true, value: 0n }),
  };
}

test("a chunk that lost a record names the record rather than blaming the commitment", async () => {
  const built = await buildWitness(
    readerOver([logAt(1, 10), logAt(3, 30)], { root: `0x${"11".repeat(32)}`, count: 3 }),
    AGENT,
    ASSET,
  );
  assert.equal(built.ok, false);
  assert.equal(built.error.code, "HISTORY_RECORD_MISSING");
  assert.equal(built.error.details.expected, 2);
  assert.equal(built.error.details.received, 3);
});

test("a chunk read twice is reported as a duplicate, not folded in twice", async () => {
  const built = await buildWitness(
    readerOver([logAt(1, 10), logAt(1, 10), logAt(2, 20)], { root: `0x${"11".repeat(32)}`, count: 2 }),
    AGENT,
    ASSET,
  );
  assert.equal(built.ok, false);
  assert.equal(built.error.code, "HISTORY_RECORD_DUPLICATED");
});
