/**
 * `pnpm --filter @tabai/watcher db:migrate`
 *
 * Applies every `.sql` file in `drizzle/` in lexical order, inside one
 * transaction. Every statement is `IF NOT EXISTS`, so running it against an
 * already-migrated database is a no-op rather than an error.
 *
 * Exit codes: 0 applied, 1 the database refused, 2 the run could not start.
 */

import { loadWatcherConfig } from "../config.js";
import { applyMigrations, createDb, requireDatabaseUrl } from "../db/client.js";

async function main(): Promise<number> {
  const config = loadWatcherConfig();
  if (!config.ok) {
    console.error(`migrate: ${config.error.code}: ${config.error.message}`);
    return 2;
  }

  const databaseUrl = requireDatabaseUrl(config.value);
  if (!databaseUrl.ok) {
    console.error(`migrate: ${databaseUrl.error.code}: ${databaseUrl.error.message}`);
    return 2;
  }

  const handle = createDb(databaseUrl.value, 1);
  try {
    const applied = await applyMigrations(handle.sql);
    if (!applied.ok) {
      console.error(`migrate: ${applied.error.code}: ${applied.error.message}`);
      if (applied.error.cause !== undefined) {
        console.error(`migrate: cause: ${applied.error.cause.code}: ${applied.error.cause.message}`);
      }
      return 1;
    }
    console.log(`migrate: applied ${applied.value.join(", ")}`);
    return 0;
  } finally {
    await handle.close();
  }
}

process.exitCode = await main();
