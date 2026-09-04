/**
 * The small glyph set the primitives need, drawn inline.
 *
 * Icons are authored here rather than pulled from an icon package, for the same
 * reason the primitives themselves live in the tree: the accessibility surface
 * has to be ours to fix. Every glyph is decorative and carries
 * `aria-hidden="true"`, so the accessible name always comes from adjacent text
 * — either visible text or an `sr-only` label supplied by the primitive.
 *
 * Each glyph paints in `currentColor`, so it inherits whichever text token its
 * container already resolved and can never introduce an unchecked colour.
 *
 * Requirements: 24.10
 */

import * as React from "react";

import { cn } from "./cn";

export type IconProps = Omit<React.ComponentProps<"svg">, "children">;

function Glyph({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4 shrink-0", className)}
      {...props}
    />
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Glyph data-slot="icon-chevron-down" {...props}>
      <path d="m6 9 6 6 6-6" />
    </Glyph>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Glyph data-slot="icon-chevron-right" {...props}>
      <path d="m9 6 6 6-6 6" />
    </Glyph>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Glyph data-slot="icon-check" {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Glyph>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Glyph data-slot="icon-close" {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Glyph>
  );
}

export function ExternalLinkIcon(props: IconProps) {
  return (
    <Glyph data-slot="icon-external-link" {...props}>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Glyph>
  );
}
