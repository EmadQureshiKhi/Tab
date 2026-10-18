/**
 * The credit curve is LimitLib itself with the time moved: every point must be
 * exactly what `creditLimit` returns at that moment over the records settled by
 * then, the last point must be the limit now, and an Agent paying curated,
 * bonded Services on time must see the curve rise as those repayments age.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type BondEntry, type SettlementRecord, CURVE_MAX_POINTS, creditCurve, creditLimit } from "../src/credit.js";

const ASSET = "0x480209747417f5c830fda188a9b9acfa70bc4083";
const DAY = 86_400n;
const T0 = 1_790_000_000n;
const SERVICES = ["0x" + "a1".repeat(32), "0x" + "b2".repeat(32), "0x" + "c3".repeat(32)];
const bonds: BondEntry[] = SERVICES.map((serviceId) => ({ serviceId, asset: ASSET, amount: 50_000_000n }));
const params = { asset: ASSET, baseline: 5_000_000n, growthFactorBps: 40_000n };

const record = (service: number, amount: bigint, settledAt: bigint): SettlementRecord => ({
  serviceId: SERVICES[service] ?? SERVICES[0]!,
  asset: ASSET,
  amount,
  settledAt,
  firstDeliveryAt: settledAt - 60n,
  curated: true,
  bonded: true,
});

const history = [record(0, 2_000_000n, T0), record(1, 2_000_000n, T0 + DAY), record(2, 2_000_000n, T0 + 2n * DAY)];

test("every point is creditLimit at that moment over the records settled by then, and the last is the limit now", () => {
  const now = T0 + 20n * DAY;
  const points = creditCurve(history, bonds, params, now);
  for (const point of points) {
    const prefix = history.filter((r) => r.settledAt <= point.at);
    assert.equal(point.limit, creditLimit(prefix, bonds, { ...params, evaluatedAt: point.at }), `point at ${point.at}`);
    assert.equal(point.settlements, prefix.length);
  }
  const last = points.at(-1)!;
  assert.equal(last.kind, "now");
  assert.equal(last.at, now);
  assert.equal(last.limit, creditLimit(history, bonds, { ...params, evaluatedAt: now }));
});

test("the curve starts before the first Settlement, marks each one, and is in time order", () => {
  const points = creditCurve(history, bonds, params, T0 + 10n * DAY);
  assert.equal(points[0]?.kind, "start");
  assert.equal(points[0]?.settlements, 0);
  assert.equal(points.filter((p) => p.kind === "settlement").length, 3);
  for (let i = 1; i < points.length; i += 1) assert.ok(points[i]!.at > points[i - 1]!.at, "strictly later");
  assert.ok(points.length <= CURVE_MAX_POINTS);
});

test("repaying three curated, bonded Services on time grows the limit as the repayments age", () => {
  const points = creditCurve(history, bonds, params, T0 + 30n * DAY);
  const start = points[0]!.limit;
  const end = points.at(-1)!.limit;
  assert.ok(end > start, `the limit rose from ${start} to ${end}`);
  const aging = points.filter((p) => p.kind === "aging" && p.at > T0 + 2n * DAY);
  for (let i = 1; i < aging.length; i += 1) assert.ok(aging[i]!.limit >= aging[i - 1]!.limit, "aging alone never lowers it");
});

test("with no Settlement there is one point, the limit now, and a record from the future is not counted", () => {
  const empty = creditCurve([], bonds, params, T0);
  assert.deepEqual(empty.map((p) => p.kind), ["now"]);
  assert.equal(empty[0]!.limit, creditLimit([], bonds, { ...params, evaluatedAt: T0 }));
  const withFuture = creditCurve([...history, record(0, 9_000_000n, T0 + 100n * DAY)], bonds, params, T0 + 5n * DAY);
  assert.equal(withFuture.at(-1)!.settlements, 3);
});

test("a long history is drawn within the point budget, keeping the most recent Settlements", () => {
  const long = Array.from({ length: 300 }, (_, i) => record(i % 3, 10_000n, T0 + BigInt(i) * 3_600n));
  const points = creditCurve(long, bonds, params, T0 + 400n * 3_600n);
  assert.ok(points.length <= CURVE_MAX_POINTS, `${points.length} points`);
  assert.equal(points.at(-1)!.settlements, 300);
  assert.equal(points.filter((p) => p.kind === "settlement").at(-1)!.at, T0 + 299n * 3_600n);
});
