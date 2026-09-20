/**
 * The network: which Monad chain every view on the Dashboard is talking about.
 *
 * ## One chain per deployment
 *
 * Tab settles on the chain it is deployed to and nowhere else. The Agent's
 * payment and the ledger entry happen in one Monad transaction, so there is no
 * second chain a Settlement could have come from and no toggle to choose one.
 * What a reader does need to know is whether the figures are test money or real
 * money, and that is decided once, by the chain id the deployment is configured
 * with, and shown on the chrome rather than inferred from a name.
 *
 * ## Empty is an answer, not a failure
 *
 * A fresh deployment has settled nothing, and that is a true statement about the
 * chain rather than a broken page. Every view that lists rows takes
 * {@link NetworkOption.emptyMeans} as the sentence it shows in their place, and
 * no view is permitted to render an empty feed as an error, as a spinner, or as
 * nothing at all.
 */

import { CHAINS, MONAD_TESTNET, isMonadChainId, type ChainDescriptor, type MonadChainId } from "@tabai/shared";

/** Whether a chain carries real value. Shown on the chrome, never inferred. */
export type ChainNetwork = "testnet" | "mainnet";

/** The network a deployment runs on, as the chrome and the views describe it. */
export interface NetworkOption {
  readonly chainId: MonadChainId;
  /** The chain's own name, from the shared table so it cannot drift. */
  readonly name: string;
  readonly network: ChainNetwork;
  /** Short label for a badge. */
  readonly shortName: string;
  readonly explorerUrl: string;
  /** The MON faucet, where one exists. */
  readonly faucetUrl: string | undefined;
  /** What an empty feed on this chain means. Never an error. */
  readonly emptyMeans: string;
}

/**
 * The chain a deployment reads when nothing names one.
 *
 * Testnet, deliberately. A deployment that has expressed no preference is
 * pointed at the chain where the value is not real, because the cost of
 * mistaking testnet for mainnet is smaller than the reverse.
 */
export const DEFAULT_CHAIN_ID: MonadChainId = MONAD_TESTNET.chainId;

/** The option for a chain id. Total over {@link MonadChainId}, so it cannot fail. */
export function networkOptionFor(chainId: MonadChainId): NetworkOption {
  const chain: ChainDescriptor = CHAINS[chainId];
  const network: ChainNetwork = chainId === MONAD_TESTNET.chainId ? "testnet" : "mainnet";
  return {
    chainId,
    name: chain.name,
    network,
    shortName: network === "testnet" ? "Testnet" : "Mainnet",
    explorerUrl: chain.explorerUrl,
    faucetUrl: chain.faucetUrl,
    emptyMeans: `Nothing has settled on ${chain.name} yet.`,
  };
}

/**
 * Reads a chain id from configuration.
 *
 * Anything unrecognised falls back to the default rather than erroring, because
 * a mistyped variable should show a working page on Testnet rather than a stack
 * trace. The value is a decimal chain id, matching `MONAD_CHAIN_ID` everywhere
 * else in the environment contract.
 */
export function parseChainId(raw: string | null | undefined): MonadChainId {
  if (raw === null || raw === undefined) return DEFAULT_CHAIN_ID;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_CHAIN_ID;
  const value = Number.parseInt(trimmed, 10);
  return isMonadChainId(value) ? value : DEFAULT_CHAIN_ID;
}

/** The explorer link for a transaction on the configured chain. */
export function explorerTxUrl(txHash: string, explorerUrl: string): string {
  return `${explorerUrl.replace(/\/+$/, "")}/tx/${txHash}`;
}

/** The explorer link for an address on the configured chain. */
export function explorerAddressUrl(address: string, explorerUrl: string): string {
  return `${explorerUrl.replace(/\/+$/, "")}/address/${address}`;
}
