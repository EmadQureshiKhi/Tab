/**
 * Waiting for the Watcher, with the clock, the sleep and the reader injected.
 *
 * The behaviour worth pinning is that a wait reads **before** it sleeps, so a
 * change that had already landed is reported at once, and that running out of
 * time is reported as an unfinished wait rather than as a failure. Attestation
 * lands on a ten-block stride, so a timeout here is ordinary rather than a fault.
 *
 * The loop under test is the real one. Only its reader is substituted, which is
 * why `waitForLedger` takes one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { historyPast, waitFor, waitForLedger } from "../dist/wait.js";

const AGENT = {
  name: "Ada",
  role: "buys proofs",
  creditcoin: "0x1F6f797Edc2EECb02BD54009B805fb2E99F80542",
  ethereum: "0xA302940db97345c5aDAF8dA23Ff46Ae63613d728",
};

/** Nothing in these tests reaches a chain, so the providers and cast are placeholders. */
const PROVIDERS = { creditcoin: undefined, source: undefined };
const CAST = undefined;

const clockFrom = (start) => {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
};

const ledgerWith = (historyCount) => ({
  agent: AGENT.creditcoin,
  tabId: `0x${"11".repeat(32)}`,
  open: 0n,
  prepaid: 0n,
  deliveryCount: 0,
  authorisationCeiling: 0n,
  authorisationSpent: 0n,
  authorisationExpiry: 0,
  authorised: false,
  historyCount,
  historyCommitment: `0x${"22".repeat(32)}`,
  walletBalance: 0n,
  atBlock: 100 + historyCount,
});

test("a change that has already landed is reported on the first reading", async () => {
  const clock = clockFrom(0);
  let reads = 0;
  const result = await waitForLedger(PROVIDERS, CAST, AGENT, historyPast(4), {
    seconds: 60,
    now: clock.now,
    sleep: async () => {
      throw new Error("the loop slept before it read");
    },
    read: async () => {
      reads += 1;
      return ledgerWith(5);
    },
  });
  assert.equal(result.outcome, "OBSERVED");
  assert.equal(result.polls, 1);
  assert.equal(reads, 1);
  assert.equal(result.elapsedMs, 0);
  assert.equal(result.ledger.historyCount, 5);
});

test("a change that lands later is reported when it does", async () => {
  const clock = clockFrom(0);
  let reads = 0;
  const result = await waitForLedger(PROVIDERS, CAST, AGENT, historyPast(4), {
    seconds: 600,
    now: clock.now,
    sleep: async (ms) => {
      assert.equal(ms, 6_000);
      clock.advance(ms);
    },
    read: async () => {
      reads += 1;
      return ledgerWith(reads >= 3 ? 5 : 4);
    },
  });
  assert.equal(result.outcome, "OBSERVED");
  assert.equal(result.polls, 3);
  assert.equal(result.elapsedMs, 12_000);
});

test("the polling interval is configurable and is what the loop sleeps for", async () => {
  const clock = clockFrom(0);
  const slept = [];
  await waitForLedger(PROVIDERS, CAST, AGENT, historyPast(4), {
    seconds: 30,
    intervalSeconds: 2,
    now: clock.now,
    sleep: async (ms) => {
      slept.push(ms);
      clock.advance(ms);
    },
    read: async () => ledgerWith(slept.length >= 2 ? 5 : 4),
  });
  assert.deepEqual(slept, [2_000, 2_000]);
});

test("running out of time is a wait that ended, not a failure", async () => {
  const clock = clockFrom(0);
  const result = await waitForLedger(PROVIDERS, CAST, AGENT, historyPast(4), {
    seconds: 12,
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
    },
    read: async () => ledgerWith(4),
  });
  assert.equal(result.outcome, "TIMED_OUT");
  assert.equal(result.polls, 3);
  assert.equal(result.ledger.historyCount, 4);
  assert.equal(result.elapsedMs, 12_000);
});

test("a zero-second wait still takes one reading before it gives up", async () => {
  const clock = clockFrom(0);
  const result = await waitForLedger(PROVIDERS, CAST, AGENT, historyPast(4), {
    seconds: 0,
    now: clock.now,
    sleep: async () => {
      throw new Error("a zero-second wait should never sleep");
    },
    read: async () => ledgerWith(4),
  });
  assert.equal(result.outcome, "TIMED_OUT");
  assert.equal(result.polls, 1);
});

test("the narration reports each reading it took while waiting", async () => {
  const clock = clockFrom(0);
  const lines = [];
  let reads = 0;
  await waitForLedger(PROVIDERS, CAST, AGENT, historyPast(4), {
    seconds: 600,
    now: clock.now,
    log: (line) => lines.push(line),
    sleep: async (ms) => {
      clock.advance(ms);
    },
    read: async () => {
      reads += 1;
      return ledgerWith(reads >= 3 ? 5 : 4);
    },
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /1 readings so far, block 104/);
  assert.match(lines[1], /2 readings so far/);
});

test("a reading that fails on the transport is retried rather than ending the wait", async () => {
  // A wait can run for twenty minutes across two public RPCs. One of them timing
  // out is an ordinary event over that span, and an earlier version let a single
  // `request timeout` throw out of a run that had already broadcast its Settlement.
  const clock = clockFrom(0);
  const lines = [];
  let reads = 0;
  const result = await waitForLedger(PROVIDERS, CAST, AGENT, historyPast(4), {
    seconds: 600,
    now: clock.now,
    log: (line) => lines.push(line),
    sleep: async (ms) => {
      clock.advance(ms);
    },
    read: async () => {
      reads += 1;
      if (reads <= 2) throw new Error("request timeout");
      return ledgerWith(5);
    },
  });
  assert.equal(result.outcome, "OBSERVED");
  assert.equal(result.readFailures, 2);
  assert.equal(result.polls, 1, "a failed reading is not a poll");
  assert.equal(lines.filter((line) => line.includes("will be retried")).length, 2);
});

test("readings that fail past the deadline end the wait as a timeout, not a throw", async () => {
  const clock = clockFrom(0);
  let reads = 0;
  const result = await waitForLedger(PROVIDERS, CAST, AGENT, historyPast(4), {
    seconds: 12,
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
    },
    read: async () => {
      reads += 1;
      if (reads === 1) return ledgerWith(4);
      throw new Error("request timeout");
    },
  });
  assert.equal(result.outcome, "TIMED_OUT");
  assert.equal(result.readFailures, 2);
  assert.equal(result.ledger.historyCount, 4, "the last reading that succeeded is the one reported");
});

test("the history predicate is strict, so an unchanged count is not settled", () => {
  assert.equal(historyPast(4)(ledgerWith(4)), false);
  assert.equal(historyPast(4)(ledgerWith(5)), true);
  assert.equal(historyPast(0)(ledgerWith(1)), true);
});

// ---------------------------------------------------------------- waitFor

test("waitFor returns the value the moment the producer has one", async () => {
  const clock = clockFrom(0);
  let calls = 0;
  const result = await waitFor(
    async () => {
      calls += 1;
      return calls >= 3 ? { creditedAgent: AGENT.creditcoin } : undefined;
    },
    {
      seconds: 600,
      now: clock.now,
      sleep: async (ms) => {
        clock.advance(ms);
      },
    },
  );
  assert.equal(result.outcome, "OBSERVED");
  assert.equal(result.value.creditedAgent, AGENT.creditcoin);
  assert.equal(result.polls, 3);
  assert.equal(result.elapsedMs, 12_000);
});

test("waitFor times out with no value rather than inventing one", async () => {
  const clock = clockFrom(0);
  const result = await waitFor(async () => undefined, {
    seconds: 12,
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
    },
  });
  assert.equal(result.outcome, "TIMED_OUT");
  assert.equal(result.value, undefined);
  assert.equal(result.polls, 3);
});

test("waitFor retries a failed reading and keeps its own count of them", async () => {
  const clock = clockFrom(0);
  let calls = 0;
  const result = await waitFor(
    async () => {
      calls += 1;
      if (calls <= 2) throw new Error("request timeout");
      return "found";
    },
    {
      seconds: 600,
      now: clock.now,
      sleep: async (ms) => {
        clock.advance(ms);
      },
    },
  );
  assert.equal(result.outcome, "OBSERVED");
  assert.equal(result.value, "found");
  assert.equal(result.readFailures, 2);
  assert.equal(result.polls, 1);
});

test("waitFor narrates through the caller's own description", async () => {
  const clock = clockFrom(0);
  const lines = [];
  let calls = 0;
  await waitFor(
    async () => {
      calls += 1;
      return calls >= 2 ? "found" : undefined;
    },
    {
      seconds: 600,
      now: clock.now,
      log: (line) => lines.push(line),
      sleep: async (ms) => {
        clock.advance(ms);
      },
      describe: (polls) => `  still waiting, poll ${String(polls)}`,
    },
  );
  assert.deepEqual(lines, ["  still waiting, poll 1"]);
});

test("waitFor treats a value the producer legitimately returns as found, including a falsy one", async () => {
  const clock = clockFrom(0);
  const result = await waitFor(async () => 0, { seconds: 60, now: clock.now, sleep: async () => {} });
  assert.equal(result.outcome, "OBSERVED");
  assert.equal(result.value, 0);
});
