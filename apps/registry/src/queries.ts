/**
 * The read surface over the indexed rows: every query the endpoints serve, in one
 * place, with nothing reinterpreted on the way out.
 *
 * `rows.ts` is the write side's rule — record what the chain said and narrow
 * nothing silently. This is the read side's, and it is the same rule pointed the
 * other way:
 *
 * **Amounts leave as strings.** Every `numeric` column is cast to `text` in the
 * SQL and never parsed. A USDC figure is a 6-decimal integer, and settled amounts
 * routinely exceed what an IEEE-754 double represents exactly, so a `number`
 * anywhere on this path is a wrong number that no later check can detect. The same
 * goes for the `uint64` coordinates inside a replay key.
 *
 * **A derived figure says it is derived.** Several answers a Dashboard wants are
 * not events. The current tier of a Service is the registration tier plus every
 * applied tier change since; a Service's Bond is the sum of the proven deposits
 * that reached its Bond Collection Address. Those reductions are done here, and
 * every one of them carries the block height it was computed against, because a
 * derived number without a horizon cannot be checked against the chain.
 *
 * **A derived figure is served only once the chain has agreed with it.** The Credit
 * Limit, headroom, and every Bond ledger figure are derived here from
 * `HistoryExtended`, `AuthorisationSet`, and the `Bond` ledger events, and then
 * checked against the contracts' own `view` reads at the index horizon block by
 * `credit-service.ts`. A figure the chain disagrees with is withheld and named,
 * never served as a plausible-looking number.
 *
 * ## Why hand-written SQL rather than the query builder
 *
 * Half of these reads are "the latest row per group" — the current price of a
 * tool, the live state of a Collection Address, the last observed Open Tab of a
 * tab. `DISTINCT ON` answers that in one index-ordered pass and has no portable
 * equivalent in a query builder, so the alternative is either several round trips
 * or a window function expressed through an escape hatch. Every value a caller
 * supplies still travels as a bind parameter, so there is no interpolation
 * anywhere below.
 *
 * Requirements: 24.1, 24.3, 24.4, 24.7, 11.8, 11.9
 */

import postgres from "postgres";

import type { AuthorisationRow, BondLedgerRow, HistoryRecordRow } from "./credit-service.js";
import type { LogPosition } from "./cursor.js";

/** A row as the driver hands it over, before any column is claimed. */
type RawRow = Record<string, unknown>;

// ------------------------------------------------------------- column readers
//
// One reader per shape, each naming the column it failed on. A read layer that
// coerces silently is a read layer that reports a zero where a column was renamed,
// so every one of these refuses instead.

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

/**
 * A column that is presentation-safe as a JavaScript number.
 *
 * Only for values the write path already checked against the safe-integer ceiling
 * — block numbers, log ordinals, counts. Amounts and packed coordinates never come
 * through here; they stay strings.
 */
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

/** A `timestamptz`, as an ISO-8601 instant. Null where the block header was never read. */
const instant = (row: RawRow, column: string): string | null => {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date)) {
    throw new Error(`queries: column ${column} is not a timestamp`);
  }
  return value.toISOString();
};

// ----------------------------------------------------------------- row shapes

/**
 * Where a row came from on Creditcoin.
 *
 * Carried on every answer, and the reason the whole read layer is checkable: a
 * caller holding this can fetch the same log from any node and compare, rather
 * than believing this service. `blockTime` is nullable because a log carries no
 * timestamp and the indexer treats a failed block read as a missing timestamp
 * rather than as a reason to drop the row.
 */
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

const positionOf = (row: RawRow): LogPosition => ({
  blockNumber: integer(row, "block_number"),
  logIndex: integer(row, "log_index"),
});

/** How far the index has read. Every response carries it, so no answer is horizonless. */
export interface IndexHorizon {
  readonly stream: string;
  readonly lastBlock: number | null;
  readonly lastBlockHash: string | null;
  readonly reorgCount: number;
  readonly updatedAt: string | null;
}

/**
 * One Verified Settlement, as the explorer and the live feed present it. (R24.4)
 *
 * The five coordinates are the Settlement's identity. `replayKey` is the packed
 * form; `chainKey`, `blockHeight`, `txIndex`, and `logIndex` are the same tuple
 * unpacked, and all four stay decimal strings because each is a `uint64` and a
 * `uint64` does not fit a double.
 *
 * `sourceLogIndex` is the ordinal within the proved transaction's own receipt
 * logs. It is not `creditcoin.logIndex`, which is the block-wide ordinal of the
 * `SettlementRecorded` log itself, and conflating them reads the wrong log.
 */
export interface SettlementView {
  readonly replayKey: string;
  readonly chainKey: string;
  readonly sourceBlockHeight: string;
  readonly sourceTxIndex: string;
  readonly sourceLogIndex: string;
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: string;
  readonly payerAddress: string;
  readonly sourceTabId: string;
  readonly creditcoin: Provenance;
  /**
   * What the Settlement did to an Open Tab, or `null` when it did not reach one.
   *
   * A `null` here is not a gap. `TabBook` emits `SettlementApplied` on every path
   * that touches a tab, so a Verified Settlement with no application is one that
   * was routed somewhere else — a proven deposit to a Bond Collection Address,
   * which `SettlementVerifier` hands to `Bond` and never to `TabBook`. That is the
   * only such route, which is what makes {@link ServiceBond} derivable.
   */
  readonly application: {
    readonly applied: string;
    readonly toPrepaid: string;
    readonly openAfter: string;
  } | null;
}

const settlementView = (row: RawRow): SettlementView => ({
  replayKey: text(row, "replay_key"),
  chainKey: text(row, "chain_key"),
  sourceBlockHeight: text(row, "source_block_height"),
  sourceTxIndex: text(row, "source_tx_index"),
  sourceLogIndex: text(row, "source_log_index"),
  agent: text(row, "agent"),
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  amount: text(row, "amount"),
  payerAddress: text(row, "payer_address"),
  sourceTabId: text(row, "source_tab_id"),
  creditcoin: provenance(row),
  application:
    optionalText(row, "applied") === null
      ? null
      : {
          applied: text(row, "applied"),
          toPrepaid: text(row, "to_prepaid"),
          openAfter: text(row, "open_after"),
        },
});

/** Optional equality filters on a settlement read. Every one is exact, never a prefix. */
export interface SettlementFilter {
  readonly agent?: string | undefined;
  readonly serviceId?: string | undefined;
  readonly asset?: string | undefined;
  readonly chainKey?: string | undefined;
}

/**
 * One state a clearing passed through, in chain order.
 *
 * `declined` cannot appear here, and its absence is a fact rather than an
 * omission: a decline creates no clearing, so `ProvisionalClearingDeclined`
 * carries no identity to join on. It is reported on its own, keyed by the Source
 * Chain transaction hash. A decline is also not a failed Settlement — it says free
 * Bond did not cover an observation, so the Open Tab was left alone until the
 * Verified Settlement arrived.
 */
export interface ClearingEventView {
  readonly state: "provisional" | "confirmed" | "reversed" | "superseded";
  readonly amount: string;
  readonly sourceTxHash: string | null;
  readonly deadline: string | null;
  readonly observedDigest: string | null;
  readonly attestedDigest: string | null;
  readonly creditcoin: Provenance;
}

const CLEARING_EVENT_STATES = ["provisional", "confirmed", "reversed", "superseded"] as const;

const clearingEventView = (row: RawRow): ClearingEventView => {
  const state = text(row, "state");
  if (!(CLEARING_EVENT_STATES as readonly string[]).includes(state)) {
    throw new Error(`queries: clearing state ${state} is not one this read knows`);
  }
  return {
    state: state as ClearingEventView["state"],
    amount: text(row, "amount"),
    sourceTxHash: optionalText(row, "source_tx_hash"),
    deadline: optionalText(row, "deadline"),
    observedDigest: optionalText(row, "observed_digest"),
    attestedDigest: optionalText(row, "attested_digest"),
    creditcoin: provenance(row),
  };
};

/** A declined observation. Carries no clearing identity, because the contract emits none. */
export interface DeclinedObservationView {
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: string;
  readonly sourceTxHash: string;
  /** Free Bond at the moment of the decline, so the shortfall is legible rather than inferred. */
  readonly freeBond: string;
  readonly creditcoin: Provenance;
}

const declinedObservationView = (row: RawRow): DeclinedObservationView => ({
  agent: text(row, "agent"),
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  amount: text(row, "amount"),
  sourceTxHash: text(row, "source_tx_hash"),
  freeBond: text(row, "free_bond"),
  creditcoin: provenance(row),
});

// ------------------------------------------------------- service directory shapes

/** Where a served registry value came from, which is what makes R11.7 checkable. */
export interface ValueSource {
  /** `registration` or the `changeId` of the applied change that last rewrote it. */
  readonly appliedBy: string;
  readonly creditcoin: Provenance;
}

/** A Service's registration, as emitted. */
export interface ServiceRegistrationRow {
  readonly serviceId: string;
  readonly operator: string;
  readonly tier: number;
  readonly tierName: string;
  readonly settlementWindowSeconds: number;
  readonly creditcoin: Provenance;
}

const serviceRegistrationRow = (row: RawRow): ServiceRegistrationRow => ({
  serviceId: text(row, "service_id"),
  operator: text(row, "operator"),
  tier: integer(row, "tier"),
  tierName: text(row, "tier_name"),
  settlementWindowSeconds: integer(row, "settlement_window"),
  creditcoin: provenance(row),
});

/** One applied or queued timelocked change, with its payload still whole. */
export interface RegistryChangeRow {
  readonly serviceId: string;
  readonly changeId: string;
  readonly changeKind: number;
  readonly changeKindName: string;
  readonly payload: string;
  /** Present on a queued change, absent on an applied one. Creditcoin timestamp, seconds. */
  readonly eta: number | null;
  readonly creditcoin: Provenance;
}

const registryChangeRow = (row: RawRow): RegistryChangeRow => ({
  serviceId: text(row, "service_id"),
  changeId: text(row, "change_id"),
  changeKind: integer(row, "change_kind"),
  changeKindName: text(row, "change_kind_name"),
  payload: text(row, "payload"),
  eta: row["eta"] === null || row["eta"] === undefined ? null : integer(row, "eta"),
  creditcoin: provenance(row),
});

/** The current price of one named tool, in Asset base units. */
export interface ToolPriceRow {
  readonly serviceId: string;
  readonly asset: string;
  readonly tool: string;
  readonly baseUnits: string;
  readonly creditcoin: Provenance;
}

const toolPriceRow = (row: RawRow): ToolPriceRow => ({
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  tool: text(row, "tool"),
  baseUnits: text(row, "base_units"),
  creditcoin: provenance(row),
});

/** A Collection Address that currently resolves, and what it collects for. */
export interface CollectionRow {
  readonly serviceId: string;
  readonly chainKey: string;
  readonly collection: string;
  readonly asset: string;
  readonly kind: number;
  readonly kindName: string;
  readonly creditcoin: Provenance;
}

const collectionRow = (row: RawRow): CollectionRow => ({
  serviceId: text(row, "service_id"),
  chainKey: text(row, "chain_key"),
  collection: text(row, "collection"),
  asset: text(row, "asset"),
  kind: integer(row, "collection_kind"),
  kindName: text(row, "collection_kind_name"),
  creditcoin: provenance(row),
});

/**
 * A Service's Bond ledger in one Asset, replayed from `Bond`'s own events. (R24.3)
 *
 * The four stored figures move through exactly seven events, each of which is
 * indexed: `BondFunded` raises `staked`; `BondReserved` raises `reserved`;
 * `BondReleased` and `SlashedForUnconfirmedClearing` lower it, the latter raising
 * `slashed` by the same amount; `SlashedForReorg` raises `slashed` from free stake;
 * `WithdrawalReleased` raises `released`. Free Bond is `staked - reserved -
 * slashed - released`, the identity `Bond._free` derives on every read, and
 * `credit-service.ts` checks all four against `Bond.ledgerOf` before any of them is
 * served.
 *
 * The party is mapped back to its Service by joining `BondFunded.replayKey` to the
 * `SettlementRecorded` that proved the deposit: a proven deposit lands on the
 * Service's own Bond Collection Address, so that Settlement names the owner.
 */
export type ServiceBondRow = BondLedgerRow;

const bondLedgerRow = (row: RawRow): BondLedgerRow => ({
  serviceId: text(row, "service_id"),
  party: text(row, "party"),
  asset: text(row, "asset"),
  staked: text(row, "staked"),
  reserved: text(row, "reserved"),
  slashed: text(row, "slashed"),
  released: text(row, "released"),
  free: text(row, "free"),
  depositCount: integer(row, "deposit_count"),
  lastBlock: integer(row, "last_block"),
});

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
    chainKey: BigInt(text(row, "record_chain_key")),
    curated: boolean(row, "record_curated"),
    bonded: boolean(row, "record_bonded"),
  },
  creditcoin: provenance(row),
});

const authorisationRow = (row: RawRow): AuthorisationRow => ({
  agent: text(row, "agent"),
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  maxCumulative: text(row, "max_cumulative"),
  expiry: text(row, "expiry"),
  creditcoin: provenance(row),
});

// ---------------------------------------------------------- agent credit shapes

/**
 * The last Open Tab this index observed for one tab, and when.
 *
 * **Not the live Open Tab, and the difference matters.** An Open Tab moves in two
 * directions: a Verified Settlement reduces it, which is the indexed
 * `SettlementApplied.openAfter` below, and a Metered Delivery raises it, which is
 * `TabBook.DeliveryRecorded` — an event this service does not index. So this is the
 * tab as at its last settlement and is a lower bound on the tab now. The live
 * figure is `TabBook.assetOpen(agent, asset)`, a public read that needs no
 * signature.
 */
export interface TabObservationRow {
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly openAfter: string;
  readonly creditcoin: Provenance;
}

const tabObservationRow = (row: RawRow): TabObservationRow => ({
  agent: text(row, "agent"),
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  openAfter: text(row, "open_after"),
  creditcoin: provenance(row),
});

/**
 * The last observed prepaid balance on one tab, and the draw that left it there.
 *
 * `TabBook.PrepaidConsumed` fires inside `_recordOnTab` whenever a Metered Delivery
 * is paid out of prepaid credit, so this is the balance as at the most recent
 * **draw** on the tab. It is an observation like {@link TabObservationRow} and moves
 * both ways for the same reason: a draw lowers it, and a later Verified Settlement
 * with an excess raises it through `SettlementApplied.toPrepaid`. The live figure is
 * `TabBook.tabOf(TabBook.tabIdOf(agent, serviceId, asset)).prepaid`, a public read
 * that needs no signature.
 *
 * `openAdded` is what the same charge borrowed once the balance ran out, which is
 * zero for a delivery paid entirely out of credit.
 */
export interface PrepaidObservationRow {
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly consumed: string;
  readonly prepaidAfter: string;
  readonly openAdded: string;
  readonly creditcoin: Provenance;
}

const prepaidObservationRow = (row: RawRow): PrepaidObservationRow => ({
  agent: text(row, "agent"),
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  consumed: text(row, "consumed"),
  prepaidAfter: text(row, "prepaid_after"),
  openAdded: text(row, "open_added"),
  creditcoin: provenance(row),
});

/**
 * The prepaid credit ledger for one Agent and Asset, and it balances exactly.
 *
 * Unlike the Open Tab, this figure is **not** a lower bound, and the reason is that
 * prepaid credit moves through exactly two events and this service indexes both.
 * `TabBook` raises `tab.prepaid` in two places - `_applyOrdinarySettlement` and
 * `_confirmProvisional` - and both emit `SettlementApplied` carrying the increase as
 * `toPrepaid`. It lowers `tab.prepaid` in one place, `_recordOnTab`, which emits
 * `PrepaidConsumed` carrying the decrease as `consumed`. There is no third mover. So
 * `balance` is `fundedTotal` less `consumedTotal` and is the live figure as at the
 * index horizon, not an observation as at some last settlement.
 *
 * The one figure here that is a lower bound is `borrowedOnDraw`, and it is named that
 * way for it. A delivery that drew no prepaid credit emits no `PrepaidConsumed` at
 * all, so this counts only the borrowing that happened on a draw. Total borrowing
 * rides on `TabBook.DeliveryRecorded`, which this service does not index.
 */
export interface PrepaidTotalsRow {
  readonly asset: string;
  /** Prepaid credit received, from every `SettlementApplied.toPrepaid`. Exact. */
  readonly fundedTotal: string;
  /** Prepaid credit spent, from every `PrepaidConsumed.consumed`. Exact. */
  readonly consumedTotal: string;
  /** `fundedTotal` less `consumedTotal`, which is the balance itself. Exact. */
  readonly balance: string;
  /** Borrowed on a draw, from `PrepaidConsumed.openAdded`. A lower bound on borrowing. */
  readonly borrowedOnDraw: string;
  readonly drawCount: number;
  /** Block of the most recent draw, or null where the Agent has never drawn. */
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

/**
 * A delinquency, and whether a later settlement lifted it.
 *
 * `resolved` mirrors the contract's own rule rather than guessing at one.
 * `TabBook._clearDelinquencyIfSettled` lifts the flag exactly when a settlement
 * leaves the tab at zero, and `SettlementApplied.openAfter` is that same figure, so
 * a delinquency is resolved when a `SettlementApplied` row for the same tab sits
 * later in the total order with `open_after = 0`. `TabDelinquencyCleared` is the
 * contract's own confirmation of the lift and is not indexed, so this is a
 * derivation from the rule and not a report of the event.
 */
export interface DelinquencyRow {
  readonly tabId: string;
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly unsettled: string;
  /** Creditcoin timestamp the Settlement Window closed at, seconds. */
  readonly windowEnd: string;
  readonly resolved: boolean;
  readonly creditcoin: Provenance;
}

const delinquencyRow = (row: RawRow): DelinquencyRow => ({
  tabId: text(row, "tab_id"),
  agent: text(row, "agent"),
  serviceId: text(row, "service_id"),
  asset: text(row, "asset"),
  unsettled: text(row, "unsettled"),
  windowEnd: text(row, "window_end"),
  resolved: boolean(row, "resolved"),
  creditcoin: provenance(row),
});

/** A Source Chain address proven to belong to an Agent. */
export interface BoundAddressRow {
  readonly agent: string;
  readonly chainKey: string;
  readonly ethAddress: string;
  readonly provingReplayKey: string;
  readonly creditcoin: Provenance;
}

const boundAddressRow = (row: RawRow): BoundAddressRow => ({
  agent: text(row, "agent"),
  chainKey: text(row, "chain_key"),
  ethAddress: text(row, "eth_address"),
  provingReplayKey: text(row, "proving_replay_key"),
  creditcoin: provenance(row),
});

/** Settled totals for one Agent and Asset, over the Settlements that reached a tab. */
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

/** One Agent in the directory listing, with the position that pages it. */
export interface AgentSummaryRow {
  readonly agent: string;
  readonly settlementCount: number;
  readonly settledTotal: string;
  readonly assetCount: number;
  readonly creditcoin: Provenance;
}

const agentSummaryRow = (row: RawRow): AgentSummaryRow => ({
  agent: text(row, "agent"),
  settlementCount: integer(row, "settlement_count"),
  settledTotal: text(row, "settled_total"),
  assetCount: integer(row, "asset_count"),
  creditcoin: provenance(row),
});

/**
 * Assets an Agent has any credit-relevant row in: a committed history, a spending
 * authorisation, or both. The Agent read unions these with the settlement, tab,
 * and delinquency Assets so a brand-new Agent that has only authorised a Service is
 * still shown the baseline it holds.
 */
export interface AgentAssetRow {
  readonly asset: string;
}

// -------------------------------------------------------------- the read surface

/**
 * Every read the endpoints perform.
 *
 * The routes are written against this rather than against Postgres, for the same
 * reason the indexer is written against `EventSink`: the shaping, the pagination,
 * and the absence handling are then exercisable without assuming one storage
 * engine. Unlike the write side there is no second implementation, because these
 * reads are `DISTINCT ON` and aggregate reductions whose whole value is that the
 * database performs them — a hand-rolled in-memory twin would be testing different
 * code. So the tests run against a real PostgreSQL server, which is the only way
 * the SQL below is checked at all.
 *
 * Paginated reads take `pageSize` and return **up to `pageSize + 1` rows**. The
 * extra row is how {@link toPage} decides whether a next cursor exists without a
 * second count query.
 */
export interface RegistryReads {
  horizon(stream: string): Promise<IndexHorizon>;

  settlements(
    filter: SettlementFilter,
    pageSize: number,
    after: LogPosition | null,
  ): Promise<readonly SettlementView[]>;
  settlementByReplayKey(replayKey: string): Promise<SettlementView | null>;
  clearingLineage(replayKey: string): Promise<readonly ClearingEventView[]>;
  declinedObservations(agent: string): Promise<readonly DeclinedObservationView[]>;

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
  /** The last observed prepaid balance per tab for one Agent. */
  prepaidObservations(agent: string): Promise<readonly PrepaidObservationRow[]>;
  /** Prepaid credit spent per Asset for one Agent, over every draw. */
  prepaidTotals(agent: string): Promise<readonly PrepaidTotalsRow[]>;
  delinquencies(agent: string): Promise<readonly DelinquencyRow[]>;
  boundAddresses(agent: string): Promise<readonly BoundAddressRow[]>;

  /** The committed history for one Agent and Asset, in commitment order. */
  historyRecords(agent: string, asset: string): Promise<readonly HistoryRecordRow[]>;
  /** Every spending authorisation the Agent set in the Asset, latest per Service. */
  authorisations(agent: string, asset: string): Promise<readonly AuthorisationRow[]>;
  /** Assets the Agent holds a history or an authorisation in. */
  creditAssets(agent: string): Promise<readonly AgentAssetRow[]>;
  /** Replayed Bond ledgers for the named Services, one per Asset each. */
  bondLedgers(serviceIds: readonly string[]): Promise<readonly BondLedgerRow[]>;

  /** Settled volume and Settlement count per Agent and Asset, over the whole index. */
  settlementVolumeByAgentAsset(): Promise<readonly AgentAssetVolumeRow[]>;
  /** Every indexed prepaid draw, which stands in for a Metered Delivery. */
  prepaidDraws(): Promise<readonly PrepaidDrawRow[]>;

  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** One Agent's settled volume in one Asset, for the adoption split. */
export interface AgentAssetVolumeRow {
  readonly agent: string;
  readonly asset: string;
  readonly amount: string;
  readonly settlementCount: number;
}

/** One indexed `PrepaidConsumed`, reduced to what the adoption split needs. */
export interface PrepaidDrawRow {
  readonly agent: string;
  readonly asset: string;
}

/** In chain order, oldest first. Used where the ordering is done here rather than in SQL. */
const byPositionAscending = <T extends { readonly creditcoin: Provenance }>(a: T, b: T): number =>
  a.creditcoin.blockNumber - b.creditcoin.blockNumber || a.creditcoin.logIndex - b.creditcoin.logIndex;

export interface PostgresReadsOptions {
  /** Connections in the pool. Reads are short and concurrent, so a few is plenty. */
  readonly max?: number;
  readonly connectTimeoutSeconds?: number;
}

/**
 * The Postgres implementation.
 *
 * Its own pool, separate from the indexer's. The indexer is a single writer whose
 * transactions must not queue behind a slow read, and the read side scales
 * horizontally, so sharing one pool would couple two things whose load shapes have
 * nothing in common.
 */
export class PostgresReads implements RegistryReads {
  private readonly client: postgres.Sql;

  private constructor(client: postgres.Sql) {
    this.client = client;
  }

  /** Opens a pool. Does not connect eagerly, so a slow database cannot fail construction. */
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
      // No cursor row means the stream has never ticked. Reporting a horizon of
      // `null` is the truthful answer and is what stops a caller reading an empty
      // result set as "nothing has happened on chain".
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

  // ------------------------------------------------------------- settlements

  /**
   * A page of Verified Settlements, newest first. (R24.4)
   *
   * Filters are exact equality and every one is optional, expressed as
   * `parameter IS NULL OR column = parameter` so one statement serves every
   * combination rather than being assembled from string fragments.
   */
  async settlements(
    filter: SettlementFilter,
    pageSize: number,
    after: LogPosition | null,
  ): Promise<readonly SettlementView[]> {
    const agent = filter.agent ?? null;
    const serviceId = filter.serviceId ?? null;
    const asset = filter.asset ?? null;
    const chainKey = filter.chainKey ?? null;
    const afterBlock = after === null ? null : String(after.blockNumber);
    const afterLog = after === null ? null : String(after.logIndex);

    const rows = await this.client<RawRow[]>`
      SELECT s.replay_key,
             s.chain_key::text           AS chain_key,
             s.source_block_height::text AS source_block_height,
             s.source_tx_index::text     AS source_tx_index,
             s.source_log_index::text    AS source_log_index,
             s.agent,
             s.service_id,
             s.asset,
             s.amount::text              AS amount,
             s.payer_address,
             s.source_tab_id,
             l.block_number::text        AS block_number,
             l.block_hash,
             l.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time,
             a.applied::text             AS applied,
             a.to_prepaid::text          AS to_prepaid,
             a.open_after::text          AS open_after
        FROM registry.settlement_recorded s
        JOIN registry.event_log l
          ON l.block_hash = s.block_hash AND l.log_index = s.log_index
        LEFT JOIN registry.settlement_applied a
          ON a.replay_key = s.replay_key
       WHERE (${agent}::text IS NULL OR s.agent = ${agent}::text)
         AND (${serviceId}::text IS NULL OR s.service_id = ${serviceId}::text)
         AND (${asset}::text IS NULL OR s.asset = ${asset}::text)
         AND (${chainKey}::text IS NULL OR s.chain_key = ${chainKey}::bigint)
         AND (${afterBlock}::text IS NULL
              OR (l.block_number, l.log_index) < (${afterBlock}::bigint, ${afterLog}::int))
       ORDER BY l.block_number DESC, l.log_index DESC
       LIMIT ${pageSize + 1}`;
    return rows.map(settlementView);
  }

  /**
   * One Verified Settlement by its replay key.
   *
   * **The key is the identity, and a transaction hash is not.** One Creditcoin
   * transaction can carry several Settlements, and one Source Chain transaction can
   * too, so the only locator that names exactly one is the packed
   * `(chainKey, blockHeight, txIndex, logIndex)` tuple.
   */
  async settlementByReplayKey(replayKey: string): Promise<SettlementView | null> {
    const rows = await this.client<RawRow[]>`
      SELECT s.replay_key,
             s.chain_key::text           AS chain_key,
             s.source_block_height::text AS source_block_height,
             s.source_tx_index::text     AS source_tx_index,
             s.source_log_index::text    AS source_log_index,
             s.agent,
             s.service_id,
             s.asset,
             s.amount::text              AS amount,
             s.payer_address,
             s.source_tab_id,
             l.block_number::text        AS block_number,
             l.block_hash,
             l.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time,
             a.applied::text             AS applied,
             a.to_prepaid::text          AS to_prepaid,
             a.open_after::text          AS open_after
        FROM registry.settlement_recorded s
        JOIN registry.event_log l
          ON l.block_hash = s.block_hash AND l.log_index = s.log_index
        LEFT JOIN registry.settlement_applied a
          ON a.replay_key = s.replay_key
       WHERE s.replay_key = ${replayKey}
       ORDER BY l.block_number DESC, l.log_index DESC
       LIMIT 1`;
    const row = rows.at(0);
    return row === undefined ? null : settlementView(row);
  }

  /**
   * Every clearing state observed under one replay key, oldest first.
   *
   * Four states, four tables, one identity. The ordering is applied here rather
   * than in the SQL because a `UNION ALL` may only be ordered by an output column,
   * and the output carries the block number as text so that a `uint64` cannot round
   * — sorting on that text would order block 9 after block 10. The set is at most a
   * handful of rows, so sorting it in this process costs nothing and removes the
   * trap.
   */
  async clearingLineage(replayKey: string): Promise<readonly ClearingEventView[]> {
    const rows = await this.client<RawRow[]>`
      SELECT 'provisional'         AS state,
             c.amount::text        AS amount,
             c.source_tx_hash      AS source_tx_hash,
             c.deadline::text      AS deadline,
             NULL::text            AS observed_digest,
             NULL::text            AS attested_digest,
             l.block_number::text  AS block_number,
             c.block_hash          AS block_hash,
             c.log_index           AS log_index,
             l.tx_hash             AS tx_hash,
             l.tx_index            AS tx_index,
             l.block_time          AS block_time
        FROM registry.provisional_clearing_applied c
        JOIN registry.event_log l
          ON l.block_hash = c.block_hash AND l.log_index = c.log_index
       WHERE c.clearing_id = ${replayKey}
       UNION ALL
      SELECT 'confirmed', c.amount::text, c.source_tx_hash, NULL::text, NULL::text, NULL::text,
             l.block_number::text, c.block_hash, c.log_index, l.tx_hash, l.tx_index, l.block_time
        FROM registry.provisional_clearing_confirmed c
        JOIN registry.event_log l
          ON l.block_hash = c.block_hash AND l.log_index = c.log_index
       WHERE c.clearing_id = ${replayKey}
       UNION ALL
      SELECT 'reversed', c.amount::text, c.source_tx_hash, NULL::text, NULL::text, NULL::text,
             l.block_number::text, c.block_hash, c.log_index, l.tx_hash, l.tx_index, l.block_time
        FROM registry.provisional_clearing_reversed c
        JOIN registry.event_log l
          ON l.block_hash = c.block_hash AND l.log_index = c.log_index
       WHERE c.clearing_id = ${replayKey}
       UNION ALL
      SELECT 'superseded', s.amount::text, NULL::text, NULL::text, s.observed_digest, s.attested_digest,
             l.block_number::text, s.block_hash, s.log_index, l.tx_hash, l.tx_index, l.block_time
        FROM registry.settlement_superseded s
        JOIN registry.event_log l
          ON l.block_hash = s.block_hash AND l.log_index = s.log_index
       WHERE s.replay_key = ${replayKey}`;
    return rows.map(clearingEventView).sort(byPositionAscending);
  }

  /** Every declined observation for one Agent, newest first. */
  async declinedObservations(agent: string): Promise<readonly DeclinedObservationView[]> {
    const rows = await this.client<RawRow[]>`
      SELECT d.agent,
             d.service_id,
             d.asset,
             d.amount::text        AS amount,
             d.source_tx_hash,
             d.free_bond::text     AS free_bond,
             l.block_number::text  AS block_number,
             d.block_hash,
             d.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time
        FROM registry.provisional_clearing_declined d
        JOIN registry.event_log l
          ON l.block_hash = d.block_hash AND l.log_index = d.log_index
       WHERE d.agent = ${agent}
       ORDER BY l.block_number DESC, d.log_index DESC`;
    return rows.map(declinedObservationView);
  }

  // -------------------------------------------------------- service directory

  /**
   * A page of Service registrations, newest first.
   *
   * `DISTINCT ON (service_id)` rather than a plain select, so that a registry which
   * ever emits a second registration for one Service serves the later one instead
   * of both. The registration is what the directory pages on, because it is the one
   * fact every Service has exactly one of.
   */
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

  /** One Service's registration, or `null` when nothing ever registered under that id. */
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

  /**
   * The latest applied change per Service and kind.
   *
   * This is what a served registry value is allowed to come from. A queued change
   * inside its hold contributes nothing here, which is R11.7 expressed as a query
   * rather than as a promise: the previously applied value keeps serving until the
   * `RegistryChangeApplied` log exists.
   */
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

  /**
   * Changes that are queued and still waiting. (R11.6, R11.8)
   *
   * A queued change stays pending until it is applied or cancelled, so both have to
   * be excluded — the cancellation especially, because without it a withdrawn change
   * would be served as pending forever with an ETA that never arrives. A change left
   * queued past its ETA is still pending, because the timelock is a floor on the
   * wait and not a window: `ServiceRegistry.applyChange` accepts it at any later
   * moment.
   */
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

  /** The current price of every named tool, per Service and Asset. (R24.3) */
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
   * Collection Addresses that currently resolve. (R24.3)
   *
   * Registrations and releases are folded into one stream and reduced per
   * `(chainKey, collection)`, which is the pair the registry keeps globally unique.
   * Taking registrations alone would keep serving a moved address as though it still
   * resolved to its old Service; taking the latest event of either kind and
   * discarding the ones that end in a release is what makes the answer current.
   */
  async collections(serviceIds: readonly string[]): Promise<readonly CollectionRow[]> {
    const rows = await this.client<RawRow[]>`
      WITH events AS (
        SELECT c.service_id,
               c.chain_key,
               c.collection,
               c.asset::text                 AS asset,
               c.collection_kind,
               c.collection_kind_name,
               TRUE                          AS active,
               l.block_number,
               c.block_hash,
               c.log_index,
               l.tx_hash,
               l.tx_index,
               l.block_time
          FROM registry.collection_registered c
          JOIN registry.event_log l
            ON l.block_hash = c.block_hash AND l.log_index = c.log_index
         UNION ALL
        SELECT r.service_id,
               r.chain_key,
               r.collection,
               NULL::text,
               NULL::smallint,
               NULL::text,
               FALSE,
               l.block_number,
               r.block_hash,
               r.log_index,
               l.tx_hash,
               l.tx_index,
               l.block_time
          FROM registry.collection_released r
          JOIN registry.event_log l
            ON l.block_hash = r.block_hash AND l.log_index = r.log_index
      ),
      current AS (
        SELECT DISTINCT ON (chain_key, collection) *
          FROM events
         ORDER BY chain_key, collection, block_number DESC, log_index DESC
      )
      SELECT service_id,
             chain_key::text      AS chain_key,
             collection,
             asset,
             collection_kind,
             collection_kind_name,
             block_number::text   AS block_number,
             block_hash,
             log_index,
             tx_hash,
             tx_index,
             block_time
        FROM current
       WHERE active
         AND service_id = ANY(${[...serviceIds]}::text[])
       ORDER BY chain_key, collection`;
    return rows.map(collectionRow);
  }

  /** A Service's Bond ledgers, replayed from events. See {@link ServiceBondRow}. */
  async serviceBonds(serviceIds: readonly string[]): Promise<readonly ServiceBondRow[]> {
    return this.bondLedgers(serviceIds);
  }

  /**
   * Bond ledgers per Service and Asset, replayed from the seven ledger events.
   *
   * The party is resolved to a Service through the deposit that funded it, so a
   * party with reservations and no deposit cannot appear; the contract refuses a
   * reservation against an unfunded ledger, so none exists on chain either. Every
   * sum is `COALESCE`d to zero, because a ledger with deposits and no other event is
   * the common case and a null there would read as an unknown figure.
   */
  async bondLedgers(serviceIds: readonly string[]): Promise<readonly BondLedgerRow[]> {
    if (serviceIds.length === 0) return [];
    const rows = await this.client<RawRow[]>`
      WITH parties AS (
        -- Joined to bond_deposit_recorded, never to settlement_recorded.
        -- SettlementVerifier._credit routes a Settlement naming a Bond Collection
        -- Address to Bond and emits BondDepositRecorded on that branch; it emits no
        -- SettlementRecorded at all. Joining through the settlement feed matched no
        -- row, dropped the party, and collapsed every staked figure to zero, which
        -- the cross-check against Bond.ledgerOf is what caught.
        SELECT DISTINCT d.service_id, d.party, d.asset
          FROM registry.bond_deposit_recorded d
         WHERE d.service_id = ANY(${[...serviceIds]}::text[])
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
      reserved AS (
        SELECT r.party, r.asset, SUM(r.amount) AS amount, MAX(l.block_number) AS last_block
          FROM registry.bond_reserved r
          JOIN registry.event_log l ON l.block_hash = r.block_hash AND l.log_index = r.log_index
         GROUP BY r.party, r.asset
      ),
      released AS (
        SELECT r.party, r.asset, SUM(r.amount) AS amount, MAX(l.block_number) AS last_block
          FROM registry.bond_released r
          JOIN registry.event_log l ON l.block_hash = r.block_hash AND l.log_index = r.log_index
         GROUP BY r.party, r.asset
      ),
      slashed_unconfirmed AS (
        SELECT x.party, x.asset, SUM(x.amount) AS amount, MAX(l.block_number) AS last_block
          FROM registry.slashed_for_unconfirmed_clearing x
          JOIN registry.event_log l ON l.block_hash = x.block_hash AND l.log_index = x.log_index
         GROUP BY x.party, x.asset
      ),
      slashed_reorg AS (
        SELECT x.party, x.asset, SUM(x.amount) AS amount, MAX(l.block_number) AS last_block
          FROM registry.slashed_for_reorg x
          JOIN registry.event_log l ON l.block_hash = x.block_hash AND l.log_index = x.log_index
         GROUP BY x.party, x.asset
      ),
      withdrawn AS (
        SELECT w.party, w.asset, SUM(w.amount) AS amount, MAX(l.block_number) AS last_block
          FROM registry.withdrawal_released w
          JOIN registry.event_log l ON l.block_hash = w.block_hash AND l.log_index = w.log_index
         GROUP BY w.party, w.asset
      ),
      ledger AS (
        SELECT p.service_id, p.party, p.asset,
               COALESCE(f.staked, 0)                                          AS staked,
               COALESCE(rs.amount, 0) - COALESCE(rl.amount, 0) - COALESCE(su.amount, 0) AS reserved,
               COALESCE(su.amount, 0) + COALESCE(sr.amount, 0)                AS slashed,
               COALESCE(w.amount, 0)                                          AS released,
               COALESCE(f.deposit_count, 0)                                   AS deposit_count,
               GREATEST(COALESCE(f.last_block, 0), COALESCE(rs.last_block, 0), COALESCE(rl.last_block, 0),
                        COALESCE(su.last_block, 0), COALESCE(sr.last_block, 0), COALESCE(w.last_block, 0)) AS last_block
          FROM parties p
          LEFT JOIN funded f               ON f.party = p.party  AND f.asset = p.asset
          LEFT JOIN reserved rs            ON rs.party = p.party AND rs.asset = p.asset
          LEFT JOIN released rl            ON rl.party = p.party AND rl.asset = p.asset
          LEFT JOIN slashed_unconfirmed su ON su.party = p.party AND su.asset = p.asset
          LEFT JOIN slashed_reorg sr       ON sr.party = p.party AND sr.asset = p.asset
          LEFT JOIN withdrawn w            ON w.party = p.party  AND w.asset = p.asset
      )
      SELECT service_id,
             party,
             asset,
             staked::text                                        AS staked,
             reserved::text                                      AS reserved,
             slashed::text                                       AS slashed,
             released::text                                      AS released,
             (staked - reserved - slashed - released)::text      AS free,
             deposit_count,
             last_block::text                                    AS last_block
        FROM ledger
       ORDER BY service_id, asset`;
    return rows.map(bondLedgerRow);
  }

  // ---------------------------------------------------------- credit witness

  /** The committed history for one Agent and Asset, in commitment order. */
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
             h.record_chain_key::text         AS record_chain_key,
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

  /** The latest authorisation per Service the Agent set in the Asset. */
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

  /** Assets the Agent holds a committed history or an authorisation in. */
  async creditAssets(agent: string): Promise<readonly AgentAssetRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT asset FROM registry.history_extended WHERE agent = ${agent}
      UNION
      SELECT asset FROM registry.authorisation_set WHERE agent = ${agent}
      ORDER BY asset`;
    return rows.map((row) => ({ asset: text(row, "asset") }));
  }

  // ------------------------------------------------------------ agent credit

  /**
   * A page of Agents, ordered by their most recent Verified Settlement.
   *
   * The order is a total one because it is keyed on that Settlement's position, and
   * two Settlements never share a position. An Agent whose only activity is a
   * binding or a delinquency does not appear here, which is deliberate: this is the
   * settlement directory, and an Agent with no Settlement has no credit history to
   * list. Its own detail read still answers.
   */
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
          FROM registry.settlement_recorded s
          JOIN registry.event_log l
            ON l.block_hash = s.block_hash AND l.log_index = s.log_index
         ORDER BY s.agent, l.block_number DESC, s.log_index DESC
      ),
      totals AS (
        SELECT s.agent,
               COUNT(*)::int              AS settlement_count,
               SUM(s.amount)::text        AS settled_total,
               COUNT(DISTINCT s.asset)::int AS asset_count
          FROM registry.settlement_recorded s
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

  /** Settled totals for one Agent, one row per Asset. */
  async agentAssetTotals(agent: string): Promise<readonly AgentAssetTotalsRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT s.agent,
             s.asset,
             COUNT(*)::int                      AS settlement_count,
             SUM(s.amount)::text                AS settled_total,
             COALESCE(SUM(a.applied), 0)::text  AS applied_total,
             COALESCE(SUM(a.to_prepaid), 0)::text AS prepaid_total,
             MIN(l.block_number)::text          AS first_block,
             MAX(l.block_number)::text          AS last_block,
             MAX(l.block_time)                  AS last_block_time
        FROM registry.settlement_recorded s
        JOIN registry.event_log l
          ON l.block_hash = s.block_hash AND l.log_index = s.log_index
        LEFT JOIN registry.settlement_applied a
          ON a.replay_key = s.replay_key
       WHERE s.agent = ${agent}
       GROUP BY s.agent, s.asset
       ORDER BY s.asset`;
    return rows.map(agentAssetTotalsRow);
  }

  /** The last observed Open Tab per tab for one Agent. See {@link TabObservationRow}. */
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

  /**
   * The last observed prepaid balance per tab for one Agent.
   *
   * One row per `(agent, service_id, asset)` triple, which is the tab identity
   * `TabBook.tabIdOf` hashes, taking the latest draw in the total order. See
   * {@link PrepaidObservationRow} for why this is an observation and not the live
   * balance.
   */
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

  /**
   * The prepaid credit ledger for one Agent, one row per Asset.
   *
   * A full outer join, deliberately. An Asset funded but never drawn has no
   * `prepaid_consumed` row and an Asset drawn to nothing still has its funding rows,
   * and dropping either side would report a balance that never existed. Summed off
   * `settlement_applied` directly rather than through `settlement_recorded`, because
   * the balance is the difference between the two events that move it and nothing
   * else belongs in that arithmetic.
   *
   * See {@link PrepaidTotalsRow} for why this is exact where the Open Tab is not.
   */
  /**
   * Settled volume and count per Agent and Asset, across the whole index.
   *
   * Grouped by `agent` rather than by `payer_address`. A Settlement is credited to
   * the Agent bound in `AgentRegistry`, and the two differ whenever the Settlement was
   * broadcast from a smart account, so grouping by the payer would attribute volume to
   * whoever pressed send rather than to whoever the credit belongs to.
   *
   * Unpaginated on purpose: this feeds one aggregate, and a page boundary in the
   * middle of a sum produces a number that is wrong rather than partial.
   */
  async settlementVolumeByAgentAsset(): Promise<readonly AgentAssetVolumeRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT s.agent            AS agent,
             s.asset            AS asset,
             SUM(s.amount)::text AS amount,
             COUNT(*)::int      AS settlement_count
        FROM registry.settlement_recorded s
       GROUP BY s.agent, s.asset
       ORDER BY s.agent, s.asset
    `;
    return rows.map((row) => ({
      agent: String(row.agent),
      asset: String(row.asset),
      amount: String(row.amount),
      settlementCount: Number(row.settlement_count),
    }));
  }

  /**
   * Every indexed prepaid draw.
   *
   * One row per `PrepaidConsumed`, which fires only on a delivery paid wholly or partly
   * out of prepaid credit. `DeliveryRecorded` is not indexed, so a count of these is a
   * lower bound on Metered Deliveries and the adoption read says so in its own body.
   */
  async prepaidDraws(): Promise<readonly PrepaidDrawRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT p.agent AS agent, p.asset AS asset
        FROM registry.prepaid_consumed p
    `;
    return rows.map((row) => ({ agent: String(row.agent), asset: String(row.asset) }));
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

  /** Delinquencies for one Agent, with the contract's own clearing rule applied. */
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
                       FROM registry.settlement_applied a
                       JOIN registry.event_log al
                         ON al.block_hash = a.block_hash AND al.log_index = a.log_index
                      WHERE a.agent = latest.agent
                        AND a.service_id = latest.service_id
                        AND a.asset = latest.asset
                        AND a.open_after = 0
                        AND (al.block_number, al.log_index) > (latest.block_number, latest.log_index)
                    ) AS resolved
        FROM latest
       ORDER BY block_number DESC, log_index DESC`;
    return rows.map(delinquencyRow);
  }

  /** Every Source Chain address proven to belong to one Agent. */
  async boundAddresses(agent: string): Promise<readonly BoundAddressRow[]> {
    const rows = await this.client<RawRow[]>`
      SELECT b.agent,
             b.chain_key::text    AS chain_key,
             b.eth_address,
             b.proving_replay_key,
             l.block_number::text AS block_number,
             b.block_hash,
             b.log_index,
             l.tx_hash,
             l.tx_index,
             l.block_time
        FROM registry.address_bound b
        JOIN registry.event_log l
          ON l.block_hash = b.block_hash AND l.log_index = b.log_index
       WHERE b.agent = ${agent}
       ORDER BY b.chain_key, l.block_number DESC, b.log_index DESC`;
    return rows.map(boundAddressRow);
  }
}

// ------------------------------------------------------------ input narrowing
//
// The two shapes every identifier in this schema takes, mirroring the
// `registry.hex_address` and `registry.hex_word` domains the columns are declared
// over. Checking here rather than letting a malformed value reach the database is
// worth the duplication: the domain would reject it too, but as a driver error
// carrying a constraint name, where a caller needs "this is not a 20-byte address".
//
// Lowercase only, in both, because `events.ts` normalises casing on the way in and
// a mixed-case address would silently match nothing.

/** True for a lowercase 20-byte hex address. */
export const isHexAddress = (value: string): boolean => /^0x[0-9a-f]{40}$/.test(value);

/** True for a lowercase 32-byte hex word: a serviceId, a replay key, a tab id, a tool. */
export const isHexWord = (value: string): boolean => /^0x[0-9a-f]{64}$/.test(value);

/** True for a decimal `uint64`, which is how a chainKey arrives in a query string. */
export const isChainKey = (value: string): boolean =>
  /^\d{1,20}$/.test(value) && BigInt(value) <= (1n << 64n) - 1n;
