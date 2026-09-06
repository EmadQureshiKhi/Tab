"use client";

/**
 * One settlement, end to end.
 *
 * ## Why this is not a node graph
 *
 * It was one: four marks on two chain lanes with curved wires crossing between
 * them. A wire diagram is the picture an engineer draws on a whiteboard, and it
 * has a real weakness on a page - the crossings are the most visually prominent
 * thing in it, and crossings carry no meaning. The reader's eye goes to the
 * tangle rather than to the order of events, which is the only thing the section
 * is there to teach.
 *
 * So it is four steps with one panel, which is the shape almost every product
 * page that has to explain a sequence has converged on: emphasis moves down a
 * list, and a single surface beside it shows the artefact of whichever step is
 * running. Nothing crosses anything. One thing changes at a time.
 *
 * ## The panel shows the real thing
 *
 * Each step draws the actual record it produces: the delivery, the Ethereum
 * transfer, the precompile's answer, the cleared tab. The addresses and figures
 * are this deployment's. A diagram of abstract boxes would have been easier and
 * would have taught nobody what a Verified Settlement actually looks like.
 *
 * Every step carries the same number of rows so the panel never changes height,
 * because a panel that resizes on a timer is a page that jumps while you read it.
 *
 * ## The scroll is the control
 *
 * Where there is room for it, the section holds still while the page scrolls
 * past it and the reader's own scrolling is what advances the step. That is the
 * right control for this content: the four stages are one movement in time, and
 * scrolling is the gesture a reader already uses to move through time on a page.
 * It also means nobody waits - a reader who wants step four goes and gets it.
 *
 * Below `lg` there is not enough height to hold a section still without trapping
 * the page, so the steps advance on a timer instead. Both paths render the same
 * markup; only the thing driving the index differs, and it is chosen after mount,
 * so the server and the first client paint agree.
 *
 * The steps are real tabs either way: they take focus, they answer the arrow
 * keys, and taking hold of one stops the timer. Under a reduced-motion
 * preference nothing advances on its own and the same tree is rendered, which is
 * the rule `test/motion.test.mjs` enforces.
 *
 * Requirements: 24.9, 24.10
 */

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  motion,
  useInView,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useTransform,
} from "motion/react";

import { Reveal } from "./reveal";
import { cn } from "../ui/cn";

/** Milliseconds a step holds before emphasis moves on. */
const DWELL = 5200;

interface Row {
  readonly label: string;
  readonly value: string;
  /** The one figure the step exists to produce. */
  readonly lead?: boolean;
}

interface Step {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly chain: string;
  /** True on the Source Chain, which the chain mark shows without a word. */
  readonly source?: boolean;
  readonly call: string;
  readonly rows: readonly Row[];
  readonly note: string;
}

const STEPS: readonly Step[] = [
  {
    key: "meter",
    title: "Meter",
    detail: "A metered tool is called. Nothing is prepaid, and nothing blocks it.",
    chain: "Creditcoin CC3",
    call: "tab_call → tab.proof-service",
    rows: [
      { label: "Delivered", value: "1 call" },
      { label: "Price", value: "0.01 USDC" },
      { label: "Prepaid drawn", value: "0.00 USDC" },
      { label: "Open Tab", value: "0.01 USDC", lead: true },
    ],
    note: "The work is delivered first. The charge is recorded after it.",
  },
  {
    key: "settle",
    title: "Settle",
    detail: "The Agent pays on Ethereum, signed by its own keys and nobody else's.",
    chain: "Ethereum Sepolia",
    source: true,
    call: "USDC.transfer",
    rows: [
      { label: "From", value: "0x1f6f…0542" },
      { label: "To", value: "0xe5ea…2b37" },
      { label: "Value", value: "0.01 USDC" },
      { label: "Signed by", value: "the Agent's own key", lead: true },
    ],
    note: "No component of Tab can move an Agent's funds. There is none to compromise.",
  },
  {
    key: "prove",
    title: "Prove",
    detail: "A Creditcoin contract verifies that Ethereum transaction itself.",
    chain: "Creditcoin CC3",
    call: "SettlementVerifier.verifyAndEmit",
    rows: [
      { label: "BlockProver", value: "0x…0FD2" },
      { label: "Merkle Proof", value: "accepted" },
      { label: "Continuity Proof", value: "accepted" },
      { label: "Returned", value: "true", lead: true },
    ],
    note: "No facilitator, oracle or bridge asserted that this payment happened.",
  },
  {
    key: "clear",
    title: "Clear",
    detail: "The Open Tab falls by exactly what the chain says was paid.",
    chain: "Creditcoin CC3",
    call: "TabBook.confirmClearing",
    rows: [
      { label: "Open Tab before", value: "0.01 USDC" },
      { label: "Verified Settlement", value: "0.01 USDC" },
      { label: "Open Tab after", value: "0.00 USDC" },
      { label: "Clearing", value: "Confirmed", lead: true },
    ],
    note: "Every figure on this site is the same read, against the same chain.",
  },
];

export function SettlementWalkthrough({ className }: { readonly className?: string }) {
  const reduced = useReducedMotion();
  const track = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const onScreen = useInView(container, { margin: "0px 0px -20% 0px" });
  const base = useId();

  const [mounted, setMounted] = useState(false);
  const [scrollDriven, setScrollDriven] = useState(false);
  const [active, setActive] = useState(0);
  const [held, setHeld] = useState(false);
  useEffect(() => setMounted(true), []);

  // The tall track is only laid out from `lg`, so the scroll drive only applies
  // there. Read after mount, which is why it cannot change what is rendered on
  // the server.
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const sync = () => setScrollDriven(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const { scrollYProgress } = useScroll({ target: track, offset: ["start start", "end end"] });
  useMotionValueEvent(scrollYProgress, "change", (progress) => {
    if (!scrollDriven || reduced === true) return;
    // The last band is widened a little so the final step is not a flash as the
    // track runs out under the reader.
    const index = Math.floor(progress * STEPS.length);
    setActive(Math.min(STEPS.length - 1, Math.max(0, index)));
  });

  /*
    How far through the running step the reader is, as a height.

    A `MotionValue` rather than state: this is written on every scroll frame, and
    putting it through React would re-render the whole section a hundred times a
    second to move one rule by a pixel. Motion writes it straight to the element.
  */
  const fill = useTransform(scrollYProgress, (progress) => {
    const scaled = Math.min(STEPS.length, Math.max(0, progress * STEPS.length));
    return `${Math.min(100, (scaled - Math.floor(scaled === STEPS.length ? scaled - 1 : scaled)) * 100)}%`;
  });

  const running = mounted && reduced !== true && onScreen && !held && !scrollDriven;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setActive((n) => (n + 1) % STEPS.length), DWELL);
    return () => clearInterval(timer);
  }, [running]);

  const step = STEPS[active] ?? STEPS[0];
  if (step === undefined) return null;

  /** Left and right arrows move between tabs, which is what a tablist owes a keyboard. */
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    setHeld(true);
    const next = (active + delta + STEPS.length) % STEPS.length;
    setActive(next);
    document.getElementById(`${base}-tab-${next}`)?.focus();
  }

  return (
    /*
      The track is what the reader scrolls through. Its height is the budget the
      section gets: four steps at roughly one screen each, plus a screen to
      arrive and leave on. It only exists from `lg`; below that the section is its
      own height and the timer drives it.
    */
    <section ref={track} className={cn("relative lg:h-[300vh]", className)}>
      {/*
        The pinned block fills the screen below the masthead and centres what it
        holds. Pinned to the top instead, a 530px card left 280px of empty page
        under it for the whole time the section was held, which reads as the page
        having stopped rather than as the section having taken the screen.
      */}
      <div className="flex flex-col justify-center gap-8 lg:sticky lg:top-20 lg:min-h-[calc(100dvh-5rem)]">
        <Reveal className="flex flex-col gap-1">
          <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
            How it works
          </p>
          <h2 className="font-host text-2xl font-semibold text-foreground sm:text-3xl">
            One settlement, end to end
          </h2>
        </Reveal>

        <div
          ref={container}
          className="grid gap-6 rounded-xl border border-border/60 bg-muted/30 p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-10"
        >
      <div
        role="tablist"
        aria-label="The four stages of one settlement"
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        className="flex flex-col"
      >
        {STEPS.map((entry, index) => {
          const current = index === active;
          return (
            <button
              key={entry.key}
              id={`${base}-tab-${index}`}
              type="button"
              role="tab"
              aria-selected={current}
              aria-controls={`${base}-panel`}
              tabIndex={current ? 0 : -1}
              onClick={() => {
                setHeld(true);
                setActive(index);
              }}
              className={cn(
                "group relative w-full cursor-pointer border-s-2 py-4 ps-5 pe-2 text-start transition-colors duration-300",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                current
                  ? "border-s-teal-600 bg-foreground/[0.03] dark:border-s-teal-400"
                  : "border-s-border/70",
              )}
            >
              <span className="flex items-baseline gap-3">
                <span
                  className={cn(
                    "font-mono text-[11px] tracking-widest tabular-nums transition-colors duration-300",
                    current ? "text-teal-700 dark:text-teal-400" : "text-muted-foreground",
                  )}
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span
                  className={cn(
                    "font-host text-base font-semibold transition-colors duration-300 sm:text-lg",
                    current ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {entry.title}
                </span>
              </span>
              <span
                className={cn(
                  "mt-1.5 block max-w-md text-sm leading-relaxed transition-colors duration-300",
                  current ? "text-muted-foreground" : "text-muted-foreground/55",
                )}
              >
                {entry.detail}
              </span>

              {/*
                The rule fills over the dwell. It is drawn on top of the resting
                border rather than replacing it, so the list's left edge is a
                continuous line whether or not anything is running.
              */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 -start-0.5 w-0.5 overflow-hidden"
              >
                {scrollDriven ? (
                  <motion.span
                    className="block w-full bg-teal-600 dark:bg-teal-400"
                    style={{ height: current ? fill : "0%" }}
                  />
                ) : (
                  <motion.span
                    key={`${entry.key}-${active}-${String(running)}`}
                    className="block w-full bg-teal-600 dark:bg-teal-400"
                    initial={{ height: "0%" }}
                    animate={{ height: current ? "100%" : "0%" }}
                    transition={
                      current && running
                        ? { duration: DWELL / 1000, ease: "linear" }
                        : { duration: 0.25 }
                    }
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div
        id={`${base}-panel`}
        role="tabpanel"
        aria-labelledby={`${base}-tab-${active}`}
        className="flex flex-col overflow-hidden rounded-lg border border-border/70 bg-[var(--panel)]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3 sm:px-5">
          <span className="inline-flex items-center gap-2 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
            <ChainDot source={step.source === true} />
            {step.chain}
          </span>
          <span className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
            Step {active + 1} of {STEPS.length}
          </span>
        </div>

        {/*
          Keyed on the step so the whole block is replaced rather than diffed,
          which is what lets the rows stagger in each time.
        */}
        <motion.div
          key={step.key}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
          className="flex flex-1 flex-col gap-4 px-4 py-4 sm:px-5 sm:py-5"
        >
          <p className="font-mono text-[13px] break-all text-foreground">{step.call}</p>

          <dl className="flex flex-1 flex-col">
            {step.rows.map((row, index) => (
              <Line key={row.label} index={index} still={reduced === true}>
                <dt className="font-mono text-xs text-muted-foreground">{row.label}</dt>
                <dd
                  className={cn(
                    "text-end font-mono text-xs break-all",
                    row.lead ? "text-teal-700 dark:text-teal-300" : "text-foreground",
                  )}
                >
                  {row.value}
                </dd>
              </Line>
            ))}
          </dl>

          <p className="mt-auto border-t border-border/70 pt-3 text-xs leading-relaxed text-muted-foreground">
            {step.note}
          </p>
        </motion.div>
        </div>
        </div>
      </div>
    </section>
  );
}

/** One row of the record, arriving a beat after the one above it. */
function Line({
  index,
  still,
  children,
}: {
  readonly index: number;
  readonly still: boolean;
  readonly children: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={still ? { duration: 0 } : { duration: 0.3, delay: 0.06 + index * 0.07 }}
      className="flex flex-1 items-center justify-between gap-4 border-b border-border/50 py-3 last:border-b-0"
    >
      {children}
    </motion.div>
  );
}

/** Which chain the step happens on, said twice: by the word and by the mark. */
function ChainDot({ source }: { readonly source: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 rounded-full",
        source ? "bg-[#7a8ba0]" : "bg-teal-600 dark:bg-teal-400",
      )}
    />
  );
}
