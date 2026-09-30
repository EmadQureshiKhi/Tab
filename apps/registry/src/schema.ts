/**
 * The registry's Postgres schema, declared once with `drizzle-orm` so the sink,
 * the queries, and the SQL migration under `sql/` agree on every column.
 *
 * ## Shape
 *
 * One table per indexed event, each keyed by `(block_hash, log_index)`, which
 * is the identity of a log on Monad: a block hash pins the block, a log index
 * pins the position, and a reorganisation that replaces the block replaces the
 * hash. Three bookkeeping tables carry the envelope of every log, the blocks
 * seen, and the cursor.
 *
 * Amounts are `NUMERIC` with the width of the Solidity type that produced them,
 * never floats and never `BIGINT`, because a `uint128` does not fit a 64-bit
 * integer. Addresses and words are lower-case hex text.
 *
 * Nothing here is derived. Every view is computed in `queries.ts`, and the one
 * SQL view, `registry.agent_identity`, is declared in the SQL alone: the query
 * builder never writes to it and every read of it is hand-written.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const registrySchema = pgSchema("registry");

const UINT256 = { precision: 78, scale: 0 } as const;
const UINT128 = { precision: 39, scale: 0 } as const;

// ------------------------------------------------------------------ bookkeeping

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

export const indexedBlock = registrySchema.table("indexed_block", {
  blockNumber: bigint("block_number", { mode: "number" }).primaryKey(),
  blockHash: text("block_hash").notNull(),
  logCount: integer("log_count").notNull(),
  seenAt: timestamp("seen_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const indexerCursor = registrySchema.table("indexer_cursor", {
  stream: text("stream").primaryKey(),
  lastBlock: bigint("last_block", { mode: "number" }).notNull(),
  lastBlockHash: text("last_block_hash"),
  reorgCount: integer("reorg_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

const envelopeColumns = {
  blockHash: text("block_hash").notNull(),
  logIndex: integer("log_index").notNull(),
} as const;

// ------------------------------------------------------------------ TabBook

export const deliveryRecorded = registrySchema.table(
  "delivery_recorded",
  {
    ...envelopeColumns,
    agent: text("agent").notNull(),
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    tool: text("tool").notNull(),
    units: bigint("units", { mode: "number" }).notNull(),
    amount: numeric("amount", UINT256).notNull(),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("delivery_recorded_agent_idx").on(table.agent, table.asset),
    index("delivery_recorded_service_idx").on(table.serviceId, table.asset),
  ],
);

export const settlementApplied = registrySchema.table(
  "settlement_applied",
  {
    ...envelopeColumns,
    settlementId: text("settlement_id").notNull(),
    agent: text("agent").notNull(),
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    applied: numeric("applied", UINT256).notNull(),
    toPrepaid: numeric("to_prepaid", UINT256).notNull(),
    openAfter: numeric("open_after", UINT128).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("settlement_applied_id_idx").on(table.settlementId),
    index("settlement_applied_agent_idx").on(table.agent, table.asset),
    index("settlement_applied_service_idx").on(table.serviceId, table.asset),
  ],
);

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
    recordCurated: boolean("record_curated").notNull(),
    recordBonded: boolean("record_bonded").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("history_extended_agent_idx").on(table.agent, table.asset, table.count),
  ],
);

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

export const tabDelinquencyCleared = registrySchema.table(
  "tab_delinquency_cleared",
  {
    ...envelopeColumns,
    tabId: text("tab_id").notNull(),
    agent: text("agent").notNull(),
    asset: text("asset").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("tab_delinquency_cleared_tab_idx").on(table.tabId),
    index("tab_delinquency_cleared_agent_idx").on(table.agent, table.asset),
  ],
);

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

export const creditLimitZeroed = registrySchema.table(
  "credit_limit_zeroed",
  {
    ...envelopeColumns,
    agent: text("agent").notNull(),
    asset: text("asset").notNull(),
    reasonTabId: text("reason_tab_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("credit_limit_zeroed_agent_idx").on(table.agent, table.asset),
  ],
);

// ------------------------------------------------------------------ TabSettlement

export const settled = registrySchema.table(
  "settled",
  {
    ...envelopeColumns,
    settlementId: text("settlement_id").notNull(),
    agent: text("agent").notNull(),
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT128).notNull(),
    applied: numeric("applied", UINT128).notNull(),
    toPrepaid: numeric("to_prepaid", UINT128).notNull(),
    collection: text("collection").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("settled_id_idx").on(table.settlementId),
    index("settled_agent_idx").on(table.agent, table.asset),
    index("settled_service_idx").on(table.serviceId, table.asset),
  ],
);

// ------------------------------------------------------------------ ServiceRegistry

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

export const collectionRegistered = registrySchema.table(
  "collection_registered",
  {
    ...envelopeColumns,
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    collection: text("collection").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("collection_registered_service_idx").on(table.serviceId, table.asset),
    index("collection_registered_collection_idx").on(table.collection),
  ],
);

export const collectionReleased = registrySchema.table(
  "collection_released",
  {
    ...envelopeColumns,
    serviceId: text("service_id").notNull(),
    asset: text("asset").notNull(),
    collection: text("collection").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("collection_released_service_idx").on(table.serviceId, table.asset),
  ],
);

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

// ------------------------------------------------------------------ Bond

export const bondFunded = registrySchema.table(
  "bond_funded",
  {
    ...envelopeColumns,
    party: text("party").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT128).notNull(),
    depositor: text("depositor").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("bond_funded_party_idx").on(table.party, table.asset),
  ],
);

export const bondWithdrawn = registrySchema.table(
  "bond_withdrawn",
  {
    ...envelopeColumns,
    party: text("party").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", UINT128).notNull(),
    /** The event's `to`, which is a reserved word in SQL, so the column is named for what it is. */
    recipient: text("recipient").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("bond_withdrawn_party_idx").on(table.party, table.asset),
  ],
);

// ------------------------------------------------------------------ IdentityRegistry (ERC-8004)
//
// Four raw tables and no state. `registry.agent_identity`, declared in the SQL as
// a view, folds them into the current owner, URI and wallet per agent, which is
// what keeps a reorganisation self-correcting here too: the rows go with their
// `event_log` envelope and the view has nothing of its own to undo.

export const identityTransfer = registrySchema.table(
  "identity_transfer",
  {
    ...envelopeColumns,
    /** The event's `from`, a reserved word in SQL, so the column is named for what it is. */
    sender: text("sender").notNull(),
    /** The event's `to`, likewise. */
    recipient: text("recipient").notNull(),
    agentId: numeric("agent_id", UINT256).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("identity_transfer_agent_idx").on(table.agentId),
    index("identity_transfer_recipient_idx").on(table.recipient),
  ],
);

export const identityRegistered = registrySchema.table(
  "identity_registered",
  {
    ...envelopeColumns,
    agentId: numeric("agent_id", UINT256).notNull(),
    agentUri: text("agent_uri").notNull(),
    owner: text("owner").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("identity_registered_agent_idx").on(table.agentId),
    index("identity_registered_owner_idx").on(table.owner),
  ],
);

export const identityMetadataSet = registrySchema.table(
  "identity_metadata_set",
  {
    ...envelopeColumns,
    agentId: numeric("agent_id", UINT256).notNull(),
    /** The indexed copy of the key, which the chain kept only as its keccak-256 hash. */
    metadataKeyHash: text("metadata_key_hash").notNull(),
    metadataKey: text("metadata_key").notNull(),
    metadataValue: text("metadata_value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("identity_metadata_set_agent_idx").on(table.agentId, table.metadataKey),
  ],
);

export const identityUriUpdated = registrySchema.table(
  "identity_uri_updated",
  {
    ...envelopeColumns,
    agentId: numeric("agent_id", UINT256).notNull(),
    newUri: text("new_uri").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockHash, table.logIndex] }),
    index("identity_uri_updated_agent_idx").on(table.agentId),
  ],
);

// ------------------------------------------------------------------ maps

/** Event name to the table its rows land in. The sink and the queries both key on this. */
export const TYPED_TABLES = {
  DeliveryRecorded: deliveryRecorded,
  SettlementApplied: settlementApplied,
  HistoryExtended: historyExtended,
  PrepaidConsumed: prepaidConsumed,
  TabDelinquent: tabDelinquent,
  TabDelinquencyCleared: tabDelinquencyCleared,
  AuthorisationSet: authorisationSet,
  CreditLimitZeroed: creditLimitZeroed,
  Settled: settled,
  ServiceRegistered: serviceRegistered,
  CollectionRegistered: collectionRegistered,
  CollectionReleased: collectionReleased,
  ToolPriceSet: toolPriceSet,
  RegistryChangeQueued: registryChangeQueued,
  RegistryChangeApplied: registryChangeApplied,
  RegistryChangeCancelled: registryChangeCancelled,
  BondFunded: bondFunded,
  BondWithdrawn: bondWithdrawn,
  Transfer: identityTransfer,
  Registered: identityRegistered,
  MetadataSet: identityMetadataSet,
  URIUpdated: identityUriUpdated,
} as const;

export const BOOKKEEPING_TABLES = {
  event_log: eventLog,
  indexed_block: indexedBlock,
  indexer_cursor: indexerCursor,
} as const;

/**
 * The Nansen overlay, declared in `sql/0002_nansen_profile.sql`. Not indexed from
 * the chain, so neither table keys on the envelope or cascades from `event_log`.
 */
export const nansenProfile = registrySchema.table("nansen_profile", {
  address: text("address").primaryKey(),
  chain: text("chain").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  profile: jsonb("profile").notNull(),
});

export const nansenPayment = registrySchema.table(
  "nansen_payment",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    address: text("address").notNull(),
    endpoint: text("endpoint").notNull(),
    amount: numeric("amount", UINT256).notNull(),
    asset: text("asset").notNull(),
    txHash: text("tx_hash"),
    paidAt: timestamp("paid_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [index("nansen_payment_paid_at_idx").on(table.paidAt)],
);

export const OVERLAY_TABLES = {
  nansen_profile: nansenProfile,
  nansen_payment: nansenPayment,
} as const;
