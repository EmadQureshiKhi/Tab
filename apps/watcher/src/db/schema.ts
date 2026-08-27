/**
 * Watcher persistence schema (Postgres, Drizzle).
 *
 * This is design section 8.7, expressed once. Three tables carry everything a
 * restart needs: what was observed, how far each chain has been read, and which
 * endpoint is in use. Nothing here is a cache — a row lost is a Settlement lost
 * (R20.6, R20.7).
 *
 * ## Why every hash and address is `bytea`
 *
 * A replay key is a packed 32-byte word, and the primary key of
 * `observed_settlement` is that word itself rather than a surrogate id. Storing
 * it as bytes makes the uniqueness the database enforces exactly the uniqueness
 * the contract enforces: one row per `(chainKey, blockHeight, txIndex, logIndex)`,
 * with no room for two spellings of the same key. Hex text would allow
 * `0xAB…` and `0xab…` to coexist and would silently break idempotence (R20.9).
 * `hexToBytes`/`bytesToHex` below are the only sanctioned boundary.
 *
 * ## Why `amount` is `NUMERIC(39,0)` and not `BIGINT`
 *
 * Amounts are integer base units of a token whose on-chain type is `uint256`. The
 * largest `uint256` has 78 digits, but the largest amount any real Asset can carry
 * comfortably fits 39, and `NUMERIC(39,0)` keeps arithmetic exact with no floating
 * point anywhere. Drizzle maps it to `bigint` in TypeScript, so no amount ever
 * becomes a `number`.
 *
 * ## Why `state` is `TEXT` and not a Postgres enum
 *
 * The state set is `OBSERVED|PROVISIONAL|READY|SUBMITTED|CONFIRMED|WITHHELD|HALTED`
 * and it lives in `state.ts`, which also owns the transition table. A Postgres
 * enum would put half of that knowledge in a migration and turn adding a state into
 * a schema change, while enforcing nothing about *transitions*, which is where the
 * real invariant is. The column is `TEXT` typed as {@link SettlementState}, and
 * `isSettlementState` narrows anything read back.
 *
 * ## Two indexes, each answering one hot question
 *
 * - `observed_state_idx (state, next_attempt_at)` — "what is due now?", the query
 *   the retry loop runs continuously.
 * - `observed_chain_block_idx (chain_key, block_height)` — "what did I see in this
 *   block range?", the query gap catch-up runs after a restart (R20.8).
 *
 * Requirements: 20.6, 20.7, 20.9, 20.11, 20.12
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import type { SettlementState } from "../state.js";

/**
 * Postgres `bytea`, carried as bytes in TypeScript.
 *
 * Drizzle ships no `bytea` column, so it is defined here once. `postgres` hands
 * back a `Buffer`, which is already a `Uint8Array`, so reading is a pass-through
 * and only writing normalises.
 */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  },
  fromDriver(value: Buffer): Uint8Array {
    return value;
  },
});

/** Which proof path produced the material a submission rests on. */
export const PROOF_SOURCES = ["PROOF_BUILDER", "RAW_BUILDER"] as const;

/** Proof path recorded on a row, so a bad source can be identified after the fact. */
export type ProofSource = (typeof PROOF_SOURCES)[number];

/**
 * The on-chain clearing lifecycle, mirroring `ITabBook.ClearingState` name for
 * name so the two cannot be read against each other wrongly.
 *
 * This column is a **cache of chain state, never the authority**. `TabBook` moves
 * a clearing without the Watcher's involvement — `reverseExpiredClearing` is a
 * permissionless crank and confirmation arrives through the `SettlementVerifier` —
 * so the only trustworthy answer is `clearingOf(replayKey)`. What the column earns
 * is the ability to keep a settled question out of the sweep: `DECLINED` is
 * terminal on chain, because `_openClearing` reverts `ClearingAlreadyExists` for
 * any identity that already carries a record, so a declined observation can never
 * be cleared again and re-attempting it would burn gas on a certain revert.
 */
export const CLEARING_STATES = [
  "NONE",
  "APPLIED",
  "CONFIRMED",
  "REVERSED",
  "DECLINED",
  "SUPERSEDED",
] as const;

/** Last known position of one clearing in the `TabBook` lifecycle. */
export type ClearingStateName = (typeof CLEARING_STATES)[number];

/** What a Collection Address collects for, mirroring `IServiceRegistry.CollectionKind`. */
export const COLLECTION_KINDS = ["TAB", "BOND"] as const;

/** Whether Settlements to the observed address reduce an Open Tab or fund stake. */
export type CollectionKindName = (typeof COLLECTION_KINDS)[number];

/**
 * Every Settlement the Watcher has seen, and where each one stands.
 *
 * The primary key is the replay key, so a duplicate observation of the same log
 * collides with itself rather than creating a second row. That is the database
 * half of the idempotence R20.9 requires; the other half is that the key is
 * written as `SUBMITTED` before any broadcast.
 */
export const observedSettlement = pgTable(
  "observed_settlement",
  {
    /** The packed 32-byte replay key: `(chainKey, blockHeight, txIndex, logIndex)`. */
    replayKey: bytea("replay_key").primaryKey(),
    chainKey: bigint("chain_key", { mode: "bigint" }).notNull(),
    blockHeight: bigint("block_height", { mode: "bigint" }).notNull(),
    /**
     * Null until proof material exists. The transaction index is derived from the
     * Merkle sibling path, so it is unknown at observation time and is not
     * guessed from the RPC log.
     */
    txIndex: bigint("tx_index", { mode: "bigint" }),
    logIndex: bigint("log_index", { mode: "bigint" }).notNull(),
    sourceTxHash: bytea("source_tx_hash").notNull(),
    asset: bytea("asset").notNull(),
    /** Read from `topics[1]`, never from the transaction sender. */
    payerAddress: bytea("payer_address").notNull(),
    collectionAddress: bytea("collection_address").notNull(),
    serviceId: bytea("service_id").notNull(),
    /** Integer base units of the Asset. Exact, never floating point. */
    amount: numeric("amount", { precision: 39, scale: 0, mode: "bigint" }).notNull(),
    /** One of `SETTLEMENT_STATES`; transitions are governed by `state.ts`. */
    state: text("state").$type<SettlementState>().notNull(),
    /**
     * The block digest observed when the Provisional Clearing was applied. At
     * confirmation the precompile is asked which height that digest belongs to; a
     * reorg surfaces as "no height", which is why the digest is stored rather than
     * re-derived later.
     */
    attestedDigest: bytea("attested_digest"),
    clearingId: bytea("clearing_id"),
    proofSource: text("proof_source").$type<ProofSource>(),
    /** The root the Watcher derived itself. */
    localRoot: bytea("local_root"),
    /** The root the builder claimed. Kept beside the local one so a mismatch is auditable. */
    receivedRoot: bytea("received_root"),
    submitAttempts: integer("submit_attempts").notNull().default(0),
    /** When the backoff schedule next allows an attempt. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
    ccTxHash: bytea("cc_tx_hash"),
    lastErrorCategory: text("last_error_category"),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    // The two columns below were appended by `drizzle/0001_observation.sql`, and
    // they are declared last here because `ALTER TABLE ... ADD COLUMN` appends
    // physically. Keeping declaration order equal to physical order is what lets
    // `test/schema.test.mjs` compare the two sources column by column.
    /**
     * Contract that emitted the observed log.
     *
     * Not derivable from `asset`: on chainKey 1 the Settlement surface is the
     * registered settlement contract emitting `TabSettled`, so the emitter and the
     * Asset are two different addresses, and without this column the row cannot say
     * which surface produced it. Nullable because an `ALTER TABLE` cannot invent a
     * truthful value for a row already written, and a null saying "not recorded" is
     * better than a zero address that reads as a real one.
     */
    emitterAddress: bytea("emitter_address"),
    /** Last known {@link ClearingStateName}; see {@link CLEARING_STATES}. */
    clearingState: text("clearing_state").$type<ClearingStateName>(),
  },
  (table) => [
    // "What is due now?" — the retry loop's only query.
    index("observed_state_idx").on(table.state, table.nextAttemptAt),
    // "What did I see in this block range?" — gap catch-up after a restart.
    index("observed_chain_block_idx").on(table.chainKey, table.blockHeight),
  ],
);

/**
 * How far each chain has been read, and whether it is still attesting.
 *
 * `attesting` is written by discovery and read by the health endpoint, which is
 * what makes a chain going quiet an observable state rather than a crash.
 *
 * `last_processed_block` is `NOT NULL` and starts at 0. Zero means "no block has
 * been processed yet", so readiness treats a chain at 0 as having no cursor and
 * `GET /readyz` answers 503 until catch-up has made progress.
 *
 * `updated_at` carries a specific meaning here: **when the attested frontier last
 * advanced**. Discovery reads it to tell a slow chain from a stopped one, so a
 * writer that bumps it without the frontier having moved silently disables the
 * staleness check. Move `last_processed_block` without touching it.
 */
export const chainCursor = pgTable("chain_cursor", {
  chainKey: bigint("chain_key", { mode: "bigint" }).primaryKey(),
  lastProcessedBlock: bigint("last_processed_block", { mode: "bigint" }).notNull(),
  lastAttestedHeight: bigint("last_attested_height", { mode: "bigint" }).notNull(),
  attesting: boolean("attesting").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .default(sql`now()`),
});

/**
 * One row per configured endpoint per chain, carrying the failure count the
 * rotation rule reads: after 3 consecutive failures the Watcher moves to the next
 * endpoint and resets the counter (R20.11).
 *
 * The count is persisted rather than held in memory so a restart does not hand a
 * known-bad endpoint a clean slate.
 */
export const endpointHealth = pgTable(
  "endpoint_health",
  {
    chainKey: bigint("chain_key", { mode: "bigint" }).notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    active: boolean("active").notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.chainKey, table.endpointUrl] })],
);

/** Every table, for the migration check and for the Drizzle client's schema. */
export const schema = { observedSettlement, chainCursor, endpointHealth };

/** A row of `observed_settlement` as read back. */
export type ObservedSettlementRow = typeof observedSettlement.$inferSelect;
/** A row of `observed_settlement` as written. */
export type NewObservedSettlementRow = typeof observedSettlement.$inferInsert;
/** A row of `chain_cursor` as read back. */
export type ChainCursorRow = typeof chainCursor.$inferSelect;
/** A row of `endpoint_health` as read back. */
export type EndpointHealthRow = typeof endpointHealth.$inferSelect;

/**
 * `0x`-prefixed hex to bytes, for writing a replay key, hash, or address.
 *
 * @throws TypeError when the input is not `0x` followed by an even number of hex digits
 */
export function hexToBytes(hex: string): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) {
    throw new TypeError(`expected 0x-prefixed hex of whole bytes, received \`${hex}\``);
  }
  return new Uint8Array(Buffer.from(hex.slice(2), "hex"));
}

/** Bytes to `0x`-prefixed lowercase hex, for reading one back. */
export function bytesToHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex")}`;
}
