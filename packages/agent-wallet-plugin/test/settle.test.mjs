import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface } from "ethers";

import { createHost } from "../dist/host-context.js";
import { runSettle } from "../dist/tab/settle.js";
import { AGENT, ENV, fakeContext, fakeIo, OTHER_ASSET, SERVICE_ID, SETTINGS, stubRegistryFetch, TAB_SETTLEMENT, USDC } from "./fixtures.mjs";

const deps = (context, over = {}) => ({
  host: createHost({ ctx: context.ctx, io: fakeIo({}), commandId: "tab:settle" }),
  settings: SETTINGS,
  env: ENV,
  registryFetch: stubRegistryFetch(),
  ...over,
});

const settle = new Interface(["function settle(bytes32 serviceId, address asset, uint128 amount)"]);
const erc20 = new Interface(["function approve(address spender, uint256 amount)"]);

test("a dry run builds both transactions when the allowance falls short, and submits nothing", async () => {
  const context = fakeContext({ allowance: 1_000n });
  const result = await runSettle(deps(context), { service: SERVICE_ID, asset: `10143:${USDC}`, amount: "47000", broadcast: false });
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const report = result.value;
  assert.equal(report.broadcast, false);
  assert.equal(report.plan.agent, AGENT);
  assert.equal(report.plan.allowanceBaseUnits, "1000");
  assert.equal(report.plan.amountBaseUnits, "47000");
  assert.equal(report.plan.assetSymbol, "mUSDC");
  assert.ok(report.plan.approval !== null);
  assert.equal(report.plan.approval.to, USDC);
  const approve = erc20.decodeFunctionData("approve", report.plan.approval.data);
  assert.equal(approve.spender.toLowerCase(), TAB_SETTLEMENT);
  assert.equal(approve.amount, 47_000n, "the approval is exact, not unlimited");
  assert.equal(report.plan.settlement.to, TAB_SETTLEMENT);
  const decoded = settle.decodeFunctionData("settle", report.plan.settlement.data);
  assert.equal(decoded.serviceId, SERVICE_ID);
  assert.equal(decoded.asset.toLowerCase(), USDC);
  assert.equal(decoded.amount, 47_000n);
  assert.match(report.note, /Dry run/);
  assert.equal(context.requests.length, 0);
  assert.equal(context.executorCalls.length, 0, "a dry run never asks for wallet-submit");
});

test("a sufficient allowance leaves the approval out", async () => {
  const context = fakeContext({ allowance: 47_000n });
  const result = await runSettle(deps(context), { service: SERVICE_ID, asset: USDC, amount: "47000", broadcast: false });
  assert.ok(result.ok);
  assert.equal(result.value.plan.approval, null);
  assert.match(result.value.note, /this transaction/);
});

test("a bare address takes the configured chain", async () => {
  const context = fakeContext({ allowance: 0n });
  const result = await runSettle(deps(context), { service: SERVICE_ID, asset: USDC, amount: "1", broadcast: false });
  assert.ok(result.ok);
  assert.equal(result.value.plan.asset, `10143:${USDC}`);
});

test("--broadcast submits the approval, then the settlement, both through the executor", async () => {
  const context = fakeContext({ allowance: 0n, status: "CONFIRMED" });
  const result = await runSettle(deps(context), { service: SERVICE_ID, asset: USDC, amount: "47000", broadcast: true });
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.equal(result.value.broadcast, true);
  assert.equal(context.requests.length, 2);
  assert.equal(context.requests[0].request.transaction.to, USDC);
  assert.equal(context.requests[0].request.transaction.data, result.value.plan.approval.data);
  assert.deepEqual(context.requests[0].opts, { waitForReceipt: true });
  assert.equal(context.requests[1].request.transaction.to, TAB_SETTLEMENT);
  assert.equal(context.requests[1].request.transaction.data, result.value.plan.settlement.data);
  assert.match(context.requests[1].request.intent.summary, /Settle 47000 mUSDC base units/);
  assert.equal(context.executorCalls[0].source, "tab:settle");
  assert.equal(result.value.approvalTx.txHash, `0x${"0".repeat(63)}1`);
  assert.equal(result.value.settlementTx.txHash, `0x${"0".repeat(63)}2`);
  assert.equal(result.value.settlementTx.explorerUrl, `https://testnet.monadvision.com/tx/0x${"0".repeat(63)}2`);
});

test("a wallet refusal on the approval stops before the settlement is submitted", async () => {
  const context = fakeContext({ allowance: 0n, status: "DENIED" });
  const result = await runSettle(deps(context), { service: SERVICE_ID, asset: USDC, amount: "47000", broadcast: true });
  assert.ok(!result.ok);
  assert.equal(result.error.category, "CHAIN");
  assert.equal(context.requests.length, 1, "the settlement was never handed to the wallet");
});

test("an Asset the Service never accepted is refused before the chain is read", async () => {
  const context = fakeContext({ allowance: 0n });
  const result = await runSettle(deps(context), { service: SERVICE_ID, asset: OTHER_ASSET, amount: "47000", broadcast: false });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "ASSET_NOT_ACCEPTED");
});

test("malformed inputs are refused by name and nothing is read", async () => {
  const context = fakeContext({ allowance: 0n });
  const registryFetch = stubRegistryFetch();
  const d = deps(context, { registryFetch });
  assert.equal((await runSettle(d, { service: "tab.demo", asset: USDC, amount: "1", broadcast: false })).error.code, "SERVICE_ID_MALFORMED");
  assert.equal((await runSettle(d, { service: SERVICE_ID, asset: "usdc", amount: "1", broadcast: false })).error.code, "ASSET_MALFORMED");
  assert.equal((await runSettle(d, { service: SERVICE_ID, asset: `143:${USDC}`, amount: "1", broadcast: false })).error.code, "ASSET_CHAIN_MISMATCH");
  assert.equal((await runSettle(d, { service: SERVICE_ID, asset: USDC, amount: "0", broadcast: false })).error.code, "AMOUNT_ZERO");
  assert.equal((await runSettle(d, { service: SERVICE_ID, asset: USDC, amount: "1.5", broadcast: false })).error.code, "AMOUNT_MALFORMED");
  assert.equal(registryFetch.calls.length, 0);
});

test("without a registry URL the failure names the variable", async () => {
  const context = fakeContext({ allowance: 0n });
  const result = await runSettle(deps(context, { settings: { ...SETTINGS, registryUrl: undefined }, registryFetch: undefined }), { service: SERVICE_ID, asset: USDC, amount: "1", broadcast: false });
  assert.equal(result.error.code, "REGISTRY_UNCONFIGURED");
  assert.match(result.error.message, /NEXT_PUBLIC_REGISTRY_API_URL/);
});

test("with no wallet there is no Agent, and the failure says what to run", async () => {
  const context = fakeContext({ wallets: [] });
  const result = await runSettle(deps(context), { service: SERVICE_ID, asset: USDC, amount: "1", broadcast: false });
  assert.equal(result.error.code, "WALLET_MISSING");
});
