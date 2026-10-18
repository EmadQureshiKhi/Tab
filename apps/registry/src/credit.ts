/**
 * `LimitLib`, restated in TypeScript exactly, and the history commitment it is
 * checked against.
 *
 * ## Why restate it, and why exactly
 *
 * `LimitLib.creditLimit` is `internal pure`: it reads no storage and makes no
 * external call. That purity is the verification story rather than a style
 * preference, because it lets a third party recompute the same number off chain
 * from published history and compare it against the on-chain read. This module is
 * that third party. Every constant, every filter, every division, and the order of
 * every operation below is the library's, including the two places its own
 * documentation warns a reimplementation goes wrong: the per-record weighted value
 * is floored before bucketing, and the growth factor and the bond cap are each
 * applied once, never inside a loop. `credit-service.ts` cross-checks every served
 * figure against `TabBook.creditLimit` over `eth_call` at the same block before it
 * leaves this service, so a restatement that drifted from the library withholds
 * the figure rather than serving a wrong one.
 *
 * Everything is a `bigint`. USDC amounts are 6-decimal integers that routinely
 * exceed what a double represents exactly, and a limit through a float is a wrong
 * number no later check can detect.
 *
 * ## The commitment
 *
 * `TabBook` folds each committed `SettlementRecord` into a rolling keccak root, and
 * `creditLimit` reverts unless the witness it is handed folds to the same root.
 * {@link foldRoot} is that fold, field for field, so a witness rebuilt from
 * `HistoryExtended` rows can be checked here before an `eth_call` is spent on it.
 */

import { AbiCoder, keccak256 } from "ethers";

// ------------------------------------------------------------------ constants
//
// Each one is `LimitLib`'s, under its own name.

/** One hundred percent in basis points. */
export const BPS = 10_000n;
/** Share of the counterparty Bond sum a Credit Limit may reach. */
export const BOND_CAP_BPS = 9_500n;
/** Largest share of the returned Credit Limit one counterparty may contribute. */
export const CONCENTRATION_BPS = 2_500n;
/** Weight a Settlement carries on the day it settled. */
export const MIN_WEIGHT_BPS = 2_500n;
/** Weight a Settlement carries once it has aged the full ramp. */
export const MAX_WEIGHT_BPS = 10_000n;
/** Span of the age ramp in whole days. */
export const RAMP_DAYS = 30n;
/** Growth in basis points earned across the whole ramp. */
export const RAMP_SPAN_BPS = 7_500n;
/** Distinct contributing counterparties required before any growth is granted. */
export const MIN_COUNTERPARTIES = 3;
/** Largest number of distinct contributing counterparties one computation may carry. */
export const MAX_COUNTERPARTIES = 32;
/** Largest number of Settlement records one computation may carry. */
export const MAX_HISTORY = 512;
/** Reciprocal of {@link CONCENTRATION_BPS} as a whole number: the `4` in the closed form. */
export const CONCENTRATION_DIVISOR = BPS / CONCENTRATION_BPS;

const SECONDS_PER_DAY = 86_400n;

/** The commitment of an empty history. */
export const ZERO_ROOT = `0x${"00".repeat(32)}`;

// -------------------------------------------------------------------- inputs

/** `LimitLib.SettlementRecord`, as committed by `TabBook` and carried by `HistoryExtended`. */
export interface SettlementRecord {
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: bigint;
  readonly settledAt: bigint;
  /** Zero means no Metered Delivery was ever recorded. */
  readonly firstDeliveryAt: bigint;
  readonly curated: boolean;
  readonly bonded: boolean;
}

/** `LimitLib.BondEntry`. */
export interface BondEntry {
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: bigint;
}

/** `LimitLib.Params`. */
export interface LimitParams {
  readonly asset: string;
  readonly baseline: bigint;
  readonly growthFactorBps: bigint;
  readonly evaluatedAt: bigint;
}

/** `TabBook.LimitWitness`: what `creditLimit` is called with. */
export interface LimitWitness {
  readonly history: readonly SettlementRecord[];
  readonly bonds: readonly BondEntry[];
}

/** `LimitLib.HistoryTooLong`, as a thrown error rather than a revert. */
export class HistoryTooLong extends Error {
  // A declared field rather than a parameter property, because this package builds
  // with `erasableSyntaxOnly` and a parameter property emits runtime code.
  readonly length: number;

  constructor(length: number) {
    super(`credit: the history carries ${length} records, past the ${MAX_HISTORY} one computation may evaluate`);
    this.length = length;
  }
}

/** `LimitLib.TooManyCounterparties`. */
export class TooManyCounterparties extends Error {
  readonly count: number;

  constructor(count: number) {
    super(
      `credit: the history contributes ${count} distinct counterparties, past the ${MAX_COUNTERPARTIES} one computation may evaluate`,
    );
    this.count = count;
  }
}

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

// ------------------------------------------------------------- age weighting

/**
 * `LimitLib.ageWeightBps`: `2500 + 7500 * min(ageDays, 30) / 30`, floored on the
 * day count, and the day-0 weight for an evaluation time at or behind the
 * settlement time.
 */
export function ageWeightBps(settledAt: bigint, evaluatedAt: bigint): bigint {
  if (evaluatedAt <= settledAt) return MIN_WEIGHT_BPS;
  const ageDays = (evaluatedAt - settledAt) / SECONDS_PER_DAY;
  if (ageDays >= RAMP_DAYS) return MAX_WEIGHT_BPS;
  return MIN_WEIGHT_BPS + (RAMP_SPAN_BPS * ageDays) / RAMP_DAYS;
}

// ------------------------------------------------------------------ bond cap

/**
 * `LimitLib.bondCap`: the sum of the entries in the Asset, then one scaling
 * division over the whole sum. Entries in another Asset are skipped, never
 * converted.
 */
export function bondCap(bonds: readonly BondEntry[], asset: string): bigint {
  let sum = 0n;
  for (const bond of bonds) {
    if (!same(bond.asset, asset)) continue;
    sum += bond.amount;
  }
  return (sum * BOND_CAP_BPS) / BPS;
}

// -------------------------------------------------------------- credit limit

/**
 * `LimitLib.creditLimit`, step for step.
 *
 * 1. Filter and bucket weighted value per counterparty.
 * 2. The bond cap, computed on every path.
 * 3. Below three distinct contributing counterparties, the bond-capped baseline.
 * 4. Growth contributions, one division per counterparty.
 * 5. The concentration cap, in closed form.
 * 6. The smallest of the three.
 *
 * @throws HistoryTooLong past 512 records, TooManyCounterparties past 32, exactly
 * where the library reverts. Neither is caught here: a witness that the contract
 * would refuse must not be silently truncated into a figure the contract would
 * never return.
 */
export function creditLimit(
  history: readonly SettlementRecord[],
  bonds: readonly BondEntry[],
  p: LimitParams,
): bigint {
  if (history.length > MAX_HISTORY) throw new HistoryTooLong(history.length);

  // --- Step 1: filter and bucket weighted value per counterparty --------------------
  const ids: string[] = [];
  const buckets: bigint[] = [];

  for (const s of history) {
    if (!same(s.asset, p.asset)) continue; // a Credit Limit is per Asset
    if (!s.curated) continue; // curated when it settled
    if (!s.bonded) continue; // and holding free stake when it settled
    // Zero is the sentinel for "no Metered Delivery was ever recorded", checked on
    // its own because a zero would otherwise pass the strictly-earlier test.
    if (s.firstDeliveryAt === 0n) continue;
    if (s.firstDeliveryAt >= s.settledAt) continue; // delivery strictly before settlement

    // Floored per record, before bucketing: a bucket is a sum of floored terms.
    const weighted = (s.amount * ageWeightBps(s.settledAt, p.evaluatedAt)) / BPS;
    // A record that weighs nothing must not create a counterparty slot, or dust would
    // count toward the three-counterparty threshold.
    if (weighted === 0n) continue;

    let slot = ids.findIndex((id) => same(id, s.serviceId));
    if (slot === -1) {
      if (ids.length === MAX_COUNTERPARTIES) throw new TooManyCounterparties(ids.length + 1);
      slot = ids.length;
      ids.push(s.serviceId);
      buckets.push(0n);
    }
    buckets[slot] = (buckets[slot] ?? 0n) + weighted;
  }

  // --- Step 2: the bond cap applies on every path ------------------------------------
  const cap = bondCap(bonds, p.asset);

  // --- Step 3: fewer than three counterparties, so baseline only ---------------------
  if (ids.length < MIN_COUNTERPARTIES) {
    return p.baseline < cap ? p.baseline : cap;
  }

  // --- Step 4: growth contributions, one division per counterparty -------------------
  const contributions = buckets.map((bucket) => (bucket * p.growthFactorBps) / BPS);
  let total = 0n;
  for (const contribution of contributions) total += contribution;
  const uncapped = p.baseline + total;

  // --- Step 5: the concentration-capped value ----------------------------------------
  const capped = concentrationCapped(contributions, p.baseline, total);

  // --- Step 6: the smallest of the three ---------------------------------------------
  let limit = uncapped;
  if (capped < limit) limit = capped;
  if (cap < limit) limit = cap;
  return limit;
}

/**
 * `LimitLib._concentrationCapped`: the fixed point of
 * `L = baseline + sum_i min(c_i, L / 4)` in closed form. With the contributions
 * sorted descending and `k` of them at the cap, `L_k = 4 * (baseline + tail_k) / (4 - k)`
 * for `k` in `0..3`; the first feasible candidate is the answer and the smallest
 * candidate is the fallback for a rounding tie. The multiplication by 4 precedes
 * the division, as the library's rounding convention fixes.
 */
function concentrationCapped(contributions: readonly bigint[], baseline: bigint, total: bigint): bigint {
  const c = [...contributions].sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
  const n = BigInt(c.length);

  let prefix = 0n;
  let best: bigint | undefined;
  const maxCapped = CONCENTRATION_DIVISOR - 1n;
  for (let k = 0n; k <= maxCapped && k <= n; k += 1n) {
    if (k > 0n) prefix += c[Number(k) - 1] ?? 0n;
    const tail = total - prefix;
    const candidate = (CONCENTRATION_DIVISOR * (baseline + tail)) / (CONCENTRATION_DIVISOR - k);
    if (best === undefined || candidate < best) best = candidate;

    const topAtCap = k === 0n || (c[Number(k) - 1] ?? 0n) * CONCENTRATION_DIVISOR >= candidate;
    const restUnderCap = k === n || (c[Number(k)] ?? 0n) * CONCENTRATION_DIVISOR <= candidate;
    if (topAtCap && restUnderCap) return candidate;
  }
  return best ?? baseline;
}

// ------------------------------------------------------------ the commitment

const CODER = AbiCoder.defaultAbiCoder();

/**
 * `TabBook._fold`: `keccak256(abi.encode(previousRoot, serviceId, asset, amount,
 * settledAt, firstDeliveryAt, curated, bonded))`. Every field of the
 * record is bound, which is what makes the four filters above unforgeable through
 * the witness.
 */
export function foldRoot(previousRoot: string, record: SettlementRecord): string {
  return keccak256(
    CODER.encode(
      ["bytes32", "bytes32", "address", "uint128", "uint64", "uint64", "bool", "bool"],
      [
        previousRoot,
        record.serviceId,
        record.asset,
        record.amount,
        record.settledAt,
        record.firstDeliveryAt,
        record.curated,
        record.bonded,
      ],
    ),
  ).toLowerCase();
}

/** The rolling commitment over an ordered history, as `TabBook.historyCommitment` reports it. */
export function commitmentOf(history: readonly SettlementRecord[]): { root: string; count: number } {
  let root = ZERO_ROOT;
  for (const record of history) root = foldRoot(root, record);
  return { root, count: history.length };
}

// --------------------------------------------------------------- the curve

/** One point of {@link creditCurve}: the limit `LimitLib` returns at `at` over the history settled by then. */
export interface CurvePoint {
  /** Unix seconds. */
  readonly at: bigint;
  readonly limit: bigint;
  /** How many of the history's records had settled by `at`. */
  readonly settlements: number;
  /**
   * `start` just before the first Settlement, `settlement` right after one,
   * `aging` between them, where the limit moves only because the repayments
   * it already counts have aged, and `now` at the evaluation time.
   */
  readonly kind: "start" | "settlement" | "aging" | "now";
}

/** Points a curve may have at most, so a long history still draws as a line rather than a payload. */
export const CURVE_MAX_POINTS = 96;

/**
 * The Credit Limit over time: {@link creditLimit} evaluated at each Settlement and
 * at evenly spaced moments between the first one and `now`, each time over the
 * records that had settled by then.
 *
 * It is the same function the contract runs, called with the times moved, so the
 * curve is not an estimate of the limit's history: every point is exactly what
 * `LimitLib` would have returned at that moment for that history. One input is
 * today's, not the past's, and the caller must say so: `bonds` are the free
 * stakes as they stand at `now`, because `LimitLib` reads stake rather than
 * history and the index keeps no stake per past block.
 *
 * A record only counts once it has settled, and growth ramps with each
 * repayment's age (`ageWeightBps`), which is why the aging points matter: an
 * Agent that stops paying still sees its limit rise for a while as what it
 * already repaid matures.
 */
export function creditCurve(
  history: readonly SettlementRecord[],
  bonds: readonly BondEntry[],
  params: Omit<LimitParams, "evaluatedAt">,
  now: bigint,
  maxPoints: number = CURVE_MAX_POINTS,
): readonly CurvePoint[] {
  const settled = [...history].filter((record) => record.settledAt <= now).sort((a, b) => (a.settledAt < b.settledAt ? -1 : a.settledAt > b.settledAt ? 1 : 0));
  const at = (time: bigint, kind: CurvePoint["kind"]): CurvePoint => {
    const prefix = settled.filter((record) => record.settledAt <= time);
    return { at: time, limit: creditLimit(prefix, bonds, { ...params, evaluatedAt: time }), settlements: prefix.length, kind };
  };

  const first = settled[0];
  if (first === undefined) return [at(now, "now")];

  // The most recent Settlements, when there are more than the curve can draw.
  const keptSettlements = settled.slice(-Math.max(1, Math.floor(maxPoints / 2)));
  const times = new Map<bigint, CurvePoint["kind"]>();
  times.set(first.settledAt - 1n, "start");
  for (const record of keptSettlements) times.set(record.settledAt, "settlement");

  const span = now - first.settledAt;
  const agingSlots = Math.max(0, maxPoints - times.size - 1);
  if (span > 0n && agingSlots > 0) {
    for (let i = 1n; i <= BigInt(agingSlots); i += 1n) {
      const time = first.settledAt + (span * i) / (BigInt(agingSlots) + 1n);
      if (!times.has(time)) times.set(time, "aging");
    }
  }
  times.set(now, "now");

  return [...times.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([time, kind]) => at(time, kind));
}
