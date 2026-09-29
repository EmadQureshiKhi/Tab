/**
 * The calldata this plugin hands to the wallet.
 *
 * Three functions on two contracts. The ERC-20 and `TabSettlement` fragments
 * come from the SDK so the plugin encodes exactly what `createMonadStrategy`
 * encodes; `TabBook.authorise` is the one fragment the SDK has no reason to
 * carry, because the Dashboard signs it in a browser and the SDK never does.
 */

import type { Address, Bytes32, Hex, Result } from "@tabai/sdk";
import { ok } from "@tabai/sdk";
import { ERC20_ABI, TAB_SETTLEMENT_ABI, validationError } from "@tabai/sdk";
import { Interface, MaxUint256 } from "ethers";

/** `TabBook.authorise`, the Agent's own cap on what a Service may meter. */
export const TAB_BOOK_AUTHORISE_ABI = [
  "function authorise(bytes32 serviceId, address asset, uint128 maxCumulative, uint64 expiry)",
] as const;

const erc20 = new Interface(ERC20_ABI);
const tabSettlement = new Interface(TAB_SETTLEMENT_ABI);
const tabBook = new Interface(TAB_BOOK_AUTHORISE_ABI);

export const UINT128_MAX = (1n << 128n) - 1n;
export const UINT64_MAX = (1n << 64n) - 1n;

export const encodeAllowance = (owner: Address, spender: Address): Hex =>
  erc20.encodeFunctionData("allowance", [owner, spender]) as Hex;

/** Reads an `allowance` return word. Short or empty data is a `Result` error, never a throw. */
export function decodeAllowance(data: string): Result<bigint> {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  if (body.length < 64) {
    return validationError("ALLOWANCE_RETURN_SHORT", `allowance returned ${body.length} hex digits, too few for one word`, {
      details: { length: body.length },
    });
  }
  return ok(BigInt(`0x${body.slice(0, 64)}`));
}

export const encodeApprove = (spender: Address, amount: bigint | "unlimited"): Hex =>
  erc20.encodeFunctionData("approve", [spender, amount === "unlimited" ? MaxUint256 : amount]) as Hex;

export const encodeSettle = (serviceId: Bytes32, asset: Address, amount: bigint): Hex =>
  tabSettlement.encodeFunctionData("settle", [serviceId, asset, amount]) as Hex;

export const encodeAuthorise = (serviceId: Bytes32, asset: Address, maxCumulative: bigint, expiry: bigint): Hex =>
  tabBook.encodeFunctionData("authorise", [serviceId, asset, maxCumulative, expiry]) as Hex;

/** A base-unit amount from a CLI string: decimal digits only, positive, and inside `uint128`. */
export function parseBaseUnits(raw: string, label: string): Result<bigint> {
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text)) {
    return validationError(
      "AMOUNT_MALFORMED",
      `${label} must be a whole number of Asset base units (USDC has six decimals, so 47000 is 0.047 USDC), received \`${raw}\``,
      { details: { label, value: raw } },
    );
  }
  const amount = BigInt(text);
  if (amount === 0n) {
    return validationError("AMOUNT_ZERO", `${label} of zero base units moves nothing and settles nothing`, { details: { label } });
  }
  if (amount > UINT128_MAX) {
    return validationError("AMOUNT_OUT_OF_RANGE", `${label} must fit a uint128`, { details: { label } });
  }
  return ok(amount);
}

/** A Service id from a CLI string: a 32-byte hex word, lower-cased. */
export function parseServiceId(raw: string): Result<Bytes32> {
  const text = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) {
    return validationError(
      "SERVICE_ID_MALFORMED",
      `service must be the Service's 32-byte identifier as 0x plus 64 hex digits; \`mm tab discover\` lists them`,
      { details: { value: raw } },
    );
  }
  return ok(text.toLowerCase() as Bytes32);
}
