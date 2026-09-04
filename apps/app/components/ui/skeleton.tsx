/**
 * Skeleton.
 *
 * A placeholder is decoration: it stands where content will be and says nothing
 * about it. So it is `aria-hidden` and it never carries text — the loading state
 * itself is announced by the region that owns it, with `aria-busy` while it
 * streams and `aria-live="polite"` where the arriving content should be read out
 * (SC 4.1.2):
 *
 *   <section aria-busy={pending}>
 *     {pending ? <Skeleton className="h-6 w-40" /> : <SettledVolume … />}
 *   </section>
 *
 * The pulse runs on the motion tokens, which collapse to an imperceptible
 * duration under `prefers-reduced-motion: reduce` through the theme (SC 2.3.3),
 * so a placeholder never animates against a stated preference.
 *
 * Requirements: 24.10
 */

import * as React from "react";

import { cn } from "./cn";

export type SkeletonProps = React.ComponentProps<"div">;

function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-[2px] bg-card",
        "border border-border/30",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
