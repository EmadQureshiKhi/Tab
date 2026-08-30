/**
 * The indexer: one tick reads a range of blocks and writes what it found.
 *
 * ## Idempotence, and why it is structural rather than careful
 *
 * Every tick re-scans a window it has already read, and every batch deletes the
 * block range it is about to write before writing it. So a range can be indexed
 * any number of times and the rows are the same afterwards. Nothing depends on
 * remembering what was already written, on a "last seen" comparison, or on getting
 * an upsert conflict clause right in seventeen places. Restarting the process,
 * re-running from an earlier block, or running the same tick twice all converge on
 * the same rows.
 *
 * Two mechanisms hold it up. `(block_hash, log_index)` is the row identity, and a
 * log's envelope is a property of the chain rather than of the reader, so the same
 * log always produces the same key. And the delete is by block *number* while the
 * key is by block *hash*, which is precisely what lets a re-mined block replace an
 * abandoned one rather than collide with it.
 *
 * ## Reorganisations
 *
 * Creditcoin blocks that carry these logs are finalized quickly and this service
 * reads a chain whose history it does not depend on for money movement — but "the
 * head rarely moves" is not a correctness argument, so the indexer handles the
 * rewrite properly:
 *
 * 1. **Every tick re-scans the last `reorgWindowBlocks` blocks** and rewrites them.
 *    Anything the previous pass recorded from a branch that lost is deleted, and
 *    whatever the winning branch carries is written in its place. No detection is
 *    needed for a reorganisation inside the window; it is corrected by construction.
 * 2. **Deeper than the window, an anchor check catches it.** `indexed_block` holds
 *    the hash each indexed block carried. Before choosing its range, a tick takes the
 *    most recent indexed blocks *below* the window and asks the chain for that one
 *    block's logs again. If the block still carries the log under the same hash, it is
 *    canonical and nothing below it can have moved, so the walk stops at the first
 *    match. If the hash differs, or the log is gone from that height entirely, the
 *    block was re-mined: the range is widened down to it and the walk continues to the
 *    next anchor. This costs one extra `eth_getLogs` over a single block in the normal
 *    case, and it needs no block header — which matters, because block objects on this
 *    RPC arrive without `mixHash` and several clients refuse them.
 * 3. **Within the scanned range, hash divergence is also checked** against
 *    `indexed_block`, which covers the case where a chunk boundary or a rewound cursor
 *    has the tick re-reading old blocks anyway.
 * 4. **The limit is stated rather than hidden.** Detection rests on a re-mined block
 *    having produced a log this service indexes. A reorganisation confined to blocks
 *    with no such log leaves nothing here to correct, which is why it needs none. The
 *    anchor walk is bounded at {@link MAX_ANCHOR_CHECKS} blocks, so a reorganisation
 *    deeper than the last eight *log-bearing* blocks below the window is corrected over
 *    successive ticks rather than in one. What this design does not do is walk parent
 *    hashes back from the head, and it does not need to: no row here authorises
 *    anything on chain. The Watcher, which does, has its own digest check against the
 *    attested chain.
 *
 * ## What a tick will not do
 *
 * It will not advance the cursor past blocks it did not write, it will not stop on
 * a log it does not recognise — the four watched contracts emit events beyond this
 * surface and those are counted and skipped — and it will not treat a missing block
 * timestamp as a reason to drop a settled amount.
 *
 * Requirements: 12.6, 24.4
 */

import { decodeLog, type IndexedEventName, type RawLog } from "./events.js";
import { toTypedInsert } from "./rows.js";
import {
  DEFAULT_STREAM,
  type BlockRow,
  type CursorState,
  type EventSink,
  type EventWrite,
  type WriteBatch,
} from "./sink.js";

/** Where logs come from. Structural, so a test needs no provider and no network. */
export interface LogSource {
  /** Current head block number. */
  headBlock(): Promise<number>;
  /** Every log from the watched addresses in `[fromBlock, toBlock]`, inclusive. */
  getLogs(fromBlock: number, toBlock: number): Promise<readonly RawLog[]>;
  /**
   * The block's timestamp, or `null` when it could not be read.
   *
   * Nullable rather than throwing, because a timestamp is a convenience for the
   * settlement timeline and a log is a fact. Losing the first must not cost the
   * second.
   */
  blockTime(blockNumber: number): Promise<Date | null>;
}

/**
 * How many log-bearing blocks below the re-scan window one tick will test.
 *
 * Bounded because each check is an RPC call, and unbounded rewind on a pathological
 * chain would turn one tick into a full re-index. Eight is generous for a chain
 * whose blocks carrying these logs are finalized within a handful of blocks, and a
 * reorganisation deeper than eight log-bearing blocks is still corrected — one
 * anchor deeper per tick — rather than missed.
 */
export const MAX_ANCHOR_CHECKS = 8;

export interface IndexerOptions {
  readonly stream?: string;
  readonly startBlock: number;
  readonly logChunkBlocks: number;
  readonly reorgWindowBlocks: number;
  /** Read block timestamps. Off makes a tick one RPC call per range and no more. */
  readonly readBlockTimes?: boolean;
}

/** What one tick did. Everything a health endpoint or a test needs to assert. */
export interface TickReport {
  readonly stream: string;
  readonly head: number;
  readonly fromBlock: number;
  readonly toBlock: number;
  /** True when the tick reached the head, so the next one has nothing new to read. */
  readonly caughtUp: boolean;
  readonly logsSeen: number;
  readonly rowsWritten: number;
  /** Logs from a watched contract whose signature this service does not index. */
  readonly logsSkipped: number;
  readonly blocksTouched: number;
  readonly reorgDetected: boolean;
  /** Lowest block whose hash had changed, when one had. */
  readonly reorgFrom: number | null;
  readonly countsByEvent: ReadonlyMap<IndexedEventName, number>;
  readonly cursor: CursorState;
  /** True when the tick found nothing to do, so it wrote nothing. */
  readonly idle: boolean;
}

/**
 * The lowest already-indexed block below `before` that the chain no longer agrees
 * with, or `null` when the most recent one still matches.
 *
 * Walks anchors downwards and stops at the first that is still canonical, because a
 * canonical block implies every block below it is canonical too. An anchor that
 * returns no logs at all counts as divergent: the log this service stored is no
 * longer at that height, so the row has to go whether or not a competing block hash
 * is visible.
 */
async function findDeepDivergence(
  source: LogSource,
  sink: EventSink,
  before: number,
  limit: number,
): Promise<number | null> {
  if (before <= 0 || limit <= 0) return null;
  const anchors = await sink.readRecentBlocks(before, limit);
  let divergentAt: number | null = null;
  for (const anchor of anchors) {
    const logs = await source.getLogs(anchor.blockNumber, anchor.blockNumber);
    const hashes = new Set(logs.map((log) => log.blockHash.toLowerCase()));
    if (hashes.has(anchor.blockHash)) break;
    divergentAt = anchor.blockNumber;
  }
  return divergentAt;
}

/**
 * Runs one tick.
 *
 * Reads the cursor, checks the anchors below the window, decides the range, fetches
 * the logs, decodes them, works out how far back the delete has to reach, and hands
 * the whole thing to the sink as one atomic batch.
 */
export async function runTick(
  source: LogSource,
  sink: EventSink,
  options: IndexerOptions,
): Promise<TickReport> {
  const stream = options.stream ?? DEFAULT_STREAM;
  const head = await source.headBlock();

  const stored = await sink.readCursor(stream);
  const cursor: CursorState = stored ?? {
    lastBlock: options.startBlock - 1,
    lastBlockHash: null,
    reorgCount: 0,
  };

  // The re-scan window is what makes a shallow reorganisation self-correcting. It
  // never reaches below the configured start block, and never below zero.
  const nextBlock = cursor.lastBlock + 1;
  const windowFrom = Math.max(options.startBlock, 0, nextBlock - options.reorgWindowBlocks);

  // Anything deeper than the window is caught here, before the range is fixed, so a
  // re-mined block below the window is rewritten in this tick rather than the next.
  const deepDivergence = await findDeepDivergence(source, sink, windowFrom, MAX_ANCHOR_CHECKS);
  const fromBlock =
    deepDivergence === null ? windowFrom : Math.max(options.startBlock, 0, Math.min(windowFrom, deepDivergence));
  const toBlock = Math.min(head, fromBlock + options.logChunkBlocks - 1);

  if (toBlock < fromBlock) {
    return {
      stream,
      head,
      fromBlock,
      toBlock: cursor.lastBlock,
      caughtUp: true,
      logsSeen: 0,
      rowsWritten: 0,
      logsSkipped: 0,
      blocksTouched: 0,
      reorgDetected: false,
      reorgFrom: null,
      countsByEvent: new Map(),
      cursor,
      idle: true,
    };
  }

  const logs = await source.getLogs(fromBlock, toBlock);

  // Decode first, so a batch is never half-written because a decoder threw
  // partway through the database work.
  const decoded: { log: RawLog; write: Omit<EventWrite, "log"> & { eventName: IndexedEventName } }[] =
    [];
  let logsSkipped = 0;
  for (const log of logs) {
    const event = decodeLog(log);
    if (event === null) {
      logsSkipped += 1;
      continue;
    }
    decoded.push({ log, write: { typed: toTypedInsert(event), eventName: event.name } });
  }

  // One entry per block that produced an indexed log, with the hash it carried.
  const blockHashes = new Map<number, string>();
  const blockCounts = new Map<number, number>();
  for (const entry of decoded) {
    const number = entry.log.blockNumber;
    blockHashes.set(number, entry.log.blockHash.toLowerCase());
    blockCounts.set(number, (blockCounts.get(number) ?? 0) + 1);
  }

  // Hash divergence: a block number already indexed under a different hash was
  // re-mined, so the delete has to reach at least that far back.
  const known = await sink.readBlockHashes(fromBlock, toBlock);
  let reorgFrom: number | null = deepDivergence;
  for (const [number, hash] of blockHashes) {
    const previous = known.get(number);
    if (previous !== undefined && previous !== hash) {
      reorgFrom = reorgFrom === null ? number : Math.min(reorgFrom, number);
    }
  }
  // A block that was indexed inside this range and produced no log this time is also
  // a rewrite: the delete covers the whole range, so the stale row goes either way,
  // but the rewind is still worth counting.
  for (const number of known.keys()) {
    if (!blockHashes.has(number)) {
      reorgFrom = reorgFrom === null ? number : Math.min(reorgFrom, number);
    }
  }
  const reorgDetected = reorgFrom !== null;
  const deleteFrom = reorgFrom === null ? fromBlock : Math.max(0, Math.min(fromBlock, reorgFrom));

  const blockTimes = new Map<number, Date | null>();
  if (options.readBlockTimes !== false) {
    for (const number of blockHashes.keys()) {
      blockTimes.set(number, await source.blockTime(number));
    }
  }

  const events: EventWrite[] = decoded.map((entry) => ({
    log: {
      blockNumber: entry.log.blockNumber,
      blockHash: entry.log.blockHash.toLowerCase(),
      blockTime: blockTimes.get(entry.log.blockNumber) ?? null,
      txHash: entry.log.transactionHash.toLowerCase(),
      txIndex: entry.log.transactionIndex,
      logIndex: entry.log.index,
      emitter: entry.log.address.toLowerCase(),
      topic0: (entry.log.topics[0] ?? "").toLowerCase(),
      eventName: entry.write.eventName,
    },
    typed: entry.write.typed,
  }));

  const blocks: BlockRow[] = [...blockHashes.entries()]
    .map(([blockNumber, blockHash]) => ({
      blockNumber,
      blockHash,
      logCount: blockCounts.get(blockNumber) ?? 0,
    }))
    .sort((a, b) => a.blockNumber - b.blockNumber);

  const highest = blocks.at(-1);
  const nextCursor: CursorState = {
    lastBlock: toBlock,
    // The hash of the highest block that produced a log, which is what the
    // divergence check compares against. Blocks with no indexed log have no hash
    // worth storing, so a range that produced nothing leaves the previous value.
    lastBlockHash: highest?.blockHash ?? cursor.lastBlockHash,
    reorgCount: cursor.reorgCount + (reorgDetected ? 1 : 0),
  };

  const batch: WriteBatch = {
    stream,
    deleteFrom,
    deleteTo: toBlock,
    blocks,
    events,
    cursor: nextCursor,
  };
  await sink.applyBatch(batch);

  const countsByEvent = new Map<IndexedEventName, number>();
  for (const event of events) {
    countsByEvent.set(event.log.eventName, (countsByEvent.get(event.log.eventName) ?? 0) + 1);
  }

  return {
    stream,
    head,
    fromBlock,
    toBlock,
    caughtUp: toBlock >= head,
    logsSeen: logs.length,
    rowsWritten: events.length,
    logsSkipped,
    blocksTouched: blocks.length,
    reorgDetected,
    reorgFrom,
    countsByEvent,
    cursor: nextCursor,
    idle: false,
  };
}

/**
 * Ticks until the head is reached.
 *
 * Catch-up is a loop of bounded chunks rather than one enormous `eth_getLogs`,
 * because every endpoint caps the range it will answer, and a service that only
 * starts after a single 5-million-block request succeeds never starts.
 *
 * @param maxTicks a ceiling, so a chain producing blocks faster than the indexer
 * reads them cannot keep one call inside this function forever.
 */
export async function catchUp(
  source: LogSource,
  sink: EventSink,
  options: IndexerOptions,
  maxTicks = 10_000,
): Promise<TickReport[]> {
  const reports: TickReport[] = [];
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const report = await runTick(source, sink, options);
    reports.push(report);
    if (report.idle || report.caughtUp) break;
  }
  return reports;
}
