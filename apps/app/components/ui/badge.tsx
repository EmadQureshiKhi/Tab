/**
 * Badge.
 *
 * A badge is a label, so it always carries text. The composites that build on it
 * - a tab state, a curation tier - must keep colour as a redundant channel
 * beside that text and a glyph, never the signal itself (SC 1.4.1).
 *
 * Every fill pairs with the badge-ink token, which is the surface colour in both
 * modes, and the gate measures those pairs: accent 6.38:1 light and 10.13:1
 * dark, and each status fill between 5.93:1 and 11.09:1. The `outline` variant
 * puts the stroke token round a transparent fill at 6.06:1 light and 5.69:1 dark,
 * which is what SC 1.4.11 asks of a badge border.
 *
 * `tone` selects the fill from the status and tier tokens without the badge
 * knowing what a status or a tier is: the composite supplies meaning, this
 * supplies a measured colour. The five status tones are named for what they
 * signal rather than for any one state of any one contract, so a new composite
 * can pick one without inheriting a meaning it did not ask for.
 */

import * as React from "react";
import { type VariantProps, cva } from "class-variance-authority";

import { cn } from "./cn";
import { FOCUS_RING } from "./focus-ring";
import { Slot } from "./slot";

const badgeVariants = cva(
  cn(
    "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden",
    "rounded-[2px] border px-2 py-0.5 font-mono text-xs font-medium whitespace-nowrap",
    "[&>svg]:pointer-events-none [&>svg]:size-3",
    FOCUS_RING,
  ),
  {
    variants: {
      variant: {
        /**
         * Unfilled: the page's own ground inside a boundary of the tone, with the
         * label and its glyph in the tone.
         *
         * This went from a flat fill, to a tint, to nothing. A flat fill put a
         * block of saturated colour beside every amount in a table of settled
         * rows and pulled the eye off the figures, which are what the page is for.
         * The tint was quieter but still drew a coloured rectangle per row. Letting
         * the page ground through leaves the three channels the badge actually
         * relies on - the word, the silhouette, and the colour of the label -
         * without adding a fourth that competes. The label-on-surface pair is the
         * one the muted variant has always used, so the contrast gate already
         * measures it.
         */
        solid: "",
        /** Transparent, bordered and labelled in the tone colour. */
        outline: "bg-transparent",
        /** Raised surface, bordered in the stroke token, labelled in the tone colour. */
        muted: "border-border bg-card",
      },
      tone: {
        accent: "",
        neutral: "",
        /** Still in flight: an Open Tab inside its Settlement Window. */
        pending: "",
        /** Done: a Settlement applied, a deposit taken. */
        settled: "",
        /** Needs attention: a delinquent tab, a refused transaction. */
        danger: "",
        /** Over and no longer material: a lapsed authorisation. */
        muted: "",
        /** Information without urgency: a change held in the timelock. */
        notice: "",
        curated: "",
        permissionless: "",
      },
    },
    compoundVariants: [
      {
        variant: "solid",
        tone: "accent",
        class: "border-accent/40 bg-transparent text-accent",
      },
      {
        variant: "solid",
        tone: "neutral",
        class: "border-border bg-muted/40 text-foreground",
      },
      {
        variant: "solid",
        tone: "pending",
        class: "border-status-pending/40 bg-transparent text-status-pending",
      },
      {
        variant: "solid",
        tone: "settled",
        class: "border-status-settled/40 bg-transparent text-status-settled",
      },
      {
        variant: "solid",
        tone: "danger",
        class: "border-status-danger/40 bg-transparent text-status-danger",
      },
      {
        variant: "solid",
        tone: "muted",
        class: "border-status-muted/40 bg-transparent text-status-muted",
      },
      {
        variant: "solid",
        tone: "notice",
        class: "border-status-notice/40 bg-transparent text-status-notice",
      },
      {
        variant: "solid",
        tone: "curated",
        class: "border-tier-curated/40 bg-transparent text-tier-curated",
      },
      {
        variant: "solid",
        tone: "permissionless",
        class: "border-tier-permissionless/40 bg-transparent text-tier-permissionless",
      },

      { variant: "outline", tone: "accent", class: "border-accent text-accent" },
      { variant: "outline", tone: "neutral", class: "border-border text-foreground" },
      { variant: "outline", tone: "pending", class: "border-status-pending text-status-pending" },
      { variant: "outline", tone: "settled", class: "border-status-settled text-status-settled" },
      { variant: "outline", tone: "danger", class: "border-status-danger text-status-danger" },
      { variant: "outline", tone: "muted", class: "border-status-muted text-status-muted" },
      { variant: "outline", tone: "notice", class: "border-status-notice text-status-notice" },
      { variant: "outline", tone: "curated", class: "border-tier-curated text-tier-curated" },
      {
        variant: "outline",
        tone: "permissionless",
        class: "border-tier-permissionless text-tier-permissionless",
      },

      { variant: "muted", tone: "accent", class: "text-accent" },
      { variant: "muted", tone: "neutral", class: "text-foreground" },
      { variant: "muted", tone: "pending", class: "text-status-pending" },
      { variant: "muted", tone: "settled", class: "text-status-settled" },
      { variant: "muted", tone: "danger", class: "text-status-danger" },
      { variant: "muted", tone: "muted", class: "text-status-muted" },
      { variant: "muted", tone: "notice", class: "text-status-notice" },
      { variant: "muted", tone: "curated", class: "text-tier-curated" },
      { variant: "muted", tone: "permissionless", class: "text-tier-permissionless" },
    ],
    defaultVariants: {
      variant: "solid",
      tone: "accent",
    },
  },
);

export type BadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    /** Render the child element instead of a `<span>`, keeping these props. */
    asChild?: boolean;
  };

function Badge({ className, variant, tone, asChild = false, children, ...props }: BadgeProps) {
  const classes = cn(badgeVariants({ variant, tone }), className);

  if (asChild) {
    return (
      <Slot data-slot="badge" className={classes} {...props}>
        {children}
      </Slot>
    );
  }

  return (
    <span data-slot="badge" className={classes} {...props}>
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
