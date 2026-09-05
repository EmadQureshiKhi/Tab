/**
 * The Bond ledger, as the Dashboard reads it.
 *
 * A Bond is posted **per Asset** and accounted in an isolated balance, with
 * coverage checked per Asset and never across Assets. One Asset's ledger carries
 * four recorded figures and one derived one:
 *
 * | Figure | Meaning |
 * | --- | --- |
 * | `staked` | funded by a proven deposit |
 * | `reserved` | covering Provisional Clearings that are still live |
 * | `slashed` | cumulative and monotonic; it never goes back down |
 * | `released` | withdrawal-eligible, awaiting Writability |
 * | derived `free` | `staked - reserved - slashed - released` |
 *
 * That formula is the whole derivation, and it is applied within one Asset only.
 * There is deliberately no function here that sums anything across Assets: a
 * single pooled Bond figure would misdescribe the accounting, because free Bond
 * in one Asset can never cover a Provisional Clearing in another.
 *
 * Requirements: 24.10
 */

import type { AssetUnit } from "./format";

/** One Asset's Bond ledger for one bonded party. */
export interface BondAssetLedger {
  readonly asset: AssetUnit;
  readonly stakedBaseUnits: bigint;
  readonly reservedBaseUnits: bigint;
  readonly slashedBaseUnits: bigint;
  readonly releasedBaseUnits: bigint;
  /**
   * The free amount as the contract reports it. Supply it where a view has read
   * `freeOf` directly; omit it and the derivation is used.
   */
  readonly freeBaseUnits?: bigint | undefined;
}

/** `staked - reserved - slashed - released`, for one Asset. */
export function derivedFreeBaseUnits(ledger: BondAssetLedger): bigint {
  return (
    ledger.stakedBaseUnits -
    ledger.reservedBaseUnits -
    ledger.slashedBaseUnits -
    ledger.releasedBaseUnits
  );
}

/** The free amount as reported, falling back to the derivation. */
export function freeBaseUnits(ledger: BondAssetLedger): bigint {
  return ledger.freeBaseUnits ?? derivedFreeBaseUnits(ledger);
}

/**
 * Whether the four recorded figures can coexist.
 *
 * A negative derived free means the reads disagree with each other, which is a
 * fact worth surfacing rather than clamping away.
 */
export function isLedgerConsistent(ledger: BondAssetLedger): boolean {
  return derivedFreeBaseUnits(ledger) >= 0n;
}

/** One part of a Bond ledger, ready to be both a bar segment and a legend row. */
export interface BondSegment {
  readonly key: "reserved" | "slashed" | "released" | "free";
  readonly label: string;
  readonly baseUnits: bigint;
  /** A checked design-token fill. */
  readonly fillClassName: string;
  /** One clause explaining what the figure is, for the legend. */
  readonly meaning: string;
}

/**
 * The four parts of one Asset's ledger, in the order they leave `staked`.
 *
 * The colours are the clearing tokens of the states that move the money, which
 * is a real correspondence rather than a palette convenience: an amount is
 * reserved to cover an *applied* clearing, released when one is *confirmed*, and
 * slashed when one is *reversed*. Free stake carries the accent.
 */
export function bondSegments(ledger: BondAssetLedger): readonly BondSegment[] {
  return [
    {
      key: "reserved",
      label: "Reserved",
      baseUnits: ledger.reservedBaseUnits,
      fillClassName: "bg-clearing-applied",
      meaning: "covering Provisional Clearings that are still live",
    },
    {
      key: "slashed",
      label: "Slashed",
      baseUnits: ledger.slashedBaseUnits,
      fillClassName: "bg-clearing-reversed",
      meaning: "cumulative; taken for a clearing that reversed or a Settlement that was superseded",
    },
    {
      key: "released",
      label: "Released",
      baseUnits: ledger.releasedBaseUnits,
      fillClassName: "bg-clearing-confirmed",
      meaning: "withdrawal-eligible, awaiting Writability",
    },
    {
      key: "free",
      label: "Free",
      baseUnits: freeBaseUnits(ledger),
      // Free Bond is the largest segment on almost every ledger, so it is drawn in
      // the quietest colour of the four. The accent token filled the whole bar at
      // full saturation and made a healthy Bond the brightest object on the page,
      // which is the opposite of what the bar is for: the eye should go to what has
      // been reserved or slashed, not to what is untouched.
      fillClassName: "bg-teal-600/45 dark:bg-teal-400/40",
      meaning: "staked minus reserved, slashed, and released; what can cover the next clearing",
    },
  ];
}
