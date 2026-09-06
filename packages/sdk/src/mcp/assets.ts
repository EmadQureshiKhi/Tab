/**
 * Assets at the MCP boundary.
 *
 * An Asset is named to a model as `<chainId>:<address>`, the same shape the
 * `Tab-Charge-Asset` header carries, so the string a tool result shows is the
 * string a tool argument accepts. `TabBook` keys an Asset by token address alone;
 * the chain id travels with it here because the SDK can be pointed at Monad
 * Mainnet or Monad Testnet and a bare address is ambiguous between the two.
 *
 * The canonical stablecoins are known by symbol and decimals. Any other address
 * is still a valid Asset, it is just one this SDK has no facts about, and the
 * tool results say so rather than guessing.
 */
import type { Address, Result } from "@tabai/shared";
import { MAINNET_ASSETS, MONAD_MAINNET, MONAD_TESTNET, TESTNET_ASSETS, isAddress, ok } from "@tabai/shared";
import { validationError } from "../errors.js";
import type { AssetRef } from "../payments/strategy.js";

export type AssetString = string;

export interface AssetFacts {
  readonly chainId: number;
  readonly address: Address;
  readonly symbol: string | null;
  readonly decimals: number | null;
  /** True when the address is a canonical stablecoin on that chain, or a configured test token. */
  readonly curatedAsset: boolean;
}

export const formatAsset = (chainId: bigint | number, address: string): AssetString =>
  `${String(chainId)}:${address.toLowerCase()}`;

export const assetStringOf = (asset: AssetRef): AssetString => formatAsset(asset.chainId, asset.address);

/** The chain ids this SDK knows how to describe. */
export const KNOWN_CHAIN_IDS = [MONAD_MAINNET.chainId, MONAD_TESTNET.chainId] as const;

/**
 * The stablecoins this SDK can name, per chain. On Testnet that is Circle's
 * USDC from the shared table plus the mock token the deployment shipped, read
 * from `MOCK_USDC_ADDRESS`. The mock is named `mUSDC` here although its own
 * `symbol()` says `USDC`, because a Service that accepts both must show two
 * Assets and not one word twice.
 */
function knownAssets(chainId: number, env: NodeJS.ProcessEnv): readonly { address: string; symbol: string; decimals: number }[] {
  if (chainId === MONAD_MAINNET.chainId) {
    return Object.values(MAINNET_ASSETS).map((asset) => ({
      address: asset.address.toLowerCase(),
      symbol: asset.symbol,
      decimals: asset.decimals,
    }));
  }
  if (chainId === MONAD_TESTNET.chainId) {
    const known = Object.values(TESTNET_ASSETS).map((asset) => ({
      address: asset.address.toLowerCase(),
      symbol: asset.symbol,
      decimals: asset.decimals,
    }));
    const mock = env["MOCK_USDC_ADDRESS"];
    return mock !== undefined && isAddress(mock) ? [...known, { address: mock.toLowerCase(), symbol: "mUSDC", decimals: 6 }] : known;
  }
  return [];
}

export function parseAsset(value: unknown, label = "asset", env: NodeJS.ProcessEnv = process.env): Result<AssetRef> {
  if (typeof value !== "string") {
    return validationError("ASSET_MALFORMED", `${label} must be a string of the form chainId:tokenAddress, received ${typeof value}`, {
      details: { label },
    });
  }
  const colon = value.indexOf(":");
  if (colon <= 0) {
    return validationError(
      "ASSET_MALFORMED",
      `${label} must be chainId:tokenAddress, for example 143:${MAINNET_ASSETS.USDC.address.toLowerCase()}, received \`${value}\``,
      { details: { label, value } },
    );
  }
  const rawChainId = value.slice(0, colon);
  const rawAddress = value.slice(colon + 1);
  if (!/^[0-9]+$/.test(rawChainId)) {
    return validationError("ASSET_CHAIN_ID_MALFORMED", `${label} must start with a decimal chain id, received \`${rawChainId}\``, {
      details: { label, chainId: rawChainId },
    });
  }
  if (!isAddress(rawAddress)) {
    return validationError("ASSET_ADDRESS_MALFORMED", `${label} must end in a 20-byte 0x address, received \`${rawAddress}\``, {
      details: { label, address: rawAddress },
    });
  }
  const chainId = Number(rawChainId);
  if (!(KNOWN_CHAIN_IDS as readonly number[]).includes(chainId)) {
    return validationError(
      "ASSET_CHAIN_UNSUPPORTED",
      `chain id ${rawChainId} is not a Monad network; the supported ids are ${KNOWN_CHAIN_IDS.join(" and ")}`,
      { details: { label, chainId: rawChainId, supported: KNOWN_CHAIN_IDS.join(", ") } },
    );
  }
  const facts = assetFacts(chainId, rawAddress, env);
  return ok({
    chainId: BigInt(chainId),
    address: rawAddress.toLowerCase() as Address,
    // An unknown token is assumed to be a six-decimal stablecoin, which is what
    // every Asset Tab settles in. The facts say when that is a guess.
    decimals: facts.decimals ?? 6,
    symbol: facts.symbol ?? "TOKEN",
  });
}

export function assetFacts(chainId: bigint | number, address: string, env: NodeJS.ProcessEnv = process.env): AssetFacts {
  const lowered = address.toLowerCase() as Address;
  const numeric = typeof chainId === "bigint" ? Number(chainId) : chainId;
  const known = knownAssets(numeric, env).find((asset) => asset.address === lowered);
  if (known !== undefined) {
    return { chainId: numeric, address: lowered, symbol: known.symbol, decimals: known.decimals, curatedAsset: true };
  }
  return { chainId: numeric, address: lowered, symbol: null, decimals: null, curatedAsset: false };
}
