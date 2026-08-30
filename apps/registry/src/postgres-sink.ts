/**
 * The Postgres implementation of {@link EventSink}, over Drizzle and `postgres.js`.
 *
 * One method carries the whole design: {@link PostgresSink.applyBatch} runs
 * delete-then-insert-then-advance inside a single transaction. Atomic, so a crash
 * cannot leave a cursor claiming blocks whose rows are missing. Idempotent, because
 * the delete covers exactly the block range the inserts land in, and the primary
 * key is `(block_hash, log_index)`.
 *
 * The typed rows ride the cascade: deleting an `event_log` row deletes the decoded
 * row that hangs off it, so this file never has to enumerate twenty-six tables to
 * undo a range. The foreign keys that make that true are declared in the files
 * under `sql/`, which are also what {@link PostgresSink.applySchema} applies.
 *
 * Requirements: 12.6, 24.4
 */

import { and, desc, gte, lt, lte, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import type { IndexedEventName } from "./events.js";
import type { BlockRow, CursorState, EventSink, WriteBatch } from "./sink.js";
import { eventLog, indexedBlock, indexerCursor, TYPED_TABLES } from "./schema.js";

/**
 * Rows per insert statement.
 *
 * Postgres caps a statement at 65535 bind parameters. The widest table here has
 * thirteen columns, so 500 rows is roughly a tenth of the ceiling — comfortable at
 * a 2000-block chunk on a busy range, and small enough that one oversized batch
 * cannot produce a statement the server refuses.
 */
const INSERT_CHUNK = 500;

/**
 * The directory of SQL files applied to the database, resolved relative to this
 * module. Every `.sql` file in it is applied in lexical order, so a later file may
 * rely on what an earlier one declared and a new file is added without touching
 * this module.
 */
const SCHEMA_SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");

/** The SQL files, in the order they are applied. */
export async function schemaFiles(): Promise<readonly string[]> {
  const names = (await readdir(SCHEMA_SQL_DIR)).filter((name) => name.endsWith(".sql")).sort();
  return names.map((name) => join(SCHEMA_SQL_DIR, name));
}

const chunked = <T>(rows: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let start = 0; start < rows.length; start += size) out.push(rows.slice(start, start + size));
  return out;
};

export interface PostgresSinkOptions {
  /** Connections in the pool. One writer needs very few. */
  readonly max?: number;
  readonly connectTimeoutSeconds?: number;
}

export class PostgresSink implements EventSink {
  private readonly client: postgres.Sql;
  private readonly db: PostgresJsDatabase;

  private constructor(client: postgres.Sql, db: PostgresJsDatabase) {
    this.client = client;
    this.db = db;
  }

  /**
   * Opens a connection pool. Does not connect eagerly, so construction cannot fail
   * on a database that is merely slow to come up.
   */
  static open(databaseUrl: string, options: PostgresSinkOptions = {}): PostgresSink {
    const client = postgres(databaseUrl, {
      max: options.max ?? 4,
      connect_timeout: options.connectTimeoutSeconds ?? 10,
      // Every hex column is text and every amount is `numeric`, both of which this
      // service reads as strings and converts explicitly. Leaving the default
      // transforms alone keeps that predictable.
      onnotice: () => {},
    });
    return new PostgresSink(client, drizzle(client));
  }

  /**
   * Applies the schema. Guarded throughout, so running it on every start — and from
   * several replicas at once — is a no-op rather than a race.
   */
  async applySchema(): Promise<void> {
    for (const file of await schemaFiles()) {
      const text = await readFile(file, "utf8");
      // Each file is several statements, which the extended protocol will not carry,
      // so it goes over the simple protocol. The text is a tracked file in this
      // repository and carries no interpolation, so there is no injection surface.
      await this.client.unsafe(text).simple();
    }
  }

  /** True when the database answers. Used by the readiness probe. */
  async ping(): Promise<boolean> {
    try {
      await this.client`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async readCursor(stream: string): Promise<CursorState | null> {
    const rows = await this.db
      .select()
      .from(indexerCursor)
      .where(sql`${indexerCursor.stream} = ${stream}`)
      .limit(1);
    const found = rows.at(0);
    if (found === undefined) return null;
    return {
      lastBlock: found.lastBlock,
      lastBlockHash: found.lastBlockHash,
      reorgCount: found.reorgCount,
    };
  }

  async readBlockHashes(from: number, to: number): Promise<ReadonlyMap<number, string>> {
    const rows = await this.db
      .select({ blockNumber: indexedBlock.blockNumber, blockHash: indexedBlock.blockHash })
      .from(indexedBlock)
      .where(and(gte(indexedBlock.blockNumber, from), lte(indexedBlock.blockNumber, to)));
    return new Map(rows.map((row) => [row.blockNumber, row.blockHash]));
  }

  async readRecentBlocks(before: number, limit: number): Promise<readonly BlockRow[]> {
    return this.db
      .select({
        blockNumber: indexedBlock.blockNumber,
        blockHash: indexedBlock.blockHash,
        logCount: indexedBlock.logCount,
      })
      .from(indexedBlock)
      .where(lt(indexedBlock.blockNumber, before))
      .orderBy(desc(indexedBlock.blockNumber))
      .limit(limit);
  }

  /**
   * Delete the range, write the range, advance the cursor. One transaction.
   *
   * The order matters. Deleting first is what makes the write idempotent and what
   * corrects a reorganisation; advancing the cursor last is what guarantees the
   * cursor never claims a block whose rows are not there.
   */
  async applyBatch(batch: WriteBatch): Promise<void> {
    await this.db.transaction(async (tx) => {
      // The cascade takes every decoded row with each envelope, so this one delete
      // is the whole undo.
      await tx
        .delete(eventLog)
        .where(and(gte(eventLog.blockNumber, batch.deleteFrom), lte(eventLog.blockNumber, batch.deleteTo)));
      await tx
        .delete(indexedBlock)
        .where(
          and(gte(indexedBlock.blockNumber, batch.deleteFrom), lte(indexedBlock.blockNumber, batch.deleteTo)),
        );

      for (const group of chunked(batch.blocks, INSERT_CHUNK)) {
        await tx
          .insert(indexedBlock)
          .values(group.map((block) => ({ ...block })))
          .onConflictDoUpdate({
            target: indexedBlock.blockNumber,
            set: { blockHash: sql`excluded.block_hash`, logCount: sql`excluded.log_count` },
          });
      }

      for (const group of chunked(batch.events, INSERT_CHUNK)) {
        await tx
          .insert(eventLog)
          .values(group.map((write) => ({ ...write.log })))
          .onConflictDoNothing();
      }

      // Grouped by event so each table takes one statement per chunk rather than one
      // per row.
      const byEvent = new Map<IndexedEventName, Record<string, unknown>[]>();
      for (const write of batch.events) {
        const bucket = byEvent.get(write.typed.event);
        if (bucket === undefined) byEvent.set(write.typed.event, [{ ...write.typed.values }]);
        else bucket.push({ ...write.typed.values });
      }

      for (const [event, values] of byEvent) {
        const table = TYPED_TABLES[event];
        for (const group of chunked(values, INSERT_CHUNK)) {
          // The one cast in the write path. `rows.ts` already checked each value
          // object against this table's own inferred insert type at the point it was
          // built; what is lost here is only the query builder's ability to re-derive
          // that pairing from a value it resolved at run time.
          await tx
            .insert(table)
            .values(group as never)
            .onConflictDoNothing();
        }
      }

      await tx
        .insert(indexerCursor)
        .values({
          stream: batch.stream,
          lastBlock: batch.cursor.lastBlock,
          lastBlockHash: batch.cursor.lastBlockHash,
          reorgCount: batch.cursor.reorgCount,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: indexerCursor.stream,
          set: {
            lastBlock: sql`excluded.last_block`,
            lastBlockHash: sql`excluded.last_block_hash`,
            reorgCount: sql`excluded.reorg_count`,
            updatedAt: sql`now()`,
          },
        });
    });
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}
