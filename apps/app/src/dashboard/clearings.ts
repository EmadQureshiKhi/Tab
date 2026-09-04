/**
 * Overdue Provisional Clearings, and the call an outsider would make.
 *
 * ## Why this page exists
 *
 * `TabBook.reverseExpiredClearing` is permissionless. The reason is stated in the
 * contract itself: the Watcher that applied a clearing is also the party that
 * benefits from never reversing it, so reversal liveness must not depend on it.
 * Anyone may crank once the deadline passes.
 *
 * That guarantee is worth nothing while no outsider can see which clearings are
 * overdue. A permissionless call nobody can discover the arguments for is a
 * permission in practice. This module is the discovery half.
 *
 * ## Where each figure comes from, and why not from the index
 *
 * The candidates are found by scanning `ProvisionalClearingApplied` logs rather
 * than by reading the registry's Verified Settlement feed, and the difference is
 * not incidental. An overdue clearing is precisely one whose Verified Settlement
 * never arrived, so walking the settlement feed would miss exactly the rows this
 * page is for.
 *
 * The state and the deadline are then read from `clearingOf(replayKey)` against
 * the chain, at one named block, and never from a stored copy. Two reasons, and
 * both are about the crank being permissionless. Somebody else may have cranked a
 * clearing a moment ago, which makes any cached state stale in a way no indexer
 * can be quick enough to prevent. And a reader who is deciding whether to send a
 * transaction needs the figure the contract will compare against, not our record
 * of it.
 *
 * ## The clock is the chain's
 *
 * `reverseExpiredClearing` compares the deadline against `block.timestamp`. So the
 * verdict here compares it against the timestamp of the block the state was read
 * at, not against the viewer's clock. A browser whose clock runs fast would
 * otherwise show a row as crankable a few seconds early and send a reader to spend
 * gas on a certain `ClearingNotExpired` revert.
 *
 * Every verdict carries the block it was computed at, so a reader can tell how
 * fresh it is instead of assuming.
 *
 * Requirements: 15.5, 14.6, 15.8, 24.8
 */

import { keccak256Ascii, ok, type Result } from "@tabai/shared";

import {
  addressFromWord,
  bytes32Arg,
  bytes32FromWord,
  selectorOf,
  uintFromWord,
  wordAt,
  type ChainReader,
} from "./chain.js";

/**
 * `topics[0]` for `ProvisionalClearingApplied`, derived rather than transcribed.
 *
 * The canonical signature carries types only, in declaration order:
 * `(bytes32 clearingId, address agent, bytes32 serviceId, address asset,
 * uint128 amount, bytes32 sourceTxHash, uint64 deadline)` with the first three
 * indexed.
 */
export const PROVISIONAL_CLEARING_APPLIED_SIGNATURE =
  "ProvisionalClearingApplied(bytes32,address,bytes32,address,uint128,bytes32,uint64)";

export const PROVISIONAL_CLEARING_APPLIED_TOPIC0 = keccak256Ascii(
  PROVISIONAL_CLEARING_APPLIED_SIGNATURE,
);

/** `TabBook.clearingOf(bytes32)`. */
export const CLEARING_OF_SELECTOR = selectorOf("clearingOf(bytes32)");

/**
 * `ITabBook.ClearingState`, in the contract's own order.
 *
 * Transcribed from the enum and ordered to match it exactly. `Declined` is 4 and
 * `Superseded` is 5, which is the opposite of the order they are usually spoken
 * in, so the mapping is written out rather than inferred.
 */
export const CLEARING_STATE_BY_ORDINAL = [
  "None",
  "Applied",
  "Confirmed",
  "Reversed",
  "Declined",
  "Superseded",
] as const;

export type ClearingStateName = (typeof CLEARING_STATE_BY_ORDINAL)[number];

/** One clearing as `clearingOf` reports it. Amounts stay `bigint` until they are rendered. */
export interface ClearingRecord {
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: bigint;
  readonly reduced: bigint;
  readonly chainKey: bigint;
  readonly appliedAt: bigint;
  readonly deadline: bigint;
  readonly sourceTxHash: string;
  readonly state: ClearingStateName;
}

/** The eleven-word layout of `Clearing`, by position in the returned tuple. */
const FIELD = {
  agent: 0,
  serviceId: 1,
  asset: 2,
  amount: 3,
  reduced: 4,
  chainKey: 5,
  appliedAt: 6,
  deadline: 7,
  sourceTxHash: 8,
  attestedDigestAtApply: 9,
  state: 10,
} as const;

/**
 * Decodes `clearingOf` return data.
 *
 * `Clearing` is entirely static, so the returned tuple is eleven words laid out in
 * place with no head offset. That is what makes this eleven slices rather than a
 * decoder.
 */
export function decodeClearing(data: string): Result<ClearingRecord> {
  const words: string[] = [];
  for (let index = 0; index <= FIELD.state; index += 1) {
    const word = wordAt(data, index);
    if (word === undefined) {
      return {
        ok: false,
        error: {
          category: "UPSTREAM",
          code: "CLEARING_RETURN_SHORT",
          message: `clearingOf returned ${data.length} characters, too few for an eleven-word struct`,
          retryable: false,
        },
      };
    }
    words.push(word);
  }

  const ordinal = Number(uintFromWord(words[FIELD.state] as string));
  const state = CLEARING_STATE_BY_ORDINAL[ordinal];
  if (state === undefined) {
    // A state this build has no name for is reported rather than guessed at. The
    // enum gaining a member is a contract change, and showing an unknown ordinal
    // as some familiar state would misreport it.
    return {
      ok: false,
      error: {
        category: "UPSTREAM",
        code: "CLEARING_STATE_UNKNOWN",
        message: `clearingOf reported state ordinal ${ordinal}, which this build has no name for`,
        retryable: false,
      },
    };
  }

  return ok({
    agent: addressFromWord(words[FIELD.agent] as string),
    serviceId: bytes32FromWord(words[FIELD.serviceId] as string),
    asset: addressFromWord(words[FIELD.asset] as string),
    amount: uintFromWord(words[FIELD.amount] as string),
    reduced: uintFromWord(words[FIELD.reduced] as string),
    chainKey: uintFromWord(words[FIELD.chainKey] as string),
    appliedAt: uintFromWord(words[FIELD.appliedAt] as string),
    deadline: uintFromWord(words[FIELD.deadline] as string),
    sourceTxHash: bytes32FromWord(words[FIELD.sourceTxHash] as string),
    state,
  });
}

/** One clearing, with the verdict this page exists to publish. */
export interface ClearingView {
  readonly clearingId: string;
  readonly record: ClearingRecord;
  /** Seconds until the deadline against the chain's clock. Negative once passed. */
  readonly secondsUntilDeadline: number;
  /** True where the contract would accept a crank at the block this was read at. */
  readonly crankable: boolean;
}

/** Everything the overdue view renders, including how it was arrived at. */
export interface ClearingsReport {
  /** The block every state and every verdict below was read at. */
  readonly at: { readonly blockNumber: number; readonly timestamp: number };
  /** Clearings still `Applied` whose deadline has passed. Crankable, oldest first. */
  readonly overdue: readonly ClearingView[];
  /** Clearings still `Applied` whose deadline has not passed. Not yet crankable. */
  readonly pending: readonly ClearingView[];
  /** How many candidates were found, before the state read narrowed them. */
  readonly candidates: number;
  /** The height range the candidate scan covered, so its coverage is stated. */
  readonly scanned: { readonly fromBlock: number; readonly toBlock: number };
}

export interface ClearingsOptions {
  readonly chain: ChainReader;
  readonly tabBook: string;
  /** First block to scan for candidates. */
  readonly fromBlock: number;
}

/**
 * Finds every clearing that an outsider could crank right now.
 *
 * The scan is bounded below by `fromBlock` and above by the block the states are
 * read at, so the two halves cannot disagree about which block the answer
 * describes. A candidate applied after that block is simply not in this answer,
 * and the range is reported so that is visible rather than implied.
 */
export async function readClearings(options: ClearingsOptions): Promise<Result<ClearingsReport>> {
  const head = await options.chain.latestBlock();
  if (!head.ok) return head;

  const logs = await options.chain.logs({
    address: options.tabBook,
    topics: [PROVISIONAL_CLEARING_APPLIED_TOPIC0],
    fromBlock: options.fromBlock,
    toBlock: head.value.number,
  });
  if (!logs.ok) return logs;

  // `clearingId` is `topics[1]`, and one clearing can only be applied once, but a
  // set is cheap insurance against a re-delivered log and keeps the per-candidate
  // read count honest.
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const log of logs.value) {
    const id = log.topics[1];
    if (id === undefined) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(key);
  }

  const overdue: ClearingView[] = [];
  const pending: ClearingView[] = [];

  for (const clearingId of ids) {
    const returned = await options.chain.call(
      options.tabBook,
      `${CLEARING_OF_SELECTOR}${bytes32Arg(clearingId)}`,
      head.value.number,
    );
    if (!returned.ok) return returned;

    const record = decodeClearing(returned.value);
    if (!record.ok) return record;

    // Only `Applied` can be cranked. Everything else was already resolved, by us
    // or by somebody else, and listing it would send a reader to a certain revert.
    if (record.value.state !== "Applied") continue;

    const secondsUntilDeadline = Number(record.value.deadline) - head.value.timestamp;
    const view: ClearingView = {
      clearingId,
      record: record.value,
      secondsUntilDeadline,
      // `block.timestamp < deadline` reverts, so the deadline is inclusive: a
      // clearing is crankable at the deadline second itself.
      crankable: secondsUntilDeadline <= 0,
    };
    (view.crankable ? overdue : pending).push(view);
  }

  const byDeadline = (left: ClearingView, right: ClearingView): number =>
    Number(left.record.deadline - right.record.deadline);

  return ok({
    at: { blockNumber: head.value.number, timestamp: head.value.timestamp },
    overdue: [...overdue].sort(byDeadline),
    pending: [...pending].sort(byDeadline),
    candidates: ids.length,
    scanned: { fromBlock: options.fromBlock, toBlock: head.value.number },
  });
}

/**
 * How long ago a deadline passed, in words.
 *
 * Rendered from the chain's own clock rather than the viewer's, for the reason the
 * module header gives, so this takes seconds rather than reading a clock itself.
 */
export function overdueBy(seconds: number): string {
  const total = Math.abs(Math.trunc(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The exact call an outsider would make, as `cast` would take it.
 *
 * Printed rather than described, and printed with the address and the identifier
 * filled in, because the whole claim of this page is that somebody who did not
 * build Tab can act on what it shows. A reader who has to assemble the calldata
 * themselves has been told about a permissionless crank rather than given one.
 */
export function crankCommand(tabBook: string, clearingId: string): string {
  return `cast send ${tabBook} "reverseExpiredClearing(bytes32)" ${clearingId} --rpc-url $CREDITCOIN_RPC_URL --private-key $YOUR_KEY`;
}
