/**
 * The composition the server and both drivers share.
 *
 * The reason it is shared rather than repeated is that a driver reporting what the
 * served app would do has to be the served app, minus the socket. So the two facts
 * asserted here are the ones a divergence would show up in first: the block tag
 * every read is pinned to, and the tool word the applied price list is keyed by.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeBytes32String } from "ethers";

import { assetFor, createRuntime, proofToolWord, BLOCK_TAG, HISTORY_FROM_BLOCK } from "../dist/runtime.js";
import { loadProofServiceConfig } from "../dist/config.js";
import { PROOF_TOOL_NAME } from "../dist/server.js";

const SERVICE_ID = "0x7461622e70726f6f662d73657276696365000000000000000000000000000000";

const config = (overrides = {}) =>
  loadProofServiceConfig({
    CREDITCOIN_RPC_URL: "https://rpc.example",
    CREDITCOIN_CHAIN_ID: "102031",
    TAB_BOOK_ADDRESS: "0x047ECFB428FE706eA391B626872Ce8Deb8756c5f",
    SERVICE_REGISTRY_ADDRESS: "0xF6Bb0d068698e504e2F21ca61c48167634a1fcAC",
    BOND_ADDRESS: "0xDbB6C19A4236ACdd8535E993C5fA93E6Ff1f173A",
    GATEWAY_SERVICE_ID: SERVICE_ID,
    ...overrides,
  }).value;

test("every read is pinned to one tag, and it is not the moving head", () => {
  assert.equal(BLOCK_TAG, "finalized");
});

test("the history scan starts at the deployment block the registry also starts from", () => {
  assert.equal(HISTORY_FROM_BLOCK, 5_407_360);
});

test("the tool word decodes back to the name the price list is keyed by", () => {
  assert.equal(decodeBytes32String(proofToolWord()), PROOF_TOOL_NAME);
  assert.equal(PROOF_TOOL_NAME, "proof.generate");
});

test("an Asset with no configured address is named rather than defaulted", () => {
  const asset = assetFor(config(), 1n);
  assert.equal(asset.ok, false);
  assert.equal(asset.error.code, "ASSET_NOT_CONFIGURED");
  assert.match(asset.error.message, /SEPOLIA_USDC_ADDRESS/);
});

test("a configured Asset carries its chainKey, decimals and symbol", () => {
  const asset = assetFor(config({ SEPOLIA_USDC_ADDRESS: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" }), 1n);
  assert.equal(asset.ok, true);
  assert.equal(asset.value.chainKey, 1n);
  assert.equal(asset.value.decimals, 6);
  assert.equal(asset.value.symbol, "USDC");
  assert.equal(asset.value.address, "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238");
});

test("a read-only runtime builds with no key and offers every seam the server uses", () => {
  const runtime = createRuntime({ config: config() });
  assert.equal(typeof runtime.deliverer.deliver, "function");
  assert.equal(typeof runtime.tabBook.simulateDelivery, "function");
  assert.equal(typeof runtime.attestation.latestAttestation, "function");
  assert.match(runtime.source.describe, /Proof Builder API/);
});

test("a runtime with no signer refuses to record rather than serving a delivery free", async () => {
  const runtime = createRuntime({ config: config() });
  const recorded = await runtime.tabBook.recordDelivery({
    agent: `0x${"11".repeat(20)}`,
    serviceId: SERVICE_ID,
    asset: `0x${"22".repeat(20)}`,
    tool: `0x${"33".repeat(32)}`,
    units: 1,
    expectedUnitPrice: 10_000n,
  });
  assert.equal(recorded.ok, false);
  assert.equal(recorded.error.code, "PROOF_SERVICE_KEY_MISSING");
});
