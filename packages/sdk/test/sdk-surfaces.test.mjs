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
 * - hook ordering: `proxy.test.mjs`.
 *
 * What this file adds is the one assertion none of them can make alone: the
 * whole seam in one run. A strategy settles on Monad and reads the `Settled`
 * event off the receipt, the proxy forwards a metered request, and a hook
 * attaches that Settlement to the delivery.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder, Interface, keccak256, toUtf8Bytes } from "ethers";
import { TAB_HEADER, parseChargeHeaders } from "../dist/http/index.js";
import { TAB_SETTLEMENT_ABI, createMonadStrategy, createStrategyRegistry } from "../dist/payments/index.js";
import { tabPostPaid } from "../dist/server/index.js";
import { createTabProxy } from "../dist/proxy/index.js";

const AGENT = "0x00000000000000000000000000000000000000a1";
const PAYER = "0xa302940db97345c5adaf8da23ff46ae63613d728";
const COLLECTION = "0x952acc70e6f54ce87dca963193a5957bcb27729e";
const TAB_SETTLEMENT = "0x0dabf8e52280d0f128f546602a99b6dc4fbb80dc";
const SERVICE_ID = `0x${"11".repeat(32)}`;
const TOOL = `0x${"22".repeat(32)}`;
const SETTLEMENT_ID = `0x${"33".repeat(32)}`;
const TX_HASH = `0x${"ee".repeat(32)}`;
const USDC = { chainId: 143n, address: "0x754704bc059f8c67012fed69bc8a327a5aafb603", decimals: 6, symbol: "USDC" };
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

/** The `Settled` log `TabSettlement` emits, as a receipt would carry it. */
function settledLog(amount, applied, toPrepaid) {
  const surface = new Interface(TAB_SETTLEMENT_ABI);
  const topic = keccak256(toUtf8Bytes("Settled(bytes32,address,bytes32,address,uint128,uint128,uint128,address)"));
  assert.equal(surface.getEvent("Settled").topicHash, topic);
  return {
    address: TAB_SETTLEMENT,
    topics: [topic, SETTLEMENT_ID, `0x${"00".repeat(12)}${PAYER.slice(2)}`, SERVICE_ID],
    data: AbiCoder.defaultAbiCoder().encode(
      ["address", "uint128", "uint128", "uint128", "address"],
      [USDC.address, amount, applied, toPrepaid, COLLECTION],
    ),
  };
}

/** A signer that answers a settle with a mined receipt and never touches a chain. */
function fakeSigner() {
  return {
    async getAddress() {
      return PAYER;
    },
    async sendTransaction() {
      return {
        hash: TX_HASH,
        async wait() {
          return { status: 1, hash: TX_HASH, logs: [settledLog(5_000_000n, 4_000_000n, 1_000_000n)] };
        },
      };
    },
    provider: {
      async call() {
        // Any allowance read answers "plenty", so no approval is sent.
        return `0x${"ff".repeat(32)}`;
      },
    },
  };
}

test("the seam end to end: strategy, receipt, metered proxy, and a hook attaching the Settlement", async () => {
  // 1. The Agent settles through the strategy seam and the receipt
  //    carries what `TabBook` applied, read straight off the `Settled` event.
  const registry = createStrategyRegistry({ logger: silent });
  const strategy = createMonadStrategy({
    signer: fakeSigner(),
    tabSettlement: TAB_SETTLEMENT,
    assets: { [`143:${USDC.address}`]: USDC },
  });
  registry.register(strategy);
  const resolved = registry.resolve({ asset: USDC });
  assert.ok(resolved.ok);
  assert.equal(resolved.value.id, strategy.id);

  const settled = await resolved.value.settle({
    agent: PAYER,
    serviceId: SERVICE_ID,
    asset: USDC,
    amount: 5_000_000n,
  });
  assert.ok(settled.ok, explain(settled));
  assert.equal(settled.value.chainId, 143n);
  assert.equal(settled.value.txHash, TX_HASH);
  assert.equal(settled.value.settlementId, SETTLEMENT_ID);
  assert.equal(settled.value.applied, 4_000_000n);
  assert.equal(settled.value.toPrepaid, 1_000_000n);

  // 2. The Service keeps what it knows about the Agent's Settlements. In
  //    production that is the registry's settlement feed; here it is one row.
  const settlementsOf = new Map([
    [
      PAYER,
      {
        settlementId: settled.value.settlementId,
        txHash: settled.value.txHash,
        agent: PAYER,
        serviceId: SERVICE_ID,
        asset: USDC.address,
        amount: settled.value.amount,
        applied: settled.value.applied,
        toPrepaid: settled.value.toPrepaid,
      },
    ],
  ]);

  // 3. A metered request goes through the proxy and a hook attaches the Settlement.
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
  const attached = [];
  const proxy = createTabProxy({
    upstream: "https://upstream.example",
    hooks: [
      {
        name: "settlement-lookup",
        after: async (context) => {
          const agent = context.request.headers.get(TAB_HEADER.agent)?.toLowerCase();
          const view = agent === undefined ? undefined : settlementsOf.get(agent);
          if (view !== undefined) {
            context.settlement = view;
            attached.push(view);
          }
          return { ok: true, value: undefined };
        },
      },
    ],
    metering,
    fetchImpl: async () => new Response("summary", { status: 200 }),
    logger: silent,
  });

  const result = await proxy.proxy(
    new Request("https://service.example/v1/summarise", { method: "POST", headers: { [TAB_HEADER.agent]: PAYER }, body: "text" }),
  );

  assert.equal(result.kind, "delivered");
  assert.equal(await result.response.text(), "summary");
  assert.equal(deliveries.length, 1, "the delivery was recorded after the upstream answered");
  const block = parseChargeHeaders(result.response.headers);
  assert.ok(block.ok && block.value !== undefined);
  assert.equal(block.value.amount, 1_000_000n);
  assert.ok(result.settlement, "the Settlement the hook looked up is attached");
  assert.equal(result.settlement.settlementId, SETTLEMENT_ID);
  assert.equal(result.settlement.txHash, TX_HASH);
  assert.equal(result.settlement.applied, 4_000_000n);
  assert.equal(attached.length, 1);
});
