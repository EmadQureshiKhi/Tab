/**
 * The state of one observed Settlement, and the transitions the pipeline may
 * make between those states.
 *
 * The seven states are the set design section 8.7 stores in
 * `observed_settlement.state`. This module is the only place the transition
 * table is written down, so the persistence layer, the recovery path, and the
 * health endpoint cannot disagree about what is reachable from where.
 *
 * ## The pipeline, in states
 *
 * ```text
 *   OBSERVED ──► PROVISIONAL ──► READY ──► SUBMITTED ──► CONFIRMED
 *      │              │            ▲          │
 *      └──────────────┴────────────┘          │
 *                     │                       │
 *                  WITHHELD ◄─────────────────┘   (root mismatch, retry the
 *                     │                            alternate builder)
 *                     ▼
 *                  HALTED
 * ```
 *
 * - `OBSERVED` — the log was seen and persisted before anything else happened
 *   (R20.6). Every other state is reached from here.
 * - `PROVISIONAL` — a Bond-covered Provisional Clearing has been applied, so the
 *   Agent's headroom is back while the proof does not yet exist.
 * - `READY` — proof material is in hand and the locally re-derived Merkle root
 *   equals the received root (R20.4), so the Settlement may be paid for.
 * - `SUBMITTED` — the replay key is recorded as claimed *before* the broadcast
 *   (R20.9). A crash between the write and the broadcast leaves a row here whose
 *   on-chain state is unknown.
 * - `CONFIRMED` — the Creditcoin transaction is mined and the Verified
 *   Settlement exists.
 * - `WITHHELD` — the local derivation disagreed with the received root, so
 *   submission is withheld and the alternate builder is tried (R20.5).
 * - `HALTED` — both independent builders disagreed with the local derivation, or
 *   the block digest observed at clearing time is no longer attested. No gas is
 *   spent and the health endpoint flags it.
 *
 * ## Why `SUBMITTED → READY` is legal, and why it is not a retreat
 *
 * Design section 8.6: recovery after a crash reads `claimedLog(replayKey)` from
 * the contract. If the chain never saw the submission, the row goes back to
 * `READY` and is submitted again under the same replay key. The key is what makes
 * that safe — it is recorded before the broadcast and is identical on both
 * attempts, so at most one of them can ever be claimed on chain.
 *
 * ## Why `CONFIRMED` and `HALTED` have no outgoing edges
 *
 * `CONFIRMED` is the end of the pipeline. `HALTED` is a state the automated
 * pipeline cannot leave by itself: it means two independent proof sources and a
 * local re-derivation could not be reconciled, which is an operator question
 * rather than a retry. Leaving it needs an operator, so no automatic edge exists.
 *
 * Requirements: 20.6, 20.7, 20.9
 */

/**
 * Every state a row of `observed_settlement` may carry. Order is presentation
 * order — pipeline progress first, then the two states that withhold spending.
 */
export const SETTLEMENT_STATES = [
  "OBSERVED",
  "PROVISIONAL",
  "READY",
  "SUBMITTED",
  "CONFIRMED",
  "WITHHELD",
  "HALTED",
] as const;

/** The state of one observed Settlement. */
export type SettlementState = (typeof SETTLEMENT_STATES)[number];

/**
 * The legal transitions out of each state, and the whole of them.
 *
 * A state absent from a list is unreachable from that state by any automated
 * path. `canTransition` is the only sanctioned reader.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<SettlementState, readonly SettlementState[]>> = {
  // A Provisional Clearing is the normal next step; READY direct is the path
  // taken when no clearing applies or the clearing call itself was refused.
  OBSERVED: ["PROVISIONAL", "READY", "WITHHELD", "HALTED"],
  PROVISIONAL: ["READY", "WITHHELD", "HALTED"],
  // CONFIRMED without passing through SUBMITTED is reachable and correct. Crash
  // recovery returns a row to READY when `claimedLog` says the key is unclaimed, and
  // the submission it gave up on can still be sitting in the mempool. When it mines,
  // the next sweep simulates, is refused `AlreadyClaimed`, and settles the row from
  // `claimedLog`. Omitting this edge would make a guarded writer refuse a correct
  // confirmation and cycle the row forever against a key it can never claim again.
  // Found by Property 13.
  READY: ["SUBMITTED", "CONFIRMED", "WITHHELD", "HALTED"],
  // READY: crash recovery found the replay key unclaimed on chain (section 8.6).
  SUBMITTED: ["CONFIRMED", "READY", "HALTED"],
  CONFIRMED: [],
  // READY: the alternate builder agreed with the local derivation (R20.5).
  WITHHELD: ["READY", "HALTED"],
  HALTED: [],
};

/** States the automated pipeline never leaves. */
export const TERMINAL_STATES = ["CONFIRMED", "HALTED"] as const;

/**
 * States that mean "this replay key has already been spent against, or is
 * being spent against right now". A Settlement in either is skipped rather than
 * submitted a second time (R20.9).
 */
export const CLAIMED_STATES = ["SUBMITTED", "CONFIRMED"] as const;

/** States that hold a Settlement out of the submission path without spending. */
export const NON_SPENDING_STATES = ["WITHHELD", "HALTED"] as const;

/** Runtime narrowing for a value that arrived from the database or an API. */
export function isSettlementState(value: unknown): value is SettlementState {
  return typeof value === "string" && (SETTLEMENT_STATES as readonly string[]).includes(value);
}

/** True when no automated transition leaves `state`. */
export function isTerminalState(state: SettlementState): boolean {
  return (TERMINAL_STATES as readonly SettlementState[]).includes(state);
}

/** True when `state` means the replay key must not be submitted again (R20.9). */
export function isClaimedState(state: SettlementState): boolean {
  return (CLAIMED_STATES as readonly SettlementState[]).includes(state);
}

/**
 * Whether the pipeline may move a Settlement from `from` to `to`.
 *
 * A transition to the state already held is legal and is a no-op: a duplicate
 * observation of the same log must be absorbed rather than rejected, which is
 * what makes re-delivery of the same RPC log harmless.
 */
export function canTransition(from: SettlementState, to: SettlementState): boolean {
  if (from === to) return true;
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Every legal `(from, to)` pair, self-transitions excluded. Present for tests and docs. */
export function legalTransitionPairs(): readonly (readonly [SettlementState, SettlementState])[] {
  return SETTLEMENT_STATES.flatMap((from) =>
    LEGAL_TRANSITIONS[from].map((to) => [from, to] as const),
  );
}

/** One row queued for the proof stage, with the attempt count its backoff continues from. */
export interface ProofQueueEntry<Row> {
  readonly row: Row;
  readonly attempts: number;
}

/**
 * The rows one pass should source proof material for.
 *
 * Two sources, and the second is the one that was missing. `OBSERVED` and
 * `PROVISIONAL` rows are the obvious half: they have never been proved. `READY`
 * rows are the other half, and they have to rejoin **before** the proof stage
 * rather than after it.
 *
 * Both halves of that matter. A Continuity Proof perishes as attestations age
 * onto the checkpoint grid, so material folded in an earlier pass may no longer
 * verify and is not carried across a pass boundary; a rejoining row must be
 * re-sourced, not trusted. And a `READY` row that is only counted, never
 * re-proved, is stranded for good: measured on the live deployment, two rows sat
 * `READY` through repeated passes while the planner reported no plans at all,
 * because the plan was built from rows proved in that pass alone.
 *
 * A row that appears in both lists is queued once, from the pending side, so a
 * single pass never pays for the same proof twice.
 *
 * @param pending Rows not yet proved, which start their backoff at zero.
 * @param ready Rows already `READY`, carrying the attempt count to continue from.
 * @param keyOf Reads the replay key, which is the identity a row is deduplicated by.
 */
export function proofQueueOf<Row, Ready extends { readonly attempts: number }>(
  pending: readonly Row[],
  ready: readonly (Row & Ready)[],
  keyOf: (row: Row) => string,
): readonly ProofQueueEntry<Row>[] {
  const queued = new Set<string>();
  const queue: ProofQueueEntry<Row>[] = [];
  for (const row of pending) {
    const key = keyOf(row);
    if (queued.has(key)) continue;
    queued.add(key);
    queue.push({ row, attempts: 0 });
  }
  for (const row of ready) {
    const key = keyOf(row);
    if (queued.has(key)) continue;
    queued.add(key);
    queue.push({ row, attempts: row.attempts });
  }
  return queue;
}
