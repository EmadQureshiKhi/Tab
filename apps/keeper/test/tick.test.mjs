/**
 * The whole tick against a fake node: the copied Dashboard judge runs unchanged
 * over JSON-RPC, then the marker simulates and sends.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createChainReader } from "../dist/chain.js";
import { readOverdue, runTick } from "../dist/tick.js";
import { AGENT_A, AGENT_B, AGENT_C, AGENT_D, fakeMarker, fakeRpc, NOW, SERVICE, SERVICE_REGISTRY, TAB_BOOK, tabIdFor, USDC, WINDOW } from "./fake-chain.mjs";

const candidates = [AGENT_A, AGENT_B, AGENT_C, AGENT_D].map((agent) => ({ agent, serviceId: SERVICE, asset: USDC }));
const walk = (list = candidates) => async () => ({ ok: true, value: { candidates: list, rows: list.length * 2, pages: 1 } });
const TAB_A = tabIdFor(AGENT_A, SERVICE, USDC);
const TAB_B = tabIdFor(AGENT_B, SERVICE, USDC);

const deps = (rpc, marker, walkFeed = walk()) => ({
  chain: createChainReader({ rpcUrl: "http://node.test", fetchImpl: rpc }),
  walkFeed,
  marker,
  tabBook: TAB_BOOK,
  serviceRegistry: SERVICE_REGISTRY,
});

test("GET /overdue material: one tab overdue, one pending, the marked and the settled ones left out", async () => {
  const rpc = fakeRpc();
  const judged = await readOverdue(deps(rpc, fakeMarker()));
  assert.ok(judged.ok, judged.ok ? "" : judged.error.message);
  const { json } = judged.value;
  assert.deepEqual(json.at, { blockNumber: 100, timestamp: NOW });
  assert.equal(json.candidates, 4);
  assert.deepEqual(json.feed, { rows: 8, pages: 1 });
  assert.equal(json.overdue.length, 1);
  assert.equal(json.overdue[0].tabId, TAB_A);
  assert.equal(json.overdue[0].agent, AGENT_A);
  assert.equal(json.overdue[0].openBaseUnits, "10000");
  assert.equal(json.overdue[0].windowEnd, NOW - 60);
  assert.equal(json.overdue[0].secondsUntilWindowEnd, -60);
  assert.equal(json.overdue[0].markable, true);
  assert.equal(json.pending.length, 1);
  assert.equal(json.pending[0].tabId, TAB_B);
  assert.equal(json.pending[0].secondsUntilWindowEnd, WINDOW - 100);
  assert.equal(json.pending[0].markable, false);
  // Every state was read at the one block the head answered.
  const blocks = new Set(rpc.calls.filter((call) => call.method === "eth_call").map((call) => call.params[1]));
  assert.deepEqual([...blocks], ["0x64"]);
});

test("a dry run simulates every markable tab and sends nothing", async () => {
  const marker = fakeMarker();
  const report = await runTick(deps(fakeRpc(), marker), { broadcast: false });
  assert.ok(report.ok);
  assert.equal(report.value.broadcast, false);
  assert.deepEqual(report.value.actions, [{ tabId: TAB_A, outcome: "would-mark" }]);
  assert.deepEqual(marker.simulated, [TAB_A]);
  assert.deepEqual(marker.sent, []);
  assert.deepEqual(report.value.notMarkable, []);
});

test("--broadcast marks the tab the chain accepts and records the hash", async () => {
  const marker = fakeMarker();
  const report = await runTick(deps(fakeRpc(), marker), { broadcast: true });
  assert.ok(report.ok);
  assert.deepEqual(marker.sent, [TAB_A]);
  assert.deepEqual(report.value.actions, [{ tabId: TAB_A, outcome: "marked", txHash: `0x${"0".repeat(63)}1`, blockNumber: 101 }]);
});

test("a tab somebody else marked between the read and the send is a named skip, not a revert", async () => {
  const marker = fakeMarker({ verdicts: { [TAB_A]: { outcome: "skip", reason: "AlreadyDelinquent" } } });
  const report = await runTick(deps(fakeRpc(), marker), { broadcast: true });
  assert.ok(report.ok);
  assert.deepEqual(report.value.actions, [{ tabId: TAB_A, outcome: "skipped", reason: "AlreadyDelinquent" }]);
  assert.deepEqual(marker.sent, []);
});

test("a failed send is an action carrying the error, and the tick still answers", async () => {
  const marker = fakeMarker({ sendError: { category: "CHAIN", code: "MARK_SUBMISSION_FAILED", message: "nonce too low", retryable: true } });
  const report = await runTick(deps(fakeRpc(), marker), { broadcast: true });
  assert.ok(report.ok);
  assert.equal(report.value.actions[0].outcome, "failed");
  assert.equal(report.value.actions[0].error.code, "MARK_SUBMISSION_FAILED");
});

test("`only` restricts the marks to the requested tabs and names the ones that were not markable", async () => {
  const marker = fakeMarker();
  const report = await runTick(deps(fakeRpc(), marker), { broadcast: true, only: [TAB_B.toUpperCase().replace("0X", "0x"), TAB_A] });
  assert.ok(report.ok);
  assert.deepEqual(marker.sent, [TAB_A]);
  assert.deepEqual(report.value.notMarkable, [TAB_B]);

  const none = await runTick(deps(fakeRpc(), fakeMarker()), { broadcast: true, only: [TAB_B] });
  assert.ok(none.ok);
  assert.deepEqual(none.value.actions, []);
  assert.deepEqual(none.value.notMarkable, [TAB_B]);
});

test("the verdict uses the chain's clock: a fast wall clock cannot make a tab markable early", async () => {
  // The node says it is one second before the window ends, whatever the machine thinks.
  const rpc = fakeRpc({ timestamp: NOW - 61 });
  const report = await runTick(deps(rpc, fakeMarker()), { broadcast: false });
  assert.ok(report.ok);
  assert.deepEqual(report.value.actions, []);
  assert.equal(report.value.pending.length, 2);
  // The window-end second itself is inclusive, exactly as the contract compares.
  const edge = await runTick(deps(fakeRpc({ timestamp: NOW - 60 }), fakeMarker()), { broadcast: false });
  assert.equal(edge.value.actions.length, 1);
});

test("a feed that cannot be read is a stated failure, never an empty list of overdue tabs", async () => {
  const failing = async () => ({ ok: false, error: { category: "UPSTREAM", code: "FEED_UNREACHABLE", message: "down", retryable: true } });
  const report = await runTick(deps(fakeRpc(), fakeMarker(), failing), { broadcast: false });
  assert.ok(!report.ok);
  assert.equal(report.error.code, "FEED_UNREACHABLE");
});

test("a node that cannot be read is a stated failure too", async () => {
  const dead = async () => {
    throw new Error("ECONNREFUSED");
  };
  const report = await runTick(deps(dead, fakeMarker()), { broadcast: false });
  assert.ok(!report.ok);
  assert.equal(report.error.code, "RPC_UNREACHABLE");
});
