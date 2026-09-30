"use client";

/**
 * The footer.
 *
 * A hairline rule, the mark and the year on the left, and links on the right, all
 * at the same small mono size as the masthead so the page is bracketed by the same
 * voice at both ends.
 *
 * There is no standing note under it. A sentence repeated on every page stops
 * being read after the first, and the claim it made, that nothing here holds a
 * key, is better made by the pages themselves never asking for one.
 *
 * The destinations that leave the site are the documentation, the Monad
 * explorer and Tab's account on X. The first two arrive as props from the
 * environment rather than being written here, so a deployment on another
 * network links to its own explorer; the X account is the same on every one.
 */

import { Moon, Sun } from "lucide-react";

import { Button } from "../ui/button";
import { useTheme } from "../providers/theme-context";

export interface FooterProps {
  readonly docsUrl: string;
  /** The Monad explorer for the configured chain. */
  readonly explorerUrl: string;
}

/** Tab's account on X. */
export const TAB_X_URL = "https://x.com/TryTabAI";

/** The X mark, drawn in the current text colour. */
function XMark() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const LINK_CLASSES =
  "inline-flex h-8 items-center px-2 font-mono text-[13px] tracking-wide text-muted-foreground no-underline hover:text-foreground hover:underline hover:decoration-dotted underline-offset-2";

export function Footer({ docsUrl, explorerUrl }: FooterProps) {
  const { isDark, mounted, toggleTheme } = useTheme();
  const brandColor = mounted ? (isDark ? "text-white" : "text-black") : "";
  const year = new Date().getUTCFullYear();

  return (
    <footer className="w-full border-t border-gray-200 bg-white/95 dark:border-gray-800 dark:bg-black/95">
      <div className="w-full px-2">
        <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:py-2">
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="" width={30} height={30} className="rounded-sm" />
            <p className="text-[13px] font-semibold text-muted-foreground">
              <span className="font-mono font-medium tracking-wide">
                {year}{" "}
                <span className={brandColor}>Tab</span>
                <span className="text-neutral-400">.</span>
                <span className="ml-2 font-normal text-muted-foreground">Built on Monad</span>
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1 sm:gap-2">
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
            <a href={docsUrl} target="_blank" rel="noreferrer" className={LINK_CLASSES}>
              DOCS
            </a>
            <a href="/explorer" className={LINK_CLASSES}>
              EXPLORER
            </a>
            <a href="/services" className={LINK_CLASSES}>
              SERVICES
            </a>
            <a href="/agents" className={LINK_CLASSES}>
              AGENTS
            </a>
            <a href="/analytics" className={LINK_CLASSES}>
              ANALYTICS
            </a>
            <a href={explorerUrl} target="_blank" rel="noreferrer" className={LINK_CLASSES}>
              MONAD
            </a>
            <a
              href={TAB_X_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Tab on X, @TryTabAI (opens in a new tab)"
              className={`${LINK_CLASSES} gap-1.5`}
            >
              <XMark />
              @TRYTABAI
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
