"use client";

/**
 * The passkey half of the Connect menu.
 *
 * Two pieces. `PasskeyOptions` sits in the menu before anything is connected
 * and offers the two ceremonies: make a passkey, or use one this host already
 * has. `PasskeyAccountPanel` replaces the wallet facts once a passkey is
 * signed in: which key is active, its MON, where to get more, and the two ways
 * out. Both are quiet, in the same mono voice as the rest of the masthead,
 * because a passkey account is a way to sign, not a feature to sell.
 *
 * Nothing here opens a prompt on render. Every ceremony follows a press.
 */

import Link from "next/link";
import { useState } from "react";

import { formatMon } from "../passkey/chain";
import { SUPPORTED_AUTHENTICATORS } from "../passkey/support";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useWallet } from "./wallet-context";

const LABEL_CLASSES = "font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase";

/** Create or use a passkey. Rendered in the menu while nothing is connected. */
export function PasskeyOptions({ onConnected }: { readonly onConnected: () => void }) {
  const { passkey } = useWallet();
  const [label, setLabel] = useState("Tab agent");
  // The ceremony's own refusal, held here: `connect` writes the shared error
  // slot, but these two presses do not go through it, and a prompt that came
  // back with nothing to show for it would look like a button that did nothing.
  const [failure, setFailure] = useState<string | undefined>(undefined);

  if (!passkey.supported) {
    return (
      <div className="mt-3 border-t border-border/60 pt-3">
        <p className={LABEL_CLASSES}>Passkey</p>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          This browser has no WebAuthn, so a passkey account cannot be made or used here. One
          that can: {SUPPORTED_AUTHENTICATORS.map((entry) => entry.authenticator).join(", ")}.
        </p>
      </div>
    );
  }

  const run = (ceremony: () => Promise<{ ok: true } | { ok: false; message: string }>): void => {
    setFailure(undefined);
    void ceremony().then((result) => {
      if (result.ok) onConnected();
      else setFailure(result.message);
    });
  };

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <p className={LABEL_CLASSES}>Passkey</p>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        An account derived from a passkey: no seed phrase, no extension, no custodian. The keys
        come back from one touch on the authenticator, on any device it syncs to.
      </p>

      {passkey.remembered === undefined ? null : (
        <p className="mt-2 font-mono text-[11px] text-foreground">
          Remembered here: {passkey.remembered.label}
        </p>
      )}

      <div className="mt-2 flex flex-col gap-2">
        <Button
          type="button"
          variant="ghostCustom"
          size="sm"
          disabled={passkey.busy}
          onClick={() => run(passkey.signIn)}
          className="w-full justify-start"
        >
          {passkey.remembered === undefined ? "Use an existing passkey" : "Use your passkey"}
        </Button>

        <label className="flex flex-col gap-1">
          <span className={LABEL_CLASSES}>Name for a new passkey</span>
          <Input
            variant="mono"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            className="h-8 text-xs md:text-xs"
          />
        </label>
        <Button
          type="button"
          variant="ghostCustomSecondary"
          size="sm"
          disabled={passkey.busy}
          onClick={() => run(() => passkey.create(label))}
          className="w-full justify-start"
        >
          {passkey.busy ? "Waiting for the authenticator" : "Create a passkey account"}
        </Button>
      </div>

      {failure === undefined ? null : (
        <p role="alert" className="mt-3 rounded-md border border-status-danger/30 bg-status-danger/5 px-2 py-1.5 text-[11px] leading-relaxed text-status-danger">
          {failure}
        </p>
      )}
    </div>
  );
}

/** The signed-in passkey account, in place of the wallet facts. */
export function PasskeyAccountPanel({ onDone }: { readonly onDone: () => void }) {
  const wallet = useWallet();
  const { passkey } = wallet;
  const active = passkey.active;

  return (
    <>
      <p className={LABEL_CLASSES}>Passkey account</p>
      <p className="mt-1 font-mono text-xs text-foreground">
        {active?.label ?? "No key"}
        {passkey.remembered === undefined ? "" : ` · ${passkey.remembered.label}`}
      </p>

      <p className={`mt-3 ${LABEL_CLASSES}`}>Signing as</p>
      <p className="mt-1 font-mono text-xs break-all text-foreground">{active?.address ?? "no key selected"}</p>

      <p className={`mt-3 ${LABEL_CLASSES}`}>Network</p>
      <p className="mt-1 font-mono text-xs text-foreground">
        {passkey.chain.name} (chain {passkey.chain.id})
      </p>

      <p className={`mt-3 ${LABEL_CLASSES}`}>MON for gas</p>
      <BalanceLine />

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        Keys live in this page and are zeroed when it closes. One touch brings them back.{" "}
        <Link href="/keys" onClick={onDone} className="text-foreground underline decoration-dotted underline-offset-2">
          Manage keys
        </Link>
      </p>

      <div className="mt-3 flex flex-col gap-2">
        <Button
          type="button"
          variant="ghostCustomSecondary"
          size="sm"
          className="w-full justify-start"
          onClick={() => {
            wallet.disconnect();
            onDone();
          }}
        >
          End the session
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start font-mono text-[11px] tracking-wider text-muted-foreground uppercase"
          onClick={() => {
            passkey.forget();
            onDone();
          }}
        >
          Forget this passkey on this device
        </Button>
      </div>
    </>
  );
}

/**
 * The active key's MON, as a fact or as the reason there is none.
 *
 * Before the read returns it says so in words; it never draws a spinner in the
 * place a figure will go, because a spinner is a claim that a figure exists.
 */
export function BalanceLine({ className }: { readonly className?: string }) {
  const { passkey } = useWallet();
  const balance = passkey.balance;
  const faucet = passkey.faucetUrl;

  if (balance === undefined) {
    return <p className={`mt-1 font-mono text-xs text-muted-foreground ${className ?? ""}`}>Not read yet.</p>;
  }
  if (balance.kind === "failed") {
    return <p className={`mt-1 text-[11px] leading-relaxed text-muted-foreground ${className ?? ""}`}>{balance.message}</p>;
  }
  return (
    <div className={className}>
      <p className="mt-1 font-mono text-xs text-foreground tabular-nums">{formatMon(balance.wei)}</p>
      {faucet === undefined ? null : (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {balance.wei === 0n ? "Nothing to pay gas with yet. " : "Testnet MON is free: "}
          <a
            href={faucet}
            target="_blank"
            rel="noreferrer noopener"
            className="text-foreground underline decoration-dotted underline-offset-2"
          >
            faucet.monad.xyz
          </a>
        </p>
      )}
    </div>
  );
}
