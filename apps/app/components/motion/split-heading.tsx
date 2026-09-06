"use client";

/**
 * A heading that arrives a line at a time.
 *
 * GSAP's SplitText is the one piece of this site that GSAP does better than
 * Motion: it measures the rendered text, wraps each line in its own element, and
 * puts it back exactly as it was afterwards. Reimplementing that means guessing
 * where the browser broke the line, which changes with the font, the width and the
 * reader's own text size.
 *
 * The rules it follows are the ones that make text animation safe rather than
 * clever. The text is in the DOM as text before anything runs, so a reader with no
 * JavaScript and a search engine both see a heading rather than an empty element.
 * The split is reverted on unmount and re-run on resize, because a line count that
 * was right at one width is wrong at another. And under a reduced-motion
 * preference nothing is split at all: the heading simply is.
 */

import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";

import { cn } from "../ui/cn";

export interface SplitHeadingProps {
  readonly children: string;
  readonly className?: string;
  readonly as?: "h1" | "h2";
  readonly delay?: number;
}

export function SplitHeading({
  children,
  className,
  as: Tag = "h1",
  delay = 0,
}: SplitHeadingProps) {
  const ref = useRef<HTMLHeadingElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced !== false) return undefined;
    const element = ref.current;
    if (element === null) return undefined;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      const [{ default: gsap }, { SplitText }] = await Promise.all([
        import("gsap"),
        import("gsap/SplitText"),
      ]);
      if (cancelled) return;
      gsap.registerPlugin(SplitText);

      let split: InstanceType<typeof SplitText> | undefined;
      let tween: gsap.core.Tween | undefined;

      const run = () => {
        split?.revert();
        tween?.kill();
        split = new SplitText(element, { type: "lines", linesClass: "overflow-hidden" });
        tween = gsap.from(split.lines, {
          yPercent: 110,
          opacity: 0,
          duration: 0.9,
          ease: "power3.out",
          stagger: 0.08,
          delay,
        });
      };

      run();

      // A line count measured at one width is wrong at another, so the split is
      // rebuilt on resize rather than left describing a layout that has gone.
      const observer =
        typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => run());
      observer?.observe(element);

      cleanup = () => {
        observer?.disconnect();
        tween?.kill();
        split?.revert();
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [children, delay, reduced]);

  return (
    <Tag ref={ref} className={cn(className)}>
      {children}
    </Tag>
  );
}
