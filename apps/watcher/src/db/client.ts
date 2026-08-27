/**
 * The Postgres handle, and the migration runner.
 *
 * `postgres` (postgres.js) is the driver and connects lazily, so building a handle
 * costs nothing and cannot fail — the first query is where an unreachable database
 * shows up, and it shows up as a `TabError` rather than a thrown connection error.
 *
 * ## Why the migration runner is eight lines and not `drizzle-kit`
 *
 * The schema is three tables and two indexes, written once in
 * `drizzle/0000_init.sql` and checked against `schema.ts` by a test. Generating and
 * carrying a migration journal would add a second source of truth and a build step
 * for a shape that is already pinned by the design document. So the runner applies
 * the `.sql` files in lexical order inside one transaction, and every statement is
 * `IF NOT EXISTS`, which makes applying them twice a no-op.
 *
 * Requirements: 20.6, 20.7
 */

import { readFile, readdir } from "node:fs/promises";

import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { causeOf, err, ok, wrap, type Result } from "@tabai/shared";

import { schema } from "./schema.js";
import { describeCause } from "../errors.js";
import type { WatcherConfig } from "../config.js";

/** The postgres.js client type, taken from the factory rather than re-declared. */
export type Sql = ReturnType<typeof postgres>;

/** Drizzle bound to the Watcher's three tables. */
export type WatcherDb = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  readonly db: WatcherDb;
  /** The raw driver, needed by the migration runner and by nothing else. */
  readonly sql: Sql;
  close(): Promise<void>;
}

/** Where the migration `.sql` files live, relative to this module once built. */
const MIGRATIONS_DIR = new URL("../../drizzle/", import.meta.url);

/**
 * Builds the handle. Does not connect.
 *
 * @param databaseUrl a `postgres://` URL
 * @param maxConnections pool ceiling; the Watcher is one process doing small writes
 */
export function createDb(databaseUrl: string, maxConnections = 5): DbHandle {
  const sql = postgres(databaseUrl, { max: maxConnections });
  return {
    db: drizzle(sql, { schema }),
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}

/**
 * The database URL, or an error naming the variable.
 *
 * Persistence is not optional: R20.6 requires durable state, so a Watcher without
 * a database must refuse to start rather than run in memory and lose Settlements on
 * restart.
 */
export function requireDatabaseUrl(config: WatcherConfig): Result<string> {
  if (config.databaseUrl === undefined) {
    return err({
      category: "VALIDATION",
      code: "DATABASE_URL_MISSING",
      message:
        "DATABASE_URL is not set, and the Watcher may not run without durable storage: an in-memory run loses every observed Settlement on restart",
      retryable: false,
    });
  }
  return ok(config.databaseUrl);
}

/**
 * Applies every migration in lexical order inside one transaction.
 *
 * @returns the file names applied, so a caller can log what it did
 */
export async function applyMigrations(sql: Sql): Promise<Result<readonly string[]>> {
  let files: string[];
  try {
    files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
  } catch (error) {
    return err({
      category: "INTERNAL",
      code: "MIGRATIONS_UNREADABLE",
      message: `the migration directory could not be read at ${MIGRATIONS_DIR.pathname}`,
      retryable: false,
      cause: causeOf(error),
    });
  }

  if (files.length === 0) {
    return err({
      category: "INTERNAL",
      code: "MIGRATIONS_EMPTY",
      message: `no .sql migration was found at ${MIGRATIONS_DIR.pathname}, so the schema would silently not exist`,
      retryable: false,
    });
  }

  const statements: { name: string; text: string }[] = [];
  for (const name of files) {
    statements.push({ name, text: await readFile(new URL(name, MIGRATIONS_DIR), "utf8") });
  }

  return wrap(
    async () => {
      await sql.begin(async (tx) => {
        for (const statement of statements) await tx.unsafe(statement.text);
      });
      return files;
    },
    (error) => ({
      category: "UPSTREAM",
      code: "MIGRATION_FAILED",
      message: "the migration transaction was rolled back",
      retryable: true,
      cause: describeCause(error),
    }),
  );
}
