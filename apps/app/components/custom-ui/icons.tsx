/**
 * The glyphs the composites need and the primitives do not have.
 *
 * The primitive set already carries a check, a close, two chevrons, and an
 * external-link mark, and those are imported from there rather than redrawn. What
 * is here is the domain set: the two curation tiers, the marks a credit view
 * needs, and the seal on a Settlement.
 *
 * These are authored inline for one accessibility reason. The icon is a
 * *load-bearing* channel: a curation tier is carried by three redundant signals
 * - text, icon, and colour - so the icon has to be guaranteed present and
 * visibly distinct at badge size from every other icon in its set. Owning the
 * paths is what makes that checkable.
 *
 * Every silhouette differs in outline, not merely in detail: a shield, a globe,
 * a triangle, a seal, an hourglass. None is a recolour of another, so the set
 * survives greyscale.
 *
 * Each glyph is `aria-hidden` and not focusable, and paints in `currentColor` so
 * it can never introduce an unchecked colour. The words beside it carry the
 * meaning, and the composite's own accessible name states it again in full, so
 * nothing depends on an icon being recognised.
 */

import * as React from "react";

import { cn } from "../ui/cn";
import type { IconProps } from "../ui/icons";

export type { IconProps };

/**
 * The shared frame. A 16-unit viewBox and a 1.6 stroke, which is a slightly
 * finer line than the primitive set's 24-unit frame carries, because these
 * glyphs sit inside a badge at 12 px rather than beside body text.
 */
function Glyph({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4 shrink-0", className)}
      {...props}
    />
  );
}

/** A window still running: time is counting against this tab. */
export function HourglassIcon(props: IconProps) {
  return (
    <Glyph data-slot="icon-hourglass" {...props}>
      <path d="M4 2h8M4 14h8" />
      <path d="M5 2c0 3 3 4 3 4s3-1 3-4" />
      <path d="M5 14c0-3 3-4 3-4s3 1 3 4" />
    </Glyph>
  );
}

/** Curated Tier: a shield carrying a check. */
export function ShieldCheckIcon(props: IconProps) {
  return (
    <Glyph data-slot="icon-shield-check" {...props}>
      <path d="M8 1.75l5 1.9v3.9c0 3.2-2.1 5.2-5 6.7-2.9-1.5-5-3.5-5-6.7V3.65l5-1.9z" />
      <path d="M5.75 7.9 7.5 9.6l3-3.4" />
    </Glyph>
  );
}

/** Permissionless Tier: a globe. Open to any address, on the same terms. */
export function GlobeIcon(props: IconProps) {
  return (
    <Glyph data-slot="icon-globe" {...props}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M2.5 6.25h11M2.5 9.75h11" />
      <path d="M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75C6.4 12.15 5.6 10.25 5.6 8S6.4 3.85 8 2.25z" />
    </Glyph>
  );
}

/** Delinquency, and anything else a reader has to notice in words. */
export function WarningIcon(props: IconProps) {
  return (
    <Glyph data-slot="icon-warning" {...props}>
      <path d="M8 2.25l5.75 11H2.25z" />
      <path d="M8 6.25v3.5" />
      <path d="M8 11.5h.01" />
    </Glyph>
  );
}

/** The mark on a Settlement card: a seal, for a payment the chain itself recorded. */
export function SettledSealIcon(props: IconProps) {
  return (
    <Glyph data-slot="icon-settled-seal" {...props}>
      <circle cx="8" cy="6.25" r="4" />
      <path d="M5.75 9.5 5 14l3-1.5L11 14l-.75-4.5" />
    </Glyph>
  );
}
