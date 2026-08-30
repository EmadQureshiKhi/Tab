/**
 * The read endpoints, over HTTP, against a real PostgreSQL server.
 *
 * `queries.test.ts` asserts the SQL against the rows the live deployment produced,
 * which is a Service registration and nothing else. This file supplies what the
 * chain has not yet: Verified Settlements, a clearing lifecycle, a delinquency and
 * its lift, a proven Bond deposit, and a bound address. Every one of those rows is
 * built by **encoding the contract's own event, decoding it with the service's own
 * decoder, and writing it through the real Postgres sink** — the same three steps a
 * tick performs — so nothing here is hand-shaped data pretending to be a row. The
 * only thing invented is which logs exist.
 *
 * The fixture is written above the indexed span and below the cursor, and is deleted
 * afterwards, so a run leaves the database exactly as it found it.
 *
 * Three claims this file exists for:
 *
 * - **the endpoints answer correctly on an empty result set**, which is the state of
 *   most of this schema today and is asserted before anything is seeded;
 * - **a cursor walk is stable across a page boundary while rows are being written**,
 *   demonstrated by inserting a Settlement above the walk mid-page and showing the
 *   remaining pages are untouched;
 * - **the Credit Limit is reported as unavailable with its reason**, never as a
 *   number that cannot be checked against the chain.
 *
 * Requirements: 24.1, 24.3, 24.4, 24.7, 11.8, 11.9
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { AbiCoder, keccak256 } from "ethers";
import postgres from "postgres";

import { replayKey } from "@tabai/shared";

import { REGISTRY_INTERFACE, decodeLog, type IndexedEventName, type RawLog } from "../src/events.js";
import { encodeCursor } from "../src/cursor.js";
import { PostgresReads } from "../src/queries.js";
import { PostgresSink } from "../src/postgres-sink.js";
import { toTypedInsert } from "../src/rows.js";
import type { CreditChainReader } from "../src/chain-reads.js";
import { createApp } from "../src/server.js";
import type { EventWrite, WriteBatch } from "../src/sink.js";
import type { IndexerStatus } from "../src/service.js";

// ------------------------------------------------------------------ environment

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
 * Two preconditions, each with its own skip reason, so a bare `pnpm test` says why
 * it did nothing. The fixture pays a Service the indexer read off the chain, so an
 * empty index is a skip and not a failure. And the pool is closed in `after`, so a
 * failed assertion can never leave the runner hanging on an open connection.
 */
const indexed =
  reachable && reads !== null && (await reads.serviceRegistrations(1, null)).length > 0;
const skip = !reachable
  ? "no PostgreSQL reachable through DATABASE_URL"
  : !indexed
    ? "the registry index is empty; run `pnpm --filter @tabai/registry index:once` first"
    : false;

after(async () => {
  if (!reachable) return;
  await cleanUp();
  if (reads !== null) await reads.close();
});

/**
 * The probe half of the app's dependencies.
 *
 * A literal rather than a running indexer: this file tests the read routes, and the
 * probes report a *different* fact — this process's own liveness — which has its own
 * meaning and its own owner. The database reachability closure is real.
 */
const IDLE_STATUS: IndexerStatus = {
  stream: "creditcoin",
  running: false,
  primed: true,
  lastBlock: null,
  head: null,
  caughtUp: true,
  reorgCount: 0,
  ticks: 0,
  rowsWritten: 0,
  logsSkipped: 0,
  consecutiveFailures: 0,
  lastError: null,
  lastTickAt: null,
};

const app =
  reads === null
    ? null
    : createApp({ status: () => IDLE_STATUS, databaseReachable: () => reads.ping(), reads });

/**
 * A chain reader that agrees with whatever the index replayed.
 *
 * The app above deliberately has none, which is the shape most of this file asserts.
 * But "no reader" means every cross-check is skipped, so it exercises none of the
 * agreeing path -- and a `bigint` reaching `c.json` on that path answered 500 on
 * every Service with a Bond, live, while this suite stayed green. This stub is the
 * second app below, and it exists so the serialising half is covered too.
 */
const AGREEING_CHAIN: CreditChainReader = {
  blockTimestamp: async () => 1_788_680_820n,
  governance: async () => ({ baseline: 5_000_000n, growthFactorBps: 5_000n }),
  historyCommitment: async () => ({ root: `0x${"00".repeat(32)}`, count: 0 }),
  creditLimit: async () => 0n,
  headroom: async () => 0n,
  assetOpen: async () => 0n,
  delinquentTabCount: async () => 0,
  // The figures the fixture's own `BondFunded` replays to, so the ledger agrees.
  bondLedger: async () => ({ staked: 7_000_000n, reserved: 0n, slashed: 0n, released: 0n }),
};

const chainApp =
  reads === null
    ? null
    : createApp({
        status: () => IDLE_STATUS,
        databaseReachable: () => reads.ping(),
        reads,
        chain: AGREEING_CHAIN,
      });

const request = async (path: string): Promise<Response> => {
  if (app === null) throw new Error("test: no app");
  return app.request(path);
};

// ---------------------------------------------------------------- the fixture
//
// Blocks 5_408_001 to 5_408_007: above the indexed span, below the cursor, so the
// fixture neither collides with a real row nor claims to be ahead of the indexer.

const FIXTURE_FROM = 5_408_001;
const FIXTURE_TO = 5_408_010;
const FIXTURE_STREAM = "test-read-endpoints";

/**
 * A cursor pinned immediately above the fixture's block range.
 *
 * The chain now carries real Verified Settlements, and they sit far above these
 * blocks, so an unfiltered feed is no longer the fixture's feed. Every walk below
 * therefore starts here: keyset pagination returns the rows strictly below a
 * position, so this admits the fixture and excludes everything the chain has
 * produced since. It scopes the assertions without weakening them, because the
 * paging being exercised is the real one rather than a filtered special case.
 */
const FIXTURE_CURSOR = encodeCursor({ blockNumber: FIXTURE_TO + 1, logIndex: 0 });
/** The query fragment that starts a walk inside the fixture. */
const FROM_FIXTURE = `cursor=${encodeURIComponent(FIXTURE_CURSOR)}`;

const AGENT_A = `0x${"11".repeat(20)}`;
const AGENT_B = `0x${"22".repeat(20)}`;
const PAYER_A = `0x${"33".repeat(20)}`;
/** USDC on chainKey 3, and the other accepted Asset on chainKey 1. Both real. */
const ASSET_A = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ASSET_B = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
/** The bonded party, as `Bond` keys its ledger: `keccak256(abi.encode(party, asset))` uses this word. */
const PARTY_A = `0x${"b1".repeat(32)}`;
const SOURCE_TX_1 = `0x${"a1".repeat(32)}`;
const SOURCE_TX_2 = `0x${"a2".repeat(32)}`;
/** Any address; the emitter is provenance the queries never filter on. */
const EMITTER = `0x${"0".repeat(39)}1`;

const CODER = AbiCoder.defaultAbiCoder();

/** `keccak256(abi.encode(agent, serviceId, asset))`, as `TabBook.tabIdOf` computes it. */
const tabIdOf = (agent: string, serviceId: string, asset: string): string =>
  keccak256(CODER.encode(["address", "bytes32", "address"], [agent, serviceId, asset]));

const word = (value: number): string => `0x${value.toString(16).padStart(64, "0")}`;

/** Builds a log exactly as the chain would deliver it, by encoding the event. */
function encodeLog(
  name: IndexedEventName,
  values: readonly unknown[],
  blockNumber: number,
  logIndex: number,
): RawLog {
  const fragment = REGISTRY_INTERFACE.getEvent(name);
  if (fragment === null) throw new Error(`test: no fragment for ${name}`);
  const encoded = REGISTRY_INTERFACE.encodeEventLog(fragment, [...values]);
  return {
    blockNumber,
    blockHash: word(blockNumber),
    transactionHash: word(blockNumber * 1_000 + logIndex),
    transactionIndex: 0,
    index: logIndex,
    address: EMITTER,
    topics: encoded.topics,
    data: encoded.data,
  };
}

/** Decodes and shapes one log the same way a tick does. */
function toWrite(log: RawLog): EventWrite {
  const decoded = decodeLog(log);
  if (decoded === null) throw new Error("test: fixture log did not decode");
  return {
    log: {
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      blockTime: new Date(Date.UTC(2026, 8, 1, 0, log.blockNumber % 60, 0)),
      txHash: log.transactionHash,
      txIndex: log.transactionIndex,
      logIndex: log.index,
      emitter: log.address,
      topic0: log.topics[0] ?? "",
      eventName: decoded.name,
    },
    typed: toTypedInsert(decoded),
  };
}

/** One batch over a block range, shaped as the sink expects. */
function toBatch(writes: readonly EventWrite[], from: number, to: number): WriteBatch {
  const counts = new Map<number, number>();
  for (const write of writes) {
    counts.set(write.log.blockNumber, (counts.get(write.log.blockNumber) ?? 0) + 1);
  }
  const highest = Math.max(...writes.map((write) => write.log.blockNumber));
  return {
    stream: FIXTURE_STREAM,
    deleteFrom: from,
    deleteTo: to,
    blocks: [...counts.entries()].map(([blockNumber, logCount]) => ({
      blockNumber,
      blockHash: word(blockNumber),
      logCount,
    })),
    events: writes,
    // A stream of its own, so the fixture cannot move the real `creditcoin` cursor
    // and cause the indexer to re-scan or skip on its next tick.
    cursor: { lastBlock: highest, lastBlockHash: word(highest), reorgCount: 0 },
  };
}

/** The five replay keys, packed by the shared implementation the contracts mirror. */
const RK = {
  one: replayKey(3n, 21_000_001n, 0n, 0n),
  two: replayKey(3n, 21_000_002n, 0n, 0n),
  three: replayKey(3n, 21_000_003n, 0n, 0n),
  four: replayKey(1n, 8_000_004n, 0n, 0n),
  five: replayKey(3n, 21_000_005n, 0n, 0n),
  six: replayKey(3n, 21_000_006n, 0n, 0n),
  seven: replayKey(3n, 21_000_007n, 0n, 0n),
} as const;

/** The Service every fixture Settlement pays. Read from the chain, never invented. */
let serviceId = "";
let tabA1 = "";
let tabB1 = "";

const cleanUp = async (): Promise<void> => {
  if (databaseUrl === null) return;
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    // The cascade takes every typed row with each envelope, so this is the whole undo.
    await client`DELETE FROM registry.event_log
                  WHERE block_number BETWEEN ${FIXTURE_FROM} AND ${FIXTURE_TO}`;
    await client`DELETE FROM registry.indexed_block
                  WHERE block_number BETWEEN ${FIXTURE_FROM} AND ${FIXTURE_TO}`;
    await client`DELETE FROM registry.indexer_cursor WHERE stream = ${FIXTURE_STREAM}`;
  } finally {
    await client.end({ timeout: 5 });
  }
};

// ------------------------------------------------------- empty, before anything

test("a settlement feed filtered to nothing is an empty page, with the horizon still reported", { skip }, async () => {
  await cleanUp();
  // **Filtered rather than unfiltered, and that is a correction.** This asserted an
  // empty *unfiltered* feed, which held only while nothing had ever settled. A
  // Verified Settlement now exists on chain, so the unfiltered feed is permanently
  // non-empty and the old assertion tested the chain's history rather than this
  // service. What it was always for is the distinction below: empty and terminal,
  // with the horizon still reported, so a caller can tell "nothing matches" from
  // "the indexer has not started".
  const response = await request(`/settlements?agent=${AGENT_A}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    index: { lastBlock: number | null };
    settlements: unknown[];
    nextCursor: string | null;
  };
  assert.deepEqual(body.settlements, []);
  assert.equal(body.nextCursor, null);
  assert.ok((body.index.lastBlock ?? 0) > 0);
});

test("an Agent with no rows is 200 with empty arrays, not 404", { skip }, async () => {
  const response = await request(`/agents/${AGENT_A}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { agent: string; assets: unknown[]; boundAddresses: unknown[] };
  // An Agent is a Creditcoin address with no identity token to be absent, so "no
  // activity" is a truthful answer about a real address. A 404 would claim the
  // address does not exist, which this service cannot know.
  assert.equal(body.agent, AGENT_A);
  assert.deepEqual(body.assets, []);
  assert.deepEqual(body.boundAddresses, []);
});

test("an unregistered Service is 404, which an Agent is not", { skip }, async () => {
  const response = await request(`/services/${`0x${"ee".repeat(32)}`}`);
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: { category: string; code: string } };
  assert.equal(body.error.category, "NOT_FOUND");
  assert.equal(body.error.code, "SERVICE_NOT_REGISTERED");
});

test("an unindexed replay key is 404", { skip }, async () => {
  const response = await request(`/settlements/${`0x${"ee".repeat(32)}`}`);
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "SETTLEMENT_NOT_INDEXED");
});

test("malformed parameters are 400 and name the field", { skip }, async () => {
  for (const path of [
    "/settlements?agent=0xnothex",
    "/settlements?serviceId=0x01",
    "/settlements?asset=deadbeef",
    "/settlements?chainKey=three",
    "/settlements?limit=0",
    "/settlements?limit=10000",
    "/settlements?cursor=%21%21%21not-a-cursor",
    "/settlements/0x1234",
    "/services/0x1234",
    "/agents/0x1234",
  ]) {
    const response = await request(path);
    assert.equal(response.status, 400, `${path} should be rejected`);
    const body = (await response.json()) as { error: { category: string } };
    assert.equal(body.error.category, "VALIDATION");
  }
});

// -------------------------------------------------------------- the real Service

test("the Service directory serves tier, prices, window, and any pending change beside them", { skip }, async () => {
  const response = await request("/services");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    services: {
      serviceId: string;
      tier: {
        value: number;
        name: string;
        creditWeight: string;
        // A change carries the Creditcoin transaction that applied it; registration
        // carries none, because nothing applied it.
        source: { appliedBy: string; creditcoin?: { txHash: string; blockNumber: number } };
      };
      settlementWindowSeconds: { value: number; source: { appliedBy: string } };
      acceptedAssets: { asset: string; chainKey: string; tabCollection: string | null; bondCollection: string | null }[];
      prices: { asset: string; tool: string; baseUnits: string }[];
      bond: unknown[];
      pendingChanges: { changeId: string; kindName: string; eta: number | null }[];
    }[];
    nextCursor: string | null;
  };

  assert.equal(body.services.length, 1, "one Service is registered on chain");
  const service = body.services[0];
  assert.notEqual(service, undefined);
  if (service === undefined) return;
  serviceId = service.serviceId;
  tabA1 = tabIdOf(AGENT_A, serviceId, ASSET_A);
  tabB1 = tabIdOf(AGENT_A, serviceId, ASSET_B);

  // The property is that the route serves the tier with its name, its credit
  // meaning and its provenance, all agreeing. It is deliberately not an assertion
  // that the tier holds a particular value: that would be a claim about the chain,
  // and the chain moved when the queued curation promotion applied on 2026-09-08.
  // The pendingChanges block below already learned this lesson; the tier had not.
  assert.ok(service.tier.value === 0 || service.tier.value === 1, "tier is a known value");
  if (service.tier.value === 0) {
    // Permissionless gates Credit Limit weight and nothing else. Such a Service can
    // be paid and can hold Open Tabs; its Settlements simply weigh zero.
    assert.equal(service.tier.name, "Permissionless");
    assert.equal(service.tier.creditWeight, "zero");
    // Registration is the only way to reach this tier, so nothing applied it.
    assert.equal(service.tier.source.appliedBy, "registration");
  } else {
    assert.equal(service.tier.name, "Curated");
    assert.equal(service.tier.creditWeight, "counted-when-bonded");
    // Curated is only reachable through a queued change, so provenance is its id.
    assert.match(service.tier.source.appliedBy, /^0x[0-9a-f]{64}$/);
    const applied = service.tier.source.creditcoin;
    assert.ok(applied !== undefined, "the applying transaction is recorded");
    assert.match(applied.txHash, /^0x[0-9a-f]{64}$/);
    assert.ok(applied.blockNumber > 0, "and the block it landed in");
  }
  assert.equal(service.settlementWindowSeconds.value, 21_600);
  assert.equal(service.settlementWindowSeconds.source.appliedBy, "registration");

  // Two accepted Assets, each with a Tab address and a Bond address on its own chain.
  assert.equal(service.acceptedAssets.length, 2);
  for (const accepted of service.acceptedAssets) {
    assert.match(accepted.tabCollection ?? "", /^0x[0-9a-f]{40}$/);
    assert.match(accepted.bondCollection ?? "", /^0x[0-9a-f]{40}$/);
    assert.notEqual(accepted.tabCollection, accepted.bondCollection);
  }
  assert.equal(service.prices.length, 2);
  for (const price of service.prices) assert.equal(price.baseUnits, "10000");

  // A queued change is reported beside the applied values and never in place of
  // them, which is R11.7 and is this route's property. Asserting the array is empty
  // was a claim about the chain instead, and it stopped being true when a curation
  // promotion was queued on 2026-09-06. The applied tier above still reads
  // Permissionless while that change is pending, which is the part that matters.
  for (const change of service.pendingChanges) {
    // No `serviceId` on the row, deliberately: a pending change is served nested
    // under the Service it applies to, so repeating the id would be redundant.
    assert.match(change.changeId, /^0x[0-9a-f]{64}$/);
    assert.ok(change.eta !== null && change.eta > 0, "a pending change carries an ETA");
    assert.ok(change.kindName.length > 0, "a pending change names its kind");
  }
  // The Bond array is no longer asserted empty: a real proven deposit now exists on
  // chain for this Service, so emptiness would be a claim about the chain's history.
  // What this test is for is the timelocked directory values above it.
  assert.equal(body.nextCursor, null);
});

// ------------------------------------------------------------------ with settlements

test("the fixture writes through the real sink", { skip }, async () => {
  if (databaseUrl === null) return;
  assert.notEqual(serviceId, "", "the Service was read from the chain first");

  const windowEnd = BigInt(Math.floor(Date.UTC(2026, 8, 1) / 1000));
  const logs: RawLog[] = [
    // Block 1: a Settlement that reduces a tab, the delinquency that preceded it, and
    // the address binding the Settlement proved.
    encodeLog("SettlementRecorded", [RK.one, 3n, 21_000_001n, 0n, 0n, AGENT_A, serviceId, ASSET_A, 5_000_000n, PAYER_A, tabA1], 5_408_001, 0),
    encodeLog("SettlementApplied", [RK.one, AGENT_A, serviceId, ASSET_A, 5_000_000n, 0n, 1_000_000n], 5_408_001, 1),
    encodeLog("TabDelinquent", [tabA1, AGENT_A, serviceId, ASSET_A, 6_000_000n, windowEnd], 5_408_001, 2),
    encodeLog("AddressBound", [AGENT_A, 3n, PAYER_A, RK.one], 5_408_001, 3),
    // Block 2: settles the tab to zero, which is exactly what lifts the delinquency.
    encodeLog("SettlementRecorded", [RK.two, 3n, 21_000_002n, 0n, 0n, AGENT_A, serviceId, ASSET_A, 1_000_000n, PAYER_A, tabA1], 5_408_002, 0),
    encodeLog("SettlementApplied", [RK.two, AGENT_A, serviceId, ASSET_A, 1_000_000n, 0n, 0n], 5_408_002, 1),
    // Block 3: a Verified Settlement with no application at all — a proven deposit to
    // the Service's Bond Collection Address, which never reaches TabBook.
    // A proven Bond deposit, shaped exactly as the chain emits one. The verifier
    // routes a Settlement naming a Bond Collection Address to `Bond` and emits
    // `BondDepositRecorded`; it emits **no** `SettlementRecorded` on that branch, so
    // a deposit never appears in the settlement feed at all. An earlier fixture wrote
    // one and inferred the deposit from its missing application, which is the retired
    // anti-join that hid a real defect.
    encodeLog(
      "BondDepositRecorded",
      [RK.three, 3n, 21_000_003n, 0n, 0n, AGENT_A, serviceId, ASSET_A, 7_000_000n, PAYER_A, PARTY_A],
      5_408_003,
      0,
    ),
    encodeLog("BondFunded", [PARTY_A, ASSET_A, 7_000_000n, RK.three], 5_408_003, 1),
    // Block 4: another Agent, another Asset, an excess that becomes prepaid credit,
    // and a Provisional Clearing opened against the Settlement that lands next block.
    encodeLog("SettlementRecorded", [RK.four, 1n, 8_000_004n, 0n, 0n, AGENT_B, serviceId, ASSET_B, 3_000_000n, PAYER_A, tabIdOf(AGENT_B, serviceId, ASSET_B)], 5_408_004, 0),
    encodeLog("SettlementApplied", [RK.four, AGENT_B, serviceId, ASSET_B, 1_000_000n, 2_000_000n, 0n], 5_408_004, 1),
    encodeLog("ProvisionalClearingApplied", [RK.five, AGENT_A, serviceId, ASSET_A, 9_000_000n, SOURCE_TX_1, windowEnd + 3_600n], 5_408_004, 5),
    // Block 5: the proof arrives and confirms the clearing, then a second Settlement
    // in the same block, so a page boundary can fall inside one block.
    encodeLog("SettlementRecorded", [RK.five, 3n, 21_000_005n, 0n, 0n, AGENT_A, serviceId, ASSET_A, 9_000_000n, PAYER_A, tabA1], 5_408_005, 0),
    encodeLog("SettlementApplied", [RK.five, AGENT_A, serviceId, ASSET_A, 0n, 0n, 4_000_000n], 5_408_005, 1),
    encodeLog("ProvisionalClearingConfirmed", [RK.five, AGENT_A, serviceId, ASSET_A, 9_000_000n, SOURCE_TX_1], 5_408_005, 2),
    encodeLog("SettlementRecorded", [RK.six, 3n, 21_000_006n, 0n, 0n, AGENT_A, serviceId, ASSET_A, 500_000n, PAYER_A, tabA1], 5_408_005, 3),
    encodeLog("SettlementApplied", [RK.six, AGENT_A, serviceId, ASSET_A, 500_000n, 0n, 3_500_000n], 5_408_005, 4),
    // Block 6: a delinquency nothing has lifted, and a declined observation.
    encodeLog("TabDelinquent", [tabB1, AGENT_A, serviceId, ASSET_B, 2_500_000n, windowEnd], 5_408_006, 0),
    encodeLog("ProvisionalClearingDeclined", [AGENT_A, serviceId, ASSET_B, 4_000_000n, SOURCE_TX_2, 1_000_000n], 5_408_006, 1),
    // Block 6, continued: the other Agent spends the prepaid credit block 4 funded.
    // 2_000_000 landed as prepaid; the first delivery costs 500_000 and is paid
    // entirely out of it, so nothing is borrowed and 1_500_000 is left. The second
    // costs 2_000_000 against a 1_500_000 balance, which empties it and borrows the
    // remaining 500_000. Both are Metered Deliveries, so neither emits a Settlement
    // and neither moves a figure any other read on this route reports.
    encodeLog("PrepaidConsumed", [AGENT_B, serviceId, ASSET_B, 500_000n, 1_500_000n, 0n], 5_408_006, 2),
    encodeLog("PrepaidConsumed", [AGENT_B, serviceId, ASSET_B, 1_500_000n, 0n, 500_000n], 5_408_006, 3),
  ];

  const sink = PostgresSink.open(databaseUrl);
  try {
    await sink.applyBatch(toBatch(logs.map(toWrite), FIXTURE_FROM, FIXTURE_TO));
  } finally {
    await sink.close();
  }

  const response = await request(`/settlements?limit=200&${FROM_FIXTURE}`);
  const body = (await response.json()) as { settlements: unknown[] };
  // Five, not six: the Bond deposit is not a settlement-feed row.
  assert.equal(body.settlements.length, 5);
});

interface SettlementsBody {
  readonly settlements: readonly {
    readonly replayKey: string;
    readonly amount: string;
    readonly chainKey: string;
    readonly creditcoin: { readonly blockNumber: number; readonly logIndex: number };
    readonly application: { readonly applied: string; readonly toPrepaid: string; readonly openAfter: string } | null;
  }[];
  readonly nextCursor: string | null;
}

test("the feed is newest first and every amount is a string", { skip }, async () => {
  const body = (await (await request(`/settlements?limit=200&${FROM_FIXTURE}`)).json()) as SettlementsBody;
  assert.deepEqual(
    body.settlements.map((row) => row.replayKey),
    [RK.six, RK.five, RK.four, RK.two, RK.one],
  );
  for (const row of body.settlements) {
    assert.equal(typeof row.amount, "string");
    assert.equal(typeof row.chainKey, "string");
  }
  // The Bond deposit is absent from this feed entirely, which is the point: the
  // verifier emits `BondDepositRecorded` rather than `SettlementRecorded` on that
  // branch. Identifying a deposit by a settlement row with no application was the
  // retired derivation, and it reported a funded ledger as zero.
  const deposit = body.settlements.find((row) => row.replayKey === RK.three);
  assert.equal(deposit, undefined, "a Bond deposit is not a settlement-feed row");
  // The excess on the other Agent's Settlement became prepaid credit, not a reduction.
  const excess = body.settlements.find((row) => row.replayKey === RK.four);
  assert.deepEqual(excess?.application, { applied: "1000000", toPrepaid: "2000000", openAfter: "0" });
});

test("filters are exact, and a filter with no match is an empty page", { skip }, async () => {
  const byAgent = (await (await request(`/settlements?agent=${AGENT_B}&${FROM_FIXTURE}`)).json()) as SettlementsBody;
  assert.deepEqual(byAgent.settlements.map((row) => row.replayKey), [RK.four]);

  const byChain = (await (await request(`/settlements?chainKey=1&${FROM_FIXTURE}`)).json()) as SettlementsBody;
  assert.deepEqual(byChain.settlements.map((row) => row.replayKey), [RK.four]);

  const byAsset = (await (await request(`/settlements?asset=${ASSET_B}&${FROM_FIXTURE}`)).json()) as SettlementsBody;
  assert.deepEqual(byAsset.settlements.map((row) => row.replayKey), [RK.four]);

  // A combination nothing satisfies: the right Agent on the wrong chain.
  const none = (await (await request(`/settlements?agent=${AGENT_B}&chainKey=3&${FROM_FIXTURE}`)).json()) as SettlementsBody;
  assert.deepEqual(none.settlements, []);
  assert.equal(none.nextCursor, null);
});

test("a cursor walk crosses a page boundary inside a block without loss", { skip }, async () => {
  // Page size one, so the boundary falls between the two Settlements that share block
  // 5_408_005 and the ordering has to be the (block, logIndex) pair rather than the
  // block alone.
  const seen: string[] = [];
  // Started inside the fixture range, so the walk crosses the fixture's own block
  // boundary rather than the chain's newest Settlement.
  let path = `/settlements?limit=1&${FROM_FIXTURE}`;
  for (let request_ = 0; request_ < 12; request_ += 1) {
    const body = (await (await request(path)).json()) as SettlementsBody;
    seen.push(...body.settlements.map((row) => row.replayKey));
    if (body.nextCursor === null) break;
    path = `/settlements?limit=1&cursor=${encodeURIComponent(body.nextCursor)}`;
  }
  assert.deepEqual(seen, [RK.six, RK.five, RK.four, RK.two, RK.one]);
  assert.equal(new Set(seen).size, seen.length, "no replay key was served twice");
});

test("a walk is unaffected by Settlements written above it", { skip }, async () => {
  if (databaseUrl === null) return;

  const first = (await (await request(`/settlements?limit=2&${FROM_FIXTURE}`)).json()) as SettlementsBody;
  assert.deepEqual(first.settlements.map((row) => row.replayKey), [RK.six, RK.five]);
  assert.notEqual(first.nextCursor, null);

  // The indexer writes while the client pages. A new Settlement lands above the walk,
  // because a block number only ever increases.
  const sink = PostgresSink.open(databaseUrl);
  try {
    await sink.applyBatch(
      toBatch(
        [
          encodeLog(
            "SettlementRecorded",
            [RK.seven, 3n, 21_000_007n, 0n, 0n, AGENT_A, serviceId, ASSET_A, 250_000n, PAYER_A, tabA1],
            5_408_007,
            0,
          ),
          // Applied as well, so this Settlement stays a tab payment. Left unapplied it
          // would read as a second proven Bond deposit, which is precisely the
          // distinction the Bond derivation rests on.
          encodeLog(
            "SettlementApplied",
            [RK.seven, AGENT_A, serviceId, ASSET_A, 250_000n, 0n, 3_500_000n],
            5_408_007,
            1,
          ),
        ].map(toWrite),
        5_408_007,
        5_408_007,
      ),
    );
  } finally {
    await sink.close();
  }

  const seen = [...first.settlements.map((row) => row.replayKey)];
  let cursor = first.nextCursor;
  while (cursor !== null) {
    const page = (await (await request(
      `/settlements?limit=2&cursor=${encodeURIComponent(cursor)}`,
    )).json()) as SettlementsBody;
    seen.push(...page.settlements.map((row) => row.replayKey));
    cursor = page.nextCursor;
  }

  // Exactly the six that existed when the walk began, once each. The seventh is
  // above the walk and correctly absent from it.
  assert.deepEqual(seen, [RK.six, RK.five, RK.four, RK.two, RK.one]);
  assert.equal(seen.includes(RK.seven), false);

  // And a fresh walk sees it, so it was written and not merely missed.
  const fresh = (await (await request(`/settlements?limit=1&${FROM_FIXTURE}`)).json()) as SettlementsBody;
  assert.deepEqual(fresh.settlements.map((row) => row.replayKey), [RK.seven]);
});

test("one Settlement carries its clearing lineage and the state it reached", { skip }, async () => {
  const response = await request(`/settlements/${RK.five}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    settlement: { replayKey: string; sourceBlockHeight: string; sourceLogIndex: string; creditcoin: { logIndex: number } };
    clearing: { state: string | null; lineage: { state: string; sourceTxHash: string | null }[] };
  };
  assert.equal(body.settlement.replayKey, RK.five);
  assert.equal(body.settlement.sourceBlockHeight, "21000005");
  // The ordinal within the proved transaction's own receipt logs is not the
  // block-wide ordinal of the Creditcoin log that reported it.
  assert.equal(body.settlement.sourceLogIndex, "0");
  assert.equal(body.settlement.creditcoin.logIndex, 0);

  assert.deepEqual(body.clearing.lineage.map((event) => event.state), ["provisional", "confirmed"]);
  assert.equal(body.clearing.state, "confirmed");
  assert.equal(body.clearing.lineage[0]?.sourceTxHash, SOURCE_TX_1);
});

test("a Settlement with no clearing reports a null state, not a fabricated one", { skip }, async () => {
  const body = (await (await request(`/settlements/${RK.one}`)).json()) as {
    clearing: { state: string | null; lineage: unknown[] };
  };
  assert.deepEqual(body.clearing.lineage, []);
  assert.equal(body.clearing.state, null);
});

test("the Service reports its Bond ledger replayed from Bond's own events", { skip }, async () => {
  const body = (await (await request(`/services/${serviceId}`)).json()) as {
    service: {
      bond: {
        asset: string;
        party: string;
        staked: string;
        reserved: string;
        slashed: string;
        released: string;
        free: string;
        depositCount: number;
        basis: string;
        crossCheck: unknown;
        unavailable: { code: string; message: string } | null;
      }[];
    };
  };
  // Selected by the fixture's own party. The chain now carries a real Bond ledger for
  // this same Service, so the array holds both and an index would pick whichever
  // sorted first.
  const bond = body.service.bond.find((row) => row.party === PARTY_A);
  assert.notEqual(bond, undefined, "the fixture's own ledger is served");
  assert.equal(bond?.asset, ASSET_A);

  // Replayed from the one `BondFunded`, with nothing reserved, slashed, or released
  // against it. Free is staked less the other three, which is the figure a
  // Provisional Clearing is actually covered by.
  assert.equal(bond?.staked, "7000000");
  assert.equal(bond?.reserved, "0");
  assert.equal(bond?.slashed, "0");
  assert.equal(bond?.released, "0");
  assert.equal(bond?.free, "7000000");
  assert.equal(bond?.depositCount, 1);
  assert.match(bond?.basis ?? "", /replayed from Bond's own events/);

  // This app is built with no Creditcoin endpoint, so the replay is served with the
  // cross-check withheld and its absence named. That is the shape a reader must be
  // able to tell apart from a checked figure, which is why it is asserted rather
  // than skipped.
  assert.equal(bond?.crossCheck, null);
  assert.equal(bond?.unavailable?.code, "CHAIN_READER_UNCONFIGURED");
});

test("an agreeing Bond cross-check serialises, and its figures are strings", { skip }, async () => {
  if (chainApp === null) return;
  // **The regression this exists for.** `Bond.ledgerOf` answers in `bigint`s, and
  // `c.json` calls `JSON.stringify`, which throws on a `bigint` rather than coercing
  // it. Carried straight onto the response, an agreeing cross-check made every
  // Service with a Bond answer 500 in production while every test here passed,
  // because the other app has no chain reader and so never reaches this branch.
  const response = await chainApp.request(`/services/${serviceId}`);
  assert.equal(response.status, 200, "an agreeing cross-check must serialise");

  const body = (await response.json()) as {
    service: {
      bond: {
        staked: string;
        party: string;
        crossCheck: {
          read: string;
          onChain: { staked: string; reserved: string; slashed: string; released: string; free: string };
          agrees: true;
        } | null;
        unavailable: unknown;
      }[];
    };
  };
  const bond = body.service.bond.find((row) => row.crossCheck !== null);
  assert.notEqual(bond, undefined, "at least one ledger cross-checked and agreed");
  assert.equal(bond?.unavailable, null);
  assert.equal(bond?.crossCheck?.agrees, true);
  assert.equal(bond?.crossCheck?.read, "Bond.ledgerOf(party, asset)");
  // Every figure a string, which is this read layer's rule for any integer that
  // could lose precision, and the thing that keeps it serialisable.
  for (const figure of Object.values(bond?.crossCheck?.onChain ?? {})) {
    assert.equal(typeof figure, "string");
  }
  assert.equal(bond?.crossCheck?.onChain.staked, "7000000");
  assert.equal(bond?.crossCheck?.onChain.free, "7000000");
});

interface AgentBody {
  readonly agent: string;
  readonly assets: readonly {
    readonly asset: string;
    readonly creditLimit: {
      readonly value: string | null;
      readonly basis: string;
      readonly computedAt: unknown;
      readonly witness: unknown;
      readonly crossCheck: unknown;
      readonly unavailable: { readonly code: string; readonly message: string } | null;
    };
    readonly headroom: {
      readonly value: string | null;
      readonly unavailable: { readonly code: string; readonly message: string } | null;
    };
    readonly openTab: { readonly observed: string; readonly liveRead: string };
    readonly prepaid: {
      readonly balance: string | null;
      readonly funded: string | null;
      readonly consumed: string | null;
      readonly borrowedOnDraw: string | null;
      readonly drawCount: number;
      readonly basis: string;
      readonly liveRead: string;
      readonly tabs: readonly {
        readonly serviceId: string;
        readonly consumed: string;
        readonly prepaidAfter: string;
        readonly openAdded: string;
        readonly creditcoin: { readonly blockNumber: number; readonly logIndex: number };
      }[];
    };
    readonly delinquency: { readonly delinquent: boolean; readonly openCount: number; readonly tabs: readonly { readonly resolved: boolean }[] };
    readonly settlements: { readonly settlementCount: number; readonly settledTotal: string; readonly appliedTotal: string; readonly prepaidTotal: string } | null;
  }[];
  readonly boundAddresses: readonly { readonly ethAddress: string; readonly chainKey: string }[];
  readonly declinedObservations: { readonly note: string; readonly observations: readonly { readonly freeBond: string }[] };
}

test("the Agent credit read carries Open Tab, delinquency, and a reasoned credit absence", { skip }, async () => {
  const response = await request(`/agents/${AGENT_A}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as AgentBody;

  // Two Assets: one with settlements and a lifted delinquency, one with a standing
  // delinquency and no settlement at all. The Asset set is the union of every source,
  // so the second is not hidden.
  assert.deepEqual(body.assets.map((asset) => asset.asset).sort(), [ASSET_B, ASSET_A].sort());

  const usdc = body.assets.find((asset) => asset.asset === ASSET_A);
  assert.notEqual(usdc, undefined);
  if (usdc === undefined) return;

  // Six Settlements including the Bond deposit, which is a Verified Settlement for
  // this Agent whatever it was routed to.
  assert.equal(usdc.settlements?.settlementCount, 5);
  assert.equal(usdc.settlements?.settledTotal, "15750000");
  // Only what actually reduced a tab: the confirmation applied nothing, because the
  // Provisional Clearing had already reduced it, and the deposit reduced nothing.
  assert.equal(usdc.settlements?.appliedTotal, "6750000");
  // The last observed Open Tab, from the latest SettlementApplied for the tab.
  assert.equal(usdc.openTab.observed, "3500000");
  assert.equal(usdc.openTab.liveRead, "TabBook.assetOpen(agent, asset)");
  // The delinquency was lifted by the settlement that took the tab to zero, which is
  // exactly the rule TabBook applies.
  assert.equal(usdc.delinquency.delinquent, false);
  assert.equal(usdc.delinquency.openCount, 0);
  assert.deepEqual(usdc.delinquency.tabs.map((tab) => tab.resolved), [true]);

  const other = body.assets.find((asset) => asset.asset === ASSET_B);
  assert.equal(other?.settlements, null);
  assert.equal(other?.openTab.observed, "0");
  // Nothing settled this tab, so the flag stands.
  assert.equal(other?.delinquency.delinquent, true);
  assert.equal(other?.delinquency.openCount, 1);

  // This app is built with no Creditcoin endpoint, so no figure is served: the
  // recomputation cannot be checked against `TabBook` and an unchecked Credit Limit
  // is a different number wearing the name. The reason is machine-readable, and it
  // names a deployment gap rather than a chain fault.
  for (const asset of body.assets) {
    assert.equal(asset.creditLimit.value, null);
    assert.equal(asset.creditLimit.unavailable?.code, "CHAIN_READER_UNCONFIGURED");
    assert.match(asset.creditLimit.basis, /LimitLib recomputed/);
    assert.equal(asset.creditLimit.crossCheck, null);
    assert.equal(asset.headroom.value, null);
    assert.equal(asset.headroom.unavailable?.code, "CHAIN_READER_UNCONFIGURED");
  }

  assert.deepEqual(body.boundAddresses.map((bound) => bound.ethAddress), [PAYER_A]);
  assert.equal(body.boundAddresses[0]?.chainKey, "3");

  // This Agent's Settlements all reduced a tab, so nothing ever became prepaid credit
  // in this Asset. A funded-but-empty ledger is a different fact from no ledger, and
  // both are reported as themselves: zero here, null on the Asset below.
  assert.equal(usdc.prepaid.balance, "0");
  assert.equal(usdc.prepaid.funded, "0");
  assert.equal(usdc.prepaid.consumed, "0");
  assert.equal(usdc.prepaid.drawCount, 0);
  assert.deepEqual(usdc.prepaid.tabs, []);
  // Nothing this Agent did in the other Asset touched prepaid credit at all.
  assert.equal(other?.prepaid.balance, null);
  assert.equal(other?.prepaid.drawCount, 0);

  // A decline is not a failed Settlement, and it carries no clearing identity.
  assert.equal(body.declinedObservations.observations.length, 1);
  assert.equal(body.declinedObservations.observations[0]?.freeBond, "1000000");
  assert.match(body.declinedObservations.note, /not a failed Settlement/);
});

test("a prepaid-funded delivery explains itself on the Agent read", { skip }, async () => {
  const body = (await (await request(`/agents/${AGENT_B}`)).json()) as AgentBody;
  const view = body.assets.find((asset) => asset.asset === ASSET_B);
  assert.notEqual(view, undefined, "the Asset the excess settlement funded");
  if (view === undefined) return;

  // The whole point of indexing PrepaidConsumed. Before it, this Agent's Open Tab
  // read zero after two deliveries and there was no row anywhere saying a delivery
  // had happened, so a tab paid out of credit was indistinguishable from a tab
  // nothing ever charged. The two draws are now the record of it.
  assert.equal(view.prepaid.drawCount, 2);
  assert.deepEqual(
    view.prepaid.tabs.map((tab) => ({ consumed: tab.consumed, prepaidAfter: tab.prepaidAfter, openAdded: tab.openAdded })),
    // One row per tab, latest draw first, so this is the second of the two.
    [{ consumed: "1500000", prepaidAfter: "0", openAdded: "500000" }],
  );
  assert.equal(view.prepaid.tabs[0]?.creditcoin.logIndex, 3);

  // 2_000_000 funded by the excess in block 4, all of it spent across the two draws,
  // so the balance is zero and it is arrived at rather than observed. Both sides are
  // reported, because a balance nobody can decompose is a number to be taken on
  // trust and this read layer serves none of those.
  assert.equal(view.prepaid.funded, "2000000");
  assert.equal(view.prepaid.consumed, "2000000");
  assert.equal(view.prepaid.balance, "0");
  assert.equal(
    BigInt(view.prepaid.funded ?? "0") - BigInt(view.prepaid.consumed ?? "0"),
    BigInt(view.prepaid.balance ?? "-1"),
  );

  // The second delivery cost more than the balance could cover, and the remainder is
  // the only prepaid figure here that is a lower bound, because a delivery that drew
  // nothing emits no event at all.
  assert.equal(view.prepaid.borrowedOnDraw, "500000");
  assert.match(view.prepaid.basis, /lower bound on borrowing/);
  assert.match(view.prepaid.basis, /which is exact/);
  assert.equal(view.prepaid.liveRead, "TabBook.tabOf(TabBook.tabIdOf(agent, serviceId, asset)).prepaid");

  // And the Open Tab still reports what it always did. The borrowed 500_000 rode on
  // DeliveryRecorded, which is not indexed, so the last observed tab is the one the
  // block 4 settlement left and is a lower bound. Naming both on the same Asset is
  // what keeps the two claims apart.
  assert.equal(view.openTab.observed, "0");
  assert.equal(view.settlements?.prepaidTotal, "2000000");
});

test("the Agent directory pages by most recent Settlement", { skip }, async () => {
  const body = (await (await request(`/agents?limit=1&${FROM_FIXTURE}`)).json()) as {
    agents: { agent: string; settlementCount: number; settledTotal: string; assetCount: number }[];
    nextCursor: string | null;
    creditLimit: { value: null; servedBy: string; why: string };
  };
  // Scoped to the fixture range, because the chain's own Agent settled later than
  // either of these and would otherwise lead the page.
  // Agent A settled most recently of the two, so it leads.
  assert.equal(body.agents.length, 1);
  assert.equal(body.agents[0]?.agent, AGENT_A);
  assert.equal(body.agents[0]?.settlementCount, 5);
  assert.equal(body.agents[0]?.assetCount, 1);
  // The listing carries no per-row figure and names the route that does, rather than
  // spending a witness rebuild and four chain reads on every row of a page.
  assert.equal(body.creditLimit.value, null);
  assert.match(body.creditLimit.servedBy, /GET \/agents\/:agent/);

  assert.notEqual(body.nextCursor, null);
  const next = (await (await request(
    `/agents?limit=1&cursor=${encodeURIComponent(body.nextCursor ?? "")}`,
  )).json()) as { agents: { agent: string; settlementCount: number }[]; nextCursor: string | null };
  assert.equal(next.agents[0]?.agent, AGENT_B);
  assert.equal(next.agents[0]?.settlementCount, 1);
  assert.equal(next.nextCursor, null);
});

test("the probes still answer beside the reads", { skip }, async () => {
  const health = await request("/healthz");
  assert.equal(health.status, 200);
  const ready = await request("/readyz");
  assert.equal(ready.status, 200);
});

test("the fixture is removed, leaving the database as it was found", { skip }, async () => {
  await cleanUp();
  // Scoped to the fixture's own range: what must be gone is what this file wrote,
  // not what the chain has settled. An unfiltered emptiness check would now be
  // asserting that no Verified Settlement exists, which is both false and none of
  // this test's business.
  const body = (await (await request(`/settlements?limit=200&${FROM_FIXTURE}`)).json()) as SettlementsBody;
  assert.deepEqual(body.settlements, []);
  const service = (await (await request(`/services/${serviceId}`)).json()) as {
    service: { bond: { party: string }[] };
  };
  // The fixture's own ledger is gone. The chain's real one is not the fixture's to
  // remove, so it is expected to remain.
  assert.equal(service.service.bond.find((row) => row.party === PARTY_A), undefined);
});
