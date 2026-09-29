"use client";

/**
 * Input.
 *
 * The `numeric` variant is for the amounts this Dashboard is mostly made of -
 * a price, a Bond deposit, an authorisation ceiling. It renders in the
 * mono face, right-aligned, and takes a `unit` suffix so a value is never a
 * bare number: the unit is real text on the page, and it is wired into the
 * field's description through `aria-describedby` so it is announced with the
 * field rather than sitting beside it as decoration (SC 1.3.1, SC 4.1.2).
 *
 * Any `aria-describedby` the call site passes is kept and the unit id is
 * appended, so an error message and a unit can both describe one field. That
 * matters on `/services/new`, where the error text has to name what is wrong
 * with the figure in the field it describes (SC 3.3.1, SC 3.3.3).
 *
 * The border is the stroke token, measured at 6.06:1 light and 5.69:1 dark
 * against the page surface, which is what SC 1.4.11 asks of a control boundary.
 * `aria-invalid` restates that boundary in the danger status token and is never
 * the only signal - the message named by `aria-describedby` carries the fault
 * in words.
 */

import * as React from "react";
import { type VariantProps, cva } from "class-variance-authority";

import { cn } from "./cn";
import { FOCUS_RING } from "./focus-ring";

const inputVariants = cva(
  cn(
    "flex w-full min-w-0 rounded-[2px] border border-border bg-background px-3 py-1",
    "text-foreground placeholder:text-muted-foreground",
    "transition-[border-color,color] duration-[var(--tab-motion-fast)]",
    "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "aria-invalid:border-status-danger",
    FOCUS_RING,
  ),
  {
    variants: {
      variant: {
        default: "h-9 text-base md:text-sm",
        mono: "h-9 font-mono text-base md:text-sm",
        numeric: "h-9 font-mono text-base tabular-nums md:text-sm",
        tall: "h-14 text-base",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type InputProps = React.ComponentProps<"input"> &
  VariantProps<typeof inputVariants> & {
    /** Asset symbol or other unit rendered inside the field and announced with it. */
    unit?: string;
  };

function Input({ className, variant, unit, ...props }: InputProps) {
  const generatedId = React.useId();

  if (unit === undefined) {
    return (
      <input data-slot="input" className={cn(inputVariants({ variant }), className)} {...props} />
    );
  }

  const unitId = `${props.id ?? generatedId}-unit`;
  const describedBy = [props["aria-describedby"], unitId].filter(Boolean).join(" ");

  return (
    <div data-slot="input-group" className="relative flex items-center">
      <input
        data-slot="input"
        className={cn(inputVariants({ variant }), "pr-16 text-right", className)}
        {...props}
        aria-describedby={describedBy}
      />
      <span
        id={unitId}
        data-slot="input-unit"
        className="pointer-events-none absolute right-3 font-mono text-sm text-muted-foreground"
      >
        {unit}
      </span>
    </div>
  );
}

export { Input, inputVariants };
