/**
 * The attestation wait.
 *
 * The loop is driven with an injected clock and an injected sleep, so the
 * documented 13-to-15-minute wait is exercised in microseconds and the deadline is
 * asserted rather than waited out.
 *
 * Run against the built output, so what is tested is what the pipeline imports.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTESTATION_POLL_INTERVAL_MS,
  ATTESTATION_STRIDE_BLOCKS,
  ATTESTATION_WAIT_TIMEOUT_MS,
  CLIENT_LIBRARY_WAIT_DEFAULT_TIMEOUT_MS,
  MAINNET_ATTESTATION_WAIT_LOWER_MS,
  MAINNET_ATTESTATION_WAIT_UPPER_MS,
  PRECOMPILE_NAMES_THAT_DO_NOT_EXIST,
  coversHeight,
  nextEndpointAtOrAbove,
  waitUntilHeightAttested,
} from "../dist/attestation.js";

const frontier = (height, overrides = {}) => ({
  height,
  digest: `0x${"ab".repeat(32)}`,
  isAttestation: true,
  exists: true,
  ...overrides,
});

/**
 * A reader whose frontier follows a script, one entry per poll. The last entry
 * repeats, so a test can say "it never catches up" without listing forever.
 */
function scriptedReader(script) {
  const reads = [];
  return {
    reads,
    async getSupportedChains() {
      throw new Error("not used");
    },
    async getLatestAttestation(chainKey) {
      const entry = script[Math.min(reads.length, script.length - 1)];
      reads.push({ chainKey, entry });
      return entry;
    },
  };
}

/** A clock that advances only when the wait sleeps, so elapsed time is exact. */
function fakeClock() {
  let ms = 0;
  return {
    now: () => ms,
    sleep: async (waited) => {
      ms += waited;
    },
    slept: () => ms,
  };
}

test("the documented Mainnet wait is 13 to 15 minutes, and the timeout is the upper end", () => {
  assert.equal(MAINNET_ATTESTATION_WAIT_LOWER_MS, 13 * 60 * 1000);
  assert.equal(MAINNET_ATTESTATION_WAIT_UPPER_MS, 15 * 60 * 1000);
  assert.equal(ATTESTATION_WAIT_TIMEOUT_MS, MAINNET_ATTESTATION_WAIT_UPPER_MS);
  // The measured head-to-attested lag was 7 to 8.6 minutes. The timeout must not
  // have been tuned down to it on the strength of one day's samples.
  assert.ok(ATTESTATION_WAIT_TIMEOUT_MS > 9 * 60 * 1000);
  // The pinned client library's own precompile-backed wait defaults to one minute,
  // which is the trap this module exists partly to avoid.
  assert.equal(CLIENT_LIBRARY_WAIT_DEFAULT_TIMEOUT_MS, 60 * 1000);
  assert.ok(ATTESTATION_WAIT_TIMEOUT_MS > CLIENT_LIBRARY_WAIT_DEFAULT_TIMEOUT_MS * 10);
});

test("`waitUntilHeightAttested` is recorded as absent from the precompile", () => {
  const names = Object.keys(PRECOMPILE_NAMES_THAT_DO_NOT_EXIST);
  assert.ok(names.includes("waitUntilHeightAttested(uint64,uint64)"));
  assert.equal(
    PRECOMPILE_NAMES_THAT_DO_NOT_EXIST["waitUntilHeightAttested(uint64,uint64)"].selector,
    "0xce6400cd",
  );
  for (const name of names) {
    assert.match(PRECOMPILE_NAMES_THAT_DO_NOT_EXIST[name].instead, /\S/);
  }
});

test("coverage asks whether the frontier reaches the height, not whether it equals it", () => {
  // Attestations land on a stride of 10, so a Settlement almost never sits on an
  // endpoint. Equality would refuse nine heights in ten.
  assert.equal(coversHeight(frontier(100n), 97n), true);
  assert.equal(coversHeight(frontier(100n), 100n), true);
  assert.equal(coversHeight(frontier(100n), 101n), false);
});

test("a checkpoint is not a frontier, and no record is not a low frontier", () => {
  assert.equal(coversHeight(frontier(100n, { isAttestation: false }), 50n), false);
  assert.equal(coversHeight(frontier(100n, { exists: false }), 50n), false);
});

test("the next endpoint sits on the measured stride", () => {
  assert.equal(ATTESTATION_STRIDE_BLOCKS, 10n);
  assert.equal(nextEndpointAtOrAbove(25876970n), 25876970n);
  assert.equal(nextEndpointAtOrAbove(25876971n), 25876980n);
  assert.equal(nextEndpointAtOrAbove(25876979n), 25876980n);
});

test("a height already covered returns on the first poll with no sleep", async () => {
  const clock = fakeClock();
  const reader = scriptedReader([{ ok: true, value: frontier(1000n) }]);
  const wait = await waitUntilHeightAttested(reader, 3, 900n, {
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(wait.ok, true);
  assert.equal(wait.value.outcome, "ATTESTED");
  assert.equal(wait.value.polls, 1);
  assert.equal(clock.slept(), 0);
  assert.equal(reader.reads.length, 1);
  assert.equal(reader.reads[0].chainKey, 3n, "the chainKey is widened to uint64 for the call");
});

test("the wait polls until the frontier reaches the height", async () => {
  const clock = fakeClock();
  const reader = scriptedReader([
    { ok: true, value: frontier(880n) },
    { ok: true, value: frontier(890n) },
    { ok: true, value: frontier(900n) },
  ]);
  const wait = await waitUntilHeightAttested(reader, 3, 900n, {
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(wait.ok, true);
  assert.equal(wait.value.outcome, "ATTESTED");
  assert.equal(wait.value.polls, 3);
  assert.equal(clock.slept(), 2 * ATTESTATION_POLL_INTERVAL_MS);
});

test("a frontier that never catches up times out at the deadline", async () => {
  const clock = fakeClock();
  const reader = scriptedReader([{ ok: true, value: frontier(800n) }]);
  const wait = await waitUntilHeightAttested(reader, 3, 1_000n, {
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(wait.ok, true);
  assert.equal(wait.value.outcome, "TIMED_OUT");
  assert.equal(wait.value.frontier.height, 800n);
  assert.equal(wait.value.expectedEndpoint, 1_000n);
  assert.equal(clock.slept(), ATTESTATION_WAIT_TIMEOUT_MS);
  assert.ok(wait.value.detail.includes("1000"));
});

test("a chain carrying only a checkpoint reports NOT_ATTESTING, not a timeout", async () => {
  const clock = fakeClock();
  const reader = scriptedReader([{ ok: true, value: frontier(2_000n, { isAttestation: false }) }]);
  const wait = await waitUntilHeightAttested(reader, 3, 1_000n, {
    timeoutMs: 60_000,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(wait.ok, true);
  assert.equal(wait.value.outcome, "NOT_ATTESTING");
  assert.ok(wait.value.detail.includes("checkpoint"));
});

test("a read failure does not end the wait, but a wait with no successful read fails", async () => {
  const clock = fakeClock();
  const transient = {
    ok: false,
    error: { category: "UPSTREAM", code: "CHAININFO_READ_FAILED", message: "endpoint hiccup", retryable: true },
  };
  const recovering = scriptedReader([transient, { ok: true, value: frontier(1_000n) }]);
  const recovered = await waitUntilHeightAttested(recovering, 3, 900n, {
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.value.outcome, "ATTESTED");
  assert.equal(recovered.value.polls, 2);

  const blind = scriptedReader([transient]);
  const failed = await waitUntilHeightAttested(blind, 3, 900n, {
    timeoutMs: 60_000,
    sleep: fakeClock().sleep,
    now: (() => {
      let ms = 0;
      return () => (ms += 30_000);
    })(),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "ATTESTATION_FRONTIER_UNREADABLE");
  assert.equal(failed.error.retryable, true);
});

test("corroboration holds the gate until the service has caught up too", async () => {
  const clock = fakeClock();
  const heights = [800n, 900n];
  const corroborator = {
    id: "the Proof Builder",
    async latestAttestedHeight() {
      return { ok: true, value: heights.shift() ?? 900n };
    },
  };
  const reader = scriptedReader([{ ok: true, value: frontier(1_000n) }]);
  const wait = await waitUntilHeightAttested(reader, 3, 900n, {
    corroborator,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(wait.ok, true);
  assert.equal(wait.value.outcome, "ATTESTED");
  // The chain said yes on poll 1; the service had only reached 800, so the wait
  // kept going rather than asking for material that does not exist yet.
  assert.equal(wait.value.polls, 2);
  assert.equal(wait.value.corroboratedHeight, 900n);
});

test("a corroboration read that fails is a not-yet, never an error", async () => {
  const clock = fakeClock();
  let calls = 0;
  const corroborator = {
    id: "the Proof Builder",
    async latestAttestedHeight() {
      calls += 1;
      return calls === 1
        ? { ok: false, error: { category: "UPSTREAM", code: "PROOF_BUILDER_TIMEOUT", message: "slow", retryable: true } }
        : { ok: true, value: 900n };
    },
  };
  const reader = scriptedReader([{ ok: true, value: frontier(1_000n) }]);
  const wait = await waitUntilHeightAttested(reader, 3, 900n, {
    corroborator,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(wait.ok, true);
  assert.equal(wait.value.outcome, "ATTESTED");
  assert.equal(wait.value.polls, 2);
});
