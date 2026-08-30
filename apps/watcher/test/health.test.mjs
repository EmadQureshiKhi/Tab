/**
 * The health surface.
 *
 * The interesting cases here are all about honesty rather than routing. A health
 * endpoint that reports zero when it means "I could not find out" is worse than one
 * that reports nothing at all, because a zero pending count reads as a healthy queue
 * and will be believed. So the database is stood in for by a stub that can refuse,
 * and the cases below pin that a refusal arrives as `null` plus a named reason, and
 * that the endpoint still returns 200 with the figures it did obtain.
 *
 * `/readyz` is pinned on the opposite discipline. It must fail closed: a cursor read
 * that could not be answered is not ready, because its whole claim is that every
 * monitored chain has somewhere to resume from and a failed read cannot support it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHealthSnapshot,
  buildReadinessSnapshot,
  readBuildInfo,
  routeHealthRequest,
  startHealthServer,
} from "../dist/index.js";

/**
 * A stand-in for the Drizzle handle.
 *
 * `loadReadCursors` and the two count helpers each build a different query chain, so
 * the stub answers by shape rather than by call order: `.from()` resolves to whatever
 * the scenario queued for that table, and `.where()`/`.groupBy()` keep returning the
 * same thenable so the chain length does not matter.
 */
function stubDb({ cursors = [], byState = [], byClearing = [], fail = null }) {
  let call = -1;
  const answers = [cursors, byState, byClearing];
  const chain = (rows) => {
    const thenable = {
      where: () => thenable,
      groupBy: () => thenable,
      then: (resolve, reject) => (fail === null ? resolve(rows) : reject(new Error(fail))),
    };
    return thenable;
  };
  return {
    select: () => ({
      from: () => {
        call += 1;
        return chain(answers[call] ?? []);
      },
    }),
  };
}

const MONITORED = [1, 3];

test("healthz reports one entry per monitored chain, in chain-key order", async () => {
  const db = stubDb({
    cursors: [
      { chainKey: 3n, lastProcessedBlock: 25917274n, attesting: true },
      { chainKey: 1n, lastProcessedBlock: 11648700n, attesting: true },
    ],
    byState: [
      { state: "OBSERVED", count: 2 },
      { state: "PROVISIONAL", count: 1 },
      { state: "READY", count: 3 },
      { state: "CONFIRMED", count: 4 },
    ],
    byClearing: [
      { state: "APPLIED", count: 1 },
      { state: "CONFIRMED", count: 2 },
    ],
  });
  const snapshot = await buildHealthSnapshot({ db, monitoredChains: MONITORED });

  assert.equal(snapshot.status, "ok");
  assert.deepEqual(
    snapshot.chains.map((chain) => chain.chainKey),
    [1, 3],
    "chains are ordered by chain key, not by insertion",
  );
  assert.equal(snapshot.chains[0].lastProcessedBlock, "11648700");
  assert.equal(typeof snapshot.chains[0].lastProcessedBlock, "string", "heights leave as strings");
  assert.equal(snapshot.pendingSubmissions, 6, "OBSERVED, PROVISIONAL and READY together");
  assert.equal(snapshot.activeProvisionalClearings, 1, "only APPLIED clearings are still exposed");
  assert.equal(snapshot.withheldProofs, 0);
  assert.equal(snapshot.haltedSettlements, 0);
  assert.deepEqual(snapshot.chainsWithoutCursor, []);
  assert.deepEqual(snapshot.unavailable, []);
});

test("healthz counts an absent state as zero, not as missing", async () => {
  const db = stubDb({
    cursors: [{ chainKey: 1n, lastProcessedBlock: 5n, attesting: true }],
    byState: [{ state: "CONFIRMED", count: 1 }],
    byClearing: [],
  });
  const snapshot = await buildHealthSnapshot({ db, monitoredChains: [1] });
  assert.equal(snapshot.pendingSubmissions, 0);
  assert.equal(snapshot.withheldProofs, 0);
  assert.equal(snapshot.activeProvisionalClearings, 0, "an empty clearing table is zero exposure");
});

test("healthz reports a halted Settlement as degraded", async () => {
  const db = stubDb({
    cursors: [{ chainKey: 1n, lastProcessedBlock: 5n, attesting: true }],
    byState: [{ state: "HALTED", count: 1 }],
    byClearing: [],
  });
  const snapshot = await buildHealthSnapshot({ db, monitoredChains: [1] });
  assert.equal(snapshot.haltedSettlements, 1);
  assert.equal(snapshot.status, "degraded", "a row needing a human is not ok");
});

test("healthz reports a monitored chain with no cursor as degraded", async () => {
  const db = stubDb({
    cursors: [{ chainKey: 1n, lastProcessedBlock: 5n, attesting: true }],
    byState: [],
    byClearing: [],
  });
  const snapshot = await buildHealthSnapshot({ db, monitoredChains: MONITORED });
  assert.deepEqual(snapshot.chainsWithoutCursor, [3]);
  assert.equal(snapshot.status, "degraded");
});

test("healthz ignores a cursor for a chain this deployment does not monitor", async () => {
  const db = stubDb({
    cursors: [
      { chainKey: 1n, lastProcessedBlock: 5n, attesting: true },
      { chainKey: 3n, lastProcessedBlock: 9n, attesting: false },
    ],
    byState: [],
    byClearing: [],
  });
  const snapshot = await buildHealthSnapshot({ db, monitoredChains: [1] });
  assert.deepEqual(snapshot.chains.map((chain) => chain.chainKey), [1]);
  assert.deepEqual(snapshot.chainsWithoutCursor, []);
});

test("healthz reports an unobtainable figure as null with a reason, never as zero", async () => {
  const db = stubDb({ fail: "connection refused" });
  const snapshot = await buildHealthSnapshot({ db, monitoredChains: MONITORED });

  assert.equal(snapshot.pendingSubmissions, null, "unknown is not zero");
  assert.equal(snapshot.withheldProofs, null);
  assert.equal(snapshot.haltedSettlements, null);
  assert.equal(snapshot.activeProvisionalClearings, null);
  assert.equal(snapshot.settlementsByState, null);
  assert.equal(snapshot.status, "degraded");
  assert.ok(snapshot.unavailable.length >= 3, "each refused figure names its own reason");
  assert.ok(
    snapshot.unavailable.some((entry) => entry.code === "CHAIN_CURSOR_READ_FAILED"),
    "the cursor failure is named",
  );
  assert.ok(
    snapshot.unavailable.some((entry) => entry.code === "CLEARING_COUNT_FAILED"),
    "the clearing-count failure is named",
  );
  assert.deepEqual(snapshot.chainsWithoutCursor, [], "a failed read is not evidence of a missing cursor");
});

test("healthz still answers 200 when figures are unavailable", async () => {
  const db = stubDb({ fail: "connection refused" });
  const answer = await routeHealthRequest("GET", "/healthz", { db, monitoredChains: MONITORED });
  assert.equal(answer.status, 200, "a description answers even when degraded");
  assert.equal(JSON.parse(answer.body).status, "degraded");
});

test("readyz is ready only when every monitored chain has a cursor", async () => {
  const ready = await buildReadinessSnapshot({
    db: stubDb({
      cursors: [
        { chainKey: 1n, lastProcessedBlock: 5n, attesting: true },
        { chainKey: 3n, lastProcessedBlock: 7n, attesting: true },
      ],
    }),
    monitoredChains: MONITORED,
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.reason, null);
});

test("readyz refuses while a monitored chain has no cursor", async () => {
  const snapshot = await buildReadinessSnapshot({
    db: stubDb({ cursors: [{ chainKey: 1n, lastProcessedBlock: 5n, attesting: true }] }),
    monitoredChains: MONITORED,
  });
  assert.equal(snapshot.ready, false);
  assert.deepEqual(snapshot.chainsWithoutCursor, [3]);
  assert.match(snapshot.reason, /chainKey 3/);
});

test("readyz is not ready when the cursor read itself failed", async () => {
  const snapshot = await buildReadinessSnapshot({
    db: stubDb({ fail: "connection refused" }),
    monitoredChains: MONITORED,
  });
  assert.equal(snapshot.ready, false, "a verdict that cannot be reached is not a pass");
  assert.match(snapshot.reason, /CHAIN_CURSOR_READ_FAILED/);
});

test("readyz answers 503 while not ready and 200 once ready", async () => {
  const missing = await routeHealthRequest("GET", "/readyz", {
    db: stubDb({ cursors: [{ chainKey: 1n, lastProcessedBlock: 5n, attesting: true }] }),
    monitoredChains: MONITORED,
  });
  assert.equal(missing.status, 503);

  const present = await routeHealthRequest("GET", "/readyz", {
    db: stubDb({
      cursors: [
        { chainKey: 1n, lastProcessedBlock: 5n, attesting: true },
        { chainKey: 3n, lastProcessedBlock: 7n, attesting: true },
      ],
    }),
    monitoredChains: MONITORED,
  });
  assert.equal(present.status, 200);
});

test("a query string does not change the route", async () => {
  const answer = await routeHealthRequest("GET", "/healthz?verbose=1", {
    db: stubDb({ cursors: [], byState: [], byClearing: [] }),
    monitoredChains: [],
  });
  assert.equal(answer.status, 200);
});

test("an unknown path is 404 and a write method is 405", async () => {
  const deps = { db: stubDb({}), monitoredChains: [] };
  assert.equal((await routeHealthRequest("GET", "/", deps)).status, 404);
  assert.equal((await routeHealthRequest("GET", "/metrics", deps)).status, 404);
  assert.equal((await routeHealthRequest("POST", "/healthz", deps)).status, 405);
  assert.equal((await routeHealthRequest("DELETE", "/readyz", deps)).status, 405);
});

test("HEAD is routed like GET", async () => {
  const answer = await routeHealthRequest("HEAD", "/healthz", {
    db: stubDb({ cursors: [], byState: [], byClearing: [] }),
    monitoredChains: [],
  });
  assert.equal(answer.status, 200);
});

test("build info reports a missing commit as null rather than a placeholder", () => {
  assert.equal(readBuildInfo({}).commit, null);
  assert.equal(readBuildInfo({ TAB_BUILD_COMMIT: "   " }).commit, null);
  assert.equal(readBuildInfo({ TAB_BUILD_COMMIT: "17d164b" }).commit, "17d164b");
  assert.equal(readBuildInfo({}).version, "0.0.0");
  assert.equal(readBuildInfo({ TAB_BUILD_VERSION: "1.2.3" }).version, "1.2.3");
});

test("the body discloses nothing an unauthenticated caller should not see", async () => {
  const db = stubDb({
    cursors: [{ chainKey: 1n, lastProcessedBlock: 5n, attesting: true }],
    byState: [],
    byClearing: [],
  });
  const answer = await routeHealthRequest("GET", "/healthz", { db, monitoredChains: [1] });
  const body = answer.body.toLowerCase();
  for (const secret of ["private", "postgres://", "postgresql://", "rpc", "0x", "key="]) {
    assert.equal(body.includes(secret), false, `health body must not disclose ${secret}`);
  }
});

test("the server binds, answers over HTTP, and closes", async () => {
  const db = stubDb({
    cursors: [{ chainKey: 1n, lastProcessedBlock: 11648700n, attesting: true }],
    byState: [{ state: "READY", count: 2 }],
    byClearing: [{ state: "APPLIED", count: 1 }],
  });
  // Port 0 lets the kernel choose, so the test cannot collide with a running Watcher.
  const started = await startHealthServer({ db, monitoredChains: [1] }, { port: 0, host: "127.0.0.1" });
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}));

  try {
    const response = await fetch(`http://127.0.0.1:${started.value.port}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.pendingSubmissions, 2);
    assert.equal(body.activeProvisionalClearings, 1);
    assert.equal(body.chains[0].lastProcessedBlock, "11648700");
    assert.equal(body.build.name, "@tabai/watcher");
  } finally {
    await started.value.close();
  }
});

test("a bind failure is returned, not thrown", async () => {
  const db = stubDb({ cursors: [], byState: [], byClearing: [] });
  const first = await startHealthServer({ db, monitoredChains: [] }, { port: 0, host: "127.0.0.1" });
  assert.equal(first.ok, true);
  try {
    const second = await startHealthServer(
      { db, monitoredChains: [] },
      { port: first.value.port, host: "127.0.0.1" },
    );
    assert.equal(second.ok, false, "a taken port is an error value");
    assert.equal(second.error.code, "HEALTH_PORT_IN_USE");
    assert.equal(second.error.retryable, false);
  } finally {
    await first.value.close();
  }
});
