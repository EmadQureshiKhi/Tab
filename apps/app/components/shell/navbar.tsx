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
 * ## The network badge
 *
 * Tab runs on one Monad network per deployment, so there is nothing to toggle
 * and the masthead states which network this is instead. The word `Testnet` or
 * `Mainnet` is in the text, not only in a colour, because a reader should never
 * have to know that a name means test money to read a balance correctly. It is
 * on every page for the same reason the connection is: a reader about to sign
 * needs to know which chain before they press, not after the dialog opens.
 */

import { useEffect, useState } from "react";
import { Menu, Moon, Sun, X } from "lucide-react";

import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import { useTheme } from "../providers/theme-context";
import { ScrollProgress } from "../motion/scroll-progress";
import { ConnectWallet } from "../wallet/connect-wallet";

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
  /** The chain's own name, such as `Monad Testnet`. From the network option. */
  readonly networkName: string;
  /** Whether the figures on this deployment are test money or real money. */
  readonly networkKind: "testnet" | "mainnet";
  readonly docsUrl: string;
}

/**
 * The network, stated in words.
 *
 * The badge draws the chain's name, and the kind is appended only where the name
 * does not already end in it, so `Monad Testnet` is never rendered as `Monad
 * Testnet testnet`. The accessible name always carries both, because the whole
 * point of the badge is that the kind is said rather than implied.
 */
export function NetworkBadge({
  networkName,
  networkKind,
  className,
}: {
  readonly networkName: string;
  readonly networkKind: "testnet" | "mainnet";
  readonly className?: string;
}) {
  const kind = networkKind === "testnet" ? "Testnet" : "Mainnet";
  const endsWithKind = networkName.toLowerCase().endsWith(kind.toLowerCase());
  return (
    <span
      // `role="img"` with the full sentence as its name, the same shape the tier
      // badge uses: one accessible name that says both the chain and the kind,
      // and no live region for a fact that never changes while the page is open.
      role="img"
      aria-label={`${networkName}, ${networkKind}`}
      title={`${networkName}, ${networkKind}`}
      className={cn(
        // The same tinted treatment the connection uses, so the two facts a signer
        // needs sit side by side in one voice.
        "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-xs tracking-wide uppercase",
        networkKind === "testnet"
          ? "border-amber-600/25 bg-amber-500/10 text-amber-600 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-400"
          : "border-teal-700/25 bg-teal-500/10 text-teal-700 dark:border-teal-400/20 dark:bg-teal-800/40 dark:text-teal-200",
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      <span>{networkName}</span>
      {endsWithKind ? null : (
        <span aria-hidden="true" className="opacity-70">
          {kind}
        </span>
      )}
    </span>
  );
}

export function Navbar({ pathname, networkName, networkKind, docsUrl }: NavbarProps) {
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
        a network badge, the connection and a theme button do not fit beside the
        wordmark at 768px, and a row that runs past the viewport makes the whole
        page scroll sideways. Below `lg` everything folds into the sheet, which
        carries the switch too.

        At `lg` itself the links sit 12px apart and open out to 24px from `xl`.
        The seventh link, Keys, measured the row at 1057px in a 1008px grid at
        1024px wide, and the links were drawn over the wordmark; the tighter
        step leaves room for a connected address in the right-hand group too.
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
            <NetworkBadge
              networkName={networkName}
              networkKind={networkKind}
              className="hidden lg:inline-flex"
            />
            {/*
              After the network badge, not before it. The network is a property
              of every page; the wallet is needed by two of them.
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
        block for every fixed descendant, so a sheet rendered inside it was sized
        to the masthead rather than to the viewport and the page showed through.
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
            <NetworkBadge networkName={networkName} networkKind={networkKind} />
            <ConnectWallet />
          </div>
        </div>
      ) : null}
    </>
  );
}
