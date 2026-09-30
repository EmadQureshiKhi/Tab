/**
 * Settling in any asset through Kuru.
 *
 * The strategy is exercised over a fake inner strategy, a fake balance and a
 * fake router, so every branch of the decision is visible: a funded Agent
 * settles straight away, a short one is topped up first and then settles, and
 * a swap that cannot cover the shortfall never reaches the Settlement. The
 * on-chain router is driven over a fake signer whose `call` plays the market.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface } from "ethers";

import {
  KURU_NATIVE_TOKEN,
  KURU_ROUTER_ABI,
  createKuruFundedStrategy,
  createKuruOnchainRouter,
  kuruRouteKey,
} from "../dist/payments/index.js";

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const AGENT = "0x00000000000000000000000000000000000a9e17";
const SERVICE_ID = `0x${"11".repeat(32)}`;
const USDC = { chainId: 10143n, address: "0x480209747417f5c830fda188a9b9acfa70bc4083", decimals: 6, symbol: "mUSDC" };
const MON = { address: KURU_NATIVE_TOKEN, decimals: 18, symbol: "MON" };
const ROUTER = "0x7EFbE105Ca7415dE98F96622173458ac1c054630";
const MARKET = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";

const settleRequest = (amount = 1_000_000n) => ({ agent: AGENT, serviceId: SERVICE_ID, asset: USDC, amount });

/** An inner strategy that records every settle and answers a receipt. */
function fakeInner(calls = []) {
  return {
    id: "monad",
    chainIds: [10143n],
    supports: (asset) => asset.address.toLowerCase() === USDC.address,
    async quote(request) {
      return { ok: true, value: { amount: request.amount, asset: request.asset, feeNote: "gas in MON" } };
    },
    async settle(request) {
      calls.push(request);
      return {
        ok: true,
        value: {
          strategyId: "monad",
          chainId: 10143n,
          txHash: `0x${"aa".repeat(32)}`,
          asset: request.asset,
          amount: request.amount,
          payer: AGENT,
          serviceId: request.serviceId,
          settlementId: null,
          applied: null,
          toPrepaid: null,
          submittedAt: 1,
        },
      };
    },
  };
}

/** A balance that a swap tops up. */
function fakeBalance(initial) {
  const state = { balance: initial, reads: 0 };
  return {
    state,
    balanceOf: async () => {
      state.reads += 1;
      return { ok: true, value: state.balance };
    },
  };
}

/** A router quoting at a fixed price and crediting the balance on swap. */
function fakeRouter({ price = 10n, state, fail } = {}) {
  const calls = [];
  return {
    calls,
    async quote(request) {
      calls.push(["quote", request]);
      if (fail === "quote") return { ok: false, error: { category: "UPSTREAM", code: "KURU_QUOTE_FAILED", message: "no route", retryable: true } };
      return { ok: true, value: { request, amountIn: request.amountOut * price, expectedOut: request.amountOut } };
    },
    async swap(quote) {
      calls.push(["swap", quote]);
      if (fail === "swap") return { ok: false, error: { category: "CHAIN", code: "KURU_SWAP_REVERTED", message: "slipped", retryable: false } };
      if (state !== undefined && fail !== "short") state.balance += quote.expectedOut;
      return { ok: true, value: { txHash: `0x${"bb".repeat(32)}`, amountIn: quote.amountIn, amountOut: quote.expectedOut } };
    },
  };
}

test("an Agent that already holds the Asset settles without a swap", async () => {
  const settles = [];
  const balance = fakeBalance(5_000_000n);
  const router = fakeRouter({ state: balance.state });
  const strategy = createKuruFundedStrategy({ inner: fakeInner(settles), kuru: { router, source: MON, balanceOf: balance.balanceOf }, logger: silent });

  assert.equal(strategy.id, "monad+kuru");
  assert.deepEqual(strategy.chainIds, [10143n]);
  assert.equal(strategy.supports(USDC), true);

  const receipt = await strategy.settle(settleRequest(1_000_000n));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.value.txHash, `0x${"aa".repeat(32)}`);
  assert.equal(receipt.value.strategyId, "monad+kuru", "the receipt names the wrapper, not the inner strategy");
  assert.equal(settles.length, 1);
  assert.deepEqual(router.calls, [], "no quote and no swap");
  assert.equal(balance.state.reads, 1);
});

test("a short Agent is topped up for exactly the shortfall, and then settles", async () => {
  const settles = [];
  const balance = fakeBalance(250_000n);
  const router = fakeRouter({ price: 3n, state: balance.state });
  const funded = [];
  const strategy = createKuruFundedStrategy({
    inner: fakeInner(settles),
    kuru: { router, source: MON, balanceOf: balance.balanceOf, maxSourceAmount: 10_000_000n, onFunded: (event) => funded.push(event) },
    logger: silent,
  });

  const receipt = await strategy.settle(settleRequest(1_000_000n));
  assert.equal(receipt.ok, true, receipt.ok ? "" : receipt.error.message);
  assert.equal(settles.length, 1, "the inner strategy settled once, after the swap");

  const [quoteCall, swapCall] = router.calls;
  assert.equal(quoteCall[0], "quote");
  assert.equal(quoteCall[1].amountOut, 750_000n, "the shortfall, not the whole amount");
  assert.equal(quoteCall[1].tokenIn, KURU_NATIVE_TOKEN);
  assert.equal(quoteCall[1].tokenOut, USDC.address);
  assert.equal(quoteCall[1].maxAmountIn, 10_000_000n);
  assert.equal(quoteCall[1].recipient.toLowerCase(), AGENT);
  assert.equal(swapCall[0], "swap");
  assert.equal(swapCall[1].amountIn, 2_250_000n);
  assert.equal(balance.state.reads, 2, "read before, and read again after the swap");

  assert.equal(funded.length, 1);
  assert.equal(funded[0].shortfall, 750_000n);
  assert.equal(funded[0].balanceBefore, 250_000n);
  assert.equal(funded[0].swap.txHash, `0x${"bb".repeat(32)}`);
});

test("a swap that cannot be quoted, that fails, or that leaves the Agent short never reaches the Settlement", async () => {
  for (const [fail, code] of [
    ["quote", "KURU_QUOTE_FAILED"],
    ["swap", "KURU_SWAP_REVERTED"],
    ["short", "KURU_SWAP_SHORT"],
  ]) {
    const settles = [];
    const balance = fakeBalance(0n);
    const strategy = createKuruFundedStrategy({
      inner: fakeInner(settles),
      kuru: { router: fakeRouter({ state: balance.state, fail }), source: MON, balanceOf: balance.balanceOf },
      logger: silent,
    });
    const receipt = await strategy.settle(settleRequest(1_000n));
    assert.equal(receipt.ok, false, fail);
    assert.equal(receipt.error.code, code, fail);
    assert.equal(settles.length, 0, `${fail}: nothing settled`);
  }
});

test("a quote above the source ceiling is refused before anything moves", async () => {
  const settles = [];
  const balance = fakeBalance(0n);
  const router = fakeRouter({ price: 100n, state: balance.state });
  const strategy = createKuruFundedStrategy({
    inner: fakeInner(settles),
    kuru: { router, source: MON, balanceOf: balance.balanceOf, maxSourceAmount: 50_000n },
    logger: silent,
  });
  const receipt = await strategy.settle(settleRequest(1_000n));
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.code, "KURU_SOURCE_CEILING");
  assert.equal(router.calls.filter(([what]) => what === "swap").length, 0);
  assert.equal(settles.length, 0);
});

test("the strategy validates the request and refuses an Asset the inner strategy does not support", async () => {
  const strategy = createKuruFundedStrategy({ inner: fakeInner(), kuru: { router: fakeRouter(), source: MON, balanceOf: async () => ({ ok: true, value: 0n }) }, logger: silent });
  const zero = await strategy.settle(settleRequest(0n));
  assert.equal(zero.ok, false);
  assert.equal(zero.error.code, "AMOUNT_NOT_POSITIVE");
  const other = await strategy.settle({ ...settleRequest(1n), asset: { ...USDC, address: "0x754704bc059f8c67012fed69bc8a327a5aafb603" } });
  assert.equal(other.ok, false);
  assert.equal(other.error.code, "ASSET_NOT_CONFIGURED");
  const quote = await strategy.quote(settleRequest(1n));
  assert.equal(quote.ok, true);
  assert.match(quote.value.feeNote, /swapped in from MON through Kuru/);
});

test("without a balance reader or a connected signer, the strategy says what it needs", async () => {
  const strategy = createKuruFundedStrategy({ inner: fakeInner(), kuru: { router: fakeRouter(), source: MON }, logger: silent });
  const receipt = await strategy.settle(settleRequest(1n));
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.code, "KURU_BALANCE_UNREADABLE");
});

// ---------------------------------------------------------------- the on-chain router

const routerInterface = new Interface(KURU_ROUTER_ABI);

/** A signer whose `call` plays a market at a fixed price and whose `send` records. */
function fakeSigner({ outPerIn, address = "0x00000000000000000000000000000000000000A1", depthCap } = {}) {
  const calls = [];
  const sent = [];
  return {
    calls,
    sent,
    getAddress: async () => address,
    provider: {
      async call(transaction) {
        calls.push(transaction);
        const [, , , , , amountIn] = routerInterface.decodeFunctionData("anyToAnySwap", transaction.data);
        let out = (amountIn * outPerIn.numerator) / outPerIn.denominator;
        if (depthCap !== undefined && out > depthCap) out = depthCap;
        return routerInterface.encodeFunctionResult("anyToAnySwap", [out]);
      },
    },
    async sendTransaction(transaction) {
      sent.push(transaction);
      return { hash: `0x${"cc".repeat(32)}`, wait: async () => ({ hash: `0x${"cc".repeat(32)}`, status: 1, logs: [] }) };
    },
  };
}

const routes = { [kuruRouteKey(KURU_NATIVE_TOKEN, USDC.address)]: { markets: [MARKET], isBuy: [false], nativeSend: [true] } };

test("the on-chain router quotes by simulation, adds the slippage margin, and sends the shortfall as the minimum out", async () => {
  // 1 MON (1e18) buys 2 USDC (2e6): the probe at the ceiling implies the price.
  const signer = fakeSigner({ outPerIn: { numerator: 2_000_000n, denominator: 1_000_000_000_000_000_000n } });
  const router = createKuruOnchainRouter({ signer, router: ROUTER, routes, slippageBps: 100, logger: silent });

  const request = { chainId: 10143n, tokenIn: KURU_NATIVE_TOKEN, tokenOut: USDC.address, amountOut: 500_000n, maxAmountIn: 10n ** 18n, recipient: AGENT };
  const quote = await router.quote(request);
  assert.equal(quote.ok, true, quote.ok ? "" : quote.error.message);
  // 0.5 USDC needs 0.25 MON, plus one percent.
  assert.equal(quote.value.amountIn, 252_500_000_000_000_000n);
  assert.equal(quote.value.expectedOut, 505_000n);
  assert.equal(signer.calls.length, 2, "the probe, then the check at the computed size");

  const swap = await router.swap(quote.value);
  assert.equal(swap.ok, true);
  assert.equal(swap.value.txHash, `0x${"cc".repeat(32)}`);
  assert.equal(signer.sent.length, 1, "native in: no approval transaction");
  const [tx] = signer.sent;
  assert.equal(tx.to, ROUTER);
  assert.equal(tx.value, 252_500_000_000_000_000n, "MON is sent as value");
  const decoded = routerInterface.decodeFunctionData("anyToAnySwap", tx.data);
  assert.deepEqual([...decoded[0]], [MARKET]);
  assert.equal(decoded[5], 252_500_000_000_000_000n);
  assert.equal(decoded[6], 500_000n, "the shortfall is the minimum out, so a short fill reverts rather than settles short");
});

test("the on-chain router approves an ERC-20 source before swapping it, and refuses a route it does not know", async () => {
  const AUSD = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a";
  const signer = fakeSigner({ outPerIn: { numerator: 1n, denominator: 1n } });
  const router = createKuruOnchainRouter({
    signer,
    router: ROUTER,
    routes: { [kuruRouteKey(AUSD, USDC.address)]: { markets: [MARKET], isBuy: [true], nativeSend: [false] } },
    logger: silent,
  });
  const quote = await router.quote({ chainId: 10143n, tokenIn: AUSD, tokenOut: USDC.address, amountOut: 1_000n, maxAmountIn: 1_000_000n, recipient: AGENT });
  assert.equal(quote.ok, true);
  assert.equal(quote.value.amountIn, 1_010n);
  const swap = await router.swap(quote.value);
  assert.equal(swap.ok, true);
  assert.equal(signer.sent.length, 2, "approve, then swap");
  assert.equal(signer.sent[0].to, AUSD);
  assert.equal(signer.sent[1].to, ROUTER);
  assert.equal(signer.sent[1].value, undefined);

  const unknown = await router.quote({ chainId: 10143n, tokenIn: USDC.address, tokenOut: AUSD, amountOut: 1n, maxAmountIn: 1n, recipient: AGENT });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "KURU_ROUTE_UNKNOWN");
});

test("the on-chain router reports a route too shallow for the shortfall instead of sending a swap that would revert", async () => {
  const signer = fakeSigner({ outPerIn: { numerator: 1n, denominator: 1n }, depthCap: 100n });
  const router = createKuruOnchainRouter({ signer, router: ROUTER, routes: { [kuruRouteKey(KURU_NATIVE_TOKEN, USDC.address)]: routes[kuruRouteKey(KURU_NATIVE_TOKEN, USDC.address)] }, logger: silent });
  const quote = await router.quote({ chainId: 10143n, tokenIn: KURU_NATIVE_TOKEN, tokenOut: USDC.address, amountOut: 1_000n, maxAmountIn: 5_000n, recipient: AGENT });
  assert.equal(quote.ok, false);
  assert.equal(quote.error.code, "KURU_QUOTE_SHORT");
  assert.equal(signer.sent.length, 0);
});
