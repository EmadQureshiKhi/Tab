/**
 * Applies `sql/0001_registry_schema.sql` and exits.
 *
 * The service applies the same file on start, so this exists for the case where the
 * schema has to land before anything runs — a first deployment, or checking the SQL
 * against a real server without starting an indexer. Every statement in the file is
 * guarded, so running this and then starting the service is not a conflict.
 *
 * Reads `DATABASE_URL` and prints no part of it.
 *
 * Requirements: 12.6, 24.4
 */

import { loadConfig, readProcessEnvironment } from "./config.js";
import { PostgresSink } from "./postgres-sink.js";

const config = loadConfig(readProcessEnvironment());
const sink = PostgresSink.open(config.databaseUrl);

try {
  await sink.applySchema();
  console.log("registry: schema applied");
} catch (error) {
  console.error(`registry: schema could not be applied — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await sink.close();
}
