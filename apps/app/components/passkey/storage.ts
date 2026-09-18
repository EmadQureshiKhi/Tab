/**
 * What this browser remembers about a passkey, and the rule about what it
 * must never remember.
 *
 * The record is credential metadata and bookkeeping: which passkey to ask the
 * authenticator for, what it was called, how many session keys have been
 * derived, and which of those have been shown to the reader. Every one of
 * those is public or harmless. A key, a seed, a mnemonic or a PRF output is
 * never written, and `readPasskeyRecord` lifts only the fields it knows, so
 * even a record somebody else wrote under this key cannot smuggle one in.
 *
 * The count matters because derivation is deterministic: remembering that
 * three session keys exist is enough for the next sign-in to show the same
 * three addresses, without a byte of key material on disk.
 */

import type { PasskeyCredentialMetadata } from "@category-labs/mera";

/** The localStorage key. Versioned in the name so a future shape can coexist. */
export const PASSKEY_RECORD_KEY = "tab.passkey.v1";

export interface PasskeyRecord {
  readonly version: 1;
  readonly credential: PasskeyCredentialMetadata;
  /** The name the passkey was created under, for the menu and the authenticator's list. */
  readonly label: string;
  /** How many session keys have been derived. Their indices are 1..sessionKeys. */
  readonly sessionKeys: number;
  /** Session indices whose private key has been shown. Informational: a shown key may be held by a runtime. */
  readonly revealed: readonly number[];
}

/** The slice of `Storage` this module uses, so tests can hand in a map. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isTransportList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * The record, or nothing.
 *
 * Nothing here throws: a malformed record is the same as no record, because
 * the fallback (ask the authenticator for any passkey under this host) works
 * without one. Unknown fields are dropped rather than carried.
 */
export function readPasskeyRecord(storage: StorageLike): PasskeyRecord | undefined {
  let raw: string | null;
  try {
    raw = storage.getItem(PASSKEY_RECORD_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const candidate = parsed as Record<string, unknown>;
  if (candidate["version"] !== 1) return undefined;

  const credential = candidate["credential"];
  if (typeof credential !== "object" || credential === null) return undefined;
  const credentialId = (credential as Record<string, unknown>)["credentialId"];
  if (typeof credentialId !== "string" || credentialId.length === 0) return undefined;
  const transports = (credential as Record<string, unknown>)["transports"];

  const sessionKeys = candidate["sessionKeys"];
  const revealed = candidate["revealed"];
  const label = candidate["label"];

  return {
    version: 1,
    credential: isTransportList(transports) ? { credentialId, transports } : { credentialId },
    label: typeof label === "string" ? label : "Passkey",
    sessionKeys: typeof sessionKeys === "number" && Number.isInteger(sessionKeys) && sessionKeys >= 0 ? sessionKeys : 0,
    revealed: Array.isArray(revealed)
      ? revealed.filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry) && entry >= 1)
      : [],
  };
}

/** Writes the record. Only the known fields are serialised, whatever else the object carries. */
export function writePasskeyRecord(storage: StorageLike, record: PasskeyRecord): void {
  const clean: PasskeyRecord = {
    version: 1,
    credential:
      record.credential.transports === undefined
        ? { credentialId: record.credential.credentialId }
        : { credentialId: record.credential.credentialId, transports: [...record.credential.transports] },
    label: record.label,
    sessionKeys: record.sessionKeys,
    revealed: [...new Set(record.revealed)].sort((a, b) => a - b),
  };
  try {
    storage.setItem(PASSKEY_RECORD_KEY, JSON.stringify(clean));
  } catch {
    // Storage can be full or disabled. The account still works for this
    // page; only the memory of it is lost, and the menu says so through
    // `remembered` being absent next time.
  }
}

export function clearPasskeyRecord(storage: StorageLike): void {
  try {
    storage.removeItem(PASSKEY_RECORD_KEY);
  } catch {
    // Nothing to do: a storage that cannot be cleared held nothing readable either.
  }
}

/** The browser's own storage, or nothing on the server. */
export function browserStorage(): StorageLike | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
