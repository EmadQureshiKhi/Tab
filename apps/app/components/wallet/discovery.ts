/**
 * Finding every wallet in the browser, rather than whichever one won the race.
 *
 * `window.ethereum` is a single slot that every injected wallet writes to, so
 * with two installed it holds whichever loaded last, and with none it holds
 * nothing at all. Reading it was why pressing Connect could appear to do nothing:
 * there was no provider, the failure was recorded, and the button had no way to
 * say so.
 *
 * EIP-6963 replaces the slot with an announcement. A page dispatches
 * `eip6963:requestProvider`, every installed wallet answers with its own
 * provider, a name, an icon and a uuid, and the reader picks. No connector
 * library is involved: it is two events and an array.
 *
 * `window.ethereum` is still read, as a last resort, for a wallet too old to
 * announce itself. It is listed as "Injected wallet" because that is genuinely
 * all that is known about it - naming it would be a guess.
 */

import type { Eip1193Provider } from "./eip1193";

export interface DiscoveredWallet {
  /** Stable for the life of the page. Identifies the choice, not the wallet. */
  readonly uuid: string;
  readonly name: string;
  /** A data URI the wallet supplies. Rendered as given; never fetched. */
  readonly icon: string | undefined;
  readonly provider: Eip1193Provider;
}

/**
 * The wallets this product names first, and where to get one.
 *
 * Announced wallets always come first and always win: this list is what to show
 * a reader who has none, so the menu can say what would work rather than only
 * that nothing did. A wallet here that the reader has installed is not drawn
 * from this list at all - it announced itself, with its own name and its own
 * icon, and that is the entry used.
 *
 * The mark is this repository's own file rather than a URL, because a menu that
 * fetched brand assets from four vendors on open would be telling four vendors
 * when somebody opened it.
 */
export interface SuggestedWallet {
  readonly name: string;
  readonly icon: string;
  readonly url: string;
  /**
   * Said beside the name where the wallet cannot sign on Creditcoin.
   *
   * Tab signs on a custom EVM network, so a wallet that cannot add one cannot be
   * used here however good it is elsewhere. Listing it without saying so would
   * send somebody to install a wallet that will not work, which is worse than
   * leaving it out.
   */
  readonly caveat?: string;
}

/**
 * A mark this repository holds for a wallet, by name.
 *
 * An announced wallet supplies its own icon, and this is the fallback for one
 * whose icon cannot be used. That happens more often than it sounds: the icon is
 * only accepted as a `data:` URI, because a wallet should not get to make this
 * page fetch from a host of its choosing, and an installed Phantom announcing an
 * `https:` icon therefore arrived with none and drew as the letter P.
 */
export function knownMark(name: string): string | undefined {
  const needle = name.trim().toLowerCase();
  return SUGGESTED.find((entry) => entry.name.toLowerCase() === needle)?.icon;
}

export const SUGGESTED: readonly SuggestedWallet[] = [
  { name: "MetaMask", icon: "/logos/wallets/metamask.svg", url: "https://metamask.io/download" },
  { name: "Trust Wallet", icon: "/logos/wallets/trust.svg", url: "https://trustwallet.com/download" },
  { name: "Phantom", icon: "/logos/wallets/phantom.svg", url: "https://phantom.com/download" },
  {
    name: "HashPack",
    icon: "/logos/wallets/hashpack.svg",
    url: "https://www.hashpack.app/download",
    caveat: "cannot add Creditcoin",
  },
];

interface AnnounceDetail {
  readonly info: { readonly uuid: string; readonly name: string; readonly icon: string };
  readonly provider: Eip1193Provider;
}

/**
 * Subscribes to announcements and asks for them.
 *
 * Wallets answer synchronously, but they answer whenever they are ready, so the
 * listener stays attached: one installed late still arrives, and the caller is
 * told again with the fuller list.
 */
export function watchWallets(onChange: (wallets: readonly DiscoveredWallet[]) => void): () => void {
  if (typeof window === "undefined") return () => undefined;

  const found = new Map<string, DiscoveredWallet>();

  const announce = (event: Event): void => {
    const detail = (event as CustomEvent<AnnounceDetail>).detail;
    if (detail?.info?.uuid === undefined || typeof detail.provider?.request !== "function") return;
    if (found.has(detail.info.uuid)) return;
    found.set(detail.info.uuid, {
      uuid: detail.info.uuid,
      name: detail.info.name,
      // Only a data URI. A wallet is not given the chance to make this page
      // fetch from a host of its choosing.
      icon: detail.info.icon?.startsWith("data:") === true ? detail.info.icon : undefined,
      provider: detail.provider,
    });
    onChange([...found.values()]);
  };

  window.addEventListener("eip6963:announceProvider", announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  // A wallet that predates the standard writes the slot and announces nothing.
  const legacy = (globalThis as { ethereum?: Eip1193Provider }).ethereum;
  if (typeof legacy?.request === "function" && found.size === 0) {
    found.set("injected", {
      uuid: "injected",
      name: "Injected wallet",
      icon: undefined,
      provider: legacy,
    });
    onChange([...found.values()]);
  }

  return () => window.removeEventListener("eip6963:announceProvider", announce);
}
