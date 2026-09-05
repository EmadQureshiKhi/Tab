"use client";

/**
 * The masthead, in the reference's shape.
 *
 * Three columns on a wide screen so the links sit centred regardless of how long
 * the brand or the actions are, and two on a narrow one with the links folded
 * into a sheet. Links are mono, uppercase and letter-spaced, and the current one
 * is marked with a dotted underline rather than a colour alone, so the state
 * survives a reader who cannot separate the two.
 *
 * The chain toggle stays. It is the one control here that changes what the page
 * is showing rather than where you are, and it is the reason a link can be shared
 * and reopened on the same chain.
 */

import { useEffect, useState } from "react";
import { Menu, Moon, Sun, X } from "lucide-react";

import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import { useTheme } from "../providers/theme-context";
import { ScrollProgress } from "../motion/scroll-progress";
import { ChainToggle } from "../views/chain-toggle";
import { ConnectWallet } from "../wallet/connect-wallet";
import {
  CHAIN_OPTIONS,
  CHAIN_QUERY_PARAM,
  DEFAULT_CHAIN_KEY,
} from "../../src/dashboard/chains";
import type { ChainKey } from "@tabai/shared";

const LINKS = [
  // First, because it is the one route a reader who has just arrived can act on.
  { href: "/browse", label: "Browse" },
  { href: "/explorer", label: "Explorer" },
  { href: "/agents", label: "Agents" },
  { href: "/services", label: "Services" },
  { href: "/analytics", label: "Analytics" },
  { href: "/register", label: "Register" },
] as const;

/**
 * Carries the selected chain across a navigation.
 *
 * The chain lives in the query string, so a plain `/explorer` drops it and the
 * next page renders the default. A reader who picked Mainnet and then opened the
 * explorer found themselves on Sepolia, which reads as the toggle springing back
 * rather than as the link discarding it. The default is left bare, so the common
 * case has clean URLs.
 */
function withChain(href: string, chainKey: ChainKey): string {
  if (chainKey === DEFAULT_CHAIN_KEY) return href;
  return `${href}?${CHAIN_QUERY_PARAM}=${chainKey}`;
}

const LINK_CLASSES =
  "h-8 px-2 font-mono text-[13px] tracking-wider text-muted-foreground hover:text-foreground hover:underline hover:decoration-dotted underline-offset-2";
const ACTIVE_CLASSES = "text-foreground underline decoration-dotted";

export interface NavbarProps {
  readonly pathname: string;
  readonly chainKey: ChainKey;
  readonly docsUrl: string;
}

export function Navbar({ pathname, chainKey, docsUrl }: NavbarProps) {
  const { isDark, mounted, toggleTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  // The sheet is a full-screen overlay, so the page behind it must not scroll
  // under the reader's finger while it is open.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const brandColor = mounted ? (isDark ? "text-white" : "text-black") : "";

  return (
    <nav className="sticky top-0 z-40 w-full border-b border-gray-200 bg-white/95 backdrop-blur transition-colors duration-200 dark:border-gray-800 dark:bg-black/95">
      <ScrollProgress />
      {/*
        The desktop masthead folds at `lg`, not at `sm`. Five links, a docs link, a
        two-option chain toggle and a theme button do not fit beside the wordmark at
        768px: the row ran 132px past the viewport and the whole page scrolled
        sideways at that width, in both themes and on every route. The reference's
        own masthead carries three links and no toggle, so `sm` was right there and
        wrong here. Below `lg` everything folds into the sheet, which already carries
        the toggle.
      */}
      <div className="w-full px-2">
        <div className="flex items-center justify-between py-2 lg:grid lg:grid-cols-[1fr_auto_1fr]">
          <div className="flex items-center">
            <a href="/" className="flex items-center gap-2 no-underline">
              <img
                src="/logo.png"
                alt=""
                width={34}
                height={34}
                className="size-[30px] rounded-sm lg:size-[34px]"
              />
              {/*
                Nudged down by a pixel and a half. The wordmark has no descender,
                so metric centring puts its optical mass above the centre of the
                square mark beside it and the two read as misaligned.
              */}
              <span className="translate-y-[1.5px] font-host text-lg font-bold lg:text-xl">
                <span className={brandColor}>Tab</span>
                <span className="text-neutral-400">.</span>
              </span>
            </a>
          </div>

          <div className="hidden items-center justify-center gap-6 lg:flex">
            {LINKS.map((link) => (
              <a
                key={link.href}
                href={withChain(link.href, chainKey)}
                aria-current={isActive(link.href) ? "page" : undefined}
                className={cn(
                  "inline-flex items-center no-underline",
                  LINK_CLASSES,
                  isActive(link.href) && ACTIVE_CLASSES,
                )}
              >
                {link.label.toUpperCase()}
              </a>
            ))}
            <a
              href={docsUrl}
              target="_blank"
              rel="noreferrer"
              className={cn("inline-flex items-center no-underline", LINK_CLASSES)}
            >
              DOCS
            </a>
          </div>

          <div className="flex items-center justify-end gap-1">
            <div className="hidden lg:block">
              <ChainToggle
                options={CHAIN_OPTIONS}
                selected={chainKey}
                hrefFor={(key) => `?chainKey=${key}`}
              />
            </div>
            {/*
              After the chain toggle, not before it. The chain is a property of
              every page; the wallet is needed by two of them.
            */}
            <ConnectWallet className="hidden lg:block" />
            <Button
              variant="link"
              size="icon"
              aria-label={mounted && isDark ? "Switch to the light theme" : "Switch to the dark theme"}
              onClick={toggleTheme}
              className="text-muted-foreground hover:text-foreground"
            >
              {mounted && isDark ? (
                <Sun className="h-4 w-4 text-amber-500" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="Open the menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>

      {menuOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          className="fixed inset-0 z-50 flex flex-col bg-white text-foreground lg:hidden dark:bg-black"
        >
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-2">
              <img src="/logo.png" alt="" width={28} height={28} className="rounded-sm" />
              <span className="translate-y-[1.5px] font-host text-2xl font-bold">
                <span className={brandColor}>Tab</span>
                <span className="text-neutral-400">.</span>
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close the menu"
              onClick={() => setMenuOpen(false)}
            >
              <X className="h-6 w-6" />
            </Button>
          </div>
          <div className="flex flex-col gap-1 px-6 py-4">
            {LINKS.map((link) => (
              <a
                key={link.href}
                href={withChain(link.href, chainKey)}
                onClick={() => setMenuOpen(false)}
                aria-current={isActive(link.href) ? "page" : undefined}
                className={cn(
                  "py-3 font-mono text-base tracking-wider text-muted-foreground uppercase no-underline",
                  isActive(link.href) && "text-foreground",
                )}
              >
                {link.label.toUpperCase()}
              </a>
            ))}
            <a
              href={docsUrl}
              target="_blank"
              rel="noreferrer"
              className="py-3 font-mono text-base tracking-wider text-muted-foreground uppercase no-underline"
            >
              DOCS
            </a>
          </div>
          <div className="mt-auto flex flex-col items-start gap-3 px-6 pb-8">
            <ChainToggle
              options={CHAIN_OPTIONS}
              selected={chainKey}
              hrefFor={(key) => `?chainKey=${key}`}
            />
            <ConnectWallet />
          </div>
        </div>
      ) : null}
    </nav>
  );
}
