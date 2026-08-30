/**
 * Persistence schema.
 *
 * Two sources describe these tables: `src/db/schema.ts`, which the code queries
 * through, and `drizzle/0000_init.sql`, which actually creates them. Drift between
 * them is silent at compile time and fatal at run time, so this file asserts both
 * against the shape design section 8.7 fixes, and then against each other.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { getTableConfig } from "drizzle-orm/pg-core";

import {
  SETTLEMENT_STATES,
  bytesToHex,
  chainCursor,
  endpointHealth,
  hexToBytes,
  observedSettlement,
} from "../dist/index.js";

const MIGRATION = readFileSync(new URL("../drizzle/0000_init.sql", import.meta.url), "utf8");
const MIGRATION_0001 = readFileSync(new URL("../drizzle/0001_observation.sql", import.meta.url), "utf8");

/**
 * Column names of one table as the migrations build it: the `CREATE TABLE` block
 * first, then anything a later migration appended, which is the order Postgres
 * itself ends up with because `ALTER TABLE ... ADD COLUMN` appends.
 */
function migrationColumns(tableName) {
  const start = MIGRATION.indexOf(`CREATE TABLE IF NOT EXISTS ${tableName} (`);
  assert.notEqual(start, -1, `${tableName} is not created by the migration`);
  const body = MIGRATION.slice(MIGRATION.indexOf("(", start) + 1, MIGRATION.indexOf("\n);", start));
  const created = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("--") && !line.startsWith("PRIMARY KEY"))
    .map((line) => line.split(/\s+/)[0]);
  const added = [
    ...MIGRATION_0001.matchAll(
      new RegExp(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS (\\w+)`, "g"),
    ),
  ].map((match) => match[1]);
  return [...created, ...added];
}

const columnNames = (table) => getTableConfig(table).columns.map((column) => column.name);
const columnByName = (table, name) =>
  getTableConfig(table).columns.find((column) => column.name === name);

test("observed_settlement carries exactly the columns the design fixes, in order", () => {
  const config = getTableConfig(observedSettlement);
  assert.equal(config.name, "observed_settlement");
  assert.deepEqual(columnNames(observedSettlement), [
    "replay_key",
    "chain_key",
    "block_height",
    "tx_index",
    "log_index",
    "source_tx_hash",
    "asset",
    "payer_address",
    "collection_address",
    "service_id",
    "amount",
    "state",
    "attested_digest",
    "clearing_id",
    "proof_source",
    "local_root",
    "received_root",
    "submit_attempts",
    "next_attempt_at",
    "cc_tx_hash",
    "last_error_category",
    "observed_at",
    "updated_at",
    // Appended by `0001_observation.sql`, in that file's order.
    "emitter_address",
    "clearing_state",
  ]);
});

test("the observation migration is additive and guarded, so it cannot rebuild the table", () => {
  assert.equal((MIGRATION_0001.match(/CREATE TABLE/g) ?? []).length, 0);
  assert.equal((MIGRATION_0001.match(/DROP /g) ?? []).length, 0);
  const alters = MIGRATION_0001.match(/ALTER TABLE \w+ ADD COLUMN/g) ?? [];
  const guarded = MIGRATION_0001.match(/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS/g) ?? [];
  assert.equal(alters.length, 2);
  assert.equal(guarded.length, alters.length);
});

test("the replay key is the primary key, so a duplicate observation collides with itself", () => {
  const replayKey = columnByName(observedSettlement, "replay_key");
  assert.equal(replayKey.primary, true);
  assert.equal(replayKey.getSQLType(), "bytea");
  assert.equal(getTableConfig(observedSettlement).primaryKeys.length, 0, "no composite key is needed");
});

test("tx_index is the only nullable identity field, because it is unknown until proof material exists", () => {
  assert.equal(columnByName(observedSettlement, "tx_index").notNull, false);
  for (const name of ["chain_key", "block_height", "log_index", "source_tx_hash", "amount", "state"]) {
    assert.equal(columnByName(observedSettlement, name).notNull, true, `${name} must be NOT NULL`);
  }
});

test("amounts are exact integers and never floating point", () => {
  assert.equal(columnByName(observedSettlement, "amount").getSQLType(), "numeric(39, 0)");
  assert.equal(columnByName(observedSettlement, "amount").dataType, "bigint");
});

test("every hash and address is bytea, so one key has one spelling", () => {
  for (const name of [
    "replay_key",
    "source_tx_hash",
    "asset",
    "payer_address",
    "collection_address",
    "service_id",
    "attested_digest",
    "clearing_id",
    "local_root",
    "received_root",
    "cc_tx_hash",
    "emitter_address",
  ]) {
    assert.equal(columnByName(observedSettlement, name).getSQLType(), "bytea", name);
  }
});

test("state is text, and the set it may hold is the one state.ts owns", () => {
  assert.equal(columnByName(observedSettlement, "state").getSQLType(), "text");
  // The migration comment is the schema's own record of the permitted set. If a
  // state is added to `state.ts` and not to that comment, they have drifted.
  for (const state of SETTLEMENT_STATES) {
    assert.ok(MIGRATION.includes(state), `${state} is missing from the migration's state comment`);
  }
  assert.ok(MIGRATION.includes(SETTLEMENT_STATES.join("|")));
});

test("the two indexes are the two hot queries, on the documented columns", () => {
  const indexes = getTableConfig(observedSettlement).indexes.map((entry) => ({
    name: entry.config.name,
    columns: entry.config.columns.map((column) => column.name),
  }));
  assert.deepEqual(indexes, [
    { name: "observed_state_idx", columns: ["state", "next_attempt_at"] },
    { name: "observed_chain_block_idx", columns: ["chain_key", "block_height"] },
  ]);
  assert.ok(MIGRATION.includes("CREATE INDEX IF NOT EXISTS observed_state_idx ON observed_settlement (state, next_attempt_at)"));
  assert.ok(
    MIGRATION.includes(
      "CREATE INDEX IF NOT EXISTS observed_chain_block_idx ON observed_settlement (chain_key, block_height)",
    ),
  );
});

test("chain_cursor records how far each chain is read and whether it still attests", () => {
  const config = getTableConfig(chainCursor);
  assert.equal(config.name, "chain_cursor");
  assert.deepEqual(columnNames(chainCursor), [
    "chain_key",
    "last_processed_block",
    "last_attested_height",
    "attesting",
    "updated_at",
  ]);
  assert.equal(columnByName(chainCursor, "chain_key").primary, true);
  assert.equal(columnByName(chainCursor, "attesting").notNull, true);
  assert.equal(columnByName(chainCursor, "last_processed_block").notNull, true);
});

test("endpoint_health is keyed on the pair, so a failure count belongs to one endpoint", () => {
  const config = getTableConfig(endpointHealth);
  assert.equal(config.name, "endpoint_health");
  assert.deepEqual(columnNames(endpointHealth), [
    "chain_key",
    "endpoint_url",
    "consecutive_failures",
    "active",
  ]);
  assert.equal(config.primaryKeys.length, 1);
  assert.deepEqual(
    config.primaryKeys[0].columns.map((column) => column.name),
    ["chain_key", "endpoint_url"],
  );
});

test("the migration and the Drizzle schema describe the same three tables", () => {
  for (const table of [observedSettlement, chainCursor, endpointHealth]) {
    const name = getTableConfig(table).name;
    assert.deepEqual(migrationColumns(name), columnNames(table), `${name} has drifted`);
  }
});

test("the migration is idempotent, so applying it twice is a no-op", () => {
  const creates = MIGRATION.match(/CREATE (TABLE|INDEX)/g) ?? [];
  const guarded = MIGRATION.match(/CREATE (TABLE|INDEX) IF NOT EXISTS/g) ?? [];
  assert.equal(creates.length, 5, "three tables and two indexes");
  assert.equal(guarded.length, creates.length);
});

test("hex and bytes round-trip, and a malformed key is refused rather than truncated", () => {
  const key = "0x000000000000000300000000018ab73a000000000000002a0000000000000007";
  assert.equal(bytesToHex(hexToBytes(key)), key);
  assert.equal(hexToBytes(key).length, 32);
  assert.throws(() => hexToBytes("0xabc"), TypeError);
  assert.throws(() => hexToBytes("abcd"), TypeError);
  assert.throws(() => hexToBytes("0xzz"), TypeError);
});
