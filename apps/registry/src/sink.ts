/**
 * The write surface the indexer talks to, and an in-memory implementation of it.
 *
 * The indexer is written against this interface rather than against Postgres, for
 * one reason that matters: the interesting logic — chunking, the re-scan window,
 * reorganisation rewind, idempotence — is exercisable without a database, and
 * exercising it is how it stays correct. `MemorySink` is not a mock standing in
 * for behaviour it does not have. It implements the same three operations with the
 * same semantics, so a test that runs the real indexer against the real chain
 * through this sink is testing the real logic.
 *
 * The contract every implementation owes:
 *
 * 1. {@link EventSink.applyBatch} is atomic. Either the delete, every insert, and
 *    the cursor advance all land, or none of them do. A partial batch would leave a
 *    cursor claiming blocks whose rows are missing, and nothing would ever go back
 *    for them.
 * 2. It is idempotent. Applying the same batch twice leaves the same rows. This
 *    follows from delete-then-insert over the batch's own range plus a primary key
 *    on `(block_hash, log_index)`.
 * 3. The delete is by block *number*, and it takes typed rows with it. A
 *    reorganisation is corrected by removing a range, not by rewriting rows in
 *    place.
 *
 * Requirements: 12.6, 24.4
 */

import type { TypedInsert } from "./rows.js";
import type { IndexedEventName } from "./events.js";

/** The default and only stream name. A second address set would get a second name. */
export const DEFAULT_STREAM = "creditcoin" as const;

/** How far the indexer has read, and how many rewinds it has performed. */
export interface CursorState {
  /** Highest block whose logs are fully written. `startBlock - 1` before the first tick. */
  readonly lastBlock: number;
  readonly lastBlockHash: string | null;
  readonly reorgCount: number;
}

/** One block that produced at least one indexed log. */
export interface BlockRow {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly logCount: number;
}

/** The envelope of one log, as stored. */
export interface EventLogRow {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly blockTime: Date | null;
  readonly txHash: string;
  readonly txIndex: number;
  readonly logIndex: number;
  readonly emitter: string;
  readonly topic0: string;
  readonly eventName: IndexedEventName;
}

/** One log's envelope and its decoded row, written together or not at all. */
export interface EventWrite {
  readonly log: EventLogRow;
  readonly typed: TypedInsert;
}

/**
 * Everything one tick writes.
 *
 * `deleteFrom`..`deleteTo` is inclusive and always covers every block the batch
 * inserts into. That is what makes a re-run of the same range a no-op instead of a
 * conflict, and what removes an abandoned branch's rows without having to identify
 * them individually.
 */
export interface WriteBatch {
  readonly stream: string;
  readonly deleteFrom: number;
  readonly deleteTo: number;
  readonly blocks: readonly BlockRow[];
  readonly events: readonly EventWrite[];
  readonly cursor: CursorState;
}

export interface EventSink {
  /** The stream's cursor, or `null` when it has never run. */
  readCursor(stream: string): Promise<CursorState | null>;
  /** Block hash per block number, for the numbers in `[from, to]` that produced logs. */
  readBlockHashes(from: number, to: number): Promise<ReadonlyMap<number, string>>;
  /**
   * The most recent indexed blocks strictly below `before`, highest first.
   *
   * These are the anchors the deep-reorganisation check walks: a block already
   * indexed, below the re-scan window, whose hash can be tested against the chain
   * without reading a block header.
   */
  readRecentBlocks(before: number, limit: number): Promise<readonly BlockRow[]>;
  /** Applies one batch atomically and idempotently. */
  applyBatch(batch: WriteBatch): Promise<void>;
  close(): Promise<void>;
}

/**
 * An in-memory sink with the same semantics as the Postgres one.
 *
 * Rows are keyed on `${blockHash}:${logIndex}`, which is the same primary key the
 * SQL declares, and the delete drops every row in a block-number range along with
 * its typed row — the cascade, by hand.
 */
export class MemorySink implements EventSink {
  private readonly cursors = new Map<string, CursorState>();
  private readonly blocks = new Map<number, BlockRow>();
  private readonly logs = new Map<string, EventLogRow>();
  private readonly typed = new Map<string, TypedInsert>();
  /** Batches applied, so a test can assert the write path ran once and not twice. */
  public batches = 0;

  static key(blockHash: string, logIndex: number): string {
    return `${blockHash}:${logIndex}`;
  }

  async readCursor(stream: string): Promise<CursorState | null> {
    return this.cursors.get(stream) ?? null;
  }

  async readBlockHashes(from: number, to: number): Promise<ReadonlyMap<number, string>> {
    const hashes = new Map<number, string>();
    for (const [blockNumber, block] of this.blocks) {
      if (blockNumber >= from && blockNumber <= to) hashes.set(blockNumber, block.blockHash);
    }
    return hashes;
  }

  async readRecentBlocks(before: number, limit: number): Promise<readonly BlockRow[]> {
    return [...this.blocks.values()]
      .filter((block) => block.blockNumber < before)
      .sort((a, b) => b.blockNumber - a.blockNumber)
      .slice(0, limit);
  }

  async applyBatch(batch: WriteBatch): Promise<void> {
    for (const [key, log] of [...this.logs]) {
      if (log.blockNumber >= batch.deleteFrom && log.blockNumber <= batch.deleteTo) {
        this.logs.delete(key);
        this.typed.delete(key);
      }
    }
    for (const blockNumber of [...this.blocks.keys()]) {
      if (blockNumber >= batch.deleteFrom && blockNumber <= batch.deleteTo) {
        this.blocks.delete(blockNumber);
      }
    }

    for (const block of batch.blocks) this.blocks.set(block.blockNumber, block);
    for (const write of batch.events) {
      const key = MemorySink.key(write.log.blockHash, write.log.logIndex);
      if (this.logs.has(key)) continue;
      this.logs.set(key, write.log);
      this.typed.set(key, write.typed);
    }

    this.cursors.set(batch.stream, batch.cursor);
    this.batches += 1;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  // ------------------------------------------------------------- inspection

  /** Every stored envelope, in chain order. */
  get storedLogs(): readonly EventLogRow[] {
    return [...this.logs.values()].sort(
      (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
    );
  }

  /** Every stored typed row, in the same order as {@link storedLogs}. */
  get storedRows(): readonly TypedInsert[] {
    return this.storedLogs.map((log) => {
      const typed = this.typed.get(MemorySink.key(log.blockHash, log.logIndex));
      if (typed === undefined) throw new Error("sink: envelope without a typed row");
      return typed;
    });
  }

  /** Count of stored rows per event name. */
  get countsByEvent(): ReadonlyMap<IndexedEventName, number> {
    const counts = new Map<IndexedEventName, number>();
    for (const log of this.logs.values()) {
      counts.set(log.eventName, (counts.get(log.eventName) ?? 0) + 1);
    }
    return counts;
  }

  get storedBlocks(): readonly BlockRow[] {
    return [...this.blocks.values()].sort((a, b) => a.blockNumber - b.blockNumber);
  }
}
