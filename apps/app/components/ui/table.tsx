/**
 * Table.
 *
 * SC 1.3.1 is not optional here, so the API makes it unavoidable rather than
 * merely encouraged:
 *
 *   - `caption` is a required prop. Every table on this Dashboard states what it
 *     is a table of, and the type checker refuses a table that does not. Pass
 *     `captionVisible={false}` where the surrounding heading already says it —
 *     the caption stays in the accessibility tree, it just stops being drawn.
 *   - `TableHead` sets `scope="col"` by default, so a header cell is always
 *     associated with its column. Pass `scope="row"` on a leading header cell in
 *     a body row for a row header.
 *
 * The scroll container is focusable and labelled, because a region that scrolls
 * has to be reachable by keyboard to be scrollable by keyboard (SC 2.1.1). It
 * takes the focus indicator for the same reason.
 *
 * Below the `sm` breakpoint a wide table should be rendered as stacked cards by
 * the view that owns it (SC 1.4.10); this primitive keeps horizontal scrolling
 * as the fallback rather than clipping.
 *
 * Requirements: 24.4, 24.10
 */

import * as React from "react";

import { cn } from "./cn";
import { FOCUS_RING } from "./focus-ring";

export type TableProps = React.ComponentProps<"table"> & {
  /** What this is a table of. Rendered as `<caption>`. Required. */
  caption: React.ReactNode;
  /** Draws the caption. When false it stays in the accessibility tree only. */
  captionVisible?: boolean;
  className?: string;
  captionClassName?: string;
  containerClassName?: string;
};

function Table({
  className,
  caption,
  captionVisible = true,
  captionClassName,
  containerClassName,
  children,
  ...props
}: TableProps) {
  // A scrollable region needs a name to be worth announcing, and it needs to be
  // focusable to be scrollable from the keyboard. Both hold when the caption is
  // text; when it is markup there is no string to name the region with, so the
  // container stays a plain element rather than an unnamed region.
  const regionProps: React.ComponentProps<"div"> =
    typeof caption === "string"
      ? { role: "region", "aria-label": caption, tabIndex: 0 }
      : {};

  return (
    <div
      data-slot="table-container"
      className={cn(
        "relative w-full overflow-x-auto rounded-[2px]",
        FOCUS_RING,
        containerClassName,
      )}
      {...regionProps}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm text-foreground", className)}
        {...props}
      >
        <TableCaption className={cn(captionVisible ? undefined : "sr-only", captionClassName)}>
          {caption}
        </TableCaption>
        {children}
      </table>
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("bg-card [&_tr]:border-b [&_tr]:border-border", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t border-border bg-card font-medium [&>tr]:last:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-border/40 transition-colors duration-[var(--tab-motion-fast)]",
        // A hovered row lifts by a tint and gains a teal edge on its leading side,
        // so the row under the pointer is unmistakable in a table of near-identical
        // hashes. `box-shadow` rather than a border, because a border would move
        // every cell by a pixel as the pointer crosses the table.
        "hover:bg-muted/40 hover:shadow-[inset_2px_0_0_0_var(--color-teal-500)]",
        "data-[state=selected]:bg-muted/40",
        className,
      )}
      {...props}
    />
  );
}

export type TableHeadProps = React.ComponentProps<"th"> & {
  scope?: "col" | "row" | "colgroup" | "rowgroup";
};

function TableHead({ className, scope = "col", ...props }: TableHeadProps) {
  return (
    <th
      data-slot="table-head"
      scope={scope}
      className={cn(
        "h-10 px-2 text-left align-middle font-mono text-xs font-medium tracking-wide",
        "whitespace-nowrap text-muted-foreground uppercase",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("px-2 py-2 align-middle text-foreground", className)}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-left text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
