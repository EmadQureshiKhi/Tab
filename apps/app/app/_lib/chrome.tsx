"use client";

/**
 * The masthead, the page body and the footer, as one client island.
 *
 * The navbar needs the current path to mark the active link and the theme to draw
 * its toggle, both of which are client facts. Rather than make every page a
 * client component to reach them, the shell is the island and the pages stay on
 * the server, streaming into it as children.
 *
 * The network is the visitor's choice, held in a cookie rather than in the URL.
 * The layout resolves it once per render on the server and passes it down, so
 * the switch on the masthead states what every page beneath it is showing and
 * cannot disagree with them.
 */

import { Fragment, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { Footer } from "../../components/shell/footer";
import { Navbar } from "../../components/shell/navbar";
import type { ChainNetwork } from "../../src/dashboard/network";

export interface ChromeProps {
  readonly children: ReactNode;
  readonly docsUrl: string;
  /** The block explorer for the selected chain, for the footer. */
  readonly explorerUrl: string;
  /** The selected chain, which keys the page body. */
  readonly chainId: number;
  /** Whether the figures on every page are test money or real money. */
  readonly networkKind: ChainNetwork;
}

export function Chrome({ children, docsUrl, explorerUrl, chainId, networkKind }: ChromeProps) {
  const pathname = usePathname() ?? "/";
  return (
    <div className="flex min-h-screen flex-col">
      <Navbar pathname={pathname} docsUrl={docsUrl} networkKind={networkKind} />
      {/*
        One container for every route, at one width and one set of padding
        steps. Holding it here rather than on each page is what stops twelve
        routes from drifting to twelve different measures, which is the single
        thing a reader notices when moving between them.
      */}
      {/*
        `overflow-x-clip`, and deliberately not `overflow-x-hidden`.

        Sections whose halves arrive from opposite edges start their entrance
        outside the page. Unclipped, a phone-width page would scroll sideways
        until the reveal finished. Clipping the axis makes that impossible for
        any entrance, present or future, rather than asking every one of them to
        be measured.

        `hidden` would clip the same and would also break the settlement
        walkthrough: `overflow-x: hidden` forces the other axis to `auto`, which
        makes this a scroll container and stops `position: sticky` working in
        anything inside it. `clip` clips without creating one, which is the whole
        reason it exists.
      */}
      <main id="main-content" className="flex-1 overflow-x-clip">
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
          {/*
            Keyed by the chain. Switching network renders the route again on the
            server, but a client island keeps its state across a refresh: a live
            feed would stay subscribed to the old network's stream and a form
            would keep the old network's choices. Changing the key mounts every
            island afresh, so nothing on the page outlives the network it was
            drawn for.
          */}
          <Fragment key={chainId}>{children}</Fragment>
        </div>
      </main>
      <Footer docsUrl={docsUrl} explorerUrl={explorerUrl} />
    </div>
  );
}
