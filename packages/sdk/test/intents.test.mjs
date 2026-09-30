/**
 * Settling with USDC brought to Monad through NEAR Intents.
 *
 * The strategy is exercised over a fake inner strategy, a fake Monad balance,
 * a fake funding-chain signer and a fake `fetch` that plays the 1Click API, so
 * every branch of the decision is visible without a network or a chain: a
 * funded Agent settles straight away, a short one is funded first and then
 * settles, and a funding step that is refused, refunded, fails or runs out of
 * time never reaches the Settlement. A dry run asks only for a dry quote.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface } from "ethers";

import {
  ERC20_ABI,
  INTENTS_FUNDED_STRATEGY_ID,
  ONE_CLICK_MONAD_ASSETS,
  ONE_CLICK_USDC_FUNDING,
  createIntentsFundedStrategy,
  createOneClickClient,
} from "../dist/payments/index.js";
import * as root from "../dist/index.js";

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const erc20 = new Interface(ERC20_ABI);

const AGENT = "0x00000000000000000000000000000000000a9e17";
const SERVICE_ID = `0x${"11".repeat(32)}`;
const USDC = { chainId: 143n, address: "0x754704bc059f8c67012fed69bc8a327a5aafb603", decimals: 6, symbol: "USDC" };
const MUSDC = { chainId: 10143n, address: "0x480209747417f5c830fda188a9b9acfa70bc4083", decimals: 6, symbol: "mUSDC" };
const FUNDING = ONE_CLICK_USDC_FUNDING.base;
const DEPOSIT = "0x76b4c56085ED136a8744D52bE956396624a730E8";
const DEPOSIT_TX = `0x${"dd".repeat(32)}`;

const settleRequest = (amount = 1_000_000n, asset = USDC) => ({ agent: AGENT, serviceId: SERVICE_ID, asset, amount });

/** An inner strategy over both Monad Assets that records every settle. */
function fakeInner(calls = []) {
  return {
    id: "monad",
    chainIds: [143n],
    supports: (asset) => [USDC.address, MUSDC.address].includes(asset.address.toLowerCase()),
    async quote(request) {
      return { ok: true, value: { amount: request.amount, asset: request.asset, feeNote: "gas in MON" } };
    },
    async settle(request) {
      calls.push(request);
      return {
        ok: true,
        value: {
          strategyId: "monad",
          chainId: 143n,
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

/** The Agent's Monad balance, which a delivery credits. */
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

/** The Agent's signer on the funding chain: answers balanceOf and the chain id, records every send. */
function fakeFundingSigner({ held = 10_000_000n, chainId = FUNDING.chainId, status = 1 } = {}) {
  const sent = [];
  return {
    sent,
    getAddress: async () => AGENT,
    provider: {
      getNetwork: async () => ({ chainId }),
      async call(transaction) {
        assert.equal(transaction.to, FUNDING.address);
        return erc20.encodeFunctionResult("balanceOf", [held]);
      },
    },
    async sendTransaction(transaction) {
      sent.push(transaction);
      return { hash: DEPOSIT_TX, wait: async () => ({ hash: DEPOSIT_TX, status, logs: [] }) };
    },
  };
}

/**
 * A `fetch` that plays the 1Click API: a quote at a fixed input for any
 * output, then the scripted statuses in order, the last one repeating.
 */
function fakeApi({ amountIn = 760_000n, statuses = ["PENDING_DEPOSIT", "PROCESSING", "SUCCESS"], onSuccess, quoteReply, minimum } = {}) {
  const calls = [];
  let statusIndex = 0;
  const reply = (status, body) => ({ status, json: async () => body });
  const fetchImpl = async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method: init.method, headers: init.headers, body });
    const path = new URL(url).pathname;
    if (path === "/v0/quote") {
      if (quoteReply !== undefined) return quoteReply(body);
      if (minimum !== undefined && BigInt(body.amount) < minimum) {
        return reply(400, { message: `Amount is too low for bridge, try at least ${minimum}` });
      }
      return reply(201, {
        correlationId: "corr-1",
        timestamp: "2026-09-30T00:00:00.000Z",
        signature: "ed25519:sig",
        quoteRequest: body,
        quote: {
          ...(body.dry ? {} : { depositAddress: DEPOSIT, deadline: body.deadline }),
          amountIn: amountIn.toString(),
          amountInFormatted: "0.76",
          amountInUsd: "0.76",
          minAmountIn: (amountIn - 7_000n).toString(),
          amountOut: body.amount,
          amountOutFormatted: "0.75",
          amountOutUsd: "0.75",
          minAmountOut: body.amount,
          timeEstimate: 37,
        },
      });
    }
    if (path === "/v0/deposit/submit") return reply(200, { correlationId: "corr-2", status: "KNOWN_DEPOSIT_TX", updatedAt: "now", swapDetails: {} });
    if (path === "/v0/status") {
      const status = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex += 1;
      if (status instanceof Error) throw status;
      if (status === "SUCCESS") onSuccess?.();
      return reply(200, {
        correlationId: "corr-3",
        status,
        updatedAt: "now",
        swapDetails: status === "REFUNDED" ? { refundedAmount: amountIn.toString(), refundReason: "DEADLINE" } : {},
      });
    }
    return reply(404, { message: "not found" });
  };
  return { calls, fetchImpl, paths: () => calls.map((call) => new URL(call.url).pathname) };
}

/** A clock that only moves when the strategy sleeps. */
function fakeClock() {
  const clock = { t: 1_800_000_000_000, sleeps: 0 };
  return {
    clock,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.sleeps += 1;
      clock.t += ms;
    },
  };
}

function build({ balance, api, signer = fakeFundingSigner(), settles = [], ...intents }) {
  const { now, sleep, clock } = fakeClock();
  const strategy = createIntentsFundedStrategy({
    inner: fakeInner(settles),
    intents: {
      funding: FUNDING,
      fundingSigner: signer,
      fetchImpl: api.fetchImpl,
      balanceOf: balance.balanceOf,
      pollIntervalMs: 1_000,
      timeoutMs: 60_000,
      now,
      sleep,
      ...intents,
    },
    logger: silent,
  });
  return { strategy, clock, signer, settles };
}

test("the strategy is exported from the package root and names itself intents-funded", () => {
  assert.equal(typeof root.createIntentsFundedStrategy, "function");
  assert.equal(typeof root.createOneClickClient, "function");
  assert.equal(INTENTS_FUNDED_STRATEGY_ID, "intents-funded");
  assert.equal(ONE_CLICK_MONAD_ASSETS[`143:${USDC.address}`], "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx");
});

test("an Agent that already holds the Asset on Monad settles without asking the API anything", async () => {
  const balance = fakeBalance(5_000_000n);
  const api = fakeApi();
  const { strategy, signer, settles } = build({ balance, api });

  assert.equal(strategy.id, "intents-funded");
  assert.deepEqual(strategy.chainIds, [143n]);
  assert.equal(strategy.supports(USDC), true);

  const receipt = await strategy.settle(settleRequest(1_000_000n));
  assert.equal(receipt.ok, true, receipt.ok ? "" : receipt.error.message);
  assert.equal(settles.length, 1);
  assert.deepEqual(api.calls, [], "no quote, no status");
  assert.deepEqual(signer.sent, [], "nothing sent on the funding chain");
  assert.equal(balance.state.reads, 1);
});

test("a short Agent is funded for exactly the shortfall through a deposit on the funding chain, and then settles", async () => {
  const balance = fakeBalance(250_000n);
  const api = fakeApi({ onSuccess: () => (balance.state.balance += 750_000n) });
  const funded = [];
  const { strategy, signer, settles } = build({
    balance,
    api,
    apiKey: "partner-key",
    maxFundingAmount: 1_000_000n,
    onFunded: (event) => funded.push(event),
  });

  const receipt = await strategy.settle(settleRequest(1_000_000n));
  assert.equal(receipt.ok, true, receipt.ok ? "" : receipt.error.message);
  assert.equal(settles.length, 1, "the inner strategy settled once, after the funding step");

  assert.deepEqual(api.paths(), ["/v0/quote", "/v0/deposit/submit", "/v0/status", "/v0/status", "/v0/status"]);
  const quote = api.calls[0];
  assert.equal(quote.method, "POST");
  assert.equal(quote.headers["x-api-key"], "partner-key");
  assert.equal(quote.body.dry, false);
  assert.equal(quote.body.swapType, "EXACT_OUTPUT");
  assert.equal(quote.body.amount, "750000", "the shortfall, not the whole amount");
  assert.equal(quote.body.originAsset, FUNDING.assetId);
  assert.equal(quote.body.destinationAsset, ONE_CLICK_MONAD_ASSETS[`143:${USDC.address}`]);
  assert.equal(quote.body.recipient.toLowerCase(), AGENT, "delivered to the Agent's own Monad address");
  assert.equal(quote.body.recipientType, "DESTINATION_CHAIN");
  assert.equal(quote.body.refundTo.toLowerCase(), AGENT, "refunded to the Agent on the funding chain");
  assert.equal(quote.body.refundType, "ORIGIN_CHAIN");
  assert.equal(quote.body.depositType, "ORIGIN_CHAIN");
  assert.equal(quote.body.slippageTolerance, 100);
  assert.ok(Date.parse(quote.body.deadline) > 0);

  assert.equal(signer.sent.length, 1, "one transfer on the funding chain");
  assert.equal(signer.sent[0].to, FUNDING.address);
  const [to, amount] = erc20.decodeFunctionData("transfer", signer.sent[0].data);
  assert.equal(to, DEPOSIT);
  assert.equal(amount, 760_000n, "the quote's amountIn, which carries the slippage tolerance");
  assert.deepEqual(api.calls[1].body, { txHash: DEPOSIT_TX, depositAddress: DEPOSIT });
  assert.equal(new URL(api.calls[2].url).searchParams.get("depositAddress"), DEPOSIT);

  assert.equal(funded.length, 1);
  assert.equal(funded[0].shortfall, 750_000n);
  assert.equal(funded[0].balanceBefore, 250_000n);
  assert.equal(funded[0].amountIn, 760_000n);
  assert.equal(funded[0].depositAddress, DEPOSIT);
  assert.equal(funded[0].depositTxHash, DEPOSIT_TX);
  assert.equal(funded[0].status.status, "SUCCESS");
});

test("a shortfall below the smallest delivery is raised to the API's minimum once", async () => {
  const balance = fakeBalance(990_000n);
  const api = fakeApi({ minimum: 149_967n, onSuccess: () => (balance.state.balance += 149_967n) });
  const { strategy, settles } = build({ balance, api });
  const receipt = await strategy.settle(settleRequest(1_000_000n));
  assert.equal(receipt.ok, true, receipt.ok ? "" : receipt.error.message);
  const quotes = api.calls.filter((call) => new URL(call.url).pathname === "/v0/quote");
  assert.deepEqual(quotes.map((call) => call.body.amount), ["10000", "149967"]);
  assert.equal(settles.length, 1);
});

test("a quote above the funding ceiling is refused before anything is sent", async () => {
  const balance = fakeBalance(0n);
  const api = fakeApi({ amountIn: 2_000_000n });
  const { strategy, signer, settles } = build({ balance, api, maxFundingAmount: 1_500_000n });
  const receipt = await strategy.settle(settleRequest(1_000_000n));
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.code, "INTENTS_FUNDING_CEILING");
  assert.equal(receipt.error.details.ceiling, "1500000");
  assert.deepEqual(api.paths(), ["/v0/quote"]);
  assert.equal(signer.sent.length, 0);
  assert.equal(settles.length, 0);
});

test("a refunded, failed or timed-out funding step returns a Result naming the deposit address, and never settles", async () => {
  for (const [statuses, code] of [
    [["PENDING_DEPOSIT", "REFUNDED"], "INTENTS_FUNDING_REFUNDED"],
    [["PROCESSING", "FAILED"], "INTENTS_FUNDING_FAILED"],
    [["PROCESSING"], "INTENTS_FUNDING_TIMEOUT"],
    [[new Error("socket hang up")], "INTENTS_FUNDING_TIMEOUT"],
  ]) {
    const balance = fakeBalance(0n);
    const api = fakeApi({ statuses });
    const { strategy, signer, settles, clock } = build({ balance, api });
    const receipt = await strategy.settle(settleRequest(1_000_000n));
    const label = statuses.map(String).join(",");
    assert.equal(receipt.ok, false, label);
    assert.equal(receipt.error.code, code, label);
    assert.equal(receipt.error.details.depositAddress, DEPOSIT, label);
    assert.equal(receipt.error.details.depositTxHash, DEPOSIT_TX, label);
    assert.match(receipt.error.message, /nothing was settled/, label);
    assert.equal(signer.sent.length, 1, `${label}: the deposit was sent once`);
    assert.equal(settles.length, 0, `${label}: nothing settled`);
    if (code === "INTENTS_FUNDING_TIMEOUT") assert.ok(clock.sleeps >= 60, `${label}: polled until the wait ran out`);
  }
});

test("a delivery the API reports that never shows up in the Monad balance is not settled on", async () => {
  const balance = fakeBalance(0n);
  const api = fakeApi({ statuses: ["SUCCESS"] });
  const { strategy, settles } = build({ balance, api });
  const receipt = await strategy.settle(settleRequest(1_000_000n));
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.code, "INTENTS_FUNDING_SHORT");
  assert.equal(settles.length, 0);
});

test("a refused quote, a signer on the wrong chain, a short funding balance and a reverted deposit all stop before the Settlement", async () => {
  const refused = build({
    balance: fakeBalance(0n),
    api: fakeApi({ quoteReply: () => ({ status: 400, json: async () => ({ message: "tokenIn is not supported" }) }) }),
  });
  const quoteRefused = await refused.strategy.settle(settleRequest());
  assert.equal(quoteRefused.ok, false);
  assert.equal(quoteRefused.error.code, "ONE_CLICK_REFUSED");
  assert.equal(quoteRefused.error.details.apiMessage, "tokenIn is not supported");
  assert.equal(refused.signer.sent.length, 0);

  const wrongChain = build({ balance: fakeBalance(0n), api: fakeApi(), signer: fakeFundingSigner({ chainId: 1n }) });
  const mismatch = await wrongChain.strategy.settle(settleRequest());
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "INTENTS_FUNDING_CHAIN_MISMATCH");
  assert.equal(mismatch.error.details.depositAddress, DEPOSIT);
  assert.equal(wrongChain.signer.sent.length, 0);

  const poor = build({ balance: fakeBalance(0n), api: fakeApi(), signer: fakeFundingSigner({ held: 1_000n }) });
  const short = await poor.strategy.settle(settleRequest());
  assert.equal(short.ok, false);
  assert.equal(short.error.code, "INTENTS_FUNDING_BALANCE_SHORT");
  assert.equal(poor.signer.sent.length, 0);

  const reverting = build({ balance: fakeBalance(0n), api: fakeApi(), signer: fakeFundingSigner({ status: 0 }) });
  const reverted = await reverting.strategy.settle(settleRequest());
  assert.equal(reverted.ok, false);
  assert.equal(reverted.error.code, "INTENTS_DEPOSIT_REVERTED");
  for (const outcome of [refused, wrongChain, poor, reverting]) assert.equal(outcome.settles.length, 0);
});

test("an Asset NEAR Intents does not deliver on Monad is declined, so Testnet mUSDC resolves elsewhere", async () => {
  const api = fakeApi();
  const { strategy, signer, settles } = build({ balance: fakeBalance(0n), api });
  assert.equal(strategy.supports(MUSDC), false);
  const receipt = await strategy.settle(settleRequest(1_000n, MUSDC));
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.code, "INTENTS_ASSET_UNSUPPORTED");
  const quote = await strategy.quote(settleRequest(1_000n, MUSDC));
  assert.equal(quote.ok, false);
  assert.equal(quote.error.code, "INTENTS_ASSET_UNSUPPORTED");
  const zero = await strategy.settle(settleRequest(0n));
  assert.equal(zero.error.code, "AMOUNT_NOT_POSITIVE");
  assert.deepEqual(api.calls, []);
  assert.equal(signer.sent.length, 0);
  assert.equal(settles.length, 0);
});

test("a dry run asks for a dry quote and moves nothing", async () => {
  const balance = fakeBalance(250_000n);
  const api = fakeApi();
  const { strategy, signer, settles } = build({ balance, api });

  const quote = await strategy.quote(settleRequest(1_000_000n));
  assert.equal(quote.ok, true, quote.ok ? "" : quote.error.message);
  assert.equal(quote.value.amount, 1_000_000n);
  assert.match(quote.value.feeNote, /short 750000 base units of USDC on Monad/);
  assert.match(quote.value.feeNote, /760000 base units of USDC on chain 8453 are brought to Monad through NEAR Intents first/);
  assert.deepEqual(api.paths(), ["/v0/quote"]);
  assert.equal(api.calls[0].body.dry, true);
  assert.equal(signer.sent.length, 0, "no deposit");
  assert.equal(settles.length, 0, "no Settlement");

  const ceiling = build({ balance: fakeBalance(0n), api: fakeApi({ amountIn: 5_000_000n }), maxFundingAmount: 1n });
  const refused = await ceiling.strategy.quote(settleRequest(1_000_000n));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "INTENTS_FUNDING_CEILING");

  const funded = build({ balance: fakeBalance(2_000_000n), api: fakeApi() });
  const covered = await funded.strategy.quote(settleRequest(1_000_000n));
  assert.equal(covered.ok, true);
  assert.match(covered.value.feeNote, /nothing is brought in first/);
});

test("without a balance reader or a connected Monad signer, the strategy says what it needs", async () => {
  const strategy = createIntentsFundedStrategy({
    inner: fakeInner(),
    intents: { funding: FUNDING, fundingSigner: fakeFundingSigner(), fetchImpl: fakeApi().fetchImpl },
    logger: silent,
  });
  const receipt = await strategy.settle(settleRequest());
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.code, "INTENTS_BALANCE_UNREADABLE");
});

test("the 1Click client speaks the documented paths and turns every failure into a Result", async () => {
  const api = fakeApi();
  const client = createOneClickClient({ baseUrl: "https://1click.example/", jwt: "token", fetchImpl: api.fetchImpl });
  const status = await client.status(DEPOSIT);
  assert.equal(status.ok, true);
  assert.equal(status.value.status, "PENDING_DEPOSIT");
  assert.equal(api.calls[0].url, `https://1click.example/v0/status?depositAddress=${DEPOSIT}`);
  assert.equal(api.calls[0].headers.authorization, "Bearer token");
  assert.equal(api.calls[0].headers["x-api-key"], undefined);

  const unreachable = createOneClickClient({ fetchImpl: async () => { throw new Error("offline"); } });
  const down = await unreachable.status(DEPOSIT);
  assert.equal(down.ok, false);
  assert.equal(down.error.code, "ONE_CLICK_UNREACHABLE");
  assert.equal(down.error.retryable, true);

  const garbled = createOneClickClient({ fetchImpl: async () => ({ status: 200, json: async () => ({ quote: { amountIn: "1.5" } }) }) });
  const bad = await garbled.quote({});
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "ONE_CLICK_UNPARSEABLE");

  const low = createOneClickClient({ fetchImpl: async () => ({ status: 400, json: async () => ({ message: "Amount is too low for bridge, try at least 149967" }) }) });
  const refused = await low.quote({});
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "ONE_CLICK_REFUSED");
  assert.equal(refused.error.details.minimumAmount, "149967");
  assert.equal(refused.error.retryable, false);
});

test("a batch is funded once per Agent and Asset for its total", async () => {
  const balance = fakeBalance(0n);
  const api = fakeApi({ onSuccess: () => (balance.state.balance = 3_000_000n) });
  const batches = [];
  const inner = { ...fakeInner(), settleBatch: async (requests) => { batches.push(requests); return { ok: true, value: [] }; } };
  const { now, sleep } = fakeClock();
  const strategy = createIntentsFundedStrategy({
    inner,
    intents: { funding: FUNDING, fundingSigner: fakeFundingSigner(), fetchImpl: api.fetchImpl, balanceOf: balance.balanceOf, now, sleep, pollIntervalMs: 1_000, timeoutMs: 60_000 },
    logger: silent,
  });
  const result = await strategy.settleBatch([settleRequest(1_000_000n), settleRequest(2_000_000n)]);
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  const quotes = api.calls.filter((call) => new URL(call.url).pathname === "/v0/quote");
  assert.deepEqual(quotes.map((call) => call.body.amount), ["3000000"]);
  assert.equal(batches.length, 1);
});
