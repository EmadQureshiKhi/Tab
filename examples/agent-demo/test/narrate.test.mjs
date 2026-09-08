/**
 * The narration, which is part of the deliverable rather than decoration.
 *
 * Two things are pinned here because getting either wrong would misinform
 * somebody reading a live run: an amount is never rounded, and a delta keeps its
 * sign rather than being re-signed into a word like "reduced".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { actHeader, describeDelta, describeVerdict, formatBaseUnits, shortAddress, signed } from "../dist/narrate.js";

const delta = (overrides = {}) => ({
  agent: "0x1F6f797Edc2EECb02BD54009B805fb2E99F80542",
  open: 0n,
  prepaid: 0n,
  deliveryCount: 0,
  authorisationSpent: 0n,
  historyCount: 0,
  walletBalance: 0n,
  smartAccountBalance: 0n,
  quiet: false,
  ...overrides,
});

test("base units are shown exactly, with the integer beside the decimal", () => {
  assert.equal(formatBaseUnits(10_000n, 6, "USDC"), "0.010000 USDC (10000 base units)");
  assert.equal(formatBaseUnits(53_777_000n, 6, "USDC"), "53.777000 USDC (53777000 base units)");
  assert.equal(formatBaseUnits(1n, 6, "USDC"), "0.000001 USDC (1 base units)");
  assert.equal(formatBaseUnits(0n, 6, "USDC"), "0.000000 USDC (0 base units)");
});

test("a negative amount keeps its sign in both renderings", () => {
  assert.equal(formatBaseUnits(-10_000n, 6, "USDC"), "-0.010000 USDC (-10000 base units)");
});

test("a zero-decimal Asset is rendered without a point", () => {
  assert.equal(formatBaseUnits(7n, 0, "PTS"), "7 PTS (7 base units)");
});

test("an address is shortened from both ends, and a short one is left alone", () => {
  assert.equal(shortAddress("0x1F6f797Edc2EECb02BD54009B805fb2E99F80542"), "0x1F6f…0542");
  assert.equal(shortAddress("0x1234"), "0x1234");
});

test("a rise carries a plus and a fall carries its minus", () => {
  assert.equal(signed(5n), "+5");
  assert.equal(signed(-5n), "-5");
  assert.equal(signed(0n), "0");
  assert.equal(signed(3), "+3");
});

test("an act header underlines its own heading", () => {
  const header = actHeader(2, "Buying", "They buy.");
  const [heading, rule] = header.split("\n");
  assert.equal(heading, "Act 2. Buying");
  assert.equal(rule.length, heading.length);
  assert.match(header, /They buy\./);
});

test("a reading with nothing in it says so in one line", () => {
  const lines = describeDelta("Ada", delta({ quiet: true }), 6, "USDC");
  assert.deepEqual(lines, ["  Ada: nothing moved"]);
});

test("only the fields that moved are printed", () => {
  const lines = describeDelta("Ada", delta({ open: -7_000n, historyCount: 1 }), 6, "USDC");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /open tab -7000 = -0\.007000 USDC/);
  assert.match(lines[2], /settlement history entries \+1/);
  assert.equal(lines.some((line) => line.includes("prepaid")), false);
});

test("every field has a line when every field moves", () => {
  const lines = describeDelta(
    "Bex",
    delta({
      open: -1n,
      prepaid: 2n,
      authorisationSpent: 3n,
      walletBalance: -4n,
      smartAccountBalance: -5n,
      deliveryCount: 1,
      historyCount: 1,
    }),
    6,
    "USDC",
  );
  assert.equal(lines.length, 8);
  for (const label of [
    "open tab",
    "prepaid credit",
    "authorisation spent",
    "wallet balance",
    "smart account balance",
    "deliveries",
    "settlement history entries",
  ]) {
    assert.equal(lines.some((line) => line.includes(label)), true, `${label} should appear`);
  }
});

test("a verdict prints its result first and its reasons under it", () => {
  const lines = describeVerdict({
    verdict: "PASS",
    creditLandedOnTopicAgent: true,
    senderAgentUntouched: true,
    reasons: ["one", "two"],
  });
  assert.deepEqual(lines, ["  payer resolution: PASS", "    - one", "    - two"]);
});
