/**
 * Feature: tab, Property 13: Watcher submission idempotence and progress
 *
 * **Validates: Requirements 20.3, 20.6, 20.7, 20.8, 20.9, 20.10, 20.11**
 *
 * The Watcher is the only component that spends CTC, and the thing that must never
 * happen is paying twice for one log. A replay key is claimed exactly once on chain,
 * so a second submission of a claimed key does not double-credit anybody, it burns
 * gas on a certain revert. Every guard below exists to keep that from happening, and
 * this property is what checks the guards hold together rather than one at a time.
 *
 * The system under test is real. `submitBatch` and `reconcileSubmitted` are the
 * shipped functions, driven through their injected seams: a fake verifier that owns
 * the set of claimed keys, and a fake row store that enforces the same
 * `ON CONFLICT DO NOTHING` contract Postgres does. Nothing about the state machine
 * is reimplemented here, which is the point. A model that re-encoded the transition
 * table would agree with a bug in it.
 *
 * The commands are the six ways the world interferes, as the task names them:
 * `Restart`, `DuplicateObservation`, `EndpointFailure`, `BuilderFailure`,
 * `Broadcast`, and `CrashBeforeBroadcast`. `CrashBeforeBroadcast` is the sharpest of
 * them. R20.9 says the row is written `SUBMITTED` before the broadcast, never after,
 * and the reason is exactly this interleaving: a process that died between the write
 * and the send leaves a row claiming a submission that never happened. Recovery must
 * resolve that from the chain, through `claimedLog`, and not from anything the dead
 * process believed. So the fake chain deliberately does not claim the key, and the
 * following `Restart` has to return the row to `READY` rather than confirm it.
 *
 * The invariants are checked after every single command, not at the end, because a
 * double claim that is later reconciled away would pass an end-state check and is
 * still money spent twice.
 *
 * The file name carries `.test.mjs` rather than the `.property.ts` the task text
 * names, for the same reason `root-derivation.property.test.mjs` does: the package's
 * test script globs `test/*.test.mjs`, so a file outside that glob is a file nobody
 * runs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import { canTransition } from "../dist/state.js";
import { reconcileSubmitted, submitBatch } from "../dist/submission.js";

const NUM_RUNS = 200;

/** The universe of replay keys a run draws from. Small, so collisions are frequent. */
const KEYS = ["0xaa", "0xbb", "0xcc", "0xdd"].map((prefix) => prefix.padEnd(66, "0"));

/** Revert data the fake verifier hands back, keyed by the error the ABI decodes to. */
const REVERTS = {
  // AlreadyClaimed(bytes32) -> RECONCILE
  AlreadyClaimed: "0x8f3dbb3b" + "00".repeat(32),
  // ProofRejected(string) -> RETRY_ALTERNATE_BUILDER
  ProofRejected: "0xa0b4f6d1" + "00".repeat(32),
};

/**
 * A revert the classifier will read as the named action.
 *
 * The selectors above are placeholders rather than real ones, so rather than depend
 * on them decoding, the fake returns a fully built `SubmissionRefusal`. The classifier
 * has its own unit tests; what is under test here is what the sweep does with an
 * action, not how the action was derived from calldata.
 */
const refusalOf = (action, errorName) => ({
  action,
  errorName,
  args: [],
  raw: REVERTS[errorName],
  recognised: true,
  detail: `${errorName} refuses with ${action}`,
});

/** The chain: which replay keys are claimed, and how many times each was claimed. */
function createChain() {
  const claimed = new Set();
  const claimCount = new Map();
  return {
    claimed,
    claimCount,
    /** A broadcast lands. Claiming an already-claimed key is the failure this hunts. */
    land(keys) {
      for (const key of keys) {
        claimCount.set(key, (claimCount.get(key) ?? 0) + 1);
        claimed.add(key);
      }
    },
    doubleClaimed() {
      return [...claimCount.entries()].filter(([, count]) => count > 1).map(([key]) => key);
    },
  };
}

/**
 * The row store.
 *
 * `observe` mirrors `recordObservations`: insert when absent, and on a collision do
 * nothing at all rather than update. A row already in flight carries a clearing, proof
 * material and a submission that a re-observation knows nothing about, so an
 * "update on conflict" would quietly reset it (R20.6, R20.7).
 *
 * Every other write goes through `transition`, which asserts the move is legal. That
 * is the model's one piece of borrowed judgement, and it borrows it from the shipped
 * `canTransition` rather than from a second copy of the table.
 */
function createStore(violations) {
  const rows = new Map();
  const history = [];
  const transition = (key, next, patch = {}) => {
    const row = rows.get(key);
    if (row === undefined) {
      violations.push(`write to unknown row ${key}`);
      return;
    }
    if (row.state !== next && !canTransition(row.state, next)) {
      violations.push(`illegal transition ${row.state} -> ${next} for ${key}`);
      return;
    }
    history.push({ key, from: row.state, to: next });
    rows.set(key, { ...row, ...patch, state: next });
  };
  return {
    rows,
    history,
    transition,
    observe(key) {
      if (rows.has(key)) return { inserted: 0 };
      rows.set(key, { state: "OBSERVED", attempts: 0, ccTxHash: undefined, badMaterial: false });
      return { inserted: 1 };
    },
    byState(state) {
      return [...rows.entries()].filter(([, row]) => row.state === state).map(([key]) => key);
    },
  };
}

/**
 * The verifier the sweep talks to.
 *
 * `endpointDown` makes every call fail the way a dead RPC endpoint does, with no
 * revert data, which is what the classifier reads as a transport failure and retries
 * on the schedule (R20.10, R20.11).
 */
function createClient(chain, store, control, marks) {
  const upstream = () => ({
    ok: false,
    error: { category: "UPSTREAM", code: "RPC_UNAVAILABLE", message: "endpoint down", retryable: true },
  });
  return {
    address: "0x" + "11".repeat(20),
    async claimedLog(key) {
      if (control.endpointDown) return upstream();
      return { ok: true, value: chain.claimed.has(key) };
    },
    async simulate(materials, _from) {
      if (control.endpointDown) return upstream();
      for (const material of materials) {
        const key = material.replayKey;
        if (chain.claimed.has(key)) {
          return { ok: true, value: { accepted: false, ingestedLogs: undefined, refusal: refusalOf("RECONCILE", "AlreadyClaimed") } };
        }
        if (store.rows.get(key)?.badMaterial === true) {
          return { ok: true, value: { accepted: false, ingestedLogs: undefined, refusal: refusalOf("RETRY_ALTERNATE_BUILDER", "ProofRejected") } };
        }
      }
      return { ok: true, value: { accepted: true, ingestedLogs: BigInt(materials.length), refusal: undefined } };
    },
    async submit(materials) {
      if (control.endpointDown) return upstream();
      const keys = materials.map((material) => material.replayKey);
      // R20.9: nothing may be broadcast that was not written SUBMITTED first.
      for (const key of keys) if (!marks.has(key)) marks.set(key, "BROADCAST_WITHOUT_MARK");
      chain.land(keys);
      return {
        ok: true,
        value: {
          txHash: "0x" + (chain.claimCount.size + 1).toString(16).padStart(64, "0"),
          blockNumber: 1,
          status: 1,
          gasUsed: 100n,
          gasLimit: 200n,
          refusal: undefined,
          recorded: [],
        },
      };
    },
  };
}

/** Build the deps `submitBatch` needs, wired to the store and to the mark ledger. */
function createDeps(client, store, marks, violations) {
  return {
    client,
    from: "0x" + "22".repeat(20),
    submit: true,
    async markSubmitted(keys) {
      for (const key of keys) {
        marks.set(key, "MARKED");
        store.transition(key, "SUBMITTED");
      }
      return { ok: true, value: keys.length };
    },
    async recordOutcome(record) {
      if (record.state === "CONFIRMED" && !client.address.startsWith("0x")) return { ok: true, value: 0 };
      const row = store.rows.get(record.replayKey);
      if (row !== undefined && row.state === "CONFIRMED" && record.state !== "CONFIRMED") {
        violations.push(`row ${record.replayKey} left CONFIRMED for ${record.state}`);
        return { ok: true, value: 0 };
      }
      store.transition(record.replayKey, record.state, {
        attempts: record.attempts,
        ccTxHash: record.ccTxHash,
      });
      return { ok: true, value: 1 };
    },
    now: () => new Date(0),
    backoff: { baseMs: 1, capMs: 4, factor: 2 },
    random: () => 0.5,
  };
}

/** Everything one run mutates, rebuilt per run so shrinking replays cleanly. */
function createWorld() {
  const violations = [];
  const marks = new Map();
  const chain = createChain();
  const store = createStore(violations);
  const control = { endpointDown: false };
  const client = createClient(chain, store, control, marks);
  const deps = createDeps(client, store, marks, violations);
  return { violations, marks, chain, store, control, client, deps };
}

/** The READY rows a submission sweep would pick up, as `loadSubmissionCandidates` does. */
function candidatesOf(store) {
  return store.byState("READY").map((key) => ({
    replayKey: key,
    material: { replayKey: key },
    attempts: store.rows.get(key).attempts,
  }));
}

/**
 * The invariants, checked after every command.
 *
 * A double claim that is reconciled away afterwards would still be gas spent twice,
 * so this runs between commands rather than at the end of the run.
 */
function checkInvariants(world) {
  assert.deepEqual(world.chain.doubleClaimed(), [], "a replay key was claimed on chain more than once");
  assert.deepEqual(world.violations, [], "an illegal state write was attempted");
  for (const [key, mark] of world.marks) {
    assert.notEqual(mark, "BROADCAST_WITHOUT_MARK", `${key} was broadcast without being written SUBMITTED first`);
  }
  assert.ok(world.store.rows.size <= KEYS.length, "the store grew beyond the distinct keys observed");
  for (const [key, row] of world.store.rows) {
    if (row.state === "CONFIRMED") {
      assert.ok(world.chain.claimed.has(key), `${key} is CONFIRMED but the chain does not hold the claim`);
    }
  }
}

const keyArb = fc.constantFrom(...KEYS);

class ObserveCommand {
  constructor(key) { this.key = key; }
  check() { return true; }
  run(_model, world) {
    world.store.observe(this.key);
    checkInvariants(world);
  }
  toString() { return `Observe(${this.key.slice(0, 6)})`; }
}

class DuplicateObservationCommand {
  constructor(key) { this.key = key; }
  check() { return true; }
  run(_model, world) {
    const before = world.store.rows.get(this.key);
    const result = world.store.observe(this.key);
    const after = world.store.rows.get(this.key);
    if (before !== undefined) {
      assert.equal(result.inserted, 0, "a duplicate observation inserted a second row");
      assert.deepEqual(after, before, "a duplicate observation modified a row already in flight");
    }
    checkInvariants(world);
  }
  toString() { return `DuplicateObservation(${this.key.slice(0, 6)})`; }
}

class ProofReadyCommand {
  constructor(key) { this.key = key; }
  check() { return true; }
  run(_model, world) {
    const row = world.store.rows.get(this.key);
    if (row === undefined) return;
    if (row.state === "OBSERVED" || row.state === "WITHHELD") {
      world.store.rows.set(this.key, { ...row, badMaterial: false });
      world.store.transition(this.key, "READY");
    }
    checkInvariants(world);
  }
  toString() { return `ProofReady(${this.key.slice(0, 6)})`; }
}

class BuilderFailureCommand {
  constructor(key) { this.key = key; }
  check() { return true; }
  run(_model, world) {
    const row = world.store.rows.get(this.key);
    if (row !== undefined) world.store.rows.set(this.key, { ...row, badMaterial: true });
    checkInvariants(world);
  }
  toString() { return `BuilderFailure(${this.key.slice(0, 6)})`; }
}

class EndpointFailureCommand {
  constructor(down) { this.down = down; }
  check() { return true; }
  run(_model, world) {
    world.control.endpointDown = this.down;
    checkInvariants(world);
  }
  toString() { return `EndpointFailure(${this.down})`; }
}

class BroadcastCommand {
  check() { return true; }
  async run(_model, world) {
    const members = candidatesOf(world.store);
    if (members.length === 0) return;
    const report = await submitBatch(world.deps, members);
    if (!report.ok) {
      // A failed sweep must leave no key claimed that was not already claimed. The
      // chain-level invariant below is what proves it.
      checkInvariants(world);
      return;
    }
    for (const outcome of report.value.members) {
      assert.ok(
        ["READY", "SUBMITTED", "CONFIRMED", "WITHHELD", "HALTED"].includes(outcome.state),
        `unexpected outcome state ${outcome.state}`,
      );
    }
    checkInvariants(world);
  }
  toString() { return "Broadcast"; }
}

class CrashBeforeBroadcastCommand {
  check() { return true; }
  async run(_model, world) {
    const members = candidatesOf(world.store);
    if (members.length === 0) return;
    // R20.9's write happens; the send never does. This is the interleaving the
    // whole write-before-broadcast rule exists for.
    await world.deps.markSubmitted(members.map((member) => member.replayKey));
    for (const member of members) {
      assert.equal(
        world.store.rows.get(member.replayKey).state,
        "SUBMITTED",
        "the row was not written SUBMITTED before the broadcast",
      );
      assert.equal(
        world.chain.claimed.has(member.replayKey),
        false,
        "a crash before broadcast must leave the chain untouched",
      );
    }
    checkInvariants(world);
  }
  toString() { return "CrashBeforeBroadcast"; }
}

class RestartCommand {
  check() { return true; }
  async run(_model, world) {
    // R20.8: recovery resolves every in-flight row from the chain, never from
    // anything the dead process believed.
    const rows = world.store.byState("SUBMITTED").map((key) => ({
      replayKey: key,
      attempts: world.store.rows.get(key).attempts,
      ccTxHash: world.store.rows.get(key).ccTxHash,
    }));
    const report = await reconcileSubmitted(world.client, rows, world.deps.recordOutcome);
    for (const key of report.confirmed) {
      assert.ok(world.chain.claimed.has(key), `${key} was confirmed without a claim on chain`);
    }
    for (const key of report.returnedToReady) {
      assert.equal(world.chain.claimed.has(key), false, `${key} returned to READY while claimed on chain`);
    }
    if (!world.control.endpointDown) {
      assert.deepEqual(report.unreadable, [], "a healthy endpoint left a row unresolved");
      assert.equal(world.store.byState("SUBMITTED").length, 0, "a restart left a row stuck in SUBMITTED");
    }
    checkInvariants(world);
  }
  toString() { return "Restart"; }
}

const allCommands = [
  keyArb.map((key) => new ObserveCommand(key)),
  keyArb.map((key) => new DuplicateObservationCommand(key)),
  keyArb.map((key) => new ProofReadyCommand(key)),
  keyArb.map((key) => new BuilderFailureCommand(key)),
  fc.boolean().map((down) => new EndpointFailureCommand(down)),
  fc.constant(new BroadcastCommand()),
  fc.constant(new CrashBeforeBroadcastCommand()),
  fc.constant(new RestartCommand()),
];

test("Property 13: no replay key is ever claimed twice, whatever the interleaving", async () => {
  await fc.assert(
    fc.asyncProperty(fc.commands(allCommands, { maxCommands: 40 }), async (commands) => {
      const world = createWorld();
      await fc.asyncModelRun(() => ({ model: {}, real: world }), commands);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("Property 13: a healthy restart always clears every in-flight row", async () => {
  await fc.assert(
    fc.asyncProperty(fc.commands(allCommands, { maxCommands: 40 }), async (commands) => {
      const world = createWorld();
      await fc.asyncModelRun(() => ({ model: {}, real: world }), commands);

      // Progress: whatever the run did, a restart against a healthy endpoint leaves
      // nothing in flight. A row that could sit in SUBMITTED forever is a row whose
      // replay key can never be spent again, which is a liveness failure even though
      // no money moved.
      world.control.endpointDown = false;
      await new RestartCommand().run({}, world);
      assert.equal(world.store.byState("SUBMITTED").length, 0);
      for (const [key, row] of world.store.rows) {
        assert.equal(
          row.state === "CONFIRMED",
          world.chain.claimed.has(key),
          `${key} disagrees with the chain after recovery`,
        );
      }
    }),
    { numRuns: NUM_RUNS },
  );
});

test("a crash between the SUBMITTED write and the broadcast recovers to READY", async () => {
  const world = createWorld();
  world.store.observe(KEYS[0]);
  world.store.transition(KEYS[0], "READY");

  await new CrashBeforeBroadcastCommand().run({}, world);
  assert.equal(world.store.rows.get(KEYS[0]).state, "SUBMITTED");
  assert.equal(world.chain.claimed.has(KEYS[0]), false, "nothing was broadcast");

  await new RestartCommand().run({}, world);
  assert.equal(
    world.store.rows.get(KEYS[0]).state,
    "READY",
    "an unclaimed key returns to READY under the same replay key",
  );

  await new BroadcastCommand().run({}, world);
  assert.equal(world.store.rows.get(KEYS[0]).state, "CONFIRMED");
  assert.equal(world.chain.claimCount.get(KEYS[0]), 1, "the retry claimed the key exactly once");
});

test("a second sweep over a claimed key reconciles instead of spending again", async () => {
  const world = createWorld();
  world.store.observe(KEYS[0]);
  world.store.transition(KEYS[0], "READY");
  await new BroadcastCommand().run({}, world);
  assert.equal(world.store.rows.get(KEYS[0]).state, "CONFIRMED");

  // Force the row back to READY as a stale process would, then sweep again. The
  // simulation refuses with AlreadyClaimed, which is RECONCILE, so the row settles
  // from `claimedLog` and no second transaction is sent.
  world.store.rows.set(KEYS[0], { ...world.store.rows.get(KEYS[0]), state: "READY" });
  await new BroadcastCommand().run({}, world);
  assert.equal(world.chain.claimCount.get(KEYS[0]), 1, "the claimed key was not broadcast a second time");
  assert.equal(world.store.rows.get(KEYS[0]).state, "CONFIRMED");
});

test("a builder failure withholds rather than spending, and recovers on the alternate", async () => {
  const world = createWorld();
  world.store.observe(KEYS[0]);
  world.store.transition(KEYS[0], "READY");
  await new BuilderFailureCommand(KEYS[0]).run({}, world);

  await new BroadcastCommand().run({}, world);
  assert.equal(world.store.rows.get(KEYS[0]).state, "WITHHELD", "disputed material is withheld, not paid for");
  assert.equal(world.chain.claimed.has(KEYS[0]), false, "no gas was spent on material the Watcher does not trust");

  await new ProofReadyCommand(KEYS[0]).run({}, world);
  await new BroadcastCommand().run({}, world);
  assert.equal(world.store.rows.get(KEYS[0]).state, "CONFIRMED");
  assert.equal(world.chain.claimCount.get(KEYS[0]), 1);
});

test("an endpoint failure leaves the row retryable and claims nothing", async () => {
  const world = createWorld();
  world.store.observe(KEYS[0]);
  world.store.transition(KEYS[0], "READY");
  world.control.endpointDown = true;

  await new BroadcastCommand().run({}, world);
  assert.equal(world.chain.claimed.has(KEYS[0]), false);
  assert.equal(world.store.rows.get(KEYS[0]).state, "READY", "a dead endpoint is transient, not terminal");

  world.control.endpointDown = false;
  await new BroadcastCommand().run({}, world);
  assert.equal(world.store.rows.get(KEYS[0]).state, "CONFIRMED");
  assert.equal(world.chain.claimCount.get(KEYS[0]), 1);
});
