"use client";

/**
 * What happens when a client calls, drawn as the path the call takes.
 *
 * The logo row above this says which clients work. It does not say what happens
 * when one of them calls, which is the question a reader has next, so this draws
 * the path: the client on the left, Tab in the middle, the Service on the right,
 * a request travelling out and the charge coming back afterwards on the same
 * wire.
 *
 * ## The geometry is measured, not authored
 *
 * The beams are drawn between the real positions of the marks rather than
 * between numbers in a `viewBox`. The first version of this diagram put its
 * labels inside a 320-unit `viewBox` stretched to 800 pixels, which rendered an
 * `11px` label at 27 pixels: text in a scaled SVG is not the size it says it is.
 * Every word here is HTML at its own size, and only the wires are drawn.
 *
 * ## Colour
 *
 * A request is teal, the charge coming back is slate, and neither is saturated
 * enough to compete with the marks it connects. The pulse is what carries the
 * eye; the resting wire stays at 14% so the picture reads as a diagram when
 * nothing is moving.
 */

import { useRef } from "react";

import { AnimatedBeam } from "./animated-beam";
import { Reveal } from "./reveal";
import { cn } from "../ui/cn";

/**
 * Six of the eight clients the row above names.
 *
 * All eight would make thirteen wires converging on one square, and the point of
 * the picture is the shape of the path rather than the length of the list. The
 * row above is the list.
 */
const CLIENTS = [
  { name: "Claude", icon: "/logos/clients/claude.svg" },
  { name: "Cursor", icon: "/logos/clients/cursor-cube.svg" },
  { name: "OpenAI", icon: "/logos/clients/OpenAI-black-monoblossom.svg" },
  { name: "Gemini", icon: "/logos/clients/Google_Gemini_icon_2025.svg" },
  { name: "Zed", icon: "/logos/clients/zed-logo.svg" },
] as const;

const REQUEST = "#2a9d8f";
const RESULT = "#7a8ba0";

export function ClientFlow({ className }: { readonly className?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const hub = useRef<HTMLDivElement>(null);
  const service = useRef<HTMLDivElement>(null);
  // One ref per client, created up front so the count is fixed across renders.
  const c0 = useRef<HTMLDivElement>(null);
  const c1 = useRef<HTMLDivElement>(null);
  const c2 = useRef<HTMLDivElement>(null);
  const c3 = useRef<HTMLDivElement>(null);
  const c4 = useRef<HTMLDivElement>(null);
  const clients = [c0, c1, c2, c3, c4];

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border/60 bg-muted/30 p-5 sm:p-6",
        className,
      )}
    >
      <div
        ref={container}
        className="relative flex w-full items-stretch justify-between gap-4 px-1 sm:gap-10 sm:px-4"
      >
        <div className="flex flex-col justify-center gap-2.5 sm:gap-3">
          {CLIENTS.map((client, index) => (
            <div
              key={client.name}
              ref={clients[index]}
              className="relative z-10 flex size-12 items-center justify-center rounded-full border border-border/70 bg-background sm:size-14"
            >
              <img
                src={client.icon}
                alt={client.name}
                width={28}
                height={28}
                className="size-6 object-contain brightness-0 grayscale sm:size-7 dark:brightness-200"
              />
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center justify-center gap-3">
          <div
            ref={hub}
            className="relative z-10 flex size-[72px] items-center justify-center rounded-2xl border border-teal-700/30 bg-teal-900/15 sm:size-20 dark:border-teal-400/20 dark:bg-teal-300/10"
          >
            <img src="/logo.png" alt="Tab" width={40} height={40} className="size-10 rounded-lg" />
          </div>
          <span className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
            Tab
          </span>
          {/*
            The charge does not travel anywhere, which is exactly the thing a
            reader gets wrong about post-paid billing. Drawing it as a figure
            recorded here, off both wires, is the only honest place to put it.
          */}
          <span className="rounded-full border border-border/70 bg-background px-2.5 py-1 font-mono text-[9px] tracking-wider text-muted-foreground">
            open tab +0.01 USDC
          </span>
        </div>

        <div className="flex flex-col items-center justify-center gap-3">
          <div
            ref={service}
            className="relative z-10 flex size-12 items-center justify-center rounded-full border border-border/70 bg-background sm:size-14"
          >
            <ServiceGlyph />
          </div>
          <span className="max-w-20 text-center font-mono text-[10px] leading-tight tracking-[0.14em] text-muted-foreground uppercase">
            Any Service
          </span>
        </div>

        {/*
          The fan in is one wire per client, staggered so six beams do not fire
          as a single flash.
        */}
        {clients.map((ref, index) => (
          <AnimatedBeam
            key={`call-${index}`}
            containerRef={container}
            fromRef={ref}
            toRef={hub}
            color={REQUEST}
            head={false}
            duration={2.8}
            delay={index * 0.24}
          />
        ))}

        {/*
          The leg to the Service and the leg back are bowed in opposite
          directions, which is the whole reason they are drawn as two wires. They
          were drawn along the same path once, one reversed, and the picture then
          had two colours in its legend and one line on the page.
        */}
        <AnimatedBeam
          containerRef={container}
          fromRef={hub}
          toRef={service}
          color={REQUEST}
          head={false}
          curvature={58}
          duration={2.4}
          delay={0.6}
        />
        <AnimatedBeam
          containerRef={container}
          fromRef={service}
          toRef={hub}
          color={RESULT}
          head={false}
          curvature={-58}
          duration={2.4}
          delay={2.1}
        />
      </div>

      <Reveal className="mt-6 flex flex-col gap-2.5 sm:mt-7 sm:flex-row sm:gap-8">
        <Legend
          color={REQUEST}
          label="Call"
          text="goes out carrying the Agent's identity. Nothing is paid to send it, and no balance blocks it."
        />
        <Legend
          color={RESULT}
          label="Result"
          text="comes back first. Only then is the charge written to the Open Tab, on Creditcoin."
        />
      </Reveal>
    </div>
  );
}

/** One wire explained, in the wire's own colour. */
function Legend({
  color,
  label,
  text,
}: {
  readonly color: string;
  readonly label: string;
  readonly text: string;
}) {
  return (
    <p className="flex flex-1 items-start gap-2.5 text-xs leading-relaxed text-muted-foreground">
      <span
        aria-hidden="true"
        className="mt-[7px] h-px w-6 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span>
        <span className="font-mono text-[11px] tracking-widest text-foreground uppercase">
          {label}
        </span>{" "}
        {text}
      </span>
    </p>
  );
}

/** A meter dial, for a Service that charges by what it delivered. */
function ServiceGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="size-6 text-muted-foreground"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M4 17a8 8 0 1 1 16 0" />
      <path d="M12 17 16 11" />
      <circle cx="12" cy="17" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
