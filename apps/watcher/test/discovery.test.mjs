/**
 * Chain discovery and degraded mode.
 *
 * Every case here runs against a stand-in ChainInfo reader rather than the network,
 * because the questions being asked are about what the Watcher *decides*, and a
 * live chain cannot be asked to stop attesting on demand. The live reads that
 * confirm the ABI itself are in `pnpm --filter @tabai/watcher discover`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { describeDiscovery, discoverChains, loadWatcherConfig } from "../dist/index.js";

const TWO_ENDPOINTS = "https://first.example,https://second.example";

/** Config with two endpoints per chain, which is the minimum the failover rule needs. */
function configWith(overrides = {}) {
  const result = loadWatcherConfig({
    ETHEREUM_SEPOLIA_RPC_URLS: TWO_ENDPOINTS,
    ETHEREUM_MAINNET_RPC_URLS: TWO_ENDPOINTS,
    ...overrides,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  return result.value;
}

/** The two entries the live precompile reports, as measured. */
const SEPOLIA = { chainKey: 1n, chainId: 11155111n, chainName: "Sepolia ethereum", chainNameHex: "0x", chainEncoding: 1 };
const MAINNET = { chainKey: 3n, chainId: 1n, chainName: "Ethereum", chainNameHex: "0x", chainEncoding: 1 };

const attesting = (height) => ({ height, digest: `0x${"ab".repeat(32)}`, isAttestation: true, exists: true });

/**
 * A reader that answers from a table.
 *
 * @param chains entries `get_supported_chains()` returns
 * @param frontiers per-chainKey frontier, or an error object to fail that one read
 */
function readerOf(chains, frontiers, supportedError) {
  return {
    async getSupportedChains() {
      return supportedError === undefined ? { ok: true, value: chains } : { ok: false, error: supportedError };
    },
    async getLatestAttestation(chainKey) {
      const entry = frontiers[String(chainKey)];
      if (entry === undefined) {
        return { ok: false, error: { category: "UPSTREAM", code: "NO_STUB", message: "no stub", retryable: true } };
      }
      return entry.error === undefined ? { ok: true, value: entry } : { ok: false, error: entry.error };
    },
  };
}

const reasonFor = (discovery, chainKey) =>
  discovery.excluded.find((entry) => entry.chainKey === chainKey)?.reason;

test("both chains attesting is the full mode", async () => {
  const result = await discoverChains(
    readerOf([SEPOLIA, MAINNET], { 1: attesting(11598820n), 3: attesting(25868090n) }),
    configWith(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.mode, "FULL");
  assert.deepEqual(
    result.value.monitored.map((chain) => chain.chainKey),
    [1, 3],
  );
  assert.equal(result.value.sepoliaOnly, false);
  assert.equal(result.value.excluded.length, 0);
  assert.equal(result.value.monitored[1].attestedHeight, 25868090n);
  assert.equal(result.value.monitored[1].name, "Ethereum Mainnet");
});

test("Mainnet not attesting leaves a working Sepolia-only degraded mode", async () => {
  const result = await discoverChains(
    readerOf([SEPOLIA, MAINNET], {
      1: attesting(11598820n),
      3: { height: 0n, digest: `0x${"00".repeat(32)}`, isAttestation: false, exists: false },
    }),
    configWith(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.mode, "DEGRADED");
  assert.equal(result.value.sepoliaOnly, true);
  assert.deepEqual(
    result.value.monitored.map((chain) => chain.chainKey),
    [1],
  );
  assert.equal(reasonFor(result.value, 3n), "NO_ATTESTATION");
  assert.match(describeDiscovery(result.value), /Sepolia-only degraded mode, which is supported/);
});

test("configuration cannot add a chain the precompile does not report", async () => {
  // Endpoints are configured for both chains; only Sepolia is reported.
  const result = await discoverChains(
    readerOf([SEPOLIA], { 1: attesting(11598820n), 3: attesting(25868090n) }),
    configWith(),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.monitored.map((chain) => chain.chainKey),
    [1],
  );
  assert.equal(reasonFor(result.value, 3n), "NOT_REPORTED");
  assert.deepEqual(result.value.ignoredConfiguration, [{ chainKey: 3, endpointCount: 2 }]);
});

test("a reported chainKey Tab has no descriptor for is named, not monitored", async () => {
  const bnb = { chainKey: 2n, chainId: 56n, chainName: "BNB", chainNameHex: "0x", chainEncoding: 1 };
  const result = await discoverChains(
    readerOf([SEPOLIA, bnb], { 1: attesting(11598820n), 2: attesting(1n) }),
    configWith({ ETHEREUM_MAINNET_RPC_URLS: "" }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.monitored.map((chain) => chain.chainKey),
    [1],
  );
  assert.equal(reasonFor(result.value, 2n), "UNSUPPORTED_BY_TAB");
});

test("a chainKey whose native chain id disagrees with Tab's table is refused", async () => {
  const impostor = { ...MAINNET, chainId: 137n };
  const result = await discoverChains(
    readerOf([SEPOLIA, impostor], { 1: attesting(11598820n), 3: attesting(25868090n) }),
    configWith(),
  );
  assert.equal(result.ok, true);
  assert.equal(reasonFor(result.value, 3n), "CHAIN_ID_MISMATCH");
  assert.equal(result.value.sepoliaOnly, true);
});

test("a checkpoint frontier is not an attestation frontier", async () => {
  const result = await discoverChains(
    readerOf([SEPOLIA, MAINNET], {
      1: attesting(11598820n),
      3: { height: 25867900n, digest: `0x${"cd".repeat(32)}`, isAttestation: false, exists: true },
    }),
    configWith(),
  );
  assert.equal(result.ok, true);
  assert.equal(reasonFor(result.value, 3n), "CHECKPOINT_ONLY");
});

test("a frontier that has stopped moving becomes an observable exclusion", async () => {
  const now = new Date("2026-08-30T13:00:00Z");
  const stale = [
    { chainKey: 3, lastAttestedHeight: 25868090n, updatedAt: new Date("2026-08-30T12:40:00Z") },
  ];
  const result = await discoverChains(
    readerOf([SEPOLIA, MAINNET], { 1: attesting(11598820n), 3: attesting(25868090n) }),
    configWith(),
    { previousFrontiers: stale, now },
  );
  assert.equal(result.ok, true);
  assert.equal(reasonFor(result.value, 3n), "FRONTIER_STALE");
  assert.equal(result.value.mode, "DEGRADED");
  assert.equal(result.value.sepoliaOnly, true);
});

test("a frontier inside the staleness window is still monitored", async () => {
  const now = new Date("2026-08-30T13:00:00Z");
  const recent = [
    { chainKey: 3, lastAttestedHeight: 25868090n, updatedAt: new Date("2026-08-30T12:58:00Z") },
  ];
  const result = await discoverChains(
    readerOf([SEPOLIA, MAINNET], { 1: attesting(11598820n), 3: attesting(25868090n) }),
    configWith(),
    { previousFrontiers: recent, now },
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.mode, "FULL");
});

test("a frontier that advanced is never stale, however old the previous read", async () => {
  const now = new Date("2026-08-30T13:00:00Z");
  const old = [
    { chainKey: 3, lastAttestedHeight: 25868080n, updatedAt: new Date("2026-08-30T10:00:00Z") },
  ];
  const result = await discoverChains(
    readerOf([SEPOLIA, MAINNET], { 1: attesting(11598820n), 3: attesting(25868090n) }),
    configWith(),
    { previousFrontiers: old, now },
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.mode, "FULL");
});

test("an attesting chain with too few endpoints is a configuration defect, named", async () => {
  const oneEndpoint = await discoverChains(
    readerOf([SEPOLIA, MAINNET], { 1: attesting(11598820n), 3: attesting(25868090n) }),
    configWith({ ETHEREUM_MAINNET_RPC_URLS: "https://only.example" }),
  );
  assert.equal(oneEndpoint.ok, true);
  assert.equal(reasonFor(oneEndpoint.value, 3n), "INSUFFICIENT_ENDPOINTS");

  const noEndpoint = await discoverChains(
    readerOf([SEPOLIA, MAINNET], { 1: attesting(11598820n), 3: attesting(25868090n) }),
    configWith({ ETHEREUM_MAINNET_RPC_URLS: "" }),
  );
  assert.equal(noEndpoint.ok, true);
  assert.equal(reasonFor(noEndpoint.value, 3n), "NO_ENDPOINTS");
  // No endpoints configured is not inert configuration; there was none to ignore.
  assert.deepEqual(noEndpoint.value.ignoredConfiguration, []);
});

test("one unreadable frontier does not take the other chain down", async () => {
  const result = await discoverChains(
    readerOf([SEPOLIA, MAINNET], {
      1: attesting(11598820n),
      3: { error: { category: "UPSTREAM", code: "CHAININFO_READ_FAILED", message: "timeout", retryable: true } },
    }),
    configWith(),
  );
  assert.equal(result.ok, true);
  assert.equal(reasonFor(result.value, 3n), "FRONTIER_UNREADABLE");
  assert.equal(result.value.sepoliaOnly, true);
});

test("nothing attesting is reported as such rather than thrown", async () => {
  const result = await discoverChains(
    readerOf([SEPOLIA, MAINNET], {
      1: { height: 0n, digest: `0x${"00".repeat(32)}`, isAttestation: false, exists: false },
      3: { height: 0n, digest: `0x${"00".repeat(32)}`, isAttestation: false, exists: false },
    }),
    configWith(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.mode, "NO_CHAIN_MONITORABLE");
  assert.equal(result.value.monitored.length, 0);
  assert.equal(result.value.sepoliaOnly, false);
  assert.match(describeDiscovery(result.value), /monitoring no chain/);
});

test("an unreadable supported-chain list fails the whole discovery", async () => {
  const result = await discoverChains(
    readerOf([], {}, {
      category: "CHAIN",
      code: "CHAININFO_SELECTOR_UNKNOWN",
      message: "unknown selector",
      retryable: false,
    }),
    configWith(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CHAININFO_SELECTOR_UNKNOWN");
});
