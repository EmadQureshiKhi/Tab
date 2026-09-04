/**
 * Link.
 *
 * A link is underlined in every variant, so it is distinguishable from
 * surrounding text without relying on colour (SC 1.4.1). The accent-on-surface
 * pair the default variant uses is measured at 6.38:1 light and 10.75:1 dark.
 *
 * `external` is for the destinations that leave the Dashboard — the Creditcoin
 * explorer link every displayed transaction carries, for instance. It adds the
 * usual `rel` hardening, a decorative glyph, and an `sr-only` phrase, because a
 * new browsing context has to be announced rather than implied by an icon
 * (SC 3.2.5, SC 4.1.2).
 *
 * `asChild` hands these props to a routing link component when one is in play.
 *
 * Requirements: 24.2, 24.10
 */

import * as React from "react";
import { type VariantProps, cva } from "class-variance-authority";

import { cn } from "./cn";
import { FOCUS_RING } from "./focus-ring";
import { ExternalLinkIcon } from "./icons";
import { Slot } from "./slot";

const linkVariants = cva(
  cn(
    // `inline-flex` keeps the external-link glyph on the same line as the label and
    // stops it wrapping alone onto the next. What it also does is refuse to break
    // the label, and this product's labels include 66-character transaction hashes:
    // at 390px one of those ran the settlement page 198px past the viewport and
    // scrolled the whole document sideways. `min-w-0` with `break-all` lets the
    // hash wrap inside the link while the glyph still travels with it.
    "inline-flex min-w-0 items-center gap-1 rounded-[2px] break-all underline decoration-1 underline-offset-4",
    "transition-[color,text-decoration-thickness] duration-[var(--tab-motion-fast)]",
    "hover:decoration-2",
    FOCUS_RING,
  ),
  {
    variants: {
      variant: {
        /*
         * A link is the page's own text with an underline, and it goes teal only
         * under the pointer.
         *
         * It was teal at rest, and on a table of transaction hashes that made forty
         * bright strings the first thing the eye landed on, ahead of the amounts and
         * the states beside them. Colour at rest is a claim about importance, and a
         * hash is not the most important thing in its row. The underline is what
         * says it is a link, which is what an underline is for.
         */
        default:
          "text-foreground decoration-muted-foreground/50 hover:text-teal-700 hover:decoration-teal-600 dark:hover:text-teal-300 dark:hover:decoration-teal-400",
        subtle: "text-muted-foreground hover:text-foreground",
        plain: "text-foreground",
      },
      size: {
        default: "text-sm",
        xs: "text-xs",
        base: "text-base",
        inherit: "text-inherit",
      },
      mono: {
        true: "font-mono",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      mono: false,
    },
  },
);

export type LinkProps = React.ComponentProps<"a"> &
  VariantProps<typeof linkVariants> & {
    /** Render the child element instead of an `<a>`, keeping these props. */
    asChild?: boolean;
    /** Opens in a new browsing context, announced in text rather than by glyph. */
    external?: boolean;
    /** The phrase appended for an external destination. */
    externalLabel?: string;
  };

function Link({
  className,
  variant,
  size,
  mono,
  asChild = false,
  external = false,
  externalLabel = "opens in a new tab",
  children,
  ...props
}: LinkProps) {
  const classes = cn(linkVariants({ variant, size, mono }), className);

  if (asChild) {
    return (
      <Slot data-slot="link" className={classes} {...props}>
        {children}
      </Slot>
    );
  }

  const externalProps = external
    ? ({ target: "_blank", rel: "noreferrer noopener" } as const)
    : ({} as const);

  return (
    <a data-slot="link" className={classes} {...externalProps} {...props}>
      {children}
      {external ? (
        <>
          <ExternalLinkIcon className="size-3.5" />
          <span className="sr-only">{` (${externalLabel})`}</span>
        </>
      ) : null}
    </a>
  );
}

export { Link, linkVariants };
