/**
 * Persisting observations, and reading them back after a restart.
 *
 * R20.6 is the whole reason this module exists: every observed Settlement is
 * written to durable storage *before* anything acts on it, so a crash between
 * seeing a Settlement and clearing it loses a clearing rather than a Settlement.
 *
 * ## A duplicate observation is absorbed, not rejected
 *
 * The primary key is the replay key, so the same log seen twice — a re-delivered
 * RPC response, an overlapping catch-up range, two endpoints answering the same
 * question — collides with itself. {@link recordObservations} therefore inserts
 * with `ON CONFLICT DO NOTHING` and reports how many rows were new. The absorbed
 * duplicate is the point: re-scanning a block range is a normal thing for catch-up
 * to do, and it must never produce a second row, a second clearing, or a second
 * submission.
 *
 * The insert deliberately does **not** update an existing row. A row already in
 * flight carries state the observation does not know about — a clearing, proof
 * material, a submission — and an "update on conflict" would quietly reset it. The
 * one field an insert could refresh is the block digest, and refreshing that would
 * overwrite the digest a clearing was applied against, which is precisely the
 * evidence the reorg check needs (design section 8.11).
 *
 * ## `chain_cursor.updated_at` is not ours to touch
 *
 * That column is the staleness clock: discovery reads it to tell a chain that is
 * attesting slowly from one that has stopped, and it records when the attested
 * frontier last **advanced**. Observation moves `last_processed_block`, which is a
 * different fact entirely, so {@link advanceCursor} writes that column and leaves
 * `updated_at` and `last_attested_height` exactly as they were. A writer that
 * bumped it here would reset the clock on every poll and no chain could ever be
 * seen to go quiet.
 *
 * Requirements: 15.1, 20.6, 20.7, 20.8
 */

import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import { ok, toChainKey, wrap, type ChainKey, type Result } from "@tabai/shared";

import { chainCursor, hexToBytes, observedSettlement, type ClearingStateName } from "./schema.js";
import { describeCause } from "../errors.js";
import type { WatcherDb } from "./client.js";
import type { Observation } from "../observation.js";
import type { SettlementState } from "../state.js";

/** What one commit wrote. */
export interface ObservationWrite {
  /** Rows that did not exist before this call. */
  readonly inserted: number;
  /** Rows already present, absorbed rather than rewritten. */
  readonly duplicates: number;
}

/**
 * Writes observations, absorbing any that already exist.
 *
 * Every row lands in `OBSERVED`, which is the only state an observation may create.
 * Nothing else about the row is decided here: the clearing, the proof, and the
 * submission each write their own fields later.
 *
 * `tx_index` is left null on purpose. The transaction index available at observation
 * is the one the RPC asserted, and that value is already carried inside the replay
 * key; the column holds the *proven* index, so that the two can be compared when
 * proof material arrives and a disagreement can be caught rather than assumed away.
 */
export async function recordObservations(
  db: WatcherDb,
  observations: readonly Observation[],
): Promise<Result<ObservationWrite>> {
  if (observations.length === 0) return ok({ inserted: 0, duplicates: 0 });

  const rows = observations.map((observation) => ({
    replayKey: hexToBytes(observation.replayKey),
    chainKey: BigInt(observation.chainKey),
    blockHeight: observation.blockHeight,
    logIndex: observation.logIndex,
    sourceTxHash: hexToBytes(observation.sourceTxHash),
    asset: hexToBytes(observation.asset),
    payerAddress: hexToBytes(observation.payer),
    collectionAddress: hexToBytes(observation.collection),
    serviceId: hexToBytes(observation.serviceId),
    amount: observation.amount,
    state: "OBSERVED" as SettlementState,
    emitterAddress: hexToBytes(observation.emitter),
  }));

  return wrap(
    async () => {
      const inserted = await db
        .insert(observedSettlement)
        .values(rows)
        .onConflictDoNothing({ target: observedSettlement.replayKey })
        .returning({ replayKey: observedSettlement.replayKey });
      return { inserted: inserted.length, duplicates: rows.length - inserted.length };
    },
    (error) => ({
      category: "UPSTREAM",
      code: "OBSERVATION_PERSIST_FAILED",
      message: `${rows.length} observation(s) could not be written to observed_settlement`,
      retryable: true,
      cause: describeCause(error),
    }),
  );
}

/**
 * Moves `chain_cursor.last_processed_block` forward.
 *
 * Forward only: `greatest` rather than assignment, so an out-of-order or replayed
 * commit cannot walk the cursor backwards and cause blocks to be re-scanned
 * forever. `updated_at` and `last_attested_height` are not in the `set` clause, and
 * that absence is load-bearing — see the note at the top of this module.
 */
export async function advanceCursor(
  db: WatcherDb,
  chainKey: ChainKey,
  lastProcessedBlock: bigint,
): Promise<Result<bigint>> {
  return wrap(
    async () => {
      const [row] = await db
        .insert(chainCursor)
        .values({
          chainKey: BigInt(chainKey),
          lastProcessedBlock,
          lastAttestedHeight: 0n,
        })
        .onConflictDoUpdate({
          target: chainCursor.chainKey,
          set: {
            lastProcessedBlock: sql`greatest(${chainCursor.lastProcessedBlock}, excluded.last_processed_block)`,
          },
        })
        .returning({ lastProcessedBlock: chainCursor.lastProcessedBlock });
      return row?.lastProcessedBlock ?? lastProcessedBlock;
    },
    (error) => ({
      category: "UPSTREAM",
      code: "CURSOR_ADVANCE_FAILED",
      message: `the read cursor for chainKey ${chainKey} could not be advanced to ${lastProcessedBlock}`,
      retryable: true,
      cause: describeCause(error),
    }),
  );
}

/** How far each chain has been read, as persisted. */
export interface ReadCursor {
  readonly chainKey: ChainKey;
  readonly lastProcessedBlock: bigint;
  readonly attesting: boolean;
}

/**
 * The read cursors, which is where a restart resumes from (R20.8).
 *
 * A chain with no row yields no entry rather than a zero: "never read" and "read up
 * to block zero" are the same number and different facts, and the caller decides
 * where a cold start begins.
 */
export async function loadReadCursors(db: WatcherDb): Promise<Result<readonly ReadCursor[]>> {
  const rows = await wrap(
    () =>
      db
        .select({
          chainKey: chainCursor.chainKey,
          lastProcessedBlock: chainCursor.lastProcessedBlock,
          attesting: chainCursor.attesting,
        })
        .from(chainCursor),
    (error) => ({
      category: "UPSTREAM",
      code: "CHAIN_CURSOR_READ_FAILED",
      message: "chain_cursor could not be read",
      retryable: true,
      cause: describeCause(error),
    }),
  );
  if (!rows.ok) return rows;

  const cursors: ReadCursor[] = [];
  for (const row of rows.value) {
    const chainKey = toChainKey(row.chainKey);
    if (chainKey === undefined) continue;
    cursors.push({
      chainKey,
      lastProcessedBlock: row.lastProcessedBlock,
      attesting: row.attesting,
    });
  }
  return ok(cursors);
}

/** One row as the pipeline needs it, with bytes already back in hex. */
export interface PendingSettlement {
  readonly replayKey: string;
  readonly chainKey: ChainKey;
  readonly blockHeight: bigint;
  readonly logIndex: bigint;
  readonly sourceTxHash: string;
  readonly asset: string;
  readonly payer: string;
  readonly collection: string;
  readonly serviceId: string;
  readonly amount: bigint;
  readonly state: SettlementState;
  readonly clearingState: ClearingStateName | undefined;
  readonly attestedDigest: string | undefined;
  readonly emitter: string | undefined;
  readonly observedAt: Date;
}

const toHex = (bytes: Uint8Array): string =>
  `0x${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex")}`;

const PENDING_COLUMNS = {
  replayKey: observedSettlement.replayKey,
  chainKey: observedSettlement.chainKey,
  blockHeight: observedSettlement.blockHeight,
  logIndex: observedSettlement.logIndex,
  sourceTxHash: observedSettlement.sourceTxHash,
  asset: observedSettlement.asset,
  payerAddress: observedSettlement.payerAddress,
  collectionAddress: observedSettlement.collectionAddress,
  serviceId: observedSettlement.serviceId,
  amount: observedSettlement.amount,
  state: observedSettlement.state,
  clearingState: observedSettlement.clearingState,
  attestedDigest: observedSettlement.attestedDigest,
  emitterAddress: observedSettlement.emitterAddress,
  observedAt: observedSettlement.observedAt,
};

/**
 * The row shape {@link PENDING_COLUMNS} selects, written out rather than inferred.
 *
 * Spelling it out is what makes a nullable column visible: `clearing_state`,
 * `attested_digest`, and `emitter_address` are all `null` on a row written before
 * the clearing ran, and an inferred type that lost that would let a `null` digest be
 * hexed into `"0x"` and reported as a digest.
 */
interface PendingRow {
  readonly replayKey: Uint8Array;
  readonly chainKey: bigint;
  readonly blockHeight: bigint;
  readonly logIndex: bigint;
  readonly sourceTxHash: Uint8Array;
  readonly asset: Uint8Array;
  readonly payerAddress: Uint8Array;
  readonly collectionAddress: Uint8Array;
  readonly serviceId: Uint8Array;
  readonly amount: bigint;
  readonly state: SettlementState;
  readonly clearingState: ClearingStateName | null;
  readonly attestedDigest: Uint8Array | null;
  readonly emitterAddress: Uint8Array | null;
  readonly observedAt: Date;
}

/** A row that arrived with a chainKey Tab has no descriptor for is skipped, not fixed. */
function toPending(row: PendingRow): PendingSettlement | undefined {
  const chainKey = toChainKey(row.chainKey);
  if (chainKey === undefined) return undefined;
  return {
    replayKey: toHex(row.replayKey),
    chainKey,
    blockHeight: row.blockHeight,
    logIndex: row.logIndex,
    sourceTxHash: toHex(row.sourceTxHash),
    asset: toHex(row.asset),
    payer: toHex(row.payerAddress),
    collection: toHex(row.collectionAddress),
    serviceId: toHex(row.serviceId),
    amount: row.amount,
    state: row.state,
    clearingState: row.clearingState ?? undefined,
    attestedDigest: row.attestedDigest === null ? undefined : toHex(row.attestedDigest),
    emitter: row.emitterAddress === null ? undefined : toHex(row.emitterAddress),
    observedAt: row.observedAt,
  };
}

/**
 * Every row a restart must pick back up: observed but not yet confirmed (R20.7).
 *
 * `CONFIRMED` and `HALTED` are excluded because no automated transition leaves
 * them — `state.ts` owns that fact and this query is the one place it is spent.
 * Order is observation order, so a restart resumes the oldest work first rather
 * than whatever the planner happens to return.
 */
export async function loadResumableSettlements(
  db: WatcherDb,
  limit = 500,
): Promise<Result<readonly PendingSettlement[]>> {
  const rows = await wrap(
    () =>
      db
        .select(PENDING_COLUMNS)
        .from(observedSettlement)
        .where(inArray(observedSettlement.state, ["OBSERVED", "PROVISIONAL", "READY", "SUBMITTED", "WITHHELD"]))
        .orderBy(asc(observedSettlement.observedAt), asc(observedSettlement.blockHeight))
        .limit(limit),
    (error) => ({
      category: "UPSTREAM",
      code: "OBSERVATION_READ_FAILED",
      message: "the unconfirmed rows of observed_settlement could not be read",
      retryable: true,
      cause: describeCause(error),
    }),
  );
  if (!rows.ok) return rows;
  return ok(rows.value.map(toPending).filter((row): row is PendingSettlement => row !== undefined));
}

/**
 * Rows that have not been offered a Provisional Clearing yet.
 *
 * `clearing_state` is null or `NONE` for exactly those, and it is what keeps a
 * declined observation out of the sweep: a decline is terminal on chain, because
 * `TabBook._openClearing` reverts `ClearingAlreadyExists` for an identity that
 * already carries a record, so re-offering one would spend gas on a certain revert.
 *
 * Ordered oldest first, because a Provisional Clearing is worth most to the Agent
 * that has been waiting longest for its headroom.
 */
export async function loadClearingCandidates(
  db: WatcherDb,
  limit = 100,
): Promise<Result<readonly PendingSettlement[]>> {
  const rows = await wrap(
    () =>
      db
        .select(PENDING_COLUMNS)
        .from(observedSettlement)
        .where(
          and(
            eq(observedSettlement.state, "OBSERVED"),
            or(isNull(observedSettlement.clearingState), eq(observedSettlement.clearingState, "NONE")),
          ),
        )
        .orderBy(asc(observedSettlement.observedAt), asc(observedSettlement.blockHeight))
        .limit(limit),
    (error) => ({
      category: "UPSTREAM",
      code: "CLEARING_CANDIDATE_READ_FAILED",
      message: "the clearing candidates could not be read from observed_settlement",
      retryable: true,
      cause: describeCause(error),
    }),
  );
  if (!rows.ok) return rows;
  return ok(rows.value.map(toPending).filter((row): row is PendingSettlement => row !== undefined));
}

/**
 * Rows that still need a Continuity Proof.
 *
 * **Not the same set as the clearing candidates, and conflating the two strands
 * the happy path.** {@link loadClearingCandidates} deliberately excludes a row
 * that already carries a clearing, because a Provisional Clearing must not be
 * applied twice. A row that was cleared is exactly a row that still needs
 * proving, though: the clearing is Bond-covered and revocable, and only the proof
 * makes it a Verified Settlement. Feeding the proof stage from the clearing
 * loader therefore proves only the Settlements that were never cleared, and every
 * cleared one sits in `PROVISIONAL` until the reversal crank takes the credit
 * back. Measured on the live deployment: with clearing enabled, three Settlements
 * sat `PROVISIONAL` across repeated passes while the proof stage reported nothing
 * to attempt.
 *
 * `WITHHELD` is included because that state exists to be retried: the local
 * derivation disagreed with one builder and the alternate is tried on a later
 * pass (R20.5). `READY` is not, because those rows are loaded separately with
 * their attempt counts by {@link loadSubmissionCandidates}.
 */
export async function loadProofCandidates(
  db: WatcherDb,
  limit = 100,
): Promise<Result<readonly PendingSettlement[]>> {
  const rows = await wrap(
    () =>
      db
        .select(PENDING_COLUMNS)
        .from(observedSettlement)
        .where(inArray(observedSettlement.state, ["OBSERVED", "PROVISIONAL", "WITHHELD"]))
        .orderBy(asc(observedSettlement.observedAt), asc(observedSettlement.blockHeight))
        .limit(limit),
    (error) => ({
      category: "UPSTREAM",
      code: "PROOF_CANDIDATE_READ_FAILED",
      message: "the proof candidates could not be read from observed_settlement",
      retryable: true,
      cause: describeCause(error),
    }),
  );
  if (!rows.ok) return rows;
  return ok(rows.value.map(toPending).filter((row): row is PendingSettlement => row !== undefined));
}

/**
 * Rows carrying an `APPLIED` clearing, which are the ones a reversal crank may act on.
 *
 * The deadline is not stored here, deliberately. It is a Creditcoin timestamp set by
 * `TabBook` at apply time, and the only trustworthy reading of both it and the current
 * state is `clearingOf(replayKey)` against the chain. A column would be a second copy
 * that a reversal cranked by anyone else, which is the whole point of a permissionless
 * crank, would silently make stale. So this returns candidates and the sweep does the
 * deciding from the chain.
 */
export async function loadReversalCandidates(
  db: WatcherDb,
  limit = 100,
): Promise<Result<readonly PendingSettlement[]>> {
  const rows = await wrap(
    () =>
      db
        .select(PENDING_COLUMNS)
        .from(observedSettlement)
        .where(eq(observedSettlement.clearingState, "APPLIED"))
        .orderBy(asc(observedSettlement.blockHeight))
        .limit(limit),
    (error) => ({
      category: "UPSTREAM",
      code: "REVERSAL_CANDIDATE_READ_FAILED",
      message: "the reversal candidates could not be read from observed_settlement",
      retryable: true,
      cause: describeCause(error),
    }),
  );
  if (!rows.ok) return rows;
  return ok(rows.value.map(toPending).filter((row): row is PendingSettlement => row !== undefined));
}

/**
 * Rows whose clearing is confirmed and therefore in scope for the reorg check.
 *
 * `TabBook.reportReorg` accepts only a `Confirmed` clearing and requires the
 * observed digest to equal the one recorded at apply time, so a row with no
 * `attested_digest` has nothing to check and is excluded here rather than filtered
 * out later.
 */
export async function loadReorgCheckCandidates(
  db: WatcherDb,
  limit = 100,
): Promise<Result<readonly PendingSettlement[]>> {
  const rows = await wrap(
    () =>
      db
        .select(PENDING_COLUMNS)
        .from(observedSettlement)
        .where(eq(observedSettlement.clearingState, "CONFIRMED"))
        .orderBy(asc(observedSettlement.blockHeight))
        .limit(limit),
    (error) => ({
      category: "UPSTREAM",
      code: "REORG_CANDIDATE_READ_FAILED",
      message: "the confirmed clearings could not be read from observed_settlement",
      retryable: true,
      cause: describeCause(error),
    }),
  );
  if (!rows.ok) return rows;
  return ok(
    rows.value
      .map(toPending)
      .filter((row): row is PendingSettlement => row !== undefined && row.attestedDigest !== undefined),
  );
}

/** What a clearing outcome writes back onto its row. */
export interface ClearingRecord {
  readonly replayKey: string;
  readonly clearingState: ClearingStateName;
  /** The digest the clearing was applied against, stored only when one was applied. */
  readonly attestedDigest?: string | undefined;
  /** The row's own pipeline state after the outcome. */
  readonly state: SettlementState;
  readonly lastErrorCategory?: string | undefined;
}

/**
 * Records the outcome of a clearing attempt.
 *
 * The digest is written in the same statement as the state, so no row can ever say
 * `APPLIED` without carrying the digest the reorg check will need — `reportReorg`
 * refuses an observation that disagrees with the digest recorded at apply time, so a
 * row missing it could never report a reorg at all.
 */
export async function recordClearingOutcome(
  db: WatcherDb,
  record: ClearingRecord,
): Promise<Result<number>> {
  return wrap(
    async () => {
      const updated = await db
        .update(observedSettlement)
        .set({
          clearingState: record.clearingState,
          state: record.state,
          clearingId: hexToBytes(record.replayKey),
          ...(record.attestedDigest === undefined
            ? {}
            : { attestedDigest: hexToBytes(record.attestedDigest) }),
          ...(record.lastErrorCategory === undefined
            ? {}
            : { lastErrorCategory: record.lastErrorCategory }),
          updatedAt: new Date(),
        })
        .where(eq(observedSettlement.replayKey, hexToBytes(record.replayKey)))
        .returning({ replayKey: observedSettlement.replayKey });
      return updated.length;
    },
    (error) => ({
      category: "UPSTREAM",
      code: "CLEARING_PERSIST_FAILED",
      message: `the clearing outcome for ${record.replayKey} could not be written`,
      retryable: true,
      cause: describeCause(error),
    }),
  );
}

/**
 * Writes only the clearing state, leaving the Settlement's own state alone.
 *
 * A reversal changes where the clearing sits and nothing about whether the Settlement
 * still needs proving and submitting. The Settlement is real: the payment happened on
 * the Source Chain, and the reversal only undid the provisional credit taken against a
 * Service's Bond before the proof arrived. So the row keeps its pipeline state and
 * carries on toward `READY`. `recordClearingOutcome` writes both columns together and
 * would have moved the row backwards here.
 */
export async function recordClearingState(
  db: WatcherDb,
  replayKey: string,
  clearingState: ClearingStateName,
): Promise<Result<number>> {
  return wrap(
    async () => {
      const updated = await db
        .update(observedSettlement)
        .set({ clearingState, updatedAt: new Date() })
        .where(eq(observedSettlement.replayKey, hexToBytes(replayKey)))
        .returning({ replayKey: observedSettlement.replayKey });
      return updated.length;
    },
    (error) => ({
      category: "UPSTREAM",
      code: "CLEARING_STATE_WRITE_FAILED",
      message: `the clearing state for ${replayKey} could not be written`,
      retryable: true,
      cause: describeCause(error),
    }),
  );
}

/** Counts by state, for the health endpoint and for a one-line operator summary. */
export async function countByState(
  db: WatcherDb,
): Promise<Result<Readonly<Partial<Record<SettlementState, number>>>>> {
  return wrap(
    async () => {
      const rows = await db
        .select({ state: observedSettlement.state, count: sql<number>`count(*)::int` })
        .from(observedSettlement)
        .groupBy(observedSettlement.state);
      const counts: Partial<Record<SettlementState, number>> = {};
      for (const row of rows) counts[row.state] = Number(row.count);
      return counts;
    },
    (error) => ({
      category: "UPSTREAM",
      code: "OBSERVATION_COUNT_FAILED",
      message: "observed_settlement could not be counted by state",
      retryable: true,
      cause: describeCause(error),
    }),
  );
}

/**
 * Counts by last known clearing state, for the health endpoint.
 *
 * The column is a cache of an on-chain fact and `clearingOf(replayKey)` is the only
 * authority, so this counts what the Watcher last saw rather than what the chain now
 * holds. That is the right figure for a health report: it answers "how many clearings
 * does this process believe it is exposed on", which is what an operator acts on. A
 * row with no clearing at all is excluded rather than counted as `NONE`, because
 * "never cleared" and "cleared then reverted to none" are different facts.
 */
export async function countByClearingState(
  db: WatcherDb,
): Promise<Result<Readonly<Partial<Record<ClearingStateName, number>>>>> {
  return wrap(
    async () => {
      const rows = await db
        .select({ state: observedSettlement.clearingState, count: sql<number>`count(*)::int` })
        .from(observedSettlement)
        .where(isNotNull(observedSettlement.clearingState))
        .groupBy(observedSettlement.clearingState);
      const counts: Partial<Record<ClearingStateName, number>> = {};
      for (const row of rows) {
        if (row.state === null) continue;
        counts[row.state] = Number(row.count);
      }
      return counts;
    },
    (error) => ({
      category: "UPSTREAM",
      code: "CLEARING_COUNT_FAILED",
      message: "observed_settlement could not be counted by clearing state",
      retryable: true,
      cause: describeCause(error),
    }),
  );
}

// ------------------------------------------------------------ the submission stage

/**
 * One row the submission sweep may act on, with the two fields the schedule needs.
 *
 * `submitAttempts` is carried so the backoff continues from where the row left off
 * rather than restarting at two seconds on every process bounce, which would turn
 * a persistently failing endpoint into a tight loop across restarts.
 */
export interface SubmissionCandidate extends PendingSettlement {
  readonly attempts: number;
  readonly nextAttemptAt: Date | undefined;
}

const SUBMISSION_COLUMNS = {
  ...PENDING_COLUMNS,
  submitAttempts: observedSettlement.submitAttempts,
  nextAttemptAt: observedSettlement.nextAttemptAt,
  ccTxHash: observedSettlement.ccTxHash,
};

/**
 * Rows whose proof has been verified locally and whose retry time has come.
 *
 * `READY` is the state `proof.ts` moves a row into once the locally re-derived
 * root matched, so every row here has already passed the gate that decides whether
 * gas is worth spending. The `next_attempt_at` filter is applied in SQL rather
 * than in the caller because the index is on `(state, next_attempt_at)` and doing
 * it here is what uses it.
 */
export async function loadSubmissionCandidates(
  db: WatcherDb,
  now: Date = new Date(),
  limit = 100,
): Promise<Result<readonly SubmissionCandidate[]>> {
  const rows = await wrap(
    () =>
      db
        .select(SUBMISSION_COLUMNS)
        .from(observedSettlement)
        .where(
          and(
            eq(observedSettlement.state, "READY"),
            or(isNull(observedSettlement.nextAttemptAt), lte(observedSettlement.nextAttemptAt, now)),
          ),
        )
        .orderBy(asc(observedSettlement.chainKey), asc(observedSettlement.blockHeight))
        .limit(limit),
    (error) => ({
      category: "UPSTREAM",
      code: "SUBMISSION_CANDIDATE_READ_FAILED",
      message: "the submission candidates could not be read from observed_settlement",
      retryable: true,
      cause: describeCause(error),
    }),
  );
  if (!rows.ok) return rows;
  return ok(
    rows.value
      .map((row) => {
        const pending = toPending(row);
        if (pending === undefined) return undefined;
        return { ...pending, attempts: row.submitAttempts, nextAttemptAt: row.nextAttemptAt ?? undefined };
      })
      .filter((row): row is SubmissionCandidate => row !== undefined),
  );
}

/**
 * Marks every key in a batch `SUBMITTED`, in one statement, before the broadcast.
 *
 * R20.9 in one write. One statement rather than one per key so a crash cannot
 * leave half a batch marked, which would be a batch the pipeline both retries and
 * reconciles.
 */
export async function markSubmitted(
  db: WatcherDb,
  replayKeys: readonly string[],
): Promise<Result<number>> {
  if (replayKeys.length === 0) return ok(0);
  return wrap(
    async () => {
      const updated = await db
        .update(observedSettlement)
        .set({ state: "SUBMITTED", updatedAt: new Date() })
        .where(inArray(observedSettlement.replayKey, replayKeys.map(hexToBytes)))
        .returning({ replayKey: observedSettlement.replayKey });
      return updated.length;
    },
    (error) => ({
      category: "UPSTREAM",
      code: "MARK_SUBMITTED_FAILED",
      message: `${replayKeys.length} replay key(s) could not be marked SUBMITTED, so nothing was broadcast`,
      retryable: true,
      cause: describeCause(error),
    }),
  );
}

/** Writes one submission outcome back onto its row. */
export async function recordSubmissionOutcome(
  db: WatcherDb,
  record: {
    readonly replayKey: string;
    readonly state: SettlementState;
    readonly attempts: number;
    readonly nextAttemptAt: Date | undefined;
    readonly ccTxHash: string | undefined;
    readonly lastErrorCategory: string | undefined;
  },
): Promise<Result<number>> {
  return wrap(
    async () => {
      const updated = await db
        .update(observedSettlement)
        .set({
          state: record.state,
          submitAttempts: record.attempts,
          nextAttemptAt: record.nextAttemptAt ?? null,
          ...(record.ccTxHash === undefined ? {} : { ccTxHash: hexToBytes(record.ccTxHash) }),
          lastErrorCategory: record.lastErrorCategory ?? null,
          updatedAt: new Date(),
        })
        .where(eq(observedSettlement.replayKey, hexToBytes(record.replayKey)))
        .returning({ replayKey: observedSettlement.replayKey });
      return updated.length;
    },
    (error) => ({
      category: "UPSTREAM",
      code: "SUBMISSION_PERSIST_FAILED",
      message: `the submission outcome for ${record.replayKey} could not be written`,
      retryable: true,
      cause: describeCause(error),
    }),
  );
}

/**
 * Rows left `SUBMITTED`, whose on-chain state is unknown.
 *
 * A crash between the mark and the broadcast, or a receipt that never arrived,
 * both land here. `reconcileSubmitted` settles each one from `claimedLog`, which
 * is the only authority: the chain either claimed the key or it did not.
 */
export async function loadSubmittedRows(
  db: WatcherDb,
  limit = 100,
): Promise<Result<readonly { replayKey: string; attempts: number; ccTxHash: string | undefined }[]>> {
  const rows = await wrap(
    () =>
      db
        .select({
          replayKey: observedSettlement.replayKey,
          submitAttempts: observedSettlement.submitAttempts,
          ccTxHash: observedSettlement.ccTxHash,
        })
        .from(observedSettlement)
        .where(eq(observedSettlement.state, "SUBMITTED"))
        .orderBy(asc(observedSettlement.blockHeight))
        .limit(limit),
    (error) => ({
      category: "UPSTREAM",
      code: "SUBMITTED_ROW_READ_FAILED",
      message: "the SUBMITTED rows could not be read from observed_settlement",
      retryable: true,
      cause: describeCause(error),
    }),
  );
  if (!rows.ok) return rows;
  return ok(
    rows.value.map((row) => ({
      replayKey: toHex(row.replayKey),
      attempts: row.submitAttempts,
      ccTxHash: row.ccTxHash === null ? undefined : toHex(row.ccTxHash),
    })),
  );
}
