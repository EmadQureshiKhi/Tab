"use client";

/**
 * One Monad transaction, drawn as the path the money and the ledger entry take.
 *
 * This sits beside a Settlement card and shows the one thing the card's rows
 * cannot: that its figures are the effects of a single call. The Agent's wallet
 * signs `TabSettlement.settle`, and from that one mark three things fan out in
 * the same block - the Asset lands at the Service's collection address,
 * `TabBook` applies it to the Open Tab, and the Agent's headroom comes back.
 * All of it lands in the block that carries the call, and a picture with one
 * origin and one block boundary says that faster than a paragraph does.
 *
 * ## The geometry is measured, not authored
 *
 * The beams are drawn between the real positions of the marks rather than
 * between numbers in a `viewBox`, for the reason `client-flow.tsx` gives: text
 * in a scaled SVG is not the size it says it is. Every word here is HTML at its
 * own size, and only the wires are drawn.
 *
 * ## It decorates nothing
 *
 * Every figure on the page is in the card beside it, in text, and this adds no
 * data of its own beyond the block number it is handed. A reader who cannot see
 * it loses nothing, which is why the wires are `aria-hidden` and the marks are
 * labelled in words a screen reader gets in order.
 *
 * Motion decides how, never whether: the wires, the marks and the labels render
 * in every case, and under a reduced-motion preference the pulse simply does
 * not travel. Reading the preference to decide markup would be a hydration
 * mismatch, which `test/motion.test.mjs` refuses.
 */

import { type ReactNode, type RefObject, useRef } from "react";

import { AnimatedBeam } from "./animated-beam";
import { NumberTicker } from "./number-ticker";
import { cn } from "../ui/cn";

const PAYMENT = "#2a9d8f";
const LEDGER = "#7a8ba0";

export interface SettlementStripProps {
  /** The block the transaction landed in, as text. Rendered verbatim. */
  readonly blockNumber: string;
  readonly className?: string;
}

export function SettlementStrip({ blockNumber, className }: SettlementStripProps) {
  const container = useRef<HTMLOListElement>(null);
  const agent = useRef<HTMLDivElement>(null);
  const settle = useRef<HTMLDivElement>(null);
  const collection = useRef<HTMLDivElement>(null);
  const tabBook = useRef<HTMLDivElement>(null);
  const headroom = useRef<HTMLDivElement>(null);

  return (
    <div
      className={cn(
        // `h-full` with a column layout so the diagram takes whatever height the
        // grid row has. Beside a tall card a panel that stopped short would leave
        // part of the row empty, which reads as a missing block rather than as a
        // deliberately short one.
        "relative flex h-full flex-col overflow-hidden rounded-lg border border-border/60 bg-muted/30",
        className,
      )}
    >
      <ol
        ref={container}
        aria-label="What one settlement transaction does"
        className="relative grid flex-1 grid-cols-[auto_auto_auto] items-center justify-between gap-x-4 px-5 py-6 sm:gap-x-8 sm:px-7"
      >
        {/*
          The block boundary. Everything inside it happened in the one block
          named below, which is the claim the whole strip exists to make, so it is
          drawn as a frame rather than said as a caption.
        */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-3 inset-y-3 rounded-md border border-dashed border-teal-700/25 dark:border-teal-400/20"
        />

        <li className="relative z-10 flex flex-col items-center gap-2">
          <Mark ref={agent} label="Agent wallet" tone="quiet">
            <WalletGlyph />
          </Mark>
          <Caption>Agent signs</Caption>
        </li>

        <li className="relative z-10 flex flex-col items-center gap-2">
          <Mark ref={settle} label="TabSettlement.settle" tone="hub">
            <img src="/logo.png" alt="" width={36} height={36} className="size-9 rounded-md" />
          </Mark>
          <Caption>
            <code className="font-mono normal-case tracking-normal">TabSettlement.settle</code>
          </Caption>
        </li>

        <li className="relative z-10 flex flex-col justify-center gap-4">
          <Effect
            ref={collection}
            label="Asset paid to the Service's collection address"
            glyph={<CoinGlyph />}
            caption="Service paid"
          />
          <Effect
            ref={tabBook}
            label="TabBook applies the amount to the Open Tab"
            glyph={<LedgerGlyph />}
            caption="Open Tab reduced"
          />
          <Effect
            ref={headroom}
            label="Headroom restored to the Agent"
            glyph={<HeadroomGlyph />}
            caption="Headroom back"
          />
        </li>

        <AnimatedBeam
          containerRef={container}
          fromRef={agent}
          toRef={settle}
          color={PAYMENT}
          head={false}
          duration={2.2}
          repeatDelay={2.4}
        />
        {/*
          The three effects fan out from the one call, and they leave together.
          Their delays are equal on purpose: a stagger would draw a sequence, and
          there is none. The contract does all three before the transaction
          returns.
        */}
        <AnimatedBeam
          containerRef={container}
          fromRef={settle}
          toRef={collection}
          color={PAYMENT}
          head={false}
          duration={2.2}
          delay={1.1}
          repeatDelay={2.4}
        />
        <AnimatedBeam
          containerRef={container}
          fromRef={settle}
          toRef={tabBook}
          color={LEDGER}
          head={false}
          duration={2.2}
          delay={1.1}
          repeatDelay={2.4}
        />
        <AnimatedBeam
          containerRef={container}
          fromRef={settle}
          toRef={headroom}
          color={LEDGER}
          head={false}
          duration={2.2}
          delay={1.1}
          repeatDelay={2.4}
        />
      </ol>

      <p className="border-t border-border px-5 py-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
        One transaction, in block{" "}
        <NumberTicker value={blockNumber} className="text-foreground" />. The payment and the
        ledger entry are the same Monad transaction, so there is nothing to wait for after it.
        Every figure is in the card beside this; the picture carries none of its own.
      </p>
    </div>
  );
}

/** A labelled node the beams are drawn between. */
function Mark({
  ref,
  label,
  tone,
  children,
}: {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly label: string;
  readonly tone: "quiet" | "hub";
  readonly children: ReactNode;
}) {
  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      className={cn(
        "relative z-10 flex items-center justify-center",
        tone === "hub"
          ? "size-[68px] rounded-2xl border border-teal-700/30 bg-teal-900/15 sm:size-[76px] dark:border-teal-400/20 dark:bg-teal-300/10"
          : "size-12 rounded-full border border-border/70 bg-background sm:size-14",
      )}
    >
      {children}
    </div>
  );
}

/** One of the three effects, drawn small so the call stays the largest thing. */
function Effect({
  ref,
  label,
  glyph,
  caption,
}: {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly label: string;
  readonly glyph: ReactNode;
  readonly caption: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        ref={ref}
        role="img"
        aria-label={label}
        className="relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background"
      >
        {glyph}
      </div>
      <Caption>{caption}</Caption>
    </div>
  );
}

function Caption({ children }: { readonly children: ReactNode }) {
  return (
    <span className="max-w-[9rem] text-center font-mono text-[10px] leading-tight tracking-[0.14em] text-muted-foreground uppercase">
      {children}
    </span>
  );
}

/** A key, for the wallet that signs. */
function WalletGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="size-6 text-muted-foreground"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <path d="M15 12h3.5" />
      <circle cx="15.5" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A coin, for the Asset that moved. */
function CoinGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="size-5 text-muted-foreground"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5v9M9.5 10a2.5 2 0 0 1 5 0c0 2-5 2-5 4a2.5 2 0 0 0 5 0" />
    </svg>
  );
}

/** A ledger line, for the tab that was reduced. */
function LedgerGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="size-5 text-muted-foreground"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M5 6h14M5 12h14M5 18h8" />
      <path d="M16 18l2 2 3-3" />
    </svg>
  );
}

/** A gauge opening, for the headroom that came back. */
function HeadroomGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="size-5 text-muted-foreground"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M4 17a8 8 0 1 1 16 0" />
      <path d="M12 17 7.5 12.5" />
      <circle cx="12" cy="17" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
