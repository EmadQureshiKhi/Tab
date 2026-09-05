"use client";

/**
 * `ClearingBadge` — the clearing state of one clearing, on any view that shows
 * it.
 *
 * ## Three redundant channels
 *
 * 1. **Text.** The state word is always rendered: `Provisional`, `Confirmed`,
 *    `Reversed`, `Declined`, or `Superseded`. It is never abbreviated and never
 *    replaced by a dot.
 * 2. **Icon.** Each state carries a distinct silhouette from `icons.tsx`. The
 *    set survives greyscale, because no member is a recolour of another.
 * 3. **Colour.** A design token fill, already checked by the CI contrast script
 *    against the badge ink at the 4.5:1 text threshold.
 *
 * Remove the colour and the badge still reads. Remove the icon and it still
 * reads. Colour is never the only signal, which is what WCAG 1.4.1 asks for.
 *
 * ## The countdown, and how it degrades
 *
 * A Provisional Clearing is revocable until the Verified Settlement exists, and
 * it is reversed if its confirmation deadline arrives first. So a provisional
 * badge carries the time remaining, and the accessible name spells out both the
 * state and that remaining time.
 *
 * The countdown degrades honestly in two directions:
 *
 * - **Before the clock is known.** A server render has no client clock, so the
 *   first frame shows the deadline as an absolute UTC instant rather than a
 *   countdown. This also keeps the server and client markup identical, so
 *   hydration is stable. The countdown appears once the component mounts.
 * - **After the deadline passes.** It does not clamp to `0s` and it does not
 *   keep counting down into negative time. It says the deadline has passed, how
 *   long ago, and that the clearing is now due to be reversed — which is the
 *   true state of affairs, since reversal is a permissionless crank that any
 *   caller may not yet have run.
 *
 * Requirements: 15.7, 24.10
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Badge } from "../ui/badge";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { cn } from "../ui/cn";
import { CheckIcon } from "../ui/icons";
import { clearingStateDescriptor, type ClearingState } from "./clearing-state";
import { describeDeadline, formatClockUtc } from "./format";
import {
  HourglassIcon,
  ReturnArrowIcon,
  SlashedCircleIcon,
  StackedPanelsIcon,
  type IconProps,
} from "./icons";

const ICONS: Readonly<Record<ClearingState, (props: IconProps) => ReactNode>> = {
  provisional: HourglassIcon,
  confirmed: CheckIcon,
  reversed: ReturnArrowIcon,
  declined: SlashedCircleIcon,
  superseded: StackedPanelsIcon,
};

/** How long the countdown waits between frames. */
const TICK_MS = 1000;

export interface ClearingBadgeProps {
  readonly state: ClearingState;
  /**
   * The confirmation deadline, in epoch milliseconds. Only a Provisional
   * Clearing has one; it is ignored in every other state.
   */
  readonly deadlineMs?: number | undefined;
  /**
   * A fixed clock, in epoch milliseconds. Supply it to render a deterministic
   * frame — in a test, or in a server render that already knows the instant it
   * is describing. Omit it and the badge reads the clock on mount and ticks once
   * a second.
   */
  readonly nowMs?: number | undefined;
  readonly className?: string | undefined;
}

/** What the countdown says, in both channels, or `null` when there is none. */
interface CountdownCopy {
  readonly visible: string;
  readonly spoken: string;
}

function countdownCopy(deadlineMs: number, clockMs: number | null): CountdownCopy {
  if (clockMs === null) {
    // No clock yet: state the deadline itself rather than invent a remaining time.
    const at = formatClockUtc(deadlineMs);
    return {
      visible: `deadline ${at}`,
      spoken: `Confirmation deadline at ${at}.`,
    };
  }

  const deadline = describeDeadline(deadlineMs, clockMs);
  if (deadline.passed) {
    return {
      visible: `deadline passed ${deadline.short} ago`,
      spoken: `Confirmation deadline passed ${deadline.spoken} ago, so this Provisional Clearing is due to be reversed.`,
    };
  }
  return {
    visible: `in ${deadline.short}`,
    spoken: `Confirmation deadline in ${deadline.spoken}.`,
  };
}

export function ClearingBadge({
  state,
  deadlineMs,
  nowMs,
  className,
}: ClearingBadgeProps) {
  const descriptor = clearingStateDescriptor(state);
  const Icon = ICONS[state];
  const showsCountdown = descriptor.carriesDeadline && deadlineMs !== undefined;

  // `null` means "the clock is not known here yet", which is exactly the state a
  // server render is in. It is never a stand-in for zero.
  const [clockMs, setClockMs] = useState<number | null>(nowMs ?? null);

  useEffect(() => {
    if (nowMs !== undefined) {
      setClockMs(nowMs);
      return;
    }
    if (!showsCountdown) return;

    setClockMs(Date.now());
    const timer = setInterval(() => setClockMs(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [nowMs, showsCountdown]);

  const reduced = useReducedMotion() === true;

  const countdown =
    showsCountdown && deadlineMs !== undefined ? countdownCopy(deadlineMs, clockMs) : null;

  const accessibleName = [
    `Clearing state: ${descriptor.label}.`,
    countdown?.spoken,
    descriptor.meaning,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");

  // The state machine is the mechanism this product is built on, so a badge that
  // changes state is the one animation on the site that carries meaning rather
  // than polish: `Provisional` becoming `Confirmed` under a reader's eye is the
  // proof landing. The key is the state, so React swaps the element and Motion
  // crossfades it; a badge whose text changed in place would look like a typo.
  //
  // The three redundant channels above are untouched. The animation moves the
  // whole badge and changes none of them, so a reader who sees no motion at all
  // still gets the word, the silhouette and the fill.
  const badge = (
    <Badge
      variant="solid"
      tone={descriptor.tone}
      // `role="img"` with an explicit name is what keeps the second-by-second
      // countdown from being announced repeatedly: the element carries one
      // accessible name and is not a live region, so the name updates silently
      // and a reader hears it when they reach the badge.
      role="img"
      aria-label={accessibleName}
      title={accessibleName}
      className={cn("gap-1.5 tracking-wide uppercase", className)}
    >
      <Icon />
      <span>{descriptor.label}</span>
      {countdown === null ? null : (
        <>
          <span aria-hidden="true">·</span>
          <span className="normal-case tracking-normal tabular-nums">{countdown.visible}</span>
        </>
      )}
    </Badge>
  );

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={state}
        className="inline-flex"
        initial={{ opacity: 0, y: -4, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 4, scale: 0.96 }}
        transition={{ duration: reduced ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
      >
        {badge}
      </motion.span>
    </AnimatePresence>
  );
}

export default ClearingBadge;
