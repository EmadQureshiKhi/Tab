import assert from "node:assert/strict";
import { test } from "node:test";

import { walkDeliveryFeed } from "../dist/feed.js";
import { AGENT_A, AGENT_B, SERVICE, USDC } from "./fake-chain.mjs";

const row = (agent) => ({ agent, serviceId: SERVICE, asset: USDC, tool: `0x${"33".repeat(32)}`, units: 1, amount: "10000", timestamp: 1, monad: {} });
const page = (deliveries, nextCursor) => ({ status: 200, json: async () => ({ index: {}, deliveries, nextCursor }) });

test("the walk follows the registry's cursor to the end and names each tab once", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (!url.includes("cursor=")) return page([row(AGENT_A), row(AGENT_A)], "c1");
    if (url.includes("cursor=c1")) return page([row(AGENT_B), row(AGENT_A)], null);
    throw new Error(`unexpected ${url}`);
  };
  const walked = await walkDeliveryFeed({ registryUrl: "http://registry.test/", fetchImpl, maxPages: 10 });
  assert.ok(walked.ok, walked.ok ? "" : walked.error.message);
  assert.deepEqual(walked.value.candidates.map((c) => c.agent), [AGENT_A, AGENT_B]);
  assert.equal(walked.value.rows, 4);
  assert.equal(walked.value.pages, 2);
  assert.deepEqual(urls, ["http://registry.test/deliveries?limit=100", "http://registry.test/deliveries?limit=100&cursor=c1"]);
});

test("a feed that never ends is FEED_TOO_LONG, not a shorter list", async () => {
  const fetchImpl = async () => page([row(AGENT_A)], "again");
  const walked = await walkDeliveryFeed({ registryUrl: "http://registry.test", fetchImpl, maxPages: 3 });
  assert.ok(!walked.ok);
  assert.equal(walked.error.code, "FEED_TOO_LONG");
});

test("a malformed row, a non-200, and a non-JSON body each fail the walk by name", async () => {
  const malformed = await walkDeliveryFeed({ registryUrl: "http://r", fetchImpl: async () => page([{ agent: AGENT_A }], null), maxPages: 1 });
  assert.equal(malformed.error.code, "FEED_MALFORMED");
  const status = await walkDeliveryFeed({ registryUrl: "http://r", fetchImpl: async () => ({ status: 503, json: async () => ({}) }), maxPages: 1 });
  assert.equal(status.error.code, "FEED_STATUS");
  const text = await walkDeliveryFeed({ registryUrl: "http://r", fetchImpl: async () => ({ status: 200, json: async () => { throw new Error("nope"); } }), maxPages: 1 });
  assert.equal(text.error.code, "FEED_MALFORMED");
  const down = await walkDeliveryFeed({ registryUrl: "http://r", fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, maxPages: 1 });
  assert.equal(down.error.code, "FEED_UNREACHABLE");
});
