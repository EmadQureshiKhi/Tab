/**
 * Skip-to-content link.
 *
 * SC 2.4.1 asks for a way past the repeated header and navigation, and the
 * mechanism only works if it is the very first focusable element in the DOM. So
 * this belongs at the top of the layout body on every route, ahead of the
 * header, with `contentId` naming the landmark that follows.
 *
 * It is hidden until it takes focus rather than hidden from assistive
 * technology: `sr-only` keeps it in the accessibility tree and in the tab order,
 * and focus reveals it as a real control on the page surface, outlined in the
 * stroke token at 6.06:1 light and 5.69:1 dark.
 *
 * The target needs to be focusable for the jump to move the caret as well as the
 * viewport, so give it `tabIndex={-1}`:
 *
 *   <SkipLink />
 *   <header>…</header>
 *   <main id="main-content" tabIndex={-1}>…</main>
 *
 * Requirements: 24.10
 */

import * as React from "react";

import { cn } from "./cn";
import { FOCUS_RING } from "./focus-ring";

export type SkipLinkProps = Omit<React.ComponentProps<"a">, "href"> & {
  /** The id of the landmark this link jumps to. */
  contentId?: string;
};

function SkipLink({
  className,
  contentId = "main-content",
  children = "Skip to content",
  ...props
}: SkipLinkProps) {
  return (
    <a
      data-slot="skip-link"
      href={`#${contentId}`}
      className={cn(
        "sr-only",
        "focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50",
        "focus-visible:inline-flex focus-visible:items-center focus-visible:rounded-[2px]",
        "focus-visible:border focus-visible:border-border focus-visible:bg-background",
        "focus-visible:px-3 focus-visible:py-2 focus-visible:font-mono focus-visible:text-sm focus-visible:text-foreground",
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      {children}
    </a>
  );
}

export { SkipLink };
