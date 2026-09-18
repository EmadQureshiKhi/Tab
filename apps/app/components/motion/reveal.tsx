"use client";

/**
 * The reveal every section uses on the way in.
 *
 * One component rather than a Motion call per section, because a site whose
 * sections each ease in slightly differently reads as unfinished rather than as
 * varied. The distance and the curve are the same everywhere.
 *
 * `from` is the one thing that varies, and it varies systematically: where a
 * section is two columns of one idea, they arrive from opposite edges and meet.
 * That is a different thing from decorating each section differently - the rule
 * is that direction carries the relationship between two elements, so a lone
 * block always rises and never slides.
 *
 * It reveals once and stays revealed. A section that fades out when it leaves the
 * viewport and back in when it returns is a section a reader has to wait for
 * twice, and scrolling back up should never cost anything.
 */

import type { ElementType, ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

/** Which edge the element travels from. `up` is the default and the common case. */
export type RevealFrom = "up" | "left" | "right";

export interface RevealProps {
  readonly children: ReactNode;
  readonly className?: string;
  /** Seconds. Use it to make one element follow another, not to stagger a list. */
  readonly delay?: number;
  readonly as?: ElementType;
  /** Pixels travelled on the way in. */
  readonly distance?: number;
  readonly from?: RevealFrom;
}

/**
 * The offset a direction starts at.
 *
 * A sideways reveal travels further than a rising one. The same 14px that reads
 * as a lift reads as a twitch when it is horizontal, because there is no
 * baseline for the eye to measure it against.
 */
function offsetFor(from: RevealFrom, distance: number): { x: number; y: number } {
  if (from === "left") return { x: -(distance + 24), y: 0 };
  if (from === "right") return { x: distance + 24, y: 0 };
  return { x: 0, y: distance };
}

export function Reveal({
  children,
  className,
  delay = 0,
  as = "div",
  distance = 14,
  from = "up",
}: RevealProps) {
  const reduced = useReducedMotion() === true;
  const Component = motion[as as "div"] ?? motion.div;
  const offset = offsetFor(from, distance);

  return (
    <Component
      className={className}
      data-reveal=""
      initial={{ opacity: 0, x: offset.x, y: offset.y }}
      whileInView={{ opacity: 1, x: 0, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -12% 0px" }}
      transition={{
        duration: reduced ? 0 : from === "up" ? 0.5 : 0.62,
        delay: reduced ? 0 : delay,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      {children}
    </Component>
  );
}

/**
 * A list whose items arrive one after another.
 *
 * Separate from {@link Reveal} because a stagger needs the parent to own the
 * timing: giving each child its own delay prop produces a sequence that drifts as
 * the list grows and cannot be reversed.
 */
export function RevealGroup({
  children,
  className,
  step = 0.06,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly step?: number;
}) {
  const reduced = useReducedMotion() === true;
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "0px 0px -12% 0px" }}
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: reduced ? 0 : step } },
      }}
    >
      {children}
    </motion.div>
  );
}

/** One member of a {@link RevealGroup}. Takes its timing from the parent. */
export function RevealItem({
  children,
  className,
  as = "div",
  from = "up",
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly as?: ElementType;
  readonly from?: RevealFrom;
}) {
  const reduced = useReducedMotion() === true;
  const Component = motion[as as "div"] ?? motion.div;
  const offset = offsetFor(from, 12);
  return (
    <Component
      className={className}
      data-reveal=""
      variants={{
        hidden: { opacity: 0, x: offset.x, y: offset.y },
        visible: {
          opacity: 1,
          x: 0,
          y: 0,
          transition: { duration: reduced ? 0 : 0.45, ease: [0.22, 1, 0.36, 1] },
        },
      }}
    >
      {children}
    </Component>
  );
}
