/**
 * The batch planner (R9.1, R9.4, R16.6, R16.7, design section 8.5).
 *
 * Groups READY Settlements per chainKey into batches that satisfy three bounds at
 * once, and the third is the one that is easy to forget:
 *
 * 1. at most `WATCHER_BATCH_MAX_PROOFS` members, which mirrors the contract's
 *    `MAX_BATCH_PROOFS` of 10 and is a blast-radius bound rather than a gas one;
 * 2. a block-height span of at most `WATCHER_BATCH_MAX_SPAN`, mirroring the
 *    contract's `MAX_BATCH_SPAN_BLOCKS` of 1000, which the contract checks before
 *    it verifies anything;
 * 3. attestation-window adjacency. The batch proof endpoint builds one digest
 *    chain from the endpoint below the lowest member to the endpoint above the
 *    highest, so two members whose windows do not touch have a gap no chain can
 *    bridge, and the pinned library's `mergeProofs` refuses exactly that input.
 *    "Touch" means the next member's lower endpoint is at or below the current
 *    batch's upper endpoint, which covers members in one window and members in
 *    adjacent windows that share an endpoint.
 *
 * Bounds are read from `get_attestation_bounds`, one keyless call per distinct
 * height, and a member whose height is not yet covered by the attested frontier is
 * deferred rather than planned: the contract would refuse it and the proof for it
 * cannot be built yet.
 *
 * The planner is pure apart from the bounds reads, which are injected, so it is
 * tested against a fake and checked against the live precompile in the same file.
 *
 * Requirements: 9.1, 9.4, 9.6, 16.6, 16.7
 */

import { err, ok, type ChainKey, type Result, type TabError } from "@tabai/shared";

import type { AttestationBounds } from "./clearing.js";

/** What the planner needs to know about one READY row. */
export interface BatchCandidate {
  readonly replayKey: string;
  readonly chainKey: ChainKey;
  readonly blockHeight: bigint;
  readonly sourceTxHash: string;
}

/** One planned batch, members in ascending height order. */
export interface BatchPlan {
  readonly chainKey: ChainKey;
  readonly members: readonly BatchCandidate[];
  readonly lowestHeight: bigint;
  readonly highestHeight: bigint;
  /** The endpoint below the lowest member, the batch proof's chain start. */
  readonly lowerEndpoint: bigint;
  /** The endpoint at or above the highest member, the batch proof's chain end. */
  readonly upperEndpoint: bigint;
}

/** Why a candidate was left out of every plan this pass. */
export type DeferralReason =
  /** the attested frontier does not cover the height yet */
  | "NOT_YET_ATTESTED"
  /** the bounds read failed; nothing is known about the window */
  | "BOUNDS_UNREADABLE";

export interface DeferredCandidate {
  readonly candidate: BatchCandidate;
  readonly reason: DeferralReason;
  readonly error: TabError | undefined;
}

export interface BatchPlanning {
  readonly plans: readonly BatchPlan[];
  readonly deferred: readonly DeferredCandidate[];
}

/** The one ChainInfo read the planner makes. */
export interface BoundsReader {
  bounds(chainKey: bigint, height: bigint): Promise<Result<AttestationBounds>>;
}

export interface BatchLimits {
  /** At most this many members per batch. The contract refuses more than 10. */
  readonly maxProofs: number;
  /** At most this many blocks between the lowest and highest member. */
  readonly maxSpan: number;
}

/** The contract's own bounds, mirrored so a misconfiguration is refused here. */
export const CONTRACT_BATCH_LIMITS: BatchLimits = { maxProofs: 10, maxSpan: 1000 };

/**
 * Plans batches for every candidate that can be planned.
 *
 * Candidates are grouped by chainKey and sorted by height; a batch is grown
 * greedily while all three bounds hold, and closed otherwise. Greedy is correct
 * here because every bound is monotonic in height: once a candidate cannot join
 * the current batch, no later candidate can either.
 */
export async function planBatches(
  candidates: readonly BatchCandidate[],
  limits: BatchLimits,
  reader: BoundsReader,
): Promise<Result<BatchPlanning>> {
  if (limits.maxProofs < 1 || limits.maxProofs > CONTRACT_BATCH_LIMITS.maxProofs) {
    return err({
      category: "VALIDATION",
      code: "BATCH_LIMIT_INVALID",
      message: `WATCHER_BATCH_MAX_PROOFS is ${limits.maxProofs}; the contract accepts 1 to ${CONTRACT_BATCH_LIMITS.maxProofs}`,
      retryable: false,
    });
  }
  if (limits.maxSpan < 0 || limits.maxSpan > CONTRACT_BATCH_LIMITS.maxSpan) {
    return err({
      category: "VALIDATION",
      code: "BATCH_LIMIT_INVALID",
      message: `WATCHER_BATCH_MAX_SPAN is ${limits.maxSpan}; the contract accepts 0 to ${CONTRACT_BATCH_LIMITS.maxSpan}`,
      retryable: false,
    });
  }

  const byChain = new Map<ChainKey, BatchCandidate[]>();
  for (const candidate of candidates) {
    const list = byChain.get(candidate.chainKey) ?? [];
    list.push(candidate);
    byChain.set(candidate.chainKey, list);
  }

  const plans: BatchPlan[] = [];
  const deferred: DeferredCandidate[] = [];

  for (const [chainKey, list] of byChain) {
    list.sort((left, right) => (left.blockHeight < right.blockHeight ? -1 : left.blockHeight > right.blockHeight ? 1 : 0));

    // One bounds read per distinct height; members in one block share it.
    const boundsByHeight = new Map<bigint, Result<AttestationBounds>>();
    const boundsOf = async (height: bigint): Promise<Result<AttestationBounds>> => {
      const cached = boundsByHeight.get(height);
      if (cached !== undefined) return cached;
      const read = await reader.bounds(BigInt(chainKey), height);
      boundsByHeight.set(height, read);
      return read;
    };

    let current: BatchCandidate[] = [];
    let currentBounds: AttestationBounds | undefined;
    let lowerEndpoint = 0n;
    let upperEndpoint = 0n;

    const close = (): void => {
      const first = current[0];
      const last = current[current.length - 1];
      if (first !== undefined && last !== undefined) {
        plans.push({
          chainKey,
          members: current,
          lowestHeight: first.blockHeight,
          highestHeight: last.blockHeight,
          lowerEndpoint,
          upperEndpoint,
        });
      }
      current = [];
      currentBounds = undefined;
    };

    for (const candidate of list) {
      const bounds = await boundsOf(candidate.blockHeight);
      if (!bounds.ok) {
        deferred.push({ candidate, reason: "BOUNDS_UNREADABLE", error: bounds.error });
        continue;
      }
      if (!bounds.value.isAttested) {
        deferred.push({ candidate, reason: "NOT_YET_ATTESTED", error: undefined });
        continue;
      }

      const first = current[0];
      const fits =
        first !== undefined &&
        currentBounds !== undefined &&
        current.length < limits.maxProofs &&
        candidate.blockHeight - first.blockHeight <= BigInt(limits.maxSpan) &&
        bounds.value.parentHeight <= upperEndpoint;

      if (!fits && current.length > 0) close();

      if (current.length === 0) lowerEndpoint = bounds.value.parentHeight;
      current.push(candidate);
      currentBounds = bounds.value;
      // The chain end only moves up: a later member in the same window shares the
      // endpoint, a member in the next window raises it.
      if (bounds.value.childHeight > upperEndpoint || current.length === 1) {
        upperEndpoint = bounds.value.childHeight;
      }
    }
    if (current.length > 0) close();
  }

  return ok({ plans, deferred });
}

/** One line per plan for the operator log. */
export function describePlan(plan: BatchPlan): string {
  return `chainKey ${plan.chainKey}: ${plan.members.length} member(s) over heights ${plan.lowestHeight} to ${plan.highestHeight}, chain ${plan.lowerEndpoint} to ${plan.upperEndpoint}`;
}
