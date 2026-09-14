import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface, id } from "ethers";

import {
  decodeAllowance,
  encodeAllowance,
  encodeApprove,
  encodeAuthorise,
  encodeSettle,
  parseBaseUnits,
  parseServiceId,
  UINT128_MAX,
} from "../dist/calldata.js";
import { SERVICE_ID, TAB_SETTLEMENT, USDC, AGENT } from "./fixtures.mjs";

const selector = (signature) => id(signature).slice(0, 10);

test("settle, approve, allowance and authorise carry the contract selectors", () => {
  assert.equal(encodeSettle(SERVICE_ID, USDC, 47_000n).slice(0, 10), selector("settle(bytes32,address,uint128)"));
  assert.equal(encodeApprove(TAB_SETTLEMENT, 47_000n).slice(0, 10), selector("approve(address,uint256)"));
  assert.equal(encodeAllowance(AGENT, TAB_SETTLEMENT).slice(0, 10), selector("allowance(address,address)"));
  assert.equal(encodeAuthorise(SERVICE_ID, USDC, 5_000_000n, 1_800_000_000n).slice(0, 10), selector("authorise(bytes32,address,uint128,uint64)"));
});

test("settle calldata decodes back to what was asked", () => {
  const iface = new Interface(["function settle(bytes32 serviceId, address asset, uint128 amount)"]);
  const decoded = iface.decodeFunctionData("settle", encodeSettle(SERVICE_ID, USDC, 47_000n));
  assert.equal(decoded.serviceId, SERVICE_ID);
  assert.equal(decoded.asset.toLowerCase(), USDC);
  assert.equal(decoded.amount, 47_000n);
});

test("an unlimited approval is the full uint256", () => {
  const iface = new Interface(["function approve(address spender, uint256 amount)"]);
  const decoded = iface.decodeFunctionData("approve", encodeApprove(TAB_SETTLEMENT, "unlimited"));
  assert.equal(decoded.amount, (1n << 256n) - 1n);
});

test("decodeAllowance reads one word and refuses less", () => {
  assert.deepEqual(decodeAllowance(`0x${(123n).toString(16).padStart(64, "0")}`), { ok: true, value: 123n });
  assert.equal(decodeAllowance("0x").error.code, "ALLOWANCE_RETURN_SHORT");
  assert.equal(decodeAllowance("0x1234").error.code, "ALLOWANCE_RETURN_SHORT");
});

test("parseBaseUnits takes digits only, refuses zero, and stops at uint128", () => {
  assert.deepEqual(parseBaseUnits("47000", "amount"), { ok: true, value: 47_000n });
  assert.deepEqual(parseBaseUnits(" 1 ", "amount"), { ok: true, value: 1n });
  assert.equal(parseBaseUnits("0", "amount").error.code, "AMOUNT_ZERO");
  assert.equal(parseBaseUnits("0.047", "amount").error.code, "AMOUNT_MALFORMED");
  assert.equal(parseBaseUnits("-5", "amount").error.code, "AMOUNT_MALFORMED");
  assert.equal(parseBaseUnits(UINT128_MAX.toString(10), "amount").ok, true);
  assert.equal(parseBaseUnits((UINT128_MAX + 1n).toString(10), "amount").error.code, "AMOUNT_OUT_OF_RANGE");
});

test("parseServiceId wants a 32-byte word and lower-cases it", () => {
  assert.deepEqual(parseServiceId(SERVICE_ID.toUpperCase().replace("0X", "0x")), { ok: true, value: SERVICE_ID });
  assert.equal(parseServiceId("tab.demo").error.code, "SERVICE_ID_MALFORMED");
  assert.equal(parseServiceId("0x1234").error.code, "SERVICE_ID_MALFORMED");
});
