/**
 * The Drizzle schema, under the Postgres schema `registry`.
 *
 * One database, two schemas: `watcher` owns the submission pipeline's state and
 * `registry` owns this read layer. They never write each other's tables, so the
 * read API can be scaled out horizontally while the Watcher stays a single writer
 * per chainKey.
 *
 * ## Shape of the whole thing
 *
 * `event_log` is the envelope of every indexed log and the only table with an
 * identity of its own: `(block_hash, log_index)`. Every typed table hangs off it
 * with that same pair as both its primary key and a cascading foreign key. Three
 * consequences, and all three are the point:
 *
 * - **Re-indexing is idempotent.** A log carries the same envelope every time it
 *   is read, so a second pass collides on the primary key and writes nothing new.
 * - **A reorganisation is one delete.** Removing the envelope rows for a block
 *   range takes every typed row with them, so no typed table can outlive the log
 *   it decoded.
 * - **No typed row can exist without provenance.** Every settled amount in here
 *   is reachable back to a block hash, a transaction hash, and a log ordinal, which
 *   is what makes the read API checkable against the chain rather than believed.
 *
 * ## Column conventions
 *
 * - **Byte-shaped values are lowercase `0x` hex in `text`,** not `bytea`. Every
 *   read serves them as hex over JSON, so text removes an encode step on the hot
 *   path and a decode step on every hand-written query, and the SQL carries a
 *   `CHECK` on shape and width so a malformed value cannot land. Amounts do not
 *   get this treatment, because arithmetic on them has to be arithmetic.
 * - **`uint256` and `uint128` are `numeric(78, 0)` and `numeric(39, 0)`,** the
 *   exact decimal widths of those two ranges. Read back as strings and converted
 *   with `BigInt`; never through a float.
 * - **`uint64` is `bigint`.** A `uint64` at its ceiling exceeds a signed 64-bit
 *   column, but block heights, chain keys, and timestamps are nowhere near it. The
 *   coordinates that must survive the full range are carried inside `replay_key`,
 *   which is hex.
 * - **Enumerations carry both the number and the member name.** The number the
 *   contract emitted is the fact; the name is derived in `enum-names.ts` so a row
 *   is legible without the contract source open beside it.
 *
 * ## Which files the database actually gets
 *
 * `sql/0001_registry_schema.sql` and `sql/0002_credit_and_bond.sql` are applied to
 * the database, in lexical order, and are the authority for the parts of the
 * schema a query builder does not need to know: the cascading foreign keys, the
 * shape `CHECK`s on every hex column, and the schema itself. This module declares
 * the tables and columns the queries are written against, and
 * `test/schema.test.ts` asserts the two agree table for table and column for
 * column, so neither can drift from the other unnoticed.
 *
 * Requirements: 12.6, 24.4
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** Everything this service owns lives under one Postgres schema. */
export const registrySchema = pgSchema("registry");

/** Decimal width of a `uint256`. */
const UINT256 = { precision: 78, scale: 0 } as const;
/** Decimal width of a `uint128`. */
const UINT128 = { precision: 39, scale: 0 } as const;

// ------------------------------------------------------------------ envelope

/**
 * One row per indexed log. The identity of every other row in the schema.
 *
 * `block_time` is nullable on purpose. A log carries no timestamp, so the
 * timestamp is a second read against the chain, and the indexer treats a failed
 * or skipped block read as a missing timestamp rather than as a reason to drop a
 * settled amount on the floor.
 */
export const eventLog = registrySchema.table(
  "event_log",
  {
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    blockHash: text("block_hash").notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }),
    txHash: text("tx_hash").notNull(),
    txIndex: integer("tx_index").notNull(),
    logIndex: integer("log_index").notNull(),
    emitter: text("emitter").notNull(),
    topic0: text("topic0").notNull(),
    eventName: text("event_name").notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("event_log_block_idx").on(table.blockNumber, table.logIndex),
    index("event_log_name_idx").on(table.eventName, table.blockNumber),
    index("event_log_tx_idx").on(table.txHash),
  ],
);

/**
 * Every block that produced at least one indexed log, with the hash it carried.
 *
 * This is the reorganisation detector. A block number whose hash has changed since
 * it was indexed is a block that was re-mined, and the indexer rewinds to it. A
 * reorganisation confined to blocks that produced no log we index leaves no trace
 * here and needs none, because there is nothing of ours to correct.
 */
export const indexedBlock = registrySchema.table("indexed_block", {
  blockNumber: bigint("block_number", { mode: "number" }).primaryKey(),
  blockHash: text("block_hash").notNull(),
  logCount: integer("log_count").notNull(),
  seenAt: timestamp("seen_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

/**
 * How far the indexer has read. One row per named stream, so a second stream over
 * a different address set can be added without touching this one.
 */
export const indexerCursor = registrySchema.table("indexer_cursor", {
  stream: text("stream").primaryKey(),
  lastBlock: bigint("last_block", { mode: "number" }).notNull(),
  lastBlockHash: text("last_block_hash"),
  reorgCount: integer("reorg_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// ------------------------------------------------------------- typed payloads

/** The `(block_hash, log_index)` pair every typed table is keyed and joined by. */
const envelopeColumns = {
  blockHash: text("block_hash").notNull(),
  logIndex: integer("log_index").notNull(),
} as const;

/**
 * `SettlementVerifier.SettlementRecorded` — eleven fields, in the contract's own
 * order.
 *
 * The five coordinates come first because they are the Settlement's identity:
 * `replay_key` is the packed form and `chain_key`, `source_block_height`,
 * `source_tx_index`, and `source_log_index` are the same tuple unpacked, stored
 * both ways so a caller can filter on a coordinate without unpacking and join on
 * the key without repacking.
 *
 * `source_log_index` is the ordinal of the log within its own transaction's
 * receipt logs, which is not the block-wide `log_index` of the envelope. The two
 * columns are deliberately not named alike.
 *
 * `payer_address` is the Source Chain address taken from `topics[1]`, and `agent`
 * is who that address is bound to. They are different facts and both are kept.
 */
export const settlementRecorded = registrySchema.table(
  "settlement_recorded",
  {
    ...envelopeColumns,
    replayKey: text("replay_key").notNull(),
    chainKey: bigint("chain_key", { mode: "number" }).notNull(),
    sourceBlockHeight: bigint("source_block_height", { mode: "number" }).notNull(),
    sourceTxIndex: bigint("source_tx_index", { mode: "number" }).notNull(),
    sourceLogIndex: bigint("source_log_index", { mode: "number" }).notNull(),
    agent: text("agent").notNull(),
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT256).notNull(),
    payerAddress: text("payer_address").notNull(),
    sourceTabId: text("source_tab_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("settlement_recorded_replay_idx").on(table.replayKey),
    index("settlement_recorded_agent_idx").on(table.agent, table.asset),
    index("settlement_recorded_service_idx").on(table.serviceId, table.asset),
    index("settlement_recorded_payer_idx").on(table.chainKey, table.payerAddress),
  ],
);

/**
 * `BondDepositRecorded`: a proven deposit that funded stake.
 *
 * The Bond branch emits this where the tab branch emits `SettlementRecorded`, so a
 * deposit is absent from the settlement feed entirely. It is the only event
 * carrying the Bond `party` alongside the `serviceId`.
 */
export const bondDepositRecorded = registrySchema.table(
  "bond_deposit_recorded",
  {
    ...envelopeColumns,
    replayKey: text("replay_key").notNull(),
    chainKey: bigint("chain_key", { mode: "number" }).notNull(),
    sourceBlockHeight: bigint("source_block_height", { mode: "number" }).notNull(),
    sourceTxIndex: bigint("source_tx_index", { mode: "number" }).notNull(),
    sourceLogIndex: bigint("source_log_index", { mode: "number" }).notNull(),
    depositor: text("depositor").notNull(),
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT256).notNull(),
    payerAddress: text("payer_address").notNull(),
    party: text("party").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("bond_deposit_recorded_replay_idx").on(table.replayKey),
    index("bond_deposit_recorded_party_idx").on(table.serviceId, table.party, table.asset),
  ],
);

/** `TabBook.SettlementApplied` — what the Verified Settlement did to the tab. */
export const settlementApplied = registrySchema.table(
  "settlement_applied",
  {
    ...envelopeColumns,
    replayKey: text("replay_key").notNull(),
    agent: text("agent").notNull(),
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    applied: numeric("applied", UINT256).notNull(),
    toPrepaid: numeric("to_prepaid", UINT256).notNull(),
    openAfter: numeric("open_after", UINT128).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("settlement_applied_replay_idx").on(table.replayKey),
    index("settlement_applied_agent_idx").on(table.agent, table.asset),
  ],
);

/**
 * `TabBook.ProvisionalClearingApplied` — the `provisional` state.
 *
 * `clearing_id` is the replay key of the observed Settlement, which is the
 * clearing's identity and is computed independently by both sides rather than
 * supplied by a caller.
 */
export const provisionalClearingApplied = registrySchema.table(
  "provisional_clearing_applied",
  {
    ...envelopeColumns,
    clearingId: text("clearing_id").notNull(),
    agent: text("agent").notNull(),
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT128).notNull(),
    sourceTxHash: text("source_tx_hash").notNull(),
    deadline: bigint("deadline", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("clearing_applied_id_idx").on(table.clearingId),
    index("clearing_applied_agent_idx").on(table.agent, table.asset),
    index("clearing_applied_deadline_idx").on(table.deadline),
  ],
);

/** `TabBook.ProvisionalClearingConfirmed` — the `confirmed` state. */
export const provisionalClearingConfirmed = registrySchema.table(
  "provisional_clearing_confirmed",
  {
    ...envelopeColumns,
    clearingId: text("clearing_id").notNull(),
    agent: text("agent").notNull(),
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT128).notNull(),
    sourceTxHash: text("source_tx_hash").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("clearing_confirmed_id_idx").on(table.clearingId),
    index("clearing_confirmed_agent_idx").on(table.agent, table.asset),
  ],
);

/** `TabBook.ProvisionalClearingReversed` — the `reversed` state. */
export const provisionalClearingReversed = registrySchema.table(
  "provisional_clearing_reversed",
  {
    ...envelopeColumns,
    clearingId: text("clearing_id").notNull(),
    agent: text("agent").notNull(),
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT128).notNull(),
    sourceTxHash: text("source_tx_hash").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("clearing_reversed_id_idx").on(table.clearingId),
    index("clearing_reversed_agent_idx").on(table.agent, table.asset),
  ],
);

/**
 * `TabBook.ProvisionalClearingDeclined` — the `declined` state.
 *
 * **A decline is not a failed Settlement.** Free Bond did not cover an
 * observation, so the Open Tab was left alone until the Verified Settlement
 * arrives, and `free_bond` records how much Bond there was at that moment so the
 * shortfall is legible rather than inferred.
 *
 * There is no `clearing_id` column because a decline creates no clearing: the
 * contract emits no identity for something that does not exist. The row is keyed
 * by its own log and located by `source_tx_hash`.
 */
export const provisionalClearingDeclined = registrySchema.table(
  "provisional_clearing_declined",
  {
    ...envelopeColumns,
    agent: text("agent").notNull(),
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT128).notNull(),
    sourceTxHash: text("source_tx_hash").notNull(),
    freeBond: numeric("free_bond", UINT128).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("clearing_declined_agent_idx").on(table.agent, table.asset),
    index("clearing_declined_source_tx_idx").on(table.sourceTxHash),
  ],
);

/**
 * `TabBook.SettlementSuperseded` — the `superseded` state.
 *
 * The only report of a Source Chain reorganisation taking away a Verified
 * Settlement that had already confirmed. Both digests are kept: the one observed
 * when the clearing was applied and the one the attested chain now carries, which
 * is zero when the block has left the attested chain entirely.
 */
export const settlementSuperseded = registrySchema.table(
  "settlement_superseded",
  {
    ...envelopeColumns,
    replayKey: text("replay_key").notNull(),
    agent: text("agent").notNull(),
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT128).notNull(),
    observedDigest: text("observed_digest").notNull(),
    attestedDigest: text("attested_digest").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("settlement_superseded_replay_idx").on(table.replayKey),
    index("settlement_superseded_agent_idx").on(table.agent, table.asset),
  ],
);

/** `TabBook.TabDelinquent` — an Open Tab passed its Settlement Window unsettled. */
export const tabDelinquent = registrySchema.table(
  "tab_delinquent",
  {
    ...envelopeColumns,
    tabId: text("tab_id").notNull(),
    agent: text("agent").notNull(),
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    unsettled: numeric("unsettled", UINT128).notNull(),
    windowEnd: bigint("window_end", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("tab_delinquent_tab_idx").on(table.tabId),
    index("tab_delinquent_agent_idx").on(table.agent, table.asset),
  ],
);

/** `AgentRegistry.AddressBound` — a Source Chain address proven to belong to an Agent. */
export const addressBound = registrySchema.table(
  "address_bound",
  {
    ...envelopeColumns,
    agent: text("agent").notNull(),
    chainKey: bigint("chain_key", { mode: "number" }).notNull(),
    ethAddress: text("eth_address").notNull(),
    provingReplayKey: text("proving_replay_key").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("address_bound_agent_idx").on(table.agent, table.chainKey),
    index("address_bound_address_idx").on(table.chainKey, table.ethAddress),
  ],
);

/**
 * `ServiceRegistry.RegistryChangeQueued` — a change entered its 48-hour hold.
 *
 * `payload` is kept as the raw abi-encoded hex the contract emitted. Decoding it
 * needs the `kind`, and a wrong guess would rewrite a price or a tier in the read
 * layer while the chain says something else, so the bytes are stored whole and the
 * read layer decodes per kind at the point of use.
 */
export const registryChangeQueued = registrySchema.table(
  "registry_change_queued",
  {
    ...envelopeColumns,
    changeId: text("change_id").notNull(),
    serviceId: text("service_id").notNull(),
    changeKind: smallint("change_kind").notNull(),
    changeKindName: text("change_kind_name").notNull(),
    payload: text("payload").notNull(),
    eta: bigint("eta", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("change_queued_id_idx").on(table.changeId),
    index("change_queued_service_idx").on(table.serviceId, table.eta),
  ],
);

/** `ServiceRegistry.RegistryChangeApplied` — the hold elapsed and the change landed. */
export const registryChangeApplied = registrySchema.table(
  "registry_change_applied",
  {
    ...envelopeColumns,
    changeId: text("change_id").notNull(),
    serviceId: text("service_id").notNull(),
    changeKind: smallint("change_kind").notNull(),
    changeKindName: text("change_kind_name").notNull(),
    payload: text("payload").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("change_applied_id_idx").on(table.changeId),
    index("change_applied_service_idx").on(table.serviceId),
  ],
);

/**
 * `ServiceRegistry.RegistryChangeCancelled` — the change was withdrawn.
 *
 * Indexed so a pending-change read can tell a change that is waiting from one
 * that was called off. Without it the read layer would serve a cancelled change as
 * pending forever, with an ETA that never arrives.
 */
export const registryChangeCancelled = registrySchema.table(
  "registry_change_cancelled",
  {
    ...envelopeColumns,
    changeId: text("change_id").notNull(),
    serviceId: text("service_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("change_cancelled_id_idx").on(table.changeId),
  ],
);

/** `ServiceRegistry.ServiceRegistered` — a Service joined, always at the Permissionless Tier. */
export const serviceRegistered = registrySchema.table(
  "service_registered",
  {
    ...envelopeColumns,
    serviceId: text("service_id").notNull(),
    operator: text("operator").notNull(),
    tier: smallint("tier").notNull(),
    tierName: text("tier_name").notNull(),
    settlementWindow: bigint("settlement_window", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("service_registered_service_idx").on(table.serviceId),
    index("service_registered_operator_idx").on(table.operator),
  ],
);

/** `ServiceRegistry.EmitterAuthorised` — a `(chainKey, emitter)` pair became authorised. */
export const emitterAuthorised = registrySchema.table(
  "emitter_authorised",
  {
    ...envelopeColumns,
    chainKey: bigint("chain_key", { mode: "number" }).notNull(),
    emitter: text("emitter").notNull(),
    emitterKind: smallint("emitter_kind").notNull(),
    emitterKindName: text("emitter_kind_name").notNull(),
    asset: text("asset").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("emitter_authorised_pair_idx").on(table.chainKey, table.emitter),
  ],
);

/** `ServiceRegistry.CollectionRegistered` — a Collection Address was claimed. */
export const collectionRegistered = registrySchema.table(
  "collection_registered",
  {
    ...envelopeColumns,
    serviceId: text("service_id").notNull(),
    chainKey: bigint("chain_key", { mode: "number" }).notNull(),
    collection: text("collection").notNull(),
    asset: text("asset").notNull(),
    collectionKind: smallint("collection_kind").notNull(),
    collectionKindName: text("collection_kind_name").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("collection_registered_pair_idx").on(table.chainKey, table.collection),
    index("collection_registered_service_idx").on(table.serviceId),
  ],
);

/**
 * `ServiceRegistry.CollectionReleased` — a Collection Address stopped resolving.
 *
 * The counterpart of a registration. A reader replaying registrations alone would
 * still believe a moved address resolves to its old Service.
 */
export const collectionReleased = registrySchema.table(
  "collection_released",
  {
    ...envelopeColumns,
    serviceId: text("service_id").notNull(),
    chainKey: bigint("chain_key", { mode: "number" }).notNull(),
    collection: text("collection").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("collection_released_pair_idx").on(table.chainKey, table.collection),
  ],
);

/** `ServiceRegistry.ToolPriceSet` — a price in Asset base units for one named tool. */
export const toolPriceSet = registrySchema.table(
  "tool_price_set",
  {
    ...envelopeColumns,
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    tool: text("tool").notNull(),
    baseUnits: numeric("base_units", UINT256).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("tool_price_service_idx").on(table.serviceId, table.asset),
  ],
);

// ------------------------------------------------------------ credit witness

/**
 * `TabBook.HistoryExtended` - the committed `LimitLib.SettlementRecord`, flattened.
 *
 * One row per Verified Settlement that reached a tab, and `count` is the
 * commitment length after the append, so the rows for one `(agent, asset)` ordered
 * by `count` are the witness in the exact order the contract folded it. The eight
 * `record_*` columns are the struct in declaration order, and `root` is what a
 * rebuilt witness is checked against before any figure is served from it.
 */
export const historyExtended = registrySchema.table(
  "history_extended",
  {
    ...envelopeColumns,
    agent: text("agent").notNull(),
    asset: text("asset").notNull(),
    root: text("root").notNull(),
    count: integer("count").notNull(),
    recordServiceId: text("record_service_id").notNull(),
    recordAsset: text("record_asset").notNull(),
    recordAmount: numeric("record_amount", UINT128).notNull(),
    recordSettledAt: bigint("record_settled_at", { mode: "number" }).notNull(),
    recordFirstDeliveryAt: bigint("record_first_delivery_at", { mode: "number" }).notNull(),
    recordChainKey: bigint("record_chain_key", { mode: "number" }).notNull(),
    recordCurated: boolean("record_curated").notNull(),
    recordBonded: boolean("record_bonded").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("history_extended_agent_idx").on(table.agent, table.asset, table.count),
  ],
);

/** `TabBook.AuthorisationSet` - an Agent named a Service as a counterparty. */
export const authorisationSet = registrySchema.table(
  "authorisation_set",
  {
    ...envelopeColumns,
    agent: text("agent").notNull(),
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    maxCumulative: numeric("max_cumulative", UINT128).notNull(),
    expiry: bigint("expiry", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("authorisation_set_agent_idx").on(table.agent, table.asset),
  ],
);

/**
 * `TabBook.PrepaidConsumed` - a Metered Delivery paid out of prepaid credit.
 *
 * The counterpart to `settlement_applied.to_prepaid`, which records prepaid credit
 * arriving. Without this table nothing recorded it leaving, so a tab funded by an
 * excess settlement read as permanently funded. `prepaidAfter` is the balance left on
 * the tab at this log, and `openAdded` is how much of the same charge had to be
 * borrowed once the balance ran out - zero for a delivery paid entirely out of credit.
 */
export const prepaidConsumed = registrySchema.table(
  "prepaid_consumed",
  {
    ...envelopeColumns,
    agent: text("agent").notNull(),
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    consumed: numeric("consumed", UINT128).notNull(),
    prepaidAfter: numeric("prepaid_after", UINT128).notNull(),
    openAdded: numeric("open_added", UINT128).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("prepaid_consumed_agent_idx").on(table.agent, table.asset),
  ],
);

// ---------------------------------------------------------------- Bond ledger
//
// The four stored ledger figures in motion. `staked` only ever grows through
// `BondFunded`; `reserved` grows through `BondReserved` and shrinks through
// `BondReleased` and `SlashedForUnconfirmedClearing`; `slashed` grows through both
// slashes; `released` grows through `WithdrawalReleased`. Free Bond is the
// difference, and `queries.ts` derives it exactly the way `Bond._free` does.

/** `Bond.BondFunded` - a proven deposit credited to a ledger. */
export const bondFunded = registrySchema.table(
  "bond_funded",
  {
    ...envelopeColumns,
    party: text("party").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT128).notNull(),
    replayKey: text("replay_key").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("bond_funded_party_idx").on(table.party, table.asset),
    index("bond_funded_replay_idx").on(table.replayKey),
  ],
);

/** `Bond.BondReserved` - a pledge against a Provisional Clearing. */
export const bondReserved = registrySchema.table(
  "bond_reserved",
  {
    ...envelopeColumns,
    clearingId: text("clearing_id").notNull(),
    party: text("party").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT128).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("bond_reserved_party_idx").on(table.party, table.asset),
    index("bond_reserved_id_idx").on(table.clearingId),
  ],
);

/** `Bond.BondReleased` - a pledge returned to free Bond on confirmation. */
export const bondReleased = registrySchema.table(
  "bond_released",
  {
    ...envelopeColumns,
    clearingId: text("clearing_id").notNull(),
    party: text("party").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT128).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("bond_released_party_idx").on(table.party, table.asset),
  ],
);

/** `Bond.SlashedForUnconfirmedClearing` - a pledge slashed at its deadline. */
export const slashedForUnconfirmedClearing = registrySchema.table(
  "slashed_for_unconfirmed_clearing",
  {
    ...envelopeColumns,
    clearingId: text("clearing_id").notNull(),
    party: text("party").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT128).notNull(),
    beneficiary: text("beneficiary").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("slashed_unconfirmed_party_idx").on(table.party, table.asset),
  ],
);

/** `Bond.SlashedForReorg` - free stake slashed for a superseded Settlement. */
export const slashedForReorg = registrySchema.table(
  "slashed_for_reorg",
  {
    ...envelopeColumns,
    replayKey: text("replay_key").notNull(),
    party: text("party").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT128).notNull(),
    beneficiary: text("beneficiary").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("slashed_reorg_party_idx").on(table.party, table.asset),
  ],
);

/** `Bond.ReorgSlashShortfall` - the uncovered remainder of a reorg slash. */
export const reorgSlashShortfall = registrySchema.table(
  "reorg_slash_shortfall",
  {
    ...envelopeColumns,
    replayKey: text("replay_key").notNull(),
    party: text("party").notNull(),
    asset: text("asset").notNull(),
    requested: numeric("requested", UINT128).notNull(),
    slashed: numeric("slashed", UINT128).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("reorg_shortfall_party_idx").on(table.party, table.asset),
  ],
);

/** `Bond.WithdrawalReleased` - free stake moved to the withdrawal-eligible figure. */
export const withdrawalReleased = registrySchema.table(
  "withdrawal_released",
  {
    ...envelopeColumns,
    party: text("party").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT128).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("withdrawal_released_party_idx").on(table.party, table.asset),
  ],
);

/** Every typed table, keyed by the event whose rows it holds. */
export const TYPED_TABLES = {
  SettlementRecorded: settlementRecorded,
  BondDepositRecorded: bondDepositRecorded,
  SettlementApplied: settlementApplied,
  ProvisionalClearingApplied: provisionalClearingApplied,
  ProvisionalClearingConfirmed: provisionalClearingConfirmed,
  ProvisionalClearingReversed: provisionalClearingReversed,
  ProvisionalClearingDeclined: provisionalClearingDeclined,
  SettlementSuperseded: settlementSuperseded,
  TabDelinquent: tabDelinquent,
  AddressBound: addressBound,
  RegistryChangeQueued: registryChangeQueued,
  RegistryChangeApplied: registryChangeApplied,
  RegistryChangeCancelled: registryChangeCancelled,
  ServiceRegistered: serviceRegistered,
  EmitterAuthorised: emitterAuthorised,
  CollectionRegistered: collectionRegistered,
  CollectionReleased: collectionReleased,
  ToolPriceSet: toolPriceSet,
  HistoryExtended: historyExtended,
  AuthorisationSet: authorisationSet,
  PrepaidConsumed: prepaidConsumed,
  BondFunded: bondFunded,
  BondReserved: bondReserved,
  BondReleased: bondReleased,
  SlashedForUnconfirmedClearing: slashedForUnconfirmedClearing,
  SlashedForReorg: slashedForReorg,
  ReorgSlashShortfall: reorgSlashShortfall,
  WithdrawalReleased: withdrawalReleased,
} as const;

/** Bookkeeping tables, which no event writes to. */
export const BOOKKEEPING_TABLES = {
  event_log: eventLog,
  indexed_block: indexedBlock,
  indexer_cursor: indexerCursor,
} as const;
