/**
 * ERC-8004 reputation: one feedback entry per Settlement, written by the
 * Service, counted rather than remembered, and pointing at a document whose
 * bytes are what the entry's hash commits to.
 *
 * The registry read API and the chain are both fakes that answer the shapes
 * the real ones do: the registry's `/settlements`, `/settlements/:id` and
 * `/agents/:agent/reputation`, and the Reputation registry's own ABI for
 * `readAllFeedback` and `giveFeedback`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { ERC8004_REPUTATION_REGISTRY_ABI } from "@tabai/shared";

import {
  REPUTATION_GAS_FLOOR,
  REPUTATION_GAS_LIMIT,
  chooseAgentId,
  createFeedbackDocuments,
  createReputationWriter,
  encodeGiveFeedback,
  feedbackDocument,
  feedbackHashOf,
  feedbackUriOf,
  loadReputationConfig,
  settlementFromBody,
} from "../dist/reputation.js";
import { createApp } from "../dist/server.js";

const registryAbi = new Interface(ERC8004_REPUTATION_REGISTRY_ABI);
const REPUTATION = "0x8004b663056a597dffe9eccc1965a193b7388713";
const REGISTRY_URL = "http://registry.test";
const PUBLIC_URL = "https://gateway.test";
const SERVICE_ID = "0x7461622e64656d6f000000000000000000000000000000000000000000000000";
const OTHER_SERVICE = `0x${"5e".repeat(32)}`;
const USDC = "0x534b2f3a21130d7a60830c2df862319e593943a3";
const OPERATOR = new Wallet(`0x${"22".repeat(32)}`);
const AGENT_A = `0x${"aa".repeat(20)}`;
const AGENT_B = `0x${"bb".repeat(20)}`;
const BLOCK_TIME = 1_790_000_000n;

const idOf = (n) => `0x${"5d".repeat(31)}${n.toString(16).padStart(2, "0")}`;

/** A registry Settlement row, as `GET /settlements` serves it. */
function row(n, agent, { blockNumber = 1_000 + n, logIndex = 0, serviceId = SERVICE_ID } = {}) {
  return {
    settlementId: idOf(n),
    agent,
    serviceId,
    asset: USDC,
    amount: `${n}0000`,
    applied: `${n}0000`,
    toPrepaid: "0",
    collection: `0x${"c1".repeat(20)}`,
    openAfter: "0",
    monad: { blockNumber, blockHash: `0x${"bb".repeat(32)}`, logIndex, txHash: `0x${n.toString(16).padStart(64, "e")}`, txIndex: 0, blockTime: null },
  };
}

/** The registry read API, newest first and paged as the real one pages. */
function fakeRegistry({ settlements = [], identities = {}, down = false, pageSize = 2 } = {}) {
  const requests = [];
  const newestFirst = () => [...settlements].sort((a, b) => b.monad.blockNumber - a.monad.blockNumber || b.monad.logIndex - a.monad.logIndex);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    if (down) throw new Error("connect ECONNREFUSED");
    if (url.pathname === "/settlements") {
      const all = newestFirst().filter((entry) => entry.serviceId === url.searchParams.get("serviceId"));
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const page = all.slice(start, start + pageSize);
      return json({ index: {}, settlements: page, nextCursor: start + pageSize < all.length ? String(start + pageSize) : null });
    }
    const one = /^\/settlements\/(0x[0-9a-f]{64})$/.exec(url.pathname);
    if (one !== null) {
      const found = settlements.find((entry) => entry.settlementId === one[1]);
      return found === undefined ? json({ error: { code: "SETTLEMENT_NOT_INDEXED" } }, 404) : json({ index: {}, settlement: found });
    }
    const reputation = /^\/agents\/(0x[0-9a-f]{40})\/reputation$/.exec(url.pathname);
    if (reputation !== null) {
      return json({ index: {}, agent: reputation[1], reputation: { identityRegistry: "0x", reputationRegistry: REPUTATION, basis: "", agents: identities[reputation[1]] ?? [] } });
    }
    return json({ error: {} }, 404);
  };
  return { fetchImpl, requests, settlements };
}

/**
 * The chain: `readAllFeedback` counts what this fake has recorded, `giveFeedback`
 * simulations can be refused, and every sent write is recorded and mined.
 */
function fakeChain({ existing = {}, refuse, receipt = "mined", estimate = 280_000n } = {}) {
  const sent = [];
  const recorded = { ...existing };
  let pendingReceipt = receipt;
  const provider = {
    async call(tx) {
      const parsed = registryAbi.parseTransaction({ data: tx.data });
      if (parsed.name === "readAllFeedback") {
        const agentId = parsed.args[0].toString();
        const count = recorded[agentId] ?? 0;
        return registryAbi.encodeFunctionResult("readAllFeedback", [
          Array(count).fill(OPERATOR.address),
          Array.from({ length: count }, (_, i) => BigInt(i + 1)),
          Array(count).fill(100n),
          Array(count).fill(0),
          Array(count).fill("tab"),
          Array(count).fill("settled"),
          Array(count).fill(false),
        ]);
      }
      if (parsed.name === "giveFeedback") {
        assert.equal(tx.from.toLowerCase(), OPERATOR.address.toLowerCase(), "simulated from the operator");
        if (refuse !== undefined) throw Object.assign(new Error("execution reverted"), { reason: refuse });
        return "0x";
      }
      throw new Error(`unexpected call ${parsed.name}`);
    },
    async estimateGas() {
      return estimate;
    },
    async getBlock(blockNumber) {
      return { number: blockNumber, timestamp: Number(BLOCK_TIME) + blockNumber };
    },
    async waitForTransaction(hash) {
      if (pendingReceipt === "pending") return null;
      const tx = sent.find((entry) => entry.hash === hash);
      const parsed = registryAbi.parseTransaction({ data: tx.data });
      const agentId = parsed.args[0].toString();
      recorded[agentId] = (recorded[agentId] ?? 0) + 1;
      return { status: 1, gasUsed: 200_000n };
    },
    async getTransactionReceipt(hash) {
      if (pendingReceipt === "pending") return null;
      return { status: 1, hash };
    },
  };
  const signer = {
    async getAddress() {
      return OPERATOR.address;
    },
    async sendTransaction(tx) {
      const hash = `0x${(sent.length + 1).toString(16).padStart(64, "f")}`;
      sent.push({ ...tx, hash });
      return { hash };
    },
  };
  return {
    provider,
    signer,
    sent,
    recorded,
    mine() {
      pendingReceipt = "mined";
    },
    land(hash) {
      const tx = sent.find((entry) => entry.hash === hash);
      const agentId = registryAbi.parseTransaction({ data: tx.data }).args[0].toString();
      recorded[agentId] = (recorded[agentId] ?? 0) + 1;
    },
  };
}

function writerFor(registry, chain, extra = {}) {
  const logs = [];
  const documents = createFeedbackDocuments({ provider: chain.provider, chainId: 10143, serviceId: SERVICE_ID, registryUrl: REGISTRY_URL, fetchImpl: registry.fetchImpl });
  const writer = createReputationWriter({
    provider: chain.provider,
    signer: chain.signer,
    documents,
    reputationRegistry: REPUTATION,
    serviceId: SERVICE_ID,
    registryUrl: REGISTRY_URL,
    publicUrl: PUBLIC_URL,
    fetchImpl: registry.fetchImpl,
    logger: { info: (message) => logs.push(["info", message]), warn: (message) => logs.push(["warn", message]) },
    ...extra,
  });
  return { writer, documents, logs };
}

const decodeSent = (tx) => registryAbi.parseTransaction({ data: tx.data }).args;

// ------------------------------------------------------------------ pure parts

test("the document is a fixed function of the Settlement, and its hash is keccak of its bytes", () => {
  const settlement = settlementFromBody(row(1, AGENT_A));
  const first = feedbackDocument(10143, settlement, BLOCK_TIME);
  assert.equal(first, feedbackDocument(10143, { ...settlement }, BLOCK_TIME), "the same Settlement, the same bytes");
  const parsed = JSON.parse(first);
  assert.deepEqual(Object.keys(parsed), ["type", "version", "chainId", "value", "valueDecimals", "tag1", "tag2", "meaning", "settlement"]);
  assert.equal(parsed.value, 100);
  assert.equal(parsed.tag1, "tab");
  assert.equal(parsed.tag2, "settled");
  assert.match(parsed.meaning, /Credit Limit never reads it/);
  assert.equal(parsed.settlement.settlementId, idOf(1));
  assert.equal(parsed.settlement.amount, "10000");
  assert.equal(parsed.settlement.settledAt, new Date(Number(BLOCK_TIME) * 1000).toISOString());
  assert.equal(parsed.settlement.txHash, row(1, AGENT_A).monad.txHash);
  assert.equal(feedbackHashOf(first), keccak256(toUtf8Bytes(first)));
  assert.equal(feedbackUriOf(`${PUBLIC_URL}/`, idOf(1).toUpperCase().replace("0X", "0x")), `${PUBLIC_URL}/reputation/${idOf(1)}`);
});

test("the calldata is giveFeedback with the fixed value, the two tags, and the document's URI and hash", () => {
  const data = encodeGiveFeedback({ agentId: 1914n, endpoint: PUBLIC_URL, feedbackURI: `${PUBLIC_URL}/reputation/${idOf(1)}`, feedbackHash: `0x${"12".repeat(32)}` });
  assert.equal(data.slice(0, 10), "0x3c036a7e");
  const args = registryAbi.decodeFunctionData("giveFeedback", data);
  assert.deepEqual([...args], [1914n, 100n, 0n, "tab", "settled", PUBLIC_URL, `${PUBLIC_URL}/reputation/${idOf(1)}`, `0x${"12".repeat(32)}`]);
});

test("feedback about an address goes to the agent it acts for, then one it owns, lowest id first", () => {
  assert.equal(chooseAgentId([]), undefined);
  assert.equal(chooseAgentId([{ agentId: "9", matchedBy: ["owner"] }, { agentId: "12", matchedBy: ["agentWallet"] }, { agentId: "7", matchedBy: ["agentWallet"] }]), 7n);
  assert.equal(chooseAgentId([{ agentId: "9", matchedBy: ["owner"] }, { agentId: "3", matchedBy: ["owner"] }]), 3n);
  assert.equal(chooseAgentId([{ agentId: "x", matchedBy: ["agentWallet"] }]), undefined);
});

test("a registry row of the wrong shape is refused rather than guessed at", () => {
  assert.equal(settlementFromBody(null), undefined);
  assert.equal(settlementFromBody({ ...row(1, AGENT_A), amount: 5 }), undefined);
  assert.equal(settlementFromBody({ ...row(1, AGENT_A), monad: { ...row(1, AGENT_A).monad, blockNumber: "7" } }), undefined);
  assert.equal(settlementFromBody(row(1, AGENT_A.toUpperCase().replace("0X", "0x"))).agent, AGENT_A);
});

test("the writer is off by default, and on it names what it is missing", () => {
  assert.deepEqual(loadReputationConfig({}, 10143), { ok: true, value: { enabled: false } });
  assert.deepEqual(loadReputationConfig({ GATEWAY_REPUTATION_ENABLED: "yes" }, 10143), { ok: true, value: { enabled: false } });

  const noUrl = loadReputationConfig({ GATEWAY_REPUTATION_ENABLED: "true" }, 10143);
  assert.equal(noUrl.ok, false);
  assert.equal(noUrl.error.details.variable, "GATEWAY_PUBLIC_URL");

  const on = loadReputationConfig({ GATEWAY_REPUTATION_ENABLED: "true", GATEWAY_PUBLIC_URL: `${PUBLIC_URL}/` }, 10143);
  assert.deepEqual(on, { ok: true, value: { enabled: true, publicUrl: PUBLIC_URL, reputationRegistry: REPUTATION, intervalMs: 60_000 } });
  const mainnet = loadReputationConfig({ GATEWAY_REPUTATION_ENABLED: "true", GATEWAY_PUBLIC_URL: PUBLIC_URL }, 143);
  assert.equal(mainnet.value.reputationRegistry, "0x8004baa17c55a88189ae136b182e5fda19de9b63");

  const override = loadReputationConfig({ GATEWAY_REPUTATION_ENABLED: "true", GATEWAY_PUBLIC_URL: PUBLIC_URL, ERC8004_REPUTATION_REGISTRY_ADDRESS: `0x${"AB".repeat(20)}` }, 1);
  assert.equal(override.value.reputationRegistry, `0x${"ab".repeat(20)}`);
  const unknownChain = loadReputationConfig({ GATEWAY_REPUTATION_ENABLED: "true", GATEWAY_PUBLIC_URL: PUBLIC_URL }, 1);
  assert.equal(unknownChain.ok, false);
  const zero = loadReputationConfig({ GATEWAY_REPUTATION_ENABLED: "true", GATEWAY_PUBLIC_URL: PUBLIC_URL, ERC8004_REPUTATION_REGISTRY_ADDRESS: `0x${"0".repeat(40)}` }, 10143);
  assert.equal(zero.ok, false);
  const fast = loadReputationConfig({ GATEWAY_REPUTATION_ENABLED: "true", GATEWAY_PUBLIC_URL: PUBLIC_URL, GATEWAY_REPUTATION_INTERVAL_MS: "100" }, 10143);
  assert.equal(fast.error.details.variable, "GATEWAY_REPUTATION_INTERVAL_MS");
});

// ------------------------------------------------------------------ the writer

test("each Settlement not yet rated gets one entry, oldest first, and the hash matches the served document", async () => {
  const registry = fakeRegistry({
    settlements: [row(1, AGENT_A), row(2, AGENT_B), row(3, AGENT_A), row(4, AGENT_A), row(5, AGENT_A, { serviceId: OTHER_SERVICE })],
    identities: { [AGENT_A]: [{ agentId: "42", matchedBy: ["agentWallet"] }, { agentId: "40", matchedBy: ["owner"] }] },
  });
  // One entry already on chain from an earlier run: Settlement 1's.
  const chain = fakeChain({ existing: { 42: 1 } });
  const { writer, documents, logs } = writerFor(registry, chain);

  const report = await writer.tick();
  assert.equal(report.ran, true);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.written.map((entry) => [entry.agentId, entry.settlementId]), [["42", idOf(3)], ["42", idOf(4)]]);
  assert.deepEqual(report.skipped, [{ agent: AGENT_B, reason: "no ERC-8004 identity" }]);
  assert.equal(chain.sent.length, 2);

  for (const [position, n] of [[0, 3], [1, 4]]) {
    const tx = chain.sent[position];
    assert.equal(tx.to, REPUTATION);
    // Estimated and padded: 280,000 plus 30%.
    assert.equal(tx.gasLimit, 364_000n);
    const [agentId, value, decimals, tag1, tag2, endpoint, uri, hash] = decodeSent(tx);
    assert.deepEqual([agentId, value, decimals, tag1, tag2, endpoint], [42n, 100n, 0n, "tab", "settled", PUBLIC_URL]);
    assert.equal(uri, `${PUBLIC_URL}/reputation/${idOf(n)}`);
    const served = await documents.document(idOf(n));
    assert.equal(hash, keccak256(toUtf8Bytes(served.value)), "the hash on chain is the hash of what the URI serves");
  }
  assert.ok(logs.some(([level, message]) => level === "info" && message.includes(`for Settlement ${idOf(4)} in 0x`)));
  assert.ok(logs.some(([, message]) => message.includes(`${AGENT_B} holds no ERC-8004 identity`)));

  // Nothing new, nothing written, and the page walk stops at what it already has.
  const before = registry.requests.length;
  const again = await writer.tick();
  assert.deepEqual(again.written, []);
  assert.equal(chain.sent.length, 2);
  assert.equal(registry.requests.length - before, 1, "one page read, no identity reads, no writes");

  // A new Settlement lands and is rated on the next tick.
  registry.settlements.push(row(6, AGENT_A));
  const third = await writer.tick();
  assert.deepEqual(third.written.map((entry) => entry.settlementId), [idOf(6)]);
});

test("a restarted writer counts what is on chain and writes nothing twice", async () => {
  const registry = fakeRegistry({
    settlements: [row(1, AGENT_A), row(2, AGENT_A)],
    identities: { [AGENT_A]: [{ agentId: "42", matchedBy: ["owner"] }] },
  });
  const chain = fakeChain();
  await writerFor(registry, chain).writer.tick();
  assert.equal(chain.sent.length, 2);

  const restarted = writerFor(registry, chain).writer;
  const report = await restarted.tick();
  assert.deepEqual(report.written, []);
  assert.equal(chain.sent.length, 2);
});

test("an agent owned by the operator is refused by the registry, skipped for free, and said once", async () => {
  const registry = fakeRegistry({
    settlements: [row(1, AGENT_A), row(2, AGENT_A)],
    identities: { [AGENT_A]: [{ agentId: "1914", matchedBy: ["owner"] }] },
  });
  const chain = fakeChain({ refuse: "Self-feedback not allowed" });
  const { writer, logs } = writerFor(registry, chain, { recheckEveryTicks: 1 });

  const report = await writer.tick();
  assert.equal(chain.sent.length, 0, "nothing is sent for a refusal the simulation already read");
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].reason, /Self-feedback not allowed/);
  assert.match(report.skipped[0].reason, /transferring agent 1914 to the Agent's key/);
  await writer.tick();
  assert.equal(logs.filter(([level, message]) => level === "warn" && message.includes("Self-feedback")).length, 1);
});

test("a write with no receipt yet holds the agent until it is mined, then carries on from the count", async () => {
  const registry = fakeRegistry({
    settlements: [row(1, AGENT_A), row(2, AGENT_A)],
    identities: { [AGENT_A]: [{ agentId: "42", matchedBy: ["agentWallet"] }] },
  });
  const chain = fakeChain({ receipt: "pending" });
  const { writer } = writerFor(registry, chain, { receiptWaitMs: 1 });

  const first = await writer.tick();
  assert.equal(chain.sent.length, 1, "it stops at the first write it cannot confirm");
  assert.equal(first.failures[0].code, "FEEDBACK_UNCONFIRMED");

  const held = await writer.tick();
  assert.equal(chain.sent.length, 1, "nothing more while the earlier write is unmined");
  assert.match(held.skipped[0].reason, /is not mined yet/);

  // It lands; the count now includes it, and only the second Settlement remains.
  chain.land(chain.sent[0].hash);
  chain.mine();
  const resumed = await writer.tick();
  assert.deepEqual(resumed.written.map((entry) => entry.settlementId), [idOf(2)]);
  assert.equal(chain.sent.length, 2);
});

test("a dry run simulates every missing entry and sends nothing", async () => {
  const registry = fakeRegistry({
    settlements: [row(1, AGENT_A), row(2, AGENT_A), row(3, AGENT_A)],
    identities: { [AGENT_A]: [{ agentId: "42", matchedBy: ["agentWallet"] }] },
  });
  const chain = fakeChain({ estimate: 50_000n });
  const { writer, logs } = writerFor(registry, chain, { dryRun: true });
  const report = await writer.tick();
  assert.equal(chain.sent.length, 0);
  assert.deepEqual(report.written.map((entry) => entry.settlementId), [idOf(1), idOf(2), idOf(3)]);
  assert.equal(report.written[0].txHash, undefined);
  assert.equal(report.written[0].gasLimit, REPUTATION_GAS_FLOOR.toString(), "a small estimate is raised to the floor");
  assert.ok(logs.every(([, message]) => !message.includes("wrote feedback")));
});

test("an unreadable registry is a logged failure on that tick, never a throw", async () => {
  const chain = fakeChain();
  const { writer, logs } = writerFor(fakeRegistry({ down: true }), chain);
  const report = await writer.tick();
  assert.equal(report.ran, true);
  assert.equal(report.failures[0].code, "REGISTRY_READ_FAILED");
  assert.equal(chain.sent.length, 0);
  assert.ok(logs.some(([level]) => level === "warn"));
});

test("an estimate that fails states the ceiling", async () => {
  const registry = fakeRegistry({ settlements: [row(1, AGENT_A)], identities: { [AGENT_A]: [{ agentId: "42", matchedBy: ["owner"] }] } });
  const chain = fakeChain();
  chain.provider.estimateGas = async () => {
    throw new Error("estimate unavailable");
  };
  await writerFor(registry, chain).writer.tick();
  assert.equal(chain.sent[0].gasLimit, REPUTATION_GAS_LIMIT);
});

// ------------------------------------------------------------------ the route

test("the gateway serves the document at /reputation/:settlementId, for its own Settlements only", async () => {
  const registry = fakeRegistry({ settlements: [row(1, AGENT_A), row(5, AGENT_A, { serviceId: OTHER_SERVICE })] });
  const chain = fakeChain();
  const documents = createFeedbackDocuments({ provider: chain.provider, chainId: 10143, serviceId: SERVICE_ID, registryUrl: REGISTRY_URL, fetchImpl: registry.fetchImpl });
  const base = {
    serviceId: SERVICE_ID,
    asset: { chainId: 10143n, address: USDC, decimals: 6, symbol: "USDC" },
    operator: OPERATOR.address,
    tabBook: { simulateDelivery: async () => ({ ok: true, value: {} }), recordDelivery: async () => ({ ok: true, value: {} }), openTabOf: async () => ({ ok: true, value: 0n }), creditLimit: async () => ({ ok: true, value: 0n }) },
    priceOf: () => undefined,
    requireSignature: false,
  };
  const app = createApp({ ...base, feedbackDocuments: documents });

  const served = await app.request(`/reputation/${idOf(1)}`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get("content-type"), /application\/json/);
  const text = await served.text();
  assert.equal(text, feedbackDocument(10143, settlementFromBody(row(1, AGENT_A)), BLOCK_TIME + 1_001n));

  assert.equal((await app.request(`/reputation/${idOf(5)}`)).status, 404, "another Service's Settlement");
  assert.equal((await app.request(`/reputation/${idOf(9)}`)).status, 404, "a Settlement the registry never indexed");
  assert.equal((await app.request("/reputation/0x1234")).status, 400);
  assert.equal((await createApp(base).request(`/reputation/${idOf(1)}`)).status, 404, "no documents configured");

  const root = await (await app.request("/")).json();
  assert.ok(root.routes.some((route) => route.startsWith("/reputation/:settlementId")));
});
