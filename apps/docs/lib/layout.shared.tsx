import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

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
    /* The product first: a reader following the docs link out of the product should be able to go back. */
    links: [
      { text: "Dashboard", url: appUrl, external: true },
      { text: "Explorer", url: `${appUrl}/explorer`, external: true },
    ],
  };
}
