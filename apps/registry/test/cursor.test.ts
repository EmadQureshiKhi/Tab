/**
 * Keyset pagination, on its own.
 *
 * The cursor is the part of the read API that can be wrong without looking wrong, so
 * it is tested apart from any database. Three claims, and the third is the one that
 * matters:
 *
 * - a token round trips, and every malformed token is rejected by name rather than
 *   quietly serving page one;
 * - `limit` is bounded, and a value over the ceiling is refused rather than clamped,
 *   because a silently shortened page is indistinguishable from the end of a feed;
 * - **a walk is stable while rows are being written.** Simulated directly: page,
 *   insert above the walk, page again, and assert the union is exactly the rows that
 *   existed at the start with nothing repeated and nothing skipped. An offset-based
 *   cursor fails this, and the same test shows it failing.
 *
 * Requirements: 24.1, 24.3, 24.4, 24.7
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  parseCursor,
  parsePageSize,
  toPage,
  type LogPosition,
} from "../src/cursor.js";

test("a position round trips through a token", () => {
  const position: LogPosition = { blockNumber: 5_408_102, logIndex: 7 };
  const decoded = decodeCursor(encodeCursor(position));
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.ok ? decoded.value : null, position);
});

test("the token is base64url, so it survives a query string unescaped", () => {
  const token = encodeCursor({ blockNumber: 5_408_102, logIndex: 7 });
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(token, encodeURIComponent(token));
});

test("a malformed token is rejected by name rather than serving page one", () => {
  for (const [token, code] of [
    ["not base64 at all !!", "CURSOR_MALFORMED"],
    [Buffer.from("v1|12", "utf8").toString("base64url"), "CURSOR_MALFORMED"],
    [Buffer.from("v2|12|3", "utf8").toString("base64url"), "CURSOR_VERSION_UNKNOWN"],
    [Buffer.from("v1|twelve|3", "utf8").toString("base64url"), "CURSOR_MALFORMED"],
    [Buffer.from("v1|-1|3", "utf8").toString("base64url"), "CURSOR_MALFORMED"],
    [
      Buffer.from(`v1|${"9".repeat(20)}|3`, "utf8").toString("base64url"),
      "CURSOR_OUT_OF_RANGE",
    ],
  ] as const) {
    const decoded = decodeCursor(token);
    assert.equal(decoded.ok, false, `${token} should have been rejected`);
    if (!decoded.ok) {
      assert.equal(decoded.error.category, "VALIDATION");
      assert.equal(decoded.error.code, code);
    }
  }
});

test("an absent cursor is not an error", () => {
  for (const raw of [undefined, "", "   "]) {
    const parsed = parseCursor(raw);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok ? parsed.value : "unset", null);
  }
});

test("limit defaults, and is bounded rather than clamped", () => {
  assert.deepEqual(parsePageSize(undefined), { ok: true, value: DEFAULT_PAGE_SIZE });
  assert.deepEqual(parsePageSize("1"), { ok: true, value: 1 });
  assert.deepEqual(parsePageSize(String(MAX_PAGE_SIZE)), { ok: true, value: MAX_PAGE_SIZE });

  for (const raw of ["0", String(MAX_PAGE_SIZE + 1), "10000"]) {
    const parsed = parsePageSize(raw);
    assert.equal(parsed.ok, false);
    // Refused, not silently reduced: a caller that asked for 10,000 rows and got 200
    // cannot tell a short page from the end of the feed.
    if (!parsed.ok) assert.equal(parsed.error.code, "LIMIT_OUT_OF_RANGE");
  }
  for (const raw of ["-1", "1.5", "many"]) {
    const parsed = parsePageSize(raw);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.error.code, "LIMIT_MALFORMED");
  }
});

test("a full page still yields a next cursor, and an exhausted one does not", () => {
  const rows: LogPosition[] = [
    { blockNumber: 10, logIndex: 1 },
    { blockNumber: 9, logIndex: 4 },
    { blockNumber: 9, logIndex: 2 },
  ];
  const identity = (row: LogPosition): LogPosition => row;

  // Three rows fetched for a page of two means a third exists.
  const first = toPage(rows, 2, identity);
  assert.equal(first.items.length, 2);
  assert.notEqual(first.nextCursor, null);
  assert.deepEqual(
    decodeCursor(first.nextCursor ?? "").ok ? decodeCursor(first.nextCursor ?? "") : null,
    { ok: true, value: { blockNumber: 9, logIndex: 4 } },
  );

  // Exactly two rows fetched for a page of two means the feed ended on the boundary.
  const last = toPage(rows.slice(0, 2), 2, identity);
  assert.equal(last.items.length, 2);
  assert.equal(last.nextCursor, null);
});

// ------------------------------------------------- stability under concurrent writes

/** The total order every paginated read walks: newest first. */
const descending = (a: LogPosition, b: LogPosition): number =>
  b.blockNumber - a.blockNumber || b.logIndex - a.logIndex;

const below = (position: LogPosition, cursor: LogPosition | null): boolean =>
  cursor === null ||
  position.blockNumber < cursor.blockNumber ||
  (position.blockNumber === cursor.blockNumber && position.logIndex < cursor.logIndex);

/** What the SQL does: the next `n` rows strictly below a position, newest first. */
const keysetPage = (
  table: readonly LogPosition[],
  cursor: LogPosition | null,
  pageSize: number,
): readonly LogPosition[] =>
  [...table].sort(descending).filter((row) => below(row, cursor)).slice(0, pageSize + 1);

/** What an offset cursor does, for the comparison. */
const offsetPage = (
  table: readonly LogPosition[],
  offset: number,
  pageSize: number,
): readonly LogPosition[] => [...table].sort(descending).slice(offset, offset + pageSize);

test("a keyset walk crossing a page boundary is stable while rows are written above it", () => {
  // Six rows, two of them sharing a block, so the boundary falls inside a block and
  // the ordering has to be the pair rather than the block number alone.
  const table: LogPosition[] = [
    { blockNumber: 100, logIndex: 0 },
    { blockNumber: 101, logIndex: 3 },
    { blockNumber: 101, logIndex: 1 },
    { blockNumber: 102, logIndex: 0 },
    { blockNumber: 103, logIndex: 9 },
    { blockNumber: 103, logIndex: 2 },
  ];
  const start = [...table].sort(descending);

  const pageSize = 2;
  const seen: LogPosition[] = [];
  let cursor: LogPosition | null = null;
  let inserted = 0;

  for (let request = 0; request < 10; request += 1) {
    const fetched = keysetPage(table, cursor, pageSize);
    const page = toPage(fetched, pageSize, (row) => row);
    seen.push(...page.items);

    // The indexer writes while the client pages. New rows land above the walk,
    // because a block number only ever increases.
    if (inserted < 3) {
      inserted += 1;
      table.push({ blockNumber: 200 + inserted, logIndex: 0 });
    }

    if (page.nextCursor === null) break;
    const next = decodeCursor(page.nextCursor);
    assert.equal(next.ok, true);
    cursor = next.ok ? next.value : null;
  }

  // Exactly the rows that existed when the walk began, in order, once each.
  assert.deepEqual(seen, start);
  assert.equal(new Set(seen.map((row) => `${row.blockNumber}:${row.logIndex}`)).size, seen.length);
});

test("the same walk under an offset cursor both repeats and skips rows", () => {
  const table: LogPosition[] = [
    { blockNumber: 100, logIndex: 0 },
    { blockNumber: 101, logIndex: 3 },
    { blockNumber: 101, logIndex: 1 },
    { blockNumber: 102, logIndex: 0 },
    { blockNumber: 103, logIndex: 9 },
    { blockNumber: 103, logIndex: 2 },
  ];
  const start = [...table].sort(descending);

  const pageSize = 2;
  const seen: LogPosition[] = [];
  for (let offset = 0; offset < 6; offset += pageSize) {
    seen.push(...offsetPage(table, offset, pageSize));
    table.push({ blockNumber: 200 + offset, logIndex: 0 });
  }

  const keys = seen.map((row) => `${row.blockNumber}:${row.logIndex}`);
  // This is the bug the keyset cursor exists to avoid, demonstrated rather than
  // asserted: a row is served twice and a row is never served at all.
  assert.notDeepEqual(seen, start);
  assert.notEqual(new Set(keys).size, keys.length);
  const missed = start.filter(
    (row) => !keys.includes(`${row.blockNumber}:${row.logIndex}`),
  );
  assert.ok(missed.length > 0, "an offset walk should have skipped at least one row");
});
