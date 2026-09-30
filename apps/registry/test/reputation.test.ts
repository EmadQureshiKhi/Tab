/**
 * The Reputation registry reads, without a chain and without a database.
 *
 * `EthersErc8004ChainReader` is driven through a provider that answers the
 * registry's own ABI, so the calldata it builds is the calldata the contract
 * would receive: the client list intersected with `getClients`, the tags passed
 * through, and no `getSummary` at all when the intersection is empty, because
 * the registry reverts on an empty list. `cachedErc8004Reader` is driven with
 * an injected clock.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface, type JsonRpcProvider } from "ethers";
import { ERC8004_REPUTATION_REGISTRY_ABI } from "@tabai/shared";

import { EthersErc8004ChainReader, cachedErc8004Reader, type Erc8004ChainReader } from "../src/chain-reads.js";
import type { ReputationSummary } from "../src/erc8004.js";

const REPUTATION = "0x8004b663056a597dffe9eccc1965a193b7388713";
const IDENTITY = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const SERVICE_OPERATOR = `0x${"0a".repeat(20)}`;
const OTHER_CLIENT = `0x${"0c".repeat(20)}`;
const NOT_A_CLIENT = `0x${"0d".repeat(20)}`;
const registry = new Interface(ERC8004_REPUTATION_REGISTRY_ABI);

/** A provider that answers `getClients` and `getSummary` and records what `getSummary` was asked. */
function fakeProvider(clients: readonly string[]) {
  const summaries: unknown[][] = [];
  const provider = {
    async call(tx: { to: string; data: string }): Promise<string> {
      assert.equal(tx.to, REPUTATION);
      const parsed = registry.parseTransaction({ data: tx.data });
      if (parsed?.name === "getClients") return registry.encodeFunctionResult("getClients", [clients]);
      if (parsed?.name === "getSummary") {
        summaries.push([...parsed.args].map((value) => (Array.isArray(value) ? [...value] : value)));
        return registry.encodeFunctionResult("getSummary", [3n, 100n, 0]);
      }
      throw new Error(`unexpected call ${parsed?.name ?? tx.data.slice(0, 10)}`);
    },
  };
  return { provider: provider as unknown as JsonRpcProvider, summaries };
}

test("the unfiltered summary spans every client the registry lists, with no tag", async () => {
  const chain = fakeProvider([SERVICE_OPERATOR, OTHER_CLIENT]);
  const reader = new EthersErc8004ChainReader(chain.provider, IDENTITY, REPUTATION);
  const summary = await reader.reputationSummary(7n);
  assert.deepEqual(summary, { clientCount: 2, clients: [SERVICE_OPERATOR, OTHER_CLIENT], count: 3, summaryValue: 100n, summaryValueDecimals: 0 });
  assert.equal(chain.summaries.length, 1);
  const [agentId, clients, tag1, tag2] = chain.summaries[0]!;
  assert.equal(agentId, 7n);
  assert.deepEqual((clients as string[]).map((client) => client.toLowerCase()), [SERVICE_OPERATOR, OTHER_CLIENT]);
  assert.equal(tag1, "");
  assert.equal(tag2, "");
});

test("a filtered summary asks only the named clients that gave feedback, under the named tags", async () => {
  const chain = fakeProvider([SERVICE_OPERATOR, OTHER_CLIENT]);
  const reader = new EthersErc8004ChainReader(chain.provider, IDENTITY, REPUTATION);
  const summary = await reader.reputationSummary(7n, {
    clients: [SERVICE_OPERATOR.toUpperCase().replace("0X", "0x"), NOT_A_CLIENT],
    tag1: "tab",
    tag2: "settled",
  });
  assert.equal(summary?.clientCount, 1);
  assert.deepEqual(summary?.clients, [SERVICE_OPERATOR]);
  assert.equal(chain.summaries.length, 1);
  const [agentId, clients, tag1, tag2] = chain.summaries[0]!;
  assert.equal(agentId, 7n);
  assert.deepEqual((clients as string[]).map((client) => client.toLowerCase()), [SERVICE_OPERATOR]);
  assert.equal(tag1, "tab");
  assert.equal(tag2, "settled");
});

test("a filter no client matches is a zero summary, and getSummary is never asked", async () => {
  const chain = fakeProvider([OTHER_CLIENT]);
  const reader = new EthersErc8004ChainReader(chain.provider, IDENTITY, REPUTATION);
  const summary = await reader.reputationSummary(7n, { clients: [SERVICE_OPERATOR], tag1: "tab", tag2: "settled" });
  assert.deepEqual(summary, { clientCount: 0, clients: [], count: 0, summaryValue: 0n, summaryValueDecimals: 0 });
  assert.equal(chain.summaries.length, 0);
});

test("no Reputation registry is null, not a zero", async () => {
  const chain = fakeProvider([]);
  const reader = new EthersErc8004ChainReader(chain.provider, IDENTITY, null);
  assert.equal(await reader.reputationSummary(7n), null);
});

test("the cache serves a summary for its lifetime, keys it by filter, and repeats a failure only briefly", async () => {
  let clock = 1_000_000;
  let calls = 0;
  let failNext = false;
  const summary: ReputationSummary = { clientCount: 1, clients: [SERVICE_OPERATOR], count: 1, summaryValue: 100n, summaryValueDecimals: 0 };
  const inner: Erc8004ChainReader = {
    tokenURI: async () => "ipfs://card",
    reputationSummary: async () => {
      calls += 1;
      if (failNext) throw new Error("rpc down");
      return summary;
    },
  };
  const cached = cachedErc8004Reader(inner, { ttlMs: 30_000, failureTtlMs: 10_000, now: () => clock });
  const filter = { clients: [SERVICE_OPERATOR], tag1: "tab", tag2: "settled" };

  // Two readers in flight share one read.
  const [first, second] = await Promise.all([cached.reputationSummary(7n, filter), cached.reputationSummary(7n, filter)]);
  assert.equal(first, summary);
  assert.equal(second, summary);
  assert.equal(calls, 1);

  // A different filter, or none, is a different question.
  await cached.reputationSummary(7n);
  assert.equal(calls, 2);
  // The same clients in another order and case are the same question.
  await cached.reputationSummary(7n, { ...filter, clients: [SERVICE_OPERATOR.toUpperCase().replace("0X", "0x")] });
  assert.equal(calls, 2);

  clock += 30_001;
  failNext = true;
  await assert.rejects(cached.reputationSummary(7n, filter), /rpc down/);
  assert.equal(calls, 3);
  // Within the failure window the failure is served, not retried.
  await assert.rejects(cached.reputationSummary(7n, filter), /rpc down/);
  assert.equal(calls, 3);
  clock += 10_001;
  failNext = false;
  assert.equal(await cached.reputationSummary(7n, filter), summary);
  assert.equal(calls, 4);
});
