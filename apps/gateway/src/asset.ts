/**
 * What the gateway calls its Asset, and how many decimals it counts in.
 *
 * The symbol is printed on every charge block and every x402 offer, so it has
 * to be the Asset's own: a gateway metering in AUSD that called it USDC would
 * quote a price in a token the Agent is not paying with. The Testnet mock is
 * named `mUSDC`, as it is everywhere the rail prints a symbol, so a charge in it
 * is never read as one in Circle's USDC. A stablecoin in the shared tables for the
 * gateway's chain is named from there, and any other token is asked for its own
 * `symbol()` and `decimals()`.
 */

import { Interface } from "ethers";

import { MAINNET_ASSETS, MONAD_MAINNET, MONAD_TESTNET, TESTNET_ASSETS, err, ok, type AssetDescriptor, type Result } from "@tabai/shared";

import type { CallProvider } from "./x402.js";

const ERC20_METADATA = new Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

/** The symbol and decimals a gateway meters under. */
export interface AssetLabel {
  readonly symbol: string;
  readonly decimals: number;
}

/** The known stablecoins on one Monad network, keyed by lowercased address. */
function knownAssets(chainId: number): ReadonlyMap<string, AssetDescriptor> {
  const table: Readonly<Record<string, AssetDescriptor>> =
    chainId === MONAD_MAINNET.chainId ? MAINNET_ASSETS : chainId === MONAD_TESTNET.chainId ? TESTNET_ASSETS : {};
  return new Map(Object.values(table).map((descriptor) => [descriptor.address.toLowerCase(), descriptor]));
}

/**
 * Resolves the label for `address` on `chainId`.
 *
 * `mockUsdc` is the deployment's `MockUsdc`, when the network has one. A token
 * that is neither the mock nor in the shared tables and does not answer
 * `symbol()` and `decimals()` is an error: the gateway would otherwise quote
 * prices under a guessed name and scale.
 */
export async function resolveAssetLabel(
  provider: CallProvider,
  address: string,
  chainId: number,
  mockUsdc: string | undefined,
): Promise<Result<AssetLabel>> {
  const asset = address.toLowerCase();
  if (mockUsdc !== undefined && asset === mockUsdc.toLowerCase()) return ok({ symbol: "mUSDC", decimals: 6 });

  const known = knownAssets(chainId).get(asset);
  if (known !== undefined) return ok({ symbol: known.symbol, decimals: known.decimals });

  try {
    const [symbolRaw, decimalsRaw] = await Promise.all([
      provider.call({ to: asset, data: ERC20_METADATA.encodeFunctionData("symbol") }),
      provider.call({ to: asset, data: ERC20_METADATA.encodeFunctionData("decimals") }),
    ]);
    const symbol = String(ERC20_METADATA.decodeFunctionResult("symbol", symbolRaw)[0]);
    const decimals = Number(ERC20_METADATA.decodeFunctionResult("decimals", decimalsRaw)[0]);
    if (symbol.length > 0 && Number.isInteger(decimals)) return ok({ symbol, decimals });
  } catch {
    // Falls through to the named refusal below.
  }
  return err({
    category: "VALIDATION",
    code: "ASSET_UNRECOGNISED",
    message: `${asset} is not a known Monad stablecoin on chain ${chainId} and does not answer symbol() and decimals()`,
    retryable: false,
  });
}
