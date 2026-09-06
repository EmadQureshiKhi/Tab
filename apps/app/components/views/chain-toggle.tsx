/**
 * `ChainToggle` - the control that decides which Source Chain the Dashboard is
 * about.
 *
 * ## It states the network, it does not imply it
 *
 * The selected option always carries the word `testnet` or `mainnet` in text, not
 * only in colour and not only in the chain's name. A reader should never have to
 * know that "Sepolia" means test money to read a balance correctly, and a reader
 * using a screen reader gets the same sentence as everyone else because the
 * network word is in the accessible name rather than in a swatch.
 *
 * ## A link, not a button
 *
 * Each option is an anchor carrying `?chainKey=`, so the chain is in the URL and
 * a view of one chain is shareable, bookmarkable, and reachable with JavaScript
 * disabled. That is the same property R24.9 asks of every read-only route: it
 * has to work without a wallet, and here it also works without a client runtime.
 * Persisting the choice per viewer is a convenience layered on top by the shell,
 * never the source of truth.
 *
 * This is a server component. It has no state and no clock.
 *
 * Requirements: 24.4, 24.9
 */

import type { ChainKey } from "@tabai/shared";

import { cn } from "../ui/cn";
import { FOCUS_RING } from "../ui/focus-ring";

/**
 * One option, declared structurally rather than imported from the core.
 *
 * The component states what it needs and the composition layer supplies it, so
 * this file depends on no module outside `components/`. `src/dashboard`'s
 * `ChainOption` is assignable to this by construction.
 */
export interface ChainOptionView {
  readonly chainKey: ChainKey;
  readonly name: string;
  readonly shortName: string;
  readonly network: "testnet" | "mainnet";
}

export interface ChainToggleProps {
  readonly options: readonly ChainOptionView[];
  readonly selected: ChainKey;
  /**
   * The path each option links to, with the chain appended by the caller. The
   * toggle never invents a URL, because only the route knows which one it is on.
   */
  readonly hrefFor: (chainKey: ChainKey) => string;
  readonly className?: string | undefined;
}

const NETWORK_LABEL: Readonly<Record<"testnet" | "mainnet", string>> = {
  testnet: "testnet",
  mainnet: "mainnet",
};

/**
 * The network word, unless the chain's short name already is that word.
 *
 * Ethereum Mainnet's short name is "Mainnet", so appending the network kind rendered
 * "MAINNET MAINNET" in the toggle while Sepolia read correctly as "SEPOLIA TESTNET".
 * Dropping the duplicate keeps the rule the component is built on: the network is
 * always stated in words rather than carried by colour alone. It is stated once.
 */
function networkSuffix(shortName: string, network: "testnet" | "mainnet"): string | undefined {
  const label = NETWORK_LABEL[network];
  return shortName.toLowerCase() === label.toLowerCase() ? undefined : label;
}

export function ChainToggle({ options, selected, hrefFor, className }: ChainToggleProps) {
  return (
    <nav
      aria-label="Source Chain"
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 p-1",
        className,
      )}
    >
      {options.map((option) => {
        const current = option.chainKey === selected;
        return (
          <a
            key={option.chainKey}
            href={hrefFor(option.chainKey)}
            // `aria-current="page"` rather than a pressed state: these are links
            // to two views of the site, not a two-state control.
            {...(current ? { "aria-current": "page" as const } : {})}
            aria-label={
              networkSuffix(option.shortName, option.network) === undefined
                ? option.name
                : `${option.name}, ${NETWORK_LABEL[option.network]}`
            }
            className={cn(
              "rounded px-3 py-1.5 font-mono text-xs tracking-wide uppercase no-underline",
              FOCUS_RING,
              // The tinted teal the reference uses for its own primary action,
              // rather than a solid accent fill. A saturated block in the masthead
              // sat louder than the wordmark beside it and was the first thing the
              // eye landed on, which is the wrong thing on every page.
              current
                ? "bg-teal-500/10 text-teal-700 dark:bg-teal-800/50 dark:text-teal-200"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
          >
            <span>{option.shortName}</span>
            {networkSuffix(option.shortName, option.network) !== undefined && (
              <span aria-hidden="true" className="ml-2 opacity-70">
                {networkSuffix(option.shortName, option.network)}
              </span>
            )}
          </a>
        );
      })}
    </nav>
  );
}
