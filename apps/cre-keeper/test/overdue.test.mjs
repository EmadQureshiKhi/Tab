import assert from "node:assert/strict";
import { test } from "node:test";

import { decideMarks, parseOverdue } from "../dist/overdue.js";

const id = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const tab = (n, over = {}) => ({
  tabId: id(n),
  agent: `0x${"a".repeat(40)}`,
  serviceId: id(99),
  asset: `0x${"b".repeat(40)}`,
  openBaseUnits: "10000",
  prepaidBaseUnits: "0",
  oldestUnsettledAt: 1,
  lastDeliveryAt: 2,
  deliveryCount: 1,
  delinquent: false,
  settlementWindowSeconds: 21600,
  windowEnd: 1_000 + n,
  secondsUntilWindowEnd: -60 - n,
  markable: true,
  ...over,
});
const body = (overdue, pending = []) => ({ at: { blockNumber: 100, timestamp: 2_000 }, candidates: overdue.length + pending.length, feed: { rows: 1, pages: 1 }, overdue, pending });

test("parseOverdue reads the keeper's shape and lower-cases every id", () => {
  const parsed = parseOverdue(body([tab(1, { tabId: id(1).toUpperCase().replace("0X", "0x") })], [tab(2)]));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);
  assert.deepEqual(parsed.value.at, { blockNumber: 100, timestamp: 2_000 });
  assert.equal(parsed.value.candidates, 2);
  assert.equal(parsed.value.pendingCount, 1);
  assert.equal(parsed.value.overdue[0].tabId, id(1));
});

test("parseOverdue refuses an answer that is missing what a verdict needs", () => {
  assert.equal(parseOverdue(null).error.code, "OVERDUE_MALFORMED");
  assert.equal(parseOverdue({ overdue: [], pending: [] }).error.code, "OVERDUE_MALFORMED");
  assert.equal(parseOverdue({ at: { blockNumber: 1, timestamp: 1 }, overdue: [{ tabId: "x" }], pending: [] }).error.code, "OVERDUE_MALFORMED");
  assert.equal(parseOverdue({ at: { blockNumber: 1, timestamp: 1 }, overdue: [{ ...tab(1), windowEnd: "soon" }], pending: [] }).error.code, "OVERDUE_MALFORMED");
  assert.equal(parseOverdue({ at: { blockNumber: 1, timestamp: 1 }, overdue: [{ ...tab(1), openBaseUnits: 5 }], pending: [] }).error.code, "OVERDUE_MALFORMED");
});

test("decideMarks asks for the markable tabs oldest first, declines the rest by reason, and caps", () => {
  const snapshot = parseOverdue(
    body([
      tab(3),
      tab(1),
      tab(2),
      tab(4, { delinquent: true }),
      tab(5, { markable: false }),
      tab(6, { openBaseUnits: "0" }),
      tab(7, { secondsUntilWindowEnd: 5 }),
      tab(1),
    ]),
  ).value;
  const decision = decideMarks(snapshot, { maxMarks: 2 });
  assert.deepEqual(decision.tabIds, [id(1), id(2)]);
  assert.equal(decision.deferred, 1);
  assert.deepEqual(
    decision.declined.map((entry) => [entry.tabId, entry.reason]),
    [
      [id(4), "already marked"],
      [id(5), "the keeper did not judge it markable"],
      [id(6), "nothing is open"],
      [id(7), "the Settlement Window has not closed"],
    ],
  );
  assert.deepEqual(decideMarks(snapshot, { maxMarks: 0 }).tabIds, []);
  assert.deepEqual(decideMarks(parseOverdue(body([])).value, { maxMarks: 25 }), { tabIds: [], declined: [], deferred: 0 });
});

test("the decision is the same whatever order the keeper listed the tabs in", () => {
  const a = decideMarks(parseOverdue(body([tab(2), tab(1), tab(3)])).value, { maxMarks: 25 });
  const b = decideMarks(parseOverdue(body([tab(3), tab(2), tab(1)])).value, { maxMarks: 25 });
  assert.deepEqual(a, b);
});
