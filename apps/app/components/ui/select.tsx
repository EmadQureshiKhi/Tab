/**
 * Select.
 *
 * This is a styled native `<select>`, and that is a deliberate accessibility
 * decision rather than a shortcut. The explorer and analytics filters are
 * exactly the case the design settles as native form controls: a native select
 * carries its own role, its own keyboard model including type-ahead, its own
 * mobile picker, and its own focus behaviour, none of which a custom listbox
 * reproduces faithfully across assistive technology (SC 2.1.1, SC 4.1.2).
 *
 * Only the presentation is ours. `appearance-none` removes the platform arrow so
 * the control matches the rest of the surface, and the replacement glyph is
 * decorative and `aria-hidden`, so removing the native arrow removes no
 * information.
 *
 * The control has no accessible name of its own: pair it with a `<label>` whose
 * `htmlFor` names the select's `id`, or pass `aria-label` when no visible label
 * exists.
 *
 * Requirements: 24.10
 */

import * as React from "react";
import { type VariantProps, cva } from "class-variance-authority";

import { cn } from "./cn";
import { FOCUS_RING } from "./focus-ring";
import { ChevronDownIcon } from "./icons";

const selectVariants = cva(
  cn(
    "w-full appearance-none rounded-[2px] border border-border bg-background",
    "pr-9 pl-3 font-mono text-foreground",
    "transition-[border-color,color] duration-[var(--tab-motion-fast)]",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "aria-invalid:border-clearing-reversed",
    FOCUS_RING,
  ),
  {
    variants: {
      size: {
        default: "h-9 text-sm",
        sm: "h-8 text-xs",
        tall: "h-14 text-base",
      },
      width: {
        full: "w-full",
        fit: "w-fit",
      },
    },
    defaultVariants: {
      size: "default",
      width: "full",
    },
  },
);

export type SelectProps = Omit<React.ComponentProps<"select">, "size"> &
  VariantProps<typeof selectVariants>;

function Select({ className, size, width, children, ...props }: SelectProps) {
  return (
    <div data-slot="select" className={cn("relative", width === "fit" ? "w-fit" : "w-full")}>
      <select
        data-slot="select-control"
        className={cn(selectVariants({ size, width }), className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

function SelectOption({ className, ...props }: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="select-option"
      className={cn("bg-background font-mono text-foreground", className)}
      {...props}
    />
  );
}

function SelectGroup({ className, ...props }: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="select-group"
      className={cn("bg-background font-mono text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Select, SelectGroup, SelectOption, selectVariants };
