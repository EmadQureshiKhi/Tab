"use client";

/**
 * Momentum scrolling, wired once.
 *
 * Lenis takes over the wheel and drives scroll on a spring instead of in
 * hardware steps. It is three kilobytes and it changes how the whole product
 * feels, which is why it sits in the layout rather than on a page.
 *
 * Two things it must not break, and does not. `position: sticky` still works,
 * because Lenis moves the document rather than a transformed wrapper. And an
 * `IntersectionObserver` still fires, for the same reason, which matters because
 * every reveal on the site is driven by one.
 *
 * It is skipped entirely under a reduced-motion preference. Smoothing is inertia
 * a reader did not ask for, and the browser's own scrolling is the correct
 * behaviour there rather than a degraded one.
 */

import { useEffect } from "react";
import { useReducedMotion } from "motion/react";

export function SmoothScroll() {
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced !== false) return undefined;

    let frame = 0;
    let cancelled = false;
    let destroy: (() => void) | undefined;

    // Imported lazily so a reader who prefers reduced motion never downloads it.
    void import("lenis").then(({ default: Lenis }) => {
      if (cancelled) return;
      const lenis = new Lenis({ duration: 1.05, smoothWheel: true, touchMultiplier: 1.6 });
      const raf = (time: number) => {
        lenis.raf(time);
        frame = requestAnimationFrame(raf);
      };
      frame = requestAnimationFrame(raf);
      destroy = () => {
        cancelAnimationFrame(frame);
        lenis.destroy();
      };
    });

    return () => {
      cancelled = true;
      if (destroy !== undefined) destroy();
    };
  }, [reduced]);

  return null;
}
