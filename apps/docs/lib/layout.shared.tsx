import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

/** The two documents that live in the repository rather than in these pages. */
const REPOSITORY_URL = "https://github.com/EmadQureshiKhi/Tab";
const WHITEPAPER_URL = "https://github.com/EmadQureshiKhi/Tab/blob/main/WHITEPAPER.md";

/**
 * What the masthead carries on every page.
 *
 * The mark and the wordmark are the same ones the Dashboard uses, because a
 * reader following the DOCS link out of the product should land somewhere that is
 * visibly the same product. The link back is the first item for the same reason.
 */
export function baseOptions(appUrl: string): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2">
          <img src="/logo.png" alt="" width={24} height={24} style={{ borderRadius: 4 }} />
          <span className="font-semibold">Tab Docs</span>
        </span>
      ),
      url: "/",
    },
    /*
     * The product first, then the two documents that sit outside these pages.
     * The whitepaper is the long argument and the repository is the evidence, and
     * neither belongs in the page tree: a reader who wants either wants to leave.
     */
    links: [
      { text: "Dashboard", url: appUrl, external: true },
      { text: "Explorer", url: `${appUrl}/explorer`, external: true },
      { text: "Whitepaper", url: WHITEPAPER_URL, external: true },
      { text: "GitHub", url: REPOSITORY_URL, external: true },
    ],
  };
}
