"use client";

/**
 * The footer, in the reference's shape.
 *
 * A hairline rule, the mark and the year on the left, and links on the right, all
 * at the same small mono size as the masthead so the page is bracketed by the same
 * voice at both ends.
 *
 * There is no standing note under it. A sentence repeated on every page stops
 * being read after the first, and the claim it made, that nothing here holds a
 * key, is better made by the pages themselves never asking for one.
 */

import { Moon, Sun } from "lucide-react";

import { Button } from "../ui/button";
import { useTheme } from "../providers/theme-context";

export interface FooterProps {
  readonly docsUrl: string;
  readonly explorerUrl: string;
}

/*
 * Constants rather than inline strings, so replacing one is a single edit in a
 * single file and a reader can see every outbound destination at a glance.
 */
const REPOSITORY_URL = "https://github.com/EmadQureshiKhi/Tab";
const WHITEPAPER_URL = "https://github.com/EmadQureshiKhi/Tab/blob/main/WHITEPAPER.md";
const SOCIAL_URL = "https://x.com/TryTabAI";

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
            <a href={WHITEPAPER_URL} target="_blank" rel="noreferrer" className={LINK_CLASSES}>
              WHITEPAPER
            </a>
            <a href={REPOSITORY_URL} target="_blank" rel="noreferrer" className={LINK_CLASSES}>
              GITHUB
            </a>
            <a href={SOCIAL_URL} target="_blank" rel="noreferrer" className={LINK_CLASSES}>
              X
            </a>
            <a href={explorerUrl} target="_blank" rel="noreferrer" className={LINK_CLASSES}>
              CREDITCOIN
            </a>
            <a href="/explorer" className={LINK_CLASSES}>
              EXPLORER
            </a>
          </div>
        </div>

      </div>
    </footer>
  );
}
