"use client";

/**
 * A beam between two elements, with a pulse that travels along it.
 *
 * The path is measured from the real DOM rather than authored as coordinates,
 * which is what makes a diagram survive a reflow: the marks are laid out by the
 * grid that owns them, at whatever size the breakpoint gives, and the beam is
 * drawn between wherever they actually landed. A `ResizeObserver` on the
 * container recomputes it, so the picture is correct at 390px and at 1920px
 * without either one being a special case.
 *
 * ## Motion decides how, never whether
 *
 * The path, the resting stroke and the gradient are all rendered in every case.
 * When motion is reduced the gradient simply does not travel. Reading the
 * preference to decide markup is what produced three separate hydration
 * mismatches on this site, and `test/motion.test.mjs` now refuses it.
 *
 * Requirements: 24.9, 24.10
 */

import { type RefObject, useCallback, useEffect, useId, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

export interface AnimatedBeamProps {
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly fromRef: RefObject<HTMLElement | null>;
  readonly toRef: RefObject<HTMLElement | null>;
  /** Height of the arc, in pixels. Positive bows the path upward. */
  readonly curvature?: number;
  /** Travel from `to` towards `from` instead. */
  readonly reverse?: boolean;
  readonly duration?: number;
  readonly delay?: number;
  /** Pause between passes. Set it to sequence several beams into one round. */
  readonly repeatDelay?: number;
  readonly pathWidth?: number;
  /** The pulse's colour. One colour, faded at both ends, rather than a two-hue ramp. */
  readonly color?: string;
  /**
   * Draw an arrowhead where the beam lands.
   *
   * Worth it on a diagram whose wires run in both directions and are read as a
   * still picture most of the time. Not worth it where several beams converge on
   * one mark, since the heads then stack into a smudge and the travelling light
   * already says which way the thing is going.
   */
  readonly head?: boolean;
  readonly startYOffset?: number;
  readonly endYOffset?: number;
}

/** Where a beam ends: the centre of a mark, nudged by an offset. */
interface Point {
  readonly x: number;
  readonly y: number;
}

function centreOf(box: DOMRect, container: DOMRect, yOffset: number): Point {
  return {
    x: box.left - container.left + box.width / 2,
    y: box.top - container.top + box.height / 2 + yOffset,
  };
}

/** Half the mark's larger side, which is where its boundary is on a straight run. */
function reachOf(box: DOMRect): number {
  return Math.max(box.width, box.height) / 2;
}

export function AnimatedBeam({
  containerRef,
  fromRef,
  toRef,
  curvature = 0,
  reverse = false,
  duration = 3.2,
  delay = 0,
  repeatDelay = 0.35,
  pathWidth = 1.5,
  color = "#2a9d8f",
  head = true,
  startYOffset = 0,
  endYOffset = 0,
}: AnimatedBeamProps) {
  const id = useId();
  const reduced = useReducedMotion();
  const [path, setPath] = useState("");
  const [size, setSize] = useState({ width: 0, height: 0 });

  const measure = useCallback(() => {
    const container = containerRef.current;
    const from = fromRef.current;
    const to = toRef.current;
    if (container === null || from === null || to === null) return;

    const box = container.getBoundingClientRect();
    setSize({ width: box.width, height: box.height });

    const fromBox = from.getBoundingClientRect();
    const toBox = to.getBoundingClientRect();
    const a = centreOf(fromBox, box, startYOffset);
    const b = centreOf(toBox, box, endYOffset);

    // Both ends stop at the mark's boundary rather than at its centre. The marks
    // are painted over this SVG, so a path drawn to the centre puts its arrowhead
    // underneath the very node it points at, which is where the heads went the
    // first time and why none of them could be seen.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    const start = { x: a.x + ux * (reachOf(fromBox) + 3), y: a.y + uy * (reachOf(fromBox) + 3) };
    const clearance = head ? 9 : 3;
    const end = {
      x: b.x - ux * (reachOf(toBox) + clearance),
      y: b.y - uy * (reachOf(toBox) + clearance),
    };

    // A quadratic through a single control point above the midpoint. Curvature
    // zero gives a straight line, which is what most of these want.
    setPath(
      `M ${start.x},${start.y} Q ${(start.x + end.x) / 2},${start.y - curvature} ${end.x},${end.y}`,
    );
  }, [containerRef, fromRef, toRef, curvature, head, startYOffset, endYOffset]);

  useEffect(() => {
    measure();
    const container = containerRef.current;
    if (container === null) return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    // The marks can change size without the container doing so, which happens
    // whenever a font finishes loading.
    const from = fromRef.current;
    const to = toRef.current;
    if (from !== null) observer.observe(from);
    if (to !== null) observer.observe(to);
    return () => observer.disconnect();
  }, [measure, containerRef, fromRef, toRef]);

  // The gradient is a window that slides across the path in user space. It is
  // sized to the container so the same numbers work at any width.
  const span = size.width === 0 ? 1 : size.width;
  // Written out rather than indexed from a pair, so the resting frame and the
  // travelling one are both named and neither can be `undefined`.
  const from = reverse ? { x1: span, x2: span * 1.35 } : { x1: -span * 0.35, x2: 0 };
  const to = reverse ? { x1: -span * 0.35, x2: 0 } : { x1: span, x2: span * 1.35 };
  const rest = { x1: from.x1, x2: from.x2, y1: 0, y2: 0 } as const;
  const travelling = {
    x1: [from.x1, to.x1],
    y1: [0, 0],
    x2: [from.x2, to.x2],
    y2: [0, 0],
  };

  return (
    <svg
      aria-hidden="true"
      fill="none"
      width={size.width}
      height={size.height}
      viewBox={`0 0 ${size.width} ${size.height}`}
      className="pointer-events-none absolute top-0 left-0"
    >
      <path
        d={path}
        stroke="currentColor"
        strokeOpacity={0.3}
        strokeWidth={pathWidth}
        strokeLinecap="round"
        markerEnd={head ? `url(#${id}-head)` : undefined}
        className="text-muted-foreground"
      />
      <path d={path} stroke={`url(#${id})`} strokeWidth={pathWidth + 0.5} strokeLinecap="round" />
      <defs>
        {/*
          The head is what makes the picture legible when nothing is moving. A
          wire with a pulse on it reads as directional only while the pulse is
          travelling, and most of the time a reader is looking at a still frame.
        */}
        <marker
          id={`${id}-head`}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="9"
          markerHeight="9"
          orient="auto-start-reverse"
        >
          <path d="M0.5 0.5 L7.5 4 L0.5 7.5 z" fill={color} fillOpacity="0.9" />
        </marker>
        <motion.linearGradient
          id={id}
          gradientUnits="userSpaceOnUse"
          initial={rest}
          animate={reduced === true ? rest : travelling}
          transition={{
            delay,
            duration,
            ease: [0.16, 1, 0.3, 1],
            repeat: reduced === true ? 0 : Infinity,
            repeatDelay,
          }}
        >
          <stop stopColor={color} stopOpacity="0" />
          <stop offset="35%" stopColor={color} stopOpacity="0.85" />
          <stop offset="65%" stopColor={color} stopOpacity="0.85" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </motion.linearGradient>
      </defs>
    </svg>
  );
}
