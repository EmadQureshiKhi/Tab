"use client";

/**
 * The masthead, the page body and the footer, as one client boundary.
 *
 * The navbar needs the current path to mark the active link and the theme to draw
 * its toggle, both of which are client facts. Rather than make every page a
 * client component to reach them, the shell is the boundary and the pages stay on
 * the server, streaming into it as children.
 *
 * The chain comes from the query string, read here, and not from the layout. The
 * layout is a server component rendered once for every route, so a `chainKey` it
 * passed down was necessarily a constant: the toggle marked Sepolia whatever the
 * URL said, while the page beneath it correctly rendered Mainnet. The pages were
 * right and the control was lying, which reads as a toggle that does nothing and
 * springs back.
 */

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import { CHAIN_QUERY_PARAM, parseChainKeyParam } from "../../src/dashboard/chains";
import { Footer } from "../../components/shell/footer";
import { Navbar } from "../../components/shell/navbar";
import type { ChainKey } from "@tabai/shared";

export interface ChromeProps {
  readonly children: ReactNode;
  /** The chain to fall back to before the query string has been read. */
  readonly chainKey: ChainKey;
  readonly docsUrl: string;
  readonly explorerUrl: string;
}

/**
 * The chain the URL names, read after mount.
 *
 * Deliberately `window.location.search` and not `useSearchParams`. That hook
 * opts the subtree out of prerendering, so in a production build the server
 * emits the Suspense fallback while the client renders the content, and React
 * reports that swap as hydration error #418 on every load of the landing page.
 * It was clean in development, which is exactly how a fault like this reaches a
 * deployment.
 *
 * Reading the location in an effect has neither problem: the first client render
 * is the server's, and the chain arrives as an ordinary state change one frame
 * later. The cost is a frame in which a reader who deep-linked to Mainnet sees
 * Sepolia marked - a flicker on one control, rather than React tearing down the
 * document and rebuilding it.
 */
function useUrlChainKey(fallback: ChainKey): ChainKey {
  const pathname = usePathname();
  const [chainKey, setChainKey] = useState<ChainKey>(fallback);

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get(CHAIN_QUERY_PARAM);
    setChainKey(parseChainKeyParam(raw));
    // `pathname` is the dependency because a client-side navigation changes the
    // query without remounting this, and the toggle must follow it.
  }, [pathname, fallback]);

  return chainKey;
}

function Masthead({
  pathname,
  fallbackChainKey,
  docsUrl,
}: {
  readonly pathname: string;
  readonly fallbackChainKey: ChainKey;
  readonly docsUrl: string;
}) {
  const chainKey = useUrlChainKey(fallbackChainKey);
  return <Navbar pathname={pathname} chainKey={chainKey} docsUrl={docsUrl} />;
}

export function Chrome({ children, chainKey, docsUrl, explorerUrl }: ChromeProps) {
  const pathname = usePathname() ?? "/";
  return (
    <div className="flex min-h-screen flex-col">
      <Masthead pathname={pathname} fallbackChainKey={chainKey} docsUrl={docsUrl} />
      {/*
        One container for every route, at the reference's own width and padding
        steps. Holding it here rather than on each page is what stops eight routes
        from drifting to eight different measures, which is the single thing a
        reader notices when moving between them.
      */}
      {/*
        `overflow-x-clip`, and deliberately not `overflow-x-hidden`.

        Sections whose halves arrive from opposite edges start their entrance
        outside the page. At 390 that pushed a FAQ answer 19px past the viewport
        and let the whole document scroll sideways until the reveal finished.
        Clipping the axis makes that impossible for any entrance, present or
        future, rather than asking every one of them to be measured.

        `hidden` would clip the same and would also break the settlement
        walkthrough: `overflow-x: hidden` forces the other axis to `auto`, which
        makes this a scroll container and stops `position: sticky` working in
        anything inside it. `clip` clips without creating one, which is the whole
        reason it exists.
      */}
      <main id="main-content" className="flex-1 overflow-x-clip">
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
          {children}
        </div>
      </main>
      <Footer docsUrl={docsUrl} explorerUrl={explorerUrl} />
    </div>
  );
}
