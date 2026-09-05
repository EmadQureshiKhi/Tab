/**
 * What every route needs before it can render: which chain, and how to read.
 *
 * ## One place resolves the chain
 *
 * Every route takes its chain from the same function, so a route cannot forget
 * the filter and quietly render Sepolia rows under a Mainnet heading. An absent
 * or unreadable parameter resolves to the default rather than to an unfiltered
 * feed, because a feed mixing two Source Chains is the one answer no view here
 * wants (R5.1).
 *
 * ## No wallet, no signer, no key
 *
 * The registry client is the only reader a route gets. It holds a base URL and a
 * `fetch`, and there is no code path from here to an account, which is what makes
 * R24.9 architectural rather than a promise: a route could not connect a wallet
 * if it tried.
 *
 * Requirements: 24.9, 24.4, 5.1
 */

import { createChainReader, type ChainReader } from "../../src/dashboard/chain";
import { createRegistryClient, type RegistryClient } from "../../src/dashboard/client";
import {
  CHAIN_QUERY_PARAM,
  chainOptionFor,
  parseChainKeyParam,
  withChainParam,
  type ChainOption,
} from "../../src/dashboard/chains";
import { DEFAULT_EXPLORER_URL, blockscoutTxUrl } from "../../src/dashboard/views";
import type { ChainKey } from "@tabai/shared";

/** Search parameters as the App Router hands them over. */
export type SearchParams = Record<string, string | string[] | undefined>;

/** The first value of a parameter, since a repeated key arrives as an array. */
export function firstParam(params: SearchParams, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Base URL of the registry read API, from the environment contract. */
export function registryBaseUrl(): string {
  return process.env["NEXT_PUBLIC_REGISTRY_API_URL"] ?? "http://localhost:8787";
}

/** Blockscout base, from the environment contract. */
export function explorerBaseUrl(): string {
  return process.env["CREDITCOIN_EXPLORER_URL"] ?? DEFAULT_EXPLORER_URL;
}

/**
 * The Documentation Site, which is a separate project on its own domain.
 *
 * It falls back to the local port the docs app serves on rather than to a
 * production URL, because a developer running the Dashboard alone should get a
 * link that works on their machine rather than one that silently leaves it.
 */
export function docsUrl(): string {
  return process.env["NEXT_PUBLIC_DOCS_URL"] ?? "http://localhost:3001";
}

/** The reader every route uses. */
export function registry(): RegistryClient {
  return createRegistryClient({ baseUrl: registryBaseUrl() });
}

/** Creditcoin RPC endpoint, from the environment contract. */
export function creditcoinRpcUrl(): string {
  return process.env["CREDITCOIN_RPC_URL"] ?? "https://rpc.cc3-testnet.creditcoin.network";
}

/** `TabBook`, from the environment contract. */
export function tabBookAddress(): string | undefined {
  const address = process.env["TAB_BOOK_ADDRESS"]?.trim();
  if (address === undefined || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  // The template ships the zero address, which is present, well formed, and holds
  // no contract. Treated as absent, so an unfilled environment reports "not
  // configured" rather than "no clearings found", which is the same wrong answer
  // this Dashboard refuses to give everywhere else.
  if (/^0x0{40}$/i.test(address)) return undefined;
  return address.toLowerCase();
}

/**
 * First block a clearing scan starts from.
 *
 * The core was redeployed on 2026-09-06, so no block below this height can carry a
 * log from the current `TabBook`, and scanning from genesis would be thousands of
 * pointless windows against an endpoint that times out queries at ten seconds.
 *
 * A constant rather than an environment variable, matching `HISTORY_FROM_BLOCK` in
 * the gateway, which solves the same problem for the same deployment. It belongs
 * beside the addresses it goes with: a floor that disagreed with the deployment it
 * was scanning would silently return an empty list, and moving it into the
 * environment makes that mismatch easier to cause, not harder.
 */
export const CLEARING_SCAN_FROM_BLOCK = 5_407_360;

/** The keyless chain reader, for the two figures the index cannot supply. */
export function chain(): ChainReader {
  return createChainReader({ rpcUrl: creditcoinRpcUrl() });
}

/** Everything a route resolves before it renders anything. */
export interface RouteContext {
  readonly chainKey: ChainKey;
  readonly chain: ChainOption;
  readonly registry: RegistryClient;
  /** The Blockscout link for a Creditcoin transaction. */
  readonly explorerHrefFor: (txHash: string) => string;
  /** The same path on another chain, for the toggle. */
  readonly hrefOnChain: (path: string) => (chainKey: ChainKey) => string;
}

export function routeContext(params: SearchParams): RouteContext {
  const chainKey = parseChainKeyParam(firstParam(params, CHAIN_QUERY_PARAM));
  const explorer = explorerBaseUrl();
  return {
    chainKey,
    chain: chainOptionFor(chainKey),
    registry: registry(),
    explorerHrefFor: (txHash) => blockscoutTxUrl(txHash, explorer),
    hrefOnChain: (path) => (target) => withChainParam(path, target),
  };
}
