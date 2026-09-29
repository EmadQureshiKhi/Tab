/**
 * Configuration loading, including the mistakes it has to catch.
 *
 * The one worth naming: `.env.example` ships every contract address as the zero
 * address, so an unfilled environment is the *expected* mistake rather than an exotic
 * one. A provider filtering on the zero address returns no logs at all, which
 * produces an indexer that starts, reports healthy, and indexes nothing, the worst
 * failure shape available. So the zero address is rejected by name at load time.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { MONAD_TESTNET_CHAIN_ID, loadConfig, readProcessEnvironment, watchedAddresses } from "../src/config.js";
import { ERC8004_REGISTRIES } from "@tabai/shared";

/**
 * The Testnet deployment's addresses, in checksum case so the lowercasing is observable.
 *
 * Nothing here reads `deployments.json` or asserts against it: the subject is the loader's
 * handling of well-formed addresses rather than any particular deployment.
 */
const complete = {
  MONAD_RPC_URL: "https://testnet-rpc.monad.xyz",
  MONAD_CHAIN_ID: "10143",
  RPC_BATCH_MAX_COUNT: "1",
  TAB_BOOK_ADDRESS: "0x87571030cCe27C84836bAfF85288eB1d85d908a4",
  TAB_SETTLEMENT_ADDRESS: "0x654Fac48185e4B71779eEc2457B1F24aEdf46717",
  SERVICE_REGISTRY_ADDRESS: "0x3638DB35A76E5a22EA1E827636dA994be622c139",
  BOND_ADDRESS: "0x29aDfD90Fc7c9026563Fc60651f696ab089080E7",
  DATABASE_URL: "postgres://user:password@localhost:5432/tab",
} as const;

test("a complete environment loads, and addresses are lowercased", () => {
  const config = loadConfig(complete);
  assert.equal(config.chainId, MONAD_TESTNET_CHAIN_ID);
  assert.equal(config.addresses.TabBook, "0x87571030cce27c84836baff85288eb1d85d908a4");
  assert.equal(config.addresses.TabSettlement, "0x654fac48185e4b71779eec2457b1f24aedf46717");
});

test("batching stays at one call per request unless the environment says otherwise", () => {
  // Several endpoints on this network reject JSON-RPC batching outright, so one is the
  // default as well as the pinned value.
  assert.equal(loadConfig({ ...complete, RPC_BATCH_MAX_COUNT: undefined }).batchMaxCount, 1);
  assert.equal(loadConfig(complete).batchMaxCount, 1);
});

test("the unfilled zero address is rejected by name", () => {
  assert.throws(
    () => loadConfig({ ...complete, TAB_BOOK_ADDRESS: "0x0000000000000000000000000000000000000000" }),
    /TAB_BOOK_ADDRESS is the zero address/,
  );
});

test("a missing or malformed value names the variable and never prints it", () => {
  assert.throws(() => loadConfig({ ...complete, MONAD_RPC_URL: "" }), /MONAD_RPC_URL is required/);
  assert.throws(() => loadConfig({ ...complete, DATABASE_URL: undefined }), /DATABASE_URL is required/);
  assert.throws(() => loadConfig({ ...complete, TAB_SETTLEMENT_ADDRESS: "0x1234" }), /not a 20-byte hex address/);
  assert.throws(() => loadConfig({ ...complete, REGISTRY_PORT: "-1" }), /REGISTRY_PORT/);
  assert.throws(() => loadConfig({ ...complete, REGISTRY_START_BLOCK: "one" }), /REGISTRY_START_BLOCK/);

  try {
    loadConfig({ ...complete, DATABASE_URL: "" });
    assert.fail("expected a failure");
  } catch (error) {
    // A database URL carries a password. The message must name the variable and stop.
    assert.equal(String(error).includes("password"), false);
  }
});

test("two contracts configured at one address is rejected", () => {
  assert.throws(
    () => loadConfig({ ...complete, TAB_BOOK_ADDRESS: complete.SERVICE_REGISTRY_ADDRESS }),
    /same address/,
  );
});

test("the ERC-8004 registries default from the chain id and can be overridden or switched off", () => {
  const testnet = loadConfig(complete);
  // The shared package carries checksummed addresses; this service lowercases everything.
  assert.deepEqual(testnet.erc8004, {
    identityRegistry: ERC8004_REGISTRIES[MONAD_TESTNET_CHAIN_ID].identity.toLowerCase(),
    reputationRegistry: ERC8004_REGISTRIES[MONAD_TESTNET_CHAIN_ID].reputation.toLowerCase(),
  });
  assert.equal(watchedAddresses(testnet).IdentityRegistry, "0x8004a818bfb912233c491871b3d84c89a494bd9e");

  const mainnet = loadConfig({ ...complete, MONAD_CHAIN_ID: "143" });
  assert.equal(mainnet.erc8004?.identityRegistry, "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432");

  // A chain with no canonical deployment has no identity unless one is named.
  assert.equal(loadConfig({ ...complete, MONAD_CHAIN_ID: "31337" }).erc8004, null);
  const named = loadConfig({
    ...complete,
    MONAD_CHAIN_ID: "31337",
    ERC8004_IDENTITY_REGISTRY_ADDRESS: "0x00000000000000000000000000000000000080A4",
  });
  assert.equal(named.erc8004?.identityRegistry, "0x00000000000000000000000000000000000080a4");
  assert.equal(named.erc8004?.reputationRegistry, null, "no Reputation registry unless named");

  // The zero address is the one explicit "off", and it takes the Reputation registry with it.
  const off = loadConfig({ ...complete, ERC8004_IDENTITY_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000000" });
  assert.equal(off.erc8004, null);
  assert.equal("IdentityRegistry" in watchedAddresses(off), false);

  assert.throws(() => loadConfig({ ...complete, ERC8004_IDENTITY_REGISTRY_ADDRESS: "0x1234" }), /not a 20-byte hex address/);
  // The registry is a watched contract like the other four, so a clash is caught.
  assert.throws(
    () => loadConfig({ ...complete, ERC8004_IDENTITY_REGISTRY_ADDRESS: complete.BOND_ADDRESS }),
    /same address/,
  );
});

test("HyperSync is off without a URL and validated with one", () => {
  assert.equal(loadConfig(complete).hypersync, null);
  const on = loadConfig({ ...complete, HYPERSYNC_URL: "https://monad-testnet.hypersync.xyz" });
  assert.deepEqual(on.hypersync, {
    url: "https://monad-testnet.hypersync.xyz",
    apiToken: null,
    liveWindowBlocks: 512,
    chunkBlocks: 100_000,
  });
  const tuned = loadConfig({
    ...complete,
    HYPERSYNC_URL: "https://monad.hypersync.xyz",
    HYPERSYNC_API_TOKEN: "token",
    HYPERSYNC_LIVE_WINDOW_BLOCKS: "64",
    HYPERSYNC_CHUNK_BLOCKS: "5000",
  });
  assert.equal(tuned.hypersync?.apiToken, "token");
  assert.equal(tuned.hypersync?.liveWindowBlocks, 64);
  assert.equal(tuned.hypersync?.chunkBlocks, 5_000);
  assert.throws(() => loadConfig({ ...complete, HYPERSYNC_URL: "monad.hypersync.xyz" }), /HYPERSYNC_URL/);
  assert.throws(() => loadConfig({ ...complete, HYPERSYNC_URL: "https://x", HYPERSYNC_CHUNK_BLOCKS: "0" }), /HYPERSYNC_CHUNK_BLOCKS/);
});

test("Nansen is off without a key, scoped to all chains by default, and the chain slug is checked", () => {
  assert.equal(loadConfig(complete).nansen, null);
  assert.deepEqual(loadConfig({ ...complete, NANSEN_API_KEY: "k" }).nansen, { apiKey: "k", chain: "all" });
  assert.equal(loadConfig({ ...complete, NANSEN_API_KEY: "k", NANSEN_CHAIN: "monad" }).nansen?.chain, "monad");
  assert.throws(() => loadConfig({ ...complete, NANSEN_API_KEY: "k", NANSEN_CHAIN: "Monad Mainnet" }), /NANSEN_CHAIN/);
});

test("every variable the process reads is declared in .env.example", () => {
  // The completeness check in CI enforces this repository-wide. Asserting it here as
  // well is what makes `readProcessEnvironment` the honest single list it claims to
  // be: a variable added to the loader and not to the template fails right here.
  const template = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env.example"),
    "utf8",
  );
  const declared = new Set(
    template
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.slice(0, line.indexOf("="))),
  );

  for (const name of Object.keys(readProcessEnvironment())) {
    assert.ok(declared.has(name), `${name} is read but not declared in .env.example`);
  }
});
