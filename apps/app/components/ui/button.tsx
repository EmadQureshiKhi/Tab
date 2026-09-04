/**
 * Button, in the reference's variants.
 *
 * The set below is the reference's own, name for name, so a component written
 * against that design drops in unchanged: two filled variants that carry the
 * page's own foreground and card, an accent pair in teal, and the `tall` size the
 * reference uses for its primary calls to action.
 *
 * Every variant reads its colour from a theme variable rather than a literal, so
 * light and dark are one definition and a reader who switches gets the right
 * contrast on both without a second set of classes.
 *
 * `animated` slides the label left and brings a chevron in from behind it on
 * hover. It is the reference's own affordance and it costs nothing when a reader
 * has asked for reduced motion, because the transition duration collapses under
 * the global preference rule in the theme.
 */

import * as React from "react";
import { type VariantProps, cva } from "class-variance-authority";

import { cn } from "./cn";
import { FOCUS_RING } from "./focus-ring";
import { ChevronRightIcon } from "./icons";
import { Slot } from "./slot";

const buttonVariants = cva(
  cn(
    "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-[2px]",
    "font-mono text-sm font-medium whitespace-nowrap transition-all",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    FOCUS_RING,
  ),
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        outline:
          "border border-border bg-background hover:bg-muted-2 dark:hover:bg-muted/50",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-muted-2 dark:hover:bg-muted/50",
        link: "text-foreground underline-offset-4 hover:underline",
        ghostCustom:
          "rounded-[2px] bg-teal-500/10 font-mono text-[13px] tracking-wider text-teal-700 uppercase transition-all duration-300 hover:bg-teal-500/20 dark:bg-teal-800/50 dark:text-teal-200 dark:hover:bg-teal-800/70",
        ghostCustomSecondary:
          "rounded-[2px] bg-muted-foreground/10 font-mono text-[13px] tracking-wider text-foreground uppercase transition-all duration-300 hover:bg-muted-foreground/20 dark:bg-muted-foreground/20 dark:hover:bg-muted-foreground/30",
        customTallPrimary:
          "rounded-[2px] bg-foreground font-mono text-sm tracking-wider text-background uppercase hover:bg-foreground/90",
        customTallSecondary:
          "rounded-[2px] bg-muted font-mono text-sm tracking-wider text-foreground uppercase hover:bg-muted/80",
        customTallAccent:
          "rounded-[2px] bg-teal-500/10 font-mono text-sm tracking-wider text-teal-700 uppercase transition-all duration-300 hover:bg-teal-500/20 dark:bg-teal-800/50 dark:text-teal-200 dark:hover:bg-teal-800/70",
        danger:
          "rounded-[2px] bg-destructive font-mono text-sm tracking-wider text-white uppercase hover:bg-destructive/90",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-7 gap-1 rounded-sm px-2 text-xs has-[>svg]:px-1.5",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        tall: "h-14 px-6 py-4 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    readonly asChild?: boolean;
    readonly animated?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  animated = false,
  children,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";
  const classes = cn(
    buttonVariants({ variant, size }),
    animated && "group relative overflow-hidden",
    className,
  );

  // `asChild` hands rendering to the child, which may be an anchor, so the
  // chevron cannot be injected without changing that child's shape. The group
  // class still goes on, so a caller that wants the affordance can draw it.
  if (animated && !asChild) {
    return (
      <Component data-slot="button" className={classes} {...props}>
        <span className="relative inline-flex items-center transition-transform duration-300 ease-out group-hover:-translate-x-1">
          {children}
          <ChevronRightIcon
            aria-hidden="true"
            className="absolute left-full ml-2 h-4 w-4 shrink-0 -translate-x-2 opacity-0 transition-all duration-300 ease-out group-hover:translate-x-0 group-hover:opacity-100"
          />
        </span>
      </Component>
    );
  }

  return (
    <Component data-slot="button" className={classes} {...props}>
      {children}
    </Component>
  );
}

export { buttonVariants };
