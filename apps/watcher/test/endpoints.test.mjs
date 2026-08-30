/**
 * Endpoint rotation (R20.11).
 *
 * The requirement is one sentence and the failure it prevents is not. Measured on
 * the configured Mainnet endpoints: `drpc` served a 125-block `eth_getLogs`
 * window, refused 250, then minutes later refused a one-block request with the
 * same message. The observation scan narrows on a width refusal, so without
 * rotation that endpoint takes the scan down to the one-block floor and stops it,
 * and every later pass repeats the descent. Narrowing cannot recover from an
 * endpoint that has stopped serving; only moving to another one can.
 *
 * The state machine is pure and is tested as such. Persistence is a recorder, and
 * what it asserts is that `endpoint_health` never shows two active endpoints for
 * one chain, because a restart reading two would have no way to choose.
 *
 * Run against the built output, so what is tested is what the pipeline imports.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  activeEndpoint,
  createEndpointRotation,
  createRotationState,
  recordFailure,
  recordSuccess,
  rotate,
} from "../dist/endpoints.js";

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";
const THREE = [A, B, C];

const stateOf = (endpoints = THREE, threshold = 3, activeUrl, failures) =>
  createRotationState(3, endpoints, threshold, activeUrl, failures).value;

/** A `RotationStore` that records every write in order. */
function recorder() {
  const writes = [];
  return {
    writes,
    async record(chainKey, endpointUrl, consecutiveFailures, active) {
      writes.push({ chainKey, endpointUrl, consecutiveFailures, active });
      return { ok: true, value: undefined };
    },
  };
}

test("a chain with no configured endpoint cannot rotate and says so", () => {
  const created = createRotationState(3, [], 3);
  assert.equal(created.ok, false);
  assert.equal(created.error.code, "NO_ENDPOINTS");
});

test("a threshold below one is refused, because it would rotate on every call", () => {
  const created = createRotationState(3, THREE, 0);
  assert.equal(created.ok, false);
  assert.equal(created.error.code, "ENDPOINT_THRESHOLD_INVALID");
});

test("a fresh rotation starts on the first configured endpoint", () => {
  // Priority order is by measured range capability rather than latency, so first
  // means first for a reason and a fresh process must not reorder it.
  assert.equal(activeEndpoint(stateOf()), A);
});

test("a restart resumes on the endpoint it was using, with its failure count", () => {
  // The count surviving a bounce is the point: a process restart must not hand a
  // known-bad endpoint a clean slate.
  const resumed = stateOf(THREE, 3, B, 2);
  assert.equal(activeEndpoint(resumed), B);
  assert.equal(resumed.consecutiveFailures, 2);
});

test("a persisted endpoint that is no longer configured falls back to the first", () => {
  const resumed = stateOf(THREE, 3, "https://removed.example", 2);
  assert.equal(activeEndpoint(resumed), A);
});

test("failures accumulate and the third one rotates", () => {
  let state = stateOf();
  const first = recordFailure(state);
  assert.equal(first.rotated, false);
  assert.equal(first.state.consecutiveFailures, 1);
  assert.equal(activeEndpoint(first.state), A);

  const second = recordFailure(first.state);
  assert.equal(second.rotated, false);
  assert.equal(second.state.consecutiveFailures, 2);
  assert.equal(activeEndpoint(second.state), A);

  const third = recordFailure(second.state);
  assert.equal(third.rotated, true);
  assert.equal(activeEndpoint(third.state), B);
  // The counter resets with the move, so the next endpoint gets its own three.
  assert.equal(third.state.consecutiveFailures, 0);
  assert.equal(third.state.rotations, 1);
});

test("a success clears the counter without moving the endpoint", () => {
  let state = stateOf();
  state = recordFailure(state).state;
  state = recordFailure(state).state;
  assert.equal(state.consecutiveFailures, 2);

  state = recordSuccess(state);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(activeEndpoint(state), A, "a working endpoint is not abandoned");

  // Consecutive means consecutive: two failures then a success then two failures
  // is not three in a row, and must not rotate.
  const next = recordFailure(recordFailure(state).state);
  assert.equal(next.rotated, false);
});

test("rotation wraps, so a chain whose endpoints all failed starts over", () => {
  let state = stateOf(THREE, 1);
  state = recordFailure(state).state;
  assert.equal(activeEndpoint(state), B);
  state = recordFailure(state).state;
  assert.equal(activeEndpoint(state), C);
  state = recordFailure(state).state;
  assert.equal(activeEndpoint(state), A, "the rotation wraps rather than running out");
  assert.equal(state.rotations, 3);
});

test("a single configured endpoint counts failures and never rotates", () => {
  // Rotation needs somewhere to go. The counter still runs so the health endpoint
  // can report the endpoint as failing rather than silently pretending it is fine.
  let step = recordFailure(stateOf([A], 1));
  assert.equal(step.rotated, false);
  assert.equal(activeEndpoint(step.state), A);
  assert.equal(rotate(step.state).activeIndex, 0);
});

test("a rotation writes both endpoints, so one chain never has two active rows", async () => {
  const store = recorder();
  const rotation = createEndpointRotation(stateOf(THREE, 2), store);

  assert.equal(await rotation.failed(), false);
  assert.deepEqual(store.writes, [{ chainKey: 3, endpointUrl: A, consecutiveFailures: 1, active: true }]);

  assert.equal(await rotation.failed(), true);
  // The endpoint that lost the flag is cleared before the one that gained it is
  // set, which is what keeps the invariant true between the two writes.
  assert.deepEqual(store.writes.slice(1), [
    { chainKey: 3, endpointUrl: A, consecutiveFailures: 0, active: false },
    { chainKey: 3, endpointUrl: B, consecutiveFailures: 0, active: true },
  ]);
  assert.equal(rotation.active(), B);
  assert.equal(store.writes.filter((write) => write.active).at(-1).endpointUrl, B);
});

test("a success after a clean run writes nothing, so a healthy pass costs no round trip", async () => {
  const store = recorder();
  const rotation = createEndpointRotation(stateOf(), store);
  await rotation.succeeded();
  assert.deepEqual(store.writes, [], "there was no counter to clear");

  await rotation.failed();
  store.writes.length = 0;
  await rotation.succeeded();
  assert.equal(store.writes.length, 1, "a cleared counter is written once");
  assert.equal(store.writes[0].consecutiveFailures, 0);
});

test("moveOn abandons an endpoint regardless of its count, and reports having somewhere to go", async () => {
  // This is what the observation scan calls when it hits the one-block floor: the
  // endpoint has not failed three times, it has simply stopped being usable.
  const store = recorder();
  const rotation = createEndpointRotation(stateOf(), store);
  assert.equal(await rotation.moveOn(), true);
  assert.equal(rotation.active(), B);

  const alone = createEndpointRotation(stateOf([A]), store);
  assert.equal(await alone.moveOn(), false, "there is nowhere to go");
  assert.equal(alone.active(), A);
});

test("a rotation with no store still works, so a read-only pass needs no database", async () => {
  const rotation = createEndpointRotation(stateOf(THREE, 1));
  assert.equal(await rotation.failed(), true);
  assert.equal(rotation.active(), B);
});
