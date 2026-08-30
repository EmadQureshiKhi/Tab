/**
 * Keyset pagination, and the cursor that carries it.
 *
 * ## Why the cursor is a position and not an offset
 *
 * Rows arrive while a client is paging. The indexer writes a batch every poll, and
 * a caller walking a settlement feed has no way to hold the table still. Under
 * `LIMIT n OFFSET k` that is a correctness bug rather than a performance note: two
 * rows inserted above the window shift everything down by two, so page two repeats
 * two rows page one already served, and two rows further down are never served at
 * all. No amount of retrying fixes it, because each page is computed against a
 * different table.
 *
 * So the cursor names a **position in a total order** instead of a count of rows
 * skipped. The order is `(block_number, log_index)` descending, and that pair is
 * both:
 *
 * - **total**, because a log ordinal is unique within a block and the stored set
 *   holds one hash per block number — the indexer deletes a re-mined block's rows
 *   before writing the replacement, so two rows can never share the pair; and
 * - **monotonic**, because a block number only ever increases as the chain
 *   advances.
 *
 * Every page therefore asks for "the next `n` rows strictly below this position",
 * which is a question with one answer no matter what has been written since. New
 * rows land *above* the walk, at higher block numbers, where they cannot disturb
 * it. A caller that wants them re-reads the first page.
 *
 * ## What the cursor is not
 *
 * It is not a snapshot. A page boundary is stable, but a row deleted by a
 * reorganisation rewind is gone from a later page, which is the truthful outcome:
 * the read layer serves the canonical chain, not the chain as it looked when
 * paging began.
 *
 * It does not carry the filter set either. A caller that changes `agent` halfway
 * through a walk gets the rows below that position under the new filter, which is
 * a coherent answer to a different question. Cursors are opaque and callers are
 * expected to keep the query fixed for the length of a walk, which is the usual
 * contract and the one the Dashboard's feed keeps.
 *
 * Requirements: 24.1, 24.3, 24.4, 24.7
 */

import { err, ok, type Result } from "@tabai/shared";

/** A row's place in the total order every paginated read walks. */
export interface LogPosition {
  /** Creditcoin block the log sits in. */
  readonly blockNumber: number;
  /** Block-wide ordinal of the log. Not the ordinal within its transaction. */
  readonly logIndex: number;
}

/** Rows per page when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Rows per page ceiling.
 *
 * A cap rather than a courtesy: the endpoints are unauthenticated, so `limit` is
 * the one number a caller can use to ask this process to do arbitrary work.
 */
export const MAX_PAGE_SIZE = 200;

/**
 * Cursor format version.
 *
 * Encoded into the token so a later change of ordering can reject an old cursor by
 * name instead of silently reinterpreting its numbers as positions in a different
 * order.
 */
const CURSOR_VERSION = "v1";

const validation = (code: string, message: string): Result<never> =>
  err({ category: "VALIDATION", code, message, retryable: false });

/**
 * Encodes a position as an opaque token.
 *
 * Base64url, so the token survives a query string with no escaping. The encoding
 * is not a secret and is not meant to be one — a caller who decodes it learns a
 * block number and a log ordinal, both of which are public chain facts it already
 * received in the row the cursor points past.
 */
export function encodeCursor(position: LogPosition): string {
  const plain = `${CURSOR_VERSION}|${position.blockNumber}|${position.logIndex}`;
  return Buffer.from(plain, "utf8").toString("base64url");
}

/**
 * Decodes a token back into a position.
 *
 * Every rejection is a `VALIDATION` failure naming what was wrong, because a
 * malformed cursor is a caller mistake and a 400 is more useful to whoever has to
 * fix it than an empty page would be.
 */
export function decodeCursor(token: string): Result<LogPosition> {
  let plain: string;
  try {
    plain = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return validation("CURSOR_MALFORMED", "cursor is not base64url");
  }

  const parts = plain.split("|");
  if (parts.length !== 3) {
    return validation("CURSOR_MALFORMED", "cursor does not carry three fields");
  }
  const [version, blockNumber, logIndex] = parts;
  if (version !== CURSOR_VERSION) {
    return validation(
      "CURSOR_VERSION_UNKNOWN",
      `cursor version ${String(version)} is not ${CURSOR_VERSION}`,
    );
  }
  if (!/^\d+$/.test(blockNumber ?? "") || !/^\d+$/.test(logIndex ?? "")) {
    return validation("CURSOR_MALFORMED", "cursor position is not a pair of non-negative integers");
  }

  const position: LogPosition = {
    blockNumber: Number.parseInt(blockNumber ?? "", 10),
    logIndex: Number.parseInt(logIndex ?? "", 10),
  };
  if (!Number.isSafeInteger(position.blockNumber) || !Number.isSafeInteger(position.logIndex)) {
    return validation("CURSOR_OUT_OF_RANGE", "cursor position exceeds the safe-integer range");
  }
  return ok(position);
}

/**
 * Reads the `limit` query parameter.
 *
 * Absent means {@link DEFAULT_PAGE_SIZE}. Anything else must be an integer in
 * `[1, MAX_PAGE_SIZE]`; a value over the ceiling is rejected rather than clamped,
 * so a caller asking for 10,000 rows learns it did not get them instead of
 * assuming a short page means the end of the feed.
 */
export function parsePageSize(raw: string | undefined): Result<number> {
  if (raw === undefined || raw.trim().length === 0) return ok(DEFAULT_PAGE_SIZE);
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return validation("LIMIT_MALFORMED", "limit must be a non-negative integer");
  }
  const value = Number.parseInt(trimmed, 10);
  if (value < 1 || value > MAX_PAGE_SIZE) {
    return validation("LIMIT_OUT_OF_RANGE", `limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return ok(value);
}

/** Reads the `cursor` query parameter, which may be absent. */
export function parseCursor(raw: string | undefined): Result<LogPosition | null> {
  if (raw === undefined || raw.trim().length === 0) return ok(null);
  const decoded = decodeCursor(raw.trim());
  return decoded.ok ? ok(decoded.value) : decoded;
}

/** One page of rows, and the token that asks for the next. */
export interface Page<T> {
  readonly items: readonly T[];
  /** `null` when this page reached the end of the feed. */
  readonly nextCursor: string | null;
}

/**
 * Turns an over-fetched row set into a page.
 *
 * The caller queries `pageSize + 1` rows. Whether the extra row came back is what
 * decides the next cursor, so `nextCursor` is `null` only when the feed is
 * genuinely exhausted — never merely because a page came back exactly full. A
 * client following cursors therefore performs one extra request at the end of a
 * walk and no more, and never stops one page early.
 */
export function toPage<T>(
  rows: readonly T[],
  pageSize: number,
  positionOf: (row: T) => LogPosition,
): Page<T> {
  const items = rows.slice(0, pageSize);
  const last = items.at(-1);
  const hasMore = rows.length > pageSize;
  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor(positionOf(last)) : null,
  };
}
