/**
 * Tests for the Dashboard: the framework-free core, and that the views render.
 *
 * Two kinds of assertion again, matching the shape the composites' own tests
 * take.
 *
 * **Behaviour.** The chain toggle, the registry reader, the view models and the
 * `/api/settlements` handler are pure or injectable, so each is exercised
 * directly with no server and no network.
 *
 * **Renders without a wallet.** R24.9 is the one architectural claim the
 * Dashboard makes, and it is asserted rather than described: every view is
 * rendered to static markup in a plain Node process, where there is no injected
 * provider, no `window.ethereum`, and no account of any kind. A component that
 * reached for one could not produce markup here.
 *
 * Requirements: 24.1, 24.4, 24.6, 24.9
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CHAIN_OPTIONS,
  DEFAULT_CHAIN_KEY,
  chainOptionFor,
  parseChainKeyParam,
  readStoredChainKey,
  withChainParam,
  writeStoredChainKey,
  type ChainStorage,
} from "../src/dashboard/chains";
import { createRegistryClient, type RegistryResponse } from "../src/dashboard/client";
import {
  assetUnitFor,
  clearingStateOf,
  serviceNameOf,
  toBigInt,
  toSettlementView,
  toSettlementViews,
  type SettlementView,
} from "../src/dashboard/views";
import { parseLimit, serveSettlements } from "../src/dashboard/api-settlements";
import { ChainToggle } from "../components/views/chain-toggle";
import { EmptyChain } from "../components/views/empty-chain";
import { SettlementTable } from "../components/views/settlement-table";

/* ------------------------------------------------------------- chain toggle */

test("the toggle offers both Source Chains and names the network of each", () => {
  assert.equal(CHAIN_OPTIONS.length, 2);
  const [first, second] = CHAIN_OPTIONS;
  assert.equal(first?.chainKey, 1);
  assert.equal(first?.network, "testnet");
  assert.equal(second?.chainKey, 3);
  assert.equal(second?.network, "mainnet");
});

test("a first-time reader is shown the chain where the value is not real", () => {
  assert.equal(DEFAULT_CHAIN_KEY, 1);
  assert.equal(chainOptionFor(DEFAULT_CHAIN_KEY).network, "testnet");
});

test("an unreadable chain parameter falls back rather than erroring", () => {
  assert.equal(parseChainKeyParam("3"), 3);
  assert.equal(parseChainKeyParam("1"), 1);
  for (const bad of [null, undefined, "", "  ", "2", "0", "-1", "abc", "1.5", "99"]) {
    assert.equal(parseChainKeyParam(bad), DEFAULT_CHAIN_KEY, `for ${String(bad)}`);
  }
});

test("an empty Mainnet is described as a fact about the chain, never as an error", () => {
  const mainnet = chainOptionFor(3);
  assert.match(mainnet.emptyMeans, /Nothing has settled/);
  assert.match(mainnet.emptyMeans, /by design/);
  assert.equal(mainnet.tabDeploysContract, false);
  // Sepolia is where Tab does deploy, and its sentence must not claim otherwise.
  assert.equal(chainOptionFor(1).tabDeploysContract, true);
});

test("storage that throws costs a preference and never a page", () => {
  const hostile: ChainStorage = {
    getItem() {
      throw new Error("site data is blocked");
    },
    setItem() {
      throw new Error("site data is blocked");
    },
  };
  assert.equal(readStoredChainKey(hostile), DEFAULT_CHAIN_KEY);
  assert.doesNotThrow(() => {
    writeStoredChainKey(hostile, 3);
  });
  assert.equal(readStoredChainKey(undefined), DEFAULT_CHAIN_KEY);

  const store = new Map<string, string>();
  const working: ChainStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
  writeStoredChainKey(working, 3);
  assert.equal(readStoredChainKey(working), 3);
});

test("the chain travels in the URL, so a view of one chain is shareable", () => {
  assert.equal(withChainParam("/explorer", 3), "/explorer?chainKey=3");
  assert.equal(withChainParam("/explorer?cursor=abc", 1), "/explorer?cursor=abc&chainKey=1");
});

/* -------------------------------------------------------------- view models */

test("an amount is never parsed into a number", () => {
  assert.equal(toBigInt("101000"), 101_000n);
  assert.equal(toBigInt("0"), 0n);
  assert.equal(toBigInt("999999999999999999999999"), 999_999_999_999_999_999_999_999n);
  for (const bad of ["", " ", "1.5", "0x10", "abc", null, undefined]) {
    assert.equal(toBigInt(bad), undefined, `for ${String(bad)}`);
  }
});

test("an unknown Asset is shown by its address rather than assumed to be USDC", () => {
  assert.deepEqual(assetUnitFor("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"), {
    symbol: "USDC",
    decimals: 6,
  });
  const unknown = assetUnitFor("0x1111111111111111111111111111111111111111");
  assert.notEqual(unknown.symbol, "USDC");
  // Zero decimals, so the figure shown is the exact base-unit integer and is not
  // scaled by a guess.
  assert.equal(unknown.decimals, 0);
});

test("a bytes32 serviceId decodes to its name, and refuses when it is not one", () => {
  assert.equal(
    serviceNameOf("0x7461622e70726f6f662d73657276696365000000000000000000000000000000"),
    "tab.proof-service",
  );
  assert.equal(serviceNameOf("0x" + "ff".repeat(32)), undefined);
  assert.equal(serviceNameOf("0x00"), undefined);
});

test("a settlement with no provisional stage is confirmed, which is the state machine", () => {
  // design section 6.1 draws `None -> Confirmed` on applyVerifiedSettlement with
  // no active clearing, so null is confirmed rather than unknown.
  assert.equal(clearingStateOf(null), "confirmed");
  assert.equal(clearingStateOf(undefined), "confirmed");
  assert.equal(clearingStateOf("Applied"), "provisional");
  assert.equal(clearingStateOf("REVERSED"), "reversed");
  assert.equal(clearingStateOf("declined"), "declined");
  assert.equal(clearingStateOf("Superseded"), "superseded");
});

/** The real row this Dashboard was built against, from the live read API. */
const LIVE_ROW = {
  replayKey: "0x00000000000000010000000000b1b398000000000000004b0000000000000000",
  chainKey: "1",
  sourceBlockHeight: "11645848",
  sourceTxIndex: "75",
  sourceLogIndex: "0",
  agent: "0x1f6f797edc2eecb02bd54009b805fb2e99f80542",
  serviceId: "0x7461622e70726f6f662d73657276696365000000000000000000000000000000",
  asset: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  amount: "101000",
  payerAddress: "0xa302940db97345c5adaf8da23ff46ae63613d728",
  sourceTabId: `0x${"00".repeat(32)}`,
  creditcoin: {
    blockNumber: 5_439_386,
    blockHash: "0x0593fd509c314356066491ddd01a84ce5b4dd5309fd67895a8d62a99da7fd9da",
    logIndex: 7,
    txHash: "0x81aad88d0fef865b7b52efa3d01abccaf16acb4027e0c656330f2a4caa15de32",
    txIndex: 2,
    blockTime: "2026-09-06T07:44:45.000Z",
  },
  application: { applied: "0", toPrepaid: "101000", openAfter: "0" },
} as const;

test("the real Settlement decodes with every coordinate intact", () => {
  const view = toSettlementView(LIVE_ROW);
  assert.notEqual(view, undefined);
  if (view === undefined) return;
  assert.equal(view.chainKey, 1);
  assert.equal(view.blockHeight, 11_645_848n);
  assert.equal(view.txIndex, 75n);
  // The receipt ordinal, not the block-wide log index. Those differ and name
  // different logs.
  assert.equal(view.logIndex, 0n);
  assert.equal(view.amountBaseUnits, 101_000n);
  assert.equal(view.serviceName, "tab.proof-service");
  assert.equal(view.asset.symbol, "USDC");
  assert.equal(view.prepaidBaseUnits, 101_000n);
});

test("a row whose coordinates will not decode is dropped, not shown with zeroes", () => {
  assert.equal(toSettlementView({ ...LIVE_ROW, sourceBlockHeight: "not a number" }), undefined);
  assert.equal(toSettlementView({ ...LIVE_ROW, chainKey: "2" }), undefined);
  assert.equal(toSettlementViews([LIVE_ROW, { ...LIVE_ROW, amount: "" }]).length, 1);
});

/* ----------------------------------------------------------------- the read */

function respondWith(status: number, body: unknown): RegistryResponse {
  return {
    status,
    json: async () => {
      if (body === undefined) throw new Error("not JSON");
      return body;
    },
  };
}

test("a registry that is down, a 404, and a bad body are three different answers", async () => {
  const down = createRegistryClient({
    baseUrl: "http://registry.invalid",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const unreachable = await down.settlements();
  assert.equal(unreachable.ok, false);
  if (!unreachable.ok) assert.equal(unreachable.error.code, "REGISTRY_UNREACHABLE");

  const missing = createRegistryClient({
    baseUrl: "http://registry.test",
    fetchImpl: async () => respondWith(404, { error: {} }),
  });
  const absent = await missing.settlement("0x00");
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.equal(absent.error.category, "NOT_FOUND");

  const garbled = createRegistryClient({
    baseUrl: "http://registry.test",
    fetchImpl: async () => respondWith(200, undefined),
  });
  const unparseable = await garbled.settlements();
  assert.equal(unparseable.ok, false);
  if (!unparseable.ok) assert.equal(unparseable.error.code, "REGISTRY_UNPARSEABLE");
});

test("the reader never throws, whatever the registry does", async () => {
  const client = createRegistryClient({
    baseUrl: "http://registry.test",
    fetchImpl: async () => respondWith(500, {}),
  });
  await assert.doesNotReject(() => client.agents());
});

/* -------------------------------------------------------- the feed handler */

test("limit is refused outside its bound rather than silently shortened", () => {
  assert.deepEqual(parseLimit(null), { ok: true, value: 25 });
  assert.deepEqual(parseLimit("10"), { ok: true, value: 10 });
  for (const bad of ["0", "101", "-1", "abc", "1.5"]) {
    const result = parseLimit(bad);
    assert.equal(result.ok, false, `for ${bad}`);
  }
});

test("the feed always resolves a chain, so two chains can never be mixed", async () => {
  const seen: string[] = [];
  const registry = createRegistryClient({
    baseUrl: "http://registry.test",
    fetchImpl: async (url) => {
      seen.push(url);
      return respondWith(200, { index: { lastBlock: 5 }, settlements: [], nextCursor: null });
    },
  });

  const noChain = await serveSettlements({ registry }, new URLSearchParams(""));
  assert.equal(noChain.status, 200);
  assert.equal((noChain.body as { chainKey: number }).chainKey, DEFAULT_CHAIN_KEY);
  assert.match(seen[0] ?? "", /chainKey=1/);

  const mainnet = await serveSettlements({ registry }, new URLSearchParams("chainKey=3"));
  assert.equal((mainnet.body as { chainKey: number }).chainKey, 3);
  assert.match(seen[1] ?? "", /chainKey=3/);

  // An unreadable chain resolves to the default rather than to an unfiltered feed.
  await serveSettlements({ registry }, new URLSearchParams("chainKey=banana"));
  assert.match(seen[2] ?? "", /chainKey=1/);
});

test("an empty Mainnet page is a 200 carrying an empty list, not an error", async () => {
  const registry = createRegistryClient({
    baseUrl: "http://registry.test",
    fetchImpl: async () =>
      respondWith(200, { index: { lastBlock: 5_439_633 }, settlements: [], nextCursor: null }),
  });
  const result = await serveSettlements({ registry }, new URLSearchParams("chainKey=3"));
  assert.equal(result.status, 200);
  const body = result.body as { settlements: unknown[]; index: { lastBlock: number } };
  assert.deepEqual(body.settlements, []);
  // The horizon proves the index looked, which is what separates "nothing has
  // settled" from "we could not read".
  assert.equal(body.index.lastBlock, 5_439_633);
});

test("the feed is never cached, because a stale ticker is a wrong ticker", async () => {
  const registry = createRegistryClient({
    baseUrl: "http://registry.test",
    fetchImpl: async () => respondWith(200, { index: {}, settlements: [], nextCursor: null }),
  });
  const result = await serveSettlements({ registry }, new URLSearchParams(""));
  assert.equal(result.headers["cache-control"], "no-store");
});

/* ------------------------------------------------- renders with no wallet */

const VIEW_ROW: SettlementView = (() => {
  const view = toSettlementView(LIVE_ROW);
  if (view === undefined) throw new Error("the live fixture must decode");
  return view;
})();

test("every view renders in a process with no provider and no account", () => {
  // Node has no `window`, no injected provider and no wallet. Anything requiring
  // one could not produce markup here, which is R24.9 asserted rather than said.
  assert.equal((globalThis as { window?: unknown }).window, undefined);

  const toggle = renderToStaticMarkup(
    createElement(ChainToggle, {
      options: CHAIN_OPTIONS,
      selected: 1,
      hrefFor: (chainKey) => `?chainKey=${chainKey}`,
    }),
  );
  assert.match(toggle, /Sepolia/);
  assert.match(toggle, /Mainnet/);
  // The network kind is stated in words rather than carried by colour, so Sepolia
  // reads "SEPOLIA testnet". Ethereum Mainnet's short name already is the network
  // kind, and appending it rendered "MAINNET MAINNET" on the live page, so the
  // duplicate is dropped and the word appears exactly once per option.
  assert.match(toggle, /testnet/);
  // Exactly one option carries the network suffix. Sepolia's short name does not say
  // which network it is, so it earns the word; Ethereum Mainnet's already does, and
  // rendering it anyway produced "MAINNET MAINNET" on the live page.
  assert.equal(
    (toggle.match(/opacity-70/g) ?? []).length,
    1,
    "the network suffix is dropped where the short name already is the network word",
  );
  assert.equal(
    toggle.includes(">mainnet<"),
    false,
    "the Mainnet option does not repeat its own name as a suffix",
  );
  assert.match(toggle, /aria-current="page"/);

  const empty = renderToStaticMarkup(
    createElement(EmptyChain, {
      message: chainOptionFor(3).emptyMeans,
      indexedBlock: 5_439_633,
    }),
  );
  assert.match(empty, /Nothing has settled on Ethereum Mainnet yet/);
  assert.match(empty, /5,439,633/);

  const table = renderToStaticMarkup(
    createElement(SettlementTable, {
      rows: [VIEW_ROW],
      caption: "Verified Settlements",
      hrefFor: (replayKey) => `/explorer/${replayKey}`,
      explorerHrefFor: (txHash) => `https://creditcoin-testnet.blockscout.com/tx/${txHash}`,
    }),
  );
  // Every identifying coordinate is on the page, so a reader can check it.
  assert.match(table, /chainKey<\/span> 1/);
  assert.match(table, /11645848/);
  assert.match(table, /tx<\/span> 75/);
  assert.match(table, /log<\/span> 0/);
  // The amount renders as decimal units with the symbol in its own element, and
  // carries the exact base-unit integer in `title`. Asserting the title is the
  // stronger claim: it is the figure that must not have been scaled by a guess.
  assert.match(table, /0\.101 /);
  assert.match(table, /title="101000 base units \(USDC, 6 decimals\)"/);
  assert.match(table, /blockscout\.com\/tx\/0x81aad88d/);
  // The clearing state is named in text, not conveyed by colour alone.
  assert.match(table, /Confirmed/);

  // The coordinates are the link, and the replay key is not printed truncated
  // anywhere. It packs (chainKey, blockHeight, txIndex, logIndex) into four 8-byte
  // fields, so a chainKey of 1 and a logIndex of 0 leave the first and last sixteen
  // hex characters zero: a middle truncation showed `0x000000…000000` on every row
  // and made twelve settlements look like one settlement twelve times.
  assert.equal(
    table.includes("0x000000…"),
    false,
    "no row prints a truncated replay key, because both of its ends are zeros",
  );
  assert.match(
    table,
    /<a[^>]*href="\/explorer\/0x[0-9a-f]+"[^>]*>(?:(?!<\/a>)[\s\S])*chainKey/,
    "the coordinates are what links to the settlement",
  );
  assert.match(table, /title="0x[0-9a-f]{64}"/, "the full replay key stays available in title");
  assert.equal(
    (table.match(/chainKey<\/span>/g) ?? []).length,
    1,
    "the identifier and the coordinates are one column, not two saying the same thing",
  );
});

test("an empty feed renders as a sentence rather than as nothing at all", () => {
  const markup = renderToStaticMarkup(
    createElement(SettlementTable, {
      rows: [],
      caption: "Verified Settlements",
      hrefFor: () => "#",
      explorerHrefFor: () => "#",
    }),
  );
  // The table still renders its caption for assistive technology even with no
  // rows, so the region is named rather than silently absent.
  assert.match(markup, /Verified Settlements/);
});
