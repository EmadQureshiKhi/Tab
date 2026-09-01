/**
 * How an Asset is named across the MCP boundary, and what this package knows
 * about the ones it ships descriptors for.
 *
 * ## One string, both halves
 *
 * A token address does not name an Asset. The same address exists on every EVM
 * chain, and Tab settles across more than one, so `0xa0b8...eb48` on its own is
 * ambiguous in exactly the way that produces a payment to the right address on
 * the wrong chain. Every Asset that crosses this boundary is therefore
 * `chainKey:address` -- Tab's own chain key, a colon, the token contract. That
 * is one field for a model to fill in rather than two it can fill in
 * inconsistently, and it is the same key the collection table is indexed by on
 * chain.
 *
 * The chain key is Tab's, not the EVM chain id: `1` is Ethereum Sepolia and `3`
 * is Ethereum Mainnet. Reusing the EVM ids here would collide with Sepolia's
 * 11155111 in no obvious way, but it would put two numbering schemes in one
 * field, and the on-chain tables are keyed by Tab's.
 *
 * ## Symbol and decimals are claims, not lookups
 *
 * `@tabai/shared` ships a descriptor for USDC on each Source Chain, and
 * `SEPOLIA_USDC_ADDRESS` and `MAINNET_USDC_ADDRESS` fill in the address for a
 * deployment whose token is chosen. When a pair matches one of those, the
 * `symbol` and `decimals` reported are that descriptor's. When it does not, both
 * are reported as null and `curatedAsset` is false, rather than assuming six
 * decimals -- an Asset accepted on chain that this package has never heard of is
 * a real thing, and a guessed decimals figure would misrender every amount
 * derived from it.
 *
 * Requirements: 23.1, 23.6, 25.1
 */

import type { Address, ChainKey, Result } from "@tabai/shared";
import { CHAINS, CHAIN_KEYS, PLACEHOLDER_ADDRESS, isAddress, ok, toChainKey } from "@tabai/shared";

import { validationError } from "../errors.js";
import type { AssetRef } from "../payments/strategy.js";

/** An Asset named across the wire: `chainKey:tokenAddress`, both halves required. */
export type AssetString = string;

/** What this package can say about one Asset beyond its coordinates. */
export interface AssetFacts {
  readonly chainKey: number;
  readonly address: Address;
  /** Null when no shipped descriptor matches the pair. */
  readonly symbol: string | null;
  /** Null when no shipped descriptor matches the pair. Never guessed. */
  readonly decimals: number | null;
  /** True when a shipped descriptor matches, which is what supplied symbol and decimals. */
  readonly curatedAsset: boolean;
}

/** Renders an Asset for the wire. Addresses are lowercased so two spellings compare equal. */
export const formatAsset = (chainKey: bigint | number, address: string): AssetString =>
  `${String(chainKey)}:${address.toLowerCase()}`;

/** Renders a strategy-seam {@link AssetRef} for the wire. */
export const assetStringOf = (asset: AssetRef): AssetString => formatAsset(asset.chainKey, asset.address);

/**
 * Reads `chainKey:address` back into the pair.
 *
 * A chain key outside the supported set is rejected here rather than carried
 * forward: every downstream read is keyed by it, and an unsupported key produces
 * an empty answer that reads like "nothing is registered" instead of "that chain
 * is not one Tab attests".
 */
export function parseAsset(value: unknown, label = "asset"): Result<AssetRef> {
  if (typeof value !== "string") {
    return validationError(
      "ASSET_MALFORMED",
      `${label} must be a string of the form chainKey:tokenAddress, received ${typeof value}`,
      { details: { label } },
    );
  }
  const colon = value.indexOf(":");
  if (colon <= 0) {
    return validationError(
      "ASSET_MALFORMED",
      `${label} must be chainKey:tokenAddress, for example 3:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48, received \`${value}\``,
      { details: { label, value } },
    );
  }
  const rawKey = value.slice(0, colon);
  const rawAddress = value.slice(colon + 1);
  if (!/^[0-9]+$/.test(rawKey)) {
    return validationError("ASSET_CHAIN_KEY_MALFORMED", `${label} must start with a decimal chain key, received \`${rawKey}\``, {
      details: { label, chainKey: rawKey },
    });
  }
  if (!isAddress(rawAddress)) {
    return validationError("ASSET_ADDRESS_MALFORMED", `${label} must end in a 20-byte 0x address, received \`${rawAddress}\``, {
      details: { label, address: rawAddress },
    });
  }
  const chainKey = toChainKey(BigInt(rawKey));
  if (chainKey === undefined) {
    return validationError(
      "ASSET_CHAIN_UNSUPPORTED",
      `chain key ${rawKey} is not a Source Chain this network attests; the supported keys are ${CHAIN_KEYS.join(" and ")}`,
      { details: { label, chainKey: rawKey, supported: CHAIN_KEYS.join(", ") } },
    );
  }
  const descriptor = CHAINS[chainKey].usdc;
  return ok({
    chainKey: BigInt(chainKey),
    address: rawAddress.toLowerCase() as Address,
    decimals: descriptor.decimals,
    symbol: descriptor.symbol,
  });
}

/** The USDC address this deployment uses on a chain, taking the environment over a placeholder. */
function usdcAddressFor(chainKey: ChainKey, env: NodeJS.ProcessEnv): string | null {
  const shipped = CHAINS[chainKey].usdc;
  const override = chainKey === 1 ? env["SEPOLIA_USDC_ADDRESS"] : env["MAINNET_USDC_ADDRESS"];
  if (override !== undefined && isAddress(override)) return override.toLowerCase();
  if (shipped.address === PLACEHOLDER_ADDRESS) return null;
  return shipped.address.toLowerCase();
}

/**
 * What this package knows about one Asset.
 *
 * Total: an unknown pair produces facts with nulls rather than a failure,
 * because an Asset a Service accepts is a chain fact and this package's
 * ignorance of it is not an error in the Service.
 */
export function assetFacts(
  chainKey: bigint | number,
  address: string,
  env: NodeJS.ProcessEnv = process.env,
): AssetFacts {
  const lowered = address.toLowerCase() as Address;
  const numeric = typeof chainKey === "bigint" ? Number(chainKey) : chainKey;
  const known = toChainKey(numeric);
  if (known !== undefined && usdcAddressFor(known, env) === lowered) {
    const descriptor = CHAINS[known].usdc;
    return {
      chainKey: numeric,
      address: lowered,
      symbol: descriptor.symbol,
      decimals: descriptor.decimals,
      curatedAsset: true,
    };
  }
  return { chainKey: numeric, address: lowered, symbol: null, decimals: null, curatedAsset: false };
}
