/**
 * `endpoint_health` against a real PostgreSQL server.
 *
 * The rotation's own state machine is pure and is covered by `endpoints.test.mjs`
 * through a recorder. What that cannot reach is the half that only exists inside the
 * database: the upsert's conflict target, and whether reading the rows back yields
 * the endpoint the last run was actually using. Those are the parts a restart
 * depends on, so they are exercised against a server or not at all. There is no
 * in-memory twin here on purpose, because a twin would be different code answering
 * the same question and would prove nothing about the SQL.
 *
 * **Nothing is left behind.** Every test runs inside a transaction that is rolled
 * back, so the shared database ends exactly as it was found, which is what lets this
 * run beside a live Watcher without disturbing it.
 *
 * Skips with a reason when no database is reachable, so a machine without one still
 * gets a green suite rather than a red herring.
 *
 * Requirements: 20.11, 20.7
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";

import postgres from "postgres";

import { activeEndpointOf, createEndpointStore, loadEndpointHealth } from "../dist/db/endpoint-store.js";
import { createRotationState, createEndpointRotation } from "../dist/endpoints.js";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../dist/db/schema.js";

/** The database URL, from the environment or from the repository-root `.env`. */
function resolveDatabaseUrl() {
  const fromEnvironment = process.env.DATABASE_URL?.trim();
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment;
  try {
    const text = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
    // The file was authored on Windows, so the value carries a carriage return.
    const line = /^DATABASE_URL=(.*)$/m.exec(text);
    const value = line?.[1]?.trim();
    return value === undefined || value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

const databaseUrl = resolveDatabaseUrl();
const sql = databaseUrl === null ? null : postgres(databaseUrl, { max: 1, onnotice: () => {} });

let reachable = false;
if (sql !== null) {
  try {
    await sql`SELECT 1`;
    reachable = true;
  } catch {
    reachable = false;
  }
}
const skip = reachable ? false : "no PostgreSQL reachable through DATABASE_URL";

after(async () => {
  if (sql !== null) await sql.end({ timeout: 5 });
});

/**
 * The drizzle handle the store is given, over the same single connection the
 * `BEGIN` and `ROLLBACK` below travel on.
 *
 * `sql.begin` hands its callback a transaction object that drizzle's postgres-js
 * driver does not accept, so the transaction is opened explicitly instead. The pool
 * is pinned to one connection, which is what makes that sound: every statement here,
 * the store's included, runs on the connection holding the open transaction.
 */
const db = sql === null ? null : drizzle(sql, { schema });

/**
 * Runs one body inside a transaction that is always rolled back, whether the body
 * passed, failed, or threw. A failure is rethrown after the rollback, so a failing
 * test reports its own error and still leaves the database untouched.
 */
async function rolledBack(body) {
  await sql.unsafe("BEGIN");
  try {
    await body(db);
  } finally {
    await sql.unsafe("ROLLBACK");
  }
}

/** A chainKey no real row uses, so these tests cannot collide with live data. */
const CHAIN = 1;
const A = "https://endpoint-a.test";
const B = "https://endpoint-b.test";
const C = "https://endpoint-c.test";

test("a failure count is written and read back, so a restart does not forget it", { skip }, async () => {
  await rolledBack(async (db) => {
    const store = createEndpointStore(db);
    const written = await store.record(CHAIN, A, 2, true);
    assert.equal(written.ok, true);

    const rows = await loadEndpointHealth(db);
    assert.equal(rows.ok, true);
    const mine = rows.value.filter((row) => row.endpointUrl === A);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].consecutiveFailures, 2);
    assert.equal(mine[0].active, true);
  });
});

test("the upsert converges on (chainKey, endpointUrl) rather than accumulating rows", { skip }, async () => {
  await rolledBack(async (db) => {
    const store = createEndpointStore(db);
    await store.record(CHAIN, A, 1, true);
    await store.record(CHAIN, A, 2, true);
    await store.record(CHAIN, A, 3, false);

    const rows = await loadEndpointHealth(db);
    const mine = rows.value.filter((row) => row.endpointUrl === A);
    // One row, not three. This is the conflict target doing its job, and it is the
    // assertion no in-memory store could ever make.
    assert.equal(mine.length, 1);
    assert.equal(mine[0].consecutiveFailures, 3);
    assert.equal(mine[0].active, false);
  });
});

test("a rotation leaves exactly one active endpoint for the chain", { skip }, async () => {
  await rolledBack(async (db) => {
    const store = createEndpointStore(db);
    const initial = createRotationState(CHAIN, [A, B, C], 3);
    assert.equal(initial.ok, true);
    const rotation = createEndpointRotation(initial.value, store);

    assert.equal(rotation.active(), A);
    assert.equal(await rotation.moveOn(), true);
    assert.equal(rotation.active(), B);

    const rows = await loadEndpointHealth(db);
    const mine = rows.value.filter((row) => [A, B, C].includes(row.endpointUrl));
    const active = mine.filter((row) => row.active);
    // Two endpoints were written, the one that lost the flag and the one that gained
    // it, and never two actives at once.
    assert.equal(active.length, 1);
    assert.equal(active[0].endpointUrl, B);
    assert.equal(mine.find((row) => row.endpointUrl === A).active, false);
  });
});

test("a restart resumes on the persisted endpoint, not the first configured one", { skip }, async () => {
  await rolledBack(async (db) => {
    const store = createEndpointStore(db);
    await store.record(CHAIN, A, 0, false);
    await store.record(CHAIN, B, 2, true);

    const rows = await loadEndpointHealth(db);
    const resumed = activeEndpointOf(rows.value, CHAIN);
    assert.equal(resumed.url, B);
    assert.equal(resumed.failures, 2);

    // And the rotation rebuilt from it starts where the last run left off, carrying
    // the count, so a known-bad endpoint is not handed a clean slate.
    const state = createRotationState(CHAIN, [A, B, C], 3, resumed.url, resumed.failures);
    assert.equal(state.ok, true);
    assert.equal(state.value.activeIndex, 1);
    assert.equal(state.value.consecutiveFailures, 2);
  });
});

test("noteFailure counts toward the threshold without moving the endpoint", { skip }, async () => {
  await rolledBack(async (db) => {
    const initial = createRotationState(CHAIN, [A, B], 3);
    const rotation = createEndpointRotation(initial.value, createEndpointStore(db));

    assert.equal(await rotation.noteFailure(), false);
    assert.equal(await rotation.noteFailure(), false);
    assert.equal(rotation.active(), A, "still on the same endpoint below the threshold");
    assert.equal(await rotation.noteFailure(), true, "the third failure reaches the threshold");
    assert.equal(rotation.active(), A, "and counting still did not move it; the scan does that");

    const rows = await loadEndpointHealth(db);
    assert.equal(rows.value.find((row) => row.endpointUrl === A).consecutiveFailures, 3);
  });
});

test("the rolled-back transactions left nothing behind", { skip }, async () => {
  const rows = await sql`
    SELECT endpoint_url FROM endpoint_health
     WHERE endpoint_url IN (${A}, ${B}, ${C})`;
  assert.equal(rows.length, 0, "a test row survived its rollback");
});
