/**
 * The agent book: what the owner knows about each Agent, sealed by the passkey.
 *
 * ## What it is
 *
 * A session key is an address and an index. What the owner actually needs to
 * remember is what that Agent is: which runtime holds it, what it is for,
 * which Services it was authorised for. That knowledge is private, and before
 * this book it lived nowhere but the owner's head, because the passkey record
 * (`storage.ts`) is deliberately limited to public bookkeeping.
 *
 * ## One passkey, a second job
 *
 * The account keys come from the passkey's PRF under Mera's fixed account salt.
 * The book is sealed under a different PRF namespace: Mera's secret vault draws
 * a fresh random 32-byte salt for every seal, evaluates the same passkey's PRF
 * at that salt, derives an AES-256-GCM key from the output with HKDF, and
 * encrypts the book. The salt travels with the ciphertext; the key never exists
 * outside the ceremony. No account key, seed or session is involved, so sealing
 * and opening the book is work the passkey does that is not signing for a
 * wallet.
 *
 * ## What is stored, and where
 *
 * Only the sealed vault: credential id, salt, nonce and ciphertext. This
 * browser keeps it in localStorage, and the owner can export it as a file and
 * import it on another device, where the same synced passkey opens it. Nothing
 * here talks to a server, so there is no server that could read it.
 *
 * Everything in this file is pure: the book's shape, its limits, its encoding,
 * and the stored and exported envelopes. The ceremonies that seal and open it
 * are in `agent-book-ceremony.ts`.
 */

import { type PasskeySecretVault, parseSecretVault } from "@category-labs/mera";

import type { StorageLike } from "./storage";

/** The localStorage key for the sealed book. Versioned in the name like the passkey record. */
export const AGENT_BOOK_KEY = "tab.agent-book.v1";

/** What an exported file says it is, so an import can refuse any other JSON. */
export const AGENT_BOOK_FILE_KIND = "tab-agent-book";

export const AGENT_BOOK_LIMITS = {
  /** Entries per book. Far above any real fleet, low enough to bound the ciphertext. */
  entries: 256,
  name: 64,
  runtime: 64,
  note: 500,
} as const;

/** One Agent, as its owner describes it. Keyed by address, so a reorder of session keys cannot mislabel one. */
export interface AgentBookEntry {
  /** EIP-55 checksummed or lowercase hex; compared case-insensitively. */
  readonly address: string;
  readonly name: string;
  /** Where the key is held: "research bot on the office Mac", "CI runner". */
  readonly runtime: string;
  readonly note: string;
}

export interface AgentBook {
  readonly version: 1;
  readonly entries: readonly AgentBookEntry[];
  /** ISO time of the last seal. */
  readonly updatedAt: string;
}

/** The sealed book as this browser stores it and as a file carries it. */
export interface SealedAgentBook {
  readonly kind: typeof AGENT_BOOK_FILE_KIND;
  readonly version: 1;
  /** ISO time the vault was made. Public, like everything in this envelope except the ciphertext. */
  readonly sealedAt: string;
  readonly vault: PasskeySecretVault;
}

export const emptyAgentBook = (): AgentBook => ({ version: 1, entries: [], updatedAt: new Date(0).toISOString() });

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Trims, drops control characters, and cuts to `limit` characters. */
function cleanText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, limit);
}

/** An entry with nothing written in it is no entry at all. */
const isBlank = (entry: AgentBookEntry): boolean => entry.name === "" && entry.runtime === "" && entry.note === "";

/**
 * The book from decrypted bytes or an object, or undefined when it is not one.
 *
 * Decrypted bytes came out of an authenticated cipher, so they were written by
 * someone holding the passkey; the checks here are about shape and limits, so
 * a book written by an older or newer page still opens as far as it can.
 */
export function parseAgentBook(value: unknown): AgentBook | undefined {
  let parsed: unknown = value;
  if (value instanceof Uint8Array) {
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (candidate["version"] !== 1 || !Array.isArray(candidate["entries"])) return undefined;

  const entries: AgentBookEntry[] = [];
  for (const raw of candidate["entries"]) {
    if (entries.length >= AGENT_BOOK_LIMITS.entries) break;
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const address = record["address"];
    if (typeof address !== "string" || !ADDRESS.test(address)) continue;
    if (entries.some((entry) => sameAddress(entry.address, address))) continue;
    const entry: AgentBookEntry = {
      address,
      name: cleanText(record["name"], AGENT_BOOK_LIMITS.name),
      runtime: cleanText(record["runtime"], AGENT_BOOK_LIMITS.runtime),
      note: cleanText(record["note"], AGENT_BOOK_LIMITS.note),
    };
    if (!isBlank(entry)) entries.push(entry);
  }
  const updatedAt = candidate["updatedAt"];
  return {
    version: 1,
    entries,
    updatedAt: typeof updatedAt === "string" && !Number.isNaN(Date.parse(updatedAt)) ? updatedAt : new Date(0).toISOString(),
  };
}

/** The bytes that get sealed. Only the known fields, so nothing else rides along. */
export function encodeAgentBook(book: AgentBook): Uint8Array<ArrayBuffer> {
  const clean = parseAgentBook(book) ?? emptyAgentBook();
  return new TextEncoder().encode(
    JSON.stringify({ version: 1, entries: clean.entries, updatedAt: book.updatedAt }),
  ) as Uint8Array<ArrayBuffer>;
}

/** The entry for an address, if the book has one. */
export function entryFor(book: AgentBook | undefined, address: string): AgentBookEntry | undefined {
  return book?.entries.find((entry) => sameAddress(entry.address, address));
}

/**
 * The book with one Agent's entry written, replaced, or removed when every
 * field is blank. Text is cleaned to the same limits `parseAgentBook` enforces.
 */
export function withEntry(
  book: AgentBook,
  entry: { readonly address: string; readonly name: string; readonly runtime: string; readonly note: string },
): AgentBook {
  const next: AgentBookEntry = {
    address: entry.address,
    name: cleanText(entry.name, AGENT_BOOK_LIMITS.name),
    runtime: cleanText(entry.runtime, AGENT_BOOK_LIMITS.runtime),
    note: cleanText(entry.note, AGENT_BOOK_LIMITS.note),
  };
  const others = book.entries.filter((existing) => !sameAddress(existing.address, entry.address));
  return { ...book, entries: isBlank(next) ? others : [...others, next].slice(0, AGENT_BOOK_LIMITS.entries) };
}

/**
 * A sealed book from untrusted JSON text or an object, or undefined.
 *
 * The vault is validated by Mera's own `parseSecretVault`, which checks every
 * base64url field and its length and drops unknown fields, so a stored or
 * imported envelope cannot carry anything but a well-formed vault.
 */
export function parseSealedAgentBook(value: unknown): SealedAgentBook | undefined {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (candidate["kind"] !== AGENT_BOOK_FILE_KIND || candidate["version"] !== 1) return undefined;
  let vault: PasskeySecretVault;
  try {
    vault = parseSecretVault(candidate["vault"]);
  } catch {
    return undefined;
  }
  const sealedAt = candidate["sealedAt"];
  return {
    kind: AGENT_BOOK_FILE_KIND,
    version: 1,
    sealedAt: typeof sealedAt === "string" && !Number.isNaN(Date.parse(sealedAt)) ? sealedAt : new Date(0).toISOString(),
    vault,
  };
}

/** The envelope as text: what localStorage holds and what an export file contains. */
export function serialiseSealedAgentBook(sealed: SealedAgentBook): string {
  return JSON.stringify(
    {
      kind: AGENT_BOOK_FILE_KIND,
      version: 1,
      sealedAt: sealed.sealedAt,
      vault: parseSecretVault(sealed.vault),
    },
    null,
    2,
  );
}

/** The file name an export is offered under. */
export const AGENT_BOOK_FILE_NAME = "tab-agent-book.sealed.json";

export function readSealedAgentBook(storage: StorageLike): SealedAgentBook | undefined {
  try {
    const raw = storage.getItem(AGENT_BOOK_KEY);
    return raw === null ? undefined : parseSealedAgentBook(raw);
  } catch {
    return undefined;
  }
}

export function writeSealedAgentBook(storage: StorageLike, sealed: SealedAgentBook): void {
  try {
    storage.setItem(AGENT_BOOK_KEY, serialiseSealedAgentBook(sealed));
  } catch {
    // Full or disabled storage: the export still works, and the view says the
    // book was not kept here because `readSealedAgentBook` comes back empty.
  }
}

export function clearSealedAgentBook(storage: StorageLike): void {
  try {
    storage.removeItem(AGENT_BOOK_KEY);
  } catch {
    // Nothing readable was there either.
  }
}

/** The first bytes of a base64url salt, for showing which namespace sealed a book. Public. */
export function namespaceFingerprint(prfSalt: string): string {
  return prfSalt.slice(0, 11);
}
