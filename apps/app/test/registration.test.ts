/**
 * The registration encoder.
 *
 * This is the one place in the Dashboard that builds calldata a wallet will sign
 * for a call that registers a business and prices its work. Everything here is
 * checked against the shape the contract declares rather than against the
 * encoder's own output, so a change that silently reorders an argument fails.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Interface, decodeBytes32String } from "ethers";

import {
  encodeBondCollection,
  encodeRegistration,
  encodeTransfer,
  toBaseUnits,
  toWindow,
  toWord,
} from "../src/dashboard/registration.js";

const ABI = new Interface([
  "function registerService(bytes32 serviceId, uint64[] chainKeys, address[] assets, address[] collections, bytes32[] tools, uint256[] prices, uint32 settlementWindow)",
]);

const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const MAINNET_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const COLLECTION = "0x952acc70e6f54ce87dca963193a5957bcb27729e";

const ONE_ASSET = {
  serviceName: "tab.demo",
  settlementWindowSeconds: "21600",
  assets: [{ chainKey: "1", asset: SEPOLIA_USDC, collection: COLLECTION }],
  tools: [{ tool: "proof.generate", priceBaseUnits: "10000" }],
};

test("a name round-trips through the word the registry stores", () => {
  const word = toWord("tab.proof-service", "Service name");
  assert.equal(word.ok, true);
  assert.equal(word.ok && decodeBytes32String(word.value), "tab.proof-service");
});

test("a name too long for the slot is refused with its length", () => {
  const word = toWord("a".repeat(32), "Service name");
  assert.equal(word.ok, false);
  assert.match(word.ok ? "" : word.message, /31 bytes/);
});

test("a price is base units and never a decimal", () => {
  assert.deepEqual(toBaseUnits("10000", "Price"), { ok: true, value: 10_000n });
  assert.equal(toBaseUnits("0.01", "Price").ok, false);
  assert.equal(toBaseUnits("-1", "Price").ok, false);
  // Underscores are a typing convenience the contract never sees.
  assert.deepEqual(toBaseUnits("1_000_000", "Price"), { ok: true, value: 1_000_000n });
});

test("the Settlement Window is held to the range the contract accepts", () => {
  assert.deepEqual(toWindow("21600"), { ok: true, value: 21_600 });
  // Zero means "take the registry default", which is a legal value.
  assert.deepEqual(toWindow("0"), { ok: true, value: 0 });
  assert.equal(toWindow("86401").ok, false);
  assert.equal(toWindow("-1").ok, false);
});

test("the calldata decodes back to exactly what was entered", () => {
  const encoded = encodeRegistration(ONE_ASSET);
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;

  const decoded = ABI.decodeFunctionData("registerService", encoded.value.data);
  assert.equal(decodeBytes32String(decoded[0] as string), "tab.demo");
  assert.deepEqual([...(decoded[1] as bigint[])], [1n]);
  assert.deepEqual([...(decoded[2] as string[])].map((a) => a.toLowerCase()), [SEPOLIA_USDC]);
  assert.deepEqual([...(decoded[3] as string[])].map((a) => a.toLowerCase()), [COLLECTION]);
  assert.equal(decodeBytes32String((decoded[4] as string[])[0] ?? ""), "proof.generate");
  assert.deepEqual([...(decoded[5] as bigint[])], [10_000n]);
  assert.equal(Number(decoded[6]), 21_600);
});

test("prices are Asset-major, so each Asset gets every tool in order", () => {
  // The pairing the contract expects. Read the wrong way round, this would price
  // the right tools in the wrong Assets and revert nothing.
  const encoded = encodeRegistration({
    serviceName: "tab.demo",
    settlementWindowSeconds: "3600",
    assets: [
      { chainKey: "1", asset: SEPOLIA_USDC, collection: COLLECTION },
      { chainKey: "3", asset: MAINNET_USDC, collection: COLLECTION },
    ],
    tools: [
      { tool: "cheap.tool", priceBaseUnits: "1" },
      { tool: "dear.tool", priceBaseUnits: "500" },
    ],
  });
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;

  const decoded = ABI.decodeFunctionData("registerService", encoded.value.data);
  assert.deepEqual([...(decoded[1] as bigint[])], [1n, 3n]);
  // Two Assets by two tools: Sepolia's pair first, then Mainnet's, each in tool order.
  assert.deepEqual([...(decoded[5] as bigint[])], [1n, 500n, 1n, 500n]);
});

test("an empty Service is refused before a wallet is opened", () => {
  assert.equal(encodeRegistration({ ...ONE_ASSET, assets: [] }).ok, false);
  assert.equal(encodeRegistration({ ...ONE_ASSET, tools: [] }).ok, false);
  assert.equal(encodeRegistration({ ...ONE_ASSET, assets: [{ chainKey: "1", asset: "0xnope", collection: COLLECTION }] }).ok, false);
});

/* -------------------------------------------------------------------- bond */

test("a bond collection encodes to the registry's own signature", () => {
  const BOND_ABI = new Interface([
    "function registerBondCollection(bytes32 serviceId, uint64 chainKey, address asset, address collection)",
  ]);
  const encoded = encodeBondCollection({
    serviceId: `0x${"11".repeat(32)}`,
    chainKey: "1",
    asset: SEPOLIA_USDC,
    collection: COLLECTION,
  });
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  const decoded = BOND_ABI.decodeFunctionData("registerBondCollection", encoded.value);
  assert.equal(Number(decoded[1]), 1);
  assert.equal((decoded[2] as string).toLowerCase(), SEPOLIA_USDC);
  assert.equal((decoded[3] as string).toLowerCase(), COLLECTION);
});

test("a deposit is base units, and nothing is not a deposit", () => {
  const ERC20 = new Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
  const encoded = encodeTransfer(COLLECTION, "5000000");
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  const decoded = ERC20.decodeFunctionData("transfer", encoded.value);
  assert.equal((decoded[0] as string).toLowerCase(), COLLECTION);
  assert.equal(decoded[1] as bigint, 5_000_000n);

  // A zero deposit would be a Settlement that proves a deposit of nothing.
  assert.equal(encodeTransfer(COLLECTION, "0").ok, false);
  assert.equal(encodeTransfer(COLLECTION, "0.5").ok, false);
});
