/**
 * The read layer over the registry's tables.
 *
 * Every view here is computed from event rows and nothing else. A row is a fact
 * the chain stated; a view is what the read API makes of the facts. Keeping the
 * two apart is what lets a view be tested against rows rather than against a
 * live chain, and what lets a wrong view be fixed without re-indexing.
 *
 * ## Identity and ordering
 *
 * Every view carries the {@link Provenance} of the log it was read from: block,
 * hash, log index, transaction, and block time. Pagination is by
 * `(block_number, log_index)` descending, so a page boundary is a stable position
 * on the chain rather than an offset that moves as rows land.
 *
 * ## Money
 *
 * Amounts leave this module as decimal strings. `NUMERIC(78,0)` does not fit a
 * JavaScript number and a `bigint` does not survive JSON, so the API serves the
 * exact figure as text and lets the caller decide what to do with it.
 */
import postgres from "postgres";
import type { AuthorisationRow, BondLedgerRow, HistoryRecordRow } from "./credit-service.js";
import type { LogPosition } from "./cursor.js";

type RawRow = Record<string, unknown>;

const text = (row: RawRow, column: string): string => {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`queries: column ${column} is ${typeof value}, expected text`);
  }
  return value;
};

const optionalText = (row: RawRow, column: string): string | null => {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`queries: column ${column} is ${typeof value}, expected text or null`);
  }
  return value;
};

const integer = (row: RawRow, column: string): number => {
  const value = row[column];
  const parsed = typeof value === "number" ? value : Number(text(row, column));
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`queries: column ${column} is not a safe integer`);
  }
  return parsed;
};

const boolean = (row: RawRow, column: string): boolean => {
  const value = row[column];
  if (typeof value !== "boolean") {
    throw new Error(`queries: column ${column} is ${typeof value}, expected boolean`);
  }
  return value;
};

const instant = (row: RawRow, column: string): string | null => {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date)) {
    throw new Error(`queries: column ${column} is not a timestamp`);
  }
  return value.toISOString();
};

// ------------------------------------------------------------------ provenance

/** Where on Monad a fact was read from. */
export interface Provenance {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly logIndex: number;
  readonly txHash: string;
  readonly txIndex: number;
  readonly blockTime: string | null;
}

const provenance = (row: RawRow): Provenance => ({
  blockNumber: integer(row, "block_number"),
  blockHash: text(row, "block_hash"),
  logIndex: integer(row, "log_index"),
  txHash: text(row, "tx_hash"),
  txIndex: integer(row, "tx_index"),
  blockTime: instant(row, "block_time"),
});

/** Which event set a served value, and where. */
export interface ValueSource {
  readonly appliedBy: string;
  readonly monad: Provenance;
}

export interface IndexHorizon {
  readonly stream: string;
  readonly lastBlock: number | null;
  readonly lastBlockHash: string | null;
  readonly reorgCount: number;
  readonly updatedAt: string | null;
}

// ------------------------------------------------------------------ settlements

/**
 * One Settlement: the Asset moved from the Agent to the Service's Collection
 * address and the Open Tab fell, in one transaction. `monad.txHash` is that
 * transaction.
 */
export interface SettlementView {
  readonly settlementId: string;
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: string;
  readonly applied: string;
  readonly toPrepaid: string;
  readonly collection: string;
  readonly openAfter: string | null;
  readonly monad: Provenance;
}

const settlementView = (row: RawRow): SettlementView => ({
  settlementId: text(row, "settlement_id"),
  agent: text(row, "agent"),
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  amount: text(row, "amount"),
  applied: text(row, "applied"),
  toPrepaid: text(row, "to_prepaid"),
  collection: text(row, "collection"),
  openAfter: optionalText(row, "open_after"),
  monad: provenance(row),
});

export interface SettlementFilter {
  readonly agent?: string | undefined;
  readonly serviceId?: string | undefined;
  readonly asset?: string | undefined;
}

// ------------------------------------------------------------------ deliveries

export interface DeliveryView {
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly tool: string;
  readonly units: number;
  readonly amount: string;
  readonly timestamp: number;
  readonly monad: Provenance;
}

const deliveryView = (row: RawRow): DeliveryView => ({
  agent: text(row, "agent"),
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  tool: text(row, "tool"),
  units: integer(row, "units"),
  amount: text(row, "amount"),
  timestamp: integer(row, "timestamp"),
  monad: provenance(row),
});

// ------------------------------------------------------------------ services

export interface ServiceRegistrationRow {
  readonly serviceId: string;
  readonly operator: string;
  readonly tier: number;
  readonly tierName: string;
  readonly settlementWindowSeconds: number;
  readonly monad: Provenance;
}

const serviceRegistrationRow = (row: RawRow): ServiceRegistrationRow => ({
  serviceId: text(row, "service_id"),
  operator: text(row, "operator"),
  tier: integer(row, "tier"),
  tierName: text(row, "tier_name"),
  settlementWindowSeconds: integer(row, "settlement_window"),
  monad: provenance(row),
});

export interface RegistryChangeRow {
  readonly serviceId: string;
  readonly changeId: string;
  readonly changeKind: number;
  readonly changeKindName: string;
  readonly payload: string;
  readonly eta: number | null;
  readonly monad: Provenance;
}

const registryChangeRow = (row: RawRow): RegistryChangeRow => ({
  serviceId: text(row, "service_id"),
  changeId: text(row, "change_id"),
  changeKind: integer(row, "change_kind"),
  changeKindName: text(row, "change_kind_name"),
  payload: text(row, "payload"),
  eta: row["eta"] === null || row["eta"] === undefined ? null : integer(row, "eta"),
  monad: provenance(row),
});

export interface ToolPriceRow {
  readonly serviceId: string;
  readonly asset: string;
  readonly tool: string;
  readonly baseUnits: string;
  readonly monad: Provenance;
}

const toolPriceRow = (row: RawRow): ToolPriceRow => ({
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  tool: text(row, "tool"),
  baseUnits: text(row, "base_units"),
  monad: provenance(row),
});

/** Where a Service is paid in one Asset, as currently registered. */
export interface CollectionRow {
  readonly serviceId: string;
  readonly asset: string;
  readonly collection: string;
  readonly monad: Provenance;
}

const collectionRow = (row: RawRow): CollectionRow => ({
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  collection: text(row, "collection"),
  monad: provenance(row),
});

export type ServiceBondRow = BondLedgerRow;

const bondLedgerRow = (row: RawRow): BondLedgerRow => ({
  serviceId: text(row, "service_id"),
  party: text(row, "party"),
  asset: text(row, "asset"),
  staked: text(row, "staked"),
  withdrawn: text(row, "withdrawn"),
  free: text(row, "free"),
  depositCount: integer(row, "deposit_count"),
  lastBlock: integer(row, "last_block"),
});

// ------------------------------------------------------------------ credit inputs

const historyRecordRow = (row: RawRow): HistoryRecordRow => ({
  agent: text(row, "agent"),
  asset: text(row, "asset"),
  root: text(row, "root"),
  count: integer(row, "count"),
  record: {
    serviceId: text(row, "record_service_id"),
    asset: text(row, "record_asset"),
    amount: BigInt(text(row, "record_amount")),
    settledAt: BigInt(text(row, "record_settled_at")),
    firstDeliveryAt: BigInt(text(row, "record_first_delivery_at")),
    curated: boolean(row, "record_curated"),
    bonded: boolean(row, "record_bonded"),
  },
  monad: provenance(row),
});

const authorisationRow = (row: RawRow): AuthorisationRow => ({
  agent: text(row, "agent"),
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  maxCumulative: text(row, "max_cumulative"),
  expiry: text(row, "expiry"),
  monad: provenance(row),
});

// ------------------------------------------------------------------ agents

export interface TabObservationRow {
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly openAfter: string;
  readonly monad: Provenance;
}

const tabObservationRow = (row: RawRow): TabObservationRow => ({
  agent: text(row, "agent"),
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  openAfter: text(row, "open_after"),
  monad: provenance(row),
});

export interface DeliveredTabRow {
  readonly serviceId: string;
  readonly asset: string;
}

export interface PrepaidObservationRow {
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly consumed: string;
  readonly prepaidAfter: string;
  readonly openAdded: string;
  readonly monad: Provenance;
}

const prepaidObservationRow = (row: RawRow): PrepaidObservationRow => ({
  agent: text(row, "agent"),
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  consumed: text(row, "consumed"),
  prepaidAfter: text(row, "prepaid_after"),
  openAdded: text(row, "open_added"),
  monad: provenance(row),
});

export interface PrepaidTotalsRow {
  readonly asset: string;
  readonly fundedTotal: string;
  readonly consumedTotal: string;
  readonly balance: string;
  readonly borrowedOnDraw: string;
  readonly drawCount: number;
  readonly lastDrawBlock: number | null;
}

const prepaidTotalsRow = (row: RawRow): PrepaidTotalsRow => {
  const funded = BigInt(text(row, "funded_total"));
  const consumed = BigInt(text(row, "consumed_total"));
  const lastDrawBlock = optionalText(row, "last_draw_block");
  return {
    asset: text(row, "asset"),
    fundedTotal: funded.toString(),
    consumedTotal: consumed.toString(),
    balance: (funded - consumed).toString(),
    borrowedOnDraw: text(row, "borrowed_on_draw"),
    drawCount: integer(row, "draw_count"),
    lastDrawBlock: lastDrawBlock === null ? null : Number(lastDrawBlock),
  };
};

export interface DelinquencyRow {
  readonly tabId: string;
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly unsettled: string;
  readonly windowEnd: string;
  readonly resolved: boolean;
  readonly monad: Provenance;
}

const delinquencyRow = (row: RawRow): DelinquencyRow => ({
  tabId: text(row, "tab_id"),
  agent: text(row, "agent"),
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  unsettled: text(row, "unsettled"),
  windowEnd: text(row, "window_end"),
  resolved: boolean(row, "resolved"),
  monad: provenance(row),
});

export interface AgentAssetTotalsRow {
  readonly agent: string;
  readonly asset: string;
  readonly settlementCount: number;
  readonly settledTotal: string;
  readonly appliedTotal: string;
  readonly prepaidTotal: string;
  readonly firstBlock: number;
  readonly lastBlock: number;
  readonly lastBlockTime: string | null;
}

const agentAssetTotalsRow = (row: RawRow): AgentAssetTotalsRow => ({
  agent: text(row, "agent"),
  asset: text(row, "asset"),
  settlementCount: integer(row, "settlement_count"),
  settledTotal: text(row, "settled_total"),
  appliedTotal: text(row, "applied_total"),
  prepaidTotal: text(row, "prepaid_total"),
  firstBlock: integer(row, "first_block"),
  lastBlock: integer(row, "last_block"),
  lastBlockTime: instant(row, "last_block_time"),
});

export interface AgentSummaryRow {
  readonly agent: string;
  readonly settlementCount: number;
  readonly settledTotal: string;
  readonly assetCount: number;
  readonly monad: Provenance;
}

const agentSummaryRow = (row: RawRow): AgentSummaryRow => ({
  agent: text(row, "agent"),
  settlementCount: integer(row, "settlement_count"),
  settledTotal: text(row, "settled_total"),
  assetCount: integer(row, "asset_count"),
  monad: provenance(row),
});

export interface AgentAssetRow {
  readonly asset: string;
}

export interface AgentAssetVolumeRow {
  readonly agent: string;
  readonly asset: string;
  readonly amount: string;
  readonly settlementCount: number;
}

export interface AgentAssetDeliveriesRow {
  readonly agent: string;
  readonly asset: string;
  readonly deliveryCount: number;
}

// ------------------------------------------------------------------ identity (ERC-8004)

/**
 * One row of the `registry.agent_identity` view: the current state of one
 * ERC-8004 agent as the indexed events fold to it. Each figure names the block
 * it was last written in, so a reader can tell a stale URI from a current one.
 */
export interface AgentIdentityRow {
  /** The ERC-721 token id, as a decimal string; a `uint256` on chain. */
  readonly agentId: string;
  readonly owner: string;
  readonly ownerBlock: number;
  /** `null` when no `Registered` or `URIUpdated` for the agent is in the index. */
  readonly agentUri: string | null;
  readonly uriBlock: number | null;
  /** The `agentWallet` metadata, or `null` when unset, cleared, or never indexed. */
  readonly agentWallet: string | null;
  readonly walletBlock: number | null;
  /** The block of the mint, when the index holds it. */
  readonly registeredBlock: number | null;
}

const optionalInteger = (row: RawRow, column: string): number | null => {
  const value = row[column];
  return value === null || value === undefined ? null : integer(row, column);
};

const agentIdentityRow = (row: RawRow): AgentIdentityRow => ({
  agentId: text(row, "agent_id"),
  owner: text(row, "owner"),
  ownerBlock: integer(row, "owner_block"),
  agentUri: optionalText(row, "agent_uri"),
  uriBlock: optionalInteger(row, "uri_block"),
  agentWallet: optionalText(row, "agent_wallet"),
  walletBlock: optionalInteger(row, "wallet_block"),
  registeredBlock: optionalInteger(row, "registered_block"),
});

// ------------------------------------------------------------------ interface

export interface RegistryReads {
  horizon(stream: string): Promise<IndexHorizon>;
  settlements(
    filter: SettlementFilter,
    pageSize: number,
    after: LogPosition | null,
  ): Promise<readonly SettlementView[]>;
  settlementById(settlementId: string): Promise<SettlementView | null>;
  deliveries(filter: SettlementFilter, pageSize: number, after: LogPosition | null): Promise<readonly DeliveryView[]>;
  serviceRegistrations(
    pageSize: number,
    after: LogPosition | null,
  ): Promise<readonly ServiceRegistrationRow[]>;
  serviceRegistration(serviceId: string): Promise<ServiceRegistrationRow | null>;
  appliedChanges(serviceIds: readonly string[]): Promise<readonly RegistryChangeRow[]>;
  pendingChanges(serviceIds: readonly string[]): Promise<readonly RegistryChangeRow[]>;
  toolPrices(serviceIds: readonly string[]): Promise<readonly ToolPriceRow[]>;
  collections(serviceIds: readonly string[]): Promise<readonly CollectionRow[]>;
  serviceBonds(serviceIds: readonly string[]): Promise<readonly ServiceBondRow[]>;
  agents(pageSize: number, after: LogPosition | null): Promise<readonly AgentSummaryRow[]>;
  agentAssetTotals(agent: string): Promise<readonly AgentAssetTotalsRow[]>;
  tabObservations(agent: string): Promise<readonly TabObservationRow[]>;
  /** Every Service and Asset the Agent has had a delivery metered to, settled or not. */
  deliveredTabs(agent: string): Promise<readonly DeliveredTabRow[]>;
  prepaidObservations(agent: string): Promise<readonly PrepaidObservationRow[]>;
  prepaidTotals(agent: string): Promise<readonly PrepaidTotalsRow[]>;
  delinquencies(agent: string): Promise<readonly DelinquencyRow[]>;
  historyRecords(agent: string, asset: string): Promise<readonly HistoryRecordRow[]>;
  authorisations(agent: string, asset: string): Promise<readonly AuthorisationRow[]>;
  creditAssets(agent: string): Promise<readonly AgentAssetRow[]>;
  bondLedgers(serviceIds: readonly string[]): Promise<readonly BondLedgerRow[]>;
  settlementVolumeByAgentAsset(): Promise<readonly AgentAssetVolumeRow[]>;
  deliveryCountsByAgentAsset(): Promise<readonly AgentAssetDeliveriesRow[]>;
  /**
   * Every ERC-8004 agent whose current owner or current `agentWallet` is the
   * address, lowest agent id first. Both are matched because either is a key the
   * agent may sign Settlements with.
   */
  agentIdentities(address: string): Promise<readonly AgentIdentityRow[]>;
  /**
   * Every address that operates a registered Service, lowercase and sorted. A
   * Service's operator cannot be reassigned, so this only ever grows. It is the
   * client list a reader passes to the Reputation registry to ask what Tab
   * Services said about an Agent, as opposed to what anyone said.
   */
  serviceOperators(): Promise<readonly string[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface PostgresReadsOptions {
  readonly max?: number;
  readonly connectTimeoutSeconds?: number;
}

// ------------------------------------------------------------------ postgres

export class PostgresReads implements RegistryReads {
  private readonly client: postgres.Sql;

  private constructor(client: postgres.Sql) {
    this.client = client;
  }

  static open(databaseUrl: string, options: PostgresReadsOptions = {}): PostgresReads {
    return new PostgresReads(
      postgres(databaseUrl, {
        max: options.max ?? 4,
        connect_timeout: options.connectTimeoutSeconds ?? 10,
        onnotice: () => {},
      }),
    );
  }

  async ping(): Promise<boolean> {
    try {
      await this.client`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }

  async horizon(stream: string): Promise<IndexHorizon> {
    const rows = await this.client<RawRow[]>`
      SELECT stream,
             last_block::text AS last_block,
             last_block_hash,
             reorg_count,
             updated_at
        FROM registry.indexer_cursor
       WHERE stream = ${stream}
       LIMIT 1`;
    const row = rows.at(0);
    if (row === undefined) {
      return { stream, lastBlock: null, lastBlockHash: null, reorgCount: 0, updatedAt: null };
    }
    return {
      stream: text(row, "stream"),
      lastBlock: integer(row, "last_block"),
      lastBlockHash: optionalText(row, "last_block_hash"),
      reorgCount: integer(row, "reorg_count"),
      updatedAt: instant(row, "updated_at"),
    };
  }

  // ---------------------------------------------------------------- settlements

  async settlements(
    filter: SettlementFilter,
    pageSize: number,
    after: LogPosition | null,
  ): Promise<readonly SettlementView[]> {
    const agent = filter.agent ?? null;
    const serviceId = filter.serviceId ?? null;
    const asset = filter.asset ?? null;
    const afterBlock = after === null ? null : String(after.blockNumber);
    const afterLog = after === null ? null : String(after.logIndex);
    const rows = await this.client<RawRow[]>`
      SELECT s.settlement_id,
             s.agent,
             s.service_id,
             s.asset,
             s.amount::text        AS amount,
             s.applied::text       AS applied,
             s.to_prepaid::text    AS to_prepaid,
             s.collection,
             a.open_after::text    AS open_after,
             l.block_number::text  AS block_number,
             l.block_hash,
             l.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time
        FROM registry.settled s
        JOIN registry.event_log l
          ON l.block_hash = s.block_hash AND l.log_index = s.log_index
        LEFT JOIN registry.settlement_applied a
          ON a.settlement_id = s.settlement_id
       WHERE (${agent}::text IS NULL OR s.agent = ${agent}::text)
         AND (${serviceId}::text IS NULL OR s.service_id = ${serviceId}::text)
         AND (${asset}::text IS NULL OR s.asset = ${asset}::text)
         AND (${afterBlock}::text IS NULL
              OR (l.block_number, l.log_index) < (${afterBlock}::bigint, ${afterLog}::int))
       ORDER BY l.block_number DESC, l.log_index DESC
       LIMIT ${pageSize + 1}`;
    return rows.map(settlementView);
  }

  async settlementById(settlementId: string): Promise<SettlementView | null> {
    const rows = await this.client<RawRow[]>`
      SELECT s.settlement_id,
             s.agent,
             s.service_id,
             s.asset,
             s.amount::text        AS amount,
             s.applied::text       AS applied,
             s.to_prepaid::text    AS to_prepaid,
             s.collection,
             a.open_after::text    AS open_after,
             l.block_number::text  AS block_number,
             l.block_hash,
             l.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time
        FROM registry.settled s
        JOIN registry.event_log l
          ON l.block_hash = s.block_hash AND l.log_index = s.log_index
        LEFT JOIN registry.settlement_applied a
          ON a.settlement_id = s.settlement_id
       WHERE s.settlement_id = ${settlementId}
       ORDER BY l.block_number DESC, l.log_index DESC
       LIMIT 1`;
    const row = rows.at(0);
    return row === undefined ? null : settlementView(row);
  }

  async deliveries(
    filter: SettlementFilter,
    pageSize: number,
    after: LogPosition | null,
  ): Promise<readonly DeliveryView[]> {
    const agent = filter.agent ?? null;
    const serviceId = filter.serviceId ?? null;
    const asset = filter.asset ?? null;
    const afterBlock = after === null ? null : String(after.blockNumber);
    const afterLog = after === null ? null : String(after.logIndex);
    const rows = await this.client<RawRow[]>`
      SELECT d.agent,
             d.service_id,
             d.asset,
             d.tool,
             d.units::text         AS units,
             d.amount::text        AS amount,
             d.timestamp::text     AS timestamp,
             l.block_number::text  AS block_number,
             l.block_hash,
             l.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time
        FROM registry.delivery_recorded d
        JOIN registry.event_log l
          ON l.block_hash = d.block_hash AND l.log_index = d.log_index
       WHERE (${agent}::text IS NULL OR d.agent = ${agent}::text)
         AND (${serviceId}::text IS NULL OR d.service_id = ${serviceId}::text)
         AND (${asset}::text IS NULL OR d.asset = ${asset}::text)
         AND (${afterBlock}::text IS NULL
              OR (l.block_number, l.log_index) < (${afterBlock}::bigint, ${afterLog}::int))
       ORDER BY l.block_number DESC, l.log_index DESC
       LIMIT ${pageSize + 1}`;
    return rows.map(deliveryView);
  }

  // ---------------------------------------------------------------- services

  async serviceRegistrations(
    pageSize: number,
    after: LogPosition | null,
  ): Promise<readonly ServiceRegistrationRow[]> {
    const afterBlock = after === null ? null : String(after.blockNumber);
    const afterLog = after === null ? null : String(after.logIndex);
    const rows = await this.client<RawRow[]>`
      WITH latest AS (
        SELECT DISTINCT ON (r.service_id)
               r.service_id,
               r.operator,
               r.tier,
               r.tier_name,
               r.settlement_window,
               l.block_number,
               r.block_hash,
               r.log_index,
               l.tx_hash,
               l.tx_index,
               l.block_time
          FROM registry.service_registered r
          JOIN registry.event_log l
            ON l.block_hash = r.block_hash AND l.log_index = r.log_index
         ORDER BY r.service_id, l.block_number DESC, r.log_index DESC
      )
      SELECT service_id,
             operator,
             tier,
             tier_name,
             settlement_window::text AS settlement_window,
             block_number::text      AS block_number,
             block_hash,
             log_index,
             tx_hash,
             tx_index,
             block_time
        FROM latest
       WHERE (${afterBlock}::text IS NULL
              OR (block_number, log_index) < (${afterBlock}::bigint, ${afterLog}::int))
       ORDER BY block_number DESC, log_index DESC
       LIMIT ${pageSize + 1}`;
    return rows.map(serviceRegistrationRow);
  }

  async serviceRegistration(serviceId: string): Promise<ServiceRegistrationRow | null> {
    const rows = await this.client<RawRow[]>`
      SELECT r.service_id,
             r.operator,
             r.tier,
             r.tier_name,
             r.settlement_window::text AS settlement_window,
             l.block_number::text      AS block_number,
             r.block_hash,
             r.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time
        FROM registry.service_registered r
        JOIN registry.event_log l
          ON l.block_hash = r.block_hash AND l.log_index = r.log_index
       WHERE r.service_id = ${serviceId}
       ORDER BY l.block_number DESC, r.log_index DESC
       LIMIT 1`;
    const row = rows.at(0);
    return row === undefined ? null : serviceRegistrationRow(row);
  }

  async appliedChanges(serviceIds: readonly string[]): Promise<readonly RegistryChangeRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT DISTINCT ON (a.service_id, a.change_kind)
             a.service_id,
             a.change_id,
             a.change_kind,
             a.change_kind_name,
             a.payload,
             NULL::bigint         AS eta,
             l.block_number::text AS block_number,
             a.block_hash,
             a.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time
        FROM registry.registry_change_applied a
        JOIN registry.event_log l
          ON l.block_hash = a.block_hash AND l.log_index = a.log_index
       WHERE a.service_id = ANY(${[...serviceIds]}::text[])
       ORDER BY a.service_id, a.change_kind, l.block_number DESC, a.log_index DESC`;
    return rows.map(registryChangeRow);
  }

  async pendingChanges(serviceIds: readonly string[]): Promise<readonly RegistryChangeRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT q.service_id,
             q.change_id,
             q.change_kind,
             q.change_kind_name,
             q.payload,
             q.eta::text          AS eta,
             l.block_number::text AS block_number,
             q.block_hash,
             q.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time
        FROM registry.registry_change_queued q
        JOIN registry.event_log l
          ON l.block_hash = q.block_hash AND l.log_index = q.log_index
       WHERE q.service_id = ANY(${[...serviceIds]}::text[])
         AND NOT EXISTS (SELECT 1
                           FROM registry.registry_change_applied ap
                          WHERE ap.change_id = q.change_id)
         AND NOT EXISTS (SELECT 1
                           FROM registry.registry_change_cancelled cx
                          WHERE cx.change_id = q.change_id)
       ORDER BY q.eta, q.service_id, q.log_index`;
    return rows.map(registryChangeRow);
  }

  async toolPrices(serviceIds: readonly string[]): Promise<readonly ToolPriceRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT DISTINCT ON (p.service_id, p.asset, p.tool)
             p.service_id,
             p.asset,
             p.tool,
             p.base_units::text   AS base_units,
             l.block_number::text AS block_number,
             p.block_hash,
             p.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time
        FROM registry.tool_price_set p
        JOIN registry.event_log l
          ON l.block_hash = p.block_hash AND l.log_index = p.log_index
       WHERE p.service_id = ANY(${[...serviceIds]}::text[])
       ORDER BY p.service_id, p.asset, p.tool, l.block_number DESC, p.log_index DESC`;
    return rows.map(toolPriceRow);
  }

  /**
   * The current Collection address of every accepted Asset. A `CollectionReleased`
   * is always followed in the same transaction by a `CollectionRegistered` for the
   * new address, so the latest registration per `(service, asset)` is the answer.
   */
  async collections(serviceIds: readonly string[]): Promise<readonly CollectionRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT DISTINCT ON (c.service_id, c.asset)
             c.service_id,
             c.asset,
             c.collection,
             l.block_number::text AS block_number,
             c.block_hash,
             c.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time
        FROM registry.collection_registered c
        JOIN registry.event_log l
          ON l.block_hash = c.block_hash AND l.log_index = c.log_index
       WHERE c.service_id = ANY(${[...serviceIds]}::text[])
       ORDER BY c.service_id, c.asset, l.block_number DESC, c.log_index DESC`;
    return rows.map(collectionRow);
  }

  async serviceBonds(serviceIds: readonly string[]): Promise<readonly ServiceBondRow[]> {
    return this.bondLedgers(serviceIds);
  }

  /**
   * The escrow ledger of each Service's bond account, replayed from `BondFunded`
   * and `BondWithdrawn`. A party is `bytes32(uint160(account))`, and the bond
   * account is the operator at registration, so the party is derived from the
   * `ServiceRegistered` row rather than looked up on chain.
   */
  async bondLedgers(serviceIds: readonly string[]): Promise<readonly BondLedgerRow[]> {
    if (serviceIds.length === 0) return [];
    const rows = await this.client<RawRow[]>`
      WITH services AS (
        SELECT DISTINCT ON (r.service_id)
               r.service_id,
               ('0x' || repeat('0', 24) || substr(r.operator, 3)) AS party
          FROM registry.service_registered r
          JOIN registry.event_log l ON l.block_hash = r.block_hash AND l.log_index = r.log_index
         WHERE r.service_id = ANY(${[...serviceIds]}::text[])
         ORDER BY r.service_id, l.block_number DESC, r.log_index DESC
      ),
      funded AS (
        SELECT f.party, f.asset,
               SUM(f.amount)        AS staked,
               COUNT(*)::int        AS deposit_count,
               MAX(l.block_number)  AS last_block
          FROM registry.bond_funded f
          JOIN registry.event_log l ON l.block_hash = f.block_hash AND l.log_index = f.log_index
         GROUP BY f.party, f.asset
      ),
      withdrawn AS (
        SELECT w.party, w.asset, SUM(w.amount) AS amount, MAX(l.block_number) AS last_block
          FROM registry.bond_withdrawn w
          JOIN registry.event_log l ON l.block_hash = w.block_hash AND l.log_index = w.log_index
         GROUP BY w.party, w.asset
      ),
      ledger AS (
        SELECT s.service_id, s.party, f.asset,
               f.staked                                                       AS staked,
               COALESCE(w.amount, 0)                                          AS withdrawn,
               f.deposit_count                                                AS deposit_count,
               GREATEST(f.last_block, COALESCE(w.last_block, 0))              AS last_block
          FROM services s
          JOIN funded f ON f.party = s.party
          LEFT JOIN withdrawn w ON w.party = s.party AND w.asset = f.asset
      )
      SELECT service_id,
             party,
             asset,
             staked::text                 AS staked,
             withdrawn::text              AS withdrawn,
             (staked - withdrawn)::text   AS free,
             deposit_count,
             last_block::text             AS last_block
        FROM ledger
       ORDER BY service_id, asset`;
    return rows.map(bondLedgerRow);
  }

  // ---------------------------------------------------------------- credit inputs

  async historyRecords(agent: string, asset: string): Promise<readonly HistoryRecordRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT h.agent,
             h.asset,
             h.root,
             h.count,
             h.record_service_id,
             h.record_asset,
             h.record_amount::text            AS record_amount,
             h.record_settled_at::text        AS record_settled_at,
             h.record_first_delivery_at::text AS record_first_delivery_at,
             h.record_curated,
             h.record_bonded,
             l.block_number::text             AS block_number,
             h.block_hash,
             h.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time
        FROM registry.history_extended h
        JOIN registry.event_log l
          ON l.block_hash = h.block_hash AND l.log_index = h.log_index
       WHERE h.agent = ${agent} AND h.asset = ${asset}
       ORDER BY h.count ASC, l.block_number ASC, h.log_index ASC`;
    return rows.map(historyRecordRow);
  }

  async authorisations(agent: string, asset: string): Promise<readonly AuthorisationRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT DISTINCT ON (a.service_id)
             a.agent,
             a.service_id,
             a.asset,
             a.max_cumulative::text AS max_cumulative,
             a.expiry::text         AS expiry,
             l.block_number::text   AS block_number,
             a.block_hash,
             a.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time
        FROM registry.authorisation_set a
        JOIN registry.event_log l
          ON l.block_hash = a.block_hash AND l.log_index = a.log_index
       WHERE a.agent = ${agent} AND a.asset = ${asset}
       ORDER BY a.service_id, l.block_number DESC, a.log_index DESC`;
    return rows.map(authorisationRow);
  }

  async creditAssets(agent: string): Promise<readonly AgentAssetRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT asset FROM registry.history_extended WHERE agent = ${agent}
      UNION
      SELECT asset FROM registry.authorisation_set WHERE agent = ${agent}
      ORDER BY asset`;
    return rows.map((row) => ({ asset: text(row, "asset") }));
  }

  // ---------------------------------------------------------------- agents

  async agents(pageSize: number, after: LogPosition | null): Promise<readonly AgentSummaryRow[]> {
    const afterBlock = after === null ? null : String(after.blockNumber);
    const afterLog = after === null ? null : String(after.logIndex);
    const rows = await this.client<RawRow[]>`
      WITH latest AS (
        SELECT DISTINCT ON (s.agent)
               s.agent,
               l.block_number,
               s.block_hash,
               s.log_index,
               l.tx_hash,
               l.tx_index,
               l.block_time
          FROM registry.settled s
          JOIN registry.event_log l
            ON l.block_hash = s.block_hash AND l.log_index = s.log_index
         ORDER BY s.agent, l.block_number DESC, s.log_index DESC
      ),
      totals AS (
        SELECT s.agent,
               COUNT(*)::int                AS settlement_count,
               SUM(s.amount)::text          AS settled_total,
               COUNT(DISTINCT s.asset)::int AS asset_count
          FROM registry.settled s
         GROUP BY s.agent
      )
      SELECT t.agent,
             t.settlement_count,
             t.settled_total,
             t.asset_count,
             la.block_number::text AS block_number,
             la.block_hash,
             la.log_index,
             la.tx_hash,
             la.tx_index,
             la.block_time
        FROM totals t
        JOIN latest la ON la.agent = t.agent
       WHERE (${afterBlock}::text IS NULL
              OR (la.block_number, la.log_index) < (${afterBlock}::bigint, ${afterLog}::int))
       ORDER BY la.block_number DESC, la.log_index DESC
       LIMIT ${pageSize + 1}`;
    return rows.map(agentSummaryRow);
  }

  async agentAssetTotals(agent: string): Promise<readonly AgentAssetTotalsRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT s.agent,
             s.asset,
             COUNT(*)::int              AS settlement_count,
             SUM(s.amount)::text        AS settled_total,
             SUM(s.applied)::text       AS applied_total,
             SUM(s.to_prepaid)::text    AS prepaid_total,
             MIN(l.block_number)::text  AS first_block,
             MAX(l.block_number)::text  AS last_block,
             MAX(l.block_time)          AS last_block_time
        FROM registry.settled s
        JOIN registry.event_log l
          ON l.block_hash = s.block_hash AND l.log_index = s.log_index
       WHERE s.agent = ${agent}
       GROUP BY s.agent, s.asset
       ORDER BY s.asset`;
    return rows.map(agentAssetTotalsRow);
  }

  async deliveredTabs(agent: string): Promise<readonly DeliveredTabRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT DISTINCT d.service_id, d.asset
        FROM registry.delivery_recorded d
       WHERE d.agent = ${agent}
       ORDER BY d.service_id, d.asset`;
    return rows.map((row) => ({ serviceId: text(row, "service_id"), asset: text(row, "asset") }));
  }

  async tabObservations(agent: string): Promise<readonly TabObservationRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT DISTINCT ON (a.agent, a.service_id, a.asset)
             a.agent,
             a.service_id,
             a.asset,
             a.open_after::text   AS open_after,
             l.block_number::text AS block_number,
             a.block_hash,
             a.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time
        FROM registry.settlement_applied a
        JOIN registry.event_log l
          ON l.block_hash = a.block_hash AND l.log_index = a.log_index
       WHERE a.agent = ${agent}
       ORDER BY a.agent, a.service_id, a.asset, l.block_number DESC, a.log_index DESC`;
    return rows.map(tabObservationRow);
  }

  async prepaidObservations(agent: string): Promise<readonly PrepaidObservationRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT DISTINCT ON (p.agent, p.service_id, p.asset)
             p.agent,
             p.service_id,
             p.asset,
             p.consumed::text      AS consumed,
             p.prepaid_after::text AS prepaid_after,
             p.open_added::text    AS open_added,
             l.block_number::text  AS block_number,
             p.block_hash,
             p.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time
        FROM registry.prepaid_consumed p
        JOIN registry.event_log l
          ON l.block_hash = p.block_hash AND l.log_index = p.log_index
       WHERE p.agent = ${agent}
       ORDER BY p.agent, p.service_id, p.asset, l.block_number DESC, p.log_index DESC`;
    return rows.map(prepaidObservationRow);
  }

  async settlementVolumeByAgentAsset(): Promise<readonly AgentAssetVolumeRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT s.agent             AS agent,
             s.asset             AS asset,
             SUM(s.amount)::text AS amount,
             COUNT(*)::int       AS settlement_count
        FROM registry.settled s
       GROUP BY s.agent, s.asset
       ORDER BY s.agent, s.asset`;
    return rows.map((row) => ({
      agent: String(row.agent),
      asset: String(row.asset),
      amount: String(row.amount),
      settlementCount: Number(row.settlement_count),
    }));
  }

  async deliveryCountsByAgentAsset(): Promise<readonly AgentAssetDeliveriesRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT d.agent        AS agent,
             d.asset        AS asset,
             COUNT(*)::int  AS delivery_count
        FROM registry.delivery_recorded d
       GROUP BY d.agent, d.asset
       ORDER BY d.agent, d.asset`;
    return rows.map((row) => ({
      agent: String(row.agent),
      asset: String(row.asset),
      deliveryCount: Number(row.delivery_count),
    }));
  }

  // ---------------------------------------------------------------- identity

  async agentIdentities(address: string): Promise<readonly AgentIdentityRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT agent_id::text          AS agent_id,
             owner,
             owner_block::text       AS owner_block,
             agent_uri,
             uri_block::text         AS uri_block,
             agent_wallet,
             wallet_block::text      AS wallet_block,
             registered_block::text  AS registered_block
        FROM registry.agent_identity
       WHERE owner = ${address} OR agent_wallet = ${address}
       ORDER BY agent_id ASC`;
    return rows.map(agentIdentityRow);
  }

  async serviceOperators(): Promise<readonly string[]> {
    const rows = await this.client<RawRow[]>`
      SELECT DISTINCT lower(operator) AS operator
        FROM registry.service_registered
       ORDER BY 1`;
    return rows.map((row) => text(row, "operator"));
  }

  async prepaidTotals(agent: string): Promise<readonly PrepaidTotalsRow[]> {
    const rows = await this.client<RawRow[]>`
      WITH funded AS (
        SELECT a.asset,
               SUM(a.to_prepaid) AS funded_total
          FROM registry.settlement_applied a
         WHERE a.agent = ${agent}
         GROUP BY a.asset
      ),
      drawn AS (
        SELECT p.asset,
               COUNT(*)              AS draw_count,
               SUM(p.consumed)       AS consumed_total,
               SUM(p.open_added)     AS borrowed_on_draw,
               MAX(l.block_number)   AS last_draw_block
          FROM registry.prepaid_consumed p
          JOIN registry.event_log l
            ON l.block_hash = p.block_hash AND l.log_index = p.log_index
         WHERE p.agent = ${agent}
         GROUP BY p.asset
      )
      SELECT COALESCE(f.asset, d.asset)             AS asset,
             COALESCE(f.funded_total, 0)::text      AS funded_total,
             COALESCE(d.consumed_total, 0)::text    AS consumed_total,
             COALESCE(d.borrowed_on_draw, 0)::text  AS borrowed_on_draw,
             COALESCE(d.draw_count, 0)::int         AS draw_count,
             d.last_draw_block::text                AS last_draw_block
        FROM funded f
        FULL OUTER JOIN drawn d ON d.asset = f.asset
       ORDER BY 1`;
    return rows.map(prepaidTotalsRow);
  }

  /**
   * Every tab the Agent was declared delinquent on, with whether a later
   * `TabDelinquencyCleared` resolved it. The book emits the clearing event when the
   * tab settles to zero, so it is read directly rather than inferred.
   */
  async delinquencies(agent: string): Promise<readonly DelinquencyRow[]> {
    const rows = await this.client<RawRow[]>`
      WITH latest AS (
        SELECT DISTINCT ON (d.tab_id)
               d.tab_id,
               d.agent,
               d.service_id,
               d.asset,
               d.unsettled,
               d.window_end,
               l.block_number,
               d.block_hash,
               d.log_index,
               l.tx_hash,
               l.tx_index,
               l.block_time
          FROM registry.tab_delinquent d
          JOIN registry.event_log l
            ON l.block_hash = d.block_hash AND l.log_index = d.log_index
         WHERE d.agent = ${agent}
         ORDER BY d.tab_id, l.block_number DESC, d.log_index DESC
      )
      SELECT tab_id,
             agent,
             service_id,
             asset,
             unsettled::text      AS unsettled,
             window_end::text     AS window_end,
             block_number::text   AS block_number,
             block_hash,
             log_index,
             tx_hash,
             tx_index,
             block_time,
             EXISTS (SELECT 1
                       FROM registry.tab_delinquency_cleared c
                       JOIN registry.event_log cl
                         ON cl.block_hash = c.block_hash AND cl.log_index = c.log_index
                      WHERE c.tab_id = latest.tab_id
                        AND (cl.block_number, cl.log_index) > (latest.block_number, latest.log_index)
                    ) AS resolved
        FROM latest
       ORDER BY block_number DESC, log_index DESC`;
    return rows.map(delinquencyRow);
  }
}

export const isHexAddress = (value: string): boolean => /^0x[0-9a-f]{40}$/.test(value);
export const isHexWord = (value: string): boolean => /^0x[0-9a-f]{64}$/.test(value);
