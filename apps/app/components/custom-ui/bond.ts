/**
 * The Bond ledger, as the Dashboard reads it.
 *
 * A Bond is escrowed **per Asset** in `Bond`, and read per Asset and never
 * across Assets. One Asset's ledger carries two recorded figures and one
 * derived one:
 *
 * | Figure | Meaning |
 * | --- | --- |
 * | `staked` | every deposit the Service has paid into escrow, summed |
 * | `withdrawn` | every withdrawal paid back out, summed |
 * | derived `free` | `staked - withdrawn`, the stake still held |
 *
 * That subtraction is the whole derivation, and it is applied within one Asset
 * only. `free` is the figure `LimitLib` reads when it caps an Agent's Credit
 * Limit at 95% of a counterparty's stake, so it is the one that matters, and it
 * is what the meter draws. There is deliberately no function here that sums
 * anything across Assets: a single pooled Bond figure would misdescribe the
 * accounting, because stake in one Asset never backs credit in another.
 */

import type { AssetUnit } from "./format";

/** One Asset's Bond ledger for one Service. */
export interface BondAssetLedger {
  readonly asset: AssetUnit;
  readonly stakedBaseUnits: bigint;
  readonly withdrawnBaseUnits: bigint;
  /**
   * The free amount as the contract reports it. Supply it where a view has read
   * `Bond.freeOf` directly; omit it and the derivation is used.
   */
  readonly freeBaseUnits?: bigint | undefined;
}

/** `staked - withdrawn`, for one Asset. */
export function derivedFreeBaseUnits(ledger: BondAssetLedger): bigint {
  return ledger.stakedBaseUnits - ledger.withdrawnBaseUnits;
}

/** The free amount as reported, falling back to the derivation. */
export function freeBaseUnits(ledger: BondAssetLedger): bigint {
  return ledger.freeBaseUnits ?? derivedFreeBaseUnits(ledger);
}

/**
 * Whether the two recorded figures can coexist.
 *
 * `Bond` pays a withdrawal only out of stake it holds, so withdrawn can never
 * exceed staked on chain. A negative derived free therefore means two reads
 * disagree with each other, which is a fact worth surfacing rather than
 * clamping away.
 */
export function isLedgerConsistent(ledger: BondAssetLedger): boolean {
  return derivedFreeBaseUnits(ledger) >= 0n;
}

/** One part of a Bond ledger, ready to be both a bar segment and a legend row. */
export interface BondSegment {
  readonly key: "withdrawn" | "free";
  readonly label: string;
  readonly baseUnits: bigint;
  /** A checked design-token fill. */
  readonly fillClassName: string;
  /** One clause explaining what the figure is, for the legend. */
  readonly meaning: string;
}

/**
 * The two parts of one Asset's ledger, in the order they leave `staked`.
 *
 * Withdrawn stake is drawn in the muted status token because it is money that
 * has already left and backs nothing. Free stake carries the teal, faded: it is
 * the larger segment on almost every ledger, and at full saturation a healthy
 * Bond became the brightest object on the page, which is the opposite of what
 * the bar is for. The eye should go to what has been taken out, not to what is
 * still held.
 */
export function bondSegments(ledger: BondAssetLedger): readonly BondSegment[] {
  return [
    {
      key: "withdrawn",
      label: "Withdrawn",
      baseUnits: ledger.withdrawnBaseUnits,
      fillClassName: "bg-status-muted",
      meaning: "paid back out of escrow; it backs nothing",
    },
    {
      key: "free",
      label: "Free",
      baseUnits: freeBaseUnits(ledger),
      fillClassName: "bg-teal-600/45 dark:bg-teal-400/40",
      meaning: "staked minus withdrawn; what caps the Credit Limit of every Agent that settled here",
    },
  ];
}
