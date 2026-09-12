import assert from "node:assert/strict";
import { test } from "node:test";

import { createChainReader } from "../dist/chain.js";
import { createKeeperApp, suppliedSecret } from "../dist/server.js";
import { AGENT_A, AGENT_B, fakeMarker, fakeRpc, SERVICE, SERVICE_REGISTRY, TAB_BOOK, tabIdFor, USDC } from "./fake-chain.mjs";

const candidates = [AGENT_A, AGENT_B].map((agent) => ({ agent, serviceId: SERVICE, asset: USDC }));
const TAB_A = tabIdFor(AGENT_A, SERVICE, USDC);

const app = (over = {}) => {
  const secret = "secret" in over ? over.secret : "s3cret";
  const canBroadcast = over.canBroadcast ?? true;
  const marker = over.marker ?? fakeMarker();
  return {
  marker,
  app: createKeeperApp({
    deps: {
      chain: createChainReader({ rpcUrl: "http://node.test", fetchImpl: fakeRpc() }),
      walkFeed: async () => ({ ok: true, value: { candidates, rows: 2, pages: 1 } }),
      marker,
      tabBook: TAB_BOOK,
      serviceRegistry: SERVICE_REGISTRY,
    },
    sharedSecret: secret,
    canBroadcast,
    chainId: 10143,
    version: "test",
  }),
  };
};

test("GET /healthz says whether the keeper can broadcast and whether /tick is protected", async () => {
  const { app: a } = app();
  const response = await a.request("/healthz");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", chainId: 10143, canBroadcast: true, tickProtected: true, version: "test" });
});

test("GET /overdue serves the verdicts as JSON with no secret", async () => {
  const { app: a } = app();
  const response = await a.request("/overdue");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.overdue.length, 1);
  assert.equal(body.overdue[0].tabId, TAB_A);
  assert.equal(body.pending.length, 1);
  assert.equal(typeof body.at.blockNumber, "number");
});

test("POST /tick is refused outright with no secret configured, and with a wrong one", async () => {
  const unprotected = app({ secret: undefined });
  const refused = await unprotected.app.request("/tick", { method: "POST" });
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).error.code, "TICK_UNPROTECTED");

  const { app: a, marker } = app();
  const missing = await a.request("/tick", { method: "POST" });
  assert.equal(missing.status, 403);
  const wrong = await a.request("/tick", { method: "POST", headers: { authorization: "Bearer nope" } });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error.code, "TICK_SECRET_INVALID");
  assert.deepEqual(marker.sent, []);
});

test("POST /tick with the secret judges, simulates and marks, and honours tabIds", async () => {
  const { app: a, marker } = app();
  const response = await a.request("/tick", {
    method: "POST",
    headers: { authorization: "Bearer s3cret", "content-type": "application/json" },
    body: JSON.stringify({ tabIds: [TAB_A] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.broadcast, true);
  assert.equal(body.actions[0].outcome, "marked");
  assert.deepEqual(marker.sent, [TAB_A]);

  const header = app();
  const viaHeader = await header.app.request("/tick", { method: "POST", headers: { "x-keeper-secret": "s3cret" } });
  assert.equal(viaHeader.status, 200);
  assert.deepEqual(header.marker.sent, [TAB_A]);
});

test("POST /tick without a key is a dry run, and a caller cannot turn broadcasting on", async () => {
  const { app: a, marker } = app({ canBroadcast: false });
  const response = await a.request("/tick", { method: "POST", headers: { authorization: "Bearer s3cret", "content-type": "application/json" }, body: JSON.stringify({ broadcast: true }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.broadcast, false);
  assert.equal(body.actions[0].outcome, "would-mark");
  assert.deepEqual(marker.sent, []);
});

test("POST /tick refuses a malformed body and malformed tab ids by name", async () => {
  const { app: a } = app();
  const notJson = await a.request("/tick", { method: "POST", headers: { authorization: "Bearer s3cret" }, body: "{oops" });
  assert.equal(notJson.status, 400);
  assert.equal((await notJson.json()).error.code, "TICK_BODY_MALFORMED");
  const badIds = await a.request("/tick", { method: "POST", headers: { authorization: "Bearer s3cret" }, body: JSON.stringify({ tabIds: ["tab-a"] }) });
  assert.equal(badIds.status, 400);
  assert.equal((await badIds.json()).error.code, "TICK_TAB_IDS_MALFORMED");
});

test("the secret is read from a Bearer token or the X-Keeper-Secret header", () => {
  assert.equal(suppliedSecret(new Headers({ authorization: "Bearer  abc " })), "abc");
  assert.equal(suppliedSecret(new Headers({ "x-keeper-secret": "xyz" })), "xyz");
  assert.equal(suppliedSecret(new Headers({ authorization: "Basic abc" })), undefined);
  assert.equal(suppliedSecret(new Headers()), undefined);
});
