/**
 * Nansen labels, against a fake `fetch`.
 *
 * Three properties matter and each is asserted directly: the request is the one
 * Nansen documents, with the key in the `apikey` header and nowhere else; every
 * outcome is either labels with a source and a fetch time or a stated
 * `unavailable`, never an empty list standing in for an unanswered question; and
 * the key appears in no message this module produces.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NANSEN_KEY_MISSING,
  NANSEN_LABELS_URL,
  createNansenLabels,
  entityOf,
  parseLabelsBody,
  type LabelsView,
} from "../src/nansen.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const KEY = "nansen-test-key-do-not-print";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fake fetch answering from a queue of responses and recording each call. */
function fakeFetch(responses: readonly (() => Response | Promise<Response>)[]): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift();
    if (next === undefined) throw new Error("fake fetch: no response queued");
    return next();
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const labelled = (labels: readonly unknown[]) => json(200, { pagination: { page: 1, per_page: 1000, is_last_page: true }, data: labels });

const unavailableCode = (view: LabelsView): string | null => ("unavailable" in view ? view.unavailable.code : null);

test("without a key the answer is a stated NANSEN_KEY_MISSING, not an empty list", async () => {
  const view = await NANSEN_KEY_MISSING.labelsFor(ADDRESS);
  assert.equal(view.source, "nansen");
  assert.equal(unavailableCode(view), "NANSEN_KEY_MISSING");
  assert.equal("labels" in view, false);
});

test("the request is the documented one: POST, apikey header, address and chain in the body", async () => {
  const { fetch, calls } = fakeFetch([() => labelled([])]);
  const source = createNansenLabels({ apiKey: KEY, chain: "monad", fetch });

  const view = await source.labelsFor(ADDRESS.toUpperCase().replace("0X", "0x"));

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, NANSEN_LABELS_URL);
  assert.equal(call.init.method, "POST");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.apikey, KEY);
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    address: ADDRESS,
    chain: "monad",
    pagination: { page: 1, per_page: 1000 },
  });
  // Nansen answered and had nothing: an empty list is the answer here, with its provenance.
  assert.ok("labels" in view);
  if (!("labels" in view)) return;
  assert.deepEqual(view.labels, []);
  assert.equal(view.chain, "monad");
  assert.match(view.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(view.entity, undefined);
});

test("labels are narrowed to the documented shape and the entity is the label of kind entity", async () => {
  const { fetch } = fakeFetch([
    () =>
      labelled([
        { label: "Binance", category: "cefi", kind: ["entity", "name"], extra: "dropped" },
        { label: "Hot Wallet", category: "cefi", kind: ["entity-tag"] },
        { label: "Token Millionaire", category: "behavioral" },
        { label: "bare" },
      ]),
  ]);
  const source = createNansenLabels({ apiKey: KEY, chain: "all", fetch });

  const view = await source.labelsFor(ADDRESS);

  assert.ok("labels" in view);
  if (!("labels" in view)) return;
  assert.deepEqual(view.labels, [
    { label: "Binance", category: "cefi", kind: ["entity", "name"] },
    { label: "Hot Wallet", category: "cefi", kind: ["entity-tag"] },
    { label: "Token Millionaire", category: "behavioral" },
    { label: "bare" },
  ]);
  assert.equal(view.entity, "Binance");
});

test("each failure is named, and none of the messages carries the key", async () => {
  const cases: [() => Response | Promise<Response>, string][] = [
    [() => json(401, { error: "Unauthorized" }), "NANSEN_UNAUTHORISED"],
    [() => json(403, { error: "Forbidden" }), "NANSEN_UNAUTHORISED"],
    // A 403 is two facts under one status. A key Nansen accepts but has
    // nothing left to spend needs credits, not a new key, and the page says
    // which so a reader is not sent looking for the wrong thing.
    [
      () => json(403, { error: "Insufficient credits", code: "insufficient_credits" }),
      "NANSEN_NO_CREDITS",
    ],
    [() => json(429, { error: "Too Many Requests" }), "NANSEN_RATE_LIMITED"],
    [() => json(503, { error: "down" }), "NANSEN_UPSTREAM_ERROR"],
    [() => new Response("<html>", { status: 200 }), "NANSEN_MALFORMED_RESPONSE"],
    [() => json(200, { data: "not-an-array" }), "NANSEN_MALFORMED_RESPONSE"],
    [() => json(200, { data: [{ notLabel: 1 }] }), "NANSEN_MALFORMED_RESPONSE"],
    [() => Promise.reject(new Error(`ECONNRESET while sending ${KEY}`)), "NANSEN_FETCH_FAILED"],
  ];
  for (const [response, code] of cases) {
    const { fetch } = fakeFetch([response]);
    const source = createNansenLabels({ apiKey: KEY, chain: "all", fetch });
    const view = await source.labelsFor(ADDRESS);
    assert.equal(unavailableCode(view), code);
    assert.equal(JSON.stringify(view).includes(KEY), false, `${code} message must not carry the key`);
  }
});

test("a slow answer is a timeout, named as one", async () => {
  const { fetch } = fakeFetch([
    () =>
      new Promise<Response>((_resolve, reject) => {
        // Never resolves; the abort signal is what ends it.
        setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 50);
      }),
  ]);
  const source = createNansenLabels({ apiKey: KEY, chain: "all", fetch, timeoutMs: 10 });
  const view = await source.labelsFor(ADDRESS);
  assert.equal(unavailableCode(view), "NANSEN_TIMEOUT");
});

test("answers are cached for ten minutes and failures for thirty seconds", async () => {
  let clock = 1_000_000;
  const { fetch, calls } = fakeFetch([
    () => labelled([{ label: "Fund" }]),
    () => json(429, {}),
    () => labelled([{ label: "Fund" }]),
  ]);
  const source = createNansenLabels({ apiKey: KEY, chain: "all", fetch, now: () => clock });

  await source.labelsFor(ADDRESS);
  clock += 9 * 60 * 1000;
  await source.labelsFor(ADDRESS);
  assert.equal(calls.length, 1, "inside ten minutes the cached answer is served");

  clock += 2 * 60 * 1000;
  const limited = await source.labelsFor(ADDRESS);
  assert.equal(calls.length, 2, "after ten minutes it is fetched again");
  assert.equal(unavailableCode(limited), "NANSEN_RATE_LIMITED");

  clock += 20 * 1000;
  await source.labelsFor(ADDRESS);
  assert.equal(calls.length, 2, "a failure is not retried inside thirty seconds");

  clock += 11 * 1000;
  const recovered = await source.labelsFor(ADDRESS);
  assert.equal(calls.length, 3);
  assert.ok("labels" in recovered);
});

test("concurrent lookups of one address share a single request", async () => {
  const { fetch, calls } = fakeFetch([() => labelled([])]);
  const source = createNansenLabels({ apiKey: KEY, chain: "all", fetch });
  await Promise.all([source.labelsFor(ADDRESS), source.labelsFor(ADDRESS), source.labelsFor(ADDRESS)]);
  assert.equal(calls.length, 1);
});

test("the body parser and the entity picker stand on their own", () => {
  assert.equal(parseLabelsBody(null), null);
  assert.equal(parseLabelsBody({ data: [{ label: 3 }] }), null);
  assert.deepEqual(parseLabelsBody({ data: [] }), []);
  assert.equal(entityOf([{ label: "x", kind: ["name"] }]), undefined);
  assert.equal(entityOf([{ label: "x", kind: ["name"] }, { label: "Coinbase", kind: ["entity"] }]), "Coinbase");
});
