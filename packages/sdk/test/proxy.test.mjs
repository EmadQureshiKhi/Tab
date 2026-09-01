/**
 * The proxy layer (R23.4).
 *
 * Checked here: hooks run in registration order before the forward and in
 * reverse order after it; a hook that fails or throws is logged and skipped
 * unless it declared `critical`, in which case the request fails with its error
 * at the category's status; the forward carries the path, the query, the body,
 * and every header but the hop-by-hop set; the metering plugin sees the upstream
 * response exactly as it sees a handler's, so the charge block lands and a
 * `LimitExceeded` is a 402; an unreachable upstream is a 502 and not a delivery;
 * and under `before-metering` the response is returned while the recording is
 * still pending.
 *
 * Requirements: 23.4, 23.3
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { TAB_HEADER, parseChargeHeaders } from "../dist/http/index.js";
import { classifyRecordDeliveryRevert, tabPostPaid } from "../dist/server/index.js";
import { HOP_BY_HOP_HEADERS, createTabProxy, resolveUpstream } from "../dist/proxy/index.js";

const AGENT = "0x00000000000000000000000000000000000000A1";
const SERVICE_ID = `0x${"11".repeat(32)}`;
const TOOL = `0x${"22".repeat(32)}`;
const USDC = {
  chainKey: 3n,
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  decimals: 6,
  symbol: "USDC",
};

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function collectingLogger() {
  const lines = [];
  const at = (level) => (message, fields) => lines.push({ level, message, fields });
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A TabBook that accepts every delivery and records what it was asked. */
function acceptingTabBook(calls = []) {
  return {
    async recordDelivery(delivery) {
      calls.push(delivery);
      return {
        ok: true,
        value: {
          charged: BigInt(delivery.units) * delivery.expectedUnitPrice,
          openAfter: 3_000_000n,
          headroomAfter: 2_000_000n,
          recordedAt: 1_700_000_000_000,
        },
      };
    },
    async openTabOf() {
      return { ok: true, value: 3_000_000n };
    },
  };
}

function refusingTabBook() {
  return {
    async recordDelivery() {
      return {
        ok: false,
        error: classifyRecordDeliveryRevert({
          revert: { name: "LimitExceeded", args: [AGENT, USDC.address, 3_000_000n, 1_000_000n] },
        }),
      };
    },
    async openTabOf() {
      return { ok: true, value: 4_000_000n };
    },
  };
}

function plugin(tabBook, overrides = {}) {
  return tabPostPaid({
    serviceId: SERVICE_ID,
    asset: USDC,
    tabBook,
    priceOf: () => ({ tool: TOOL, units: 3, unitPrice: 1_000_000n }),
    logger: silent,
    ...overrides,
  });
}

/** An upstream that records what it received and answers a streamed body. */
function upstream(status = 200, body = "hello from upstream") {
  const calls = [];
  const fetchImpl = async (url, init) => {
    let received = null;
    if (init.body !== undefined && init.body !== null) {
      received = await new Response(init.body).text();
    }
    calls.push({ url, method: init.method, headers: init.headers, body: received, duplex: init.duplex });
    return new Response(body, {
      status,
      headers: { "content-type": "text/plain", "content-encoding": "gzip", "x-upstream": "yes" },
    });
  };
  return { calls, fetchImpl };
}

function orderedHook(name, events, overrides = {}) {
  return {
    name,
    async before(context) {
      events.push(`${name}:before`);
      assert.equal(context.phase, "before");
      return { ok: true, value: undefined };
    },
    async after(context) {
      events.push(`${name}:after`);
      assert.equal(context.phase, "after");
      assert.ok(context.response instanceof Response);
      return { ok: true, value: undefined };
    },
    ...overrides,
  };
}

const request = (path = "/v1/summarise?lang=en", init = {}) =>
  new Request(`https://service.example${path}`, {
    method: "POST",
    headers: { [TAB_HEADER.agent]: AGENT, "content-type": "text/plain", connection: "keep-alive", host: "service.example" },
    body: "the body",
    ...init,
  });

test("hooks run in registration order before the forward and in reverse order after it", async () => {
  const events = [];
  const up = upstream();
  const proxy = createTabProxy({
    upstream: "https://upstream.example/base",
    hooks: [orderedHook("a", events), orderedHook("b", events), orderedHook("c", events)],
    metering: plugin(acceptingTabBook()),
    fetchImpl: async (url, init) => {
      events.push("forward");
      return up.fetchImpl(url, init);
    },
    logger: silent,
  });

  const result = await proxy.proxy(request());
  assert.equal(result.kind, "delivered");
  assert.deepEqual(events, ["a:before", "b:before", "c:before", "forward", "c:after", "b:after", "a:after"]);
  assert.deepEqual(result.hookFailures, []);
  assert.equal(await result.response.text(), "hello from upstream");
});

test("the forward carries the path, the query, the body, and the headers minus the hop-by-hop set", async () => {
  const up = upstream();
  const proxy = createTabProxy({
    upstream: "https://upstream.example/base",
    metering: plugin(acceptingTabBook()),
    fetchImpl: up.fetchImpl,
    logger: silent,
  });

  await proxy(request());
  assert.equal(up.calls.length, 1);
  const [call] = up.calls;
  assert.equal(call.url, "https://upstream.example/base/v1/summarise?lang=en");
  assert.equal(call.method, "POST");
  assert.equal(call.body, "the body");
  assert.equal(call.duplex, "half", "a streamed request body needs duplex: half");
  const names = Object.keys(call.headers).map((name) => name.toLowerCase());
  assert.ok(names.includes("content-type"));
  assert.ok(names.includes(TAB_HEADER.agent.toLowerCase()), "the Agent claim is forwarded");
  for (const hop of [...HOP_BY_HOP_HEADERS, "host", "content-length"]) {
    assert.ok(!names.includes(hop), `${hop} must not be forwarded`);
  }
});

test("a GET forwards no body, and the upstream's framing headers are not passed back", async () => {
  const up = upstream();
  const proxy = createTabProxy({
    upstream: "https://upstream.example",
    metering: plugin(acceptingTabBook()),
    fetchImpl: up.fetchImpl,
    logger: silent,
  });
  const response = await proxy(new Request("https://service.example/v1/thing", { headers: { [TAB_HEADER.agent]: AGENT } }));
  assert.equal(up.calls[0].body, null);
  assert.equal(up.calls[0].duplex, undefined);
  assert.equal(response.headers.get("x-upstream"), "yes");
  assert.equal(response.headers.get("content-encoding"), null, "the host fetch already decoded the body");
  assert.equal(await response.text(), "hello from upstream");
});

test("the upstream response is metered exactly as a handler's: the charge block lands on it", async () => {
  const calls = [];
  const up = upstream();
  const proxy = createTabProxy({
    upstream: "https://upstream.example",
    metering: plugin(acceptingTabBook(calls)),
    fetchImpl: up.fetchImpl,
    logger: silent,
  });

  const result = await proxy.proxy(request());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent, AGENT);
  const block = parseChargeHeaders(result.response.headers);
  assert.ok(block.ok && block.value !== undefined, "the six charge headers are present");
  assert.equal(block.value.amount, 3_000_000n);
  assert.equal(result.charge?.amount, 3_000_000n);
  assert.equal((await result.metering).kind, "charged");
});

test("after hooks see the recorded charge and the metering outcome", async () => {
  let seen;
  const proxy = createTabProxy({
    upstream: "https://upstream.example",
    hooks: [
      {
        name: "observer",
        async after(context) {
          seen = { charge: context.charge, metering: context.metering };
          return { ok: true, value: undefined };
        },
      },
    ],
    metering: plugin(acceptingTabBook()),
    fetchImpl: upstream().fetchImpl,
    logger: silent,
  });
  await proxy(request());
  assert.equal(seen.charge.agent, AGENT);
  assert.equal(seen.metering.kind, "charged");
});

test("a LimitExceeded refusal replaces the response with a 402, and the after hooks still run", async () => {
  const events = [];
  const proxy = createTabProxy({
    upstream: "https://upstream.example",
    hooks: [orderedHook("a", events)],
    metering: plugin(refusingTabBook()),
    fetchImpl: upstream().fetchImpl,
    logger: silent,
  });
  const result = await proxy.proxy(request());
  assert.equal(result.kind, "refused");
  assert.equal(result.response.status, 402);
  assert.equal(result.charge, undefined);
  assert.deepEqual(events, ["a:before", "a:after"]);
  const body = await result.response.json();
  assert.equal(body.error.code, "LIMIT_EXCEEDED");
});

test("a non-critical hook that fails is logged and skipped, and the request still succeeds", async () => {
  const logger = collectingLogger();
  const events = [];
  const failing = {
    name: "shipper",
    async before() {
      return { ok: false, error: { category: "UPSTREAM", code: "SHIPPER_DOWN", message: "log shipper is down", retryable: true } };
    },
    async after() {
      throw new Error("after phase exploded");
    },
  };
  const proxy = createTabProxy({
    upstream: "https://upstream.example",
    hooks: [failing, orderedHook("b", events)],
    metering: plugin(acceptingTabBook()),
    fetchImpl: upstream().fetchImpl,
    logger,
  });

  const result = await proxy.proxy(request());
  assert.equal(result.kind, "delivered");
  assert.equal(result.response.status, 200);
  assert.deepEqual(events, ["b:before", "b:after"]);
  assert.equal(result.hookFailures.length, 2);
  assert.equal(result.hookFailures[0].code ?? result.hookFailures[0].error.code, "SHIPPER_DOWN");
  assert.equal(result.hookFailures[0].phase, "before");
  assert.equal(result.hookFailures[1].error.code, "HOOK_THREW");
  assert.equal(result.hookFailures[1].phase, "after");
  assert.equal(logger.lines.filter((line) => line.level === "warn").length, 2);
  assert.equal(logger.lines.filter((line) => line.level === "error").length, 0);
});

test("a critical before hook that fails answers with its error and the upstream is never called", async () => {
  const up = upstream();
  const events = [];
  const proxy = createTabProxy({
    upstream: "https://upstream.example",
    hooks: [
      orderedHook("a", events),
      {
        name: "gate",
        critical: true,
        async before() {
          return { ok: false, error: { category: "UNAVAILABLE", code: "MAINTENANCE", message: "closed", retryable: true } };
        },
      },
      orderedHook("c", events),
    ],
    metering: plugin(acceptingTabBook()),
    fetchImpl: up.fetchImpl,
    logger: silent,
  });
  const result = await proxy.proxy(request());
  assert.equal(result.kind, "failed");
  assert.equal(result.response.status, 503);
  assert.equal(result.failure.code, "MAINTENANCE");
  assert.equal(up.calls.length, 0);
  assert.deepEqual(events, ["a:before"], "nothing after the critical failure runs, not even the after phases");
  const body = await result.response.json();
  assert.equal(body.error.code, "MAINTENANCE");
});

test("a critical after hook that fails replaces the upstream response and cancels its body", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const proxy = createTabProxy({
    upstream: "https://upstream.example",
    hooks: [
      {
        name: "audit",
        critical: true,
        async after() {
          return { ok: false, error: { category: "INTERNAL", code: "AUDIT_FAILED", message: "no audit record", retryable: false } };
        },
      },
    ],
    metering: plugin(acceptingTabBook()),
    fetchImpl: async () => new Response(stream, { status: 200 }),
    logger: silent,
  });
  const result = await proxy.proxy(request());
  assert.equal(result.kind, "failed");
  assert.equal(result.response.status, 500);
  assert.equal(result.failure.code, "AUDIT_FAILED");
  assert.equal(cancelled, true);
});

test("an unreachable upstream is a 502 carrying the error, is not metered, and the after hooks still run", async () => {
  const calls = [];
  const events = [];
  const proxy = createTabProxy({
    upstream: "https://upstream.example",
    hooks: [orderedHook("a", events)],
    metering: plugin(acceptingTabBook(calls)),
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
    logger: silent,
  });
  const result = await proxy.proxy(request());
  assert.equal(result.kind, "failed");
  assert.equal(result.response.status, 502);
  assert.equal(result.failure.code, "PROXY_UPSTREAM_UNREACHABLE");
  assert.equal(calls.length, 0, "a failed forward is not a delivery");
  assert.deepEqual(events, ["a:before", "a:after"]);
  const body = await result.response.json();
  assert.equal(body.error.cause.message, "ECONNREFUSED");
});

test("a fetch that returns a non-response is a 502 rather than a throw", async () => {
  const proxy = createTabProxy({
    upstream: "https://upstream.example",
    metering: plugin(acceptingTabBook()),
    fetchImpl: async () => "not a response",
    logger: silent,
  });
  const result = await proxy.proxy(request());
  assert.equal(result.response.status, 502);
  assert.equal(result.failure.code, "PROXY_UPSTREAM_INVALID");
});

test("an unusable upstream URL is reported by the request, as a VALIDATION error, and nothing is sent", async () => {
  const up = upstream();
  const proxy = createTabProxy({
    upstream: "upstream.example/no-scheme",
    metering: plugin(acceptingTabBook()),
    fetchImpl: up.fetchImpl,
    logger: silent,
  });
  const result = await proxy.proxy(request());
  assert.equal(result.response.status, 400);
  assert.equal(result.failure.code, "UPSTREAM_INVALID");
  assert.equal(up.calls.length, 0);
  assert.equal(resolveUpstream("ftp://x", "https://s/x").ok, false);
  assert.equal(resolveUpstream("https://u/base", "https://s/p/q?x=1").value, "https://u/base/p/q?x=1");
  assert.equal(resolveUpstream("https://u/base/", "https://s/").value, "https://u/base/");
});

test("under before-metering the response is returned while the recording is still pending", async () => {
  const gate = deferred();
  const calls = [];
  const tabBook = {
    async recordDelivery(delivery) {
      await gate.promise;
      calls.push(delivery);
      return { ok: true, value: { charged: 3_000_000n, openAfter: 1n, headroomAfter: 1n, recordedAt: 1 } };
    },
    async openTabOf() {
      return { ok: true, value: 0n };
    },
  };
  let seenCharge = "unset";
  const proxy = createTabProxy({
    upstream: "https://upstream.example",
    hooks: [
      {
        name: "observer",
        async after(context) {
          seenCharge = context.charge;
          return { ok: true, value: undefined };
        },
      },
    ],
    metering: plugin(tabBook, { release: "before-metering" }),
    fetchImpl: upstream().fetchImpl,
    logger: silent,
  });

  const result = await proxy.proxy(request());
  assert.equal(result.kind, "delivered");
  assert.equal(await result.response.text(), "hello from upstream");
  assert.equal(calls.length, 0, "the response is in hand and the delivery is not yet recorded");
  assert.equal(seenCharge, undefined, "the after hooks ran before the recording finished");
  gate.resolve();
  assert.equal((await result.metering).kind, "charged");
  assert.equal(calls.length, 1);
});

test("the proxy is a plain handler, and onResult sees every result and cannot break one", async () => {
  const results = [];
  const proxy = createTabProxy({
    upstream: "https://upstream.example",
    metering: plugin(acceptingTabBook()),
    fetchImpl: upstream().fetchImpl,
    logger: silent,
    onResult(result) {
      results.push(result.kind);
      throw new Error("consumer bug");
    },
  });
  assert.equal(typeof proxy, "function");
  assert.equal(proxy.upstream, "https://upstream.example");
  const response = await proxy(request());
  assert.equal(response.status, 200);
  assert.deepEqual(results, ["delivered"]);
});

test("hook state is shared across phases and is exposed on the result", async () => {
  const proxy = createTabProxy({
    upstream: "https://upstream.example",
    hooks: [
      {
        name: "timer",
        async before(context) {
          context.state.set("timer", "started");
          return { ok: true, value: undefined };
        },
        async after(context) {
          context.state.set("timer", `${context.state.get("timer")} then finished`);
          return { ok: true, value: undefined };
        },
      },
    ],
    metering: plugin(acceptingTabBook()),
    fetchImpl: upstream().fetchImpl,
    logger: silent,
  });
  const result = await proxy.proxy(request());
  assert.equal(result.state.get("timer"), "started then finished");
});
