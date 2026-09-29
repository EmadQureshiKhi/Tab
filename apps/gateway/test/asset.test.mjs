/**
 * The Asset label the gateway quotes under.
 *
 * Every charge block and x402 offer carries the symbol, so a gateway metering in
 * AUSD must not call it USDC, and the Testnet mock must never be read as Circle's
 * token. None of these cases touches the network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder } from "ethers";

import { MAINNET_ASSETS, TESTNET_ASSETS } from "@tabai/shared";

import { resolveAssetLabel } from "../dist/asset.js";

const MOCK_USDC = "0x480209747417f5c830fDA188a9b9AcFa70Bc4083";
const UNKNOWN = `0x${"7a".repeat(20)}`;

/** A provider that fails the test if it is asked anything. */
const silent = { call: async () => assert.fail("a known Asset needs no chain read") };

test("the Testnet mock is mUSDC, whatever case its address arrives in", async () => {
  const label = await resolveAssetLabel(silent, MOCK_USDC.toLowerCase(), 10143, MOCK_USDC);
  assert.deepEqual(label, { ok: true, value: { symbol: "mUSDC", decimals: 6 } });
});

test("a stablecoin in the shared tables is named from them, per network", async () => {
  assert.deepEqual(await resolveAssetLabel(silent, MAINNET_ASSETS.AUSD.address, 143, undefined), {
    ok: true,
    value: { symbol: "AUSD", decimals: 6 },
  });
  assert.deepEqual(await resolveAssetLabel(silent, MAINNET_ASSETS.USDC.address.toLowerCase(), 143, undefined), {
    ok: true,
    value: { symbol: "USDC", decimals: 6 },
  });
  assert.deepEqual(await resolveAssetLabel(silent, TESTNET_ASSETS.USDC.address, 10143, MOCK_USDC), {
    ok: true,
    value: { symbol: "USDC", decimals: 6 },
  });
});

test("any other token is asked for its own symbol and decimals", async () => {
  const coder = AbiCoder.defaultAbiCoder();
  const answers = { "0x95d89b41": coder.encode(["string"], ["WMON"]), "0x313ce567": coder.encode(["uint8"], [18]) };
  const provider = { call: async ({ to, data }) => (assert.equal(to, UNKNOWN), answers[data.slice(0, 10)]) };
  assert.deepEqual(await resolveAssetLabel(provider, UNKNOWN, 143, undefined), {
    ok: true,
    value: { symbol: "WMON", decimals: 18 },
  });
});

test("a token that cannot say what it is refuses rather than being guessed at", async () => {
  const provider = { call: async () => { throw new Error("execution reverted"); } };
  const label = await resolveAssetLabel(provider, UNKNOWN, 10143, MOCK_USDC);
  assert.equal(label.ok, false);
  assert.equal(label.error.code, "ASSET_UNRECOGNISED");
  assert.match(label.error.message, new RegExp(UNKNOWN));
});
