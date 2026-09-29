"use client";

/**
 * The masthead.
 *
 * Three columns on a wide screen so the links sit centred regardless of how long
 * the brand or the actions are, and two on a narrow one with the links folded
 * into a sheet. Links are mono, uppercase and letter-spaced, and the current one
 * is marked with a dotted underline rather than a colour alone, so the state
 * survives a reader who cannot separate the two.
 *
 * ## The network switch
 *
 * The Dashboard shows one Monad network at a time and the visitor picks which,
 * so the masthead both states the network and offers the other one. The word
 * `Testnet` or `Mainnet` is in the text, not only in a colour, because a reader
 * should never have to know that a name means test money to read a balance
 * correctly. It is on every page for the same reason the connection is: a
 * reader about to sign needs to know which chain before they press, not after
 * the dialog opens.
 */

import { useEffect, useState } from "react";
import { Menu, Moon, Sun, X } from "lucide-react";

import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import { useTheme } from "../providers/theme-context";
import { ScrollProgress } from "../motion/scroll-progress";
import { ConnectWallet } from "../wallet/connect-wallet";
import { NetworkSwitch } from "./network-switch";

const LINKS = [
  // First, because it is the one route a reader who has just arrived can act on.
  { href: "/browse", label: "Browse" },
  { href: "/explorer", label: "Explorer" },
  { href: "/agents", label: "Agents" },
  { href: "/services", label: "Services" },
  { href: "/analytics", label: "Analytics" },
  { href: "/authorise", label: "Authorise" },
  { href: "/keys", label: "Keys" },
] as const;

const LINK_CLASSES =
  "h-8 px-2 font-mono text-[13px] tracking-wider text-muted-foreground hover:text-foreground hover:underline hover:decoration-dotted underline-offset-2";
const ACTIVE_CLASSES = "text-foreground underline decoration-dotted";

export interface NavbarProps {
  readonly pathname: string;
  /** Whether the figures on this page are test money or real money. */
  readonly networkKind: "testnet" | "mainnet";
  readonly docsUrl: string;
}

export function Navbar({ pathname, networkKind, docsUrl }: NavbarProps) {
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
    <>
    <nav className="sticky top-0 z-40 w-full border-b border-gray-200 bg-white/95 backdrop-blur transition-colors duration-200 dark:border-gray-800 dark:bg-black/95">
      <ScrollProgress />
      {/*
        The desktop masthead folds at `lg`, not at `sm`. Seven links, a docs link,
        a network switch, the connection and a theme button do not fit beside the
        wordmark at 768px, and a row that runs past the viewport makes the whole
        page scroll sideways. Below `lg` everything folds into the sheet, which
        carries the switch too.

        At `lg` itself the links sit 12px apart and open out to 24px from `xl`.
        At 1024px wide the wider step would push the links over the wordmark;
        the tighter one leaves room for a connected address in the right-hand
        group too.
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

          <div className="hidden items-center justify-center gap-3 lg:flex xl:gap-6">
            {LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
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
            <NetworkSwitch networkKind={networkKind} className="hidden lg:inline-flex" />
            {/*
              After the network switch, not before it. The network is a property
              of every page; the wallet is needed by the four that sign.
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
    </nav>

      {/*
        The sheet is a sibling of the masthead, not a child. The masthead carries
        `backdrop-blur`, and a backdrop filter makes its element the containing
        block for every fixed descendant, so a sheet rendered inside it would be
        sized to the masthead rather than to the viewport.
      */}
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
                href={link.href}
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
            <NetworkSwitch networkKind={networkKind} />
            <ConnectWallet />
          </div>
        </div>
      ) : null}
    </>
  );
}
