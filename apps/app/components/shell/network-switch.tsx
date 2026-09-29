"use client";

/**
 * The masthead's network switch: Testnet or Mainnet, one press apart.
 *
 * ## It states the network before it offers the other one
 *
 * It is the network badge first and a control second. The outline and the
 * selected half carry the network's tint, and the
 * selected half says `Testnet` or `Mainnet` in words, because a reader should
 * never have to know that a colour means test money to read a balance
 * correctly. The other half is quiet until it is hovered. The two words are
 * the same length, so the halves are the same width and nothing in the
 * masthead shifts when the choice changes.
 *
 * ## One choice, held by the server
 *
 * Pressing a half writes the `tab-network` cookie and asks the router to render
 * the current route again. Every server component and every API route reads the
 * cookie before it reads anything else, so the whole page changes network in
 * one render rather than piece by piece. While that render is in flight the
 * pressed half shows as selected and pulses, and the group is marked busy.
 *
 * ## A radio group, because that is what it is
 *
 * Two mutually exclusive options with one always chosen. The arrow keys move
 * between them and choose as they go, Tab enters and leaves the group at the
 * chosen half, and each half's name is its network, so a screen reader hears
 * "Network, radio group, Testnet, selected".
 */

import { useRouter } from "next/navigation";
import { useState, useTransition, type KeyboardEvent } from "react";

import { networkCookieAssignment, type ChainNetwork } from "../../src/dashboard/network";
import { cn } from "../ui/cn";
import { FOCUS_RING } from "../ui/focus-ring";

const OPTIONS = [
  { kind: "testnet", label: "Testnet", title: "Monad Testnet: test money, nothing here is real value" },
  { kind: "mainnet", label: "Mainnet", title: "Monad Mainnet: real money" },
] as const satisfies readonly { kind: ChainNetwork; label: string; title: string }[];

/*
  The network's tint, the same one the Testnet and Mainnet badges on every card
  use: amber for test money, teal for real money, in both themes. The outline takes the
  selected network's border and the selected half its fill and ink.
*/
const OUTLINE_CLASSES: Record<ChainNetwork, string> = {
  testnet: "border-amber-600/25 dark:border-amber-400/20",
  mainnet: "border-teal-700/25 dark:border-teal-400/20",
};
const SELECTED_CLASSES: Record<ChainNetwork, string> = {
  testnet: "bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400",
  mainnet: "bg-teal-500/10 text-teal-700 dark:bg-teal-800/40 dark:text-teal-200",
};

export interface NetworkSwitchViewProps {
  /** The network the page is showing, or the one just asked for while it loads. */
  readonly selected: ChainNetwork;
  /** True while the page is being rendered again on the newly chosen network. */
  readonly pending?: boolean;
  readonly onSelect?: (kind: ChainNetwork) => void;
  readonly className?: string;
}

/** The control itself, with no router: what the tests render. */
export function NetworkSwitchView({ selected, pending = false, onSelect, className }: NetworkSwitchViewProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    // Two options, so every arrow is "the other one".
    const next: ChainNetwork = selected === "testnet" ? "mainnet" : "testnet";
    onSelect?.(next);
    const target = event.currentTarget.querySelector<HTMLButtonElement>(`[data-network="${next}"]`);
    target?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Network"
      aria-busy={pending || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        // Thirty pixels tall, the height of the connection beside it, and no
        // wider than two short words. The masthead's right-hand group has no
        // spare width at 1024px, where a wider control would push the links
        // over the wordmark.
        "inline-flex items-stretch rounded-md border font-mono text-xs tracking-wide transition-colors",
        OUTLINE_CLASSES[selected],
        className,
      )}
    >
      {OPTIONS.map((option, index) => {
        const checked = option.kind === selected;
        return (
          <button
            key={option.kind}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            title={option.title}
            data-network={option.kind}
            onClick={() => {
              if (!checked) onSelect?.(option.kind);
            }}
            className={cn(
              // Uppercase on the button itself: the reset stops a button inheriting it.
              "px-1.5 py-1.5 uppercase transition-colors",
              // Rounded on the outer edge only, one pixel inside the outline.
              index === 0 ? "rounded-s-[5px]" : "rounded-e-[5px]",
              checked
                ? cn(SELECTED_CLASSES[option.kind], pending && "animate-pulse")
                : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
              FOCUS_RING,
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export interface NetworkSwitchProps {
  /** The network the server rendered this page for. */
  readonly networkKind: ChainNetwork;
  readonly className?: string;
}

export function NetworkSwitch({ networkKind, className }: NetworkSwitchProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [requested, setRequested] = useState<ChainNetwork | undefined>(undefined);

  // Once the new render lands the server's answer is the truth again, so a
  // request only overrides the prop while it is in flight.
  const selected = pending && requested !== undefined ? requested : networkKind;

  const choose = (kind: ChainNetwork): void => {
    if (kind === selected) return;
    document.cookie = networkCookieAssignment(kind);
    setRequested(kind);
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <NetworkSwitchView
      selected={selected}
      pending={pending}
      onSelect={choose}
      {...(className === undefined ? {} : { className })}
    />
  );
}
