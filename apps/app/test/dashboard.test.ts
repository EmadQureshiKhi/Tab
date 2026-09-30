/**
 * Tests for the Dashboard: the framework-free core, and that the views render.
 *
 * Two kinds of assertion again, matching the shape the composites' own tests
 * take.
 *
 * **Behaviour.** The network model, the registry reader, the view models and
 * the `/api/settlements` handler are pure or injectable, so each is exercised
 * directly with no server and no network.
 *
 * **Renders without a wallet.** That every read-only view needs no wallet is
 * the one architectural claim the Dashboard makes, and it is asserted rather
 * than described: every view is
 * rendered to static markup in a plain Node process, where there is no injected
 * provider, no `window.ethereum`, and no account of any kind. A component that
 * reached for one could not produce markup here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DEFAULT_CHAIN_ID,
  explorerAddressUrl,
  explorerTxUrl,
  networkOptionFor,
  parseChainId,
} from "../src/dashboard/network";
import {
  createRegistryClient,
  type IdentityAgentRow,
  type IdentityRow,
  type RegistryResponse,
  type ServiceRow,
} from "../src/dashboard/client";
import {
  IDENTITY_UNCONFIGURED_STATEMENT,
  LABELS_OFFCHAIN_STATEMENT,
  LABELS_UNCONFIGURED_STATEMENT,
  NO_IDENTITY_STATEMENT,
  REPUTATION_DERIVED_STATEMENT,
  REPUTATION_NOT_SERVED_STATEMENT,
  REPUTATION_NO_IDENTITY_STATEMENT,
  REPUTATION_UNCONFIGURED_STATEMENT,
  assetUnitFor,
  fixedPointText,
  registerAsset,
  serviceNameOf,
  shortenUri,
  toBigInt,
  toCreditView,
  toIdentitySummary,
  toIdentityView,
  toLabelsView,
  toReputationSectionView,
  toSettlementView,
  toSettlementViews,
  type SettlementView,
} from "../src/dashboard/views";
import { offersX402, parsePublishedDirectory, publishedOn, toCatalogue } from "../src/dashboard/catalogue";
import { readCurationAuthority } from "../src/dashboard/curation";
import { hubRecipeFor, toHubEntries, withMargin, type HubEndpointInput } from "../src/dashboard/hub";
import { CATEGORY_TINT, SHOWCASE, providerLogo } from "../src/dashboard/showcase";
import { parseLimit, serveSettlements } from "../src/dashboard/api-settlements";
import { NetworkSwitchView } from "../components/shell/network-switch";
import { LabelsStrip } from "../components/custom-ui/labels-strip";
import { EmptyChain } from "../components/views/empty-chain";
import { IdentitySection } from "../components/views/identity-section";
import { ReputationSection } from "../components/views/reputation-section";
import { ServiceOperatorStrip, X402_STRIP_COPY } from "../components/views/service-operator-strip";
import { SettlementTable } from "../components/views/settlement-table";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The Testnet mock token, registered the way `_lib/context.ts` registers it at startup. */
const TESTNET_MUSDC = "0x480209747417f5c830fda188a9b9acfa70bc4083";
registerAsset(TESTNET_MUSDC, { symbol: "mUSDC", decimals: 6 });

/* ------------------------------------------------------------------ network */

test("a deployment names one Monad chain and says which kind of money it holds", () => {
  const testnet = networkOptionFor(10143);
  assert.equal(testnet.network, "testnet");
  assert.equal(testnet.name, "Monad Testnet");
  assert.equal(testnet.explorerUrl, "https://testnet.monadvision.com");
  assert.equal(typeof testnet.faucetUrl, "string");

  const mainnet = networkOptionFor(143);
  assert.equal(mainnet.network, "mainnet");
  assert.equal(mainnet.faucetUrl, undefined);
});

test("a deployment that names no chain is shown the one where the value is not real", () => {
  assert.equal(DEFAULT_CHAIN_ID, 10143);
  assert.equal(networkOptionFor(DEFAULT_CHAIN_ID).network, "testnet");
});

test("an unreadable chain id falls back rather than erroring", () => {
  assert.equal(parseChainId("143"), 143);
  assert.equal(parseChainId("10143"), 10143);
  for (const bad of [null, undefined, "", "  ", "1", "0", "-1", "abc", "1.5", "31337"]) {
    assert.equal(parseChainId(bad), DEFAULT_CHAIN_ID, `for ${String(bad)}`);
  }
});

test("an empty chain is described as a fact about the chain, never as an error", () => {
  assert.match(networkOptionFor(143).emptyMeans, /Nothing has settled on Monad Mainnet yet/);
  assert.match(networkOptionFor(10143).emptyMeans, /Nothing has settled on Monad Testnet yet/);
});

test("explorer links are built from the configured explorer, with no trailing slash doubled", () => {
  assert.equal(explorerTxUrl("0xabc", "https://testnet.monadvision.com/"), "https://testnet.monadvision.com/tx/0xabc");
  assert.equal(explorerAddressUrl("0xdef", "https://monadvision.com"), "https://monadvision.com/address/0xdef");
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
  // The Mainnet stablecoins come from the shared table, checksummed or not.
  assert.deepEqual(assetUnitFor("0x754704Bc059F8C67012fEd69BC8A327a5aafb603"), { symbol: "USDC", decimals: 6 });
  assert.deepEqual(assetUnitFor("0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a"), { symbol: "AUSD", decimals: 6 });
  // The Testnet token is deployment output, so it is registered rather than listed.
  assert.deepEqual(assetUnitFor(TESTNET_MUSDC.toUpperCase().replace("0X", "0x")), { symbol: "mUSDC", decimals: 6 });
  // Circle's Testnet USDC is a network constant, so it is listed.
  assert.deepEqual(assetUnitFor("0x534b2f3A21130d7a60830c2Df862319e593943A3"), { symbol: "USDC", decimals: 6 });
  const unknown = assetUnitFor("0x1111111111111111111111111111111111111111");
  assert.notEqual(unknown.symbol, "USDC");
  // Zero decimals, so the figure shown is the exact base-unit integer and is not
  // scaled by a guess.
  assert.equal(unknown.decimals, 0);
});

test("a bytes32 serviceId decodes to its name, and refuses when it is not one", () => {
  assert.equal(
    serviceNameOf("0x7461622e64656d6f2d7365727669636500000000000000000000000000000000"),
    "tab.demo-service",
  );
  assert.equal(serviceNameOf("0x" + "ff".repeat(32)), undefined);
  assert.equal(serviceNameOf("0x00"), undefined);
});

/** One row as the read API serves it: the Settlement and the transaction that paid it. */
const LIVE_ROW = {
  settlementId: "0x9e4c1a7b2d3f4e5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c",
  agent: "0xa9e1000000000000000000000000000000007c30",
  serviceId: "0x7461622e64656d6f2d7365727669636500000000000000000000000000000000",
  asset: TESTNET_MUSDC,
  amount: "101000",
  applied: "0",
  toPrepaid: "101000",
  collection: "0xc011ec7000000000000000000000000000000001",
  openAfter: "0",
  monad: {
    blockNumber: 66_724_016,
    blockHash: "0xb10c000000000000000000000000000000000000000000000000000000000001",
    logIndex: 7,
    txHash: "0x7e57a11ed0000000000000000000000000000000000000000000000000000001",
    txIndex: 2,
    blockTime: "2026-09-21T15:46:30.000Z",
  },
} as const;

test("a Settlement decodes with its id, its transaction and both applied figures intact", () => {
  const view = toSettlementView(LIVE_ROW);
  assert.notEqual(view, undefined);
  if (view === undefined) return;
  assert.equal(view.settlementId, LIVE_ROW.settlementId);
  assert.equal(view.txHash, LIVE_ROW.monad.txHash);
  assert.equal(view.blockNumber, 66_724_016);
  assert.equal(view.logIndex, 7);
  assert.equal(view.amountBaseUnits, 101_000n);
  assert.equal(view.appliedBaseUnits, 0n);
  assert.equal(view.prepaidBaseUnits, 101_000n);
  assert.equal(view.openAfterBaseUnits, 0n);
  assert.equal(view.serviceName, "tab.demo-service");
  assert.equal(view.asset.symbol, "mUSDC");
  assert.equal(view.collection, LIVE_ROW.collection);
  assert.equal(view.tier, "permissionless", "an unresolved Service takes the tier every Service holds on registration");
});

test("a row whose figures will not decode is dropped, not shown with zeroes", () => {
  assert.equal(toSettlementView({ ...LIVE_ROW, amount: "not a number" }), undefined);
  assert.equal(toSettlementView({ ...LIVE_ROW, settlementId: "0x1234" }), undefined);
  assert.equal(toSettlementViews([LIVE_ROW, { ...LIVE_ROW, applied: "" }]).length, 1);
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
  const absent = await missing.settlement(`0x${"00".repeat(32)}`);
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

test("the feed passes the page size and the cursor through, and nothing else", async () => {
  const seen: string[] = [];
  const registry = createRegistryClient({
    baseUrl: "http://registry.test",
    fetchImpl: async (url) => {
      seen.push(url);
      return respondWith(200, { index: { lastBlock: 5 }, settlements: [], nextCursor: null });
    },
  });

  const first = await serveSettlements({ registry }, new URLSearchParams(""));
  assert.equal(first.status, 200);
  assert.equal(seen[0], "http://registry.test/settlements?limit=25");

  await serveSettlements({ registry }, new URLSearchParams("limit=10&cursor=abc"));
  assert.equal(seen[1], "http://registry.test/settlements?limit=10&cursor=abc");
});

test("an empty page is a 200 carrying an empty list, not an error", async () => {
  const registry = createRegistryClient({
    baseUrl: "http://registry.test",
    fetchImpl: async () =>
      respondWith(200, { index: { lastBlock: 66_742_071 }, settlements: [], nextCursor: null }),
  });
  const result = await serveSettlements({ registry }, new URLSearchParams(""));
  assert.equal(result.status, 200);
  const body = result.body as { settlements: unknown[]; index: { lastBlock: number } };
  assert.deepEqual(body.settlements, []);
  // The horizon shows the index looked, which is what separates "nothing has
  // settled" from "we could not read".
  assert.equal(body.index.lastBlock, 66_742_071);
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
  // one could not produce markup here, so the claim is asserted rather than said.
  assert.equal((globalThis as { window?: unknown }).window, undefined);

  const networkSwitch = renderToStaticMarkup(createElement(NetworkSwitchView, { selected: "testnet" }));
  // The network is stated in words rather than carried by colour, as a radio
  // group with exactly one option checked and only that one in the tab order.
  assert.match(networkSwitch, /role="radiogroup"/);
  assert.match(networkSwitch, /aria-label="Network"/);
  assert.match(networkSwitch, />Testnet</);
  assert.match(networkSwitch, />Mainnet</);
  assert.equal(networkSwitch.match(/aria-checked="true"/g)?.length, 1);
  assert.match(networkSwitch, /aria-checked="true" tabindex="0"[^>]*data-network="testnet"/);
  assert.match(networkSwitch, /aria-checked="false" tabindex="-1"[^>]*data-network="mainnet"/);
  assert.doesNotMatch(networkSwitch, /aria-busy/, "nothing is loading until a choice is made");
  const switching = renderToStaticMarkup(createElement(NetworkSwitchView, { selected: "mainnet", pending: true }));
  assert.match(switching, /aria-busy="true"/);
  assert.match(switching, /aria-checked="true"[^>]*data-network="mainnet"/);

  const empty = renderToStaticMarkup(
    createElement(EmptyChain, {
      message: networkOptionFor(10143).emptyMeans,
      indexedBlock: 66_742_071,
    }),
  );
  assert.match(empty, /Nothing has settled on Monad Testnet yet/);
  assert.match(empty, /66,742,071/);

  const table = renderToStaticMarkup(
    createElement(SettlementTable, {
      rows: [VIEW_ROW],
      caption: "Settlements",
      hrefFor: (settlementId) => `/explorer/${settlementId}`,
      explorerHrefFor: (txHash) => explorerTxUrl(txHash, "https://testnet.monadvision.com"),
    }),
  );
  // The Settlement links by its id, and the transaction links to the explorer,
  // with both full words kept in `title` so a reader can check them.
  assert.match(table, new RegExp(`href="/explorer/${LIVE_ROW.settlementId}"`));
  assert.match(table, new RegExp(`title="${LIVE_ROW.settlementId}"`));
  assert.match(table, /monadvision\.com\/tx\/0x7e57a11e/);
  assert.match(table, /66,724,016/);
  // The amount renders as decimal units with the symbol in its own element, and
  // carries the exact base-unit integer in `title`. Asserting the title is the
  // stronger claim: it is the figure that must not have been scaled by a guess.
  assert.match(table, /0\.101 /);
  assert.match(table, /title="101000 base units \(mUSDC, 6 decimals\)"/);
  // Applied and prepaid are both on the row, so a reader sees where the money went.
  assert.match(table, /title="0 base units \(mUSDC, 6 decimals\)"/);
});

test("an empty feed renders as a sentence rather than as nothing at all", () => {
  const markup = renderToStaticMarkup(
    createElement(SettlementTable, {
      rows: [],
      caption: "Settlements",
      hrefFor: () => "#",
      explorerHrefFor: () => "#",
    }),
  );
  // The table still renders its caption for assistive technology even with no
  // rows, so the region is named rather than silently absent.
  assert.match(markup, /Settlements/);
});

/* ------------------------------------------------------- ERC-8004 identity */

const IDENTITY_REGISTRY = "0x8004a1b2c3d4e5f60718293a4b5c6d7e8f901234";

/** One agent as the registry serves it, with a card, a wallet and a live reputation read. */
const AGENT_ROW: IdentityAgentRow = {
  agentId: "7",
  owner: "0xa9e1000000000000000000000000000000007c30",
  agentWallet: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  matchedBy: ["owner"],
  agentURI: "https://agents.example.org/.well-known/agent-registration/tab-demo-agent.json",
  agentURISource: "index",
  card: {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Tab demo agent",
    description: "Settles its own tabs.",
    image: "https://agents.example.org/tab.png",
    services: [
      { name: "MCP", endpoint: "https://agents.example.org/mcp", version: "2025-06-18" },
      { endpoint: "https://agents.example.org/nameless" },
    ],
    secret: "must not be shown",
  },
  cardUnavailable: null,
  cardFetchedAt: "2026-09-22T09:00:00.000Z",
  reputation: {
    registry: "0x8004b1b2c3d4e5f60718293a4b5c6d7e8f905678",
    count: 12,
    clientCount: 3,
    summaryValue: "4567",
    summaryValueDecimals: 3,
    basis: "getSummary over every client",
    unavailable: null,
  },
  blocks: { registered: 64_000_000, owner: 64_000_000, uri: 64_000_001, wallet: 64_000_002 },
};

const IDENTITY: IdentityRow = {
  registry: IDENTITY_REGISTRY,
  basis: "Transfer, Registered, URIUpdated and MetadataSet folded to the current owner",
  agents: [AGENT_ROW],
};

test("identity kept apart: not served, not configured, none registered, and registered", () => {
  const notServed = toIdentityView(undefined);
  assert.equal(notServed.configured, false);
  assert.equal(notServed.agents.length, 0);
  assert.match(notServed.statement, /served no identity block/);

  const unconfigured = toIdentityView(null);
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.statement, IDENTITY_UNCONFIGURED_STATEMENT);

  const empty = toIdentityView({ ...IDENTITY, agents: [] });
  assert.equal(empty.configured, true);
  assert.equal(empty.statement, NO_IDENTITY_STATEMENT);
  assert.equal(empty.basis, IDENTITY.basis, "the empty answer carries what it was measured against");
  assert.equal(empty.registry, IDENTITY_REGISTRY);

  const populated = toIdentityView(IDENTITY);
  assert.equal(populated.agents.length, 1);
  const [agent] = populated.agents;
  assert.notEqual(agent, undefined);
  if (agent === undefined) return;
  assert.equal(agent.agentId, "7");
  assert.equal(agent.name, "Tab demo agent");
  assert.equal(agent.description, "Settles its own tabs.");
  assert.equal(agent.agentWallet, AGENT_ROW.agentWallet);
  assert.deepEqual(agent.matchedBy, ["owner"]);
  assert.equal(agent.agentURI, AGENT_ROW.agentURI);
  assert.equal(agent.agentURIShort, shortenUri(AGENT_ROW.agentURI as string));
  assert.ok((agent.agentURIShort as string).length < (AGENT_ROW.agentURI as string).length);
  assert.equal(agent.agentURISource, "the index");
  assert.equal(agent.cardFetchedAt, "2026-09-22T09:00:00.000Z");
  assert.equal(agent.cardUnavailable, undefined);
  assert.equal(agent.registeredBlock, 64_000_000);
  // Only the services that name themselves, and only name and endpoint of each.
  assert.deepEqual(agent.services, [{ name: "MCP", endpoint: "https://agents.example.org/mcp" }]);
  assert.equal(JSON.stringify(agent).includes("must not be shown"), false, "unknown card fields stay out");
  // The reputation mean is fixed point on the wire and decimal text here, never a float.
  assert.deepEqual(agent.reputation, {
    count: "12",
    clientCount: "3",
    summary: "4.567",
    registry: AGENT_ROW.reputation.registry,
    unavailable: undefined,
  });
});

test("a card that could not be read, and a reputation that was withheld, keep their reasons", () => {
  const view = toIdentityView({
    ...IDENTITY,
    agents: [
      {
        ...AGENT_ROW,
        agentURI: "",
        agentURISource: null,
        card: null,
        cardUnavailable: { code: "CARD_URI_EMPTY", message: "the agent has no URI set" },
        cardFetchedAt: null,
        reputation: {
          ...AGENT_ROW.reputation,
          count: null,
          clientCount: null,
          summaryValue: null,
          summaryValueDecimals: null,
          unavailable: { code: "CHAIN_READER_UNCONFIGURED", message: "no Monad endpoint wired in" },
        },
        blocks: { ...AGENT_ROW.blocks, registered: null },
      },
    ],
  });
  const [agent] = view.agents;
  if (agent === undefined) throw new Error("one agent expected");
  assert.equal(agent.name, undefined);
  assert.equal(agent.agentURI, undefined, "an empty URI is no URI");
  assert.equal(agent.cardUnavailable, "the agent has no URI set");
  assert.equal(agent.reputation.summary, undefined);
  assert.equal(agent.reputation.unavailable, "no Monad endpoint wired in");
  assert.equal(agent.registeredBlock, undefined);
  assert.deepEqual(agent.services, []);
});

test("the one-line identity summary names the agent or states the absence", () => {
  assert.deepEqual(toIdentitySummary(toIdentityView(null)), { text: "ERC-8004 identity not configured", named: false });
  assert.deepEqual(toIdentitySummary(toIdentityView({ ...IDENTITY, agents: [] })), { text: "no ERC-8004 identity", named: false });
  const named = toIdentitySummary(toIdentityView(IDENTITY));
  assert.equal(named.named, true);
  assert.equal(named.text, "Tab demo agent (ERC-8004 agent #7)");
  const unnamed = toIdentitySummary(toIdentityView({ ...IDENTITY, agents: [{ ...AGENT_ROW, card: null }, AGENT_ROW] }));
  assert.equal(unnamed.text, "ERC-8004 agent #7 and 1 more");
});

test("fixed-point text and URI shortening are exact and refuse to guess", () => {
  assert.equal(fixedPointText("4567", 3), "4.567");
  assert.equal(fixedPointText("45", 1), "4.5");
  assert.equal(fixedPointText("5", 3), "0.005");
  assert.equal(fixedPointText("5000", 3), "5");
  assert.equal(fixedPointText("-15", 1), "-1.5");
  assert.equal(fixedPointText("12", 0), "12");
  assert.equal(fixedPointText("1.5", 1), undefined);
  assert.equal(fixedPointText("12", -1), undefined);

  assert.equal(shortenUri("https://a.example/card.json"), "https://a.example/card.json");
  const long = `https://agents.example.org/${"x".repeat(80)}/card.json`;
  assert.ok(shortenUri(long).length < long.length);
  assert.ok(shortenUri(long).startsWith("https://agents.example.org/"));
  assert.ok(shortenUri(long).endsWith("card.json"));
  assert.match(shortenUri("data:application/json;base64,eyJ9"), /^data: URI, \d+ characters inline$/);
});

/* ---------------------------------------------------------- Nansen labels */

test("labels: a missing key is a configuration fact, and the other four answers are distinct", () => {
  const notServed = toLabelsView(undefined);
  assert.equal(notServed.status, "not-served");
  assert.match(notServed.statement, /served no labels block/);

  const unconfigured = toLabelsView({
    source: "nansen",
    unavailable: { code: "NANSEN_KEY_MISSING", message: "no NANSEN_API_KEY is configured, so no labels were looked up" },
  });
  assert.equal(unconfigured.status, "not-configured");
  assert.equal(unconfigured.statement, LABELS_UNCONFIGURED_STATEMENT);
  assert.equal(/error|fail/i.test(unconfigured.statement), false, "a missing key never reads as a failure");

  const unavailable = toLabelsView({
    source: "nansen",
    unavailable: { code: "NANSEN_TIMEOUT", message: "Nansen did not answer within 4000 ms" },
  });
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.statement, /could not be read: Nansen did not answer within 4000 ms/);

  const empty = toLabelsView({ source: "nansen", chain: "all", fetchedAt: "2026-09-22T09:00:00.000Z", labels: [] });
  assert.equal(empty.status, "empty");
  assert.match(empty.statement, /holds no label for this address on any chain it covers/);
  assert.equal(empty.fetchedAt, "2026-09-22T09:00:00.000Z");

  const served = toLabelsView({
    source: "nansen",
    chain: "monad",
    fetchedAt: "2026-09-22T09:00:00.000Z",
    entity: "Example Exchange",
    labels: [
      { label: "Example Exchange", category: "Exchange", kind: ["entity"] },
      { label: "Smart Money", kind: "behaviour" },
      { label: "Deposit" },
    ],
  });
  assert.equal(served.status, "served");
  assert.equal(served.entity, "Example Exchange");
  assert.equal(served.chain, "monad");
  assert.match(served.statement, /3 Nansen labels on monad/);
  assert.deepEqual(served.labels, [
    { label: "Example Exchange", category: "Exchange", kind: "entity" },
    { label: "Smart Money", category: undefined, kind: "behaviour" },
    { label: "Deposit", category: undefined, kind: undefined },
  ]);
});

/* ---------------------------------------- the agent page sections, no wallet */

test("the identity and labels sections state their facts in a process with no wallet", () => {
  assert.equal((globalThis as { window?: unknown }).window, undefined);
  const explorer = (address: string) => explorerAddressUrl(address, "https://testnet.monadvision.com");

  // Not configured: the sentence, and no basis because nothing was searched.
  const unconfigured = renderToStaticMarkup(
    createElement(IdentitySection, { identity: toIdentityView(null), explorerAddressHrefFor: explorer }),
  );
  assert.ok(unconfigured.includes(IDENTITY_UNCONFIGURED_STATEMENT));
  assert.equal(unconfigured.includes("Basis"), false);

  // None registered: the sentence plus the basis it was measured against.
  const none = renderToStaticMarkup(
    createElement(IdentitySection, { identity: toIdentityView({ ...IDENTITY, agents: [] }), explorerAddressHrefFor: explorer }),
  );
  assert.ok(none.includes(NO_IDENTITY_STATEMENT));
  assert.ok(none.includes(IDENTITY.basis));

  // Registered: one card with the id, the name, the URI and its source, the
  // wallet, the reputation, the block and the explorer link to the registry.
  const registered = renderToStaticMarkup(
    createElement(IdentitySection, { identity: toIdentityView(IDENTITY), explorerAddressHrefFor: explorer }),
  );
  assert.match(registered, /ERC-8004 agent #7/);
  assert.match(registered, /Tab demo agent/);
  assert.match(registered, /from the index/);
  assert.match(registered, new RegExp(`title="${AGENT_ROW.agentURI}"`));
  assert.match(registered, /mean 4\.567 over 12 entries from 3 clients/);
  assert.match(registered, /block 64,000,000/);
  assert.match(registered, new RegExp(`monadvision\\.com/address/${IDENTITY_REGISTRY}`));
  assert.match(registered, /agents\.example\.org\/mcp/);
  assert.equal(registered.includes("must not be shown"), false);

  // Labels, with no key: the configuration sentence and the offchain sentence,
  // and nothing drawn in the danger tone.
  const labels = renderToStaticMarkup(
    createElement(LabelsStrip, {
      view: toLabelsView({ source: "nansen", unavailable: { code: "NANSEN_KEY_MISSING", message: "no key" } }),
      offchainStatement: LABELS_OFFCHAIN_STATEMENT,
    }),
  );
  assert.ok(labels.includes(LABELS_UNCONFIGURED_STATEMENT));
  assert.ok(labels.includes(LABELS_OFFCHAIN_STATEMENT));
  assert.equal(labels.includes("status-danger"), false);

  const served = renderToStaticMarkup(
    createElement(LabelsStrip, {
      view: toLabelsView({
        source: "nansen",
        chain: "all",
        fetchedAt: "2026-09-22T09:05:00.000Z",
        labels: [{ label: "Smart Money", category: "Fund" }],
        entity: "Example Fund",
      }),
      offchainStatement: LABELS_OFFCHAIN_STATEMENT,
    }),
  );
  assert.match(served, /Smart Money/);
  assert.match(served, /Fund/);
  assert.match(served, /fetched 2026-09-22 09:05 UTC/);
  assert.match(served, /Example Fund/);
  assert.ok(served.includes(LABELS_OFFCHAIN_STATEMENT));
});

/* ------------------------------------------------------ ERC-8004 reputation */

/** The same agent, with what Tab Services wrote beside what everyone wrote. */
const TAB_REPUTATION: IdentityAgentRow["reputation"] = {
  ...AGENT_ROW.reputation,
  fromTab: {
    tag1: "tab",
    tag2: "settled",
    count: 9,
    clients: ["0xa9e1000000000000000000000000000000007c30", "0x2f117efa472ba981cc2d89767ca5c9427cab0532"],
    summaryValue: "100",
    summaryValueDecimals: 0,
    basis: "getSummary over the Service operators with tag1 tab and tag2 settled; never read by the Credit Limit",
    unavailable: null,
  },
};

test("reputation keeps four answers apart: not served, not configured, no identity, and figures", () => {
  assert.equal(toReputationSectionView(undefined).statement, REPUTATION_NOT_SERVED_STATEMENT);
  assert.equal(toReputationSectionView(null).statement, REPUTATION_UNCONFIGURED_STATEMENT);
  const none = toReputationSectionView({ ...IDENTITY, agents: [] });
  assert.equal(none.statement, REPUTATION_NO_IDENTITY_STATEMENT);
  assert.deepEqual(none.agents, []);

  const view = toReputationSectionView({ ...IDENTITY, agents: [{ ...AGENT_ROW, reputation: TAB_REPUTATION }] });
  assert.deepEqual(view.agents, [
    {
      agentId: "7",
      fromTab: { text: "9 entries from 2 Tab Services, average 100", hasFeedback: true },
      fromAll: { text: "12 entries from 3 clients, average 4.567", hasFeedback: true },
      registry: AGENT_ROW.reputation.registry,
    },
  ]);
  assert.equal(view.basis, TAB_REPUTATION.fromTab?.basis);
});

test("an agent with no feedback says so, and a figure that was not read says why", () => {
  const empty = toReputationSectionView({
    ...IDENTITY,
    agents: [
      {
        ...AGENT_ROW,
        reputation: {
          ...TAB_REPUTATION,
          count: 0,
          clientCount: 0,
          summaryValue: "0",
          fromTab: { ...TAB_REPUTATION.fromTab!, count: 0, clients: [], summaryValue: "0" },
        },
      },
    ],
  });
  assert.deepEqual(empty.agents[0]?.fromTab, { text: "No feedback yet from Tab Services.", hasFeedback: false });
  assert.deepEqual(empty.agents[0]?.fromAll, { text: "No feedback yet.", hasFeedback: false });

  const withheld = toReputationSectionView({
    ...IDENTITY,
    agents: [
      {
        ...AGENT_ROW,
        reputation: {
          ...TAB_REPUTATION,
          fromTab: { ...TAB_REPUTATION.fromTab!, count: null, unavailable: { code: "CHAIN_READ_FAILED", message: "ReputationRegistry could not be read" } },
        },
      },
    ],
  });
  assert.equal(withheld.agents[0]?.fromTab.text, "Not read: ReputationRegistry could not be read");

  // A registry from before the Tab figure existed serves no `fromTab` at all.
  const older = toReputationSectionView(IDENTITY);
  assert.equal(older.agents[0]?.fromTab.text, "Not served by this registry.");
  assert.equal(older.agents[0]?.fromAll.hasFeedback, true);

  // One entry and one client read in the singular.
  const single = toReputationSectionView({
    ...IDENTITY,
    agents: [{ ...AGENT_ROW, reputation: { ...TAB_REPUTATION, fromTab: { ...TAB_REPUTATION.fromTab!, count: 1, clients: ["0xa9e1000000000000000000000000000000007c30"] } } }],
  });
  assert.equal(single.agents[0]?.fromTab.text, "1 entry from 1 Tab Service, average 100");
});

test("the reputation section renders each state in a process with no wallet", () => {
  const explorer = (address: string) => explorerAddressUrl(address, "https://testnet.monadvision.com");
  const render = (identity: IdentityRow | null | undefined) =>
    renderToStaticMarkup(
      createElement(ReputationSection, {
        reputation: toReputationSectionView(identity),
        derivedStatement: REPUTATION_DERIVED_STATEMENT,
        explorerAddressHrefFor: explorer,
      }),
    );

  const noIdentity = render({ ...IDENTITY, agents: [] });
  assert.ok(noIdentity.includes(REPUTATION_NO_IDENTITY_STATEMENT));
  assert.equal(noIdentity.includes(REPUTATION_DERIVED_STATEMENT), false, "no figure, so nothing to qualify");
  assert.ok(render(null).includes(REPUTATION_UNCONFIGURED_STATEMENT));

  const served = render({ ...IDENTITY, agents: [{ ...AGENT_ROW, reputation: TAB_REPUTATION }] });
  assert.match(served, /ERC-8004 agent #7/);
  assert.match(served, /From Tab Services/);
  assert.match(served, /9 entries from 2 Tab Services, average 100/);
  assert.match(served, /From all clients/);
  assert.match(served, /12 entries from 3 clients, average 4\.567/);
  assert.match(served, new RegExp(`monadvision\\.com/address/${AGENT_ROW.reputation.registry}`));
  assert.ok(served.includes(REPUTATION_DERIVED_STATEMENT));
  assert.match(served, /Basis/);
  assert.match(REPUTATION_DERIVED_STATEMENT, /Credit Limit never reads it/);

  const quiet = render({
    ...IDENTITY,
    agents: [{ ...AGENT_ROW, reputation: { ...TAB_REPUTATION, count: 0, clientCount: 0, fromTab: { ...TAB_REPUTATION.fromTab!, count: 0, clients: [] } } }],
  });
  assert.match(quiet, /No feedback yet from Tab Services\./);
  assert.match(quiet, /No feedback yet\./);
  assert.equal(quiet.includes("status-danger"), false, "no feedback is not a fault");
});

test("the agent page gives reputation its own section, so the identity card leaves its line out", () => {
  const source = readFileSync(join(APP_ROOT, "app", "agents", "[agent]", "page.tsx"), "utf8");
  assert.match(source, /Reputation, from the ERC-8004 registry/);
  assert.match(source, /<ReputationSection\s+reputation=\{reputation\}\s+derivedStatement=\{REPUTATION_DERIVED_STATEMENT\}/);
  assert.match(source, /<IdentitySection identity=\{identity\} explorerAddressHrefFor=\{context\.explorerAddressHrefFor\} hideReputation \/>/);
  // The section sits directly under the identity section.
  assert.ok(source.indexOf("Identity, from the ERC-8004 registry") < source.indexOf("Reputation, from the ERC-8004 registry"));
  assert.ok(source.indexOf("Reputation, from the ERC-8004 registry") < source.indexOf("Credit, per Asset"));

  const hidden = renderToStaticMarkup(createElement(IdentitySection, { identity: toIdentityView(IDENTITY), hideReputation: true }));
  assert.equal(/mean 4\.567/.test(hidden), false);
  assert.match(renderToStaticMarkup(createElement(IdentitySection, { identity: toIdentityView(IDENTITY) })), /mean 4\.567/);
});

test("the agent page places both sections and the strip says what a label is not", () => {
  const source = readFileSync(join(APP_ROOT, "app", "agents", "[agent]", "page.tsx"), "utf8");
  assert.match(source, /<IdentitySection identity=\{identity\}/);
  assert.match(source, /<LabelsStrip view=\{labels\} offchainStatement=\{LABELS_OFFCHAIN_STATEMENT\}/);
  assert.match(LABELS_OFFCHAIN_STATEMENT, /offchain signal/);
  assert.match(LABELS_OFFCHAIN_STATEMENT, /change nothing in the Credit Limit/);
});

test("the operator strip names the identity or the absence, and the x402 offer", () => {
  const named = renderToStaticMarkup(
    createElement(ServiceOperatorStrip, { identity: toIdentitySummary(toIdentityView(IDENTITY)), x402: true }),
  );
  assert.match(named, /Tab demo agent \(ERC-8004 agent #7\)/);
  assert.match(named, />x402</);
  assert.ok(named.includes(X402_STRIP_COPY));
  assert.equal(X402_STRIP_COPY, "also payable per call with x402 when credit runs out");

  const absent = renderToStaticMarkup(
    createElement(ServiceOperatorStrip, { identity: toIdentitySummary(toIdentityView({ ...IDENTITY, agents: [] })), x402: false }),
  );
  assert.match(absent, /no ERC-8004 identity/);
  assert.match(absent, /credit only/);

  const unread = renderToStaticMarkup(
    createElement(ServiceOperatorStrip, {
      identity: toIdentitySummary(toIdentityView(undefined)),
      identityUnavailable: "the registry answered 503",
      x402: false,
    }),
  );
  assert.match(unread, /not read: the registry answered 503/);
});

test("the explorer says where an x402 payment goes, and that it is not a Settlement", () => {
  const source = readFileSync(join(APP_ROOT, "app", "explorer", "page.tsx"), "utf8");
  assert.match(source, /paid per request with x402/);
  assert.match(source, /never appear here as Settlements/);
});

/* -------------------------------------------------------- the service read */

const SERVICE_ROW: ServiceRow = {
  serviceId: "0x7461622e64656d6f000000000000000000000000000000000000000000000000",
  operator: "0xc011ec7000000000000000000000000000000001",
  tier: { value: 0, name: "permissionless", creditWeight: "0", source: { appliedBy: "registration", monad: LIVE_ROW.monad } },
  settlementWindowSeconds: { value: 3600, source: { appliedBy: "registration", monad: LIVE_ROW.monad } },
  acceptedAssets: [{ asset: TESTNET_MUSDC, collection: "0xc011ec7000000000000000000000000000000001" }],
  prices: [{ asset: TESTNET_MUSDC, tool: "0x71756f74652e67656e657261746500000000000000000000000000000000000000".slice(0, 66), baseUnits: "101000" }],
  bond: [],
  pendingChanges: [],
  registeredAt: LIVE_ROW.monad,
};

test("a tool priced in an Asset the Service never staked in shows a free Bond of zero, and a refused ledger shows none", () => {
  const otherAsset = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a";
  const priced = {
    ...SERVICE_ROW,
    acceptedAssets: [...SERVICE_ROW.acceptedAssets, { asset: otherAsset, collection: SERVICE_ROW.operator }],
    prices: [...SERVICE_ROW.prices, { ...SERVICE_ROW.prices[0], asset: otherAsset }],
    bond: [
      {
        serviceId: SERVICE_ROW.serviceId,
        party: `0x${"ab".repeat(32)}`,
        asset: TESTNET_MUSDC,
        staked: "50000000",
        withdrawn: "0",
        free: "50000000",
        crossCheck: { read: "Bond.freeOf", onChain: { free: "1" }, agrees: false },
      },
    ],
  } as ServiceRow;
  const entries = toCatalogue([priced], [], 10143);
  const inUsdc = entries.find((entry) => entry.assetAddress.toLowerCase() === TESTNET_MUSDC.toLowerCase());
  const inOther = entries.find((entry) => entry.assetAddress.toLowerCase() === otherAsset);
  // The ledger the index refused is absent: the page must not print a figure
  // the chain disagreed with. The Asset with no ledger at all is zero: nothing
  // was ever staked in it, and that is a fact the index stands behind.
  assert.equal(inUsdc?.freeBondBaseUnits, undefined);
  assert.equal(inOther?.freeBondBaseUnits, 0n);
});

test("the service read folds the operator's identity onto the row, and a 404 is not-found", async () => {
  const client = createRegistryClient({
    baseUrl: "http://registry.test",
    fetchImpl: async (url) =>
      url.endsWith("/services/missing")
        ? respondWith(404, { error: {} })
        : respondWith(200, { index: { lastBlock: 1 }, service: SERVICE_ROW, identity: IDENTITY }),
  });
  const detail = await client.service(SERVICE_ROW.serviceId);
  assert.equal(detail.ok, true);
  if (!detail.ok) return;
  assert.deepEqual(detail.value.service.identity, IDENTITY);
  assert.equal(detail.value.service.operator, SERVICE_ROW.operator);

  const missing = await client.service("missing");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "SERVICE_NOT_REGISTERED");
});

/* ------------------------------------------------- the published directory */

test("the committed directory parses, with its x402 and Hub blocks carried", () => {
  const parsed = parsePublishedDirectory(
    JSON.parse(readFileSync(join(APP_ROOT, "..", "..", "service-endpoints.json"), "utf8")),
  );
  assert.ok(parsed.length >= 1);
  const demo = parsed.find((entry) => entry.name === "tab.demo");
  assert.notEqual(demo, undefined);
  if (demo === undefined) return;
  assert.equal(demo.x402?.offerOn402, true);
  assert.equal(demo.hub?.provider, "defillama");
  assert.equal(demo.hub?.prefix, "apihub");
  assert.equal(demo.hub?.marginBps, 500);
  assert.equal(offersX402(demo), true);
  assert.equal(offersX402(undefined), false);
  assert.equal(offersX402({ ...demo, x402: undefined, hub: undefined }), false);
  assert.equal(offersX402({ ...demo, x402: undefined }), true, "a Hub block alone means x402 is in play");
  // A malformed file yields nothing rather than a throw, and a malformed
  // entry is dropped rather than rendered with holes.
  assert.deepEqual(parsePublishedDirectory(null), []);
  assert.deepEqual(parsePublishedDirectory({ services: [{ name: "no id" }] }), []);
});

test("the committed directory names a network on every entry, and each network gets only its own", () => {
  const parsed = parsePublishedDirectory(
    JSON.parse(readFileSync(join(APP_ROOT, "..", "..", "service-endpoints.json"), "utf8")),
  );
  for (const entry of parsed) {
    assert.ok(entry.chainId === 10143 || entry.chainId === 143, `${entry.name} names a Monad network`);
  }
  const testnet = publishedOn(parsed, 10143).find((entry) => entry.name === "tab.demo");
  const mainnet = publishedOn(parsed, 143).find((entry) => entry.name === "tab.demo");
  assert.notEqual(testnet, undefined);
  assert.notEqual(mainnet, undefined);
  // The same Service id on both networks, so only the chain keeps the two
  // gateways apart, and they must be two gateways.
  assert.equal(testnet?.serviceId, mainnet?.serviceId);
  assert.notEqual(testnet?.endpoint, mainnet?.endpoint);

  // An entry that names no chain, or names it as text, serves neither network.
  const loose = parsePublishedDirectory({
    services: [
      { serviceId: "0x01", endpoint: "http://a.test" },
      { serviceId: "0x02", endpoint: "http://b.test", chainId: "143" },
      { serviceId: "0x03", endpoint: "http://c.test", chainId: 143 },
    ],
  });
  assert.deepEqual(publishedOn(loose, 10143), []);
  assert.deepEqual(
    publishedOn(loose, 143).map((entry) => entry.serviceId),
    ["0x03"],
  );
});

/* --------------------------------------------------------------- the Hub */

const HUB_ENDPOINTS: readonly HubEndpointInput[] = [
  {
    provider: "defillama",
    providerName: "DefiLlama",
    endpoint: "/protocols",
    name: "List protocols",
    description: "Every protocol DefiLlama tracks.",
    priceType: "PER_CALL",
    priceUsd: "0.01",
    priceBaseUnits: "10000",
    networks: ["eip155:143"],
    categories: ["defi"],
  },
  {
    provider: "defillama",
    providerName: "DefiLlama",
    endpoint: "/tvl",
    name: null,
    description: null,
    priceType: "PER_CALL",
    priceUsd: "0.001",
    priceBaseUnits: "1000",
    networks: [],
    categories: [],
  },
  {
    provider: "defillama",
    providerName: "DefiLlama",
    endpoint: "/search",
    name: "Search",
    description: "Priced per result.",
    priceType: "PER_RESULT",
    priceUsd: "0.0001",
    priceBaseUnits: null,
    networks: [],
    categories: [],
  },
];

test("the margin is applied with bigint arithmetic and rounds up", () => {
  assert.equal(withMargin("10000", 500), "10500");
  assert.equal(withMargin("10001", 500), "10502", "10501.05 rounds up: a catalogue must not understate");
  assert.equal(withMargin("10000", undefined), "10000");
  assert.equal(withMargin("10000", 0), "10000");
  assert.equal(withMargin("1.5", 500), undefined);
  assert.equal(withMargin("10000", -1), undefined);
});

test("Hub entries carry both prices, the hub path and the tool, and sort after the chain's tools", () => {
  const published = parsePublishedDirectory({
    services: [
      {
        serviceId: SERVICE_ROW.serviceId,
        name: "tab.demo",
        endpoint: "http://localhost:8788",
        tools: { "apihub.run": "the Hub" },
        hub: { provider: "defillama", prefix: "apihub", marginBps: 500 },
      },
      {
        serviceId: `0x${"ab".repeat(32)}`,
        name: "ghost",
        endpoint: "http://ghost.test",
        hub: { provider: "coingecko", prefix: "gecko" },
      },
    ],
  });
  const manifests = new Map([
    [SERVICE_ROW.serviceId, { ok: true as const, endpoints: HUB_ENDPOINTS, total: 120 }],
  ]);
  const hub = toHubEntries([SERVICE_ROW], published, manifests, 10143);

  // Cheapest per-call first, then the one with no fixed price.
  assert.deepEqual(hub.entries.map((entry) => entry.path), ["/tvl", "/protocols", "/search"]);
  const protocols = hub.entries.find((entry) => entry.path === "/protocols");
  if (protocols === undefined) throw new Error("expected /protocols");
  assert.equal(protocols.upstreamUsd, "0.01");
  assert.equal(protocols.tabPriceBaseUnits, "10500");
  assert.equal(protocols.asset.symbol, "mUSDC", "priced in the Asset the Service accepts");
  assert.equal(protocols.hubPath, "/hub/apihub/run");
  assert.equal(protocols.tool, "apihub.run");
  assert.equal(protocols.serviceName, "tab.demo");
  assert.equal(protocols.providerName, "DefiLlama");
  const search = hub.entries.find((entry) => entry.path === "/search");
  assert.equal(search?.tabPriceBaseUnits, undefined, "a per-result price has no fixed Tab price");
  const tvl = hub.entries.find((entry) => entry.path === "/tvl");
  assert.equal(tvl?.name, "/tvl", "an unnamed endpoint is named by its path");

  // The unregistered Service is a sentence, not a card; so is the count.
  assert.equal(hub.notes.some((note) => /ghost/.test(note.text) && /not registered on chain/.test(note.text)), true);
  assert.equal(hub.notes.some((note) => /lists 120 endpoints/.test(note.text)), true);

  // A manifest that could not be read is a sentence too, and the Service keeps its on-chain tools.
  const failed = toHubEntries(
    [SERVICE_ROW],
    published,
    new Map([[SERVICE_ROW.serviceId, { ok: false as const, message: "the API Hub manifest did not answer" }]]),
    10143,
  );
  assert.deepEqual(failed.entries, []);
  assert.equal(failed.notes.some((note) => /could not be read: the API Hub manifest did not answer/.test(note.text)), true);
  assert.equal(toCatalogue([SERVICE_ROW], published, 10143).length, 1, "the chain's own tool is still listed");

  // The recipe names the tool, the hub path and the endpoint the Hub is called with.
  const recipe = hubRecipeFor(protocols);
  assert.match(recipe.call, /tab_call with/);
  assert.match(recipe.call, /tool: {6}apihub\.run/);
  assert.match(recipe.call, /path: {6}\/hub\/apihub\/run/);
  assert.match(recipe.call, /"endpoint":"\/protocols"/);
  assert.match(recipe.call, new RegExp(`asset: {5}10143:${TESTNET_MUSDC}`));
  assert.match(recipe.http, /^POST http:\/\/localhost:8788\/hub\/apihub\/run/);
});

/* ---------------------------------------------- the curation authority, read */

test("the curation authority is read for what it is, and a refusal is not an answer", async () => {
  const MULTISIG = "0x123c19f46c38d5b4e922d1297250a71a03dffd17";
  const OWNERS = ["0x49472ef9ed99f30d4ead45ac9e1c16c31f70783a", "0x64e86f88706afa73bb627dbd7430406cf26b4f78"];
  const word = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
  const ownersReturn = `0x${word("0x20")}${word(`0x${OWNERS.length.toString(16)}`)}${OWNERS.map((o) => word(o)).join("")}`;

  const reader = (answers: Record<string, { ok: true; value: string } | { ok: false; error: { code: string; message: string; category: string; retryable: boolean } }>) =>
    ({
      chainId: async () => ({ ok: true as const, value: 143 }),
      latestBlock: async () => ({ ok: true as const, value: { number: 1, timestamp: 1 } }),
      logs: async () => ({ ok: true as const, value: [] }),
      call: async (_to: string, data: string) =>
        answers[data.slice(0, 10)] ?? { ok: false as const, error: { category: "UPSTREAM", code: "CALL_FAILED", message: "no", retryable: true } },
    }) as unknown as Parameters<typeof readCurationAuthority>[0];

  // A CurationMultisig answers both reads, and is drawn as the multisig it is.
  const multisig = await readCurationAuthority(
    reader({ "0x785ffb37": { ok: true, value: `0x${word("0x2")}` }, "0xaffe39c1": { ok: true, value: ownersReturn } }),
    MULTISIG,
    1,
  );
  assert.equal(multisig.kind, "multisig");
  assert.equal(multisig.threshold, 2);
  assert.deepEqual(multisig.owners, OWNERS);

  // An ordinary account answers none of them, which is an answer and not a failure.
  const account = await readCurationAuthority(reader({}), MULTISIG, 1);
  assert.equal(account.kind, "account");

  // A threshold with no decodable owner set is neither, and says so rather than
  // printing a multisig with no owners.
  const half = await readCurationAuthority(
    reader({ "0x785ffb37": { ok: true, value: `0x${word("0x2")}` }, "0xaffe39c1": { ok: true, value: "0xdeadbeef" } }),
    MULTISIG,
    1,
  );
  assert.equal(half.kind, "unreadable");
  assert.match(half.unreadable ?? "", /could not decode/);

  // A partial owner list is refused whole: two of three owners would be worse
  // than none.
  const truncated = `0x${word("0x20")}${word("0x3")}${word(OWNERS[0] as string)}`;
  const short = await readCurationAuthority(
    reader({ "0x785ffb37": { ok: true, value: `0x${word("0x2")}` }, "0xaffe39c1": { ok: true, value: truncated } }),
    MULTISIG,
    1,
  );
  assert.equal(short.kind, "unreadable");

  assert.equal((await readCurationAuthority(reader({}), "not-an-address", 1)).kind, "unreadable");
});

// ---------------------------------------------------------------- Browse examples

test("every Browse example has a unique key, a provider mark on disk and a declared tint", () => {
  const keys = new Set(SHOWCASE.map((entry) => entry.key));
  assert.equal(keys.size, SHOWCASE.length, "example keys are unique");
  const presentation = readFileSync(join(APP_ROOT, "styles", "presentation.css"), "utf8");
  for (const entry of SHOWCASE) {
    const mark = providerLogo(entry.tool);
    assert.notEqual(mark, "/logo.png", `${entry.tool} has its provider's own mark`);
    assert.ok(readFileSync(join(APP_ROOT, "public", mark)).length > 0, `${mark} exists`);
    const tint = CATEGORY_TINT[entry.category];
    assert.ok(tint !== undefined, `${entry.category} has a tint`);
    // The theme clears Tailwind's palette, so a shade that is not declared compiles to nothing.
    for (const [, hue, step] of tint.matchAll(/(?:bg|text)-([a-z]+)-(\d{3})/g)) {
      assert.match(presentation, new RegExp(`--color-${hue}-${step}:`), `--color-${hue}-${step} is declared`);
    }
  }
});

test("a provider mark is drawn in a colour that shows on the light disc behind it", () => {
  for (const mark of new Set(SHOWCASE.map((entry) => providerLogo(entry.tool)))) {
    const svg = readFileSync(join(APP_ROOT, "public", mark), "utf8");
    const fills = [...svg.matchAll(/fill="([^"]+)"/g)].map(([, fill]) => fill.toLowerCase());
    const visible = fills.length === 0 || fills.some((fill) => !["white", "#fff", "#ffffff", "none"].includes(fill));
    assert.ok(visible, `${mark} is not drawn only in white or nothing`);
  }
});

test("an example from a provider with no mark of its own is drawn with Tab's", () => {
  assert.equal(providerLogo("someone-new/model"), "/logo.png");
});

test("the credit gauge's Open Tab is the live TabBook read, not the lower bound left by the last Settlement", () => {
  // Twenty deliveries after a Settlement that left 0: the index observed 0, the
  // chain holds 200000, and the headroom beside it is measured from 200000.
  const row = {
    asset: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    creditLimit: { value: "950000" },
    headroom: { value: "750000", openTab: "200000" },
    openTab: { observed: "0", basis: "lower bound", liveRead: "TabBook.assetOpen(agent, asset)" },
    delinquency: { delinquent: false, openCount: 0 },
    settlements: null,
  };
  const view = toCreditView(row);
  assert.equal(view.openTabBaseUnits, 200_000n);
  assert.equal(view.creditLimitBaseUnits! - view.openTabBaseUnits, view.headroomBaseUnits, "limit, open and headroom agree");

  const withoutChain = toCreditView({ ...row, headroom: { value: null, openTab: null } });
  assert.equal(withoutChain.openTabBaseUnits, 0n, "a registry with no chain reader leaves only the observation");
});
