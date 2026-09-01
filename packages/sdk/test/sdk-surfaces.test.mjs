/**
 * Task 15.6: the six SDK surface assertions, in one place.
 *
 * Four of the six are already asserted where the surface lives, and are named
 * here rather than duplicated, so a change to one of them fails exactly one
 * test file:
 *
 * - strategy resolution order: `strategy-registry.test.mjs`, "resolution takes
 *   an explicit id first, then registration order";
 * - the duplicate-id replacement warning: `strategy-registry.test.mjs`,
 *   "module-level registration is idempotent by id and replacement keeps the
 *   earlier position", which counts the warn line;
 * - the 402 repeat path: `client-402.test.mjs`, "a 402 records the required
 *   amount, repeats exactly once, and settles nothing";
 * - post-paid accrual after the handler: `post-paid.test.mjs`, "the handler runs
 *   to completion before anything is metered";
 * - hook ordering: `proxy.test.mjs`;
 * - proof-hook attachment: `proof-hook.test.mjs`.
 *
 * What this file adds is the one assertion none of them can make alone: the
 * whole seam in one run. A strategy settles and hands back a hint, the Service
 * records the hint, the proxy forwards a metered request, and the proof hook
 * recognises the recorded Settlement the hint announced.
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { packReplayKey } from "@tabai/shared";
import { TAB_HEADER, parseChargeHeaders } from "../dist/http/index.js";
import { createEthereumUsdcStrategy, createStrategyRegistry } from "../dist/payments/index.js";
import { tabPostPaid } from "../dist/server/index.js";
import {
  createAttestcoinProofHook,
  createFakeSettlementVerifierClient,
  createSettlementHintStore,
  createTabProxy,
} from "../dist/proxy/index.js";

const AGENT = "0x00000000000000000000000000000000000000a1";
const PAYER = "0xa302940db97345c5adaf8da23ff46ae63613d728";
const COLLECTION = "0x952acc70e6f54ce87dca963193a5957bcb27729e";
const SERVICE_ID = `0x${"11".repeat(32)}`;
const TOOL = `0x${"22".repeat(32)}`;
const TAB_ID = `0x${"33".repeat(32)}`;
const USDC = { chainKey: 3n, address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, symbol: "USDC" };
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * Renders a `Result` for an assertion message.
 *
 * An assertion message is evaluated eagerly, whether or not the assertion
 * fails, and `JSON.stringify` throws on a `bigint`. Every settlement amount and
 * coordinate here is one, so a bare `JSON.stringify` fails the test it was
 * written to explain. Bigints render with an `n` suffix, so a reader can tell
 * `5n` from a string carrying digits.
 */
const explain = (result) =>
  JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? `${value}n` : value));

/** A signer that answers a transfer with a receipt and never touches a chain. */
function fakeSigner() {
  return {
    async getAddress() {
      return PAYER;
    },
    async sendTransaction() {
      return {
        hash: `0x${"ee".repeat(32)}`,
        async wait() {
          return { status: 1, hash: `0x${"ee".repeat(32)}` };
        },
      };
    },
    provider: {
      async call() {
        return `0x${"ff".repeat(32)}`;
      },
    },
  };
}

test("the seam end to end: strategy, hint, metered proxy, and the proof hook recognising the Settlement", async () => {
  // 1. The Agent settles through the strategy seam (R23.1, R23.6) and gets a hint.
  const registry = createStrategyRegistry({ logger: silent });
  const strategy = createEthereumUsdcStrategy({ signer: fakeSigner(), assets: { [`3:${USDC.address}`]: USDC } });
  registry.register(strategy);
  const resolved = registry.resolve({ asset: USDC });
  assert.ok(resolved.ok);
  assert.equal(resolved.value.id, strategy.id);

  const settled = await resolved.value.settle({
    agent: AGENT,
    serviceId: SERVICE_ID,
    asset: USDC,
    amount: 5_000_000n,
    collectionAddress: COLLECTION,
    tabId: TAB_ID,
    mode: "direct-transfer",
  });
  assert.ok(settled.ok, explain(settled));
  const hint = resolved.value.watchHint(settled.value);
  assert.equal(hint.chainKey, 3n);
  assert.equal(hint.amount, 5_000_000n);

  // 2. The Service records the hint against the Agent.
  const hints = createSettlementHintStore();
  hints.add(AGENT, hint);

  // 3. The Watcher proves the Settlement and the verifier records it. Simulated
  //    by the fake client carrying what SettlementRecorded would carry.
  const position = { chainKey: 3n, blockHeight: 25_900_001n, txIndex: 7n, logIndex: 2n };
  const verifier = createFakeSettlementVerifierClient([
    {
      replayKey: packReplayKey(position),
      ...position,
      agent: AGENT,
      serviceId: SERVICE_ID,
      asset: USDC.address,
      amount: 5_000_000n,
      payerAddress: PAYER,
      sourceTabId: `0x${"00".repeat(32)}`,
      creditcoin: { blockNumber: 5_500_000, txHash: `0x${"cc".repeat(32)}`, logIndex: 0 },
    },
  ]);

  // 4. A metered request goes through the proxy (R23.3, R23.4) and the hook attaches the Settlement (R23.5).
  const deliveries = [];
  const metering = tabPostPaid({
    serviceId: SERVICE_ID,
    asset: USDC,
    tabBook: {
      async recordDelivery(delivery) {
        deliveries.push(delivery);
        return { ok: true, value: { charged: 1_000_000n, openAfter: 1_000_000n, headroomAfter: 4_000_000n, recordedAt: 1 } };
      },
      async openTabOf() {
        return { ok: true, value: 0n };
      },
    },
    priceOf: () => ({ tool: TOOL, units: 1, unitPrice: 1_000_000n }),
    logger: silent,
  });
  const verified = [];
  const proxy = createTabProxy({
    upstream: "https://upstream.example",
    hooks: [createAttestcoinProofHook({ verifier, hints, minRefreshMs: 0, logger: silent, onVerified: (view) => verified.push(view) })],
    metering,
    fetchImpl: async () => new Response("summary", { status: 200 }),
    logger: silent,
  });

  const result = await proxy.proxy(
    new Request("https://service.example/v1/summarise", { method: "POST", headers: { [TAB_HEADER.agent]: AGENT }, body: "text" }),
  );

  assert.equal(result.kind, "delivered");
  assert.equal(await result.response.text(), "summary");
  assert.equal(deliveries.length, 1, "the delivery was recorded after the upstream answered");
  const block = parseChargeHeaders(result.response.headers);
  assert.ok(block.ok && block.value !== undefined);
  assert.equal(block.value.amount, 1_000_000n);
  assert.ok(result.settlement, "the Verified Settlement the hint announced is attached");
  assert.equal(result.settlement.replayKey, packReplayKey(position));
  assert.equal(result.settlement.payerAddress, PAYER);
  assert.match(result.settlement.blockscoutUrl, /\/tx\/0xcc/);
  assert.equal(verified.length, 1);
  assert.deepEqual(hints.open(AGENT), [], "the hint is retired once the chain confirmed it");
});
