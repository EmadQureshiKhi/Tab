/**
 * Badge.
 *
 * A badge is a label, so it always carries text. The composites that build on it
 * — a clearing state, a curation tier — must keep colour as a redundant channel
 * beside that text and a glyph, never the signal itself (SC 1.4.1).
 *
 * Every fill pairs with the badge-ink token, which is the surface colour in both
 * modes, and the gate measures those pairs: accent 6.38:1 light and 10.13:1
 * dark, and each clearing fill between 5.93:1 and 11.09:1. The `outline` variant
 * puts the stroke token round a transparent fill at 6.06:1 light and 5.69:1 dark,
 * which is what SC 1.4.11 asks of a badge border.
 *
 * `tone` selects the fill from the clearing and tier tokens without the badge
 * knowing what a clearing or a tier is: the composite supplies meaning, this
 * supplies a measured colour.
 *
 * Requirements: 24.10
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
         * block of saturated colour beside every amount in a table of confirmed
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
        applied: "",
        confirmed: "",
        reversed: "",
        declined: "",
        superseded: "",
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
        tone: "applied",
        class: "border-clearing-applied/40 bg-transparent text-clearing-applied",
      },
      {
        variant: "solid",
        tone: "confirmed",
        class: "border-clearing-confirmed/40 bg-transparent text-clearing-confirmed",
      },
      {
        variant: "solid",
        tone: "reversed",
        class: "border-clearing-reversed/40 bg-transparent text-clearing-reversed",
      },
      {
        variant: "solid",
        tone: "declined",
        class: "border-clearing-declined/40 bg-transparent text-clearing-declined",
      },
      {
        variant: "solid",
        tone: "superseded",
        class: "border-clearing-superseded/40 bg-transparent text-clearing-superseded",
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
      {
        variant: "outline",
        tone: "applied",
        class: "border-clearing-applied text-clearing-applied",
      },
      {
        variant: "outline",
        tone: "confirmed",
        class: "border-clearing-confirmed text-clearing-confirmed",
      },
      {
        variant: "outline",
        tone: "reversed",
        class: "border-clearing-reversed text-clearing-reversed",
      },
      {
        variant: "outline",
        tone: "declined",
        class: "border-clearing-declined text-clearing-declined",
      },
      {
        variant: "outline",
        tone: "superseded",
        class: "border-clearing-superseded text-clearing-superseded",
      },
      { variant: "outline", tone: "curated", class: "border-tier-curated text-tier-curated" },
      {
        variant: "outline",
        tone: "permissionless",
        class: "border-tier-permissionless text-tier-permissionless",
      },

      { variant: "muted", tone: "accent", class: "text-accent" },
      { variant: "muted", tone: "neutral", class: "text-foreground" },
      { variant: "muted", tone: "applied", class: "text-clearing-applied" },
      { variant: "muted", tone: "confirmed", class: "text-clearing-confirmed" },
      { variant: "muted", tone: "reversed", class: "text-clearing-reversed" },
      { variant: "muted", tone: "declined", class: "text-clearing-declined" },
      { variant: "muted", tone: "superseded", class: "text-clearing-superseded" },
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
