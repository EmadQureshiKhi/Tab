/**
 * The Credit Limit, headroom, and Bond ledger this service serves, and the rule
 * that lets it serve them: **a derived figure leaves only after the chain has
 * agreed with it at the block it was derived for.**
 *
 * ## The witness
 *
 * `TabBook.creditLimit(agent, asset, witness)` answers only against a
 * `LimitWitness` that folds to the stored history commitment. The witness is
 * rebuilt here from `HistoryExtended` rows, which carry each committed record in
 * full and in commitment order; the rebuilt history is folded with the same hash
 * the contract uses and compared against the root the last row reported, so a
 * missing or reordered row is caught before an `eth_call` is spent on it.
 *
 * The Bond entries follow `TabBook._resolveBonds`. One entry per counterparty
 * Service of the Agent in the Asset, where a counterparty is a Service that
 * appears in the committed history or that the Agent has authorised to meter it.
 * The second clause is what lets a brand-new Agent hold a Credit Limit at all:
 * with an empty history and no authorisation the bond cap is zero and so is the
 * limit, which is the contract's answer too. Amounts are the ledger's `staked`
 * figure, derived from `BondFunded`, and the contract replaces them with its own
 * read either way, so an error here can only make the cross-check fail.
 *
 * ## What is served, and what is not
 *
 * The served value is this service's recomputation of `LimitLib`, at the index
 * horizon block, with `evaluatedAt` taken from that block's timestamp. It is
 * served only when `TabBook.creditLimit` at that block returns the same number.
 * Where the chain returns a different number, or cannot be read, the value is
 * `null` and an `unavailable` block says which of the two happened and carries the
 * recomputed figure so nothing is hidden. A number the chain has not confirmed is
 * exactly the one thing this read layer exists not to serve.
 *
 * Headroom is the limit less `TabBook.assetOpen` at the same block. The Open Tab
 * is read rather than derived because a Metered Delivery raises it and
 * `DeliveryRecorded` is not indexed; the read is checked against
 * `TabBook.headroom` the same way.
 *
 * ## Delinquency
 *
 * The contract zeroes the limit ahead of any arithmetic while a delinquent tab
 * stands in the Asset. The recomputation applies the index's own derivation of
 * that flag, which mirrors the contract's lifting rule, and the cross-check is what
 * catches the two ever disagreeing.
 *
 * Requirements: 24.1, 24.3, 24.7, 12.6, 13.1, 28.3
 */

import type { CreditChainReader, LedgerFigures } from "./chain-reads.js";
import {
  HistoryTooLong,
  TooManyCounterparties,
  ZERO_ROOT,
  commitmentOf,
  creditLimit,
  type BondEntry,
  type LimitWitness,
  type SettlementRecord,
} from "./credit.js";
import type { Provenance } from "./queries.js";

// ----------------------------------------------------------------- the reads

/** One `HistoryExtended` row, as the witness is rebuilt from it. */
export interface HistoryRecordRow {
  readonly agent: string;
  readonly asset: string;
  readonly root: string;
  readonly count: number;
  readonly record: SettlementRecord;
  readonly creditcoin: Provenance;
}

/** A Service the Agent authorised to meter it in one Asset. */
export interface AuthorisationRow {
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly maxCumulative: string;
  readonly expiry: string;
  readonly creditcoin: Provenance;
}

/**
 * One Bond ledger as the events reconstruct it, with the Service the party maps to.
 *
 * `party` is `Bond.partyOf(bondAccount)`; `serviceId` is the Service whose Bond
 * Collection Address received the deposits, taken from `BondDepositRecorded`, which
 * is the only event carrying both. It is deliberately not resolved through
 * `SettlementRecorded`: the verifier emits `BondDepositRecorded` **instead of**
 * `SettlementRecorded` on the Bond branch, so a join through the settlement feed
 * matches nothing and silently reports a funded ledger as zero. `free` is
 * `staked - reserved - slashed - released`, the identity `Bond._free` holds.
 */
export interface BondLedgerRow {
  readonly serviceId: string;
  readonly party: string;
  readonly asset: string;
  readonly staked: string;
  readonly reserved: string;
  readonly slashed: string;
  readonly released: string;
  readonly free: string;
  readonly depositCount: number;
  /** Highest Creditcoin block any of this ledger's events was seen in. */
  readonly lastBlock: number;
}

/** The subset of the registry reads this module needs. */
export interface CreditReads {
  historyRecords(agent: string, asset: string): Promise<readonly HistoryRecordRow[]>;
  authorisations(agent: string, asset: string): Promise<readonly AuthorisationRow[]>;
  bondLedgers(serviceIds: readonly string[]): Promise<readonly BondLedgerRow[]>;
}

// ----------------------------------------------------------------- the views

/** Why a figure is not served. Every code names one specific, checkable cause. */
export type CreditUnavailableCode =
  /** the index has never ticked, so there is no block to derive at */
  | "INDEX_NOT_PRIMED"
  /** the `HistoryExtended` rows for the pair do not form the sequence 1..n */
  | "HISTORY_INCOMPLETE"
  /** the rebuilt history does not fold to the root the last row reported */
  | "COMMITMENT_MISMATCH"
  /** the witness is one `LimitLib` itself would refuse */
  | "WITNESS_OUT_OF_BOUNDS"
  /** the chain could not be read at the horizon block */
  | "CHAIN_READ_FAILED"
  /** the chain returned a different figure at the same block */
  | "CROSS_CHECK_DISAGREED"
  /**
   * No Creditcoin endpoint is wired into this process, so the cross-check cannot
   * run at all. Distinct from `CHAIN_READ_FAILED`, which means a configured
   * endpoint answered badly: this one is a deployment gap rather than a chain
   * fault, and it is the operator's to fix rather than something to retry.
   */
  | "CHAIN_READER_UNCONFIGURED";

export interface CreditUnavailable {
  readonly code: CreditUnavailableCode;
  readonly message: string;
  /** The figure this service computed, when it computed one. Never served as the value. */
  readonly recomputed?: string;
  /** The figure the chain returned, when it returned one. */
  readonly onChain?: string;
}

/** The block a figure was derived and checked at. */
export interface ComputedAt {
  readonly blockNumber: number;
  /** Creditcoin timestamp of that block, seconds; the `evaluatedAt` the ages were measured against. */
  readonly blockTime: string;
}

export interface WitnessSummary {
  readonly historyLength: number;
  readonly bondEntries: readonly { readonly serviceId: string; readonly staked: string }[];
  readonly commitment: { readonly root: string; readonly count: number };
  /** Whether `TabBook.historyCommitment` at the block reports the same root and count. */
  readonly commitmentMatchesChain: boolean;
}

export interface CrossCheck {
  readonly read: string;
  readonly onChain: string;
  readonly agrees: true;
}

export interface CreditLimitView {
  readonly value: string | null;
  readonly basis: string;
  readonly computedAt: ComputedAt | null;
  readonly witness: WitnessSummary | null;
  readonly crossCheck: CrossCheck | null;
  readonly unavailable: CreditUnavailable | null;
}

export interface HeadroomView {
  readonly value: string | null;
  readonly basis: string;
  /** `TabBook.assetOpen` at the block, the live Open Tab the headroom is measured from. */
  readonly openTab: string | null;
  readonly crossCheck: CrossCheck | null;
  readonly unavailable: CreditUnavailable | null;
}

export interface AgentCreditView {
  readonly creditLimit: CreditLimitView;
  readonly headroom: HeadroomView;
}

const CREDIT_BASIS =
  "LimitLib recomputed from the HistoryExtended witness and the BondFunded ledger at the index horizon block, served only where TabBook.creditLimit at that block returns the same figure";
const HEADROOM_BASIS =
  "the Credit Limit less TabBook.assetOpen at the same block, served only where TabBook.headroom at that block returns the same figure";

const unavailable = (
  code: CreditUnavailableCode,
  message: string,
  extra: { recomputed?: bigint; onChain?: bigint } = {},
): CreditUnavailable => ({
  code,
  message,
  ...(extra.recomputed === undefined ? {} : { recomputed: extra.recomputed.toString() }),
  ...(extra.onChain === undefined ? {} : { onChain: extra.onChain.toString() }),
});

const withheld = (why: CreditUnavailable): AgentCreditView => ({
  creditLimit: { value: null, basis: CREDIT_BASIS, computedAt: null, witness: null, crossCheck: null, unavailable: why },
  headroom: {
    value: null,
    basis: HEADROOM_BASIS,
    openTab: null,
    crossCheck: null,
    unavailable: {
      code: why.code,
      message: "headroom is the Credit Limit less the Open Tab, so it is withheld with the Credit Limit",
    },
  },
});

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The withheld view, for a caller that cannot even attempt a computation.
 *
 * The one case today is a process with no Creditcoin endpoint wired in. The
 * figures are withheld rather than approximated, for the same reason every other
 * path here withholds them: a Credit Limit this service has not checked against
 * `TabBook` is a number wearing the name of a different number.
 */
export const creditWithheld = (code: CreditUnavailableCode, message: string): AgentCreditView =>
  withheld({ code, message });

// -------------------------------------------------------------- the witness

/** What {@link rebuildWitness} concluded. */
export type WitnessRebuild =
  | { readonly ok: true; readonly witness: LimitWitness; readonly summary: Omit<WitnessSummary, "commitmentMatchesChain"> }
  | { readonly ok: false; readonly unavailable: CreditUnavailable };

/**
 * Rebuilds the `LimitWitness` for one Agent and Asset from indexed rows.
 *
 * The history must be the sequence `count = 1..n` in order, and it must fold to
 * the root the last row reported; either failing means the index is missing or
 * mis-holding a row, and no figure is derived from it. The Bond entries are one
 * per counterparty, which is the union of the Services in the history and the
 * Services the Agent authorised, exactly as `TabBook._isCounterparty` admits them.
 */
export async function rebuildWitness(
  reads: CreditReads,
  agent: string,
  asset: string,
): Promise<WitnessRebuild> {
  const rows = [...(await reads.historyRecords(agent, asset))].sort((a, b) => a.count - b.count);
  for (const [position, row] of rows.entries()) {
    if (row.count !== position + 1) {
      return {
        ok: false,
        unavailable: unavailable(
          "HISTORY_INCOMPLETE",
          `the indexed HistoryExtended rows for this Agent and Asset carry count ${row.count} at position ${position + 1}, so the witness cannot be rebuilt until the index holds every row`,
        ),
      };
    }
  }

  const history = rows.map((row) => row.record);
  const commitment = commitmentOf(history);
  const reported = rows.at(-1)?.root ?? ZERO_ROOT;
  if (commitment.root !== reported.toLowerCase()) {
    return {
      ok: false,
      unavailable: unavailable(
        "COMMITMENT_MISMATCH",
        `the rebuilt history folds to ${commitment.root} while the last HistoryExtended row reported ${reported}, so the index disagrees with itself and no figure is derived from it`,
      ),
    };
  }

  const authorised = await reads.authorisations(agent, asset);
  const counterparties = new Set<string>();
  for (const record of history) {
    if (record.asset.toLowerCase() === asset.toLowerCase()) counterparties.add(record.serviceId.toLowerCase());
  }
  for (const row of authorised) counterparties.add(row.serviceId.toLowerCase());

  const ledgers = await reads.bondLedgers([...counterparties]);
  const stakedOf = new Map<string, bigint>();
  for (const ledger of ledgers) {
    if (ledger.asset.toLowerCase() === asset.toLowerCase()) stakedOf.set(ledger.serviceId.toLowerCase(), BigInt(ledger.staked));
  }
  const bonds: BondEntry[] = [...counterparties].sort().map((serviceId) => ({
    serviceId,
    asset,
    amount: stakedOf.get(serviceId) ?? 0n,
  }));

  return {
    ok: true,
    witness: { history, bonds },
    summary: {
      historyLength: history.length,
      bondEntries: bonds.map((bond) => ({ serviceId: bond.serviceId, staked: bond.amount.toString() })),
      commitment,
    },
  };
}

// ------------------------------------------------------------ the credit view

export interface AgentCreditInput {
  readonly agent: string;
  readonly asset: string;
  /** The index horizon, or `null` when the stream has never ticked. */
  readonly horizonBlock: number | null;
  /** Whether the index holds an unresolved delinquency for the pair. */
  readonly delinquent: boolean;
}

/**
 * The Credit Limit and headroom for one Agent and Asset, derived and checked.
 *
 * The recomputation and the chain reads all happen at `horizonBlock`, so the
 * comparison is between two views of the same state. A chain read that fails
 * withholds the figure with `CHAIN_READ_FAILED`; a read that answers differently
 * withholds it with `CROSS_CHECK_DISAGREED`, carrying both numbers.
 */
export async function computeAgentCredit(
  reads: CreditReads,
  chain: CreditChainReader,
  input: AgentCreditInput,
): Promise<AgentCreditView> {
  if (input.horizonBlock === null) {
    return withheld(unavailable("INDEX_NOT_PRIMED", "the index has never ticked, so there is no block to derive a figure at"));
  }
  const block = input.horizonBlock;

  const rebuilt = await rebuildWitness(reads, input.agent, input.asset);
  if (!rebuilt.ok) return withheld(rebuilt.unavailable);
  const { witness, summary } = rebuilt;

  let blockTime: bigint;
  let governance: { baseline: bigint; growthFactorBps: bigint };
  let onChainCommitment: { root: string; count: number };
  try {
    [blockTime, governance, onChainCommitment] = await Promise.all([
      chain.blockTimestamp(block),
      chain.governance(block),
      chain.historyCommitment(input.agent, input.asset, block),
    ]);
  } catch (error) {
    return withheld(unavailable("CHAIN_READ_FAILED", `the chain could not be read at block ${block}: ${describe(error)}`));
  }

  let recomputed: bigint;
  try {
    recomputed = input.delinquent
      ? 0n
      : creditLimit(witness.history, witness.bonds, {
          asset: input.asset,
          baseline: governance.baseline,
          growthFactorBps: governance.growthFactorBps,
          evaluatedAt: blockTime,
        });
  } catch (error) {
    if (error instanceof HistoryTooLong || error instanceof TooManyCounterparties) {
      return withheld(unavailable("WITNESS_OUT_OF_BOUNDS", error.message));
    }
    throw error;
  }

  const computedAt: ComputedAt = { blockNumber: block, blockTime: blockTime.toString() };
  const witnessSummary: WitnessSummary = {
    ...summary,
    commitmentMatchesChain:
      onChainCommitment.root === summary.commitment.root && onChainCommitment.count === summary.commitment.count,
  };

  let onChainLimit: bigint;
  let onChainOpen: bigint;
  let onChainHeadroom: bigint;
  try {
    [onChainLimit, onChainOpen, onChainHeadroom] = await Promise.all([
      chain.creditLimit(input.agent, input.asset, witness, block),
      chain.assetOpen(input.agent, input.asset, block),
      chain.headroom(input.agent, input.asset, witness, block),
    ]);
  } catch (error) {
    const why = unavailable(
      "CHAIN_READ_FAILED",
      `TabBook could not be read at block ${block}: ${describe(error)}`,
      { recomputed },
    );
    return {
      creditLimit: { value: null, basis: CREDIT_BASIS, computedAt, witness: witnessSummary, crossCheck: null, unavailable: why },
      headroom: { value: null, basis: HEADROOM_BASIS, openTab: null, crossCheck: null, unavailable: why },
    };
  }

  if (onChainLimit !== recomputed) {
    const why = unavailable(
      "CROSS_CHECK_DISAGREED",
      `this service recomputed ${recomputed} and TabBook.creditLimit returned ${onChainLimit} at block ${block}, so neither is served as the value`,
      { recomputed, onChain: onChainLimit },
    );
    return {
      creditLimit: { value: null, basis: CREDIT_BASIS, computedAt, witness: witnessSummary, crossCheck: null, unavailable: why },
      headroom: {
        value: null,
        basis: HEADROOM_BASIS,
        openTab: onChainOpen.toString(),
        crossCheck: null,
        unavailable: { code: "CROSS_CHECK_DISAGREED", message: "headroom is derived from the Credit Limit, which the chain disagreed with" },
      },
    };
  }

  const recomputedHeadroom = recomputed > onChainOpen ? recomputed - onChainOpen : 0n;
  const headroom: HeadroomView =
    recomputedHeadroom === onChainHeadroom
      ? {
          value: recomputedHeadroom.toString(),
          basis: HEADROOM_BASIS,
          openTab: onChainOpen.toString(),
          crossCheck: { read: "TabBook.headroom(agent, asset, witness)", onChain: onChainHeadroom.toString(), agrees: true },
          unavailable: null,
        }
      : {
          value: null,
          basis: HEADROOM_BASIS,
          openTab: onChainOpen.toString(),
          crossCheck: null,
          unavailable: unavailable(
            "CROSS_CHECK_DISAGREED",
            `this service derived headroom ${recomputedHeadroom} and TabBook.headroom returned ${onChainHeadroom} at block ${block}`,
            { recomputed: recomputedHeadroom, onChain: onChainHeadroom },
          ),
        };

  return {
    creditLimit: {
      value: recomputed.toString(),
      basis: CREDIT_BASIS,
      computedAt,
      witness: witnessSummary,
      crossCheck: { read: "TabBook.creditLimit(agent, asset, witness)", onChain: onChainLimit.toString(), agrees: true },
      unavailable: null,
    },
    headroom,
  };
}

// --------------------------------------------------------------- Bond ledgers

/** A Service's Bond ledger in one Asset, derived from events and checked against `Bond.ledgerOf`. */
export interface ServiceBondView extends BondLedgerRow {
  readonly basis: string;
  readonly computedAt: { readonly blockNumber: number } | null;
  /**
   * The chain's own four figures and its free amount, **as decimal strings**.
   *
   * Strings rather than `bigint`s because this crosses an HTTP boundary: `c.json`
   * calls `JSON.stringify`, which throws on a `bigint` rather than coercing it, so a
   * raw figure here answered 500 on every Service that had a Bond. It is also the
   * read layer's own rule, that every integer which could lose precision leaves as
   * text.
   */
  readonly crossCheck: {
    readonly read: string;
    readonly onChain: { readonly staked: string; readonly reserved: string; readonly slashed: string; readonly released: string; readonly free: string };
    readonly agrees: true;
  } | null;
  readonly unavailable: CreditUnavailable | null;
}

export const BOND_BASIS =
  "the four ledger figures replayed from Bond's own events (BondFunded, BondReserved, BondReleased, the two slashes, WithdrawalReleased) at the index horizon block, with free as staked less reserved, slashed, and released; served only where Bond.ledgerOf at that block agrees on all four";

const figuresOf = (row: BondLedgerRow): LedgerFigures => ({
  staked: BigInt(row.staked),
  reserved: BigInt(row.reserved),
  slashed: BigInt(row.slashed),
  released: BigInt(row.released),
});

const sameFigures = (left: LedgerFigures, right: LedgerFigures): boolean =>
  left.staked === right.staked &&
  left.reserved === right.reserved &&
  left.slashed === right.slashed &&
  left.released === right.released;

/**
 * Checks each derived ledger against `Bond.ledgerOf` at the horizon block.
 *
 * A ledger the chain disagrees with is served with its figures blanked and both
 * sides named; free Bond in particular is what a Provisional Clearing is covered
 * by, and a wrong figure there would misreport whether headroom can be restored.
 */
export async function verifyBondLedgers(
  chain: CreditChainReader,
  rows: readonly BondLedgerRow[],
  horizonBlock: number | null,
): Promise<readonly ServiceBondView[]> {
  return Promise.all(
    rows.map(async (row): Promise<ServiceBondView> => {
      if (horizonBlock === null) {
        return {
          ...row,
          basis: BOND_BASIS,
          computedAt: null,
          crossCheck: null,
          unavailable: unavailable("INDEX_NOT_PRIMED", "the index has never ticked, so there is no block to check the ledger at"),
        };
      }
      let onChain: LedgerFigures;
      try {
        onChain = await chain.bondLedger(row.party, row.asset, horizonBlock);
      } catch (error) {
        return {
          ...row,
          basis: BOND_BASIS,
          computedAt: { blockNumber: horizonBlock },
          crossCheck: null,
          unavailable: unavailable("CHAIN_READ_FAILED", `Bond.ledgerOf could not be read at block ${horizonBlock}: ${describe(error)}`),
        };
      }
      const derived = figuresOf(row);
      const free = onChain.staked - onChain.reserved - onChain.slashed - onChain.released;
      if (!sameFigures(derived, onChain)) {
        return {
          ...row,
          basis: BOND_BASIS,
          computedAt: { blockNumber: horizonBlock },
          crossCheck: null,
          unavailable: unavailable(
            "CROSS_CHECK_DISAGREED",
            `the events replay to staked ${derived.staked}, reserved ${derived.reserved}, slashed ${derived.slashed}, released ${derived.released}, while Bond.ledgerOf at block ${horizonBlock} holds staked ${onChain.staked}, reserved ${onChain.reserved}, slashed ${onChain.slashed}, released ${onChain.released}`,
          ),
        };
      }
      return {
        ...row,
        basis: BOND_BASIS,
        computedAt: { blockNumber: horizonBlock },
        crossCheck: {
          read: "Bond.ledgerOf(party, asset)",
          onChain: {
            staked: onChain.staked.toString(),
            reserved: onChain.reserved.toString(),
            slashed: onChain.slashed.toString(),
            released: onChain.released.toString(),
            free: free.toString(),
          },
          agrees: true,
        },
        unavailable: null,
      };
    }),
  );
}
