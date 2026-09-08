/**
 * Gasless settlement: the Permit2 signature and the relayed strategy.
 *
 * The signature is checked by recovering it over the exact typed data the
 * contract rebuilds, with the domain and types the shared package pins, so a
 * field that drifts on either side fails here rather than as a mined revert.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet, verifyTypedData } from "ethers";
import {
  PERMIT2_ADDRESS,
  PERMIT2_WITNESS_TRANSFER_FROM_TYPES,
  permit2Domain,
} from "@tabai/shared";
import {
  createRelayedMonadStrategy,
  encodeSettleWithPermit2,
  fromRelayBody,
  signSettlementPermit,
  toRelayBody,
} from "../dist/payments/index.js";

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const AGENT_KEY = `0x${"11".repeat(32)}`;
const TAB_SETTLEMENT = "0x654Fac48185e4B71779eEc2457B1F24aEdf46717";
const USDC = { chainId: 10143n, address: "0x534b2f3A21130d7a60830c2Df862319e593943A3", decimals: 6, symbol: "USDC" };
const SERVICE_ID = "0x7461622e64656d6f000000000000000000000000000000000000000000000000";

test("a settlement permit recovers to the Agent over Permit2's typed data", async () => {
  const wallet = new Wallet(AGENT_KEY);
  const permit = await signSettlementPermit({
    signer: wallet,
    chainId: 10143,
    tabSettlement: TAB_SETTLEMENT,
    serviceId: SERVICE_ID,
    asset: USDC.address,
    amount: 47_000n,
    nonce: 7n,
    deadline: 1_800_000_000n,
  });
  assert.equal(permit.ok, true, permit.ok ? "" : permit.error.message);
  assert.equal(permit.value.agent, wallet.address);
  assert.equal(permit.value.permit2, PERMIT2_ADDRESS);
  const recovered = verifyTypedData(
    permit2Domain(10143, PERMIT2_ADDRESS),
    PERMIT2_WITNESS_TRANSFER_FROM_TYPES,
    {
      permitted: { token: USDC.address, amount: 47_000n },
      spender: TAB_SETTLEMENT,
      nonce: 7n,
      deadline: 1_800_000_000n,
      witness: { serviceId: SERVICE_ID, asset: USDC.address, amount: 47_000n, surface: TAB_SETTLEMENT, chainId: 10143n },
    },
    permit.value.signature,
  );
  assert.equal(recovered, wallet.address);

  // A body round-trips, and calldata targets settleWithPermit2.
  const body = toRelayBody(permit.value);
  const back = fromRelayBody(body);
  assert.equal(back.ok, true);
  assert.deepEqual({ ...back.value, signature: back.value.signature.toLowerCase() }, { ...permit.value, signature: permit.value.signature.toLowerCase() });
  assert.match(encodeSettleWithPermit2(permit.value), /^0x[0-9a-f]{8}/);
});

test("a permit refuses an amount outside uint128 and a nonce-less default is random", async () => {
  const wallet = new Wallet(AGENT_KEY);
  const tooBig = await signSettlementPermit({ signer: wallet, chainId: 10143, tabSettlement: TAB_SETTLEMENT, serviceId: SERVICE_ID, asset: USDC.address, amount: 1n << 128n });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.error.code, "AMOUNT_OUT_OF_RANGE");
  const one = await signSettlementPermit({ signer: wallet, chainId: 10143, tabSettlement: TAB_SETTLEMENT, serviceId: SERVICE_ID, asset: USDC.address, amount: 1n });
  const two = await signSettlementPermit({ signer: wallet, chainId: 10143, tabSettlement: TAB_SETTLEMENT, serviceId: SERVICE_ID, asset: USDC.address, amount: 1n });
  assert.notEqual(one.value.nonce, two.value.nonce, "unordered nonces are drawn at random");
  assert.ok(one.value.deadline > BigInt(Math.floor(Date.now() / 1000)), "the default deadline is in the future");
});

test("a relay body that is not a permit is refused before any signature is checked", () => {
  for (const bad of [null, {}, { agent: "0x12" }, { agent: `0x${"aa".repeat(20)}`, serviceId: "0x00", asset: `0x${"bb".repeat(20)}`, tabSettlement: TAB_SETTLEMENT, amount: "1", nonce: "1", deadline: "1", chainId: "1", signature: "0x00" }]) {
    const parsed = fromRelayBody(bad);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "RELAY_BODY_INVALID");
  }
});

/** A signer whose provider answers the Permit2 allowance read with a fixed figure. */
function signerWithAllowance(allowance) {
  const wallet = new Wallet(AGENT_KEY);
  const provider = {
    async call() {
      return `0x${allowance.toString(16).padStart(64, "0")}`;
    },
  };
  return wallet.connect(provider);
}

test("the relayed strategy signs, posts the permit, and reads the receipt back", async () => {
  const posted = [];
  const strategy = createRelayedMonadStrategy({
    signer: signerWithAllowance(1n << 200n),
    tabSettlement: TAB_SETTLEMENT,
    relayUrl: "http://gateway.test/relay/settle",
    assets: { [`10143:${USDC.address.toLowerCase()}`]: USDC },
    fetchImpl: async (url, init) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return {
        status: 200,
        json: async () => ({ ok: true, txHash: `0x${"ee".repeat(32)}`, settlementId: `0x${"ab".repeat(32)}`, applied: "47000", toPrepaid: "0" }),
      };
    },
    logger: silent,
  });
  assert.equal(strategy.id, "monad-relayed");
  assert.deepEqual(strategy.chainIds, [10143n]);
  assert.equal(strategy.supports(USDC), true);

  const receipt = await strategy.settle({ agent: new Wallet(AGENT_KEY).address, serviceId: SERVICE_ID, asset: USDC, amount: 47_000n });
  assert.equal(receipt.ok, true, receipt.ok ? "" : receipt.error.message);
  assert.equal(receipt.value.txHash, `0x${"ee".repeat(32)}`);
  assert.equal(receipt.value.settlementId, `0x${"ab".repeat(32)}`);
  assert.equal(receipt.value.applied, 47_000n);
  assert.equal(receipt.value.toPrepaid, 0n);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "http://gateway.test/relay/settle");
  assert.equal(posted[0].body.amount, "47000");
  assert.equal(posted[0].body.tabSettlement, TAB_SETTLEMENT);
  // The relay body is self-authenticating: what was posted recovers to the Agent.
  const back = fromRelayBody(posted[0].body);
  assert.equal(back.ok, true);
  assert.equal(back.value.agent, new Wallet(AGENT_KEY).address);
});

test("a missing Permit2 approval is named, and a refusing relay is reported as its own error", async () => {
  const unapproved = createRelayedMonadStrategy({
    signer: signerWithAllowance(0n),
    tabSettlement: TAB_SETTLEMENT,
    relayUrl: "http://gateway.test/relay/settle",
    assets: { [`10143:${USDC.address.toLowerCase()}`]: USDC },
    fetchImpl: async () => {
      throw new Error("must not be reached");
    },
    logger: silent,
  });
  const refused = await unapproved.settle({ agent: new Wallet(AGENT_KEY).address, serviceId: SERVICE_ID, asset: USDC, amount: 1n });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "PERMIT2_ALLOWANCE_MISSING");

  const relayRefuses = createRelayedMonadStrategy({
    signer: signerWithAllowance(1n << 200n),
    tabSettlement: TAB_SETTLEMENT,
    relayUrl: "http://gateway.test/relay/settle",
    assets: { [`10143:${USDC.address.toLowerCase()}`]: USDC },
    fetchImpl: async () => ({ status: 409, json: async () => ({ ok: false, error: { category: "CONFLICT", code: "PERMIT_NONCE_USED", message: "spent" } }) }),
    logger: silent,
  });
  const conflict = await relayRefuses.settle({ agent: new Wallet(AGENT_KEY).address, serviceId: SERVICE_ID, asset: USDC, amount: 1n });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "PERMIT_NONCE_USED");
});
