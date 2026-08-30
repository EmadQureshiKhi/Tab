/**
 * The five clearing states, as this service reports them.
 *
 * The words are the Dashboard's words, taken from
 * `apps/app/components/custom-ui/clearing-state.ts`. There is exactly one
 * vocabulary difference between the contract and the presentation, it is already
 * documented there, and this file agrees with it rather than inventing a second
 * set of names:
 *
 * | Contract event | State reported here |
 * | --- | --- |
 * | `ProvisionalClearingApplied` | `provisional` |
 * | `ProvisionalClearingConfirmed` | `confirmed` |
 * | `ProvisionalClearingReversed` | `reversed` |
 * | `ProvisionalClearingDeclined` | `declined` |
 * | `SettlementSuperseded` | `superseded` |
 *
 * **`declined` is not a failed Settlement.** It says free Bond did not cover an
 * observation, so the Open Tab was left alone until the Verified Settlement
 * arrives. The Settlement itself is unaffected. A reader who collapses `declined`
 * into a failure bucket is reporting something the chain never said, which is why
 * the state is carried through whole and never folded into another one.
 *
 * ## What this file is, and what it is not
 *
 * It is a reduction over rows the indexer already stored, not a reinterpretation
 * of them. Every raw event row survives untouched in its own table; this returns
 * the latest state of a clearing for a caller that wants one answer instead of a
 * lifecycle. The precedence is the state machine's own ordering — a clearing may
 * only move forwards — so the reduction adds no rule the contract does not
 * already enforce.
 *
 * `declined` is deliberately absent from the precedence ladder. A decline creates
 * no clearing: `ProvisionalClearingDeclined` carries no `clearingId`, because
 * there is nothing to identify. It is keyed by its Source Chain transaction hash
 * and reported on its own.
 *
 * Requirements: 12.6, 24.4, 15.7
 */

/** The five states, in the order the lifecycle introduces them. */
export const CLEARING_STATES = [
  "provisional",
  "confirmed",
  "reversed",
  "declined",
  "superseded",
] as const;

export type ClearingState = (typeof CLEARING_STATES)[number];

/** The event that puts a clearing into each state. */
export const CLEARING_STATE_EVENT: Readonly<Record<ClearingState, string>> = {
  provisional: "ProvisionalClearingApplied",
  confirmed: "ProvisionalClearingConfirmed",
  reversed: "ProvisionalClearingReversed",
  declined: "ProvisionalClearingDeclined",
  superseded: "SettlementSuperseded",
};

/**
 * How far along the lifecycle each state sits. Higher wins a reduction.
 *
 * `superseded` outranks `confirmed` because it is what happens *to* a confirmed
 * clearing. `reversed` and `confirmed` are mutually exclusive on chain — the
 * reversal crank only fires on an unconfirmed clearing — so their relative order
 * is never exercised by a well-formed stream, and a stream that does exercise it
 * is reporting a contract bug that the raw rows still record in full.
 */
const PRECEDENCE: Readonly<Record<Exclude<ClearingState, "declined">, number>> = {
  provisional: 1,
  confirmed: 2,
  reversed: 3,
  superseded: 4,
};

/** One state observation for a clearing, as the indexer stored it. */
export interface ClearingObservation {
  readonly state: Exclude<ClearingState, "declined">;
  readonly blockNumber: number;
  readonly logIndex: number;
}

/**
 * The latest state of one clearing, or `null` when nothing has been observed.
 *
 * Ties on lifecycle position are broken by chain order, so two observations of the
 * same rank resolve to the later log rather than to whichever row the database
 * happened to return first.
 */
export function latestClearingState(
  observations: readonly ClearingObservation[],
): ClearingObservation | null {
  let latest: ClearingObservation | null = null;
  for (const observation of observations) {
    if (latest === null) {
      latest = observation;
      continue;
    }
    const rank = PRECEDENCE[observation.state] - PRECEDENCE[latest.state];
    if (rank > 0) {
      latest = observation;
      continue;
    }
    if (rank < 0) continue;
    if (
      observation.blockNumber > latest.blockNumber ||
      (observation.blockNumber === latest.blockNumber && observation.logIndex > latest.logIndex)
    ) {
      latest = observation;
    }
  }
  return latest;
}

/** True once a clearing can no longer change. */
export const isTerminalClearingState = (state: ClearingState): boolean => state !== "provisional";

/** Runtime narrowing for a value arriving from outside the process. */
export const isClearingState = (value: unknown): value is ClearingState =>
  typeof value === "string" && (CLEARING_STATES as readonly string[]).includes(value);
