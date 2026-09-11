/**
 * The settlement relay: the permit is the authentication, the simulation is the
 * gate, and the receipt is the answer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface, Wallet } from "ethers";
import { TAB_SETTLEMENT_ABI, signSettlementPermit, toRelayBody } from "@tabai/sdk";
import { createSettlementRelay } from "../dist/relay.js";
import { createApp } from "../dist/server.js";

const TAB_SETTLEMENT = "0x654fac48185e4b71779eec2457b1f24aedf46717";
const USDC = "0x534b2f3a21130d7a60830c2df862319e593943a3";
const SERVICE_ID = "0x7461622e64656d6f000000000000000000000000000000000000000000000000";
const AGENT = new Wallet(`0x${"11".repeat(32)}`);
const OPERATOR = new Wallet(`0x${"22".repeat(32)}`);
const surface = new Interface(TAB_SETTLEMENT_ABI);

async function permitBody(overrides = {}) {
  const permit = await signSettlementPermit({
    signer: AGENT,
    chainId: 10143,
    tabSettlement: TAB_SETTLEMENT,
    serviceId: SERVICE_ID,
    asset: USDC,
    amount: 47_000n,
    nonce: 9n,
    deadline: 1_900_000_000n,
    ...overrides,
  });
  assert.equal(permit.ok, true);
  return toRelayBody(permit.value);
}

/** A chain whose simulation and receipt a test dictates. */
function fakeChain({ simulate = async () => "0x", status = 1, settledLog = true } = {}) {
  const calls = [];
  const sent = [];
  const settlementId = `0x${"ab".repeat(32)}`;
  const log = surface.encodeEventLog(surface.getEvent("Settled"), [
    settlementId,
    AGENT.address,
    SERVICE_ID,
    USDC,
    47_000n,
    40_000n,
    7_000n,
    OPERATOR.address,
  ]);
  return {
    calls,
    sent,
    provider: {
      async call(tx) {
        calls.push(tx);
        return simulate(tx);
      },
      async waitForTransaction(hash) {
        return { status, hash, logs: settledLog ? [{ address: TAB_SETTLEMENT, topics: log.topics, data: log.data }] : [] };
      },
    },
    signer: {
      async getAddress() {
        return OPERATOR.address;
      },
      async sendTransaction(tx) {
        sent.push(tx);
        return { hash: `0x${"ee".repeat(32)}` };
      },
    },
  };
}

test("a valid permit is simulated from the operator, sent, and answered with the Settled figures", async () => {
  const chain = fakeChain();
  const relay = createSettlementRelay({ provider: chain.provider, signer: chain.signer, tabSettlement: TAB_SETTLEMENT, chainId: 10143n, now: () => 1_700_000_000_000 });
  const reply = await relay.relay(await permitBody());
  assert.equal(reply.ok, true, reply.ok ? "" : reply.error.message);
  assert.equal(reply.value.txHash, `0x${"ee".repeat(32)}`);
  assert.equal(reply.value.settlementId, `0x${"ab".repeat(32)}`);
  assert.equal(reply.value.applied, "40000");
  assert.equal(reply.value.toPrepaid, "7000");
  assert.equal(chain.calls.length, 1, "simulated once");
  assert.equal(chain.calls[0].from, OPERATOR.address);
  assert.equal(chain.calls[0].to.toLowerCase(), TAB_SETTLEMENT);
  assert.equal(chain.sent.length, 1);
  assert.equal(chain.sent[0].data, chain.calls[0].data, "what was simulated is what was sent");
});

test("the gas stated is the estimate plus the margin, clamped, and the ceiling without an estimate", async () => {
  const { RELAY_GAS_FLOOR, RELAY_GAS_LIMIT } = await import("../dist/relay.js");
  const cases = [
    { estimate: 320_000n, stated: 416_000n, name: "an ordinary estimate carries a 30% margin" },
    { estimate: 100_000n, stated: RELAY_GAS_FLOOR, name: "a small estimate is lifted to the floor" },
    { estimate: 2_000_000n, stated: RELAY_GAS_LIMIT, name: "a huge estimate is held at the ceiling" },
  ];
  for (const { estimate, stated, name } of cases) {
    const chain = fakeChain();
    chain.provider.estimateGas = async () => estimate;
    const relay = createSettlementRelay({ provider: chain.provider, signer: chain.signer, tabSettlement: TAB_SETTLEMENT, chainId: 10143n, now: () => 1_700_000_000_000 });
    const reply = await relay.relay(await permitBody());
    assert.equal(reply.ok, true, name);
    assert.equal(chain.sent[0].gasLimit, stated, name);
  }

  // No estimateGas on the provider: the ceiling, which is never wrong, only dear.
  const bare = fakeChain();
  const relay = createSettlementRelay({ provider: bare.provider, signer: bare.signer, tabSettlement: TAB_SETTLEMENT, chainId: 10143n, now: () => 1_700_000_000_000 });
  await relay.relay(await permitBody());
  assert.equal(bare.sent[0].gasLimit, RELAY_GAS_LIMIT);

  // A failing estimate is the same as none.
  const failing = fakeChain();
  failing.provider.estimateGas = async () => {
    throw new Error("estimate unavailable");
  };
  const relayOverFailing = createSettlementRelay({ provider: failing.provider, signer: failing.signer, tabSettlement: TAB_SETTLEMENT, chainId: 10143n, now: () => 1_700_000_000_000 });
  await relayOverFailing.relay(await permitBody());
  assert.equal(failing.sent[0].gasLimit, RELAY_GAS_LIMIT);
});

test("a revert in simulation is named and nothing is sent", async () => {
  const errors = new Interface(["error InvalidNonce()", "error SignatureExpired(uint256 signatureDeadline)"]);
  const chain = fakeChain({
    simulate: async () => {
      throw Object.assign(new Error("execution reverted"), { data: errors.encodeErrorResult("InvalidNonce", []) });
    },
  });
  const relay = createSettlementRelay({ provider: chain.provider, signer: chain.signer, tabSettlement: TAB_SETTLEMENT, chainId: 10143n, now: () => 1_700_000_000_000 });
  const reply = await relay.relay(await permitBody());
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, "PERMIT_NONCE_USED");
  assert.equal(reply.error.category, "CONFLICT");
  assert.equal(chain.sent.length, 0, "a refusal costs no gas");
});

test("a permit for another chain, another surface, or a past deadline is refused before any chain read", async () => {
  const chain = fakeChain();
  const relay = createSettlementRelay({ provider: chain.provider, signer: chain.signer, tabSettlement: TAB_SETTLEMENT, chainId: 10143n, now: () => 1_700_000_000_000 });

  const otherChain = await relay.relay(await permitBody({ chainId: 143 }));
  assert.equal(otherChain.ok, false);
  assert.equal(otherChain.error.code, "PERMIT_CHAIN_MISMATCH");

  const otherSurface = await relay.relay(await permitBody({ tabSettlement: `0x${"cc".repeat(20)}` }));
  assert.equal(otherSurface.ok, false);
  assert.equal(otherSurface.error.code, "PERMIT_SURFACE_MISMATCH");

  const expired = await relay.relay(await permitBody({ deadline: 1_600_000_000n }));
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, "PERMIT_EXPIRED");

  const garbage = await relay.relay({ hello: "world" });
  assert.equal(garbage.ok, false);
  assert.equal(garbage.error.code, "RELAY_BODY_INVALID");

  assert.equal(chain.calls.length, 0, "nothing reached the chain");
});

test("a mined revert is reported with its hash, and a receipt without a Settled log still answers the hash", async () => {
  const reverted = fakeChain({ status: 0 });
  const relayReverted = createSettlementRelay({ provider: reverted.provider, signer: reverted.signer, tabSettlement: TAB_SETTLEMENT, chainId: 10143n, now: () => 1_700_000_000_000 });
  const failed = await relayReverted.relay(await permitBody());
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "RELAY_REVERTED");
  assert.equal(failed.error.details.txHash, `0x${"ee".repeat(32)}`);

  const bare = fakeChain({ settledLog: false });
  const relayBare = createSettlementRelay({ provider: bare.provider, signer: bare.signer, tabSettlement: TAB_SETTLEMENT, chainId: 10143n, now: () => 1_700_000_000_000 });
  const answered = await relayBare.relay(await permitBody());
  assert.equal(answered.ok, true);
  assert.equal(answered.value.settlementId, null);
});

test("the app serves POST /relay/settle when a relay is configured, and 404 when it is not", async () => {
  const chain = fakeChain();
  const relay = createSettlementRelay({ provider: chain.provider, signer: chain.signer, tabSettlement: TAB_SETTLEMENT, chainId: 10143n, now: () => 1_700_000_000_000 });
  const base = {
    serviceId: SERVICE_ID,
    asset: { chainId: 10143n, address: USDC, decimals: 6, symbol: "USDC" },
    operator: OPERATOR.address,
    tabBook: { simulateDelivery: async () => ({ ok: true, value: {} }), recordDelivery: async () => ({ ok: true, value: {} }), openTabOf: async () => ({ ok: true, value: 0n }), creditLimit: async () => ({ ok: true, value: 0n }) },
    priceOf: () => undefined,
    requireSignature: false,
  };
  const withRelay = createApp({ ...base, relay });
  const okResponse = await withRelay.request("/relay/settle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await permitBody()) });
  assert.equal(okResponse.status, 200);
  const body = await okResponse.json();
  assert.equal(body.ok, true);
  assert.equal(body.applied, "40000");

  const notJson = await withRelay.request("/relay/settle", { method: "POST", body: "nope" });
  assert.equal(notJson.status, 400);

  const withoutRelay = createApp(base);
  const missing = await withoutRelay.request("/relay/settle", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(missing.status, 404);

  const root = await (await withRelay.request("/")).json();
  assert.ok(root.routes.some((route) => route.startsWith("/relay/settle")));
});
