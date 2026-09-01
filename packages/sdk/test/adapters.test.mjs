/**
 * The three framework adapters: Hono, Express, and Next.js route handlers.
 *
 * Each is checked on the same three facts — the delivery is recorded after the
 * handler produced its response, the charge block reaches the caller, and a
 * `LimitExceeded` refusal replaces the response with a 402 carrying the required
 * amount and the headroom. The block is read back through the shared parser, so
 * each adapter is checked against the wire contract rather than against a string.
 *
 * Requirements: 23.3, 12.1
 */

import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import { TAB_HEADER, parseChargeHeaders } from "../dist/http/index.js";
import {
  classifyRecordDeliveryRevert,
  expressTabPostPaid,
  honoTabPostPaid,
  meteredRequestFrom,
  tabPostPaid,
  withTabPostPaid,
} from "../dist/server/index.js";

const AGENT = "0x00000000000000000000000000000000000000A1";
const SERVICE_ID = `0x${"11".repeat(32)}`;
const TOOL = `0x${"22".repeat(32)}`;
const USDC = {
  chainKey: 3n,
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  decimals: 6,
  symbol: "USDC",
};
const OPEN_TAB_ON_REFUSAL = 6_250_000n;

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const decoder = new TextDecoder();

function deferred() {
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function accepting(calls = []) {
  return {
    calls,
    async recordDelivery(delivery) {
      calls.push(delivery);
      return {
        ok: true,
        value: {
          charged: BigInt(delivery.units) * delivery.expectedUnitPrice,
          openAfter: 9_000_000n,
          headroomAfter: 4_000_000n,
          recordedAt: 0,
        },
      };
    },
    async openTabOf() {
      return { ok: true, value: OPEN_TAB_ON_REFUSAL };
    },
  };
}

function overLimit() {
  return {
    async recordDelivery() {
      return {
        ok: false,
        error: classifyRecordDeliveryRevert({
          revert: { name: "LimitExceeded", args: [AGENT, USDC.address, 2_000_000n, 750_000n] },
        }),
      };
    },
    async openTabOf() {
      return { ok: true, value: OPEN_TAB_ON_REFUSAL };
    },
  };
}

function pluginWith(tabBook, overrides = {}) {
  return tabPostPaid({
    serviceId: SERVICE_ID,
    asset: USDC,
    tabBook,
    priceOf: () => ({ tool: TOOL, units: 2, unitPrice: 1_000_000n }),
    logger: silent,
    ...overrides,
  });
}

/** The charge block a header source carries, read by the client's own parser. */
function chargeBlockOf(source) {
  const parsed = parseChargeHeaders(source);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error.message);
  return parsed.value;
}

const webRequest = () =>
  new Request("https://service.example/v1/summarise", {
    method: "POST",
    headers: { [TAB_HEADER.agent]: AGENT, [TAB_HEADER.authorisation]: `0x${"44".repeat(32)}` },
  });

// ---------------------------------------------------------------- Hono

/** The two fields of a Hono context the middleware touches. */
function honoContext() {
  return { req: { raw: webRequest() }, res: new Response(null, { status: 200 }) };
}

test("hono: the delivery is recorded after the handler chain and the block lands on c.res", async () => {
  const order = [];
  const calls = [];
  const tabBook = accepting(calls);
  const middleware = honoTabPostPaid(
    pluginWith({
      async recordDelivery(delivery) {
        order.push("metered");
        return tabBook.recordDelivery(delivery);
      },
      openTabOf: tabBook.openTabOf,
    }),
  );

  const context = honoContext();
  await middleware(context, async () => {
    order.push("handler");
    await tick();
    context.res = new Response("summary", { status: 200 });
  });

  assert.deepEqual(order, ["handler", "metered"]);
  assert.equal(calls.length, 1);
  assert.equal(context.res.status, 200);
  assert.equal(await context.res.text(), "summary");
  assert.deepEqual(chargeBlockOf(context.res.headers), {
    amount: 2_000_000n,
    asset: { chainKey: 3n, address: USDC.address.toLowerCase() },
    serviceId: SERVICE_ID,
    tool: TOOL,
    openTab: 9_000_000n,
    headroom: 4_000_000n,
  });
});

test("hono: LimitExceeded replaces c.res with a 402 naming the amount and the headroom", async () => {
  const middleware = honoTabPostPaid(pluginWith(overLimit()));
  const context = honoContext();

  await middleware(context, async () => {
    context.res = new Response("summary", { status: 200 });
  });

  assert.equal(context.res.status, 402);
  const block = chargeBlockOf(context.res.headers);
  assert.equal(block.amount, 2_000_000n);
  assert.equal(block.headroom, 750_000n);
  assert.equal(block.openTab, OPEN_TAB_ON_REFUSAL);
  const body = await context.res.json();
  assert.equal(body.error.code, "LIMIT_EXCEEDED");
  assert.equal(body.requiredBaseUnits, "2000000");
  assert.equal(body.headroomBaseUnits, "750000");
});

test("hono: a handler that throws is re-raised for hono's own error handling, and nothing is metered", async () => {
  const calls = [];
  const middleware = honoTabPostPaid(pluginWith(accepting(calls)));
  const context = honoContext();
  const boom = new Error("route failed");

  await assert.rejects(
    middleware(context, async () => {
      throw boom;
    }),
    (thrown) => thrown === boom,
  );
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------- Express

/** An Express-shaped response: the fields the adapter touches, and a record of what left. */
function expressResponse() {
  const headers = new Map();
  const listeners = [];
  const written = [];
  const state = {
    statusCode: 200,
    headersSent: false,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), String(value));
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
    },
    write(chunk) {
      written.push(chunk);
      return true;
    },
    end(chunk, callback) {
      if (chunk !== undefined && typeof chunk !== "function") written.push(chunk);
      const done = typeof chunk === "function" ? chunk : callback;
      for (const listener of listeners) listener();
      if (typeof done === "function") done();
      return state;
    },
    on(event, listener) {
      if (event === "finish") listeners.push(listener);
      return state;
    },
  };
  return {
    res: state,
    header: (name) => headers.get(name.toLowerCase()),
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    body: () =>
      written
        .map((chunk) => (typeof chunk === "string" ? chunk : decoder.decode(chunk)))
        .join(""),
  };
}

const expressRequest = () => ({
  method: "POST",
  originalUrl: "/v1/summarise",
  headers: { "tab-agent": AGENT },
});

test("express: the buffered body goes out with its charge block once the delivery is recorded", async () => {
  const calls = [];
  const captured = [];
  const middleware = expressTabPostPaid(pluginWith(accepting(calls)), {
    onMetering: (metering) => captured.push(metering),
    logger: silent,
  });

  const response = expressResponse();
  middleware(expressRequest(), response.res, () => {
    response.res.write("sum");
    response.res.end("mary");
  });

  await captured[0];
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(response.body(), "summary");
  assert.equal(response.header("Content-Length"), "7");
  assert.deepEqual(chargeBlockOf(response.headers), {
    amount: 2_000_000n,
    asset: { chainKey: 3n, address: USDC.address.toLowerCase() },
    serviceId: SERVICE_ID,
    tool: TOOL,
    openTab: 9_000_000n,
    headroom: 4_000_000n,
  });
});

test("express: LimitExceeded replaces the buffered body with a 402", async () => {
  const captured = [];
  const middleware = expressTabPostPaid(pluginWith(overLimit()), {
    onMetering: (metering) => captured.push(metering),
    logger: silent,
  });

  const response = expressResponse();
  middleware(expressRequest(), response.res, () => {
    response.res.end("summary");
  });

  await captured[0];
  await tick();

  assert.equal(response.res.statusCode, 402);
  const block = chargeBlockOf(response.headers);
  assert.equal(block.amount, 2_000_000n);
  assert.equal(block.headroom, 750_000n);
  const parsed = JSON.parse(response.body());
  assert.equal(parsed.error.code, "LIMIT_EXCEEDED");
  assert.equal(parsed.requiredBaseUnits, "2000000");
  assert.equal(parsed.headroomBaseUnits, "750000");
});

test("express: under before-metering the bytes leave untouched and the charge follows them", async () => {
  const gate = deferred();
  const captured = [];
  let recorded = false;
  const middleware = expressTabPostPaid(
    pluginWith(
      {
        async recordDelivery() {
          await gate.promise;
          recorded = true;
          return {
            ok: true,
            value: { charged: 2_000_000n, openAfter: 1n, headroomAfter: 1n, recordedAt: 0 },
          };
        },
        async openTabOf() {
          return { ok: true, value: 0n };
        },
      },
      { release: "before-metering" },
    ),
    { onMetering: (metering) => captured.push(metering), logger: silent },
  );

  const response = expressResponse();
  const originalEnd = response.res.end;
  middleware(expressRequest(), response.res, () => {
    response.res.end("summary");
  });

  // Nothing was intercepted, and the response is already written while the
  // recording has not even been made.
  assert.equal(response.res.end, originalEnd, "before-metering must not replace res.end");
  assert.equal(response.body(), "summary");
  assert.equal(recorded, false);
  assert.equal(response.header(TAB_HEADER.chargeAmount), undefined);

  gate.resolve();
  assert.equal((await captured[0]).kind, "charged");
  assert.equal(recorded, true);
});

test("express: a request becomes a MeteredRequest without touching its body", () => {
  const metered = meteredRequestFrom({
    method: "GET",
    originalUrl: "/v1/summarise?units=2",
    headers: { "tab-agent": AGENT, "x-forwarded-for": ["a", "b"] },
  });
  assert.equal(metered.method, "GET");
  assert.equal(metered.url, "http://localhost/v1/summarise?units=2");
  assert.equal(metered.headers.get(TAB_HEADER.agent), AGENT);
  assert.equal(metered.headers.get("X-Forwarded-For"), "a, b");
  assert.equal(metered.headers.get("absent"), null);
});

// ---------------------------------------------------------------- Next.js

test("next: the wrapped route handler returns its own response carrying the charge block", async () => {
  const calls = [];
  const context = { params: Promise.resolve({ id: "7" }) };
  let seenContext;

  const route = withTabPostPaid(pluginWith(accepting(calls)), (request, ctx) => {
    seenContext = ctx;
    return new Response("summary", { status: 200 });
  });

  const response = await route(webRequest(), context);

  assert.equal(seenContext, context, "the route context is handed through untouched");
  assert.equal(calls.length, 1);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "summary");
  const block = chargeBlockOf(response.headers);
  assert.equal(block.amount, 2_000_000n);
  assert.equal(block.openTab, 9_000_000n);
  assert.equal(block.headroom, 4_000_000n);
});

test("next: LimitExceeded becomes a 402 and a thrown handler is re-raised unmetered", async () => {
  const refused = await withTabPostPaid(pluginWith(overLimit()), () => new Response("summary"))(
    webRequest(),
    {},
  );
  assert.equal(refused.status, 402);
  const body = await refused.json();
  assert.equal(body.requiredBaseUnits, "2000000");
  assert.equal(body.headroomBaseUnits, "750000");

  const calls = [];
  const boom = new Error("route failed");
  const route = withTabPostPaid(pluginWith(accepting(calls)), () => {
    throw boom;
  });
  await assert.rejects(route(webRequest(), {}), (thrown) => thrown === boom);
  assert.deepEqual(calls, []);
});

test("next: before-metering hands the pending recording to the host keep-alive hook", async () => {
  const gate = deferred();
  const tasks = [];
  const plugin = pluginWith(
    {
      async recordDelivery() {
        await gate.promise;
        return {
          ok: true,
          value: { charged: 2_000_000n, openAfter: 1n, headroomAfter: 1n, recordedAt: 0 },
        };
      },
      async openTabOf() {
        return { ok: true, value: 0n };
      },
    },
    { release: "before-metering" },
  );

  const route = withTabPostPaid(plugin, () => new Response("summary"), {
    after: (task) => tasks.push(task),
  });

  const response = await route(webRequest(), {});
  assert.equal(await response.text(), "summary");
  assert.equal(tasks.length, 1, "the recording is handed to `after` so the runtime keeps it alive");

  gate.resolve();
  assert.equal((await tasks[0]()).kind, "charged");
});
