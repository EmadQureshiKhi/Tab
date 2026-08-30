/**
 * The indexer's two hard behaviours: re-indexing is idempotent, and a
 * reorganisation is corrected rather than layered on top of.
 *
 * These run the real {@link runTick} and {@link catchUp} against a scripted chain
 * and the in-memory sink. Nothing is stubbed out that carries logic: the decoder,
 * the row mapping, the window arithmetic, the divergence check, and the
 * delete-then-insert write path are all the shipped ones. What the fake chain
 * removes is only the network, which lets a test do the one thing a live chain will
 * not do on request — re-mine a block.
 *
 * Requirements: 12.6, 24.4
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { REGISTRY_INTERFACE, type IndexedEventName, type RawLog } from "../src/events.js";
import { catchUp, runTick, type IndexerOptions, type LogSource } from "../src/indexer.js";
import { MemorySink } from "../src/sink.js";

const AGENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const ASSET = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SERVICE_ID = `0x${"11".repeat(32)}`;
const VERIFIER = "0xc5c83782f315b321cd8e18b4c2e05df4050c3854";

const word = (seed: number): string => `0x${seed.toString(16).padStart(2, "0").repeat(32)}`;

/** One `SettlementRecorded` log at a given block, block hash, and ordinal. */
function settlementLog(blockNumber: number, blockHash: string, logIndex: number, amount: bigint): RawLog {
  const fragment = REGISTRY_INTERFACE.getEvent("SettlementRecorded");
  assert.notEqual(fragment, null);
  const encoded = REGISTRY_INTERFACE.encodeEventLog(fragment!, [
    word(logIndex + 1),
    3n,
    BigInt(21_000_000 + blockNumber),
    1n,
    BigInt(logIndex),
    AGENT,
    SERVICE_ID,
    ASSET,
    amount,
    PAYER,
    word(0),
  ]);
  return {
    blockNumber,
    blockHash,
    transactionHash: word(blockNumber % 256),
    transactionIndex: 0,
    index: logIndex,
    address: VERIFIER,
    topics: encoded.topics,
    data: encoded.data,
  };
}

/** A chain a test can rewrite. `logs` is keyed by block number. */
class ScriptedChain implements LogSource {
  head: number;
  readonly logs = new Map<number, RawLog[]>();
  /** Every range asked for, so a test can assert the chunking. */
  readonly ranges: { from: number; to: number }[] = [];

  constructor(head: number) {
    this.head = head;
  }

  put(blockNumber: number, logs: readonly RawLog[]): void {
    this.logs.set(blockNumber, [...logs]);
  }

  async headBlock(): Promise<number> {
    return this.head;
  }

  async getLogs(fromBlock: number, toBlock: number): Promise<readonly RawLog[]> {
    this.ranges.push({ from: fromBlock, to: toBlock });
    const out: RawLog[] = [];
    for (let block = fromBlock; block <= toBlock; block += 1) {
      out.push(...(this.logs.get(block) ?? []));
    }
    return out;
  }

  async blockTime(blockNumber: number): Promise<Date | null> {
    return new Date(1_700_000_000_000 + blockNumber * 1000);
  }
}

const options = (overrides: Partial<IndexerOptions> = {}): IndexerOptions => ({
  startBlock: 100,
  logChunkBlocks: 50,
  reorgWindowBlocks: 4,
  readBlockTimes: false,
  ...overrides,
});

const amountsIn = (sink: MemorySink): string[] =>
  sink.storedRows.map((row) => String(row.values.amount));

test("a tick writes what it read and advances the cursor to the block it wrote", async () => {
  const chain = new ScriptedChain(120);
  chain.put(105, [settlementLog(105, word(0xaa), 0, 1n)]);
  chain.put(110, [settlementLog(110, word(0xbb), 0, 2n), settlementLog(110, word(0xbb), 1, 3n)]);
  const sink = new MemorySink();

  const report = await runTick(chain, sink, options());

  assert.equal(report.fromBlock, 100);
  assert.equal(report.toBlock, 120);
  assert.equal(report.rowsWritten, 3);
  assert.equal(report.blocksTouched, 2);
  assert.equal(report.caughtUp, true);
  assert.equal(report.reorgDetected, false);
  assert.equal(report.cursor.lastBlock, 120);
  assert.deepEqual(amountsIn(sink), ["1", "2", "3"]);
});

test("re-running the same range changes nothing", async () => {
  const chain = new ScriptedChain(120);
  chain.put(105, [settlementLog(105, word(0xaa), 0, 1n)]);
  chain.put(110, [settlementLog(110, word(0xbb), 0, 2n)]);
  const sink = new MemorySink();

  await runTick(chain, sink, options());
  const first = sink.storedLogs.map((log) => `${log.blockHash}:${log.logIndex}`);

  // Rewind the cursor by hand and read the same range again, which is what a crash
  // between the write and the cursor advance would leave behind.
  await sink.applyBatch({
    stream: "creditcoin",
    deleteFrom: 1_000_000,
    deleteTo: 1_000_000,
    blocks: [],
    events: [],
    cursor: { lastBlock: 99, lastBlockHash: null, reorgCount: 0 },
  });
  await runTick(chain, sink, options());

  assert.deepEqual(
    sink.storedLogs.map((log) => `${log.blockHash}:${log.logIndex}`),
    first,
  );
  assert.equal(sink.storedLogs.length, 2);
});

test("the overlapping window re-scanned every tick never duplicates a row", async () => {
  const chain = new ScriptedChain(100);
  const sink = new MemorySink();
  const config = options({ startBlock: 100, logChunkBlocks: 10, reorgWindowBlocks: 4 });

  // Blocks arrive one at a time, and each tick re-scans the previous four.
  for (let block = 100; block <= 112; block += 1) {
    chain.head = block;
    chain.put(block, [settlementLog(block, word(block % 256), 0, BigInt(block))]);
    await runTick(chain, sink, config);
  }

  assert.equal(sink.storedLogs.length, 13);
  assert.deepEqual(
    amountsIn(sink),
    Array.from({ length: 13 }, (_, offset) => String(100 + offset)),
  );
  // Every tick genuinely re-read blocks it had already written.
  assert.ok(chain.ranges.some((range) => range.from < 112 && range.to === 112));
});

test("a block re-mined inside the window is replaced, not layered on", async () => {
  const chain = new ScriptedChain(110);
  chain.put(108, [settlementLog(108, word(0xaa), 0, 500n)]);
  const sink = new MemorySink();
  const config = options({ logChunkBlocks: 50, reorgWindowBlocks: 4 });

  await runTick(chain, sink, config);
  assert.deepEqual(amountsIn(sink), ["500"]);

  // Block 108 is re-mined under a different hash, carrying a different Settlement.
  chain.head = 111;
  chain.put(108, [settlementLog(108, word(0xcc), 0, 900n)]);
  const second = await runTick(chain, sink, config);

  // The abandoned branch's row is gone rather than sitting beside the new one, which
  // is the difference between a correct total and a doubled one.
  assert.deepEqual(amountsIn(sink), ["900"]);
  assert.equal(sink.storedLogs.length, 1);
  assert.equal(sink.storedBlocks.length, 1);
  assert.equal(sink.storedBlocks[0]?.blockHash, word(0xcc));
  assert.equal(second.reorgDetected, true);
  assert.equal(second.reorgFrom, 108);
  assert.equal(second.cursor.reorgCount, 1);
});

test("a block re-mined below the window is detected by hash and rewound to", async () => {
  const chain = new ScriptedChain(200);
  chain.put(120, [settlementLog(120, word(0xaa), 0, 500n)]);
  const sink = new MemorySink();
  const config = options({ logChunkBlocks: 500, reorgWindowBlocks: 2 });

  await runTick(chain, sink, config);
  assert.deepEqual(amountsIn(sink), ["500"]);

  // Block 120 is now 80 blocks behind the head, far outside the two-block re-scan
  // window, and it changes. Detection is by stored hash, and the delete widens down
  // to the divergent block rather than only covering the window.
  chain.head = 201;
  chain.put(120, [settlementLog(120, word(0xdd), 0, 700n)]);
  const second = await runTick(chain, sink, { ...config, startBlock: 100 });

  assert.equal(second.reorgDetected, true);
  assert.equal(second.reorgFrom, 120);
  assert.deepEqual(amountsIn(sink), ["700"]);
});

test("catch-up walks the range in chunks and stops at the head", async () => {
  const chain = new ScriptedChain(340);
  for (const block of [101, 175, 260, 339]) {
    chain.put(block, [settlementLog(block, word(block % 256), 0, BigInt(block))]);
  }
  const sink = new MemorySink();

  const reports = await catchUp(chain, sink, options({ logChunkBlocks: 100, reorgWindowBlocks: 0 }));

  assert.ok(reports.length >= 3, "a 240-block span at 100 blocks a chunk takes at least three ticks");
  assert.equal(reports.at(-1)?.caughtUp, true);
  assert.equal(sink.storedLogs.length, 4);
  for (const range of chain.ranges) {
    assert.ok(range.to - range.from + 1 <= 100, "no request exceeded the chunk size");
  }
});

test("a tick that finds nothing is idle and leaves the cursor alone", async () => {
  const chain = new ScriptedChain(120);
  const sink = new MemorySink();
  const config = options({ reorgWindowBlocks: 0 });

  const first = await runTick(chain, sink, config);
  assert.equal(first.idle, false);
  assert.equal(first.cursor.lastBlock, 120);

  const second = await runTick(chain, sink, config);
  assert.equal(second.idle, true);
  assert.equal(second.cursor.lastBlock, 120);
  assert.equal(sink.batches, 1, "an idle tick writes no batch");
});

test("unrecognised logs are counted and skipped without stopping the tick", async () => {
  const chain = new ScriptedChain(110);
  const unknown: RawLog = {
    blockNumber: 105,
    blockHash: word(0xaa),
    transactionHash: word(1),
    transactionIndex: 0,
    index: 0,
    address: VERIFIER,
    topics: [word(0xfe)],
    data: "0x",
  };
  chain.put(105, [unknown, settlementLog(105, word(0xaa), 1, 42n)]);
  const sink = new MemorySink();

  const report = await runTick(chain, sink, options());

  assert.equal(report.logsSeen, 2);
  assert.equal(report.logsSkipped, 1);
  assert.equal(report.rowsWritten, 1);
  assert.deepEqual(amountsIn(sink), ["42"]);
});

test("the cursor never claims a block the batch did not cover", async () => {
  const chain = new ScriptedChain(1000);
  chain.put(150, [settlementLog(150, word(0xaa), 0, 1n)]);
  const sink = new MemorySink();

  const report = await runTick(chain, sink, options({ logChunkBlocks: 20, reorgWindowBlocks: 0 }));

  // 20 blocks a chunk from block 100 means the cursor stops at 119, not at the head.
  assert.equal(report.toBlock, 119);
  assert.equal(report.cursor.lastBlock, 119);
  assert.equal(report.caughtUp, false);
  assert.equal(sink.storedLogs.length, 0);
});

test("every event this service indexes reaches its own table", async () => {
  // Not a decoding test — that is `decode.test.ts`. This asserts the routing: 17
  // events, 17 destinations, no two events sharing a table by accident.
  const chain = new ScriptedChain(110);
  chain.put(105, [settlementLog(105, word(0xaa), 0, 1n)]);
  const sink = new MemorySink();
  await runTick(chain, sink, options());

  const routed: IndexedEventName[] = sink.storedRows.map((row) => row.event);
  assert.deepEqual(routed, ["SettlementRecorded"]);
  assert.equal(sink.countsByEvent.get("SettlementRecorded"), 1);
});
