/**
 * The read queries, against a real PostgreSQL server and the rows the indexer put
 * there.
 *
 * `MemorySink` lets the indexer's logic be tested without a database because the
 * interesting part of a write is chunking and idempotence. The interesting part of a
 * *read* here is the SQL itself — five `DISTINCT ON` reductions, two `NOT EXISTS`
 * anti-joins, and a row-tuple comparison for the cursor — and none of that is
 * exercised at all by anything other than a server executing it. So these tests
 * connect, or they skip. There is no in-memory twin, because a twin would be
 * different code answering the same question and would prove nothing about the SQL.
 *
 * **This file never writes.** Every assertion is against the rows already indexed
 * off the live deployment, so running it cannot disturb the database. The seeded
 * fixtures that exercise the settlement and credit paths live in `routes.test.ts`,
 * which writes through the real sink and cleans up after itself.
 *
 * What that division buys is the half of the coverage that is easiest to skip:
 * **eleven of the seventeen indexed events have no live instance**, because a Service
 * is registered while no Settlement has been verified. So the empty result set is
 * not an edge case here, it is the normal state of most of the schema, and it is
 * asserted directly rather than assumed to fall out.
 *
 * Requirements: 24.1, 24.3, 24.4, 24.7, 11.8, 11.9
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { PostgresReads } from "../src/queries.js";
import { DEFAULT_STREAM } from "../src/sink.js";

/**
 * The database URL, from the environment or from the repository-root `.env`.
 *
 * The `.env` fallback is what makes these tests runnable by hand without exporting
 * anything first, and it is absent in CI — the file is untracked — so the suite skips
 * there rather than failing. `DATABASE_URL` is declared in `.env.example`, which is
 * what the environment completeness gate checks against.
 */
function resolveDatabaseUrl(): string | null {
  const fromEnvironment = process.env.DATABASE_URL?.trim();
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment;
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const text = readFileSync(join(root, ".env"), "utf8");
    const line = /^DATABASE_URL=(.*)$/m.exec(text);
    const value = line?.[1]?.trim();
    return value === undefined || value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

const databaseUrl = resolveDatabaseUrl();
const reads = databaseUrl === null ? null : PostgresReads.open(databaseUrl);
const reachable = reads === null ? false : await reads.ping();
if (reads !== null && !reachable) await reads.close();

/**
 * Every assertion below reads rows the indexer put there, so an index that has never
 * ticked is a skip with a reason and not a failure. The pool is closed in `after`,
 * whatever any test did, so the runner can always exit.
 */
const indexed =
  reachable &&
  reads !== null &&
  (await reads.horizon(DEFAULT_STREAM)).lastBlock !== null &&
  (await reads.serviceRegistrations(1, null)).length > 0;
const skip = !reachable
  ? "no PostgreSQL reachable through DATABASE_URL"
  : !indexed
    ? "the registry index is empty; run `pnpm --filter @tabai/registry index:once` first"
    : false;

after(async () => {
  if (reachable && reads !== null) await reads.close();
});

/** Narrows the module-level handle for a test body that only runs when it exists. */
const database = (): PostgresReads => {
  if (reads === null) throw new Error("test: no database handle");
  return reads;
};

/** An address and a word that nothing on chain has ever used. */
const UNKNOWN_AGENT = `0x${"ee".repeat(20)}`;
const UNKNOWN_WORD = `0x${"ee".repeat(32)}`;

test("the horizon reports how far the indexer has read", { skip }, async () => {
  const horizon = await database().horizon(DEFAULT_STREAM);
  assert.equal(horizon.stream, DEFAULT_STREAM);
  assert.ok(horizon.lastBlock !== null && horizon.lastBlock > 0, "the stream has ticked");
  assert.match(horizon.lastBlockHash ?? "", /^0x[0-9a-f]{64}$/);
  assert.equal(horizon.reorgCount, 0);
});

test("an unknown stream reports a null horizon rather than a zero one", { skip }, async () => {
  const horizon = await database().horizon("no-such-stream");
  // Null and not zero: zero would read as "the indexer is at the genesis block",
  // which is a different claim from "this stream has never run".
  assert.deepEqual(horizon, {
    stream: "no-such-stream",
    lastBlock: null,
    lastBlockHash: null,
    reorgCount: 0,
    updatedAt: null,
  });
});

// ------------------------------------------------------------ service directory

test("the directory serves the registered Service with its provenance", { skip }, async () => {
  const registrations = await database().serviceRegistrations(50, null);
  assert.ok(registrations.length >= 1, "at least one Service is registered on chain");

  const registration = registrations[0];
  assert.notEqual(registration, undefined);
  if (registration === undefined) return;

  assert.match(registration.serviceId, /^0x[0-9a-f]{64}$/);
  assert.match(registration.operator, /^0x[0-9a-f]{40}$/);
  // Every Service registers at the Permissionless Tier and reaches Curated only
  // through the 48-hour timelock. (R11.2)
  assert.equal(registration.tier, 0);
  assert.equal(registration.tierName, "Permissionless");
  // Six hours, the registry default. (R16.4)
  assert.equal(registration.settlementWindowSeconds, 21_600);
  // The provenance is what makes the row checkable against the chain rather than
  // believed.
  assert.match(registration.creditcoin.blockHash, /^0x[0-9a-f]{64}$/);
  assert.match(registration.creditcoin.txHash, /^0x[0-9a-f]{64}$/);
  assert.ok(registration.creditcoin.blockNumber > 0);
});

test("prices are the latest per Service, Asset, and tool", { skip }, async () => {
  const registrations = await database().serviceRegistrations(50, null);
  const ids = registrations.map((row) => row.serviceId);
  const prices = await database().toolPrices(ids);

  assert.ok(prices.length >= 1);
  // One row per (asset, tool) triple, never one per emitted event: a re-priced tool
  // must not appear twice with two different figures.
  const keys = prices.map((row) => `${row.serviceId}:${row.asset}:${row.tool}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const price of prices) {
    // Integer base units, as a string. A price through a float is a wrong price.
    assert.match(price.baseUnits, /^\d+$/);
    assert.equal(typeof price.baseUnits, "string");
  }
});

test("collections resolve per (chainKey, collection) and carry their kind", { skip }, async () => {
  const registrations = await database().serviceRegistrations(50, null);
  const ids = registrations.map((row) => row.serviceId);
  const collections = await database().collections(ids);

  assert.ok(collections.length >= 1);
  const pairs = collections.map((row) => `${row.chainKey}:${row.collection}`);
  assert.equal(new Set(pairs).size, pairs.length, "a Collection Address resolves to one Service");

  // Both kinds exist on chain, and the distinction is load-bearing: a deposit to a
  // Bond address funds stake, and the same shape of transfer to a Tab address pays a
  // tab. Conflating them would credit real money to the wrong thing.
  const kinds = new Set(collections.map((row) => row.kindName));
  assert.ok(kinds.has("Tab"), "a Tab Collection Address is registered");
  assert.ok(kinds.has("Bond"), "a Bond Collection Address is registered");
  for (const collection of collections) {
    // chainKey stays a decimal string, because it is a uint64.
    assert.match(collection.chainKey, /^\d+$/);
    assert.match(collection.asset, /^0x[0-9a-f]{40}$/);
  }
});

test("a queued change is reported as pending and never as applied", { skip }, async () => {
  const registrations = await database().serviceRegistrations(50, null);
  const ids = registrations.map((row) => row.serviceId);

  // This test used to assert that both answers were empty, which was a claim about
  // the chain rather than about this query, and it stopped being true the moment a
  // curation promotion was queued on 2026-09-06. What is this query's own property,
  // and what R11.7 actually requires, is that a queued change is pending and is not
  // applied until its hold elapses. So the subject is the relation between the two
  // answers, which holds whether or not anything happens to be queued today.
  const pending = await database().pendingChanges(ids);
  const applied = await database().appliedChanges(ids);

  for (const change of pending) {
    assert.ok(ids.includes(change.serviceId), "a pending change names a registered Service");
    assert.ok(change.eta !== null && change.eta > 0, "a pending change carries an ETA");
    assert.ok(
      !applied.some((row) => row.changeId === change.changeId),
      "a change cannot be pending and applied at once",
    );
  }
  for (const change of applied) {
    assert.ok(ids.includes(change.serviceId), "an applied change names a registered Service");
  }
});

test("a Service with no proven deposit reports no Bond rather than a zero", { skip }, async () => {
  // Keyed on a Service id nothing has ever deposited against. The registered Service
  // now holds a real proven deposit on chain, so asking about *it* would assert the
  // chain's history rather than this query's behaviour. An absent row is the honest
  // answer for a Service with no ledger: a zero would claim one exists and holds
  // nothing.
  assert.deepEqual(await database().bondLedgers([UNKNOWN_WORD]), []);
  assert.deepEqual(await database().serviceBonds([UNKNOWN_WORD]), []);
});

test("an empty id set returns nothing rather than everything", { skip }, async () => {
  // A directory page with no rows hydrates against an empty id list, and a query
  // that dropped the filter on an empty array would return the whole table.
  assert.deepEqual(await database().toolPrices([]), []);
  assert.deepEqual(await database().collections([]), []);
  assert.deepEqual(await database().appliedChanges([]), []);
  assert.deepEqual(await database().pendingChanges([]), []);
  assert.deepEqual(await database().serviceBonds([]), []);
});

test("an unregistered serviceId is absent, not empty-shaped", { skip }, async () => {
  assert.equal(await database().serviceRegistration(UNKNOWN_WORD), null);
});

// ------------------------------------------------ the eleven events with no instance

test("the settlement, clearing, and credit reads answer empty for what they do not hold", { skip }, async () => {
  // **This test no longer asserts an empty chain, and that is the point.** It was
  // written while nothing had ever settled, so "the feed is empty" and "an unknown
  // Agent has no rows" were the same assertion. A Verified Settlement now exists on
  // CC3 Testnet, so the first is permanently false and only the second was ever the
  // property worth holding: a read must answer empty rather than absent, malformed,
  // or an error, for a subject it genuinely does not hold. Every read below is keyed
  // on something no chain row names.
  assert.deepEqual(await database().clearingLineage(UNKNOWN_WORD), []);
  assert.deepEqual(await database().declinedObservations(UNKNOWN_AGENT), []);
  assert.deepEqual(await database().agentAssetTotals(UNKNOWN_AGENT), []);
  assert.deepEqual(await database().tabObservations(UNKNOWN_AGENT), []);
  assert.deepEqual(await database().delinquencies(UNKNOWN_AGENT), []);
  assert.deepEqual(await database().boundAddresses(UNKNOWN_AGENT), []);
  // And a filter naming an Agent nothing settled for pages cleanly rather than
  // falling back to the whole feed, which is the failure a dropped predicate makes.
  assert.deepEqual(await database().settlements({ agent: UNKNOWN_AGENT }, 10, null), []);
});

test("an unknown replay key is absent", { skip }, async () => {
  assert.equal(await database().settlementByReplayKey(UNKNOWN_WORD), null);
});

test("a filter that matches nothing pages cleanly", { skip }, async () => {
  const filtered = await database().settlements(
    { agent: UNKNOWN_AGENT, serviceId: UNKNOWN_WORD, asset: UNKNOWN_AGENT, chainKey: "3" },
    10,
    null,
  );
  assert.deepEqual(filtered, []);
  // And a cursor into an empty feed is not an error either.
  assert.deepEqual(
    await database().settlements({}, 10, { blockNumber: 1, logIndex: 0 }),
    [],
  );
});
