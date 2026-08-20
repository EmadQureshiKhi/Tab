/**
 * Chain constants: the single definition of every chain-level fact.
 *
 * Two Source Chains exist on this network and no more. A read of the ChainInfo
 * Precompile on CC3 Testnet returned exactly two supported chains, so the
 * chainKey space is closed at `1` and `3`. {@link ChainKey} encodes that
 * closure in the type system: an unknown chainKey fails to compile, and
 * {@link isSupportedChainKey} performs the same check on a runtime value that
 * arrived as `unknown` from a proof, an RPC response, or a request body.
 *
 * Requirements: 5.6, 18.1
 */

import type { Address } from "./hex.js";

/** Creditcoin CC3 Testnet, the settlement-verification home chain. */
export const CREDITCOIN = {
  name: "Creditcoin CC3 Testnet",
  chainId: 102031,
  rpcUrl: "https://rpc.cc3-testnet.creditcoin.network",
  explorerUrl: "https://creditcoin-testnet.blockscout.com",
} as const;

/**
 * Precompile addresses, pinned here and nowhere else.
 *
 * The casing is the casing used on chain and in `.env.example`; both addresses
 * compare case-insensitively, so nothing depends on it.
 */
export const PRECOMPILES = {
  /** BlockProver: `verifyAndEmit`, `calculateTxIndex`. */
  blockProver: "0x0000000000000000000000000000000000000FD2",
  /** ChainInfo: supported chains, attested heights, attested block digests. */
  chainInfo: "0x0000000000000000000000000000000000000fd3",
} as const satisfies Readonly<Record<string, Address>>;

/**
 * The zero address, used as the placeholder for any address not yet fixed.
 *
 * This follows the convention `.env.example` already uses: an undeployed or
 * undecided address is the zero address, flagged as pending rather than guessed.
 */
export const PLACEHOLDER_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Every chainKey this network attests. Closed set. */
export const CHAIN_KEYS = [1, 3] as const;

/** A Source Chain identifier. `1` is Ethereum Sepolia, `3` is Ethereum Mainnet. */
export type ChainKey = (typeof CHAIN_KEYS)[number];

/** How a Settlement reaches the chain: a Tab contract event, or a plain token transfer. */
export type SettlementSurface = "settlement-contract" | "erc20-transfer";

export interface AssetDescriptor {
  readonly symbol: "USDC";
  /** USDC is 6 decimals on both Source Chains. Every amount is integer base units. */
  readonly decimals: 6;
  readonly address: Address;
  /**
   * True while {@link AssetDescriptor.address} is {@link PLACEHOLDER_ADDRESS}.
   * Callers that submit or filter on the address must refuse to run while this
   * is set rather than treat the zero address as a real token.
   */
  readonly addressPending: boolean;
}

export interface ChainDescriptor {
  readonly chainKey: ChainKey;
  readonly name: string;
  /** The chain's own EVM chain id, distinct from its chainKey. */
  readonly evmChainId: number;
  /** The name the ChainInfo Precompile reports for this chain. */
  readonly attestedName: string;
  readonly settlementSurface: SettlementSurface;
  readonly usdc: AssetDescriptor;
  /**
   * Seconds a Provisional Clearing stays applied before it may be reversed,
   * sized to the attestation latency of this chain.
   */
  readonly clearingDeadlineSeconds: number;
}

/**
 * The chain table. Keyed by literal chainKey, so `CHAINS[2]` is a compile error
 * and `CHAINS[chainKey]` never widens to `undefined`.
 */
export const CHAINS = {
  1: {
    chainKey: 1,
    name: "Ethereum Sepolia",
    evmChainId: 11155111,
    attestedName: "Sepolia ethereum",
    settlementSurface: "settlement-contract",
    usdc: {
      symbol: "USDC",
      decimals: 6,
      // Not yet fixed. Stays the placeholder until the Sepolia asset is chosen
      // and registered, at which point `SEPOLIA_USDC_ADDRESS` fills in too.
      address: PLACEHOLDER_ADDRESS,
      addressPending: true,
    },
    clearingDeadlineSeconds: 1800,
  },
  3: {
    chainKey: 3,
    name: "Ethereum Mainnet",
    evmChainId: 1,
    attestedName: "Ethereum",
    settlementSurface: "erc20-transfer",
    usdc: {
      symbol: "USDC",
      decimals: 6,
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      addressPending: false,
    },
    clearingDeadlineSeconds: 3600,
  },
} as const satisfies Readonly<Record<ChainKey, ChainDescriptor>>;

/** Runtime counterpart of the {@link ChainKey} type. */
export function isSupportedChainKey(value: unknown): value is ChainKey {
  return typeof value === "number" && (CHAIN_KEYS as readonly number[]).includes(value);
}

/**
 * Narrows a chainKey that arrived as a `uint64` — from a proof or an RPC read —
 * to a supported {@link ChainKey}, or returns `undefined` when the chain is not
 * one this network attests.
 */
export function toChainKey(value: bigint | number): ChainKey | undefined {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    const narrowed = Number(value);
    return isSupportedChainKey(narrowed) ? narrowed : undefined;
  }
  return isSupportedChainKey(value) ? value : undefined;
}

/** The descriptor for a chainKey. Total over {@link ChainKey}, so it cannot fail. */
export const chainFor = <K extends ChainKey>(chainKey: K): (typeof CHAINS)[K] => CHAINS[chainKey];

/** Seconds a Provisional Clearing on `chainKey` stays applied before reversal. */
export const clearingDeadlineSecondsFor = (chainKey: ChainKey): number =>
  CHAINS[chainKey].clearingDeadlineSeconds;

/** The USDC descriptor for `chainKey`. */
export const usdcFor = (chainKey: ChainKey): AssetDescriptor => CHAINS[chainKey].usdc;
