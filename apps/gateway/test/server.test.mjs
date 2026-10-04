/**
 * The served surface: delivery first, metering second, and 402 reserved for credit.
 *
 * The ordering assertion is the one that matters. "The response is never withheld
 * pending payment" is the product claim, and it is only observable by watching the
 * sequence of events across one request, which is what the recorder below does.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";

import { createApp, ISSUED_AT_HEADER, SIGNATURE_HEADER } from "../dist/server.js";
import { METERING_HEADER, meteringDigest } from "../dist/authorisation.js";
import { TAB_BOOK_INTERFACE } from "../dist/tab-book.js";

const OPERATOR = new Wallet(`0x${"11".repeat(32)}`);
const AGENT = "0x0a11ce0000000000000000000000000000000001";
const ASSET = "0x534b2f3a21130d7a60830c2df862319e593943a3";
const SERVICE = "0x7461622e64656d6f000000000000000000000000000000000000000000000000";
const TOOL = `0x${"33".repeat(32)}`;
const NOW = 1_788_700_000_000;

const asset = { chainId: 10143n, address: ASSET, decimals: 6, symbol: "USDC" };

/** A client that records the order it was called in, so ordering is observable. */
function recordingClient({ events, receipt, error }) {
  return {
    recordDelivery: async () => {
      events.push("metered");
      if (error !== undefined) return { ok: false, error };
      return { ok: true, value: receipt };
    },
    openTabOf: async () => ({ ok: true, value: 10_000n }),
    simulateDelivery: async () => ({ ok: true, value: receipt }),
    creditLimit: async () => ({ ok: true, value: 4_750_000n }),
  };
}

const baseOptions = (over = {}) => ({
  serviceId: SERVICE,
  asset,
  operator: OPERATOR.address,
  priceOf: () => ({ tool: TOOL, unitPrice: 10_000n }),
  now: () => NOW,
  ...over,
});

async function signedRequest(app, path = "/meter/quote", method = "POST") {
  const claim = { method, path, agent: AGENT, tool: TOOL, units: 1, issuedAt: NOW };
  const signature = await OPERATOR.signMessage(meteringDigest(claim));
  return app.request(path, {
    method,
    headers: { [SIGNATURE_HEADER]: signature, [ISSUED_AT_HEADER]: String(NOW), "Tab-Agent": AGENT },
  });
}

test("the probe answers without a signature and without metering anything", async () => {
  const events = [];
  const app = createApp(
    baseOptions({ tabBook: recordingClient({ events, receipt: { charged: 10_000n, openAfter: 10_000n, headroomAfter: 4_740_000n, recordedAt: NOW } }) }),
  );
  const response = await app.request("/healthz");
  assert.equal(response.status, 200);
  assert.deepEqual(events, [], "a liveness probe is not a delivery");
});

test("the handler runs to completion before anything is metered", async () => {
  const events = [];
  const app = createApp(
    baseOptions({
      tabBook: recordingClient({ events, receipt: { charged: 10_000n, openAfter: 10_000n, headroomAfter: 4_740_000n, recordedAt: NOW } }),
      deliver: () => {
        events.push("delivered");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }),
  );
  const response = await signedRequest(app);
  assert.equal(response.status, 200);
  assert.deepEqual(events, ["delivered", "metered"], "the work is delivered before it is billed");
});

test("a delivered response carries the charge block the 402 client parses", async () => {
  const events = [];
  const app = createApp(
    baseOptions({ tabBook: recordingClient({ events, receipt: { charged: 10_000n, openAfter: 10_000n, headroomAfter: 4_740_000n, recordedAt: NOW } }) }),
  );
  const response = await signedRequest(app);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Tab-Charge-Amount"), "10000");
  assert.equal(response.headers.get("Tab-Open-Tab"), "10000");
  assert.equal(response.headers.get("Tab-Headroom"), "4740000");
  assert.equal(response.headers.get("Tab-Charge-Asset"), `10143:${ASSET}`);
});

test("quote.generate delivers a quote on the topic asked, the same line every time", async () => {
  const events = [];
  const app = createApp(
    baseOptions({ tabBook: recordingClient({ events, receipt: { charged: 10_000n, openAfter: 10_000n, headroomAfter: 4_740_000n, recordedAt: NOW } }) }),
  );
  const ask = async (body) => {
    const path = "/meter/quote.generate";
    const claim = { method: "POST", path, agent: AGENT, tool: TOOL, units: 1, issuedAt: NOW };
    const signature = await OPERATOR.signMessage(meteringDigest(claim));
    const response = await app.request(path, {
      method: "POST",
      headers: { [SIGNATURE_HEADER]: signature, [ISSUED_AT_HEADER]: String(NOW), "Tab-Agent": AGENT, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).quote;
  };
  const credit = await ask({ prompt: "credit" });
  assert.equal(credit.topic, "credit");
  assert.match(credit.text, /credit/i, "a credit question gets a line about credit");
  assert.deepEqual(await ask({ prompt: "credit" }), credit, "the same topic draws the same line");
  const none = await ask(undefined);
  assert.equal(none.topic, "anything");
  assert.ok(none.text.length > 0, "no topic still gets a quote");
});

test("LimitExceeded is the one 402, and it names the shortfall", async () => {
  const events = [];
  const app = createApp(
    baseOptions({
      tabBook: recordingClient({
        events,
        receipt: { charged: 0n, openAfter: 0n, headroomAfter: 0n, recordedAt: NOW },
        error: {
          category: "LIMIT",
          code: "LIMIT_EXCEEDED",
          message: "over the Credit Limit",
          retryable: false,
          details: { disposition: "refuse-request", requested: "10000", headroom: "500" },
        },
      }),
    }),
  );
  const response = await signedRequest(app);
  assert.equal(response.status, 402);
  const body = await response.json();
  assert.equal(body.error.code, "LIMIT_EXCEEDED");
  assert.equal(body.requiredBaseUnits, "10000");
});

test("a Service-side failure delivers the response anyway and never bills the caller", async () => {
  const events = [];
  const app = createApp(
    baseOptions({
      tabBook: recordingClient({
        events,
        receipt: { charged: 0n, openAfter: 0n, headroomAfter: 0n, recordedAt: NOW },
        // A price that moved under the call is the Service's fault, not the Agent's.
        error: {
          category: "CHAIN",
          code: "PRICE_LIST_CHANGED_MID_CALL",
          message: "the applied price moved",
          retryable: true,
          details: { disposition: "deliver-anyway" },
        },
      }),
    }),
  );
  const response = await signedRequest(app);
  assert.equal(response.status, 200, "a broken billing system eats the delivery rather than charging for it");
});

test("an unsigned metered request is refused before it can spend the operator's gas", async () => {
  const events = [];
  const app = createApp(
    baseOptions({ tabBook: recordingClient({ events, receipt: { charged: 0n, openAfter: 0n, headroomAfter: 0n, recordedAt: NOW } }) }),
  );
  const response = await app.request("/meter/quote", { method: "POST" });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, "METERING_SIGNATURE_ABSENT");
  assert.deepEqual(events, [], "nothing reached the chain");
});

test("a request signed by someone other than the operator is refused", async () => {
  const events = [];
  const app = createApp(
    baseOptions({ tabBook: recordingClient({ events, receipt: { charged: 0n, openAfter: 0n, headroomAfter: 0n, recordedAt: NOW } }) }),
  );
  const stranger = new Wallet(`0x${"22".repeat(32)}`);
  const claim = { method: "POST", path: "/meter/quote", agent: AGENT, tool: TOOL, units: 1, issuedAt: NOW };
  const response = await app.request("/meter/quote", {
    method: "POST",
    headers: {
      [SIGNATURE_HEADER]: await stranger.signMessage(meteringDigest(claim)),
      [ISSUED_AT_HEADER]: String(NOW),
      "Tab-Agent": AGENT,
    },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(events, []);
});

test("a request the Agent signed as itself is accepted, and one it signed for another Agent is not", async () => {
  const agentKey = new Wallet(`0x${"44".repeat(32)}`);
  const agent = agentKey.address.toLowerCase();
  const receipt = { charged: 10_000n, openAfter: 10_000n, headroomAfter: 4_740_000n, recordedAt: NOW };
  const events = [];
  const app = createApp(baseOptions({ tabBook: recordingClient({ events, receipt }) }));

  const claimFor = (who) => ({ method: "POST", path: "/meter/quote", agent: who, tool: TOOL, units: 1, issuedAt: NOW });
  const own = await app.request("/meter/quote", {
    method: "POST",
    headers: {
      [METERING_HEADER.agentSignature]: await agentKey.signMessage(meteringDigest(claimFor(agent))),
      [METERING_HEADER.agentIssuedAt]: String(NOW),
      "Tab-Agent": agent,
    },
  });
  assert.equal(own.status, 200, await own.text());
  assert.deepEqual(events, ["metered"], "the Agent's own signature reached the chain");

  // The same key signing a claim that names a different Agent: the signature
  // recovers to the key, the key is not the Agent named, and nothing is metered.
  const forged = await app.request("/meter/quote", {
    method: "POST",
    headers: {
      [METERING_HEADER.agentSignature]: await agentKey.signMessage(meteringDigest(claimFor(AGENT))),
      [METERING_HEADER.agentIssuedAt]: String(NOW),
      "Tab-Agent": AGENT,
    },
  });
  assert.equal(forged.status, 403);
  assert.equal((await forged.json()).error.code, "METERING_SIGNATURE_NOT_AGENT");
  assert.deepEqual(events, ["metered"], "nothing more reached the chain");

  // Both present: the operator's is the one checked, so an Agent signature
  // that would fail on its own does not stop a request the operator vouched for.
  const both = await app.request("/meter/quote", {
    method: "POST",
    headers: {
      [SIGNATURE_HEADER]: await OPERATOR.signMessage(meteringDigest(claimFor(AGENT))),
      [ISSUED_AT_HEADER]: String(NOW),
      [METERING_HEADER.agentSignature]: "0xnotasignature",
      [METERING_HEADER.agentIssuedAt]: String(NOW),
      "Tab-Agent": AGENT,
    },
  });
  assert.equal(both.status, 200);
});

test("the revert set the gateway decodes covers what recordDelivery can raise", () => {
  // A guard against the pinned list drifting from the contract it decodes.
  for (const name of ["LimitExceeded", "AuthorisationMissing", "AuthorisationExpired", "AuthorisationExceeded", "TabIsDelinquent"]) {
    assert.ok(TAB_BOOK_INTERFACE.getError(name) !== null, `${name} is decodable`);
  }
});
