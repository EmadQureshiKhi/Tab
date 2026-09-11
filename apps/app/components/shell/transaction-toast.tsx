"use client";

/**
 * What the page says after a transaction is broadcast.
 *
 * ## Why this exists
 *
 * Four write paths in this Dashboard hand a wallet a transaction: binding a
 * Source Chain address, registering a Service, claiming a Bond collection, and
 * paying a Bond deposit. Every one of them returned a hash and did nothing with
 * it - `/register` discarded it outright, the other three printed it as inert
 * monospace text. So the one moment the product is most worth trusting, the
 * moment something is actually on chain, was the moment it said least.
 *
 * A hash the reader cannot open is a hash they have to paste somewhere. The
 * whole argument of this project is that every figure is checkable, and a
 * checkable figure with no link is only half the claim.
 *
 * ## The countdown is the dismiss
 *
 * The line along the bottom edge is not decoration. It runs for exactly as long
 * as the toast has left, so the reader can see the thing is about to go rather
 * than having it vanish mid-read. Hovering pauses it, because a toast that
 * disappears while you are reaching for its link is worse than no toast.
 *
 * It is drawn in the same green this product already uses for a Confirmed
 * Clearing, rather than a new one: a transaction landing and a clearing
 * confirming are the same kind of event, and the interface should not invent a
 * second vocabulary for it.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { blockscoutTxUrl } from "../../src/dashboard/views";

/** How long a toast stays up, and how long the line takes to cross. */
const DWELL_MS = 5_000;

export interface AnnouncedTransaction {
  /** The transaction hash the wallet returned. */
  readonly hash: string;
  /** What the reader just did, in their words rather than the contract's. */
  readonly title: string;
  /** One line of detail. Optional: the title carries the meaning. */
  readonly detail?: string;
}

interface Announced extends AnnouncedTransaction {
  readonly id: number;
}

interface TransactionToastValue {
  /** Announce a broadcast transaction. Safe to call when no provider is mounted. */
  readonly announce: (transaction: AnnouncedTransaction) => void;
}

const TransactionToastContext = createContext<TransactionToastValue>({
  // A no-op default rather than a thrown error. Announcing is a courtesy on top
  // of a flow that has already succeeded, so a caller rendered outside the
  // provider should lose the toast, not the transaction.
  announce: () => undefined,
});

export function useTransactionToast(): TransactionToastValue {
  return useContext(TransactionToastContext);
}

export interface TransactionToastProviderProps {
  readonly children: ReactNode;
  /** Blockscout base, resolved on the server where the environment is readable. */
  readonly explorerUrl: string;
}

export function TransactionToastProvider({ children, explorerUrl }: TransactionToastProviderProps) {
  const [items, setItems] = useState<readonly Announced[]>([]);
  const next = useRef(0);

  const announce = useCallback((transaction: AnnouncedTransaction): void => {
    next.current += 1;
    const id = next.current;
    setItems((current) => [...current, { ...transaction, id }]);
  }, []);

  const dismiss = useCallback((id: number): void => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const value = useMemo<TransactionToastValue>(() => ({ announce }), [announce]);

  return (
    <TransactionToastContext.Provider value={value}>
      {children}
      {/*
        `aria-live="polite"` rather than `assertive`: the transaction is already
        sent, so this is an announcement and not an interruption. `pointer-events-none`
        on the stack with `pointer-events-auto` on each card keeps the region from
        swallowing clicks on the page behind it.
      */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-0 bottom-0 z-50 flex w-full max-w-sm flex-col gap-2 p-4 sm:p-6"
      >
        {items.map((item) => (
          <Toast
            key={item.id}
            item={item}
            explorerUrl={explorerUrl}
            onDismiss={() => dismiss(item.id)}
          />
        ))}
      </div>
    </TransactionToastContext.Provider>
  );
}

function Toast({
  item,
  explorerUrl,
  onDismiss,
}: {
  readonly item: Announced;
  readonly explorerUrl: string;
  readonly onDismiss: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const [entered, setEntered] = useState(false);

  // Two frames before the entrance, not one. A single frame sometimes lands in
  // the same paint as the insert, and the element arrives already in place with
  // no transition at all.
  useEffect(() => {
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (paused) return undefined;
    const timer = setTimeout(onDismiss, DWELL_MS);
    return () => clearTimeout(timer);
  }, [paused, onDismiss]);

  return (
    <div
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={[
        "pointer-events-auto relative overflow-hidden rounded-lg border border-border bg-card shadow-lg",
        "transition-all duration-300 ease-out motion-reduce:transition-none",
        entered ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
      ].join(" ")}
    >
      <div className="flex items-start gap-3 p-4">
        <img src="/logo.png" alt="" width={20} height={20} className="mt-0.5 shrink-0 rounded-sm" />
        <div className="min-w-0 flex-1">
          <p className="font-host text-sm font-semibold text-foreground">{item.title}</p>
          {item.detail === undefined ? null : (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
          )}
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{item.hash}</p>
          <a
            href={blockscoutTxUrl(item.hash, explorerUrl)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex font-mono text-xs tracking-wide text-teal-700 underline decoration-dotted underline-offset-2 hover:text-teal-600 dark:text-teal-300 dark:hover:text-teal-200"
          >
            VIEW ON EXPLORER
          </a>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mt-1 -mr-1 shrink-0 rounded p-1 font-mono text-xs text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </div>

      {/*
        The countdown, anchored to the bottom edge and shrinking from the right.
        `transform` rather than `width` so it animates on the compositor and does
        not lay the card out again sixty times a second.
      */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-0.5 origin-right bg-[var(--tab-clearing-confirmed)] motion-reduce:hidden"
        style={{
          animation: `tab-toast-countdown ${DWELL_MS}ms linear forwards`,
          animationPlayState: paused ? "paused" : "running",
        }}
      />
    </div>
  );
}
