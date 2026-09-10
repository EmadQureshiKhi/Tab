/**
 * The HyperSync adapter and the composite that routes between it and the RPC.
 *
 * Both run against scripted fakes and no network. What is under test is the one
 * invariant the adapter guards, that a range is returned whole or not at all, and
 * the rule the composite applies, that the head and the live window come from the
 * RPC while everything older comes from the archive until the archive fails.
 *
 * The last test drives the real {@link runTick} through the composite, so the
 * chunk hint, the fallback and the block-time cache are exercised on the shipped
 * indexing path rather than in isolation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ALL_TOPIC0, REGISTRY_INTERFACE, type RawLog } from "../src/events.js";
import {
  HyperSyncBehindError,
  HyperSyncLogSource,
  createCatchUpSource,
  hyperSyncLogToRaw,
  type HyperSyncQuery,
  type HyperSyncQueryClient,
  type HyperSyncResponse,
  type HyperSyncLogRecord,
} from "../src/hypersync.js";
import { runTick, type LogSource } from "../src/indexer.js";
import { MemorySink } from "../src/sink.js";

const SETTLEMENT_SURFACE = "0x0dabf8e52280d0f128f546602a99b6dc4fbb80dc";
const AGENT = "0x1111111111111111111111111111111111111111";
const COLLECTION = "0x2222222222222222222222222222222222222222";
const ASSET = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SERVICE_ID = `0x${"11".repeat(32)}`;
const ADDRESSES = { TabSettlement: SETTLEMENT_SURFACE };

const word = (seed: number): string => `0x${seed.toString(16).padStart(2, "0").repeat(32)}`;

/** One `Settled` log as HyperSync would return it. */
function settledRecord(blockNumber: number, logIndex: number, amount: bigint): HyperSyncLogRecord {
  const fragment = REGISTRY_INTERFACE.getEvent("Settled");
  assert.notEqual(fragment, null);
  const encoded = REGISTRY_INTERFACE.encodeEventLog(fragment!, [
    word(logIndex + 1),
    AGENT,
    SERVICE_ID,
    ASSET,
    amount,
    amount,
    0n,
    COLLECTION,
  ]);
  return {
    blockNumber,
    blockHash: word(blockNumber % 256),
    transactionHash: word((blockNumber + 1) % 256),
    transactionIndex: 0,
    logIndex,
    address: SETTLEMENT_SURFACE,
    data: encoded.data,
    // HyperSync pads the four topic slots and fills the unused ones with null.
    topics: [...encoded.topics, ...Array<null>(4 - encoded.topics.length).fill(null)],
  };
}

/**
 * A scripted archive. `pages` is consumed in order, one per `get`, so a test
 * states exactly how the server paginates. `height` is what `getHeight` answers.
 */
class ScriptedArchive implements HyperSyncQueryClient {
  readonly queries: HyperSyncQuery[] = [];
  private readonly pages: HyperSyncResponse[];
  height: number;

  constructor(height: number, pages: readonly HyperSyncResponse[]) {
    this.height = height;
    this.pages = [...pages];
  }

  async getHeight(): Promise<number> {
    return this.height;
  }

  async get(query: HyperSyncQuery): Promise<HyperSyncResponse> {
    this.queries.push(query);
    const page = this.pages.shift();
    if (page === undefined) throw new Error("scripted archive: no page left to serve");
    return page;
  }
}

/**
 * A simulated archive: answers any query from a map of logs, paging at
 * `pageBlocks` per response and never past its height, the way the server does.
 */
class FakeArchive implements HyperSyncQueryClient {
  readonly queries: HyperSyncQuery[] = [];
  readonly logs = new Map<number, HyperSyncLogRecord[]>();
  readonly times = new Map<number, number>();
  height: number;
  pageBlocks: number;

  constructor(height: number, pageBlocks = 1_000_000) {
    this.height = height;
    this.pageBlocks = pageBlocks;
  }

  put(record: HyperSyncLogRecord, timestamp: number): void {
    const block = record.blockNumber ?? 0;
    this.logs.set(block, [...(this.logs.get(block) ?? []), record]);
    this.times.set(block, timestamp);
  }

  async getHeight(): Promise<number> {
    return this.height;
  }

  async get(query: HyperSyncQuery): Promise<HyperSyncResponse> {
    this.queries.push(query);
    const exclusiveTo = Math.min(query.toBlock ?? this.height + 1, query.fromBlock + this.pageBlocks, this.height + 1);
    const logs: HyperSyncLogRecord[] = [];
    const blocks: { number: number; timestamp: number }[] = [];
    for (let block = query.fromBlock; block < exclusiveTo; block += 1) {
      const found = this.logs.get(block);
      if (found === undefined) continue;
      logs.push(...found);
      blocks.push({ number: block, timestamp: this.times.get(block) ?? 0 });
    }
    return { nextBlock: exclusiveTo, archiveHeight: this.height, data: { logs, blocks } };
  }
}

const page = (
  nextBlock: number,
  logs: readonly HyperSyncLogRecord[],
  blocks: readonly { number: number; timestamp: number }[] = [],
  archiveHeight?: number,
): HyperSyncResponse => ({
  nextBlock,
  ...(archiveHeight === undefined ? {} : { archiveHeight }),
  data: { logs, blocks },
});

// ------------------------------------------------------------------ the adapter

test("the adapter asks for the watched addresses, every indexed topic, and an exclusive upper bound", async () => {
  const archive = new ScriptedArchive(1_000, [page(201, [], [], 1_000)]);
  const source = new HyperSyncLogSource(archive, ADDRESSES, { chunkBlocks: 5_000 });

  const logs = await source.getLogs(100, 200);

  assert.deepEqual(logs, []);
  assert.equal(archive.queries.length, 1);
  const query = archive.queries[0]!;
  assert.equal(query.fromBlock, 100);
  assert.equal(query.toBlock, 201, "HyperSync's toBlock is exclusive, so the inclusive 200 becomes 201");
  assert.deepEqual(query.logs[0]?.address, [SETTLEMENT_SURFACE]);
  assert.deepEqual(query.logs[0]?.topics, [ALL_TOPIC0]);
  assert.ok(query.fieldSelection.log.includes("BlockHash"));
  assert.ok(query.fieldSelection.block.includes("Timestamp"));
});

test("a range is followed across pages by nextBlock and comes back in chain order", async () => {
  const archive = new ScriptedArchive(1_000, [
    page(150, [settledRecord(120, 1, 2n), settledRecord(120, 0, 1n)], [{ number: 120, timestamp: 1_700_000_120 }], 1_000),
    page(180, [settledRecord(160, 0, 3n)], [{ number: 160, timestamp: 1_700_000_160 }], 1_000),
    page(201, [], [], 1_000),
  ]);
  const source = new HyperSyncLogSource(archive, ADDRESSES, { chunkBlocks: 5_000 });

  const logs = await source.getLogs(100, 200);

  assert.deepEqual(
    logs.map((log) => [log.blockNumber, log.index]),
    [
      [120, 0],
      [120, 1],
      [160, 0],
    ],
  );
  assert.deepEqual(
    archive.queries.map((query) => query.fromBlock),
    [100, 150, 180],
    "each page continues from the nextBlock the previous one returned",
  );
  // The block headers that rode along are served as timestamps without a request.
  assert.equal((await source.blockTime(120))?.getTime(), 1_700_000_120_000);
  assert.equal((await source.blockTime(160))?.getTime(), 1_700_000_160_000);
  assert.equal(await source.blockTime(121), null);
});

test("a range the archive has not reached is refused, never returned short", async () => {
  // The server answers up to its height of 150 and says so: nextBlock past the
  // height, and the height below the 200 asked for.
  const archive = new ScriptedArchive(150, [page(151, [settledRecord(120, 0, 1n)], [], 150)]);
  const source = new HyperSyncLogSource(archive, ADDRESSES, { chunkBlocks: 5_000 });

  await assert.rejects(source.getLogs(100, 200), (error: unknown) => {
    assert.ok(error instanceof HyperSyncBehindError);
    assert.equal(error.askedTo, 200);
    assert.equal(error.archiveHeight, 150);
    return true;
  });
});

test("a page that makes no progress is a fault, not a spin", async () => {
  const archive = new ScriptedArchive(1_000, [page(100, [], [], 1_000), page(100, [], [], 1_000)]);
  const source = new HyperSyncLogSource(archive, ADDRESSES, { chunkBlocks: 5_000 });
  await assert.rejects(source.getLogs(100, 200), /no progress past block 100/);
});

test("a log with a hole in its envelope is refused by the field it lacks", () => {
  const whole = settledRecord(120, 0, 1n);
  assert.equal(hyperSyncLogToRaw(whole).blockHash, word(120));
  assert.deepEqual(hyperSyncLogToRaw(whole).topics.length, 4, "trailing nulls are trimmed, real topics kept");
  const { blockHash: _dropped, ...withoutHash } = whole;
  assert.throws(() => hyperSyncLogToRaw(withoutHash as HyperSyncLogRecord), /without blockHash/);
});

test("the adapter reports the archive height as its head and its configured chunk", async () => {
  const archive = new ScriptedArchive(4_242, []);
  const source = new HyperSyncLogSource(archive, ADDRESSES, { chunkBlocks: 5_000 });
  assert.equal(await source.headBlock(), 4_242);
  assert.equal(await source.chunkBlocks(), 5_000);
});

// ------------------------------------------------------------------ the composite

/** A LogSource that records every call and answers from a script. */
class Recorder implements LogSource {
  readonly calls: string[] = [];
  head = 10_000;
  fail = false;
  readonly logs = new Map<number, RawLog[]>();
  readonly times = new Map<number, Date>();
  chunk: number | null = null;

  async headBlock(): Promise<number> {
    this.calls.push("head");
    return this.head;
  }

  async getLogs(fromBlock: number, toBlock: number): Promise<readonly RawLog[]> {
    this.calls.push(`logs ${fromBlock}..${toBlock}`);
    if (this.fail) throw new Error("scripted failure");
    const out: RawLog[] = [];
    for (let block = fromBlock; block <= toBlock; block += 1) out.push(...(this.logs.get(block) ?? []));
    return out;
  }

  async blockTime(blockNumber: number): Promise<Date | null> {
    this.calls.push(`time ${blockNumber}`);
    return this.times.get(blockNumber) ?? null;
  }

  async chunkBlocks(): Promise<number | null> {
    return this.chunk;
  }
}

const composite = (
  fast: Recorder,
  live: Recorder,
  overrides: { liveWindow?: number; now?: () => number; onFallback?: (error: unknown, from: number, to: number) => void } = {},
): LogSource =>
  createCatchUpSource({
    fast,
    live,
    liveWindow: overrides.liveWindow ?? 500,
    liveChunkBlocks: 100,
    restAfterFailureMs: 60_000,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.onFallback === undefined ? {} : { onFallback: overrides.onFallback }),
  });

test("the head always comes from the RPC, never the archive", async () => {
  const fast = new Recorder();
  fast.head = 9_000;
  const live = new Recorder();
  live.head = 10_000;
  const source = composite(fast, live);
  assert.equal(await source.headBlock(), 10_000);
  assert.deepEqual(fast.calls, []);
});

test("ranges older than the live window go to the archive, the live window goes to the RPC", async () => {
  const fast = new Recorder();
  const live = new Recorder();
  live.head = 10_000;
  const source = composite(fast, live, { liveWindow: 500 });
  await source.headBlock();

  await source.getLogs(1_000, 2_000);
  assert.deepEqual(fast.calls, ["logs 1000..2000"]);
  assert.deepEqual(live.calls, ["head"]);

  // 9_500 is exactly head - liveWindow, so a range ending there is still archive.
  await source.getLogs(9_400, 9_500);
  assert.deepEqual(fast.calls.at(-1), "logs 9400..9500");

  // One block further and the range touches the live window: RPC, in RPC-sized pieces.
  await source.getLogs(9_400, 9_501);
  assert.deepEqual(live.calls.slice(1), ["logs 9400..9499", "logs 9500..9501"]);
  assert.equal(fast.calls.length, 2);
});

test("when the archive fails the range is read from the RPC and the archive rests", async () => {
  const fast = new Recorder();
  fast.fail = true;
  const live = new Recorder();
  live.head = 10_000;
  live.logs.set(1_500, []);
  let clock = 1_000_000;
  const fallbacks: [number, number][] = [];
  const source = composite(fast, live, {
    now: () => clock,
    onFallback: (_error, from, to) => fallbacks.push([from, to]),
  });
  await source.headBlock();

  await source.getLogs(1_000, 1_250);
  assert.deepEqual(fallbacks, [[1_000, 1_250]]);
  assert.deepEqual(live.calls.slice(1), ["logs 1000..1099", "logs 1100..1199", "logs 1200..1250"]);

  // Within the rest period the archive is not asked again.
  clock += 30_000;
  await source.getLogs(2_000, 2_050);
  assert.equal(fast.calls.length, 1, "the archive rested");
  assert.deepEqual(live.calls.at(-1), "logs 2000..2050");

  // Once the rest is over it is tried again.
  clock += 31_000;
  fast.fail = false;
  await source.getLogs(3_000, 3_050);
  assert.deepEqual(fast.calls.at(-1), "logs 3000..3050");
  assert.equal(fallbacks.length, 1);
});

test("the chunk hint offers the archive's chunk up to the edge of the live window, and nothing inside it", async () => {
  const fast = new Recorder();
  fast.chunk = 100_000;
  const live = new Recorder();
  live.head = 10_000;
  const source = composite(fast, live, { liveWindow: 500 });
  await source.headBlock();

  assert.equal(await source.chunkBlocks?.(1_000, 10_000), 8_501, "1000..9500 is the whole archive zone");
  assert.deepEqual(fast.calls, ["logs 1000..1000"], "one probe before the first large chunk");
  assert.equal(await source.chunkBlocks?.(9_401, 10_000), 100, "exactly one RPC chunk of archive left is still archive");
  assert.equal(await source.chunkBlocks?.(9_402, 10_000), null, "less than one RPC chunk left: the configured chunk, read live across the edge");
  assert.equal(await source.chunkBlocks?.(9_501, 10_000), null, "inside the live window the configured chunk applies");
  assert.equal(fast.calls.length, 1, "verified once, not probed again");

  fast.chunk = 2_000;
  assert.equal(await source.chunkBlocks?.(1_000, 10_000), 2_000, "capped at the archive's own chunk");
});

test("an archive that fails the probe is not offered as a chunk, so the tick stays RPC-sized", async () => {
  const fast = new Recorder();
  fast.chunk = 100_000;
  fast.fail = true;
  const live = new Recorder();
  live.head = 10_000;
  let clock = 0;
  const fallbacks: [number, number][] = [];
  const source = composite(fast, live, { now: () => clock, onFallback: (_e, from, to) => fallbacks.push([from, to]) });
  await source.headBlock();

  assert.equal(await source.chunkBlocks?.(1_000, 10_000), null);
  assert.deepEqual(fallbacks, [[1_000, 1_000]], "the probe is the only thing that failed");
  assert.equal(await source.chunkBlocks?.(1_000, 10_000), null);
  assert.equal(fast.calls.length, 1, "resting: no second probe inside the minute");

  clock += 61_000;
  fast.fail = false;
  assert.equal(await source.chunkBlocks?.(1_000, 10_000), 8_501, "after the rest the probe succeeds and the chunk is offered");
});

test("block times come from the archive's cache first and the RPC only on a miss", async () => {
  const fast = new Recorder();
  fast.times.set(120, new Date(120_000));
  const live = new Recorder();
  live.times.set(121, new Date(121_000));
  const source = composite(fast, live);

  assert.equal((await source.blockTime(120))?.getTime(), 120_000);
  assert.deepEqual(live.calls, []);
  assert.equal((await source.blockTime(121))?.getTime(), 121_000);
  assert.deepEqual(live.calls, ["time 121"]);
});

// ------------------------------------------------------------------ end to end

test("a cold tick catches up through the archive in one chunk and the next tick reads the head live", async () => {
  const fragment = REGISTRY_INTERFACE.getEvent("Settled");
  assert.notEqual(fragment, null);
  const toRaw = (record: HyperSyncLogRecord): RawLog => hyperSyncLogToRaw(record);

  // An archive holding two settlements deep in history, and lagging the chain.
  const archive = new FakeArchive(9_990);
  archive.put(settledRecord(5_000, 0, 1n), 1_700_005_000);
  archive.put(settledRecord(7_000, 0, 2n), 1_700_007_000);
  const fast = new HyperSyncLogSource(archive, ADDRESSES, { chunkBlocks: 100_000 });

  // The RPC at head 10_000 with one settlement inside the live window.
  const live = new Recorder();
  live.head = 10_000;
  live.logs.set(9_800, [toRaw(settledRecord(9_800, 0, 3n))]);
  live.times.set(9_800, new Date(1_700_009_800_000));

  const source = createCatchUpSource({ fast, live, liveWindow: 500, liveChunkBlocks: 100 });
  const sink = new MemorySink();
  const options = { startBlock: 1_000, logChunkBlocks: 100, reorgWindowBlocks: 4 };

  const first = await runTick(source, sink, options);
  assert.equal(first.fromBlock, 1_000);
  assert.equal(first.toBlock, 9_500, "one archive chunk to the edge of the live window");
  assert.equal(first.rowsWritten, 2);
  assert.equal(first.caughtUp, false);
  assert.deepEqual(
    archive.queries.map((query) => [query.fromBlock, query.toBlock]),
    [
      [1_000, 1_001],
      [1_000, 9_501],
    ],
    "a one-block probe, then the whole archive zone in one request",
  );
  // No RPC block reads: the timestamps came with the logs.
  assert.deepEqual(
    live.calls.filter((call) => call.startsWith("time")),
    [],
  );
  assert.deepEqual(
    sink.storedLogs.map((log) => log.blockTime?.getTime()),
    [1_700_005_000_000, 1_700_007_000_000],
  );

  // The next tick is inside the live window: RPC, at the configured 100-block chunk.
  // The anchor check below the window (block 7000) still goes to the archive.
  const second = await runTick(source, sink, options);
  assert.equal(second.fromBlock, 9_497, "the re-scan window reaches back four blocks");
  assert.equal(second.toBlock, 9_596);
  assert.deepEqual(
    archive.queries.slice(2).map((query) => [query.fromBlock, query.toBlock]),
    [[7_000, 7_001]],
    "the archive answered the anchor check and was not asked for the live window",
  );

  // Ticking to the head lands the live settlement through the RPC with its timestamp.
  let report = second;
  for (let tick = 0; tick < 10 && !report.caughtUp; tick += 1) report = await runTick(source, sink, options);
  assert.equal(report.caughtUp, true);
  assert.deepEqual(
    sink.storedRows.map((row) => String(row.values.amount)),
    ["1", "2", "3"],
  );
  assert.ok(live.calls.includes("time 9800"));
  assert.ok(
    live.calls.every((call) => !call.startsWith("logs") || Number(call.split(" ")[1]?.split("..")[0]) >= 9_497),
    "the RPC never read a block the archive covered",
  );
});
