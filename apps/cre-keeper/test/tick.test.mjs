import assert from "node:assert/strict";
import { test } from "node:test";

import { runDelinquencyTick, TickFailure } from "../dist/tick.js";
import { readOf } from "../dist/keeper-client.js";
import { parseOverdue } from "../dist/overdue.js";

const id = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const tab = (n) => ({ tabId: id(n), agent: "0xa", serviceId: id(9), asset: "0xb", openBaseUnits: "1", windowEnd: n, secondsUntilWindowEnd: -1, markable: true, delinquent: false });
const snapshot = (overdue) => parseOverdue({ at: { blockNumber: 100, timestamp: 1 }, candidates: overdue.length, overdue, pending: [] }).value;

const runtime = () => {
  const logs = [];
  return { config: { keeperUrl: "http://keeper.test", maxMarksPerTick: 25 }, log: (message) => logs.push(message), logs };
};

test("a tick with nothing overdue reads, logs, and never asks for the secret or posts", () => {
  const rt = runtime();
  let secretAsked = false;
  const summary = runDelinquencyTick(rt, {
    readOverdue: () => ({ ok: true, value: readOf(snapshot([]), 25) }),
    secret: () => {
      secretAsked = true;
      return { ok: true, value: "s" };
    },
    postTick: () => assert.fail("nothing should be posted"),
  });
  assert.equal(secretAsked, false);
  assert.deepEqual(summary, { keeperUrl: "http://keeper.test", candidates: 0, overdue: 0, pending: 0, requested: [], declined: 0, deferred: 0 });
  assert.ok(rt.logs.some((line) => line.includes("nothing to mark")));
});

test("a tick with overdue tabs posts them and logs every verdict the keeper answered", () => {
  const rt = runtime();
  const posted = [];
  const summary = runDelinquencyTick(rt, {
    readOverdue: () => ({ ok: true, value: readOf(snapshot([tab(2), tab(1)]), 25) }),
    secret: () => ({ ok: true, value: "s3cret" }),
    postTick: (secret, tabIds) => {
      posted.push({ secret, tabIds });
      return {
        ok: true,
        value: {
          statusCode: 200,
          broadcast: true,
          at: { blockNumber: 101, timestamp: 2 },
          actions: [
            { tabId: id(1), outcome: "marked", txHash: "0xabc" },
            { tabId: id(2), outcome: "skipped", reason: "AlreadyDelinquent" },
          ],
          notMarkable: [],
        },
      };
    },
  });
  assert.deepEqual(posted, [{ secret: "s3cret", tabIds: [id(1), id(2)] }]);
  assert.deepEqual(summary.tick, { blockNumber: 101, broadcast: true, marked: 1, skipped: 1, failed: 0, wouldMark: 0, notMarkable: 0 });
  assert.ok(rt.logs.some((line) => line === `tab keeper: marked ${id(1)} in 0xabc`));
  assert.ok(rt.logs.some((line) => line === `tab keeper: skipped ${id(2)}: AlreadyDelinquent`));
  assert.ok(rt.logs.some((line) => line.includes("1 marked, 1 skipped, 0 failed")));
});

test("a keeper without a key answers would-mark, and the tick says so instead of claiming a mark", () => {
  const rt = runtime();
  const summary = runDelinquencyTick(rt, {
    readOverdue: () => ({ ok: true, value: readOf(snapshot([tab(1)]), 25) }),
    secret: () => ({ ok: true, value: "s" }),
    postTick: () => ({ ok: true, value: { statusCode: 200, broadcast: false, at: { blockNumber: 5, timestamp: 1 }, actions: [{ tabId: id(1), outcome: "would-mark" }], notMarkable: [] } }),
  });
  assert.equal(summary.tick.wouldMark, 1);
  assert.equal(summary.tick.broadcast, false);
  assert.ok(rt.logs.some((line) => line.includes("dry run")));
});

test("a failed port fails the tick with the port's code, which is what CRE reports", () => {
  const rt = runtime();
  assert.throws(
    () =>
      runDelinquencyTick(rt, {
        readOverdue: () => ({ ok: false, error: { category: "UPSTREAM", code: "KEEPER_OVERDUE_STATUS", message: "502", retryable: true } }),
        secret: () => ({ ok: true, value: "s" }),
        postTick: () => assert.fail("unreachable"),
      }),
    (error) => error instanceof TickFailure && error.code === "KEEPER_OVERDUE_STATUS" && /502/.test(error.message),
  );
  assert.throws(
    () =>
      runDelinquencyTick(rt, {
        readOverdue: () => ({ ok: true, value: readOf(snapshot([tab(1)]), 25) }),
        secret: () => ({ ok: false, error: { category: "UPSTREAM", code: "SECRET_UNAVAILABLE", message: "vault", retryable: true } }),
        postTick: () => assert.fail("unreachable"),
      }),
    (error) => error instanceof TickFailure && error.code === "SECRET_UNAVAILABLE",
  );
});
