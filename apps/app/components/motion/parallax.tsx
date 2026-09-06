"use client";

/**
 * Moves its contents slightly against the scroll.
 *
 * Depth, at the smallest dose that still reads as depth. The element travels a
 * few dozen pixels across the whole time it is on screen, which the eye reads as
 * the thing sitting behind the page rather than on it. Anything larger stops
 * being depth and starts being a moving object, and a moving object next to text
 * is a thing to look at rather than a thing to read past.
 *
 * The transform is a `MotionValue`, so it never causes a React render: Motion
 * writes it straight to the element on the browser's own frame. That matters
 * here because this is driven by scroll, which fires constantly.
 *
 * `useReducedMotion` decides the distance, never the markup. At zero the element
 * simply does not move, and the tree is the same one the server sent.
 *
 * Requirements: 24.9, 24.10
 */

import { type ReactNode, useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";

export function Parallax({
  children,
  className,
  /** Pixels travelled across the element's whole pass through the viewport. */
  distance = 40,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly distance?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const travel = reduced === true ? 0 : distance;
  const y = useTransform(scrollYProgress, [0, 1], [travel, -travel]);

  return (
    <div ref={ref} className={className}>
      <motion.div style={{ y }}>{children}</motion.div>
    </div>
  );
}
