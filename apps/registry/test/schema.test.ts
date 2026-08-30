/**
 * The SQL and the Drizzle schema must describe the same database.
 *
 * Two files describe one schema: `sql/0001_registry_schema.sql` is applied to the
 * database, and `src/schema.ts` is what every query is written against. Nothing in a
 * type checker connects them. A column renamed in one and not the other compiles
 * cleanly, applies cleanly, and then fails at run time on the first insert — or
 * worse, on the first read, months of rows later.
 *
 * So these tests parse the SQL and compare it against the Drizzle definitions: every
 * table on both sides, every column on both sides, in order. They also assert the
 * two invariants the whole design rests on — that every typed table keys on
 * `(block_hash, log_index)` and cascades from `event_log` — and that every event this
 * service indexes has a table to land in.
 *
 * Requirements: 12.6, 24.4
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import { INDEXED_EVENT_NAMES } from "../src/events.js";
import { BOOKKEEPING_TABLES, TYPED_TABLES } from "../src/schema.js";

/**
 * Every migration, concatenated in lexical order.
 *
 * The schema is applied as a sequence of guarded files rather than one, so reading
 * only the first would compare the Drizzle schema against a fraction of the SQL and
 * report agreement it had not checked. Read from the directory rather than a list,
 * so a migration added later is covered without editing this test.
 */
const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");
const sqlText = readdirSync(SQL_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => readFileSync(join(SQL_DIR, file), "utf8"))
  .join("\n");

/** Keywords that begin a table constraint rather than a column. */
const CONSTRAINT_KEYWORDS = new Set(["primary", "foreign", "constraint", "check", "unique", "exclude"]);

interface SqlTable {
  readonly name: string;
  readonly columns: readonly string[];
  readonly body: string;
}

/**
 * Parses every `CREATE TABLE registry.<name> ( ... );` in the file.
 *
 * Deliberately simple. It reads to the matching close parenthesis, drops comment
 * lines, splits on top-level commas, and treats the first token of each entry as a
 * column name unless it opens a constraint. The file is written to stay inside what
 * this understands; anything more elaborate fails the test rather than being
 * mis-read.
 */
function parseTables(text: string): readonly SqlTable[] {
  const tables: SqlTable[] = [];
  const pattern = /CREATE TABLE IF NOT EXISTS registry\.([a-z_]+)\s*\(/g;

  for (const match of text.matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let cursor = open; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          close = cursor;
          break;
        }
      }
    }
    assert.notEqual(close, -1, `unterminated CREATE TABLE for ${match[1]}`);

    const body = text.slice(open + 1, close);
    // Comments come out before the split, because a comma inside one would otherwise
    // look like a column boundary.
    const withoutComments = body
      .split("\n")
      .map((line) => {
        const comment = line.indexOf("--");
        return comment === -1 ? line : line.slice(0, comment);
      })
      .join("\n");
    const entries: string[] = [];
    let depthInBody = 0;
    let current = "";
    for (const character of withoutComments) {
      if (character === "(") depthInBody += 1;
      if (character === ")") depthInBody -= 1;
      if (character === "," && depthInBody === 0) {
        entries.push(current);
        current = "";
        continue;
      }
      current += character;
    }
    entries.push(current);

    const columns: string[] = [];
    for (const entry of entries) {
      const cleaned = entry
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("--"))
        .join(" ")
        .trim();
      if (cleaned.length === 0) continue;
      const first = cleaned.split(/\s+/)[0] ?? "";
      if (CONSTRAINT_KEYWORDS.has(first.toLowerCase())) continue;
      columns.push(first);
    }

    tables.push({ name: match[1] ?? "", columns, body });
  }

  return tables;
}

const sqlTables = parseTables(sqlText);
const sqlByName = new Map(sqlTables.map((table) => [table.name, table]));

const drizzleTables = [
  ...Object.values(BOOKKEEPING_TABLES),
  ...Object.values(TYPED_TABLES),
].map((table) => {
  const config = getTableConfig(table);
  return {
    name: config.name,
    schema: config.schema,
    columns: config.columns.map((column) => column.name),
  };
});

test("the parser found every table, so the comparison is not vacuous", () => {
  // 3 bookkeeping tables and 28 typed tables: the original 17, plus HistoryExtended,
  // AuthorisationSet, the seven Bond ledger events the credit reads replay,
  // BondDepositRecorded, which is the Bond branch's counterpart to SettlementRecorded,
  // and PrepaidConsumed, which is the counterpart to SettlementApplied.to_prepaid.
  assert.equal(sqlTables.length, 31, "3 bookkeeping tables and 28 typed tables");
  assert.equal(drizzleTables.length, 31);
});

test("every table lives under the registry schema", () => {
  assert.match(sqlText, /CREATE SCHEMA IF NOT EXISTS registry;/);
  for (const table of drizzleTables) {
    assert.equal(table.schema, "registry", `${table.name} is declared outside the registry schema`);
  }
});

test("the SQL and the Drizzle schema declare the same tables", () => {
  assert.deepEqual(
    drizzleTables.map((table) => table.name).sort(),
    sqlTables.map((table) => table.name).sort(),
  );
});

test("each table declares the same columns in the same order on both sides", () => {
  for (const table of drizzleTables) {
    const fromSql = sqlByName.get(table.name);
    assert.notEqual(fromSql, undefined, `${table.name} has no CREATE TABLE`);
    assert.deepEqual(
      table.columns,
      [...(fromSql?.columns ?? [])],
      `${table.name} columns disagree between src/schema.ts and the SQL`,
    );
  }
});

test("every typed table keys on the envelope pair and cascades from event_log", () => {
  for (const [event, table] of Object.entries(TYPED_TABLES)) {
    const config = getTableConfig(table);
    const fromSql = sqlByName.get(config.name);
    assert.notEqual(fromSql, undefined, `${event} has no SQL table`);
    const body = fromSql?.body ?? "";

    assert.match(body, /PRIMARY KEY \(block_hash, log_index\)/, `${config.name} is not keyed on the envelope pair`);
    assert.match(
      body,
      /FOREIGN KEY \(block_hash, log_index\)\s*REFERENCES registry\.event_log \(block_hash, log_index\) ON DELETE CASCADE/,
      `${config.name} would outlive the log it was decoded from`,
    );

    const primaryKey = config.primaryKeys.at(0);
    assert.notEqual(primaryKey, undefined, `${config.name} declares no primary key in src/schema.ts`);
    assert.deepEqual(
      primaryKey?.columns.map((column) => column.name),
      ["block_hash", "log_index"],
      `${config.name} keys on something other than the envelope pair in src/schema.ts`,
    );
  }
});

test("every indexed event has a table, and no table is orphaned", () => {
  assert.deepEqual(Object.keys(TYPED_TABLES).sort(), [...INDEXED_EVENT_NAMES].sort());
});

test("amount columns carry the exact decimal width of their Solidity type", () => {
  // A settled amount through a float is a wrong number. `numeric(78,0)` is the full
  // decimal width of a uint256 and `numeric(39,0)` of a uint128, so every value round
  // trips exactly.
  assert.match(sqlByName.get("settlement_recorded")?.body ?? "", /amount\s+NUMERIC\(78,0\)/);
  assert.match(sqlByName.get("settlement_applied")?.body ?? "", /applied\s+NUMERIC\(78,0\)/);
  assert.match(sqlByName.get("settlement_applied")?.body ?? "", /open_after\s+NUMERIC\(39,0\)/);
  assert.match(sqlByName.get("provisional_clearing_declined")?.body ?? "", /free_bond\s+NUMERIC\(39,0\)/);
  assert.match(sqlByName.get("tool_price_set")?.body ?? "", /base_units\s+NUMERIC\(78,0\)/);
  // Prepaid credit is a uint128 on the tab, and all three of its figures are the same
  // width, so a consumed amount and the balance it left behind round trip exactly.
  assert.match(sqlByName.get("prepaid_consumed")?.body ?? "", /consumed\s+NUMERIC\(39,0\)/);
  assert.match(sqlByName.get("prepaid_consumed")?.body ?? "", /prepaid_after\s+NUMERIC\(39,0\)/);
  assert.match(sqlByName.get("prepaid_consumed")?.body ?? "", /open_added\s+NUMERIC\(39,0\)/);
});

test("hex columns are constrained by shape, so a malformed value cannot land", () => {
  assert.match(sqlText, /CREATE DOMAIN registry\.hex_address AS TEXT CHECK \(VALUE ~ '\^0x\[0-9a-f\]\{40\}\$'\)/);
  assert.match(sqlText, /CREATE DOMAIN registry\.hex_word AS TEXT CHECK \(VALUE ~ '\^0x\[0-9a-f\]\{64\}\$'\)/);
  // Lowercase only, in both domains, which is why `events.ts` normalises casing
  // rather than leaving it to the caller.
  assert.equal(sqlText.includes("A-F"), false);
});

test("the settlement_recorded table keeps the two log ordinals apart", () => {
  const columns = sqlByName.get("settlement_recorded")?.columns ?? [];
  assert.ok(columns.includes("log_index"), "the envelope ordinal on Creditcoin");
  assert.ok(columns.includes("source_log_index"), "the ordinal within the proved transaction's receipt logs");
  // Eleven event fields plus the two envelope columns.
  assert.equal(columns.length, 13);
});
