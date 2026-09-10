/**
 * The agent card fetcher, against a fake `fetch`.
 *
 * A card is somebody else's document at somebody else's origin, so what is
 * asserted here is the discipline around fetching it: which schemes are fetched,
 * the timeout, the size cap, JSON or nothing, and the cache that keeps a page
 * reload from becoming a request against that origin.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createCardFetcher, decodeDataUri, fetchableUrl, type CardResult } from "../src/agent-card.js";

const CARD = { type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "demo", endpoints: [] };

const code = (result: CardResult): string | null => (result.ok ? null : result.error.code);

function fakeFetch(responses: readonly (() => Response | Promise<Response>)[]): {
  readonly fetch: typeof globalThis.fetch;
  readonly urls: string[];
} {
  const urls: string[] = [];
  const queue = [...responses];
  const fetch: typeof globalThis.fetch = async (input) => {
    urls.push(String(input));
    const next = queue.shift();
    if (next === undefined) throw new Error("fake fetch: no response queued");
    return next();
  };
  return { fetch, urls };
}

test("a base64 data: URI is decoded in process and never fetched", async () => {
  const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(CARD)).toString("base64")}`;
  const { fetch, urls } = fakeFetch([]);
  const cards = createCardFetcher({ fetch });
  const result = await cards.fetch(uri);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value, CARD);
  assert.deepEqual(urls, []);
});

test("a percent-encoded data: URI decodes too, and a non-JSON one is named as such", () => {
  const plain = decodeDataUri(`data:application/json,${encodeURIComponent(JSON.stringify(CARD))}`);
  assert.ok(plain.ok);
  assert.equal(code(decodeDataUri("data:text/plain,hello")), "CARD_NOT_JSON");
  assert.equal(code(decodeDataUri("data:application/json;base64,!!!!")), "CARD_NOT_JSON");
  assert.equal(code(decodeDataUri("data:nonsense")), "CARD_NOT_JSON");
});

test("https: is fetched as is, ipfs: through the gateway, and anything else is refused", async () => {
  assert.equal(fetchableUrl("https://example.com/agent.json", "https://gw/ipfs/"), "https://example.com/agent.json");
  assert.equal(fetchableUrl("ipfs://bafyabc/card.json", "https://gw/ipfs/"), "https://gw/ipfs/bafyabc/card.json");
  assert.equal(fetchableUrl("http://example.com/agent.json", "https://gw/ipfs/"), null);
  assert.equal(fetchableUrl("ftp://example.com/agent.json", "https://gw/ipfs/"), null);

  const cards = createCardFetcher({ fetch: fakeFetch([]).fetch });
  assert.equal(code(await cards.fetch("http://example.com/agent.json")), "CARD_SCHEME_UNSUPPORTED");
  assert.equal(code(await cards.fetch("")), "CARD_URI_EMPTY");
});

test("a JSON card over https is served with its fetch time", async () => {
  const { fetch, urls } = fakeFetch([() => new Response(JSON.stringify(CARD), { status: 200 })]);
  const cards = createCardFetcher({ fetch });
  const result = await cards.fetch("https://example.com/agent.json");
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value, CARD);
  assert.match(result.fetchedAt, /^\d{4}-/);
  assert.deepEqual(urls, ["https://example.com/agent.json"]);
});

test("an error status, a non-JSON body, and an oversized body are each named", async () => {
  const big = "x".repeat(2_000);
  const { fetch } = fakeFetch([
    () => new Response("nope", { status: 404 }),
    () => new Response("<html>", { status: 200 }),
    () => new Response(big, { status: 200, headers: { "content-length": String(big.length) } }),
    () => new Response(big, { status: 200 }),
  ]);
  const cards = createCardFetcher({ fetch, maxBytes: 1_000, failureTtlMs: 0 });
  assert.equal(code(await cards.fetch("https://a.example/1")), "CARD_HTTP_ERROR");
  assert.equal(code(await cards.fetch("https://a.example/2")), "CARD_NOT_JSON");
  assert.equal(code(await cards.fetch("https://a.example/3")), "CARD_TOO_LARGE");
  assert.equal(code(await cards.fetch("https://a.example/4")), "CARD_TOO_LARGE");
});

test("an origin that does not answer in time is a timeout", async () => {
  const { fetch } = fakeFetch([
    () =>
      new Promise<Response>((_resolve, reject) => {
        setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 50);
      }),
  ]);
  const cards = createCardFetcher({ fetch, timeoutMs: 10 });
  assert.equal(code(await cards.fetch("https://slow.example/agent.json")), "CARD_TIMEOUT");
});

test("a card is cached for ten minutes and a failure for one", async () => {
  let clock = 5_000_000;
  const { fetch, urls } = fakeFetch([
    () => new Response(JSON.stringify(CARD), { status: 200 }),
    () => new Response("down", { status: 503 }),
    () => new Response(JSON.stringify(CARD), { status: 200 }),
  ]);
  const cards = createCardFetcher({ fetch, now: () => clock });
  const uri = "https://example.com/agent.json";

  await cards.fetch(uri);
  clock += 9 * 60 * 1000;
  await cards.fetch(uri);
  assert.equal(urls.length, 1);

  clock += 2 * 60 * 1000;
  assert.equal(code(await cards.fetch(uri)), "CARD_HTTP_ERROR");
  clock += 30 * 1000;
  assert.equal(code(await cards.fetch(uri)), "CARD_HTTP_ERROR", "the failure is remembered for a minute");
  assert.equal(urls.length, 2);

  clock += 31 * 1000;
  assert.ok((await cards.fetch(uri)).ok);
  assert.equal(urls.length, 3);
});
