/**
 * The Nansen profile: bought once a week per Agent, whoever reads it, and never
 * for an address that is not one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NANSEN_CALL_CEILING,
  PROFILE_FAILURE_TTL_MS,
  PROFILE_TTL_MS,
  cleanLabel,
  createNansenProfiles,
  parseActivity,
  parseFunding,
  parseHoldings,
  type PaidFetch,
  type ProfileStore,
  type StoredProfile,
} from "../src/nansen-profile.js";

const AGENT = "0x3a3b6079e418c81a9de08414bb07ea817939e7ce";
const SERVICE = "0x49472ef9ed99f30d4ead45ac9e1c16c31f70783a";
const BRIDGE = "0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd";
const FUNDER = "0x456a79894e2b68e7986791c399f98a4ba5844a75";
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const START = Date.parse("2026-09-30T18:00:00Z");

/** Bodies in the shape Nansen answered with on Mainnet. */
const BODIES: Record<string, unknown> = {
  "current-balance": {
    pagination: { page: 1, per_page: 10, is_last_page: true },
    data: [
      { token_symbol: "MON", token_amount: 14.84, value_usd: 0.42 },
      { token_symbol: "USDC", token_amount: 1.25, value_usd: 1.25 },
      { token_symbol: "ODD", token_amount: 3, value_usd: null },
    ],
  },
  "related-wallets": {
    pagination: { page: 1, per_page: 10, is_last_page: true },
    data: [{ address: FUNDER, address_label: "[0x456a79]", relation: "First Funder", transaction_hash: "0x83c7", block_timestamp: "2026-09-29T14:49:43Z" }],
  },
  transactions: {
    pagination: { page: 1, per_page: 100, is_last_page: true },
    data: [
      {
        volume_usd: 0.2,
        block_timestamp: "2026-09-30T17:19:26",
        tokens_sent: [{ from_address: AGENT, to_address: SERVICE, from_address_label: "[0x3a3b60]", to_address_label: "[0x49472e]" }],
        tokens_received: [],
      },
      {
        volume_usd: 0.11,
        block_timestamp: "2026-09-30T17:19:19",
        tokens_sent: [],
        tokens_received: [{ from_address: BRIDGE, to_address: AGENT, from_address_label: "​​🤖 USDT Bridge [0x233c53]", to_address_label: "[0x3a3b60]" }],
      },
      {
        volume_usd: 0.01,
        block_timestamp: "2026-09-29T12:00:00",
        tokens_sent: [{ from_address: AGENT, to_address: SERVICE, to_address_label: "[0x49472e]" }],
        tokens_received: [],
      },
    ],
  },
};

interface Harness {
  readonly store: ProfileStore & { rows: Map<string, { fetchedAt: Date; profile: StoredProfile }>; payments: { endpoint: string; amount: bigint }[]; agents: Set<string> };
  readonly calls: string[];
  readonly clock: { now: number };
  paidFetch: PaidFetch;
}

function harness(options: { readonly fail?: (endpoint: string) => boolean; readonly status?: number } = {}): Harness {
  const rows = new Map<string, { fetchedAt: Date; profile: StoredProfile }>();
  const payments: { endpoint: string; amount: bigint }[] = [];
  const paidAt: { at: number; amount: bigint }[] = [];
  const clock = { now: START };
  const calls: string[] = [];
  const store = {
    rows,
    payments,
    agents: new Set([AGENT]),
    async read(address: string) {
      return rows.get(address) ?? null;
    },
    async write(address: string, fetchedAt: Date, profile: StoredProfile) {
      rows.set(address, { fetchedAt, profile: JSON.parse(JSON.stringify(profile)) as StoredProfile });
    },
    async recordPayment(payment: { endpoint: string; amount: bigint }) {
      payments.push({ endpoint: payment.endpoint, amount: payment.amount });
      paidAt.push({ at: clock.now, amount: payment.amount });
    },
    async spentSince(since: Date) {
      return paidAt.filter((entry) => entry.at >= since.getTime()).reduce((sum, entry) => sum + entry.amount, 0n);
    },
    async isAgent(address: string) {
      return store.agents.has(address);
    },
  };
  const paidFetch: PaidFetch = async (url) => {
    const endpoint = url.slice(url.lastIndexOf("/") + 1);
    calls.push(endpoint);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (options.fail?.(endpoint) === true) return { ok: false, error: { category: "UPSTREAM", code: "X402_REFUSED", message: "offer refused", retryable: false } };
    return { ok: true, value: { status: options.status ?? 200, body: BODIES[endpoint], payment: { amount: 10_000n, asset: USDC, txHash: `0x${endpoint.length.toString(16).padStart(64, "0")}` } } };
  };
  return { store, calls, clock, paidFetch };
}

const build = (h: Harness, extra: { chainId?: number; dailyBudget?: bigint; paid?: boolean; slept?: number[] } = {}) =>
  createNansenProfiles({
    chainId: extra.chainId ?? 143,
    store: h.store,
    paidFetch: extra.paid === false ? null : h.paidFetch,
    ...(extra.dailyBudget === undefined ? {} : { dailyBudget: extra.dailyBudget }),
    now: () => h.clock.now,
    warn: () => {},
    sleep: async (ms) => {
      extra.slept?.push(ms);
    },
  });

test("the first read buys three calls and stores the answer; every read that week is served from it", async () => {
  const h = harness();
  const source = build(h);
  const first = await source.profileFor(AGENT.toUpperCase().replace("0X", "0x"));
  assert.ok(!("unavailable" in first));
  if ("unavailable" in first) return;
  assert.deepEqual(h.calls.sort(), ["current-balance", "related-wallets", "transactions"]);
  assert.equal(first.paid.totalBaseUnits, "30000");
  assert.equal(first.paid.payments.length, 3);
  assert.equal(first.fetchedAt, "2026-09-30T18:00:00.000Z");
  assert.equal(first.refreshesAt, "2026-10-07T18:00:00.000Z");
  assert.equal(first.stale, false);

  h.clock.now += PROFILE_TTL_MS - 1;
  for (let view = 0; view < 25; view += 1) {
    const again = await source.profileFor(AGENT);
    assert.ok(!("unavailable" in again) && again.fetchedAt === first.fetchedAt, "the stored answer, to every reader");
  }
  assert.equal(h.calls.length, 3, "nothing more was paid in the week");
  assert.equal(h.store.payments.length, 3);

  h.clock.now += 1;
  const next = await source.profileFor(AGENT);
  assert.ok(!("unavailable" in next));
  assert.equal(h.calls.length, 6, "the week is up, so the next read buys once more");
});

test("concurrent first reads of one Agent share one purchase", async () => {
  const h = harness();
  const source = build(h);
  const views = await Promise.all(Array.from({ length: 10 }, () => source.profileFor(AGENT)));
  assert.equal(h.calls.length, 3);
  assert.ok(views.every((view) => !("unavailable" in view)));
});

test("an address that is not an Agent here is refused and nothing is paid", async () => {
  const h = harness();
  const view = await build(h).profileFor("0x00000000000000000000000000000000000000aa");
  assert.ok("unavailable" in view);
  if (!("unavailable" in view)) return;
  assert.equal(view.unavailable.code, "NANSEN_NOT_AN_AGENT");
  assert.equal(h.calls.length, 0);
});

test("the day's budget stops a purchase, and a stored row is served stale instead", async () => {
  const h = harness();
  const source = build(h, { dailyBudget: NANSEN_CALL_CEILING * 3n });
  assert.ok(!("unavailable" in (await source.profileFor(AGENT))));
  h.store.agents.add(SERVICE);
  const refused = await source.profileFor(SERVICE);
  assert.ok("unavailable" in refused && refused.unavailable.code === "NANSEN_BUDGET_SPENT");
  assert.equal(h.calls.length, 3);

  // A week on, the Agent's row is due, and a budget of nothing refuses the refresh.
  const later = harness();
  later.store.rows.set(AGENT, h.store.rows.get(AGENT)!);
  later.clock.now = START + PROFILE_TTL_MS + 1;
  const stale = await build(later, { dailyBudget: 0n }).profileFor(AGENT);
  assert.ok(!("unavailable" in stale) && stale.stale, "the old answer, marked stale, rather than nothing");
  assert.equal(later.calls.length, 0);
});

test("a registry on Testnet serves a stated refusal and reads nothing", async () => {
  const h = harness();
  const view = await build(h, { chainId: 10143 }).profileFor(AGENT);
  assert.ok("unavailable" in view && view.unavailable.code === "NANSEN_MAINNET_ONLY");
  assert.equal(h.calls.length, 0);
});

test("without a payer, a stored profile is still served and a new one is a stated refusal", async () => {
  const h = harness();
  await build(h).profileFor(AGENT);
  const unpaid = build(h, { paid: false });
  assert.ok(!("unavailable" in (await unpaid.profileFor(AGENT))));
  h.store.agents.add(SERVICE);
  const none = await unpaid.profileFor(SERVICE);
  assert.ok("unavailable" in none && none.unavailable.code === "NANSEN_PAYER_MISSING");
});

test("a lookup that fails everywhere is not retried for ten minutes", async () => {
  const h = harness({ fail: () => true });
  const source = build(h);
  const view = await source.profileFor(AGENT);
  assert.ok("unavailable" in view && view.unavailable.code === "NANSEN_PAYMENT_FAILED");
  assert.equal(h.calls.length, 3);
  h.clock.now += PROFILE_FAILURE_TTL_MS - 1;
  await source.profileFor(AGENT);
  assert.equal(h.calls.length, 3, "remembered, not paid again");
  h.clock.now += 1;
  await source.profileFor(AGENT);
  assert.equal(h.calls.length, 6);
});

test("a paid call Nansen answered with an error is recorded as spent and stored as an unavailable section", async () => {
  const h = harness({ status: 500 });
  const view = await build(h).profileFor(AGENT);
  assert.ok("unavailable" in view && view.unavailable.code === "NANSEN_UPSTREAM_ERROR");
  assert.equal(h.store.payments.length, 3, "the budget counts what was paid, whatever came back");
  assert.equal(h.store.rows.size, 0, "nothing usable, so nothing stored");

  const partial = harness({ fail: (endpoint) => endpoint === "related-wallets" });
  const served = await build(partial).profileFor(AGENT);
  assert.ok(!("unavailable" in served));
  if ("unavailable" in served) return;
  assert.ok("unavailable" in served.funding, "the one section that failed says so");
  assert.ok(!("unavailable" in served.holdings));
  assert.equal(served.paid.totalBaseUnits, "20000");
});

test("Nansen's placeholder names are not names, and padding is dropped", () => {
  assert.equal(cleanLabel("[0x49472e]"), null);
  assert.equal(cleanLabel("​​🤖 USDT Bridge [0x233c53]"), "🤖 USDT Bridge [0x233c53]");
  assert.equal(cleanLabel(""), null);
  assert.equal(cleanLabel(7), null);
});

test("the sections are read from Nansen's own shapes", () => {
  const holdings = parseHoldings(BODIES["current-balance"]);
  assert.equal(holdings?.tokens[0]?.symbol, "USDC", "largest value first");
  assert.equal(holdings?.totalUsd, 1.67, "unpriced tokens are listed and not valued");
  assert.equal(holdings?.tokens.length, 3);

  const funding = parseFunding(BODIES["related-wallets"]);
  assert.deepEqual(funding?.wallets, [{ address: FUNDER, label: null, relation: "First Funder", txHash: "0x83c7", at: "2026-09-29T14:49:43Z" }]);

  const activity = parseActivity(BODIES.transactions, AGENT);
  assert.equal(activity?.transactions, 3);
  assert.equal(activity?.more, false);
  assert.equal(activity?.lastAt, "2026-09-30T17:19:26");
  assert.ok(Math.abs((activity?.volumeUsd ?? 0) - 0.32) < 1e-9);
  assert.deepEqual(activity?.counterparties, [
    { address: SERVICE, label: null, transactions: 2 },
    { address: BRIDGE, label: "🤖 USDT Bridge [0x233c53]", transactions: 1 },
  ]);

  assert.equal(parseHoldings({ nope: true }), null, "a body without data is not an empty answer");
});

test("a 429 is asked again after a pause, and paid for once", async () => {
  const h = harness();
  let refusals = 1;
  const inner = h.paidFetch;
  h.paidFetch = async (url, body) => {
    if (url.endsWith("/transactions") && refusals > 0) {
      refusals -= 1;
      h.calls.push("transactions (429)");
      return { ok: true, value: { status: 429, body: { error: "rate limited" } } };
    }
    return inner(url, body);
  };
  const slept: number[] = [];
  const view = await build(h, { slept }).profileFor(AGENT);
  assert.ok(!("unavailable" in view));
  if ("unavailable" in view) return;
  assert.ok(!("unavailable" in view.activity), "the retry filled the section");
  assert.deepEqual(h.calls, ["current-balance", "related-wallets", "transactions (429)", "transactions"], "one call at a time");
  assert.deepEqual(slept, [1_500]);
  assert.equal(view.paid.totalBaseUnits, "30000", "the refused call cost nothing");
});

test("a section that failed is bought again on its own, ten minutes later, and merged into the week", async () => {
  let failing = true;
  const h = harness({ fail: (endpoint) => failing && endpoint === "transactions" });
  const source = build(h);
  const first = await source.profileFor(AGENT);
  assert.ok(!("unavailable" in first) && "unavailable" in first.activity);
  assert.equal(h.calls.length, 3);

  failing = false;
  h.clock.now += PROFILE_FAILURE_TTL_MS - 1;
  await source.profileFor(AGENT);
  assert.equal(h.calls.length, 3, "not asked again straight away");

  h.clock.now += 1;
  const filled = await source.profileFor(AGENT);
  assert.deepEqual(h.calls.slice(3), ["transactions"], "only the missing section is bought");
  assert.ok(!("unavailable" in filled));
  if ("unavailable" in filled || "unavailable" in first) return;
  assert.ok(!("unavailable" in filled.activity));
  assert.equal(filled.fetchedAt, first.fetchedAt, "the week still runs from the first purchase");
  assert.equal(filled.paid.totalBaseUnits, "30000");
  assert.deepEqual(filled.paid.payments.map((payment) => payment.endpoint), ["current-balance", "related-wallets", "transactions"]);

  h.clock.now += PROFILE_FAILURE_TTL_MS * 3;
  await source.profileFor(AGENT);
  assert.equal(h.calls.length, 4, "complete, so nothing more until the week is up");
});
