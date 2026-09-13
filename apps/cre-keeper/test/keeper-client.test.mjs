import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchOverdue, postTick } from "../dist/keeper-client.js";

const id = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const overdueBody = {
  at: { blockNumber: 100, timestamp: 2_000 },
  candidates: 3,
  feed: { rows: 3, pages: 1 },
  overdue: [
    { tabId: id(2), agent: "0xa", serviceId: id(9), asset: "0xb", openBaseUnits: "5", windowEnd: 20, secondsUntilWindowEnd: -10, markable: true, delinquent: false },
    { tabId: id(1), agent: "0xa", serviceId: id(9), asset: "0xb", openBaseUnits: "7", windowEnd: 10, secondsUntilWindowEnd: -20, markable: true, delinquent: false },
  ],
  pending: [{ tabId: id(3) }],
};

/** A requester that answers from a table and records each request, with bodies as bytes like the WASM host hands them. */
function fakeRequester(answers) {
  const requests = [];
  return {
    requests,
    sendRequest(input) {
      requests.push(input);
      const answer = answers[`${input.method ?? "GET"} ${input.url}`];
      if (answer === undefined) throw new Error(`unexpected ${input.method} ${input.url}`);
      return { result: () => ({ statusCode: answer.status, body: new TextEncoder().encode(JSON.stringify(answer.body)) }) };
    },
  };
}

test("fetchOverdue reads /overdue with a shared cache and returns the decision without the block", () => {
  const requester = fakeRequester({ "GET http://keeper.test/overdue": { status: 200, body: overdueBody } });
  const read = fetchOverdue(requester, { keeperUrl: "http://keeper.test/", timeout: "8s", maxMarks: 25 });
  assert.ok(read.ok, read.ok ? "" : read.error.message);
  assert.deepEqual(read.value.decision.tabIds, [id(1), id(2)]);
  assert.equal(read.value.candidates, 3);
  assert.equal(read.value.overdueCount, 2);
  assert.equal(read.value.pendingCount, 1);
  assert.equal("at" in read.value, false, "the aggregated value carries no block, so nodes a block apart still agree");
  assert.deepEqual(requester.requests[0], {
    url: "http://keeper.test/overdue",
    method: "GET",
    headers: { accept: "application/json" },
    timeout: "8s",
    cacheSettings: { store: true, maxAge: "60s" },
  });
});

test("fetchOverdue reports a non-200 and a non-JSON body by name", () => {
  const down = fetchOverdue(fakeRequester({ "GET http://k/overdue": { status: 502, body: {} } }), { keeperUrl: "http://k", timeout: "8s", maxMarks: 1 });
  assert.equal(down.error.code, "KEEPER_OVERDUE_STATUS");
  const requester = { sendRequest: () => ({ result: () => ({ statusCode: 200, body: new TextEncoder().encode("<html>") }) }) };
  assert.equal(fetchOverdue(requester, { keeperUrl: "http://k", timeout: "8s", maxMarks: 1 }).error.code, "KEEPER_NOT_JSON");
});

test("postTick sends the tab ids with the Bearer secret, base64-encoded, under a long shared cache", () => {
  const requester = fakeRequester({
    "POST http://keeper.test/tick": { status: 200, body: { broadcast: true, at: { blockNumber: 101, timestamp: 2_010 }, actions: [{ tabId: id(1), outcome: "marked", txHash: "0xabc" }], notMarkable: [id(2)] } },
  });
  const outcome = postTick(requester, { keeperUrl: "http://keeper.test", timeout: "8s", secret: "s3cret", tabIds: [id(1), id(2)] });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.error.message);
  assert.equal(outcome.value.broadcast, true);
  assert.equal(outcome.value.actions[0].outcome, "marked");
  assert.deepEqual(outcome.value.notMarkable, [id(2)]);
  const sent = requester.requests[0];
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers.authorization, "Bearer s3cret");
  assert.equal(sent.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(Buffer.from(sent.body, "base64").toString("utf8")), { tabIds: [id(1), id(2)] });
  assert.deepEqual(sent.cacheSettings, { store: true, maxAge: "600s" });
});

test("postTick names a rejected secret and passes the keeper's own error through", () => {
  const forbidden = postTick(fakeRequester({ "POST http://k/tick": { status: 403, body: { error: { code: "TICK_SECRET_INVALID", message: "no" } } } }), { keeperUrl: "http://k", timeout: "8s", secret: "x", tabIds: [id(1)] });
  assert.equal(forbidden.error.code, "KEEPER_SECRET_REJECTED");
  assert.match(forbidden.error.message, /TICK_SECRET_INVALID/);
  const broken = postTick(fakeRequester({ "POST http://k/tick": { status: 200, body: { nope: true } } }), { keeperUrl: "http://k", timeout: "8s", secret: "x", tabIds: [id(1)] });
  assert.equal(broken.error.code, "KEEPER_TICK_MALFORMED");
});

test("a base64 body, as the JSON side of the host would hand it, decodes the same", () => {
  const requester = { sendRequest: () => ({ result: () => ({ statusCode: 200, body: Buffer.from(JSON.stringify(overdueBody)).toString("base64") }) }) };
  const read = fetchOverdue(requester, { keeperUrl: "http://k", timeout: "8s", maxMarks: 1 });
  assert.ok(read.ok);
  assert.deepEqual(read.value.decision.tabIds, [id(1)]);
  assert.equal(read.value.decision.deferred, 1);
});
