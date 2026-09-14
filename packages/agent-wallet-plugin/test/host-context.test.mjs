import assert from "node:assert/strict";
import { test } from "node:test";

import { createHost, selectedEvmAddress } from "../dist/host-context.js";
import { AGENT, fakeContext, fakeIo, USDC } from "./fixtures.mjs";

const OTHER = "0x00000000000000000000000000000000000000d2";

test("the selected wallet wins, by id, by address, or by name", () => {
  const roster = { byokWallets: [{ id: "byok:evm:0", namespace: "evm", address: AGENT, name: "first" }, { id: "byok:evm:1", namespace: "evm", address: OTHER, name: "second" }] };
  assert.deepEqual(selectedEvmAddress({ ...roster, selectedWallet: { namespace: "evm", ref: { id: "byok:evm:1" } } }), { ok: true, value: OTHER });
  assert.deepEqual(selectedEvmAddress({ ...roster, selectedWallet: { namespace: "evm", ref: { address: OTHER.toUpperCase().replace("0X", "0x") } } }), { ok: true, value: OTHER });
  assert.deepEqual(selectedEvmAddress({ ...roster, selectedWallet: { namespace: "evm", ref: { name: "second" } } }), { ok: true, value: OTHER });
});

test("with no selection, or a Solana selection, the first EVM wallet is the Agent", () => {
  assert.deepEqual(selectedEvmAddress({ byokWallets: [{ address: AGENT }] }), { ok: true, value: AGENT });
  assert.deepEqual(
    selectedEvmAddress({
      byokWallets: [{ id: "byok:solana:0", namespace: "solana", address: "So1anaAddress" }, { id: "byok:evm:0", namespace: "evm", address: AGENT }],
      selectedWallet: { namespace: "solana", ref: { id: "byok:solana:0" } },
    }),
    { ok: true, value: AGENT },
  );
  assert.deepEqual(selectedEvmAddress({ remoteWallets: [{ address: OTHER }] }), { ok: true, value: OTHER });
});

test("an empty roster is WALLET_MISSING, with the remedy in the message", () => {
  const result = selectedEvmAddress({ byokWallets: [], remoteWallets: [] });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "WALLET_MISSING");
  assert.match(result.error.message, /mm init/);
});

test("a host without the read members reports the capability by name", async () => {
  const host = createHost({ ctx: {}, io: fakeIo({}), commandId: "tab:status" });
  const address = host.wallet().address();
  assert.equal(address.error.code, "CAPABILITY_MISSING");
  assert.equal(address.error.details.capability, "wallet-read");
  const call = await host.chain(10143).call(USDC, "0x");
  assert.equal(call.error.code, "CAPABILITY_MISSING");
  const submitter = await host.submitter();
  assert.equal(submitter.error.code, "CAPABILITY_MISSING");
  assert.equal(submitter.error.details.capability, "wallet-submit");
});

test("the submitter hands the executor a transaction request with the command as its source and waits for the receipt", async () => {
  const { ctx, requests, executorCalls } = fakeContext({ status: "CONFIRMED" });
  const io = fakeIo({});
  const host = createHost({ ctx, io, commandId: "tab:settle" });
  const submitter = await host.submitter();
  assert.ok(submitter.ok);
  const sent = await submitter.value.submit({ chainId: 10143, to: USDC, data: "0xabcdef", summary: "Approve", details: { a: "b" } });
  assert.ok(sent.ok);
  assert.equal(sent.value.status, "CONFIRMED");
  assert.match(sent.value.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(executorCalls[0].source, "tab:settle");
  assert.equal(executorCalls[0].io, io);
  assert.deepEqual(requests[0].request, {
    kind: "transaction",
    chainId: 10143,
    transaction: { to: USDC, data: "0xabcdef" },
    intent: { summary: "Approve", action: "call", details: { a: "b" } },
  });
  assert.deepEqual(requests[0].opts, { waitForReceipt: true });
});

test("a denied or failed job is an error carrying the wallet's status, never a hash presented as success", async () => {
  for (const status of ["DENIED", "FAILED", "BROADCAST_FAILED", "EXPIRED"]) {
    const { ctx } = fakeContext({ status });
    const host = createHost({ ctx, io: fakeIo({}), commandId: "tab:settle" });
    const submitter = await host.submitter();
    const sent = await submitter.value.submit({ chainId: 10143, to: USDC, data: "0x", summary: "x", details: {} });
    assert.ok(!sent.ok, status);
    assert.equal(sent.error.category, "CHAIN");
    assert.equal(sent.error.details.status, status);
  }
  const { ctx } = fakeContext({ status: "CONFIRMED", failureCode: "POLICY_DENIED" });
  const host = createHost({ ctx, io: fakeIo({}), commandId: "tab:settle" });
  const submitter = await host.submitter();
  const sent = await submitter.value.submit({ chainId: 10143, to: USDC, data: "0x", summary: "x", details: {} });
  assert.equal(sent.error.code, "POLICY_DENIED");
  assert.match(sent.error.message, /policy said no/);
});

test("an executor that throws becomes a SUBMISSION_FAILED result", async () => {
  const ctx = { walletExecutor: async () => async () => { throw new Error("no session"); } };
  const host = createHost({ ctx, io: fakeIo({}), commandId: "tab:settle" });
  const submitter = await host.submitter();
  const sent = await submitter.value.submit({ chainId: 10143, to: USDC, data: "0x", summary: "x", details: {} });
  assert.equal(sent.error.code, "SUBMISSION_FAILED");
  assert.equal(sent.error.cause.message, "no session");
});

test("the chain reader goes through the wallet's public client for the chain asked for", async () => {
  const { ctx } = fakeContext({ allowance: 7n });
  const host = createHost({ ctx, io: fakeIo({}), commandId: "tab:settle" });
  const answer = await host.chain(10143).call(USDC, "0x1234");
  assert.ok(answer.ok);
  assert.equal(BigInt(answer.value), 7n);
});
