/**
 * The submission retry schedule (R20.10).
 *
 * Every case pins the random source, because a jittered schedule asserted against
 * a real random source is a test that passes most of the time, which is worse than
 * no test at all. The three fixed draws below are the only ones needed: 0 is the
 * bottom of the jitter band, 0.5 the middle, and a value approaching 1 the top.
 *
 * Run against the built output, so what is tested is what the pipeline imports.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BACKOFF,
  backoffDelayMs,
  baseDelayMs,
  isDue,
  nextAttemptAt,
} from "../dist/backoff.js";

const LOW = () => 0;
const MID = () => 0.5;
const HIGH = () => 1 - Number.EPSILON;

test("the schedule is the documented one: 2 seconds, doubling, capped at 5 minutes", () => {
  assert.equal(DEFAULT_BACKOFF.minMs, 2_000);
  assert.equal(DEFAULT_BACKOFF.maxMs, 300_000);
  assert.equal(DEFAULT_BACKOFF.jitterBps, 2_000);
});

test("the base delay doubles per failure and stops at the cap", () => {
  assert.equal(baseDelayMs(1), 2_000);
  assert.equal(baseDelayMs(2), 4_000);
  assert.equal(baseDelayMs(3), 8_000);
  assert.equal(baseDelayMs(4), 16_000);
  assert.equal(baseDelayMs(8), 256_000);
  // 9 doublings would be 512,000, which is past the 5-minute cap.
  assert.equal(baseDelayMs(9), 300_000);
  assert.equal(baseDelayMs(50), 300_000);
});

test("an attempt count below one is read as the first failure rather than as zero delay", () => {
  // A row that has never failed still waits the minimum before its next try; a
  // zero here would turn the schedule into a spin.
  assert.equal(baseDelayMs(0), 2_000);
  assert.equal(baseDelayMs(-5), 2_000);
});

test("a very high attempt count stays inside a safe integer", () => {
  // 2 ** 10_000 is Infinity, and Infinity milliseconds is not a schedule. The
  // exponent is clamped, so the answer is the cap rather than a non-finite number.
  const delay = baseDelayMs(10_000);
  assert.ok(Number.isSafeInteger(delay), "the delay is a safe integer");
  assert.equal(delay, 300_000);
});

test("jitter spans plus or minus 20 percent of the base delay and nothing wider", () => {
  assert.equal(backoffDelayMs(3, DEFAULT_BACKOFF, LOW), 6_400);
  assert.equal(backoffDelayMs(3, DEFAULT_BACKOFF, MID), 8_000);
  assert.equal(backoffDelayMs(3, DEFAULT_BACKOFF, HIGH), 9_600);
});

test("jitter applies at the cap too, so replicas do not converge at 5 minutes", () => {
  // The point of the cap is a ceiling on the wait, not a rendezvous: without
  // jitter here every replica that reached the cap would retry in lockstep forever.
  assert.equal(backoffDelayMs(20, DEFAULT_BACKOFF, LOW), 240_000);
  assert.equal(backoffDelayMs(20, DEFAULT_BACKOFF, HIGH), 360_000);
  assert.notEqual(
    backoffDelayMs(20, DEFAULT_BACKOFF, LOW),
    backoffDelayMs(20, DEFAULT_BACKOFF, HIGH),
  );
});

test("a custom schedule is honoured, so the environment bounds are real", () => {
  const schedule = { minMs: 1_000, maxMs: 4_000, jitterBps: 0 };
  assert.equal(backoffDelayMs(1, schedule, MID), 1_000);
  assert.equal(backoffDelayMs(2, schedule, MID), 2_000);
  assert.equal(backoffDelayMs(3, schedule, MID), 4_000);
  assert.equal(backoffDelayMs(9, schedule, MID), 4_000);
});

test("the next attempt is an instant, computed from the given clock and never from now", () => {
  const now = new Date("2026-09-06T12:00:00.000Z");
  const at = nextAttemptAt(now, 2, DEFAULT_BACKOFF, MID);
  assert.equal(at.toISOString(), "2026-09-06T12:00:04.000Z");
});

test("a row with no schedule is due, and one scheduled ahead is not", () => {
  const now = new Date("2026-09-06T12:00:00.000Z");
  // Never having failed is the state of every fresh row, and it must not wait.
  assert.equal(isDue(null, now), true);
  assert.equal(isDue(undefined, now), true);
  assert.equal(isDue(new Date("2026-09-06T11:59:59.999Z"), now), true);
  // The boundary is inclusive: a row due exactly now is due.
  assert.equal(isDue(now, now), true);
  assert.equal(isDue(new Date("2026-09-06T12:00:00.001Z"), now), false);
});
