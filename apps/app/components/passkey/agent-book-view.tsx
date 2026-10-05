"use client";

/**
 * `AgentBookView` - the owner's private notes on each Agent, sealed by the passkey.
 *
 * Rendered on `/keys` under the session keys while a passkey is signed in.
 * `agent-book.ts` says what the book is and why sealing it is the passkey
 * doing something other than signing for an account.
 *
 * ## States, and what each costs
 *
 * Nothing sealed here yet: starting a book opens an empty one in memory, no
 * prompt. Sealed: opening it is one prompt. Open: editing is free, and
 * "Seal and save" is one prompt that draws a fresh namespace. "Lock" drops the
 * plaintext from memory without a prompt. Export and import move the sealed
 * file and never prompt, because neither reads what is inside.
 *
 * The plaintext lives only in this component's state while the book is open.
 * What this browser keeps is the sealed envelope, and the page shows it, so
 * the claim that nothing readable is stored can be checked by looking.
 */

import { useEffect, useRef, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../ui/cn";
import { FOCUS_RING } from "../ui/focus-ring";
import { useWallet } from "../wallet/wallet-context";
import {
  AGENT_BOOK_FILE_NAME,
  AGENT_BOOK_LIMITS,
  type AgentBook,
  type SealedAgentBook,
  emptyAgentBook,
  entryFor,
  namespaceFingerprint,
  parseSealedAgentBook,
  readSealedAgentBook,
  serialiseSealedAgentBook,
  withEntry,
  writeSealedAgentBook,
} from "./agent-book";
import { openAgentBook, sealAgentBook } from "./agent-book-ceremony";
import { relyingPartyId } from "./ceremony";
import { browserStorage } from "./storage";
import type { KeyView } from "./use-passkey";

const EYEBROW = "font-mono text-[11px] tracking-wider text-muted-foreground uppercase";
const FIELD = "flex min-w-0 flex-col gap-1.5";

export interface AgentBookViewProps {
  readonly sessionKeys: readonly KeyView[];
  /** The open book, lifted so the session key rows can show each Agent's name. */
  readonly book: AgentBook | undefined;
  readonly onBook: (book: AgentBook | undefined) => void;
}

type Notice = { readonly tone: "danger" | "settled"; readonly text: string };

export function AgentBookView({ sessionKeys, book, onBook }: AgentBookViewProps) {
  const { passkey } = useWallet();
  const credential = passkey.remembered?.credential;
  const [sealed, setSealed] = useState<SealedAgentBook | undefined>(undefined);
  const [draft, setDraft] = useState<AgentBook | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);

  // What this browser holds, read once on arrival. No prompt.
  useEffect(() => {
    const storage = browserStorage();
    if (storage !== undefined) setSealed(readSealedAgentBook(storage));
  }, []);

  // The draft follows the open book: opening loads it, locking clears it.
  useEffect(() => setDraft(book), [book]);

  const sealedByOther =
    sealed !== undefined && credential !== undefined && sealed.vault.credential.credentialId !== credential.credentialId;
  const dirty = draft !== undefined && book !== undefined && JSON.stringify(draft.entries) !== JSON.stringify(book.entries);
  const sessions = sessionKeys.filter((key) => key.role === "session" && key.index >= 1);

  const open = async (): Promise<void> => {
    const rpId = relyingPartyId();
    if (sealed === undefined || rpId === undefined) return;
    setNotice(undefined);
    setBusy(true);
    try {
      const opened = await openAgentBook({ rpId, sealed });
      if (opened.ok) onBook(opened.value);
      else setNotice({ tone: "danger", text: opened.message });
    } finally {
      setBusy(false);
    }
  };

  const seal = async (): Promise<void> => {
    const rpId = relyingPartyId();
    if (draft === undefined || credential === undefined || rpId === undefined) return;
    setNotice(undefined);
    setBusy(true);
    try {
      const result = await sealAgentBook({ rpId, credential, book: draft });
      if (!result.ok) {
        setNotice({ tone: "danger", text: result.message });
        return;
      }
      const storage = browserStorage();
      if (storage !== undefined) writeSealedAgentBook(storage, result.value);
      setSealed(result.value);
      onBook({ ...draft, updatedAt: result.value.sealedAt });
      setNotice({
        tone: "settled",
        text: `Sealed under a new PRF namespace, ${namespaceFingerprint(result.value.vault.prfSalt)}… This browser now holds only the sealed copy below.`,
      });
    } finally {
      setBusy(false);
    }
  };

  const exportFile = (): void => {
    if (sealed === undefined) return;
    const blob = new Blob([serialiseSealedAgentBook(sealed)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = AGENT_BOOK_FILE_NAME;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const importFile = async (file: File): Promise<void> => {
    setNotice(undefined);
    const text = await file.text().catch(() => "");
    const imported = parseSealedAgentBook(text);
    if (imported === undefined) {
      setNotice({ tone: "danger", text: "That file is not a sealed agent book. Nothing was imported." });
      return;
    }
    const storage = browserStorage();
    if (storage !== undefined) writeSealedAgentBook(storage, imported);
    setSealed(imported);
    onBook(undefined);
    setNotice({ tone: "settled", text: "Imported. It stays sealed until the passkey that sealed it opens it." });
  };

  const status = book !== undefined ? "Open" : sealed !== undefined ? "Sealed" : "Not started";

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border/60 bg-muted/30 p-5 sm:p-6" aria-labelledby="agent-book-title">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="agent-book-title" className="font-host text-base font-semibold text-foreground sm:text-lg">
            Agent book
          </h2>
          <Badge tone={book !== undefined ? "notice" : sealed !== undefined ? "settled" : "muted"}>{status}</Badge>
          <Badge tone="neutral">Signs nothing</Badge>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          What each Agent is, where it runs and what it is for, in your words. The same passkey seals
          it under a PRF namespace of its own, drawn fresh on every seal and unrelated to the one
          your keys come from. No key signs it and no server stores it.
        </p>
      </div>

      {book === undefined ? (
        <Closed
          sealed={sealed}
          sealedByOther={sealedByOther}
          busy={busy}
          onOpen={() => void open()}
          onStart={() => onBook(emptyAgentBook())}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {sessions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
              Derive a session key above, then describe the Agent it is.
            </p>
          ) : (
            <ol className="flex flex-col gap-3">
              {sessions.map((key) => (
                <EntryEditor
                  key={key.address}
                  view={key}
                  book={draft ?? book}
                  onChange={(entry) => setDraft((current) => withEntry(current ?? book, { address: key.address, ...entry }))}
                />
              ))}
            </ol>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghostCustom" size="sm" disabled={busy || credential === undefined} onClick={() => void seal()}>
              {busy ? "Waiting for the authenticator" : "Seal and save"}
            </Button>
            <Button type="button" variant="ghostCustomSecondary" size="sm" disabled={busy} onClick={() => onBook(undefined)}>
              {dirty ? "Lock without saving" : "Lock"}
            </Button>
            {dirty ? <span className="font-mono text-xs text-muted-foreground">Unsaved changes</span> : null}
          </div>
        </div>
      )}

      {notice === undefined ? null : (
        <p
          role={notice.tone === "danger" ? "alert" : "status"}
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            notice.tone === "danger"
              ? "border-status-danger/30 bg-status-danger/5 text-status-danger"
              : "border-border/60 bg-background/60 text-foreground",
          )}
        >
          {notice.text}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
        <Button type="button" variant="ghostCustomSecondary" size="sm" disabled={sealed === undefined} onClick={exportFile}>
          Export the sealed file
        </Button>
        <Button type="button" variant="ghostCustomSecondary" size="sm" onClick={() => fileInput.current?.click()}>
          Import a sealed file
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file !== undefined) void importFile(file);
          }}
        />
      </div>

      {sealed === undefined ? null : <Stored sealed={sealed} />}
    </section>
  );
}

function Closed({
  sealed,
  sealedByOther,
  busy,
  onOpen,
  onStart,
}: {
  readonly sealed: SealedAgentBook | undefined;
  readonly sealedByOther: boolean;
  readonly busy: boolean;
  readonly onOpen: () => void;
  readonly onStart: () => void;
}) {
  if (sealed === undefined) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Nothing is sealed in this browser yet. Start a book, name your Agents, then seal it with
          one touch. On another device, import the sealed file and the same passkey opens it.
        </p>
        <div>
          <Button type="button" variant="ghostCustom" size="sm" onClick={onStart}>
            Start the agent book
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Sealed {formatSealedAt(sealed.sealedAt)} under namespace{" "}
        <code className="font-mono text-foreground">{namespaceFingerprint(sealed.vault.prfSalt)}…</code>. Opening it
        asks the passkey once for that namespace and decrypts it on this page.
      </p>
      {sealedByOther ? (
        <p className="rounded-md border border-status-notice/40 bg-background/60 px-3 py-2 text-sm text-foreground">
          This book was sealed by a different passkey from the one signed in. Opening it will ask for that passkey.
        </p>
      ) : null}
      <div>
        <Button type="button" variant="ghostCustom" size="sm" disabled={busy} onClick={onOpen}>
          {busy ? "Waiting for the authenticator" : "Open with your passkey"}
        </Button>
      </div>
    </div>
  );
}

function EntryEditor({
  view,
  book,
  onChange,
}: {
  readonly view: KeyView;
  readonly book: AgentBook;
  readonly onChange: (entry: { readonly name: string; readonly runtime: string; readonly note: string }) => void;
}) {
  const entry = entryFor(book, view.address);
  const current = { name: entry?.name ?? "", runtime: entry?.runtime ?? "", note: entry?.note ?? "" };
  const id = `agent-book-${view.index}`;
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border/60 bg-[var(--panel)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono text-sm font-semibold text-foreground">{view.label}</h3>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{view.address}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={FIELD} htmlFor={`${id}-name`}>
          <span className={EYEBROW}>Name</span>
          <Input
            id={`${id}-name`}
            value={current.name}
            maxLength={AGENT_BOOK_LIMITS.name}
            placeholder="A name you will recognise"
            autoComplete="off"
            onChange={(event) => onChange({ ...current, name: event.target.value })}
          />
        </label>
        <label className={FIELD} htmlFor={`${id}-runtime`}>
          <span className={EYEBROW}>Where it runs</span>
          <Input
            id={`${id}-runtime`}
            value={current.runtime}
            maxLength={AGENT_BOOK_LIMITS.runtime}
            placeholder="Laptop, server, CI runner"
            autoComplete="off"
            onChange={(event) => onChange({ ...current, runtime: event.target.value })}
          />
        </label>
      </div>
      <label className={FIELD} htmlFor={`${id}-note`}>
        <span className={EYEBROW}>Note</span>
        <textarea
          id={`${id}-note`}
          value={current.note}
          maxLength={AGENT_BOOK_LIMITS.note}
          rows={2}
          placeholder="What it is for, which Services it may use, anything to remember"
          className={cn(
            "min-h-16 w-full min-w-0 rounded-[2px] border border-border bg-background px-3 py-2 text-base text-foreground placeholder:text-muted-foreground md:text-sm",
            FOCUS_RING,
          )}
          onChange={(event) => onChange({ ...current, note: event.target.value })}
        />
      </label>
    </li>
  );
}

/** The sealed envelope as this browser stores it, ciphertext shortened. Everything shown is safe to show. */
function Stored({ sealed }: { readonly sealed: SealedAgentBook }) {
  const { vault } = sealed;
  const shown = {
    kind: sealed.kind,
    sealedAt: sealed.sealedAt,
    vault: {
      credential: vault.credential.credentialId,
      prfSalt: vault.prfSalt,
      nonce: vault.nonce,
      ciphertext: `${vault.ciphertext.slice(0, 48)}… (${vault.ciphertext.length} chars)`,
    },
  };
  return (
    <details className="group rounded-lg border border-border/60 bg-background/60 px-4 py-3">
      <summary className={cn(EYEBROW, "cursor-pointer select-none")}>What this browser stores</summary>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        The salt names the namespace the passkey was asked for; the ciphertext is the book. Neither
        is a key, and without the passkey neither opens anything.
      </p>
      <pre className="mt-2 overflow-x-auto rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-relaxed text-foreground">
        {JSON.stringify(shown, null, 2)}
      </pre>
    </details>
  );
}

function formatSealedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime()) || at.getTime() === 0) return "earlier";
  return `on ${at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}
