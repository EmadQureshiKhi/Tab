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
      { text: "Demo video", url: "https://youtu.be/k8_eo5tZoFI", external: true },
      {
        type: "icon",
        text: "X",
        label: "Tab on X, @TryTabAI",
        url: "https://x.com/TryTabAI",
        external: true,
        icon: (
          <svg aria-hidden="true" viewBox="0 0 24 24" width={16} height={16} fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        ),
      },
    ],
  };
}
