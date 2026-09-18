"use client";

/**
 * A figure that counts up when it comes into view.
 *
 * **The number it lands on is the number it was given.** That sounds obvious and
 * it is the whole reason this component is written out rather than taken from a
 * kit: every amount in this product is an integer count of Asset base units, and
 * a ticker that interpolates through a float and formats the result would report
 * a settled amount that never existed. So the animation runs over a plain counter
 * and the final frame is the exact string passed in, never a rounded one.
 *
 * It also never animates a value the reader cannot check. The `title` carries the
 * full figure from the first frame, so a reader who lands mid-count still has the
 * real number available.
 */

import { useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "motion/react";

import { cn } from "../ui/cn";

export interface NumberTickerProps {
  /** The figure to land on. Rendered verbatim at the end of the run. */
  readonly value: string;
  /** Parsed target. Supplied when `value` carries separators or a symbol. */
  readonly target?: number;
  readonly className?: string;
  readonly durationMs?: number;
}

export function NumberTicker({ value, target, className, durationMs = 900 }: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
  const reduced = useReducedMotion() === true;
  const [display, setDisplay] = useState<string | null>(null);

  const destination = target ?? Number(value.replace(/[^0-9.-]/g, ""));
  const animatable = Number.isFinite(destination) && destination !== 0;

  useEffect(() => {
    if (!inView || reduced || !animatable) {
      setDisplay(null);
      return undefined;
    }

    const start = performance.now();
    let frame = 0;

    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      // Ease out, so the count decelerates into its final value rather than
      // stopping dead on a number the eye was still tracking.
      const eased = 1 - Math.pow(1 - progress, 3);
      if (progress >= 1) {
        // The last frame is the given string, not a formatted interpolation.
        setDisplay(null);
        return;
      }
      setDisplay(formatLike(value, destination * eased));
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [animatable, destination, durationMs, inView, reduced, value]);

  return (
    <span ref={ref} className={cn("tabular-nums", className)} title={value}>
      {display ?? value}
    </span>
  );
}

/**
 * Renders an intermediate count in the shape of the final string.
 *
 * The decimal places and any thousands separators come from the target, so the
 * figure does not change width or precision as it counts, which is what makes the
 * animation read as a number rising rather than as text being replaced.
 */
function formatLike(sample: string, current: number): string {
  const decimals = sample.includes(".") ? (sample.split(".")[1]?.replace(/\D+$/, "").length ?? 0) : 0;
  const grouped = sample.includes(",");
  const fixed = current.toFixed(decimals);
  if (!grouped) return fixed;
  const [whole, fraction] = fixed.split(".");
  const withSeparators = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? withSeparators : `${withSeparators}.${fraction}`;
}
