/**
 * The read API, end to end, against a real PostgreSQL.
 *
 * ## What these tests need, and what they do when it is absent
 *
 * A PostgreSQL server, found through `DATABASE_URL` in the environment or the
 * repository-root `.env`. Where none is reachable every test here skips with a
 * reason rather than failing, so `pnpm test` stays green on a machine with no
 * PostgreSQL while still saying why this half did not run.
 *
 * ## A database of their own
 *
 * The tests never touch the database `DATABASE_URL` names. That one is the
 * live index on a developer's machine, and a read route serves everything it
 * holds, so a feed test asserting "exactly these three Settlements" would be
 * true on a fresh index and false the moment the indexer saw a real one. The
 * suite runs against `REGISTRY_TEST_DATABASE_URL` when that is set and
 * otherwise against a sibling database named `<database>_test` on the same
 * server, which it creates if it is missing. The schema is applied there, the
 * fixture is written there, and the live index is never read or written.
 *
 * ## The fixture
 *
 * Every row these tests read is written by these tests, through the real sink,
 * under a stream of their own. Nothing here depends on what is on chain. The
 * fixture is one Service, two Assets, two Agents, deliveries, settlements, a
 * prepaid draw, a delinquency and its clearing, and a bond deposit, which is
 * enough to exercise every view once. It is removed again when the file
 * finishes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { AbiCoder, keccak256 } from "ethers";
import postgres from "postgres";
import { REGISTRY_INTERFACE, decodeLog, type IndexedEventName, type RawLog } from "../src/events.js";
import { encodeCursor } from "../src/cursor.js";
import { createClassifier } from "../src/adoption.js";
import { PostgresReads } from "../src/queries.js";
import { PostgresSink } from "../src/postgres-sink.js";
import { toTypedInsert } from "../src/rows.js";
import type { CreditChainReader, Erc8004ChainReader } from "../src/chain-reads.js";
import type { ReputationFilter } from "../src/erc8004.js";
import type { CardFetcher } from "../src/agent-card.js";
import { createApp } from "../src/server.js";
import { DEFAULT_STREAM, type EventWrite, type WriteBatch } from "../src/sink.js";
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

/**
 * The suite's own database, beside the live one.
 *
 * `REGISTRY_TEST_DATABASE_URL` wins when set. Otherwise the live URL's database
 * name gains a `_test` suffix, and the database is created through the server's
 * `postgres` maintenance database when it does not exist yet. A server that
 * cannot be reached, or one that refuses to create it, leaves the suite skipping
 * with that reason, exactly as no server at all would.
 */
function testDatabaseUrl(liveUrl: string): string {
  const explicit = process.env.REGISTRY_TEST_DATABASE_URL?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const url = new URL(liveUrl);
  const name = url.pathname.replace(/^\//, "");
  url.pathname = `/${(name.length === 0 ? "tab" : name)}_test`;
  return url.toString();
}

async function ensureDatabase(url: string): Promise<boolean> {
  const probe = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await probe`SELECT 1`;
    return true;
  } catch (error) {
    // 3D000 is "database does not exist"; anything else is the server's answer.
    if ((error as { code?: string }).code !== "3D000") return false;
  } finally {
    await probe.end({ timeout: 5 });
  }
  const name = new URL(url).pathname.replace(/^\//, "");
  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const admin = postgres(maintenance.toString(), { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    return true;
  } catch {
    return false;
  } finally {
    await admin.end({ timeout: 5 });
  }
}

const liveUrl = resolveDatabaseUrl();
const databaseUrl = liveUrl === null ? null : testDatabaseUrl(liveUrl);
const created = databaseUrl === null ? false : await ensureDatabase(databaseUrl);
const reads = databaseUrl === null || !created ? null : PostgresReads.open(databaseUrl);
const reachable = reads === null ? false : await reads.ping();
if (reads !== null && !reachable) await reads.close();
const skip = reachable ? false : "no PostgreSQL reachable through DATABASE_URL, or its test database could not be created";

if (reachable && databaseUrl !== null) {
  const sink = PostgresSink.open(databaseUrl);
  try {
    await sink.applySchema();
  } finally {
    await sink.close();
  }
}

after(async () => {
  if (!reachable) return;
  await cleanUp();
  if (reads !== null) await reads.close();
});

const IDLE_STATUS: IndexerStatus = {
  stream: "monad",
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

/** A chain reader that agrees with everything the fixture replays. */
const AGREEING_CHAIN: CreditChainReader = {
  blockTimestamp: async () => 1_790_000_000n,
  governance: async () => ({ baseline: 5_000_000n, growthFactorBps: 5_000n }),
  historyCommitment: async () => ({ root: `0x${"00".repeat(32)}`, count: 0 }),
  creditLimit: async () => 0n,
  headroom: async () => 0n,
  assetOpen: async () => 0n,
  delinquentTabCount: async () => 0,
  bondLedger: async () => ({ staked: 10_000_000n, withdrawn: 3_000_000n }),
};

const chainApp =
  reads === null
    ? null
    : createApp({ status: () => IDLE_STATUS, databaseReachable: () => reads.ping(), reads, chain: AGREEING_CHAIN });

// ------------------------------------------------------------------ identity fixtures

const IDENTITY_REGISTRY = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const REPUTATION_REGISTRY = "0x8004b663056a597dffe9eccc1965a193b7388713";
const CARD = { type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "fixture agent", endpoints: [] };
const CARD_URI = "https://cards.example/agent-7.json";
const CARD_URI_UPDATED = "https://cards.example/agent-7-v2.json";
const OPERATOR_CARD_URI = `data:application/json;base64,${Buffer.from(JSON.stringify({ ...CARD, name: "fixture operator" })).toString("base64")}`;

/** Serves the fixture cards without a network. Anything else is a 404. */
const fixtureCards: CardFetcher = {
  async fetch(uri) {
    if (uri === CARD_URI_UPDATED) return { ok: true, value: CARD, fetchedAt: "2026-09-22T00:00:00.000Z" };
    if (uri.startsWith("data:")) {
      const decoded = JSON.parse(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64").toString("utf8")) as unknown;
      return { ok: true, value: decoded, fetchedAt: "2026-09-22T00:00:00.000Z" };
    }
    return { ok: false, error: { code: "CARD_HTTP_ERROR", message: "the card's origin answered 404" } };
  },
};

/** Every reputation read the fixture chain was asked, so a test can see the filter the route built. */
const reputationAsked: { readonly agentId: bigint; readonly filter: ReputationFilter | undefined }[] = [];

/**
 * A Reputation registry holding two feedback entries for agent 7 and none for
 * anyone else. Both are from the fixture Service's operator: one of 100 under
 * Tab's tags, written after a Settlement, and one of 70 under other tags, so
 * the whole-registry mean is 85 and the Tab-only one is 100 over one entry.
 */
const REPUTATION_CHAIN: Erc8004ChainReader = {
  tokenURI: async (agentId) => `chain://${agentId}`,
  reputationSummary: async (agentId, filter) => {
    reputationAsked.push({ agentId, filter });
    const none = { clientCount: 0, clients: [], count: 0, summaryValue: 0n, summaryValueDecimals: 0 };
    if (agentId !== 7n) return none;
    if (filter === undefined) return { clientCount: 1, clients: [OPERATOR], count: 2, summaryValue: 85n, summaryValueDecimals: 0 };
    const asksTab = filter.clients.includes(OPERATOR) && filter.tag1 === "tab" && filter.tag2 === "settled";
    return asksTab ? { clientCount: 1, clients: [OPERATOR], count: 1, summaryValue: 100n, summaryValueDecimals: 0 } : none;
  },
};

const identityApp =
  reads === null
    ? null
    : createApp({
        status: () => IDLE_STATUS,
        databaseReachable: () => reads.ping(),
        reads,
        identity: {
          registries: { identity: IDENTITY_REGISTRY, reputation: REPUTATION_REGISTRY },
          cards: fixtureCards,
          chain: REPUTATION_CHAIN,
        },
        labels: {
          async labelsFor(address) {
            return address === AGENT_A
              ? {
                  source: "nansen",
                  chain: "all",
                  fetchedAt: "2026-09-22T00:00:00.000Z",
                  labels: [{ label: "Fixture Fund", category: "cefi", kind: ["entity"] }],
                  entity: "Fixture Fund",
                }
              : { source: "nansen", unavailable: { code: "NANSEN_RATE_LIMITED", message: "fixture" } };
          },
        },
      });

const request = async (path: string): Promise<Response> => {
  if (app === null) throw new Error("test: no app");
  return app.request(path);
};

// ------------------------------------------------------------------ the fixture

const FIXTURE_FROM = 900_000_001;
const FIXTURE_TO = 900_000_010;
const FIXTURE_STREAM = "test-read-endpoints";
/** A cursor just above the fixture, so a walk starts inside it whatever else is indexed. */
const FROM_FIXTURE = `cursor=${encodeURIComponent(encodeCursor({ blockNumber: FIXTURE_TO + 1, logIndex: 0 }))}`;

const OPERATOR = `0x${"0a".repeat(20)}`;
const AGENT_A = `0x${"11".repeat(20)}`;
const AGENT_B = `0x${"22".repeat(20)}`;
const COLLECTION_A = `0x${"c1".repeat(20)}`;
const COLLECTION_B = `0x${"c2".repeat(20)}`;
const ASSET_A = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const ASSET_B = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a";
const SERVICE_ID = `0x${"5e".repeat(32)}`;
const TOOL = `0x${"70".repeat(32)}`;
const PARTY = `0x${"00".repeat(12)}${OPERATOR.slice(2)}`;
const TAB_BOOK = `0x${"0b".repeat(20)}`;
const STRANGER = `0x${"33".repeat(20)}`;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;

const CODER = AbiCoder.defaultAbiCoder();
const tabIdOf = (agent: string, serviceId: string, asset: string): string =>
  keccak256(CODER.encode(["address", "bytes32", "address"], [agent, serviceId, asset]));
const word = (value: number): string => `0x${value.toString(16).padStart(64, "0")}`;
const settlementId = (n: number): string => `0x${"5d".repeat(31)}${n.toString(16).padStart(2, "0")}`;

function encodeLog(
  name: IndexedEventName,
  values: readonly unknown[],
  blockNumber: number,
  logIndex: number,
  address: string = TAB_BOOK,
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
    address,
    topics: encoded.topics,
    data: encoded.data,
  };
}

function toWrite(log: RawLog): EventWrite {
  const decoded = decodeLog(log);
  if (decoded === null) throw new Error("test: fixture log did not decode");
  return {
    log: {
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      blockTime: new Date(Date.UTC(2026, 8, 21, 0, log.blockNumber % 60, 0)),
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
    // A stream of its own, so the fixture cannot move the real cursor.
    cursor: { lastBlock: highest, lastBlockHash: word(highest), reorgCount: 0 },
  };
}

/**
 * The routes read the horizon of the default stream, and a cross-check needs a
 * block to check at. A database that has never indexed the real chain has no
 * such cursor, so one is primed here at the fixture's top block, and only when
 * absent: a database that has indexed the chain keeps its own horizon, and the
 * prime is removed again on the way out only if this file wrote it.
 */
let primedDefaultStream = false;

const primeHorizon = async (): Promise<void> => {
  if (databaseUrl === null) return;
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const existing = await client<{ stream: string }[]>`SELECT stream FROM registry.indexer_cursor WHERE stream = ${DEFAULT_STREAM}`;
    if (existing.length > 0) return;
    await client`INSERT INTO registry.indexer_cursor (stream, last_block, last_block_hash, reorg_count)
      VALUES (${DEFAULT_STREAM}, ${FIXTURE_TO}, ${word(FIXTURE_TO)}, 0)`;
    primedDefaultStream = true;
  } finally {
    await client.end({ timeout: 5 });
  }
};

const cleanUp = async (): Promise<void> => {
  if (databaseUrl === null) return;
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    // The cascade takes every typed row with each envelope, so this is the whole undo.
    await client`DELETE FROM registry.event_log WHERE block_number BETWEEN ${FIXTURE_FROM} AND ${FIXTURE_TO}`;
    await client`DELETE FROM registry.indexed_block WHERE block_number BETWEEN ${FIXTURE_FROM} AND ${FIXTURE_TO}`;
    await client`DELETE FROM registry.indexer_cursor WHERE stream = ${FIXTURE_STREAM}`;
    if (primedDefaultStream) await client`DELETE FROM registry.indexer_cursor WHERE stream = ${DEFAULT_STREAM}`;
  } finally {
    await client.end({ timeout: 5 });
  }
};

const tabA1 = tabIdOf(AGENT_A, SERVICE_ID, ASSET_A);

// ------------------------------------------------------- empty, before anything

test("a settlement feed filtered to nothing is an empty page, with the horizon still reported", { skip }, async () => {
  await cleanUp();
  const response = await request(`/settlements?agent=${AGENT_A}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { index: { stream: string }; settlements: unknown[]; nextCursor: string | null };
  assert.deepEqual(body.settlements, []);
  assert.equal(body.nextCursor, null);
  assert.equal(body.index.stream, "monad");
});

test("an Agent with no rows is 200 with empty arrays, not 404", { skip }, async () => {
  const response = await request(`/agents/${AGENT_A}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { agent: string; assets: unknown[] };
  // An Agent is a Monad address with no identity token to be absent, so "no
  // activity" is a truthful answer about a real address.
  assert.equal(body.agent, AGENT_A);
  assert.deepEqual(body.assets, []);
});

test("the witness for an Agent with no rows is an empty history under the index horizon", { skip }, async () => {
  const response = await request(`/agents/${AGENT_A}/witness/${ASSET_A}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    agent: string;
    asset: string;
    commitment: { root: string; count: number };
    history: unknown[];
    bonds: unknown[];
    index: { lastBlock: number | null };
  };
  assert.equal(body.agent, AGENT_A);
  assert.equal(body.asset, ASSET_A);
  assert.deepEqual(body.history, []);
  assert.deepEqual(body.bonds, []);
  assert.equal(body.commitment.count, 0);
  assert.equal(body.commitment.root, `0x${"00".repeat(32)}`);
  // The block the witness is complete to is stated, because a reader that
  // scans for what landed after it needs a number and not a promise.
  assert.notEqual(body.index.lastBlock, undefined);
});

test("an unregistered Service is 404, which an Agent is not", { skip }, async () => {
  const response = await request(`/services/${`0x${"ee".repeat(32)}`}`);
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: { category: string; code: string } };
  assert.equal(body.error.category, "NOT_FOUND");
  assert.equal(body.error.code, "SERVICE_NOT_REGISTERED");
});

test("an unindexed settlement id is 404", { skip }, async () => {
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
    "/settlements?limit=0",
    "/settlements?limit=10000",
    "/settlements?cursor=%21%21%21not-a-cursor",
    "/settlements/0x1234",
    "/deliveries?agent=0x01",
    "/services/0x1234",
    "/agents/0x1234",
    `/agents/${AGENT_A}/witness/0x1234`,
    `/agents/0x1234/witness/${ASSET_A}`,
  ]) {
    const response = await request(path);
    assert.equal(response.status, 400, `${path} should be rejected`);
    const body = (await response.json()) as { error: { category: string } };
    assert.equal(body.error.category, "VALIDATION");
  }
});

// ------------------------------------------------------------------ the fixture lands

test("the fixture writes through the real sink", { skip }, async () => {
  if (databaseUrl === null) return;
  await primeHorizon();
  const windowEnd = 1_790_021_600n;
  const logs: RawLog[] = [
    // Block 1: the Service registers, accepts two Assets, prices one tool in each,
    // and its operator stakes ten million, later withdrawing three.
    encodeLog("ServiceRegistered", [SERVICE_ID, OPERATOR, 0, 21_600n], FIXTURE_FROM, 0),
    encodeLog("CollectionRegistered", [SERVICE_ID, ASSET_A, COLLECTION_A], FIXTURE_FROM, 1),
    encodeLog("CollectionRegistered", [SERVICE_ID, ASSET_B, COLLECTION_B], FIXTURE_FROM, 2),
    encodeLog("ToolPriceSet", [SERVICE_ID, ASSET_A, TOOL, 10_000n], FIXTURE_FROM, 3),
    encodeLog("ToolPriceSet", [SERVICE_ID, ASSET_B, TOOL, 10_000n], FIXTURE_FROM, 4),
    encodeLog("BondFunded", [PARTY, ASSET_A, 10_000_000n, OPERATOR], FIXTURE_FROM, 5),
    encodeLog("BondWithdrawn", [PARTY, ASSET_A, 3_000_000n, OPERATOR], FIXTURE_FROM, 6),
    // Block 2: Agent A authorises, is metered twice, and settles part of it.
    encodeLog("AuthorisationSet", [AGENT_A, SERVICE_ID, ASSET_A, 100_000_000n, 1_800_000_000n], FIXTURE_FROM + 1, 0),
    encodeLog("DeliveryRecorded", [AGENT_A, SERVICE_ID, ASSET_A, TOOL, 100n, 1_000_000n, 1_790_000_000n], FIXTURE_FROM + 1, 1),
    encodeLog("DeliveryRecorded", [AGENT_A, SERVICE_ID, ASSET_A, TOOL, 100n, 1_000_000n, 1_790_000_100n], FIXTURE_FROM + 1, 2),
    encodeLog("SettlementApplied", [settlementId(1), AGENT_A, SERVICE_ID, ASSET_A, 1_500_000n, 0n, 500_000n], FIXTURE_FROM + 1, 3),
    encodeLog("HistoryExtended", [AGENT_A, ASSET_A, word(0x77), 1n, [SERVICE_ID, ASSET_A, 1_500_000n, 1_790_000_200n, 1_790_000_000n, false, true]], FIXTURE_FROM + 1, 4),
    encodeLog("Settled", [settlementId(1), AGENT_A, SERVICE_ID, ASSET_A, 1_500_000n, 1_500_000n, 0n, COLLECTION_A], FIXTURE_FROM + 1, 5),
    // Block 3: the rest goes late, is declared delinquent, and is then cleared by
    // an overpayment that banks the excess as prepaid credit.
    encodeLog("TabDelinquent", [tabA1, AGENT_A, SERVICE_ID, ASSET_A, 500_000n, windowEnd], FIXTURE_FROM + 2, 0),
    encodeLog("SettlementApplied", [settlementId(2), AGENT_A, SERVICE_ID, ASSET_A, 500_000n, 200_000n, 0n], FIXTURE_FROM + 2, 1),
    encodeLog("TabDelinquencyCleared", [tabA1, AGENT_A, ASSET_A], FIXTURE_FROM + 2, 2),
    encodeLog("HistoryExtended", [AGENT_A, ASSET_A, word(0x78), 2n, [SERVICE_ID, ASSET_A, 700_000n, 1_790_030_000n, 1_790_000_000n, false, true]], FIXTURE_FROM + 2, 3),
    encodeLog("Settled", [settlementId(2), AGENT_A, SERVICE_ID, ASSET_A, 700_000n, 500_000n, 200_000n, COLLECTION_A], FIXTURE_FROM + 2, 4),
    // Block 4: Agent B prepays in the second Asset and a delivery draws on it.
    encodeLog("SettlementApplied", [settlementId(3), AGENT_B, SERVICE_ID, ASSET_B, 0n, 2_000_000n, 0n], FIXTURE_FROM + 3, 0),
    encodeLog("Settled", [settlementId(3), AGENT_B, SERVICE_ID, ASSET_B, 2_000_000n, 0n, 2_000_000n, COLLECTION_B], FIXTURE_FROM + 3, 1),
    encodeLog("PrepaidConsumed", [AGENT_B, SERVICE_ID, ASSET_B, 1_500_000n, 500_000n, 0n], FIXTURE_FROM + 3, 2),
    // Block 5, from the ERC-8004 Identity registry: the operator registers agent 7
    // from its cold key with Agent A as the acting wallet, then rewrites the URI.
    // Agent B registers agent 8 with no URI. Agent 9 is minted by a stranger and
    // then transferred to Agent A, which clears its wallet.
    encodeLog("Transfer", [ZERO_ADDRESS, OPERATOR, 7n], FIXTURE_FROM + 4, 0, IDENTITY_REGISTRY),
    encodeLog("Registered", [7n, CARD_URI, OPERATOR], FIXTURE_FROM + 4, 1, IDENTITY_REGISTRY),
    encodeLog("MetadataSet", [7n, "agentWallet", "agentWallet", OPERATOR], FIXTURE_FROM + 4, 2, IDENTITY_REGISTRY),
    encodeLog("MetadataSet", [7n, "agentWallet", "agentWallet", AGENT_A], FIXTURE_FROM + 4, 3, IDENTITY_REGISTRY),
    encodeLog("URIUpdated", [7n, CARD_URI_UPDATED, OPERATOR], FIXTURE_FROM + 4, 4, IDENTITY_REGISTRY),
    encodeLog("Transfer", [ZERO_ADDRESS, AGENT_B, 8n], FIXTURE_FROM + 4, 5, IDENTITY_REGISTRY),
    encodeLog("Registered", [8n, "", AGENT_B], FIXTURE_FROM + 4, 6, IDENTITY_REGISTRY),
    encodeLog("MetadataSet", [8n, "agentWallet", "agentWallet", AGENT_B], FIXTURE_FROM + 4, 7, IDENTITY_REGISTRY),
    encodeLog("Transfer", [ZERO_ADDRESS, STRANGER, 9n], FIXTURE_FROM + 4, 8, IDENTITY_REGISTRY),
    encodeLog("Registered", [9n, OPERATOR_CARD_URI, STRANGER], FIXTURE_FROM + 4, 9, IDENTITY_REGISTRY),
    encodeLog("MetadataSet", [9n, "agentWallet", "agentWallet", STRANGER], FIXTURE_FROM + 4, 10, IDENTITY_REGISTRY),
    // Block 6: agent 9 changes hands; the registry clears the wallet before the transfer.
    encodeLog("MetadataSet", [9n, "agentWallet", "agentWallet", "0x"], FIXTURE_FROM + 5, 0, IDENTITY_REGISTRY),
    encodeLog("Transfer", [STRANGER, AGENT_A, 9n], FIXTURE_FROM + 5, 1, IDENTITY_REGISTRY),
  ];
  const sink = PostgresSink.open(databaseUrl);
  try {
    await sink.applyBatch(toBatch(logs.map(toWrite), FIXTURE_FROM, FIXTURE_TO));
  } finally {
    await sink.close();
  }
  const response = await request(`/settlements?limit=200&${FROM_FIXTURE}`);
  const body = (await response.json()) as { settlements: unknown[] };
  assert.equal(body.settlements.length, 3);
});

interface SettlementsBody {
  readonly settlements: readonly {
    readonly settlementId: string;
    readonly agent: string;
    readonly amount: string;
    readonly applied: string;
    readonly toPrepaid: string;
    readonly collection: string;
    readonly openAfter: string | null;
    readonly monad: { readonly blockNumber: number; readonly logIndex: number; readonly txHash: string };
  }[];
  readonly nextCursor: string | null;
}

test("the feed is newest first, joined to the book, and every amount is a string", { skip }, async () => {
  const response = await request(`/settlements?limit=10&${FROM_FIXTURE}`);
  const body = (await response.json()) as SettlementsBody;
  assert.deepEqual(
    body.settlements.map((row) => row.settlementId),
    [settlementId(3), settlementId(2), settlementId(1)],
  );
  const overpaid = body.settlements[1];
  assert.notEqual(overpaid, undefined);
  if (overpaid === undefined) return;
  assert.equal(overpaid.amount, "700000");
  assert.equal(overpaid.applied, "500000");
  assert.equal(overpaid.toPrepaid, "200000");
  assert.equal(overpaid.collection, COLLECTION_A);
  // The book's own view of the same Settlement rides along.
  assert.equal(overpaid.openAfter, "0");
  assert.match(overpaid.monad.txHash, /^0x[0-9a-f]{64}$/);
});

test("filters are exact, and a filter with no match is an empty page", { skip }, async () => {
  const byAgent = (await (await request(`/settlements?agent=${AGENT_B}&${FROM_FIXTURE}`)).json()) as SettlementsBody;
  assert.deepEqual(byAgent.settlements.map((row) => row.settlementId), [settlementId(3)]);
  const byAsset = (await (await request(`/settlements?asset=${ASSET_A}&${FROM_FIXTURE}`)).json()) as SettlementsBody;
  assert.equal(byAsset.settlements.length, 2);
  const none = (await (await request(`/settlements?agent=${`0x${"99".repeat(20)}`}&${FROM_FIXTURE}`)).json()) as SettlementsBody;
  assert.deepEqual(none.settlements, []);
  assert.equal(none.nextCursor, null);
});

test("a cursor walk crosses a page boundary without loss or repetition", { skip }, async () => {
  const seen: string[] = [];
  let cursor = FROM_FIXTURE;
  for (let page = 0; page < 5; page += 1) {
    const body = (await (await request(`/settlements?limit=2&${cursor}`)).json()) as SettlementsBody;
    seen.push(...body.settlements.map((row) => row.settlementId));
    if (body.nextCursor === null) break;
    cursor = `cursor=${encodeURIComponent(body.nextCursor)}`;
  }
  assert.deepEqual(seen.slice(0, 3), [settlementId(3), settlementId(2), settlementId(1)]);
  assert.equal(new Set(seen).size, seen.length, "no row was served twice");
});

test("one Settlement is read back by its id", { skip }, async () => {
  const response = await request(`/settlements/${settlementId(2)}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { settlement: { agent: string; amount: string; openAfter: string | null } };
  assert.equal(body.settlement.agent, AGENT_A);
  assert.equal(body.settlement.amount, "700000");
  assert.equal(body.settlement.openAfter, "0");
});

test("deliveries are served newest first with their units and charge", { skip }, async () => {
  const response = await request(`/deliveries?agent=${AGENT_A}&${FROM_FIXTURE}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { deliveries: { units: number; amount: string; tool: string }[] };
  assert.equal(body.deliveries.length, 2);
  for (const delivery of body.deliveries) {
    assert.equal(delivery.units, 100);
    assert.equal(delivery.amount, "1000000");
    assert.equal(delivery.tool, TOOL);
  }
});

test("adoption counts every Metered Delivery exactly, from DeliveryRecorded", { skip }, async () => {
  if (reads === null) throw new Error("test: no reads");
  const counts = await reads.deliveryCountsByAgentAsset();
  assert.deepEqual(
    counts.filter((row) => row.agent === AGENT_A || row.agent === AGENT_B),
    [{ agent: AGENT_A, asset: ASSET_A, deliveryCount: 2 }],
    "both of Agent A's deliveries, and none for Agent B, whose only draw was prepaid",
  );

  // Agent A is ours on this chain only, so both deliveries count as internal here.
  const classifier = createClassifier(
    { network: "fixture", chainIds: [10143], internal: [{ address: AGENT_A, role: "fixture", why: "fixture", chainIds: [10143] }] },
    10143,
  );
  const adoptionApp = createApp({
    status: () => IDLE_STATUS,
    databaseReachable: () => reads.ping(),
    reads,
    adoption: { classifier, allowlistPath: "fixture" },
  });
  const response = await adoptionApp.request("/adoption");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { internalDeliveryCount: number; allowlist: { chainId: number; internalCount: number } };
  assert.equal(body.internalDeliveryCount, 2);
  assert.deepEqual(body.allowlist, { chainId: 10143, internalCount: 1, path: "fixture" });

  // The origin lists the route only where it is mounted.
  const root = (await (await adoptionApp.request("/")).json()) as { routes: string[] };
  assert.ok(root.routes.includes("/adoption"));
  const plainRoot = (await (await request("/")).json()) as { routes: string[] };
  assert.equal(plainRoot.routes.includes("/adoption"), false);
});

// ------------------------------------------------------------------ the Service

test("the Service directory serves tier, prices, window, and payout addresses", { skip }, async () => {
  const response = await request(`/services/${SERVICE_ID}`);
  assert.equal(response.status, 200);
  // One Service is served under `service`, beside the index horizon, which is
  // the shape the SDK's `tab_settle` reads before it builds a transaction.
  const { service } = (await response.json()) as {
    service: {
      serviceId: string;
      operator: string;
      tier: { value: number; name: string; creditWeight: string; source: { appliedBy: string } };
      settlementWindowSeconds: { value: number; source: { appliedBy: string } };
      acceptedAssets: { asset: string; collection: string }[];
      prices: { asset: string; tool: string; baseUnits: string }[];
      pendingChanges: unknown[];
    };
  };
  assert.equal(service.serviceId, SERVICE_ID);
  assert.equal(service.operator, OPERATOR);
  assert.equal(service.tier.name, "Permissionless");
  assert.equal(service.tier.creditWeight, "zero");
  assert.equal(service.tier.source.appliedBy, "registration");
  assert.equal(service.settlementWindowSeconds.value, 21_600);
  assert.deepEqual(
    service.acceptedAssets,
    [
      { asset: ASSET_B, collection: COLLECTION_B },
      { asset: ASSET_A, collection: COLLECTION_A },
    ].sort((a, b) => a.asset.localeCompare(b.asset)),
  );
  assert.equal(service.prices.length, 2);
  for (const price of service.prices) assert.equal(price.baseUnits, "10000");
  assert.deepEqual(service.pendingChanges, []);
});

test("the Service reports its Bond ledger replayed from the escrow's own events", { skip }, async () => {
  const response = await request(`/services/${SERVICE_ID}`);
  const { service } = (await response.json()) as {
    service: {
      bond: { asset: string; party: string; staked: string; withdrawn: string; free: string; depositCount: number; unavailable: { code: string } | null }[];
    };
  };
  assert.equal(service.bond.length, 1);
  const ledger = service.bond[0];
  assert.notEqual(ledger, undefined);
  if (ledger === undefined) return;
  assert.equal(ledger.asset, ASSET_A);
  assert.equal(ledger.party, PARTY);
  assert.equal(ledger.staked, "10000000");
  assert.equal(ledger.withdrawn, "3000000");
  assert.equal(ledger.free, "7000000");
  assert.equal(ledger.depositCount, 1);
  // No chain reader on this app, so the cross-check is withheld and says so.
  assert.equal(ledger.unavailable?.code, "CHAIN_READER_UNCONFIGURED");
});

test("an agreeing Bond cross-check serialises, and its figures are strings", { skip }, async () => {
  if (chainApp === null) throw new Error("test: no app");
  const response = await chainApp.request(`/services/${SERVICE_ID}`);
  assert.equal(response.status, 200);
  const { service } = (await response.json()) as {
    service: {
      bond: { crossCheck: { onChain: { staked: string; withdrawn: string; free: string }; agrees: true } | null; unavailable: unknown }[];
    };
  };
  const ledger = service.bond[0];
  assert.notEqual(ledger, undefined);
  if (ledger === undefined) return;
  assert.equal(ledger.unavailable, null);
  assert.deepEqual(ledger.crossCheck?.onChain, { staked: "10000000", withdrawn: "3000000", free: "7000000" });
  assert.equal(ledger.crossCheck?.agrees, true);
});

// ------------------------------------------------------------------ the Agents

test("the Agent read carries Open Tab, delinquency with its clearing, and settlement totals", { skip }, async () => {
  const response = await request(`/agents/${AGENT_A}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    assets: {
      asset: string;
      openTab: { observed: string; tabs: { openAfter: string }[] };
      delinquency: { delinquent: boolean; openCount: number; tabs: { tabId: string; resolved: boolean }[] };
      prepaid: { balance: string | null; funded: string | null };
      settlements: {
        settlementCount: number;
        settledTotal: string;
        appliedTotal: string;
        prepaidTotal: string;
        firstBlock: number;
        lastBlock: number;
        lastBlockTime: string | null;
      } | null;
    }[];
  };
  assert.equal(body.assets.length, 1);
  const view = body.assets[0];
  assert.notEqual(view, undefined);
  if (view === undefined) return;
  assert.equal(view.asset, ASSET_A);
  assert.equal(view.openTab.observed, "0");
  assert.equal(view.delinquency.delinquent, false, "the clearing resolved it");
  assert.equal(view.delinquency.openCount, 0);
  assert.deepEqual(view.delinquency.tabs.map((tab) => [tab.tabId, tab.resolved]), [[tabA1, true]]);
  assert.equal(view.prepaid.funded, "200000");
  assert.equal(view.prepaid.balance, "200000");
  assert.notEqual(view.settlements, null);
  if (view.settlements === null) return;
  assert.equal(view.settlements.settlementCount, 2);
  assert.equal(view.settlements.settledTotal, "2200000");
  assert.equal(view.settlements.appliedTotal, "2000000");
  assert.equal(view.settlements.prepaidTotal, "200000");
  assert.equal(view.settlements.firstBlock, FIXTURE_FROM + 1);
  assert.equal(view.settlements.lastBlock, FIXTURE_FROM + 2);
});

test("a witness the index cannot fold is refused whole, never served short", { skip }, async () => {
  // The fixture's HistoryExtended rows carry made-up roots, so the rebuilt
  // history cannot fold to the root the last row reported. The route answers
  // with the reason and no records at all, because a metering Service that
  // took a partial list would only learn of it from a revert after the gas.
  const response = await request(`/agents/${AGENT_A}/witness/${ASSET_A}`);
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: { code: string; category: string; details: { agent: string } } };
  assert.equal(body.error.category, "CONFLICT");
  assert.equal(body.error.code, "WITNESS_COMMITMENT_MISMATCH");
  assert.equal(body.error.details.agent, AGENT_A);
});

test("a prepaid-funded delivery explains itself on the Agent read", { skip }, async () => {
  const response = await request(`/agents/${AGENT_B}`);
  const body = (await response.json()) as {
    assets: { asset: string; prepaid: { balance: string | null; funded: string | null; consumed: string | null; borrowedOnDraw: string | null; drawCount: number } }[];
  };
  const view = body.assets.find((entry) => entry.asset === ASSET_B);
  assert.notEqual(view, undefined);
  if (view === undefined) return;
  assert.equal(view.prepaid.funded, "2000000");
  assert.equal(view.prepaid.consumed, "1500000");
  assert.equal(view.prepaid.balance, "500000");
  assert.equal(view.prepaid.borrowedOnDraw, "0");
  assert.equal(view.prepaid.drawCount, 1);
});

test("the Agent directory pages by most recent Settlement", { skip }, async () => {
  const response = await request(`/agents?limit=10&${FROM_FIXTURE}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { agents: { agent: string; settlementCount: number; settledTotal: string }[] };
  assert.deepEqual(
    body.agents.slice(0, 2).map((row) => [row.agent, row.settlementCount, row.settledTotal]),
    [
      [AGENT_B, 1, "2000000"],
      [AGENT_A, 2, "2200000"],
    ],
  );
});

// ------------------------------------------------------------------ identity and labels

interface IdentityBody {
  readonly identity: {
    readonly registry: string;
    readonly basis: string;
    readonly agents: readonly {
      readonly agentId: string;
      readonly owner: string;
      readonly agentWallet: string | null;
      readonly matchedBy: readonly string[];
      readonly agentURI: string | null;
      readonly agentURISource: string | null;
      readonly card: unknown;
      readonly cardUnavailable: { readonly code: string } | null;
      readonly reputation: {
        readonly registry: string | null;
        readonly count: number | null;
        readonly clientCount: number | null;
        readonly summaryValue: string | null;
        readonly summaryValueDecimals: number | null;
        readonly unavailable: { readonly code: string } | null;
        readonly fromTab: {
          readonly tag1: string;
          readonly tag2: string;
          readonly count: number | null;
          readonly clients: readonly string[] | null;
          readonly summaryValue: string | null;
          readonly summaryValueDecimals: number | null;
          readonly basis: string;
          readonly unavailable: { readonly code: string } | null;
        };
      };
      readonly blocks: { readonly registered: number | null; readonly owner: number; readonly uri: number | null; readonly wallet: number | null };
    }[];
  } | null;
  readonly labels: { readonly source: string; readonly labels?: unknown[]; readonly entity?: string; readonly unavailable?: { readonly code: string } };
}

test("without identity or a Nansen key the Agent read says so in place, never by omission", { skip }, async () => {
  const body = (await (await request(`/agents/${AGENT_A}`)).json()) as IdentityBody;
  assert.equal(body.identity, null);
  assert.equal(body.labels.source, "nansen");
  assert.equal(body.labels.unavailable?.code, "NANSEN_KEY_MISSING");
  assert.equal("labels" in body.labels, false);
});

test("the Agent read folds the identity events to owner, wallet and URI, and matches through either key", { skip }, async () => {
  if (identityApp === null) throw new Error("test: no app");
  const response = await identityApp.request(`/agents/${AGENT_A}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as IdentityBody;
  assert.notEqual(body.identity, null);
  if (body.identity === null) return;
  assert.equal(body.identity.registry, IDENTITY_REGISTRY);

  // Agent 7 through its wallet, agent 9 through ownership, lowest id first.
  assert.deepEqual(
    body.identity.agents.map((agent) => [agent.agentId, agent.matchedBy]),
    [
      ["7", ["agentWallet"]],
      ["9", ["owner"]],
    ],
  );

  const seven = body.identity.agents[0]!;
  assert.equal(seven.owner, OPERATOR);
  assert.equal(seven.agentWallet, AGENT_A, "the later MetadataSet wins");
  assert.equal(seven.agentURI, CARD_URI_UPDATED, "URIUpdated after Registered wins");
  assert.equal(seven.agentURISource, "index");
  assert.deepEqual(seven.card, CARD);
  assert.equal(seven.cardUnavailable, null);
  assert.deepEqual(seven.blocks, { registered: FIXTURE_FROM + 4, owner: FIXTURE_FROM + 4, uri: FIXTURE_FROM + 4, wallet: FIXTURE_FROM + 4 });
  // Reputation, read live and served with its inputs.
  assert.equal(seven.reputation.registry, REPUTATION_REGISTRY);
  assert.equal(seven.reputation.count, 2);
  assert.equal(seven.reputation.clientCount, 1);
  assert.equal(seven.reputation.summaryValue, "85");
  assert.equal(seven.reputation.summaryValueDecimals, 0);
  assert.equal(seven.reputation.unavailable, null);
  // And the part Tab Services wrote, asked over the Service operators under Tab's tags.
  assert.deepEqual(seven.reputation.fromTab, {
    tag1: "tab",
    tag2: "settled",
    count: 1,
    clients: [OPERATOR],
    summaryValue: "100",
    summaryValueDecimals: 0,
    basis: seven.reputation.fromTab.basis,
    unavailable: null,
  });
  assert.match(seven.reputation.fromTab.basis, /never read by the Credit Limit/);
  const asked = reputationAsked.find((entry) => entry.agentId === 7n && entry.filter !== undefined);
  assert.ok(asked?.filter?.clients.includes(OPERATOR), "the operators of registered Services are the client list");

  const nine = body.identity.agents[1]!;
  assert.equal(nine.owner, AGENT_A);
  assert.equal(nine.agentWallet, null, "the transfer cleared the wallet");
  assert.equal(nine.blocks.owner, FIXTURE_FROM + 5);
  assert.equal(nine.blocks.wallet, FIXTURE_FROM + 5);
  assert.deepEqual(nine.card, { ...CARD, name: "fixture operator" }, "a data: URI card decodes in process");
  assert.equal(nine.reputation.count, 0);

  // The overlay rides beside the facts with its provenance.
  assert.equal(body.labels.entity, "Fixture Fund");
  assert.equal(body.labels.labels?.length, 1);
});

test("an agent registered with an empty URI is served from the index, with no live read and a card that says why it is absent", { skip }, async () => {
  if (identityApp === null) throw new Error("test: no app");
  const body = (await (await identityApp.request(`/agents/${AGENT_B}`)).json()) as IdentityBody;
  assert.notEqual(body.identity, null);
  if (body.identity === null) return;
  assert.equal(body.identity.agents.length, 1);
  const eight = body.identity.agents[0]!;
  assert.equal(eight.agentId, "8");
  assert.deepEqual(eight.matchedBy, ["owner", "agentWallet"]);
  // An empty Registered URI is the index's answer, so no live read is made.
  assert.equal(eight.agentURI, "");
  assert.equal(eight.agentURISource, "index");
  assert.equal(eight.card, null);
  assert.equal(eight.cardUnavailable?.code, "CARD_URI_EMPTY");
  assert.equal(body.labels.unavailable?.code, "NANSEN_RATE_LIMITED");
});

test("the Service read carries the operator's identity the same way", { skip }, async () => {
  if (identityApp === null) throw new Error("test: no app");
  const response = await identityApp.request(`/services/${SERVICE_ID}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as IdentityBody & { service: { operator: string } };
  assert.equal(body.service.operator, OPERATOR);
  assert.notEqual(body.identity, null);
  if (body.identity === null) return;
  assert.deepEqual(
    body.identity.agents.map((agent) => [agent.agentId, agent.owner, agent.matchedBy]),
    [["7", OPERATOR, ["owner"]]],
  );
  // And the plain app, with identity off, serves null rather than nothing.
  const plain = (await (await request(`/services/${SERVICE_ID}`)).json()) as IdentityBody;
  assert.equal(plain.identity, null);
});

interface ReputationBody {
  readonly agent: string;
  readonly reputation: {
    readonly identityRegistry: string;
    readonly reputationRegistry: string | null;
    readonly agents: readonly {
      readonly agentId: string;
      readonly owner: string;
      readonly agentWallet: string | null;
      readonly matchedBy: readonly string[];
      readonly reputation: NonNullable<IdentityBody["identity"]>["agents"][number]["reputation"];
    }[];
  } | null;
}

test("the reputation read names each agent an address holds and what Tab Services wrote about it", { skip }, async () => {
  if (identityApp === null) throw new Error("test: no app");
  const response = await identityApp.request(`/agents/${AGENT_A.toUpperCase().replace("0X", "0x")}/reputation`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as ReputationBody;
  assert.equal(body.agent, AGENT_A);
  assert.notEqual(body.reputation, null);
  if (body.reputation === null) return;
  assert.equal(body.reputation.identityRegistry, IDENTITY_REGISTRY);
  assert.equal(body.reputation.reputationRegistry, REPUTATION_REGISTRY);
  assert.deepEqual(
    body.reputation.agents.map((agent) => [agent.agentId, agent.matchedBy, agent.reputation.count, agent.reputation.fromTab.count]),
    [
      ["7", ["agentWallet"], 2, 1],
      ["9", ["owner"], 0, 0],
    ],
  );
  // No registration file on this read: it is the light one a Service polls.
  assert.equal("card" in (body.reputation.agents[0] as object), false);

  const stranger = (await (await identityApp.request(`/agents/${`0x${"99".repeat(20)}`}/reputation`)).json()) as ReputationBody;
  assert.deepEqual(stranger.reputation?.agents, []);

  // Identity off is `null`, and a malformed address is refused.
  const plain = (await (await request(`/agents/${AGENT_A}/reputation`)).json()) as ReputationBody;
  assert.equal(plain.reputation, null);
  assert.equal((await request("/agents/0x1234/reputation")).status, 400);
});

test("a stranger's address has an empty identity under the stated basis", { skip }, async () => {
  if (identityApp === null) throw new Error("test: no app");
  const body = (await (await identityApp.request(`/agents/${`0x${"99".repeat(20)}`}`)).json()) as IdentityBody;
  assert.deepEqual(body.identity?.agents, []);
  assert.match(body.identity?.basis ?? "", /agents registered before the index's start block/);
});

test("the probes still answer beside the reads", { skip }, async () => {
  for (const path of ["/healthz", "/readyz"]) {
    const response = await request(path);
    assert.ok(response.status === 200 || response.status === 503, `${path} answers`);
  }
});

test("the fixture is removed, leaving the database as it was found", { skip }, async () => {
  await cleanUp();
  const body = (await (await request(`/settlements?limit=200&${FROM_FIXTURE}`)).json()) as SettlementsBody;
  assert.equal(body.settlements.filter((row) => row.agent === AGENT_A || row.agent === AGENT_B).length, 0);
});
