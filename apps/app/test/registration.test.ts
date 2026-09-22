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
  encodeApprove,
  encodeDeposit,
  encodeRegistration,
  encodeWithdraw,
  toBaseUnits,
  toWindow,
  toWord,
} from "../src/dashboard/registration.js";

const ABI = new Interface([
  "function registerService(bytes32 serviceId, address[] assets, address[] collections, bytes32[] tools, uint256[] prices, uint32 settlementWindow)",
]);

const TESTNET_USDC = "0x5d519a1e8cf4edd7067fd631047e6869e9a7e4fe";
const MAINNET_USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const COLLECTION = "0x952acc70e6f54ce87dca963193a5957bcb27729e";
const BOND = "0x4f791f13f94944fcb2f884f8c7991caa583884a6";

const ONE_ASSET = {
  serviceName: "tab.demo",
  settlementWindowSeconds: "21600",
  assets: [{ asset: TESTNET_USDC, collection: COLLECTION }],
  tools: [{ tool: "quote.generate", priceBaseUnits: "10000" }],
};

test("a name round-trips through the word the registry stores", () => {
  const word = toWord("tab.demo-service", "Service name");
  assert.equal(word.ok, true);
  assert.equal(word.ok && decodeBytes32String(word.value), "tab.demo-service");
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
  assert.deepEqual([...(decoded[1] as string[])].map((a) => a.toLowerCase()), [TESTNET_USDC]);
  assert.deepEqual([...(decoded[2] as string[])].map((a) => a.toLowerCase()), [COLLECTION]);
  assert.equal(decodeBytes32String((decoded[3] as string[])[0] ?? ""), "quote.generate");
  assert.deepEqual([...(decoded[4] as bigint[])], [10_000n]);
  assert.equal(Number(decoded[5]), 21_600);
});

test("prices are Asset-major, so each Asset gets every tool in order", () => {
  // The pairing the contract expects. Read the wrong way round, this would price
  // the right tools in the wrong Assets and revert nothing.
  const encoded = encodeRegistration({
    serviceName: "tab.demo",
    settlementWindowSeconds: "3600",
    assets: [
      { asset: TESTNET_USDC, collection: COLLECTION },
      { asset: MAINNET_USDC, collection: COLLECTION },
    ],
    tools: [
      { tool: "cheap.tool", priceBaseUnits: "1" },
      { tool: "dear.tool", priceBaseUnits: "500" },
    ],
  });
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;

  const decoded = ABI.decodeFunctionData("registerService", encoded.value.data);
  assert.deepEqual(
    [...(decoded[1] as string[])].map((address) => address.toLowerCase()),
    [TESTNET_USDC, MAINNET_USDC],
  );
  // Two Assets by two tools: the first Asset's pair first, then the second's, each in tool order.
  assert.deepEqual([...(decoded[4] as bigint[])], [1n, 500n, 1n, 500n]);
});

test("an empty Service is refused before a wallet is opened", () => {
  assert.equal(encodeRegistration({ ...ONE_ASSET, assets: [] }).ok, false);
  assert.equal(encodeRegistration({ ...ONE_ASSET, tools: [] }).ok, false);
  assert.equal(encodeRegistration({ ...ONE_ASSET, assets: [{ asset: "0xnope", collection: COLLECTION }] }).ok, false);
});

/* -------------------------------------------------------------------- bond */

test("funding a Bond is an approval for Bond and a deposit it pulls", () => {
  const ERC20 = new Interface(["function approve(address spender, uint256 amount) returns (bool)"]);
  const approval = encodeApprove(BOND, "5000000");
  assert.equal(approval.ok, true);
  if (!approval.ok) return;
  const decodedApproval = ERC20.decodeFunctionData("approve", approval.value);
  assert.equal((decodedApproval[0] as string).toLowerCase(), BOND);
  assert.equal(decodedApproval[1] as bigint, 5_000_000n);

  const BOND_ABI = new Interface([
    "function deposit(address asset, uint128 amount)",
    "function depositFor(address account, address asset, uint128 amount)",
    "function withdraw(address asset, uint128 amount) returns (uint128 released)",
  ]);
  const own = encodeDeposit({ asset: TESTNET_USDC, baseUnits: "5000000" });
  assert.equal(own.ok, true);
  if (!own.ok) return;
  const decodedOwn = BOND_ABI.decodeFunctionData("deposit", own.value);
  assert.equal((decodedOwn[0] as string).toLowerCase(), TESTNET_USDC);
  assert.equal(decodedOwn[1] as bigint, 5_000_000n);

  // A treasury funds a Service's bond account without holding its key.
  const forAccount = encodeDeposit({ asset: TESTNET_USDC, baseUnits: "5000000", account: COLLECTION });
  assert.equal(forAccount.ok, true);
  if (!forAccount.ok) return;
  const decodedFor = BOND_ABI.decodeFunctionData("depositFor", forAccount.value);
  assert.equal((decodedFor[0] as string).toLowerCase(), COLLECTION);

  const withdrawal = encodeWithdraw(TESTNET_USDC, "1000");
  assert.equal(withdrawal.ok, true);
  if (!withdrawal.ok) return;
  assert.equal(BOND_ABI.decodeFunctionData("withdraw", withdrawal.value)[1] as bigint, 1_000n);

  // Nothing is not a deposit, a decimal is not base units, and uint128 is the ceiling.
  assert.equal(encodeDeposit({ asset: TESTNET_USDC, baseUnits: "0" }).ok, false);
  assert.equal(encodeDeposit({ asset: TESTNET_USDC, baseUnits: "0.5" }).ok, false);
  assert.equal(encodeDeposit({ asset: TESTNET_USDC, baseUnits: (1n << 128n).toString() }).ok, false);
  assert.equal(encodeApprove("0xnope", "1").ok, false);
});
