/**
 * Configuration, which is the only place this service learns anything.
 *
 * Every rejection is asserted by the variable it names, because a service that
 * cannot start is read by an operator who is often not the person who wrote the
 * deployment, and "PROOF_SERVICE_PRICE_BASE_UNITS must be a non-negative integer"
 * is actionable where a stack trace is not.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  loadProofServiceConfig,
  requireCollectionAddress,
  requireOperatorKey,
  DEFAULT_CHAIN_INFO_PRECOMPILE,
  DEFAULT_PROOF_BUILDER_URL,
  DEFAULT_PROOF_PRICE_BASE_UNITS,
  DEFAULT_SETTLEMENT_WINDOW_SECONDS,
} from "../dist/config.js";

const SERVICE_ID = "0x7461622e70726f6f662d73657276696365000000000000000000000000000000";

const COMPLETE = {
  CREDITCOIN_RPC_URL: "https://rpc.cc3-testnet.creditcoin.network",
  CREDITCOIN_CHAIN_ID: "102031",
  TAB_BOOK_ADDRESS: "0x047ECFB428FE706eA391B626872Ce8Deb8756c5f",
  SERVICE_REGISTRY_ADDRESS: "0xF6Bb0d068698e504e2F21ca61c48167634a1fcAC",
  BOND_ADDRESS: "0xDbB6C19A4236ACdd8535E993C5fA93E6Ff1f173A",
  GATEWAY_SERVICE_ID: SERVICE_ID,
};

const load = (overrides = {}) => loadProofServiceConfig({ ...COMPLETE, ...overrides });

test("a complete environment loads and lowercases every address", () => {
  const config = load();
  assert.equal(config.ok, true);
  assert.equal(config.value.tabBook, COMPLETE.TAB_BOOK_ADDRESS.toLowerCase());
  assert.equal(config.value.chainId, 102031);
});

test("the defaults are the deployed facts, not zeroes", () => {
  const config = load();
  assert.equal(config.value.chainInfo, DEFAULT_CHAIN_INFO_PRECOMPILE);
  assert.equal(config.value.proofBuilderUrl, DEFAULT_PROOF_BUILDER_URL);
  assert.equal(config.value.unitPrice, DEFAULT_PROOF_PRICE_BASE_UNITS);
  assert.equal(config.value.settlementWindowSeconds, DEFAULT_SETTLEMENT_WINDOW_SECONDS);
  assert.equal(config.value.batchMaxCount, 1);
});

test("the registered price is 10000 base units per proof", () => {
  assert.equal(DEFAULT_PROOF_PRICE_BASE_UNITS, 10_000n);
  assert.equal(load({ PROOF_SERVICE_PRICE_BASE_UNITS: "10000" }).value.unitPrice, 10_000n);
});

test("a missing RPC URL is named rather than defaulted", () => {
  const config = load({ CREDITCOIN_RPC_URL: "  " });
  assert.equal(config.ok, false);
  assert.equal(config.error.details.variable, "CREDITCOIN_RPC_URL");
});

test("a non-decimal chain id is refused", () => {
  const config = load({ CREDITCOIN_CHAIN_ID: "cc3" });
  assert.equal(config.ok, false);
  assert.equal(config.error.details.variable, "CREDITCOIN_CHAIN_ID");
});

test("a zero-address contract is refused as not deployed yet", () => {
  const config = load({ TAB_BOOK_ADDRESS: `0x${"0".repeat(40)}` });
  assert.equal(config.ok, false);
  assert.match(config.error.message, /not deployed yet/);
});

test("each required address is checked, and the first wrong one is the one named", () => {
  for (const name of ["TAB_BOOK_ADDRESS", "SERVICE_REGISTRY_ADDRESS", "BOND_ADDRESS"]) {
    const config = load({ [name]: "0xnothex" });
    assert.equal(config.ok, false);
    assert.equal(config.error.details.variable, name);
  }
});

test("a service id that is not 32 bytes is refused", () => {
  const config = load({ GATEWAY_SERVICE_ID: "0x1234" });
  assert.equal(config.ok, false);
  assert.equal(config.error.details.variable, "GATEWAY_SERVICE_ID");
});

test("a zero price is refused, because a free tool cannot be metered", () => {
  const config = load({ PROOF_SERVICE_PRICE_BASE_UNITS: "0" });
  assert.equal(config.ok, false);
  assert.match(config.error.message, /free tool cannot be metered/);
});

test("a non-integer price is refused", () => {
  const config = load({ PROOF_SERVICE_PRICE_BASE_UNITS: "1.5" });
  assert.equal(config.ok, false);
  assert.equal(config.error.details.variable, "PROOF_SERVICE_PRICE_BASE_UNITS");
});

test("the template's non-hexadecimal key placeholder reads as no key at all", () => {
  const config = load({ PROOF_SERVICE_PRIVATE_KEY: "0xREPLACE_WITH_YOUR_OWN_64_HEX_CHARACTER_KEY" });
  assert.equal(config.value.operatorKey, undefined);
  const required = requireOperatorKey(config.value);
  assert.equal(required.ok, false);
  assert.equal(required.error.details.variable, "PROOF_SERVICE_PRIVATE_KEY");
});

test("a filled key is carried through", () => {
  const key = `0x${"11".repeat(32)}`;
  const config = load({ PROOF_SERVICE_PRIVATE_KEY: key });
  assert.equal(config.value.operatorKey, key);
  assert.equal(requireOperatorKey(config.value).value, key);
});

test("the zero-address Collection placeholder reads as unset and is named when needed", () => {
  const config = load({ PROOF_SERVICE_COLLECTION_ADDRESS: `0x${"0".repeat(40)}` });
  assert.equal(config.value.collectionAddress, undefined);
  const required = requireCollectionAddress(config.value);
  assert.equal(required.ok, false);
  assert.equal(required.error.details.variable, "PROOF_SERVICE_COLLECTION_ADDRESS");
});

test("a real Collection Address is carried through lowercased", () => {
  const config = load({ PROOF_SERVICE_COLLECTION_ADDRESS: "0x952AcC70E6f54Ce87Dca963193A5957BCb27729e" });
  assert.equal(config.value.collectionAddress, "0x952acc70e6f54ce87dca963193a5957bcb27729e");
  assert.equal(requireCollectionAddress(config.value).ok, true);
});

test("no Source Chain is configured when no Asset address is given", () => {
  assert.deepEqual(load().value.sourceChains, {});
});

test("Sepolia carries a settlement contract and Mainnet deliberately carries none", () => {
  const config = load({
    SEPOLIA_USDC_ADDRESS: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    MAINNET_USDC_ADDRESS: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    SEPOLIA_SETTLEMENT_ADDRESS: "0x10619F16E1ac73AAe41AA4C1619f1387687EED79",
    ETHEREUM_SEPOLIA_RPC_URLS: "https://one.example, https://two.example ,",
  });
  assert.equal(config.value.sourceChains["1"].settlementContract, "0x10619f16e1ac73aae41aa4c1619f1387687eed79");
  assert.deepEqual(config.value.sourceChains["1"].rpcUrls, ["https://one.example", "https://two.example"]);
  assert.equal(config.value.sourceChains["3"].settlementContract, undefined);
  assert.deepEqual(config.value.sourceChains["3"].rpcUrls, []);
});

test("a trailing slash on the Proof Builder URL is trimmed once", () => {
  const config = load({ PROOF_BUILDER_URL: "https://prover.example///" });
  assert.equal(config.value.proofBuilderUrl, "https://prover.example");
});
