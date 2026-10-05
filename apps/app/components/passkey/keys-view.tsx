"use client";

/**
 * `KeysView` - the owner key, the session keys, and the actions on them.
 * The client island behind `/keys`; it lives here rather than beside the route
 * so the test project, which spans `components/`, can render it.
 *
 * ## The key model, stated once here and enforced in `components/passkey`
 *
 * In Tab the Agent is whoever signs: `TabBook.authorise` records `msg.sender`
 * and `TabSettlement.settle` moves the Asset from `msg.sender`. There is no
 * acting on another account's behalf. So a **session key is the Agent for one
 * runtime**: it signs its own `authorise`, it settles its own tab, and its
 * credit history is its own. The **owner key is the recovery root**: it can
 * always re-derive every session key from the passkey, it signs from this
 * Dashboard when nothing else is chosen, and it is never revealed.
 *
 * ## What a reveal is
 *
 * A session key is shown once, on a press that follows a warning, so it can be
 * pasted into a runtime's `AGENT_PRIVATE_KEY`. The page records that it was
 * shown and nothing else. Index 0 cannot be revealed: `revealPrivateKey`
 * refuses it, and this view never offers it.
 *
 * ## Every state renders
 *
 * With no wallet and no passkey the page is an explanation and two buttons.
 * With an injected wallet it says that wallet's keys are not this page's to
 * manage. No state draws a spinner where a fact will go.
 *
 * ## The agent book
 *
 * Under the keys sits the agent book (`agent-book-view.tsx`): the owner's
 * notes on each Agent, sealed by the same passkey under a PRF namespace of its
 * own. While it is open, each session key row shows the name it was given.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { CopyButton } from "../custom-ui/copy-button";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../ui/cn";
import { MON, MONAD_CHAINS } from "../wallet/eip1193";
import { BalanceLine } from "../wallet/passkey-controls";
import { useWallet } from "../wallet/wallet-context";
import { type AgentBook, entryFor } from "./agent-book";
import { AgentBookView } from "./agent-book-view";
import { DERIVATION_ROOT } from "./derivation";
import { SUPPORTED_AUTHENTICATORS, UNSUPPORTED_AUTHENTICATORS } from "./support";
import type { KeyView } from "./use-passkey";
import { explorerAddressUrl } from "../../src/dashboard/network";

export interface KeysViewProps {
  readonly chainId: number;
  readonly chainName: string;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
}

const EYEBROW = "font-mono text-[11px] tracking-wider text-muted-foreground uppercase";

export function KeysView({ chainId, chainName, rpcUrl, explorerUrl }: KeysViewProps) {
  const wallet = useWallet();
  const { passkey } = wallet;
  const [note, setNote] = useState<string | undefined>(undefined);
  // The open agent book. Plaintext, so it is dropped the moment the passkey session ends.
  const [book, setBook] = useState<AgentBook | undefined>(undefined);
  useEffect(() => {
    if (!passkey.signedIn) setBook(undefined);
  }, [passkey.signedIn]);

  /*
    The deployment's chain and endpoint, handed to the passkey account the way
    the signing pages hand them over. For a passkey this is a state update and
    never a prompt, so it is safe to do on arrival; an injected wallet is left
    alone, because for it the same call would open a switch dialog.
  */
  const { kind, ensureChain } = wallet;
  useEffect(() => {
    if (kind !== "passkey") return;
    void ensureChain({
      ...(MONAD_CHAINS[chainId] ?? { id: chainId, name: chainName, currency: MON }),
      rpcUrl,
      explorerUrl,
    });
  }, [kind, ensureChain, chainId, chainName, rpcUrl, explorerUrl]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-10">
      <div className="flex min-w-0 flex-col gap-5">
        {passkey.signedIn && passkey.owner !== undefined ? (
          <>
            <OwnerCard owner={passkey.owner} active={passkey.active} explorerUrl={explorerUrl} />
            <SessionKeys
              keys={passkey.sessionKeys}
              active={passkey.active}
              explorerUrl={explorerUrl}
              onDerive={() => {
                const derived = passkey.deriveNext();
                setNote(derived.ok ? undefined : derived.message);
              }}
              onSelect={(index) => {
                const chosen = passkey.select(index);
                setNote(chosen.ok ? undefined : chosen.message);
              }}
              reveal={(index) => passkey.reveal(index)}
              book={book}
            />
            <AgentBookView sessionKeys={passkey.sessionKeys} book={book} onBook={setBook} />
          </>
        ) : (
          <Empty onNote={setNote} />
        )}

        {note === undefined ? null : (
          <p role="alert" className="rounded-md border border-status-danger/30 bg-status-danger/5 px-3 py-2 text-sm text-status-danger">
            {note}
          </p>
        )}
      </div>

      <aside className="flex min-w-0 flex-col gap-5">
        <Model />
        <Runtime />
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------ empty state */

function Empty({ onNote }: { readonly onNote: (message: string | undefined) => void }) {
  const wallet = useWallet();
  const { passkey } = wallet;
  const [label, setLabel] = useState("Tab agent");

  const run = (ceremony: () => Promise<{ ok: boolean; message?: string }>): void => {
    onNote(undefined);
    void ceremony().then((result) => {
      if (!result.ok) onNote(result.message);
    });
  };

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-dashed border-border/60 bg-muted/30 p-5 sm:p-6">
      <h2 className="font-host text-base font-semibold text-foreground sm:text-lg">
        No passkey account is signed in
      </h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        This page lists the keys derived from a passkey. There are none to list until a passkey
        is signed in, which takes one touch on the authenticator and stores nothing but which
        passkey to ask for.
      </p>

      {wallet.kind === "injected" ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          You are connected with {wallet.walletName ?? "a browser wallet"}. Its keys live in that
          wallet and are not this page&apos;s to manage. Creating or using a passkey here replaces
          that connection for signing.
        </p>
      ) : null}

      {passkey.supported ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="customTallPrimary"
              size="tall"
              disabled={passkey.busy}
              onClick={() => run(passkey.signIn)}
            >
              {passkey.remembered === undefined ? "Use an existing passkey" : "Use your passkey"}
            </Button>
            {passkey.remembered === undefined ? null : (
              <span className="font-mono text-xs text-muted-foreground">
                Remembered here: {passkey.remembered.label}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className={EYEBROW}>Name for a new passkey</span>
              <Input
                variant="mono"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
              />
            </label>
            <Button
              type="button"
              variant="customTallSecondary"
              size="tall"
              disabled={passkey.busy}
              onClick={() => run(() => passkey.create(label))}
            >
              {passkey.busy ? "Waiting for the authenticator" : "Create a passkey account"}
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Both open the authenticator once. The passkey is made under this host and works only
            here; a passkey made on another host derives different keys.
          </p>
        </div>
      ) : (
        <Unsupported />
      )}
    </section>
  );
}

function Unsupported() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed text-foreground">
        This browser has no WebAuthn, so a passkey account cannot be made or used here.
      </p>
      <p className={EYEBROW}>Authenticators with a confirmed PRF cycle</p>
      <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
        {SUPPORTED_AUTHENTICATORS.map((entry) => (
          <li key={entry.authenticator}>
            <span className="font-mono text-foreground">{entry.authenticator}</span>: {entry.where}
          </li>
        ))}
      </ul>
      <p className={EYEBROW}>Known not to return a PRF</p>
      <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
        {UNSUPPORTED_AUTHENTICATORS.map((entry) => (
          <li key={entry.authenticator}>
            <span className="font-mono text-foreground">{entry.authenticator}</span>: {entry.where}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- the keys */

function OwnerCard({
  owner,
  active,
  explorerUrl,
}: {
  readonly owner: KeyView;
  readonly active: KeyView | undefined;
  readonly explorerUrl: string;
}) {
  const wallet = useWallet();
  const isActive = active?.index === owner.index;
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border/60 bg-muted/30 p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-host text-base font-semibold text-foreground sm:text-lg">{owner.label}</h2>
        <Badge tone="neutral">{owner.path}</Badge>
        {isActive ? <Badge tone="accent">Signing</Badge> : null}
        <Badge tone="muted">Never revealed</Badge>
      </div>
      <AddressLine address={owner.address} explorerUrl={explorerUrl} />
      <p className="text-xs leading-relaxed text-muted-foreground">
        The root the passkey stands behind. It re-derives every session key, so a runtime that
        loses its key has not lost the account, and it signs from this Dashboard when no session
        key is chosen. It has no export.
      </p>
      {isActive ? (
        <div>
          <p className={EYEBROW}>MON for gas</p>
          <BalanceLine />
        </div>
      ) : (
        <div>
          <Button type="button" variant="ghostCustomSecondary" size="sm" onClick={() => void wallet.passkey.select(owner.index)}>
            Sign as the owner
          </Button>
        </div>
      )}
    </section>
  );
}

function SessionKeys({
  keys,
  active,
  explorerUrl,
  onDerive,
  onSelect,
  reveal,
  book,
}: {
  readonly keys: readonly KeyView[];
  readonly active: KeyView | undefined;
  readonly explorerUrl: string;
  readonly onDerive: () => void;
  readonly onSelect: (index: number) => void;
  readonly reveal: (index: number) => { ok: true; value: string } | { ok: false; message: string };
  readonly book: AgentBook | undefined;
}) {
  // Index 0 is the owner and is never a session key. The list arrives that way
  // from the connection; the filter is a second guard the copy above depends on.
  const sessions = keys.filter((key) => key.role === "session" && key.index >= 1);

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border/60 bg-muted/30 p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-host text-base font-semibold text-foreground sm:text-lg">Session keys</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            One per runtime, at <code className="font-mono">{DERIVATION_ROOT}/n</code> for n from 1. Each is the Agent
            for the runtime that holds it.
          </p>
        </div>
        <Button type="button" variant="ghostCustom" size="sm" onClick={onDerive}>
          Derive session key {sessions.length + 1}
        </Button>
      </div>

      {sessions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
          No session key has been derived yet. The first one is at{" "}
          <code className="font-mono">{DERIVATION_ROOT}/1</code>, and it is the same key every time
          this passkey derives it.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {sessions.map((key) => (
            <SessionKeyRow
              key={key.index}
              view={key}
              name={entryFor(book, key.address)?.name}
              isActive={active?.index === key.index}
              explorerUrl={explorerUrl}
              onSelect={() => onSelect(key.index)}
              reveal={() => reveal(key.index)}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function SessionKeyRow({
  view,
  name,
  isActive,
  explorerUrl,
  onSelect,
  reveal,
}: {
  readonly view: KeyView;
  /** The Agent's name from the open agent book, if it has one. */
  readonly name: string | undefined;
  readonly isActive: boolean;
  readonly explorerUrl: string;
  readonly onSelect: () => void;
  readonly reveal: () => { ok: true; value: string } | { ok: false; message: string };
}) {
  type Stage =
    | { readonly kind: "closed" }
    | { readonly kind: "warned" }
    | { readonly kind: "shown"; readonly hex: string }
    | { readonly kind: "refused"; readonly message: string };
  const [stage, setStage] = useState<Stage>({ kind: "closed" });

  return (
    <li className={cn("flex flex-col gap-3 rounded-lg border bg-[var(--panel)] p-4", isActive ? "border-teal-700/25 dark:border-teal-400/20" : "border-border/60")}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono text-sm font-semibold text-foreground">{view.label}</h3>
        {name === undefined || name === "" ? null : <span className="text-sm text-foreground">{name}</span>}
        <Badge tone="neutral">{view.path}</Badge>
        {isActive ? <Badge tone="accent">Signing</Badge> : null}
        {view.revealed ? <Badge tone="notice">Revealed</Badge> : <Badge tone="muted">Not revealed</Badge>}
      </div>
      <AddressLine address={view.address} explorerUrl={explorerUrl} />
      {isActive ? (
        <div>
          <p className={EYEBROW}>MON for gas</p>
          <BalanceLine />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {isActive ? null : (
          <Button type="button" variant="ghostCustomSecondary" size="sm" onClick={onSelect}>
            Sign as this key
          </Button>
        )}
        {/*
          A client-side hop, on purpose. The session lives in this page's
          memory, and a full navigation would end it; `next/link` keeps the
          provider mounted, so `/authorise` sees this key as the connected
          account and it signs its own authorisation.
        */}
        <Button asChild variant="ghostCustom" size="sm">
          <Link href="/authorise" onClick={onSelect}>
            Authorise a Service as this key
          </Link>
        </Button>
        {stage.kind === "closed" || stage.kind === "refused" ? (
          <Button type="button" variant="ghost" size="sm" className="font-mono text-[12px] tracking-wider uppercase" onClick={() => setStage({ kind: "warned" })}>
            {view.revealed ? "Reveal the private key again" : "Reveal the private key"}
          </Button>
        ) : null}
      </div>

      {stage.kind === "warned" ? (
        <div className="flex flex-col gap-3 rounded-md border border-status-danger/30 bg-status-danger/5 p-3">
          <p className="text-sm leading-relaxed text-status-danger">
            Anyone holding this key can authorise Services and settle as this Agent. Paste it into
            the runtime&apos;s <code className="font-mono">AGENT_PRIVATE_KEY</code> and nowhere else. This page keeps no copy and
            records only that it was shown.
            {view.revealed ? " It has been shown before, so a runtime may already hold it." : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => {
                const result = reveal();
                setStage(result.ok ? { kind: "shown", hex: result.value } : { kind: "refused", message: result.message });
              }}
            >
              Show it once
            </Button>
            <Button type="button" variant="ghostCustomSecondary" size="sm" onClick={() => setStage({ kind: "closed" })}>
              Keep it hidden
            </Button>
          </div>
        </div>
      ) : null}

      {stage.kind === "shown" ? (
        <div className="flex flex-col gap-2 rounded-md border border-status-notice/40 bg-background/60 p-3">
          <p className={EYEBROW}>AGENT_PRIVATE_KEY for {view.label.toLowerCase()}</p>
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 font-mono text-[12px] break-all text-foreground">{stage.hex}</p>
            <CopyButton text={stage.hex} label={`the private key of ${view.label.toLowerCase()}`} />
          </div>
          <div>
            <Button type="button" variant="ghostCustomSecondary" size="sm" onClick={() => setStage({ kind: "closed" })}>
              Hide it
            </Button>
          </div>
        </div>
      ) : null}

      {stage.kind === "refused" ? (
        <p role="alert" className="text-sm text-status-danger">{stage.message}</p>
      ) : null}
    </li>
  );
}

function AddressLine({ address, explorerUrl }: { readonly address: string; readonly explorerUrl: string }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className={EYEBROW}>Address</p>
        <a
          href={explorerAddressUrl(address, explorerUrl)}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-1 block font-mono text-xs break-all text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-teal-600 dark:hover:decoration-teal-400"
        >
          {address}
        </a>
      </div>
      <CopyButton text={address} label="the address" />
    </div>
  );
}

/* ------------------------------------------------------------------- copy */

function Model() {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/30 p-5 sm:p-6">
      <h2 className="font-host text-base font-semibold text-foreground sm:text-lg">Which key is the Agent</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        In Tab the Agent is whoever signs. <code className="font-mono">authorise</code> records the sender as the
        Agent, and a Settlement moves the Asset from the sender, so the account that signs is
        the tab. There is no signing on another account&apos;s behalf.
      </p>
      <p className="text-sm leading-relaxed text-muted-foreground">
        So a <span className="text-foreground">session key is the Agent for one runtime</span>: it
        signs its own authorisation, settles its own tab, and its credit history is its own. The{" "}
        <span className="text-foreground">owner key is the recovery root</span>: it re-derives every
        session key from the same passkey, it signs from this Dashboard when nothing else is
        chosen, and it is never revealed.
      </p>
      <h2 className="mt-2 font-host text-base font-semibold text-foreground sm:text-lg">
        Why there is no seed phrase and no custodian
      </h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Every key is a function of the passkey&apos;s PRF output: 32 bytes the authenticator
        returns for this host, the same bytes on every device the passkey syncs to. The
        authenticator holds the passkey. This page holds the derived keys for as long as it is
        open, then zeroes them. Nobody holds them for you, and there is no phrase to write down
        because the passkey is the backup.
      </p>
      <p className="text-sm leading-relaxed text-muted-foreground">
        The other side of that: lose the passkey and the keys are gone with it, and a passkey
        works only under the host it was made for. Reveal a session key to its runtime while the
        passkey works. The derivation follows the Mera recipe published at mera.category.xyz, so
        it can be reproduced outside this page.
      </p>
      <h2 className="mt-2 font-host text-base font-semibold text-foreground sm:text-lg">
        One passkey, a second job
      </h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        The keys come from the passkey&apos;s PRF at Mera&apos;s fixed account salt. The agent book
        asks the same passkey for its PRF at a different salt, a fresh random one on every seal,
        and turns that output into an AES-256-GCM key that encrypts the book. That key never
        signs, never becomes an address, and exists only during the touch that seals or opens
        the book.
      </p>
    </section>
  );
}

function Runtime() {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/30 p-5 sm:p-6">
      <h2 className="font-host text-base font-semibold text-foreground sm:text-lg">Giving a runtime a key</h2>
      <ol className="flex list-decimal flex-col gap-2 ps-5 text-sm leading-relaxed text-muted-foreground">
        <li>Derive the next session key. Its address is fixed by the passkey and the index.</li>
        <li>
          Fund that address with MON for gas. On Testnet the faucet is free; the balance shown
          beside the signing key is read from the chain.
        </li>
        <li>
          Authorise a Service as that key. The key signs its own authorisation from this page,
          so the runtime never has to.
        </li>
        <li>
          Reveal the key once and paste it into the runtime&apos;s{" "}
          <code className="font-mono">AGENT_PRIVATE_KEY</code>. From then on the runtime calls and
          settles as that Agent, and its tab is its own.
        </li>
      </ol>
    </section>
  );
}
