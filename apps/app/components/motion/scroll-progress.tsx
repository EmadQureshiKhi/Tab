"use client";

/**
 * How far down the page you are, as a line under the masthead.
 *
 * It is the same idea as the marker the documentation runs down its contents
 * list, brought to the product so the two feel like one thing. On a page of
 * settlements it also answers a real question: whether the table you are reading
 * is most of the page or the start of it.
 *
 * `scaleX` on a transform rather than a width, so it never triggers layout while
 * scrolling.
 *
 * The element is always rendered and the preference decides only whether it is
 * visible. Returning `null` under the preference instead is a hydration mismatch:
 * the server has no preference to read and renders the bar, a browser set to
 * reduce motion renders nothing, and React throws and re-renders the tree. The
 * same mistake, in a different component, is why the diagram carries the note it
 * does.
 */

import { useEffect, useState } from "react";
import { motion, useReducedMotion, useScroll, useSpring } from "motion/react";

export function ScrollProgress() {
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll();
  // Damped, so a flick of the wheel does not snap the line across the screen.
  const scaleX = useSpring(scrollYProgress, { stiffness: 180, damping: 30, restDelta: 0.001 });

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const visible = mounted && reduced === false;

  return (
    <motion.div
      aria-hidden="true"
      className="absolute inset-x-0 bottom-0 h-px origin-left bg-gradient-to-r from-teal-500 to-teal-300"
      style={{ scaleX, opacity: visible ? 1 : 0 }}
    />
  );
}
