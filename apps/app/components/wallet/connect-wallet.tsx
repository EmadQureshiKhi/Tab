"use client";

/**
 * The masthead's connection.
 *
 * ## It is deliberately quiet
 *
 * Every read on this site works without a wallet, and only two actions need one.
 * A connect button drawn as the loudest thing in the masthead would say the
 * opposite: that this is a site you sign into. It takes the same tinted treatment
 * the chain toggle uses, sits after it, and only becomes emphatic once there is
 * something to report - a wrong chain.
 *
 * ## Connected is a fact, not a badge
 *
 * Once connected it shows the account, truncated, and the chain. A reader about
 * to sign needs to know which account and which chain before they press, not
 * after the wallet dialog opens, and putting it in the masthead means it is
 * answered on every page rather than restated by every form.
 *
 * Requirements: 24.5, 24.10
 */

import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";

import { SUGGESTED, knownMark } from "./discovery";
import { useWallet } from "./wallet-context";
import { cn } from "../ui/cn";
import { FOCUS_RING } from "../ui/focus-ring";

/** Chains this product signs on, by id, so the masthead can name the one in use. */
const KNOWN: Record<number, string> = {
  102031: "Creditcoin",
  11155111: "Sepolia",
  1: "Ethereum",
};

/** `0x1f6f…0542`, which is the shortest form that still distinguishes two accounts. */
function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function ConnectWallet({ className }: { readonly className?: string }) {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  /*
    Nothing is drawn until the browser has been inspected. Rendering "connect"
    and then swapping it for an account a frame later is a flicker on every page
    load for anyone who has connected once, and the masthead is the worst place
    on the page for one.
  */
  if (!wallet.ready) {
    return <span className={cn("h-[30px] w-[104px]", className)} aria-hidden="true" />;
  }

  if (wallet.account === undefined) {
    return (
      <div ref={box} className={cn("relative", className)}>
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          disabled={wallet.connecting}
          aria-expanded={open}
          aria-haspopup="menu"
          className={cn(
            "rounded-md border border-border/60 bg-muted/30 px-3 py-1.5 font-mono text-xs tracking-wide uppercase",
            "text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
            "disabled:cursor-not-allowed disabled:opacity-60",
            FOCUS_RING,
          )}
        >
          {wallet.connecting ? "Connecting" : "Connect"}
        </button>

        {/*
          A menu even when there is one wallet, and especially when there are
          none. Pressing Connect used to call straight through and, with nothing
          installed, recorded a failure the control had no way to show - so the
          button appeared to do nothing at all. Whatever the answer is, it is
          now drawn here.
        */}
        {open ? (
          <div
            role="menu"
            className="absolute end-0 top-[calc(100%+6px)] z-50 w-80 rounded-lg border border-border/70 bg-[var(--panel)] p-3 shadow-lg"
          >
            <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
              {wallet.wallets.length > 0 ? "Installed" : "Choose a wallet"}
            </p>

            {/*
              Four at a time. A menu that lists every announced wallet grows past
              the fold on a machine with several installed, and the fifth onwards
              are one press away rather than absent.
            */}
            {wallet.wallets.length > 0 ? (
              <>
                <ul className="mt-2 flex flex-col gap-1">
                  {(more ? wallet.wallets : wallet.wallets.slice(0, 4)).map((entry) => (
                    <li key={entry.uuid}>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          void wallet.connect(entry.uuid).then((result) => {
                            if (result.ok) setOpen(false);
                          });
                        }}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-2 py-2 text-start transition-colors",
                          "hover:bg-foreground/[0.05]",
                          FOCUS_RING,
                        )}
                      >
                        <Mark src={entry.icon ?? knownMark(entry.name)} name={entry.name} />
                        <span className="font-mono text-xs text-foreground">{entry.name}</span>
                        <span className="ms-auto font-mono text-[10px] tracking-wider text-teal-700 uppercase dark:text-teal-400">
                          Detected
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {wallet.wallets.length > 4 ? (
                  <button
                    type="button"
                    onClick={() => setMore((current) => !current)}
                    className={cn(
                      "mt-1 w-full rounded-md px-2 py-1.5 text-start font-mono text-[11px] text-muted-foreground",
                      "transition-colors hover:bg-foreground/[0.04] hover:text-foreground",
                      FOCUS_RING,
                    )}
                  >
                    {more ? "Show fewer" : `Other wallets (${wallet.wallets.length - 4})`}
                  </button>
                ) : null}
              </>
            ) : null}

            {/*
              What would work, for a reader who has none. Listed after anything
              detected, never instead of it, and each one links out rather than
              pretending it can be connected from here.
            */}
            {wallet.wallets.length === 0 ? (
              <>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  No browser wallet answered. Any of these can hold Creditcoin CC3, which Tab signs
                  on. Every read on this site works without one.
                </p>
                <ul className="mt-2 flex flex-col gap-1">
                  {SUGGESTED.map((entry) => (
                    <li key={entry.name}>
                      <a
                        href={entry.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-2 py-2 no-underline transition-colors",
                          "hover:bg-foreground/[0.05]",
                          FOCUS_RING,
                        )}
                      >
                        <Mark src={entry.icon} name={entry.name} />
                        <span className="font-mono text-xs text-foreground">{entry.name}</span>
                        {entry.caveat === undefined ? null : (
                          <span className="ms-auto font-mono text-[10px] tracking-wider text-muted-foreground">
                            {entry.caveat}
                          </span>
                        )}
                        <ExternalLink
                          aria-hidden="true"
                          className={cn(
                            "size-3 text-muted-foreground",
                            entry.caveat === undefined && "ms-auto",
                          )}
                        />
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {wallet.error === undefined ? null : (
              <p className="mt-3 rounded-md border border-clearing-declined/30 bg-clearing-declined/5 px-2 py-1.5 text-[11px] leading-relaxed text-clearing-declined">
                {wallet.error}
              </p>
            )}

            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Signing on Creditcoin costs CTC for gas. Nothing here reads through your wallet.
            </p>
          </div>
        ) : null}
      </div>
    );
  }

  const chainName = wallet.chainId === undefined ? undefined : KNOWN[wallet.chainId];

  return (
    <div ref={box} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-xs tracking-wide uppercase",
          "border-teal-700/25 bg-teal-500/10 text-teal-700 dark:border-teal-400/20 dark:bg-teal-800/40 dark:text-teal-200",
          FOCUS_RING,
        )}
      >
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-teal-600 dark:bg-teal-400"
        />
        {short(wallet.account)}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute end-0 top-[calc(100%+6px)] z-50 w-64 rounded-lg border border-border/70 bg-[var(--panel)] p-3 shadow-lg"
        >
          <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
            Connected account
          </p>
          <p className="mt-1 font-mono text-xs break-all text-foreground">{wallet.account}</p>

          <p className="mt-3 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
            Wallet
          </p>
          <p className="mt-1 font-mono text-xs text-foreground">{wallet.walletName ?? "unknown"}</p>

          <p className="mt-3 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
            Network
          </p>
          <p className="mt-1 font-mono text-xs text-foreground">
            {chainName ?? (wallet.chainId === undefined ? "unknown" : `chain ${wallet.chainId}`)}
          </p>

          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Nothing on this site reads through your wallet. It signs, and only when you press
            something that says it will.
          </p>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              wallet.disconnect();
              setOpen(false);
            }}
            className={cn(
              "mt-3 w-full rounded-md border border-border/60 px-3 py-1.5 font-mono text-xs tracking-wide uppercase",
              "text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground",
              FOCUS_RING,
            )}
          >
            Forget this account
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A wallet's mark.
 *
 * An announced icon is a data URI the wallet supplied; a suggested one is a file
 * in this repository. Either way it is drawn on a light ground, because several
 * of these are dark monochrome marks that vanish on a dark page - which is why
 * one of them appeared to have no logo at all.
 */
function Mark({ src, name }: { readonly src: string | undefined; readonly name: string }) {
  if (src === undefined) {
    return (
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background font-mono text-[10px] text-muted-foreground"
      >
        {name.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={24}
      height={24}
      className="size-6 shrink-0 rounded-md bg-white/95 p-0.5"
    />
  );
}
