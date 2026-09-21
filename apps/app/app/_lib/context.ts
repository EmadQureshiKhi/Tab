/**
 * What every route needs before it can render: which network, and how to read.
 *
 * ## One chain per deployment
 *
 * Tab settles on the Monad chain it is deployed to and nowhere else. The Agent's
 * payment and the ledger entry happen in one transaction, so there is no second
 * chain a Settlement could have come from and no toggle to choose one. The chain
 * id comes from the environment once, here, and every route reads the same
 * answer, so a page cannot quietly render Testnet rows under a Mainnet heading.
 *
 * ## No wallet, no signer, no key
 *
 * The registry client is the only reader a route gets. It holds a base URL and a
 * `fetch`, and there is no code path from here to an account, which is what makes
 * "every read renders without a wallet" architectural rather than a promise: a
 * route could not connect a wallet if it tried.
 */

import { createChainReader, type ChainReader } from "../../src/dashboard/chain";
import { createRegistryClient, type RegistryClient } from "../../src/dashboard/client";
import {
  explorerAddressUrl,
  explorerTxUrl,
  networkOptionFor,
  parseChainId,
  type NetworkOption,
} from "../../src/dashboard/network";
import { registerAsset } from "../../src/dashboard/views";
import { registerAsset as registerAssetUnit } from "../../components/custom-ui/format";
import { CHAINS, type MonadChainId } from "@tabai/shared";

/** Search parameters as the App Router hands them over. */
export type SearchParams = Record<string, string | string[] | undefined>;

/** The first value of a parameter, since a repeated key arrives as an array. */
export function firstParam(params: SearchParams, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * An address from the environment, or nothing.
 *
 * The template ships the zero address, which is present, well formed, and holds
 * no contract. Treated as absent, so an unfilled environment reports "not
 * configured" rather than "nothing found", which is the same wrong answer this
 * Dashboard refuses to give everywhere else.
 */
function configuredAddress(raw: string | undefined): string | undefined {
  const address = raw?.trim();
  if (address === undefined || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  if (/^0x0{40}$/i.test(address)) return undefined;
  return address.toLowerCase();
}

/*
  The Testnet token is deployment output, so it is named here at module load
  rather than in the shared table: once `MOCK_USDC_ADDRESS` is set, every amount
  in it renders as mUSDC instead of as an address at zero decimals. It is
  `mUSDC` and not the `USDC` its own `symbol()` returns, because the demo
  Service accepts Circle's Testnet USDC beside it and a reader must be able to
  tell the two apart; the mock is minted freely and the real one is not. Both
  tables are told, because `components/` cannot import from `src/` and keeps a
  mirror.
*/
const mockUsdc = configuredAddress(process.env["MOCK_USDC_ADDRESS"]);
if (mockUsdc !== undefined) {
  registerAsset(mockUsdc, { symbol: "mUSDC", decimals: 6 });
  registerAssetUnit(mockUsdc, { symbol: "mUSDC", decimals: 6 });
}

/** The Monad chain this deployment reads, from the environment contract. */
export function chainId(): MonadChainId {
  return parseChainId(process.env["MONAD_CHAIN_ID"]);
}

/** The network, as the chrome and the views describe it. */
export function network(): NetworkOption {
  return networkOptionFor(chainId());
}

/** Base URL of the registry read API, from the environment contract. */
export function registryBaseUrl(): string {
  return process.env["NEXT_PUBLIC_REGISTRY_API_URL"] ?? "http://localhost:8787";
}

/** The block explorer, from the environment contract, defaulting to the network's own. */
export function explorerBaseUrl(): string {
  const configured = process.env["MONAD_EXPLORER_URL"]?.trim();
  return configured !== undefined && configured.length > 0 ? configured : network().explorerUrl;
}

/** The Monad RPC endpoint, from the environment contract, defaulting to the network's own. */
export function monadRpcUrl(): string {
  const configured = process.env["MONAD_RPC_URL"]?.trim();
  return configured !== undefined && configured.length > 0 ? configured : CHAINS[chainId()].rpcUrl;
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

/** `TabBook`, from the environment contract. */
export function tabBookAddress(): string | undefined {
  return configuredAddress(process.env["TAB_BOOK_ADDRESS"]);
}

/** `ServiceRegistry`, from the environment contract. */
export function serviceRegistryAddress(): string | undefined {
  return configuredAddress(process.env["SERVICE_REGISTRY_ADDRESS"]);
}

/** `Bond`, from the environment contract. */
export function bondAddress(): string | undefined {
  return configuredAddress(process.env["BOND_ADDRESS"]);
}

/** `TabSettlement`, from the environment contract. */
export function tabSettlementAddress(): string | undefined {
  return configuredAddress(process.env["TAB_SETTLEMENT_ADDRESS"]);
}

/** The Testnet mock token, where this deployment ships one. */
export function mockUsdcAddress(): string | undefined {
  return mockUsdc;
}

/** The keyless chain reader, for the figures the index cannot supply. */
export function chain(): ChainReader {
  return createChainReader({ rpcUrl: monadRpcUrl() });
}

/** Everything a route resolves before it renders anything. */
export interface RouteContext {
  readonly chainId: MonadChainId;
  readonly network: NetworkOption;
  readonly registry: RegistryClient;
  /** The explorer link for a Monad transaction. */
  readonly explorerHrefFor: (txHash: string) => string;
  /** The explorer link for a Monad address. */
  readonly explorerAddressHrefFor: (address: string) => string;
}

export function routeContext(): RouteContext {
  const explorer = explorerBaseUrl();
  return {
    chainId: chainId(),
    network: network(),
    registry: registry(),
    explorerHrefFor: (txHash) => explorerTxUrl(txHash, explorer),
    explorerAddressHrefFor: (address) => explorerAddressUrl(address, explorer),
  };
}
