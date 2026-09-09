/**
 * Envio HyperSync as a {@link LogSource}, and the composite that decides when to
 * use it.
 *
 * ## Why a second log source
 *
 * Monad's public RPC answers `eth_getLogs` over at most 100 blocks per call, so a
 * cold start from the deployment block is thousands of round trips before the
 * first row lands. HyperSync serves the same logs from a columnar archive: one
 * request covers as many blocks as the server cares to return, paginated by the
 * `nextBlock` it hands back, and a narrow address-and-topic filter over a hundred
 * thousand blocks is a single round trip that comes back in well under a second.
 *
 * ## What it is not used for
 *
 * HyperSync is an archive, and an archive lags the head by a few seconds. Three
 * things therefore stay on the RPC, which is the chain's own view of itself:
 *
 * 1. **The head.** `headBlock` is always the RPC's `eth_blockNumber`, so "caught
 *    up" means caught up with the chain, not with a mirror of it.
 * 2. **The live window.** Any range that ends within `liveWindowBlocks` of the head
 *    is read from the RPC. That covers the re-scan window the indexer rewrites on
 *    every tick, so a reorganisation is corrected from the source that sees it
 *    first, and it covers the archive's own lag with room to spare.
 * 3. **Fallback.** When HyperSync fails, a missing token, a network fault, an
 *    archive that has not yet reached the block asked for, the range is read from
 *    the RPC instead and the fast path is rested for a minute. A tick never fails
 *    because the fast path did; it only gets slower.
 *
 * A large chunk is offered only once the archive has answered a one-block probe
 * since it last failed. Without that, a tick would fix a hundred-thousand-block
 * range on the archive's promise and then, on a refusal, have to read the whole
 * of it from the RPC in one go: minutes inside a single tick, written as one
 * batch. With it, a bad token costs one small request a minute and every tick in
 * between stays RPC-sized.
 *
 * ## The one invariant the adapter guards
 *
 * The indexer treats the logs a source returns for `[from, to]` as the whole truth
 * for that range: it deletes and rewrites the range around them and advances its
 * cursor past `to`. A source that returned a partial range would therefore cause
 * rows to be dropped silently. So the adapter pages until the server confirms
 * `nextBlock > to`, and refuses, with a thrown error the composite turns into an
 * RPC read, whenever the archive's reported height stops short of `to` or a page
 * makes no progress. Partial data is never returned as a result.
 *
 * Block timestamps ride along: HyperSync returns the block header of every block
 * that produced a matching log when asked, so the adapter keeps a bounded cache of
 * them and the composite consults it before spending an RPC call on `eth_getBlock`.
 */

import { ALL_TOPIC0, type RawLog } from "./events.js";
import type { LogSource } from "./indexer.js";

// ------------------------------------------------------------------ the client

/** The log fields the adapter asks for. Named as HyperSync names them. */
const LOG_FIELDS = [
  "BlockNumber",
  "BlockHash",
  "TransactionHash",
  "TransactionIndex",
  "LogIndex",
  "Address",
  "Data",
  "Topic0",
  "Topic1",
  "Topic2",
  "Topic3",
] as const;

const BLOCK_FIELDS = ["Number", "Timestamp"] as const;

/** One log as HyperSync returns it. Every field is optional on the wire; the adapter checks each. */
export interface HyperSyncLogRecord {
  readonly removed?: boolean | undefined;
  readonly logIndex?: number | undefined;
  readonly transactionIndex?: number | undefined;
  readonly transactionHash?: string | undefined;
  readonly blockHash?: string | undefined;
  readonly blockNumber?: number | undefined;
  readonly address?: string | undefined;
  readonly data?: string | undefined;
  readonly topics: ReadonlyArray<string | undefined | null>;
}

export interface HyperSyncBlockRecord {
  readonly number?: number | undefined;
  readonly timestamp?: number | undefined;
}

export interface HyperSyncQuery {
  readonly fromBlock: number;
  /** Exclusive, as HyperSync defines it. */
  readonly toBlock?: number;
  readonly logs: ReadonlyArray<{ readonly address: readonly string[]; readonly topics: ReadonlyArray<readonly string[]> }>;
  readonly fieldSelection: {
    readonly log: ReadonlyArray<(typeof LOG_FIELDS)[number]>;
    readonly block: ReadonlyArray<(typeof BLOCK_FIELDS)[number]>;
  };
}

export interface HyperSyncResponse {
  readonly nextBlock: number;
  readonly archiveHeight?: number | undefined;
  readonly data: {
    readonly logs: readonly HyperSyncLogRecord[];
    readonly blocks: readonly HyperSyncBlockRecord[];
  };
}

/**
 * The two calls this module makes. Structural, so the tests drive the adapter with
 * a scripted server and no network, and so the native client is loaded only by
 * the process that configured it.
 */
export interface HyperSyncQueryClient {
  /** The archive's current height. */
  getHeight(): Promise<number>;
  get(query: HyperSyncQuery): Promise<HyperSyncResponse>;
}

export interface HyperSyncClientConfig {
  readonly url: string;
  readonly apiToken: string | null;
}

/**
 * The real client, over `@envio-dev/hypersync-client`.
 *
 * Loaded lazily because the package is a native module: a process that never
 * configured HyperSync should never need it to exist, and a test that fakes the
 * client should not pay to load it.
 */
export async function createHyperSyncClient(config: HyperSyncClientConfig): Promise<HyperSyncQueryClient> {
  const { HypersyncClient } = await import("@envio-dev/hypersync-client");
  const client = new HypersyncClient({
    url: config.url,
    apiToken: config.apiToken ?? "",
    // A range read is one request that the composite will fall back from, so a
    // slow or unreachable archive should cost seconds rather than the default
    // dozen retries with backoff.
    httpReqTimeoutMillis: 15_000,
    maxNumRetries: 2,
    proactiveRateLimitSleep: true,
  });
  return {
    getHeight: () => client.getHeight(),
    get: (query) =>
      client.get({
        fromBlock: query.fromBlock,
        ...(query.toBlock === undefined ? {} : { toBlock: query.toBlock }),
        logs: query.logs.map((selection) => ({
          address: [...selection.address],
          topics: selection.topics.map((topic) => [...topic]),
        })),
        fieldSelection: { log: [...query.fieldSelection.log], block: [...query.fieldSelection.block] },
      }),
  };
}

// ------------------------------------------------------------------ the adapter

/** Thrown when the archive cannot yet answer for the range asked. The composite reads the RPC instead. */
export class HyperSyncBehindError extends Error {
  readonly askedTo: number;
  readonly archiveHeight: number;

  constructor(askedTo: number, archiveHeight: number) {
    super(`hypersync: archive height ${archiveHeight} is below the ${askedTo} asked for`);
    this.name = "HyperSyncBehindError";
    this.askedTo = askedTo;
    this.archiveHeight = archiveHeight;
  }
}

/** How many block timestamps the adapter remembers. Bounded so a long catch-up cannot grow it without limit. */
const BLOCK_TIME_CACHE = 50_000;

/** The largest page count one range read will follow before it is treated as runaway. */
const MAX_PAGES_PER_RANGE = 1_000;

export interface HyperSyncLogSourceOptions {
  /** The chunk this source reports through {@link LogSource.chunkBlocks}. */
  readonly chunkBlocks: number;
}

/** Reads the watched contracts' logs from a HyperSync archive. */
export class HyperSyncLogSource implements LogSource {
  private readonly client: HyperSyncQueryClient;
  private readonly addresses: readonly string[];
  private readonly chunk: number;
  private readonly blockTimes = new Map<number, number>();

  constructor(client: HyperSyncQueryClient, addresses: Readonly<Record<string, string>>, options: HyperSyncLogSourceOptions) {
    this.client = client;
    this.addresses = Object.values(addresses);
    this.chunk = options.chunkBlocks;
    if (this.addresses.length === 0) throw new Error("hypersync: no watched addresses configured");
  }

  /** The archive height. Behind the chain by its lag; the composite never uses this for the head. */
  async headBlock(): Promise<number> {
    return this.client.getHeight();
  }

  async chunkBlocks(): Promise<number> {
    return this.chunk;
  }

  /**
   * Every log from the watched addresses in `[fromBlock, toBlock]`, or a thrown
   * error. Never a partial range; see the module comment.
   */
  async getLogs(fromBlock: number, toBlock: number): Promise<readonly RawLog[]> {
    const out: RawLog[] = [];
    let cursor = fromBlock;
    for (let page = 0; page < MAX_PAGES_PER_RANGE; page += 1) {
      const response = await this.client.get({
        fromBlock: cursor,
        toBlock: toBlock + 1,
        logs: [{ address: this.addresses, topics: [ALL_TOPIC0] }],
        fieldSelection: { log: LOG_FIELDS, block: BLOCK_FIELDS },
      });

      for (const block of response.data.blocks) this.rememberBlockTime(block);
      for (const log of response.data.logs) out.push(hyperSyncLogToRaw(log));

      if (response.nextBlock > toBlock) {
        return out.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
      }
      if (response.archiveHeight !== undefined && response.nextBlock > response.archiveHeight) {
        throw new HyperSyncBehindError(toBlock, response.archiveHeight);
      }
      if (response.nextBlock <= cursor) {
        throw new Error(`hypersync: no progress past block ${cursor} for range ${fromBlock}..${toBlock}`);
      }
      cursor = response.nextBlock;
    }
    throw new Error(`hypersync: range ${fromBlock}..${toBlock} did not complete within ${MAX_PAGES_PER_RANGE} pages`);
  }

  /** A timestamp seen while reading logs, or `null`. Never a request of its own. */
  async blockTime(blockNumber: number): Promise<Date | null> {
    const seconds = this.blockTimes.get(blockNumber);
    return seconds === undefined ? null : new Date(seconds * 1000);
  }

  private rememberBlockTime(block: HyperSyncBlockRecord): void {
    if (block.number === undefined || block.timestamp === undefined) return;
    if (this.blockTimes.size >= BLOCK_TIME_CACHE) {
      const oldest = this.blockTimes.keys().next().value;
      if (oldest !== undefined) this.blockTimes.delete(oldest);
    }
    this.blockTimes.set(block.number, block.timestamp);
  }
}

/**
 * One HyperSync log in the shape the decoder reads, or a thrown error naming the
 * field the archive left out. A log with a hole in its envelope cannot be keyed,
 * so it is refused rather than stored under a guess.
 */
export function hyperSyncLogToRaw(log: HyperSyncLogRecord): RawLog {
  const need = <T>(value: T | undefined, field: string): T => {
    if (value === undefined) throw new Error(`hypersync: log arrived without ${field}`);
    return value;
  };
  const topics: string[] = [];
  for (const topic of log.topics) {
    if (topic === undefined || topic === null) break;
    topics.push(topic);
  }
  return {
    blockNumber: need(log.blockNumber, "blockNumber"),
    blockHash: need(log.blockHash, "blockHash"),
    transactionHash: need(log.transactionHash, "transactionHash"),
    transactionIndex: need(log.transactionIndex, "transactionIndex"),
    index: need(log.logIndex, "logIndex"),
    address: need(log.address, "address"),
    topics,
    data: need(log.data, "data"),
  };
}

// ------------------------------------------------------------------ the composite

export interface CatchUpSourceOptions {
  /** The archive. Consulted for ranges that end further than `liveWindow` behind the head. */
  readonly fast: LogSource;
  /** The RPC. Answers the head, the live window, and every range the archive could not. */
  readonly live: LogSource;
  /** Ranges ending within this many blocks of the head are read live. */
  readonly liveWindow: number;
  /** Blocks per request the live source tolerates. A fallback read is split to this. */
  readonly liveChunkBlocks: number;
  /** How long the fast path is rested after a failure, in milliseconds. */
  readonly restAfterFailureMs?: number;
  /** Called on every fallback, with the failure. For the process log; never throws. */
  readonly onFallback?: (error: unknown, fromBlock: number, toBlock: number) => void;
  readonly now?: () => number;
}

/**
 * The two sources as one. See the module comment for the rule it applies.
 *
 * Which source a range goes to is decided against the head this composite last
 * returned from {@link LogSource.headBlock}, which is the head the current tick is
 * working from, so a decision cannot be made against a head the indexer has not
 * seen.
 */
export function createCatchUpSource(options: CatchUpSourceOptions): LogSource {
  const { fast, live, liveWindow, liveChunkBlocks } = options;
  const rest = options.restAfterFailureMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  let head: number | null = null;
  let fastRestingUntil = 0;
  /** True once the archive has answered since it last failed. Gates the large chunk. */
  let fastVerified = false;

  const fastCovers = (toBlock: number, headNow: number): boolean =>
    toBlock <= headNow - liveWindow && now() >= fastRestingUntil;

  const restFast = (error: unknown, fromBlock: number, toBlock: number): void => {
    fastVerified = false;
    fastRestingUntil = now() + rest;
    options.onFallback?.(error, fromBlock, toBlock);
  };

  const readLive = async (fromBlock: number, toBlock: number): Promise<readonly RawLog[]> => {
    const out: RawLog[] = [];
    for (let start = fromBlock; start <= toBlock; start += liveChunkBlocks) {
      const end = Math.min(toBlock, start + liveChunkBlocks - 1);
      out.push(...(await live.getLogs(start, end)));
    }
    return out;
  };

  return {
    async headBlock(): Promise<number> {
      head = await live.headBlock();
      return head;
    },

    async chunkBlocks(fromBlock: number, headNow: number): Promise<number | null> {
      const fastChunk = fast.chunkBlocks === undefined ? null : await fast.chunkBlocks(fromBlock, headNow);
      if (fastChunk === null || !fastCovers(fromBlock, headNow)) return null;
      // The fast range may run up to the edge of the live window and no further,
      // so the live window is never read from the archive. Once less than one RPC
      // chunk of archive remains, the hint steps aside: a tick whose re-scan
      // window straddles the edge must read a whole configured chunk across it,
      // live, or it would re-read the same few blocks below the edge for ever.
      const remaining = headNow - liveWindow - fromBlock + 1;
      if (remaining < liveChunkBlocks) return null;
      if (!fastVerified) {
        try {
          await fast.getLogs(fromBlock, fromBlock);
          fastVerified = true;
        } catch (error) {
          restFast(error, fromBlock, fromBlock);
          return null;
        }
      }
      return Math.min(fastChunk, remaining);
    },

    async getLogs(fromBlock: number, toBlock: number): Promise<readonly RawLog[]> {
      const headNow = head ?? (await live.headBlock());
      if (!fastCovers(toBlock, headNow)) return readLive(fromBlock, toBlock);
      try {
        const logs = await fast.getLogs(fromBlock, toBlock);
        fastVerified = true;
        return logs;
      } catch (error) {
        restFast(error, fromBlock, toBlock);
        return readLive(fromBlock, toBlock);
      }
    },

    async blockTime(blockNumber: number): Promise<Date | null> {
      const cached = await fast.blockTime(blockNumber);
      return cached ?? live.blockTime(blockNumber);
    },
  };
}
