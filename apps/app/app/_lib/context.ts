/**
 * What every route needs before it can render: which network, and how to read.
 *
 * ## One network per render, chosen by the visitor
 *
 * The Dashboard serves Monad Testnet and Monad Mainnet from one deployment,
 * and the visitor picks which with the switch on the masthead. The choice is
 * the `tab-network` cookie, read here and nowhere else: a page resolves it with
 * {@link routeContext}, an API route with {@link requestContext}, and both hand
 * back one {@link NetworkContext} carrying the chain, the contracts, the
 * readers and the links for that network. Nothing below a route asks the
 * question again, so a page cannot render Testnet rows under a Mainnet
 * heading. With no cookie, `MONAD_CHAIN_ID` names the network, as it did when
 * a deployment served only one.
 *
 * ## Contracts are built in, hosts are configured
 *
 * The contract addresses are transaction results and the same for every host,
 * so they come from `src/dashboard/deployments.ts`. What differs per host is
 * where the registry read API and the RPC endpoint live, and each network has
 * its own variable for those. The unsuffixed variables a single-network
 * deployment set still work, for the default network only: a Testnet registry
 * URL answering for Mainnet would be the one mistake this file exists to make
 * impossible, so a network with nothing configured reports that instead.
 *
 * ## No wallet, no signer, no key
 *
 * The registry client is the only reader a route gets. It holds a base URL and a
 * `fetch`, and there is no code path from here to an account, which is what makes
 * "every read renders without a wallet" architectural rather than a promise: a
 * route could not connect a wallet if it tried.
 */

import { cookies } from "next/headers";

import { createChainReader, type ChainReader } from "../../src/dashboard/chain";
import { createRegistryClient, type RegistryClient } from "../../src/dashboard/client";
import { DEPLOYMENTS, deploymentFor, type NetworkDeployment } from "../../src/dashboard/deployments";
import {
  NETWORK_COOKIE,
  cookieFromHeader,
  explorerAddressUrl,
  explorerTxUrl,
  networkOptionFor,
  parseChainId,
  selectChainId,
  type NetworkOption,
} from "../../src/dashboard/network";
import { registerAsset } from "../../src/dashboard/views";
import { registerAsset as registerAssetUnit } from "../../components/custom-ui/format";
import { CHAINS, MONAD_TESTNET, type MonadChainId } from "@tabai/shared";

/** Search parameters as the App Router hands them over. */
export type SearchParams = Record<string, string | string[] | undefined>;

/** The first value of a parameter, since a repeated key arrives as an array. */
export function firstParam(params: SearchParams, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/*
  The Testnet token is named here at module load rather than in the shared
  table, because it is this project's deployment output rather than a network
  constant. It is `mUSDC` and not the `USDC` its own `symbol()` returns, because
  the demo Service accepts Circle's Testnet USDC beside it and a reader must be
  able to tell the two apart; the mock is minted freely and the real one is
  not. Both tables are told, because `components/` cannot import from `src/`
  and keeps a mirror.
*/
for (const deployment of Object.values(DEPLOYMENTS)) {
  if (deployment.mockUsdc === undefined) continue;
  registerAsset(deployment.mockUsdc, { symbol: "mUSDC", decimals: 6 });
  registerAssetUnit(deployment.mockUsdc, { symbol: "mUSDC", decimals: 6 });
}

/** A configured value, or nothing where the variable is unset or blank. */
function configured(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

const isTestnet = (chainId: MonadChainId): boolean => chainId === MONAD_TESTNET.chainId;

/** The network a visitor who has not chosen one is shown, from the environment contract. */
export function defaultChainId(): MonadChainId {
  return parseChainId(process.env["MONAD_CHAIN_ID"]);
}

/** The network this render is for: the visitor's cookie, else the default. */
export async function selectedChainId(): Promise<MonadChainId> {
  const jar = await cookies();
  return selectChainId(jar.get(NETWORK_COOKIE)?.value, defaultChainId());
}

/**
 * The network an API request is for.
 *
 * A `network` query parameter first, so a monitor can probe either network
 * without holding a cookie; then the cookie the page's own `fetch` carries;
 * then the default.
 */
export function requestChainId(request: Request): MonadChainId {
  const fallback = defaultChainId();
  const asked = new URL(request.url).searchParams.get("network");
  if (asked !== null) return selectChainId(asked, fallback);
  return selectChainId(cookieFromHeader(request.headers.get("cookie"), NETWORK_COOKIE), fallback);
}

/**
 * Base URL of the registry read API for a network.
 *
 * Each network indexes into its own database behind its own API. The
 * unsuffixed variable is honoured for the default network only, and a network
 * with nothing configured gets an empty base, which the client reports as
 * `REGISTRY_BASE_URL_MISSING` rather than reading another network's rows.
 */
export function registryBaseUrl(chainId: MonadChainId): string {
  const own = configured(
    isTestnet(chainId)
      ? process.env["NEXT_PUBLIC_REGISTRY_API_URL_TESTNET"]
      : process.env["NEXT_PUBLIC_REGISTRY_API_URL_MAINNET"],
  );
  if (own !== undefined) return own;
  if (chainId !== defaultChainId()) return "";
  return configured(process.env["NEXT_PUBLIC_REGISTRY_API_URL"]) ?? "http://localhost:8787";
}

/** The Monad RPC endpoint for a network: its own variable, the shared one on the default network, else the public one. */
export function monadRpcUrl(chainId: MonadChainId): string {
  const own = configured(
    isTestnet(chainId) ? process.env["MONAD_RPC_URL_TESTNET"] : process.env["MONAD_RPC_URL_MAINNET"],
  );
  if (own !== undefined) return own;
  const shared = chainId === defaultChainId() ? configured(process.env["MONAD_RPC_URL"]) : undefined;
  return shared ?? CHAINS[chainId].rpcUrl;
}

/** The block explorer for a network: the configured one on the default network, else the network's own. */
export function explorerBaseUrl(chainId: MonadChainId): string {
  const shared = chainId === defaultChainId() ? configured(process.env["MONAD_EXPLORER_URL"]) : undefined;
  return shared ?? CHAINS[chainId].explorerUrl;
}

/**
 * The Agent a trial call on a network is billed to, where one is named.
 *
 * Each network's demo Agent is its own account with its own Open Tab, so each
 * has its own variable; the unsuffixed one stands in on the default network.
 */
export function tryItAgent(chainId: MonadChainId): string | undefined {
  const own = configured(
    isTestnet(chainId) ? process.env["TRY_IT_AGENT_TESTNET"] : process.env["TRY_IT_AGENT_MAINNET"],
  );
  if (own !== undefined) return own;
  return chainId === defaultChainId() ? configured(process.env["TRY_IT_AGENT"]) : undefined;
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

/** Everything a route resolves before it renders anything, for one network. */
export interface NetworkContext {
  readonly chainId: MonadChainId;
  readonly network: NetworkOption;
  /** Tab's contracts on this network, from the built-in table. */
  readonly contracts: NetworkDeployment;
  readonly registry: RegistryClient;
  /** The keyless chain reader, for the figures the index cannot supply. */
  readonly chain: ChainReader;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  /** The explorer link for a Monad transaction. */
  readonly explorerHrefFor: (txHash: string) => string;
  /** The explorer link for a Monad address. */
  readonly explorerAddressHrefFor: (address: string) => string;
}

/** The context for a named network. Construction reads nothing over the network. */
export function networkContext(chainId: MonadChainId): NetworkContext {
  const explorer = explorerBaseUrl(chainId);
  const rpcUrl = monadRpcUrl(chainId);
  return {
    chainId,
    network: networkOptionFor(chainId),
    contracts: deploymentFor(chainId),
    registry: createRegistryClient({ baseUrl: registryBaseUrl(chainId) }),
    chain: createChainReader({ rpcUrl }),
    rpcUrl,
    explorerUrl: explorer,
    explorerHrefFor: (txHash) => explorerTxUrl(txHash, explorer),
    explorerAddressHrefFor: (address) => explorerAddressUrl(address, explorer),
  };
}

/** The context for the network this page render is for. */
export async function routeContext(): Promise<NetworkContext> {
  return networkContext(await selectedChainId());
}

/** The context for the network an API request is for. */
export function requestContext(request: Request): NetworkContext {
  return networkContext(requestChainId(request));
}
