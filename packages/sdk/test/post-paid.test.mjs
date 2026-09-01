/**
 * The post-paid plugin: what it charges, what it refuses, and — the one that
 * matters — when the response goes out relative to the charge.
 *
 * The header expectations here go through `TAB_HEADER` and `parseChargeHeaders`
 * from the shared header contract, so what this suite asserts the server writes is
 * what the 402 client reads rather than a second opinion about it.
 *
 * Requirements: 23.3, 12.1, 12.2, 12.3
 */

import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import { TAB_HEADER, parseChargeHeaders } from "../dist/http/index.js";
import {
  RECORD_DELIVERY_REVERTS,
  classifyRecordDeliveryRevert,
  decodeRevert,
  detailAmount,
  dispositionOf,
  tabPostPaid,
} from "../dist/server/index.js";

const AGENT = "0x00000000000000000000000000000000000000A1";
const SERVICE_ID = `0x${"11".repeat(32)}`;
const TOOL = `0x${"22".repeat(32)}`;
const TAB_ID = `0x${"33".repeat(32)}`;
const USDC = {
  chainKey: 3n,
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  decimals: 6,
  symbol: "USDC",
};
const ASSET_KEY = "3:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const OPEN_TAB_ON_REFUSAL = 5_500_000n;

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** A request the plugin can read: method, URL, headers, no body. */
function request(headers = { [TAB_HEADER.agent]: AGENT }) {
  return new Request("https://service.example/v1/summarise", { method: "POST", headers });
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Records one delivery and returns what the contract returns. */
function acceptingTabBook(calls = []) {
  return {
    calls,
    async recordDelivery(delivery) {
      calls.push(delivery);
      return {
        ok: true,
        value: {
          charged: BigInt(delivery.units) * delivery.expectedUnitPrice,
          openAfter: 7_000_000n,
          headroomAfter: 3_000_000n,
          recordedAt: 1_700_000_000_000,
        },
      };
    },
    async openTabOf() {
      return { ok: true, value: OPEN_TAB_ON_REFUSAL };
    },
  };
}

/**
 * A client whose `recordDelivery` reverts. Shaped the way `ethers` v6 reports a
 * matched custom error, and classified the way a real client classifies it, so the
 * mapping table is exercised rather than restated.
 */
function revertingTabBook(name, args, openTabOf) {
  return {
    async recordDelivery() {
      return { ok: false, error: classifyRecordDeliveryRevert({ revert: { name, args } }) };
    },
    openTabOf: openTabOf ?? (async () => ({ ok: true, value: OPEN_TAB_ON_REFUSAL })),
  };
}

function pluginWith(tabBook, overrides = {}) {
  return tabPostPaid({
    serviceId: SERVICE_ID,
    asset: USDC,
    tabBook,
    priceOf: () => ({ tool: TOOL, units: 3, unitPrice: 1_000_000n }),
    logger: silent,
    ...overrides,
  });
}

/** The charge block the shared parser reads off a response, or undefined. */
function chargeBlockOf(response) {
  const parsed = parseChargeHeaders(response.headers);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error.message);
  return parsed.value;
}

// ---------------------------------------------------------------- the normal path

test("the normal path is a 200 with the delivery recorded and the charge block attached", async () => {
  const calls = [];
  const plugin = pluginWith(acceptingTabBook(calls));

  const execution = await plugin.execute(request(), () => new Response("summary", { status: 200 }));

  assert.equal(execution.kind, "delivered");
  assert.equal(execution.response.status, 200);
  assert.equal(await execution.response.text(), "summary");

  assert.deepEqual(calls, [
    {
      agent: AGENT,
      serviceId: SERVICE_ID,
      asset: USDC,
      tool: TOOL,
      units: 3,
      expectedUnitPrice: 1_000_000n,
    },
  ]);

  // Read back through the client's own parser: the six headers are a complete,
  // well-formed block, not six strings that happen to be present.
  assert.deepEqual(chargeBlockOf(execution.response), {
    amount: 3_000_000n,
    asset: { chainKey: 3n, address: USDC.address.toLowerCase() },
    serviceId: SERVICE_ID,
    tool: TOOL,
    openTab: 7_000_000n,
    headroom: 3_000_000n,
  });
  assert.equal(execution.response.headers.get(TAB_HEADER.chargeAsset), ASSET_KEY);

  const outcome = await execution.metering;
  assert.equal(outcome.kind, "charged");
  assert.equal(outcome.charge.amount, 3_000_000n);
});

test("the handler runs to completion before anything is metered", async () => {
  const order = [];
  const tabBook = {
    async recordDelivery() {
      order.push("metered");
      return {
        ok: true,
        value: { charged: 3_000_000n, openAfter: 1n, headroomAfter: 1n, recordedAt: 0 },
      };
    },
    async openTabOf() {
      return { ok: true, value: 0n };
    },
  };

  const plugin = pluginWith(tabBook);
  await plugin.execute(request(), async () => {
    order.push("handler-start");
    await tick();
    order.push("handler-end");
    return new Response("ok");
  });

  assert.deepEqual(order, ["handler-start", "handler-end", "metered"]);
});

// ------------------------------------------- the response is never withheld

test("the handler's response is observable while the metering call is still pending", async () => {
  const gate = deferred();
  let recorded = false;
  const tabBook = {
    async recordDelivery() {
      await gate.promise;
      recorded = true;
      return {
        ok: true,
        value: { charged: 3_000_000n, openAfter: 1n, headroomAfter: 1n, recordedAt: 0 },
      };
    },
    async openTabOf() {
      return { ok: true, value: 0n };
    },
  };

  const plugin = pluginWith(tabBook, { release: "before-metering" });
  const execution = await plugin.execute(request(), () => new Response("payload"));

  // The response is here, in hand, readable, with the recording not yet made.
  assert.equal(execution.kind, "delivered");
  assert.equal(execution.response.status, 200);
  assert.equal(await execution.response.text(), "payload");
  assert.equal(recorded, false);

  let settled = false;
  void execution.metering.then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false, "metering must still be in flight after the response was read");

  gate.resolve();
  const outcome = await execution.metering;
  assert.equal(recorded, true);
  assert.equal(outcome.kind, "charged");
});

test("a metering failure the Agent cannot fix delivers the handler's response unchanged", async () => {
  const failures = [];
  const plugin = pluginWith(
    revertingTabBook("PriceListChangedMidCall", [SERVICE_ID, USDC.address, TOOL, 1_000_000n, 1_200_000n]),
    { onMeteringFailed: (context) => failures.push(context.error.code) },
  );

  const execution = await plugin.execute(request(), () => new Response("summary", { status: 200 }));

  assert.equal(execution.kind, "delivered");
  assert.equal(execution.response.status, 200);
  assert.equal(await execution.response.text(), "summary");
  assert.equal(chargeBlockOf(execution.response), undefined, "no charge landed, so no charge block");
  assert.deepEqual(failures, ["PRICE_LIST_CHANGED_MID_CALL"]);
});

test("a handler that throws is not metered and its throw is handed back untouched", async () => {
  const calls = [];
  const plugin = pluginWith(acceptingTabBook(calls));
  const boom = new Error("upstream model refused");

  const execution = await plugin.execute(request(), () => {
    throw boom;
  });

  assert.equal(execution.kind, "handler-failed");
  assert.equal(execution.thrown, boom);
  assert.equal(execution.error.code, "HANDLER_FAILED");
  assert.equal(execution.error.details.metered, false);
  assert.deepEqual(calls, []);
});

test("a failed response is not a delivery, and an unpriced or unidentified request is not charged", async () => {
  const calls = [];
  const plugin = pluginWith(acceptingTabBook(calls));

  const failed = await plugin.execute(request(), () => new Response("boom", { status: 500 }));
  assert.equal(failed.kind, "delivered");
  assert.equal((await failed.metering).reason, "not-billable");

  const anonymous = await plugin.execute(new Request("https://service.example/v1/free"), () =>
    new Response("ok"),
  );
  assert.equal((await anonymous.metering).reason, "no-agent");

  const malformed = await plugin.execute(request({ [TAB_HEADER.agent]: "0xnope" }), () =>
    new Response("ok"),
  );
  assert.equal((await malformed.metering).reason, "agent-malformed");

  const unpriced = pluginWith(acceptingTabBook(calls), { priceOf: () => undefined });
  const free = await unpriced.execute(request(), () => new Response("ok"));
  assert.equal((await free.metering).reason, "not-priced");

  const broken = pluginWith(acceptingTabBook(calls), {
    priceOf: () => ({ tool: TOOL, units: 0, unitPrice: 1_000_000n }),
  });
  const invalid = await broken.execute(request(), () => new Response("ok"));
  assert.equal((await invalid.metering).reason, "price-invalid");

  assert.deepEqual(calls, [], "nothing above is a delivery this Service charges for");
});

// ---------------------------------------------------------------- refusals

test("LimitExceeded is the one 402, and it names the required amount and the headroom", async () => {
  const plugin = pluginWith(
    revertingTabBook("LimitExceeded", [AGENT, USDC.address, 3_000_000n, 1_250_000n]),
  );

  const execution = await plugin.execute(request(), () => new Response("summary"));

  assert.equal(execution.kind, "refused");
  assert.equal(execution.response.status, 402);
  assert.equal(execution.outcome.error.code, "LIMIT_EXCEEDED");
  assert.equal(execution.outcome.error.category, "LIMIT");

  const body = await execution.response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "LIMIT_EXCEEDED");
  assert.equal(body.requiredBaseUnits, "3000000");
  assert.equal(body.headroomBaseUnits, "1250000");
  assert.equal(body.agent, AGENT);
  assert.equal(body.serviceId, SERVICE_ID);
  assert.equal(body.asset, ASSET_KEY);
  assert.equal(body.tool, TOOL);
  assert.match(body.action, /settle/i);

  // The 402 carries a complete charge block, so the client parses a refusal with
  // the parser it uses on a success. `amount` is what the call requires and did
  // not land; `openTab` is the figure the refusal path read back.
  assert.deepEqual(chargeBlockOf(execution.response), {
    amount: 3_000_000n,
    asset: { chainKey: 3n, address: USDC.address.toLowerCase() },
    serviceId: SERVICE_ID,
    tool: TOOL,
    openTab: OPEN_TAB_ON_REFUSAL,
    headroom: 1_250_000n,
  });
});

test("a 402 whose Open Tab cannot be read carries the figures in its body and no partial block", async () => {
  const plugin = pluginWith(
    revertingTabBook("LimitExceeded", [AGENT, USDC.address, 3_000_000n, 1_250_000n], async () => ({
      ok: false,
      error: { category: "UPSTREAM", code: "RPC_DOWN", message: "no endpoint", retryable: true },
    })),
  );

  const execution = await plugin.execute(request(), () => new Response("summary"));
  assert.equal(execution.response.status, 402);
  assert.equal(
    chargeBlockOf(execution.response),
    undefined,
    "an incomplete block is worse than none: the client cannot complete it by guessing",
  );
  const body = await execution.response.json();
  assert.equal(body.requiredBaseUnits, "3000000");
  assert.equal(body.headroomBaseUnits, "1250000");
});

test("each mapped revert produces its own status, and only LimitExceeded produces 402", async () => {
  const cases = [
    { name: "LimitExceeded", args: [AGENT, USDC.address, 3_000_000n, 1_250_000n], status: 402, code: "LIMIT_EXCEEDED", block: true },
    { name: "AuthorisationMissing", args: [AGENT, SERVICE_ID, USDC.address], status: 403, code: "AUTHORISATION_MISSING", block: false },
    { name: "AuthorisationExpired", args: [1_700_000_000n, 1_700_000_060n], status: 403, code: "AUTHORISATION_EXPIRED", block: false },
    { name: "AuthorisationExceeded", args: [5_000_000n, 4_000_000n, 3_000_000n], status: 403, code: "AUTHORISATION_EXCEEDED", block: false },
    { name: "TabIsDelinquent", args: [TAB_ID], status: 409, code: "TAB_DELINQUENT", block: false },
  ];

  for (const expected of cases) {
    const plugin = pluginWith(revertingTabBook(expected.name, expected.args));
    const execution = await plugin.execute(request(), () => new Response("summary"));

    assert.equal(execution.kind, "refused", `${expected.name} must refuse the request`);
    assert.equal(execution.response.status, expected.status, expected.name);
    const body = await execution.response.json();
    assert.equal(body.error.code, expected.code);
    assert.equal(body.requiredBaseUnits, "3000000");
    assert.equal(
      execution.response.status === 402,
      expected.name === "LimitExceeded",
      "402 belongs to LimitExceeded alone",
    );
    // A revert that carries no headroom has no complete charge block to send, and
    // a partial one is not an option.
    assert.equal(chargeBlockOf(execution.response) !== undefined, expected.block, expected.name);
  }
});

test("every Service-side revert delivers the response and never reaches the Agent", async () => {
  const serviceSide = Object.entries(RECORD_DELIVERY_REVERTS).filter(
    ([, mapping]) => mapping.disposition === "deliver-anyway",
  );
  assert.ok(serviceSide.length >= 10, "the table must keep the Service-side set the larger one");

  for (const [name, mapping] of serviceSide) {
    const reported = [];
    const plugin = pluginWith(revertingTabBook(name, []), {
      onMeteringFailed: (context) => reported.push(context.error.code),
    });
    const execution = await plugin.execute(request(), () => new Response("summary", { status: 200 }));

    assert.equal(execution.kind, "delivered", name);
    assert.equal(execution.response.status, 200, name);
    assert.equal(await execution.response.text(), "summary");
    assert.deepEqual(reported, [mapping.code], name);
  }
});

test("an unclassified revert is a chain fault, and the delivery still goes out", async () => {
  const plugin = pluginWith({
    async recordDelivery() {
      throw new Error("execution reverted: NotAnErrorThisSdkKnows()");
    },
    async openTabOf() {
      return { ok: true, value: 0n };
    },
  });

  const execution = await plugin.execute(request(), () => new Response("summary"));
  assert.equal(execution.kind, "delivered");
  assert.equal((await execution.metering).error.code, "RECORD_DELIVERY_REVERTED");
});

test("onLimitExceeded replaces the default 402 and receives the headroom", async () => {
  let seen;
  const plugin = pluginWith(
    revertingTabBook("LimitExceeded", [AGENT, USDC.address, 3_000_000n, 1_250_000n]),
    {
      onLimitExceeded: (context) => {
        seen = context;
        return new Response("settle first", { status: 402, headers: { "X-Tab": "custom" } });
      },
    },
  );

  const execution = await plugin.execute(request(), () => new Response("summary"));
  assert.equal(execution.kind, "refused");
  assert.equal(await execution.response.text(), "settle first");
  assert.equal(execution.response.headers.get("X-Tab"), "custom");
  assert.equal(seen.requiredBaseUnits, 3_000_000n);
  assert.equal(seen.headroomBaseUnits, 1_250_000n);
});

// ---------------------------------------------------------------- the mapping table

test("the revert table classifies ethers shapes and names the decoded arguments", () => {
  assert.deepEqual(decodeRevert({ revert: { name: "LimitExceeded", args: [1n] } }), {
    name: "LimitExceeded",
    args: [1n],
  });
  assert.deepEqual(decodeRevert({ errorName: "TabIsDelinquent", errorArgs: [TAB_ID] }), {
    name: "TabIsDelinquent",
    args: [TAB_ID],
  });
  assert.equal(decodeRevert("execution reverted"), undefined);
  assert.equal(decodeRevert({ name: "SomethingElse" }), undefined);

  const error = classifyRecordDeliveryRevert({
    revert: { name: "LimitExceeded", args: [AGENT, USDC.address, 3_000_000n, 1_250_000n] },
  });
  assert.equal(error.category, "LIMIT");
  assert.equal(error.details.revert, "LimitExceeded");
  assert.equal(error.details.requested, "3000000");
  assert.equal(detailAmount(error, "headroom"), 1_250_000n);
  assert.equal(detailAmount(error, "nothing"), undefined);
  assert.equal(dispositionOf(error), "refuse-request");
  assert.equal(dispositionOf(classifyRecordDeliveryRevert({ revert: { name: "UnknownTool" } })), "deliver-anyway");
});

test("a consumer callback that throws cannot take down a delivered response", async () => {
  const plugin = pluginWith(acceptingTabBook(), {
    priceOf: () => {
      throw new Error("pricing table unavailable");
    },
  });
  const thrownPricing = await plugin.execute(request(), () => new Response("summary"));
  assert.equal(thrownPricing.kind, "delivered");
  assert.equal((await thrownPricing.metering).reason, "not-priced");

  const chargeThrows = pluginWith(acceptingTabBook(), {
    onCharge: () => {
      throw new Error("logging sink down");
    },
  });
  const execution = await chargeThrows.execute(request(), () => new Response("summary"));
  assert.equal(execution.kind, "delivered");
  assert.equal((await execution.metering).kind, "charged");
});
