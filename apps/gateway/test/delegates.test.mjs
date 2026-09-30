/**
 * A metered call signed by a delegate: a session key the Agent named in
 * `MeteringDelegates`. The signature is recovered against `Tab-Delegate`, the
 * registration is read off the contract, and the operator and Agent paths are
 * exactly what they were.
 *
 * The contract is played by a fake `eth_call` that decodes the real calldata
 * against the real fragments and answers from a table, so what is tested is
 * the encoding the gateway sends to the chain.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface, Wallet } from "ethers";

import { METERING_DELEGATES_ABI } from "@tabai/shared";

import { createApp, ISSUED_AT_HEADER, SIGNATURE_HEADER } from "../dist/server.js";
import { METERING_HEADER, SIGNATURE_WINDOW_MS, meteringDigest } from "../dist/authorisation.js";
import { DELEGATE_CACHE_MS, createMeteringDelegateReader } from "../dist/delegates.js";

/** The window the cache tests opt into; the default holds nothing. */
const WINDOW_MS = 60_000;

const OPERATOR = new Wallet(`0x${"11".repeat(32)}`);
const AGENT_KEY = new Wallet(`0x${"44".repeat(32)}`);
const AGENT = AGENT_KEY.address.toLowerCase();
const DELEGATE = new Wallet(`0x${"77".repeat(32)}`);
const STRANGER = new Wallet(`0x${"88".repeat(32)}`);
const REGISTRY = "0x00000000000000000000000000000000000de1e9";
const ASSET = "0x534b2f3a21130d7a60830c2df862319e593943a3";
const SERVICE = "0x7461622e64656d6f000000000000000000000000000000000000000000000000";
const TOOL = `0x${"33".repeat(32)}`;
const NOW = 1_788_700_000_000;
const NOW_S = BigInt(NOW / 1000);

const asset = { chainId: 10143n, address: ASSET, decimals: 6, symbol: "USDC" };
const receipt = { charged: 10_000n, openAfter: 10_000n, headroomAfter: 4_740_000n, recordedAt: NOW };
const IFACE = new Interface([...METERING_DELEGATES_ABI]);

/**
 * `MeteringDelegates` as a table of `agent:delegate` to expiry in seconds,
 * judged against a clock the test controls, with every read counted.
 */
function fakeRegistry(entries, clock) {
  const reads = [];
  const call = async ({ to, data }) => {
    assert.equal(to, REGISTRY, "the configured contract is the one asked");
    const parsed = IFACE.parseTransaction({ data });
    const [agent, delegate] = parsed.args.map((value) => String(value).toLowerCase());
    reads.push(parsed.name);
    const expiry = entries.get(`${agent}:${delegate}`) ?? 0n;
    if (parsed.name === "isDelegate") return IFACE.encodeFunctionResult("isDelegate", [expiry * 1000n > BigInt(clock())]);
    if (parsed.name === "expiryOf") return IFACE.encodeFunctionResult("expiryOf", [expiry]);
    throw new Error(`unexpected read ${parsed.name}`);
  };
  return { call, reads };
}

function recordingClient(events) {
  return {
    recordDelivery: async () => {
      events.push("metered");
      return { ok: true, value: receipt };
    },
    openTabOf: async () => ({ ok: true, value: 10_000n }),
    simulateDelivery: async () => ({ ok: true, value: receipt }),
    creditLimit: async () => ({ ok: true, value: 4_750_000n }),
  };
}

function appWith({ entries = new Map(), delegates = true, clock = () => NOW } = {}) {
  const events = [];
  const registry = fakeRegistry(entries, clock);
  const app = createApp({
    serviceId: SERVICE,
    asset,
    operator: OPERATOR.address,
    tabBook: recordingClient(events),
    priceOf: () => ({ tool: TOOL, unitPrice: 10_000n }),
    now: clock,
    ...(delegates ? { meteringDelegates: createMeteringDelegateReader({ address: REGISTRY, call: registry.call, now: clock }) } : {}),
  });
  return { app, events, reads: registry.reads };
}

const claim = (issuedAt = NOW, agent = AGENT) => ({ method: "POST", path: "/meter/quote", agent, tool: TOOL, units: 1, issuedAt });

async function delegateHeaders({ signer = DELEGATE, named = signer.address, agent = AGENT, issuedAt = NOW } = {}) {
  return {
    "Tab-Agent": agent,
    [METERING_HEADER.delegate]: named,
    [METERING_HEADER.delegateSignature]: await signer.signMessage(meteringDigest(claim(issuedAt, agent))),
    [METERING_HEADER.delegateIssuedAt]: String(issuedAt),
  };
}

const post = async (app, headers) => app.request("/meter/quote", { method: "POST", headers });
const registered = (expirySeconds = NOW_S + 86_400n) => new Map([[`${AGENT}:${DELEGATE.address.toLowerCase()}`, expirySeconds]]);

test("a call signed by a delegate the Agent registered is accepted and metered to the Agent", async () => {
  const { app, events, reads } = appWith({ entries: registered() });
  const response = await post(app, await delegateHeaders());
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(events, ["metered"]);
  assert.deepEqual(reads.sort(), ["expiryOf", "isDelegate"], "one registration read, and the expiry that bounds the cache");
});

test("a signature by a key other than the one named in Tab-Delegate is refused before the chain is read", async () => {
  const { app, events, reads } = appWith({ entries: registered() });
  const response = await post(app, await delegateHeaders({ signer: STRANGER, named: DELEGATE.address }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "METERING_SIGNATURE_NOT_DELEGATE");
  assert.deepEqual(events, []);
  assert.deepEqual(reads, [], "a forged signature costs no RPC call");
});

test("a key the Agent never registered is refused by name, however well it signs", async () => {
  const { app, events } = appWith({ entries: registered() });
  const response = await post(app, await delegateHeaders({ signer: STRANGER }));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, "METERING_DELEGATE_NOT_REGISTERED");
  assert.match(body.error.message, /never set, lapsed, or revoked/);
  assert.equal(body.error.details.meteringDelegates, REGISTRY);
  assert.deepEqual(events, []);
});

test("a delegate registered for another Agent cannot sign for this one", async () => {
  const other = new Wallet(`0x${"99".repeat(32)}`).address.toLowerCase();
  const { app, events } = appWith({ entries: new Map([[`${other}:${DELEGATE.address.toLowerCase()}`, NOW_S + 86_400n]]) });
  const response = await post(app, await delegateHeaders());
  assert.equal((await response.json()).error.code, "METERING_DELEGATE_NOT_REGISTERED");
  assert.deepEqual(events, []);
});

test("a lapsed delegate is refused", async () => {
  const { app, events } = appWith({ entries: registered(NOW_S - 1n) });
  const response = await post(app, await delegateHeaders());
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "METERING_DELEGATE_NOT_REGISTERED");
  assert.deepEqual(events, []);
});

test("with no MeteringDelegates configured, a delegate-only request is refused by name", async () => {
  const { app, events } = appWith({ entries: registered(), delegates: false });
  const response = await post(app, await delegateHeaders());
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, "METERING_DELEGATE_UNSUPPORTED");
  assert.match(body.error.message, /METERING_DELEGATES_ADDRESS/);
  assert.deepEqual(events, []);
});

test("the delegate's timestamp is held to the same window as the Agent's", async () => {
  const { app, events } = appWith({ entries: registered() });
  const stale = await post(app, await delegateHeaders({ issuedAt: NOW - SIGNATURE_WINDOW_MS - 1 }));
  assert.equal((await stale.json()).error.code, "METERING_SIGNATURE_STALE");
  const future = await post(app, await delegateHeaders({ issuedAt: NOW + SIGNATURE_WINDOW_MS + 1 }));
  assert.equal((await future.json()).error.code, "METERING_SIGNATURE_STALE");
  const edge = await post(app, await delegateHeaders({ issuedAt: NOW - SIGNATURE_WINDOW_MS }));
  assert.equal(edge.status, 200, "inside the window at its edge");
  assert.deepEqual(events, ["metered"]);
});

test("a signature over a claim for a different Agent than Tab-Agent is refused", async () => {
  const { app, events } = appWith({ entries: registered() });
  const headers = await delegateHeaders();
  // The key signed for AGENT; the request names somebody else, so the digest recovers to a stranger.
  headers["Tab-Agent"] = new Wallet(`0x${"99".repeat(32)}`).address.toLowerCase();
  const response = await post(app, headers);
  assert.equal((await response.json()).error.code, "METERING_SIGNATURE_NOT_DELEGATE");
  assert.deepEqual(events, []);
});

test("an unreadable registry is a retryable upstream refusal, never an acceptance", async () => {
  const events = [];
  const app = createApp({
    serviceId: SERVICE,
    asset,
    operator: OPERATOR.address,
    tabBook: recordingClient(events),
    priceOf: () => ({ tool: TOOL, unitPrice: 10_000n }),
    now: () => NOW,
    meteringDelegates: createMeteringDelegateReader({
      address: REGISTRY,
      call: async () => {
        throw new Error("rpc down");
      },
      now: () => NOW,
    }),
  });
  const response = await post(app, await delegateHeaders());
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, "METERING_DELEGATE_UNREADABLE");
  assert.equal(body.error.retryable, true);
  assert.deepEqual(events, []);
});

test("the operator and Agent paths are unchanged with delegates configured, and take precedence", async () => {
  const { app, events, reads } = appWith({ entries: new Map() });

  const byOperator = await post(app, {
    "Tab-Agent": AGENT,
    [SIGNATURE_HEADER]: await OPERATOR.signMessage(meteringDigest(claim())),
    [ISSUED_AT_HEADER]: String(NOW),
  });
  assert.equal(byOperator.status, 200);

  const byAgent = await post(app, {
    "Tab-Agent": AGENT,
    [METERING_HEADER.agentSignature]: await AGENT_KEY.signMessage(meteringDigest(claim())),
    [METERING_HEADER.agentIssuedAt]: String(NOW),
  });
  assert.equal(byAgent.status, 200);

  // An Agent signature beside an unregistered delegate's: the Agent's is the one checked.
  const both = await post(app, {
    ...(await delegateHeaders({ signer: STRANGER })),
    [METERING_HEADER.agentSignature]: await AGENT_KEY.signMessage(meteringDigest(claim())),
    [METERING_HEADER.agentIssuedAt]: String(NOW),
  });
  assert.equal(both.status, 200);

  assert.deepEqual(events, ["metered", "metered", "metered"]);
  assert.deepEqual(reads, [], "neither path reads MeteringDelegates");

  const unsigned = await post(app, { "Tab-Agent": AGENT });
  const body = await unsigned.json();
  assert.equal(body.error.code, "METERING_SIGNATURE_ABSENT");
  assert.match(body.error.message, /Tab-Delegate-Signature/, "the refusal names the delegate option too");
});

test("the operator and Agent paths are unchanged with delegates unconfigured", async () => {
  const { app, events } = appWith({ delegates: false });
  const byAgent = await post(app, {
    "Tab-Agent": AGENT,
    [METERING_HEADER.agentSignature]: await AGENT_KEY.signMessage(meteringDigest(claim())),
    [METERING_HEADER.agentIssuedAt]: String(NOW),
  });
  assert.equal(byAgent.status, 200);
  const byOperator = await post(app, {
    "Tab-Agent": AGENT,
    [SIGNATURE_HEADER]: await OPERATOR.signMessage(meteringDigest(claim())),
    [ISSUED_AT_HEADER]: String(NOW),
  });
  assert.equal(byOperator.status, 200);
  assert.deepEqual(events, ["metered", "metered"]);
});

test("the root page says which signers this gateway accepts", async () => {
  const withDelegates = await (await appWith().app.request("/")).json();
  assert.ok(withDelegates.routes.some((route) => route.includes("a delegate the Agent registered")));
  const without = await (await appWith({ delegates: false }).app.request("/")).json();
  assert.ok(without.routes.some((route) => route === "/meter/:tool (signed by the operator or the Agent)"));
});

// ---------------------------------------------------------------- the reader's cache

test("by default nothing is held, so a revoked key is refused on the very next call", async () => {
  const entries = registered(NOW_S + 86_400n);
  const registry = fakeRegistry(entries, () => NOW);
  const reader = createMeteringDelegateReader({ address: REGISTRY, call: registry.call, now: () => NOW });
  assert.equal(DELEGATE_CACHE_MS, 0);
  assert.equal((await reader.isDelegate(AGENT, DELEGATE.address)).value, true);
  entries.clear();
  assert.equal((await reader.isDelegate(AGENT, DELEGATE.address)).value, false, "revoked, and refused at once");
  assert.equal(registry.reads.length, 4, "each answer came from the chain");
});

test("with a cache window, a positive answer is held for it and read again after it", async () => {
  let clock = NOW;
  const registry = fakeRegistry(registered(NOW_S + 86_400n), () => clock);
  const reader = createMeteringDelegateReader({ address: REGISTRY, call: registry.call, now: () => clock, cacheMs: WINDOW_MS });

  assert.deepEqual(await reader.isDelegate(AGENT, DELEGATE.address), { ok: true, value: true });
  assert.equal(registry.reads.length, 2);
  clock += WINDOW_MS - 1;
  assert.deepEqual(await reader.isDelegate(AGENT.toUpperCase().replace("0X", "0x"), DELEGATE.address.toLowerCase()), { ok: true, value: true });
  assert.equal(registry.reads.length, 2, "held, whatever the address casing");
  clock += 1;
  await reader.isDelegate(AGENT, DELEGATE.address);
  assert.equal(registry.reads.length, 4, "read again once the window passed");
});

test("a positive answer is never held past the delegation's own expiry", async () => {
  let clock = NOW;
  const expiry = NOW_S + 10n;
  const registry = fakeRegistry(registered(expiry), () => clock);
  const reader = createMeteringDelegateReader({ address: REGISTRY, call: registry.call, now: () => clock, cacheMs: WINDOW_MS });

  assert.equal((await reader.isDelegate(AGENT, DELEGATE.address)).value, true);
  clock = NOW + 9_999;
  assert.equal((await reader.isDelegate(AGENT, DELEGATE.address)).value, true, "held until the expiry");
  assert.equal(registry.reads.length, 2);
  clock = NOW + 10_000;
  assert.equal((await reader.isDelegate(AGENT, DELEGATE.address)).value, false, "lapsed at the expiry to the millisecond");
  assert.equal(registry.reads.length, 4, "the lapsed answer came from the chain, not the cache");
});

test("a negative answer is never held, so a key registered a moment ago is accepted at once", async () => {
  const entries = new Map();
  const registry = fakeRegistry(entries, () => NOW);
  const reader = createMeteringDelegateReader({ address: REGISTRY, call: registry.call, now: () => NOW });
  assert.equal((await reader.isDelegate(AGENT, DELEGATE.address)).value, false);
  entries.set(`${AGENT}:${DELEGATE.address.toLowerCase()}`, NOW_S + 60n);
  assert.equal((await reader.isDelegate(AGENT, DELEGATE.address)).value, true);
});
