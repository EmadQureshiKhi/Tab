/**
 * The network: which Monad chain every view on the Dashboard is talking about.
 *
 * ## One chain per view, chosen by the visitor
 *
 * The Agent's payment and the ledger entry happen in one Monad transaction, so
 * a Settlement belongs to exactly one network and no view ever mixes two. What
 * the Dashboard offers is both networks, one at a time: Testnet, where the
 * money is not real, and Mainnet, where it is. The visitor picks one on the
 * masthead switch, the choice is kept in a first-party cookie, and every server
 * render and every API call resolves that one choice before it reads anything,
 * so a page cannot render Testnet rows under a Mainnet heading. With no choice
 * made, the deployment's own `MONAD_CHAIN_ID` decides. Whether the figures are
 * test money or real money is shown on the chrome in words rather than
 * inferred from a name.
 *
 * ## Empty is an answer, not a failure
 *
 * A fresh deployment has settled nothing, and that is a true statement about the
 * chain rather than a broken page. Every view that lists rows takes
 * {@link NetworkOption.emptyMeans} as the sentence it shows in their place, and
 * no view is permitted to render an empty feed as an error, as a spinner, or as
 * nothing at all.
 */

import {
  CHAINS,
  MONAD_MAINNET,
  MONAD_TESTNET,
  isMonadChainId,
  type ChainDescriptor,
  type MonadChainId,
} from "@tabai/shared";

/** Whether a chain carries real value. Shown on the chrome, never inferred. */
export type ChainNetwork = "testnet" | "mainnet";

/** A network, as the chrome and the views describe it. */
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
 * mistaking testnet for mainnet is smaller than the reverse. A visitor's own
 * choice on the masthead switch overrides it; see {@link selectChainId}.
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

/** The explorer link for a transaction on the selected chain. */
export function explorerTxUrl(txHash: string, explorerUrl: string): string {
  return `${explorerUrl.replace(/\/+$/, "")}/tx/${txHash}`;
}

/** The explorer link for an address on the selected chain. */
export function explorerAddressUrl(address: string, explorerUrl: string): string {
  return `${explorerUrl.replace(/\/+$/, "")}/address/${address}`;
}

/* ------------------------------------------------------- the visitor's choice */

/**
 * The cookie that carries the visitor's network.
 *
 * First-party and never sent anywhere but this origin. It holds a word rather
 * than a chain id, so it reads plainly in a browser's storage panel and cannot
 * be mistaken for a figure.
 */
export const NETWORK_COOKIE = "tab-network";

/** A year, in seconds. The choice outlives a session but not a device. */
export const NETWORK_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** The chain id a network word stands for. */
export function chainIdForNetwork(kind: ChainNetwork): MonadChainId {
  return kind === "testnet" ? MONAD_TESTNET.chainId : MONAD_MAINNET.chainId;
}

/**
 * Reads the cookie's value.
 *
 * Exactly `testnet` or `mainnet`, ignoring case and surrounding space. Anything
 * else is no choice at all, so a tampered or stale cookie falls back to the
 * deployment's default rather than to whichever network a parser happened to
 * lean towards.
 */
export function parseNetworkCookie(raw: string | null | undefined): ChainNetwork | undefined {
  if (raw === null || raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  return value === "testnet" || value === "mainnet" ? value : undefined;
}

/** The chain a visitor is shown: their choice when they made one, else the fallback. */
export function selectChainId(raw: string | null | undefined, fallback: MonadChainId): MonadChainId {
  const chosen = parseNetworkCookie(raw);
  return chosen === undefined ? fallback : chainIdForNetwork(chosen);
}

/**
 * One cookie's value out of a `Cookie` request header.
 *
 * The API routes read the choice from the request itself. A same-origin
 * `fetch` or `EventSource` carries the cookie without being asked, so the feed
 * a page opens is on the network the page was rendered for.
 */
export function cookieFromHeader(header: string | null | undefined, name: string): string | undefined {
  if (header === null || header === undefined) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/**
 * The `document.cookie` assignment that records a choice.
 *
 * Whole-site path, `SameSite=Lax` so it rides along on a link followed from
 * elsewhere, and a year's lifetime. No `Secure` flag: the value is a public
 * preference rather than a credential, and the flag would stop it being set on
 * a plain-HTTP development host.
 */
export function networkCookieAssignment(kind: ChainNetwork): string {
  return `${NETWORK_COOKIE}=${kind}; Path=/; Max-Age=${NETWORK_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}
