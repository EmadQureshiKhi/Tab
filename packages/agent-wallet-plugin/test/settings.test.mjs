import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { MAINNET_DEFAULTS, TESTNET_DEFAULTS, DEFAULT_CHAIN_ID, MAINNET_CHAIN_ID } from "../dist/defaults.js";
import { resolvePluginSettings } from "../dist/settings.js";

test("the Testnet defaults are the addresses deployments.json records", () => {
  const path = resolve(import.meta.dirname, "..", "..", "..", "deployments.json");
  if (!existsSync(path)) return;
  // One entry per network, keyed by chain id; these defaults are the Testnet one.
  const recorded = JSON.parse(readFileSync(path, "utf8")).networks["10143"];
  assert.equal(recorded.chainId, DEFAULT_CHAIN_ID);
  assert.equal(recorded.contracts.TabBook.address.toLowerCase(), TESTNET_DEFAULTS.tabBook);
  assert.equal(recorded.contracts.TabSettlement.address.toLowerCase(), TESTNET_DEFAULTS.tabSettlement);
  assert.equal(recorded.contracts.ServiceRegistry.address.toLowerCase(), TESTNET_DEFAULTS.serviceRegistry);
  assert.equal(recorded.explorerUrl, TESTNET_DEFAULTS.explorerUrl);
  assert.equal(recorded.rpcUrl, TESTNET_DEFAULTS.rpcUrl);
  assert.equal(recorded.contracts.MockUsdc.address.toLowerCase(), TESTNET_DEFAULTS.mockUsdc);
});

test("the Mainnet defaults are the addresses deployments.json records", () => {
  const path = resolve(import.meta.dirname, "..", "..", "..", "deployments.json");
  if (!existsSync(path)) return;
  const recorded = JSON.parse(readFileSync(path, "utf8")).networks["143"];
  assert.equal(recorded.chainId, MAINNET_CHAIN_ID);
  assert.equal(recorded.contracts.TabBook.address.toLowerCase(), MAINNET_DEFAULTS.tabBook);
  assert.equal(recorded.contracts.TabSettlement.address.toLowerCase(), MAINNET_DEFAULTS.tabSettlement);
  assert.equal(recorded.contracts.ServiceRegistry.address.toLowerCase(), MAINNET_DEFAULTS.serviceRegistry);
  assert.equal(recorded.explorerUrl, MAINNET_DEFAULTS.explorerUrl);
  assert.equal(recorded.rpcUrl, MAINNET_DEFAULTS.rpcUrl);
});

test("an empty environment resolves to the Testnet deployment and says so", () => {
  const result = resolvePluginSettings({});
  assert.ok(result.ok);
  assert.equal(result.value.chainId, 10143);
  assert.equal(result.value.tabBook, TESTNET_DEFAULTS.tabBook);
  assert.equal(result.value.tabSettlement, TESTNET_DEFAULTS.tabSettlement);
  assert.equal(result.value.registryUrl, undefined);
  assert.equal(result.value.rpcUrl, undefined);
  assert.equal(result.value.explorerUrl, "https://testnet.monadvision.com");
  assert.match(result.value.sources.TAB_BOOK_ADDRESS, /default/);
});

test("the environment overrides every default and is named as the source", () => {
  const result = resolvePluginSettings({
    TAB_BOOK_ADDRESS: "0x00000000000000000000000000000000000000B1",
    TAB_SETTLEMENT_ADDRESS: "0x00000000000000000000000000000000000000B2",
    NEXT_PUBLIC_REGISTRY_API_URL: "http://registry.test/",
    MONAD_CHAIN_ID: "10143",
    MONAD_RPC_URL: "http://rpc.test",
    MONAD_EXPLORER_URL: "https://explorer.test",
  });
  assert.ok(result.ok);
  assert.equal(result.value.tabBook, "0x00000000000000000000000000000000000000b1");
  assert.equal(result.value.tabSettlement, "0x00000000000000000000000000000000000000b2");
  assert.equal(result.value.registryUrl, "http://registry.test/");
  assert.equal(result.value.rpcUrl, "http://rpc.test");
  assert.equal(result.value.explorerUrl, "https://explorer.test");
  assert.equal(result.value.sources.TAB_BOOK_ADDRESS, "env TAB_BOOK_ADDRESS");
});

test("the zero-address placeholder from .env.example is refused by name", () => {
  const result = resolvePluginSettings({ TAB_BOOK_ADDRESS: `0x${"0".repeat(40)}` });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "ADDRESS_PLACEHOLDER");
  assert.equal(result.error.details.variable, "TAB_BOOK_ADDRESS");
});

test("naming Mainnet resolves to the Mainnet deployment, with no test token", () => {
  const result = resolvePluginSettings({ MONAD_CHAIN_ID: "143" });
  assert.ok(result.ok);
  assert.equal(result.value.tabBook, MAINNET_DEFAULTS.tabBook);
  assert.equal(result.value.tabSettlement, MAINNET_DEFAULTS.tabSettlement);
  assert.equal(result.value.explorerUrl, "https://monadvision.com");
  assert.equal(result.value.mockUsdc, undefined);
  assert.equal(result.value.sources.TAB_BOOK_ADDRESS, "default (Monad Mainnet deployment)");

  const overridden = resolvePluginSettings({ MONAD_CHAIN_ID: "143", TAB_BOOK_ADDRESS: `0x${"b1".repeat(20)}` });
  assert.ok(overridden.ok);
  assert.equal(overridden.value.tabBook, `0x${"b1".repeat(20)}`);
  assert.equal(overridden.value.sources.TAB_BOOK_ADDRESS, "env TAB_BOOK_ADDRESS");
});

test("Testnet names its test token, from the environment or the recorded deployment", () => {
  const recorded = resolvePluginSettings({});
  assert.ok(recorded.ok);
  assert.equal(recorded.value.mockUsdc, TESTNET_DEFAULTS.mockUsdc);

  const named = resolvePluginSettings({ MOCK_USDC_ADDRESS: `0x${"c3".repeat(20)}` });
  assert.ok(named.ok);
  assert.equal(named.value.mockUsdc, `0x${"c3".repeat(20)}`);
  assert.equal(named.value.sources.MOCK_USDC_ADDRESS, "env MOCK_USDC_ADDRESS");
});

test("a chain id that is not a Monad network is refused", () => {
  assert.equal(resolvePluginSettings({ MONAD_CHAIN_ID: "1" }).error.code, "CHAIN_ID_UNSUPPORTED");
  assert.equal(resolvePluginSettings({ MONAD_CHAIN_ID: "ten" }).error.code, "CHAIN_ID_MALFORMED");
  assert.equal(resolvePluginSettings({ TAB_SETTLEMENT_ADDRESS: "0x12" }).error.code, "ADDRESS_MALFORMED");
});
