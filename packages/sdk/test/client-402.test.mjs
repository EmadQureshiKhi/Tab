/**
 * The HTTP 402 client wrapper.
 *
 * Nothing here reaches the network. The `fetch` is a recorder that returns
 * scripted responses and remembers what it was asked, which is what lets these
 * tests assert the two things that matter most and that a live call could not show
 * cleanly: that the repeat happens **exactly once**, and that no settlement of any
 * kind happens inside it.
 *
 * Requirements: 23.2, 21.5
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { TAB_HEADER, createTab402Client } from "../dist/http/index.js";

const BASE_URL = "https://proof.example/api/";
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const AGENT = "0xE5eaB26CaE0855BcCaBBb9A64faFce28C8432b37";
const SERVICE_ID = "0x7461622e70726f6f662d73657276696365000000000000000000000000000000";
const TOOL = `0x70726f6f66${"0".repeat(54)}`;
const AUTH_KEY = `0x${"ab".repeat(32)}`;
const USDC_3 = { chainKey: 3n, address: MAINNET_USDC.toLowerCase() };

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const chargeHeaders = (overrides = {}) => ({
  [TAB_HEADER.chargeAmount]: "10000",
  [TAB_HEADER.chargeAsset]: `3:${MAINNET_USDC.toLowerCase()}`,
  [TAB_HEADER.chargeService]: SERVICE_ID,
  [TAB_HEADER.chargeTool]: TOOL,
  [TAB_HEADER.openTab]: "40000",
  [TAB_HEADER.headroom]: "960000",
  ...overrides,
});

/** A response shaped like the real thing, with a body that records its cancellation. */
function response({ status = 200, headers = {} } = {}) {
  const state = { cancelled: 0 };
  return {
    status,
    headers: new Headers(headers),
    bodyUsed: false,
    body: {
      cancelled: state,
      cancel: async () => {
        state.cancelled += 1;
      },
    },
    async json() {
      return { ok: true };
    },
  };
}

/** A `fetch` that answers from a script and remembers every call. */
function recordingFetch(script) {
  const calls = [];
  let index = 0;
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    if (typeof step === "function") return step(url, init);
    return step;
  };
  return { calls, impl };
}

const clientOver = (script, options = {}) => {
  const recorder = recordingFetch(script);
  const charges = [];
  const client = createTab402Client({
    baseUrl: BASE_URL,
    agent: AGENT,
    authorisation: AUTH_KEY,
    fetchImpl: recorder.impl,
    logger: silent,
    now: () => 1_700_000_000_000,
    onCharge: (charge) => charges.push(charge),
    ...options,
  });
  return { client, calls: recorder.calls, charges };
};

test("a 200 carrying the charge block records the accrual and hands the response back", async () => {
  const served = response({ headers: chargeHeaders() });
  const { client, calls, charges } = clientOver([served]);

  const result = await client.fetch("proof");
  assert.equal(result.ok, true);
  assert.equal(result.value, served);
  assert.equal(result.value.status, 200);

  // One call. A 200 is the normal metered response, so there is nothing to repeat.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://proof.example/api/proof");
  assert.equal(calls[0].init.headers[TAB_HEADER.agent], AGENT);
  assert.equal(calls[0].init.headers[TAB_HEADER.authorisation], AUTH_KEY);

  assert.equal(charges.length, 1);
  assert.deepEqual(client.charges(), charges);
  const [charge] = charges;
  assert.equal(charge.outcome, "accrued");
  assert.equal(charge.status, 200);
  assert.equal(charge.attempt, 1);
  assert.equal(charge.amount, 10_000n);
  assert.equal(charge.openTab, 40_000n);
  assert.equal(charge.headroom, 960_000n);
  assert.deepEqual(charge.asset, USDC_3);
  assert.equal(charge.serviceId, SERVICE_ID);
  assert.equal(charge.tool, TOOL);
  assert.equal(charge.agent, AGENT);
  assert.equal(charge.observedAt, 1_700_000_000_000);

  // The Open Tab is the Service's figure, carried through rather than recomputed.
  const tab = client.tabOf({ chainKey: 3n, address: MAINNET_USDC });
  assert.equal(tab.openTab, 40_000n);
  assert.equal(tab.headroom, 960_000n);
  assert.equal(tab.accrued, 10_000n);
  assert.equal(tab.declined, 0n);
  assert.equal(tab.accruedCount, 1);
  assert.equal(client.tabs().length, 1);
});

test("an unmetered 200 is handed back untouched and accrues nothing", async () => {
  const { client, calls, charges } = clientOver([response({ headers: { "content-type": "text/plain" } })]);

  const result = await client.fetch("healthz");
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(charges.length, 0);
  assert.deepEqual(client.tabs(), []);
});

test("a 402 records the required amount, repeats exactly once, and settles nothing", async () => {
  const declined = response({ status: 402, headers: chargeHeaders({ [TAB_HEADER.headroom]: "0" }) });
  const served = response({ headers: chargeHeaders({ [TAB_HEADER.openTab]: "50000" }) });
  const { client, calls, charges } = clientOver([declined, served]);

  const result = await client.fetch("proof", { method: "POST", body: '{"tx":"0x01"}' });
  assert.equal(result.ok, true);
  assert.equal(result.value, served);
  assert.equal(result.value.status, 200);

  // Exactly two calls: the original and one repeat. Not a loop.
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://proof.example/api/proof", "https://proof.example/api/proof"],
  );
  for (const call of calls) {
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.body, '{"tx":"0x01"}');
    assert.equal(call.init.headers[TAB_HEADER.agent], AGENT);
    assert.equal(call.init.headers[TAB_HEADER.authorisation], AUTH_KEY);
  }

  // The repeat carries identity and nothing else. No signer, no allowance, no
  // transaction: settlement is asynchronous and Agent-initiated, and a payment
  // step here would be the prepay model this rail replaces.
  assert.equal(calls[1].init.authorization, undefined);
  assert.equal(calls[1].init.headers["X-Payment"], undefined);

  assert.equal(charges.length, 2);
  assert.equal(charges[0].outcome, "declined");
  assert.equal(charges[0].status, 402);
  assert.equal(charges[0].attempt, 1);
  assert.equal(charges[0].amount, 10_000n);
  assert.equal(charges[0].headroom, 0n);
  assert.equal(charges[1].outcome, "accrued");
  assert.equal(charges[1].attempt, 2);

  const tab = client.tabOf(USDC_3);
  assert.equal(tab.accrued, 10_000n);
  assert.equal(tab.declined, 10_000n);
  assert.equal(tab.openTab, 50_000n);

  // The discarded 402 body was released rather than left holding its connection.
  assert.equal(declined.body.cancelled.cancelled, 1);
  assert.equal(served.body.cancelled.cancelled, 0);
});

test("a 402 that stands after the repeat is a LIMIT error naming the shortfall", async () => {
  const { client, calls } = clientOver([
    response({ status: 402, headers: chargeHeaders({ [TAB_HEADER.headroom]: "2500" }) }),
  ]);

  const result = await client.fetch("proof");
  assert.equal(result.ok, false);
  assert.equal(result.error.category, "LIMIT");
  assert.equal(result.error.code, "LIMIT_EXCEEDED");
  assert.equal(result.error.retryable, false);
  assert.equal(result.error.details.requiredBaseUnits, "10000");
  assert.equal(result.error.details.headroomBaseUnits, "2500");
  assert.equal(result.error.details.attempts, 2);
  assert.equal(result.error.details.asset, `3:${MAINNET_USDC.toLowerCase()}`);

  // Two attempts, and no third.
  assert.equal(calls.length, 2);
  assert.equal(client.tabOf(USDC_3).declined, 20_000n);
});

test("maxRetries 0 repeats nothing and reports the credit decision straight away", async () => {
  const { client, calls } = clientOver(
    [response({ status: 402, headers: chargeHeaders({ [TAB_HEADER.headroom]: "0" }) })],
    { maxRetries: 0 },
  );

  const result = await client.fetch("proof");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "LIMIT_EXCEEDED");
  assert.equal(result.error.details.attempts, 1);
  assert.equal(calls.length, 1);
});

test("a 402 with no charge headers is an error, because a credit decision must name its numbers", async () => {
  const { client, charges } = clientOver([response({ status: 402 })]);

  const result = await client.fetch("proof");
  assert.equal(result.ok, false);
  assert.equal(result.error.category, "VALIDATION");
  assert.equal(result.error.code, "CHARGE_HEADERS_MISSING");
  assert.equal(charges.length, 0);
});

test("a malformed charge header is an err rather than a throw", async () => {
  for (const [overrides, code] of [
    [{ [TAB_HEADER.chargeAmount]: "1e6" }, "CHARGE_AMOUNT_INVALID"],
    [{ [TAB_HEADER.chargeAsset]: "3:0xnope" }, "CHARGE_ASSET_INVALID"],
    [{ [TAB_HEADER.chargeService]: "0x01" }, "CHARGE_SERVICE_INVALID"],
    [{ [TAB_HEADER.chargeTool]: "proof" }, "CHARGE_TOOL_INVALID"],
    [{ [TAB_HEADER.openTab]: "-1" }, "OPEN_TAB_INVALID"],
    [{ [TAB_HEADER.headroom]: "1.5" }, "HEADROOM_INVALID"],
  ]) {
    const { client, calls, charges } = clientOver([response({ headers: chargeHeaders(overrides) })]);
    const result = await client.fetch("proof");
    assert.equal(result.ok, false, `${code} was accepted`);
    assert.equal(result.error.code, code);
    assert.equal(result.error.category, "VALIDATION");
    // One call, nothing recorded: a charge that cannot be read is not a charge.
    assert.equal(calls.length, 1);
    assert.equal(charges.length, 0);
    assert.deepEqual(client.tabs(), []);
  }
});

test("a missing charge header is an err rather than a throw", async () => {
  const partial = chargeHeaders();
  delete partial[TAB_HEADER.headroom];
  const { client, charges } = clientOver([response({ headers: partial })]);

  const result = await client.fetch("proof");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CHARGE_HEADERS_INCOMPLETE");
  assert.equal(result.error.category, "VALIDATION");
  assert.match(result.error.details.missing, /Tab-Headroom/);
  assert.equal(charges.length, 0);
});

test("a network failure is an err rather than a throw", async () => {
  const { client, calls } = clientOver([
    () => {
      throw new Error("getaddrinfo ENOTFOUND proof.example");
    },
  ]);

  const result = await client.fetch("proof");
  assert.equal(result.ok, false);
  assert.equal(result.error.category, "UPSTREAM");
  assert.equal(result.error.code, "FETCH_FAILED");
  assert.equal(result.error.retryable, true);
  assert.equal(result.error.cause.message, "getaddrinfo ENOTFOUND proof.example");
  assert.equal(result.error.details.attempt, 1);
  assert.equal(calls.length, 1);
});

test("a rejected promise and a response-shaped nothing are both err values", async () => {
  const rejecting = clientOver([async () => Promise.reject(new Error("socket hang up"))]);
  const rejected = await rejecting.client.fetch("proof");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "FETCH_FAILED");

  const garbage = clientOver([async () => "not a response"]);
  const invalid = await garbage.client.fetch("proof");
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.category, "UPSTREAM");
  assert.equal(invalid.error.code, "FETCH_RESPONSE_INVALID");
});

test("a Service error status is the Service's business and comes back as a response", async () => {
  const { client } = clientOver([response({ status: 503 })]);
  const result = await client.fetch("proof");
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 503);
});

test("a stream body cannot be repeated, and the client says so instead of sending an empty one", async () => {
  const { client, calls } = clientOver([
    response({ status: 402, headers: chargeHeaders({ [TAB_HEADER.headroom]: "0" }) }),
  ]);

  const result = await client.fetch("proof", {
    method: "POST",
    body: { getReader: () => ({}) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "REQUEST_BODY_NOT_REPLAYABLE");
  assert.equal(result.error.category, "VALIDATION");
  assert.equal(calls.length, 1);
  // The charge the 402 declared was still recorded before the repeat was refused.
  assert.equal(client.charges().length, 1);
  assert.equal(client.charges()[0].outcome, "declined");
});

test("bad client input is reported by the call, not by the constructor, and sends nothing", async () => {
  const noAgent = clientOver([response()], { agent: "0x1234" });
  const badAgent = await noAgent.client.fetch("proof");
  assert.equal(badAgent.ok, false);
  assert.equal(badAgent.error.code, "AGENT_INVALID");
  assert.equal(noAgent.calls.length, 0);

  const badAuth = clientOver([response()], { authorisation: "0xdead" });
  const auth = await badAuth.client.fetch("proof");
  assert.equal(auth.ok, false);
  assert.equal(auth.error.code, "AUTHORISATION_INVALID");
  assert.equal(badAuth.calls.length, 0);

  const badBase = clientOver([response()], { baseUrl: "proof.example" });
  const base = await badBase.client.fetch("proof");
  assert.equal(base.ok, false);
  assert.equal(base.error.code, "BASE_URL_INVALID");
  assert.equal(badBase.calls.length, 0);

  const empty = clientOver([response()]);
  const noUrl = await empty.client.fetch("");
  assert.equal(noUrl.ok, false);
  assert.equal(noUrl.error.code, "REQUEST_URL_INVALID");
  assert.equal(empty.calls.length, 0);

  const looping = clientOver([response()], { maxRetries: 3 });
  const retries = await looping.client.fetch("proof");
  assert.equal(retries.ok, false);
  assert.equal(retries.error.code, "MAX_RETRIES_UNSUPPORTED");
  assert.equal(looping.calls.length, 0);
});

test("the caller's own headers win, and every accepted header shape is merged", async () => {
  const other = "0x621663045265405B65d2afD1c22bC7254f8E1dec";

  const explicit = clientOver([response()]);
  await explicit.client.fetch("proof", { headers: { [TAB_HEADER.agent]: other } });
  assert.equal(explicit.calls[0].init.headers[TAB_HEADER.agent], other);

  const asHeaders = clientOver([response()]);
  await asHeaders.client.fetch("proof", { headers: new Headers({ "x-trace": "abc" }) });
  assert.equal(asHeaders.calls[0].init.headers["x-trace"], "abc");
  assert.equal(asHeaders.calls[0].init.headers[TAB_HEADER.agent], AGENT);

  const asPairs = clientOver([response()]);
  await asPairs.client.fetch("proof", { headers: [["x-trace", "def"]] });
  assert.equal(asPairs.calls[0].init.headers["x-trace"], "def");

  const bad = clientOver([response()]);
  const rejected = await bad.client.fetch("proof", { headers: [["x-trace"]] });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "REQUEST_HEADERS_INVALID");
  assert.equal(bad.calls.length, 0);
});

test("an onCharge that throws does not fail a call that succeeded", async () => {
  const served = response({ headers: chargeHeaders() });
  const { client } = clientOver([served], {
    onCharge: () => {
      throw new Error("consumer bug");
    },
  });

  const result = await client.fetch("proof");
  assert.equal(result.ok, true);
  assert.equal(result.value, served);
  assert.equal(client.charges().length, 1);
});

test("the charge history is bounded while the totals stay exact", async () => {
  const { client } = clientOver([response({ headers: chargeHeaders() })], { maxChargeHistory: 2 });
  for (let call = 0; call < 5; call += 1) {
    const result = await client.fetch("proof");
    assert.equal(result.ok, true);
  }
  assert.equal(client.charges().length, 2);
  assert.equal(client.tabOf(USDC_3).accrued, 50_000n);
  assert.equal(client.tabOf(USDC_3).accruedCount, 5);
});

test("the strategy id is recorded for the later settlement path and used by nothing here", async () => {
  const { client, calls } = clientOver([response({ headers: chargeHeaders() })], {
    strategyId: "ethereum-usdc",
  });

  const result = await client.fetch("proof");
  assert.equal(result.ok, true);
  assert.equal(client.charges()[0].strategyId, "ethereum-usdc");
  // It travels on no header and changes no request.
  assert.equal(calls[0].init.headers["Tab-Strategy"], undefined);
});
