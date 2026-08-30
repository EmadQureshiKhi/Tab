/**
 * Settlement state machine.
 *
 * Run against the built output, so what is tested is what the pipeline imports.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAIMED_STATES,
  LEGAL_TRANSITIONS,
  SETTLEMENT_STATES,
  TERMINAL_STATES,
  canTransition,
  isClaimedState,
  isSettlementState,
  isTerminalState,
  legalTransitionPairs,
  proofQueueOf,
} from "../dist/index.js";

test("the state set is exactly the seven states the schema stores", () => {
  assert.deepEqual(SETTLEMENT_STATES, [
    "OBSERVED",
    "PROVISIONAL",
    "READY",
    "SUBMITTED",
    "CONFIRMED",
    "WITHHELD",
    "HALTED",
  ]);
});

test("every state has a transition list, and every target is a state", () => {
  for (const state of SETTLEMENT_STATES) {
    const targets = LEGAL_TRANSITIONS[state];
    assert.ok(Array.isArray(targets), `${state} has no transition list`);
    for (const target of targets) {
      assert.ok(isSettlementState(target), `${state} -> ${target} names a state that does not exist`);
      assert.notEqual(target, state, `${state} lists itself; self-transitions are implicit`);
    }
  }
});

test("the terminal states are the two the automated pipeline cannot leave", () => {
  assert.deepEqual([...TERMINAL_STATES], ["CONFIRMED", "HALTED"]);
  for (const state of TERMINAL_STATES) {
    assert.equal(LEGAL_TRANSITIONS[state].length, 0);
    assert.equal(isTerminalState(state), true);
  }
  for (const state of SETTLEMENT_STATES.filter((s) => !TERMINAL_STATES.includes(s))) {
    assert.equal(isTerminalState(state), false, `${state} must not be terminal`);
  }
});

test("the happy path is reachable end to end", () => {
  const path = ["OBSERVED", "PROVISIONAL", "READY", "SUBMITTED", "CONFIRMED"];
  for (let i = 0; i + 1 < path.length; i += 1) {
    assert.equal(canTransition(path[i], path[i + 1]), true, `${path[i]} -> ${path[i + 1]}`);
  }
});

test("crash recovery may return a submitted settlement to READY", () => {
  // Design 8.6: the replay key was written before the broadcast, so re-submitting
  // under the same key cannot double-spend.
  assert.equal(canTransition("SUBMITTED", "READY"), true);
});

test("a withheld settlement may be retried through the alternate builder", () => {
  assert.equal(canTransition("WITHHELD", "READY"), true);
  assert.equal(canTransition("WITHHELD", "HALTED"), true);
  assert.equal(canTransition("WITHHELD", "SUBMITTED"), false);
});

test("nothing leaves CONFIRMED, and nothing rewinds past submission", () => {
  for (const target of SETTLEMENT_STATES) {
    // The self-transition is the documented no-op and is excluded on purpose.
    if (target !== "CONFIRMED") {
      assert.equal(canTransition("CONFIRMED", target), false, `CONFIRMED -> ${target}`);
    }
    if (target !== "HALTED") {
      assert.equal(canTransition("HALTED", target), false, `HALTED -> ${target}`);
    }
  }
  assert.equal(canTransition("CONFIRMED", "SUBMITTED"), false);
  assert.equal(canTransition("SUBMITTED", "OBSERVED"), false);
  // Reachable without passing through SUBMITTED: recovery returned the row to READY
  // on an unclaimed read, the abandoned submission then mined, and the next sweep
  // settles the row from `claimedLog` (design section 8.6). Found by Property 13.
  assert.equal(canTransition("READY", "CONFIRMED"), true);
  assert.equal(canTransition("READY", "OBSERVED"), false);
  assert.equal(canTransition("READY", "PROVISIONAL"), false);
});

test("a duplicate observation is absorbed rather than rejected", () => {
  for (const state of SETTLEMENT_STATES) {
    assert.equal(canTransition(state, state), true, `${state} -> ${state} must be a no-op`);
  }
});

test("the claimed set is what skips a second submission", () => {
  assert.deepEqual([...CLAIMED_STATES], ["SUBMITTED", "CONFIRMED"]);
  assert.equal(isClaimedState("SUBMITTED"), true);
  assert.equal(isClaimedState("CONFIRMED"), true);
  assert.equal(isClaimedState("READY"), false);
  assert.equal(isClaimedState("WITHHELD"), false);
});

test("isSettlementState refuses anything that is not one of the seven", () => {
  assert.equal(isSettlementState("OBSERVED"), true);
  assert.equal(isSettlementState("observed"), false);
  assert.equal(isSettlementState(""), false);
  assert.equal(isSettlementState(undefined), false);
  assert.equal(isSettlementState(0), false);
});

test("every legal pair is reachable and no pair is listed twice", () => {
  const pairs = legalTransitionPairs();
  const seen = new Set();
  for (const [from, to] of pairs) {
    const key = `${from}->${to}`;
    assert.equal(seen.has(key), false, `${key} is listed twice`);
    seen.add(key);
    assert.equal(canTransition(from, to), true);
  }
  // 4 + 3 + 4 + 3 + 0 + 2 + 0
  assert.equal(pairs.length, 16);
});

// ------------------------------------------------------------------ the proof queue

test("a pass proves the rows it has never proved and the rows left READY behind it", () => {
  // The defect this covers: `READY` rows were counted and never re-proved, so the
  // planner drew from that pass's newly proved rows alone and a row that reached
  // READY without being submitted was stranded for good. Seen live as two rows
  // sitting READY through repeated passes while the planner reported no plans.
  const queue = proofQueueOf(
    [{ replayKey: "0xaa" }, { replayKey: "0xbb" }],
    [{ replayKey: "0xcc", attempts: 3 }],
    (row) => row.replayKey,
  );
  assert.deepEqual(
    queue.map((entry) => [entry.row.replayKey, entry.attempts]),
    [
      ["0xaa", 0],
      ["0xbb", 0],
      ["0xcc", 3],
    ],
  );
});

test("a rejoining row carries its attempt count, so its backoff continues", () => {
  const queue = proofQueueOf([], [{ replayKey: "0xcc", attempts: 7 }], (row) => row.replayKey);
  assert.equal(queue[0].attempts, 7);
});

test("a row in both lists is queued once, so a pass never pays for one proof twice", () => {
  const queue = proofQueueOf(
    [{ replayKey: "0xaa" }],
    [{ replayKey: "0xaa", attempts: 4 }],
    (row) => row.replayKey,
  );
  assert.equal(queue.length, 1);
  assert.equal(queue[0].attempts, 0, "the pending side wins, because it is the fresher record");
});

test("a repeat inside one list is queued once too", () => {
  const queue = proofQueueOf(
    [{ replayKey: "0xaa" }, { replayKey: "0xaa" }],
    [],
    (row) => row.replayKey,
  );
  assert.equal(queue.length, 1);
});

test("two empty lists queue nothing rather than failing", () => {
  assert.deepEqual(proofQueueOf([], [], (row) => row.replayKey), []);
});
