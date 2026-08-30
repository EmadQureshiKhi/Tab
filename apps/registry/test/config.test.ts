/**
 * Configuration loading, including the mistakes it has to catch.
 *
 * The one worth naming: `.env.example` ships every contract address as the zero
 * address, so an unfilled environment is the *expected* mistake rather than an exotic
 * one. A provider filtering on the zero address returns no logs at all, which
 * produces an indexer that starts, reports healthy, and indexes nothing — the worst
 * failure shape available. So the zero address is rejected by name at load time.
 *
 * Requirements: 12.6, 24.4, 28.6
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CREDITCOIN_CC3_TESTNET_CHAIN_ID, loadConfig, readProcessEnvironment } from "../src/config.js";

/**
 * Realistic addresses, not live configuration.
 *
 * These were copied from `deployments.json` when the fixture was written and are deliberately not
 * kept in step with it: nothing here reads that file or asserts against it, so the subject is the
 * loader's handling of well-formed addresses rather than any particular deployment. Some of them name
 * contracts superseded by the 2026-09-06 redeploy, which is harmless and is why they are described
 * this way rather than as current.
 */
const complete = {
  CREDITCOIN_RPC_URL: "https://rpc.cc3-testnet.creditcoin.network",
  CREDITCOIN_CHAIN_ID: "102031",
  RPC_BATCH_MAX_COUNT: "1",
  SETTLEMENT_VERIFIER_ADDRESS: "0xc5c83782f315b321Cd8e18B4C2e05df4050C3854",
  TAB_BOOK_ADDRESS: "0x7974db23B02bA3c109994cc9337c1dBd900AC5Ba",
  AGENT_REGISTRY_ADDRESS: "0xf3066dC828c2D7043A5587fcb5bB23350746103e",
  SERVICE_REGISTRY_ADDRESS: "0xF6Bb0d068698e504e2F21ca61c48167634a1fcAC",
  // Required since the Bond ledger events joined the indexed set: `Bond` is a
  // fifth event source, and its ledger is what free Bond and the Credit Limit's
  // bond cap are derived from.
  BOND_ADDRESS: "0x726B13fc534Ed6A3F063737Fd39000602BB66E4B",
  DATABASE_URL: "postgres://user:password@localhost:5432/tab",
} as const;

test("a complete environment loads, and addresses are lowercased", () => {
  const config = loadConfig(complete);
  assert.equal(config.chainId, CREDITCOIN_CC3_TESTNET_CHAIN_ID);
  assert.equal(config.addresses.TabBook, "0x7974db23b02ba3c109994cc9337c1dbd900ac5ba");
  assert.equal(config.addresses.SettlementVerifier, "0xc5c83782f315b321cd8e18b4c2e05df4050c3854");
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
  assert.throws(() => loadConfig({ ...complete, CREDITCOIN_RPC_URL: "" }), /CREDITCOIN_RPC_URL is required/);
  assert.throws(() => loadConfig({ ...complete, DATABASE_URL: undefined }), /DATABASE_URL is required/);
  assert.throws(() => loadConfig({ ...complete, AGENT_REGISTRY_ADDRESS: "0x1234" }), /not a 20-byte hex address/);
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
