/**
 * Tests for the agent book: the owner's notes on each Agent, sealed by the
 * passkey under a PRF namespace of its own.
 *
 * The seal and open run Mera's real secret-vault code. Only the authenticator
 * is a double, and its PRF behaves like the real one: the output is HMAC-SHA256
 * of a per-credential secret over the salt the ceremony asks for, so it is
 * deterministic per credential and salt, unrelated across salts, and different
 * for another passkey. That lets these tests check the claims the Keys page
 * makes, that the book is sealed under a namespace that is not the account's,
 * that only the sealing passkey opens it, and that what the browser keeps
 * holds nothing readable.
 */

import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { MeraError } from "@category-labs/mera";

import {
  AGENT_BOOK_KEY,
  AGENT_BOOK_LIMITS,
  type AgentBook,
  emptyAgentBook,
  entryFor,
  namespaceFingerprint,
  parseAgentBook,
  parseSealedAgentBook,
  readSealedAgentBook,
  serialiseSealedAgentBook,
  withEntry,
  writeSealedAgentBook,
} from "../components/passkey/agent-book";
import { describeBookFailure, openAgentBook, sealAgentBook } from "../components/passkey/agent-book-ceremony";
import type { StorageLike } from "../components/passkey/storage";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RP_ID = "trytabai.vercel.app";

/** Mera's fixed account salt, `sha256("mera.prf.salt.v1")`, which the account keys come from. */
const ACCOUNT_SALT = createHash("sha256").update("mera.prf.salt.v1").digest();

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

interface FakeAuthenticator {
  readonly credentialId: string;
  /** Every salt the authenticator was asked to evaluate, in order. */
  readonly saltsAsked: Buffer[];
  readonly client: {
    createCredential: () => Promise<never>;
    getCredential: (request: {
      readonly rpId: string;
      readonly allowCredential?: { readonly credentialId: Uint8Array };
      readonly prfSalt: Uint8Array;
    }) => Promise<{ credentialId: Uint8Array; prfOutput: Uint8Array }>;
  };
}

/**
 * A passkey whose PRF is HMAC-SHA256(secret, salt), the construction CTAP's
 * hmac-secret uses. `credentialId` can be shared between two doubles to model
 * a different passkey answering for the same id.
 */
function authenticator(options: { readonly credentialId?: Uint8Array; readonly secret?: Uint8Array } = {}): FakeAuthenticator {
  const id = options.credentialId ?? randomBytes(16);
  const secret = options.secret ?? randomBytes(32);
  const saltsAsked: Buffer[] = [];
  return {
    credentialId: base64Url(id),
    saltsAsked,
    client: {
      createCredential: () => Promise.reject(new Error("not used")),
      getCredential: async (request) => {
        assert.equal(request.rpId, RP_ID);
        if (request.allowCredential !== undefined) {
          assert.equal(base64Url(request.allowCredential.credentialId), base64Url(id), "the prompt is pinned to the vault's passkey");
        }
        saltsAsked.push(Buffer.from(request.prfSalt));
        return { credentialId: new Uint8Array(id), prfOutput: new Uint8Array(createHmac("sha256", secret).update(request.prfSalt).digest()) };
      },
    },
  };
}

function memoryStorage(): StorageLike & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const AGENT_1 = "0x1111111111111111111111111111111111111111";
const AGENT_2 = "0x2222222222222222222222222222222222222222";

const sampleBook = (): AgentBook =>
  withEntry(
    withEntry(emptyAgentBook(), { address: AGENT_1, name: "Research agent", runtime: "Claude Code on the laptop", note: "Settles every evening" }),
    { address: AGENT_2, name: "Trading agent", runtime: "CI runner", note: "Buys a quote before every trade" },
  );

/* --------------------------------------------------------------- the seal */

test("a book seals under a fresh namespace that is never the account's, and opens to what was sealed", async () => {
  const passkey = authenticator();
  const credential = { credentialId: passkey.credentialId };
  const sealed = await sealAgentBook({ rpId: RP_ID, credential, book: sampleBook(), webAuthnClient: passkey.client });
  assert.ok(sealed.ok, sealed.ok ? "" : sealed.message);

  const salt = Buffer.from(sealed.value.vault.prfSalt, "base64url");
  assert.equal(salt.length, 32);
  assert.notDeepEqual(salt, ACCOUNT_SALT, "the book is not sealed under the account namespace");
  assert.deepEqual(passkey.saltsAsked, [salt], "sealing asked the passkey once, for the book's own salt");
  assert.equal(sealed.value.vault.credential.credentialId, passkey.credentialId);

  const opened = await openAgentBook({ rpId: RP_ID, sealed: sealed.value, webAuthnClient: passkey.client });
  assert.ok(opened.ok, opened.ok ? "" : opened.message);
  assert.deepEqual(opened.value.entries, sampleBook().entries);
  assert.equal(opened.value.updatedAt, sealed.value.sealedAt);
  assert.equal(passkey.saltsAsked.length, 2, "opening asked once more");
  assert.deepEqual(passkey.saltsAsked[1], salt, "and for the same salt the vault carries");
});

test("every seal draws a new namespace, so two seals of the same book share no key", async () => {
  const passkey = authenticator();
  const credential = { credentialId: passkey.credentialId };
  const first = await sealAgentBook({ rpId: RP_ID, credential, book: sampleBook(), webAuthnClient: passkey.client });
  const second = await sealAgentBook({ rpId: RP_ID, credential, book: sampleBook(), webAuthnClient: passkey.client });
  assert.ok(first.ok && second.ok);
  assert.notEqual(first.value.vault.prfSalt, second.value.vault.prfSalt);
  assert.notEqual(first.value.vault.ciphertext, second.value.vault.ciphertext);
  assert.notEqual(namespaceFingerprint(first.value.vault.prfSalt), namespaceFingerprint(second.value.vault.prfSalt));
});

test("only the passkey that sealed the book opens it, and a changed file opens nothing", async () => {
  const passkey = authenticator();
  const sealed = await sealAgentBook({ rpId: RP_ID, credential: { credentialId: passkey.credentialId }, book: sampleBook(), webAuthnClient: passkey.client });
  assert.ok(sealed.ok);

  // Another passkey answering for the same credential id: its PRF differs, so its key does.
  const impostor = authenticator({ credentialId: Buffer.from(passkey.credentialId, "base64url") });
  const refused = await openAgentBook({ rpId: RP_ID, sealed: sealed.value, webAuthnClient: impostor.client });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.message, /sealed by a different passkey/);

  // One flipped byte of ciphertext fails AES-GCM's authentication.
  const bytes = Buffer.from(sealed.value.vault.ciphertext, "base64url");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  const tampered = { ...sealed.value, vault: { ...sealed.value.vault, ciphertext: bytes.toString("base64url") } };
  const changed = await openAgentBook({ rpId: RP_ID, sealed: tampered, webAuthnClient: passkey.client });
  assert.equal(changed.ok, false);
  assert.match(changed.ok ? "" : changed.message, /changed after it was sealed/);
});

test("what this browser stores and what an export carries hold no word of the book", async () => {
  const passkey = authenticator();
  const sealed = await sealAgentBook({ rpId: RP_ID, credential: { credentialId: passkey.credentialId }, book: sampleBook(), webAuthnClient: passkey.client });
  assert.ok(sealed.ok);

  const storage = memoryStorage();
  writeSealedAgentBook(storage, sealed.value);
  const stored = storage.map.get(AGENT_BOOK_KEY) ?? "";
  for (const secret of ["Research agent", "Claude Code", "every evening", "Trading agent", AGENT_1, AGENT_2]) {
    assert.equal(stored.includes(secret), false, `the stored envelope must not contain ${secret}`);
  }
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ["kind", "sealedAt", "vault", "version"]);
  assert.deepEqual(Object.keys(JSON.parse(stored).vault).sort(), ["ciphertext", "credential", "nonce", "prfSalt", "version"]);

  // The stored copy and the export are the same envelope, and either opens.
  assert.equal(serialiseSealedAgentBook(sealed.value), stored);
  const back = readSealedAgentBook(storage);
  assert.ok(back !== undefined);
  const opened = await openAgentBook({ rpId: RP_ID, sealed: back, webAuthnClient: passkey.client });
  assert.ok(opened.ok);
  assert.equal(entryFor(opened.value, AGENT_1)?.name, "Research agent");
});

/* ---------------------------------------------------- shape and envelopes */

test("a book keeps only well-formed entries, one per address, within the limits", () => {
  const long = "x".repeat(AGENT_BOOK_LIMITS.note + 50);
  const book = parseAgentBook(
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-05T00:00:00.000Z",
        entries: [
          { address: AGENT_1, name: "  First\u0007 ", runtime: "laptop", note: long, key: "0xdeadbeef" },
          { address: AGENT_1.toUpperCase().replace("0X", "0x"), name: "Duplicate" },
          { address: "not an address", name: "Dropped" },
          { address: AGENT_2, name: "", runtime: "", note: "" },
          "junk",
        ],
      }),
    ),
  );
  assert.ok(book !== undefined);
  assert.equal(book.entries.length, 1);
  assert.equal(book.entries[0]?.name, "First");
  assert.equal(book.entries[0]?.note.length, AGENT_BOOK_LIMITS.note);
  assert.equal("key" in (book.entries[0] ?? {}), false, "unknown fields are dropped");
  assert.equal(parseAgentBook(new TextEncoder().encode("{")), undefined);
  assert.equal(parseAgentBook({ version: 2, entries: [] }), undefined);
});

test("writing an entry replaces it case-insensitively, and blanking every field removes it", () => {
  const book = sampleBook();
  const renamed = withEntry(book, { address: AGENT_1.toUpperCase().replace("0X", "0x"), name: "Renamed", runtime: "", note: "" });
  assert.equal(renamed.entries.length, 2);
  assert.equal(entryFor(renamed, AGENT_1)?.name, "Renamed");
  const removed = withEntry(renamed, { address: AGENT_1, name: " ", runtime: "", note: "" });
  assert.equal(entryFor(removed, AGENT_1), undefined);
  assert.equal(removed.entries.length, 1);
});

test("an import that is not a sealed agent book, or carries a damaged vault, is refused", async () => {
  const passkey = authenticator();
  const sealed = await sealAgentBook({ rpId: RP_ID, credential: { credentialId: passkey.credentialId }, book: sampleBook(), webAuthnClient: passkey.client });
  assert.ok(sealed.ok);
  const text = serialiseSealedAgentBook(sealed.value);
  assert.ok(parseSealedAgentBook(text) !== undefined);
  assert.equal(parseSealedAgentBook("not json"), undefined);
  assert.equal(parseSealedAgentBook(JSON.stringify({ ...JSON.parse(text), kind: "something-else" })), undefined);
  assert.equal(parseSealedAgentBook(JSON.stringify({ ...JSON.parse(text), vault: { ...JSON.parse(text).vault, nonce: "!!" } })), undefined);
  // Extra fields in an imported envelope do not survive into what is stored.
  const padded = parseSealedAgentBook(JSON.stringify({ ...JSON.parse(text), plaintext: "Research agent" }));
  assert.ok(padded !== undefined);
  assert.equal(serialiseSealedAgentBook(padded).includes("Research agent"), false);
});

test("each failure to seal or open becomes a sentence that says what happened", () => {
  const cancelled = new MeraError("PASSKEY_OPERATION_FAILED", "cancelled", { cause: Object.assign(new Error("x"), { name: "NotAllowedError" }) });
  assert.match(describeBookFailure(cancelled, "seal"), /not sealed, and the last sealed copy is unchanged/);
  assert.match(describeBookFailure(cancelled, "open"), /stays sealed: the prompt was closed, or this device holds no copy/);
  assert.match(describeBookFailure(new MeraError("DECRYPT_FAILED", "x"), "open"), /different passkey/);
  assert.match(describeBookFailure(new MeraError("VAULT_FORMAT_INVALID", "x"), "open"), /not a sealed agent book/);
  assert.match(describeBookFailure(new MeraError("PRF_UNAVAILABLE", "x"), "open"), /returned no PRF output/);
});

/* --------------------------------------------------------- source contract */

test("the book's plaintext never reaches storage: the view writes only the sealed envelope", () => {
  const view = readFileSync(join(ROOT, "components/passkey/agent-book-view.tsx"), "utf8");
  assert.doesNotMatch(view, /localStorage|sessionStorage|setItem\(/, "the view goes through the sealed-envelope helpers only");
  assert.match(view, /writeSealedAgentBook\(storage, result\.value\)/);
  assert.match(view, /writeSealedAgentBook\(storage, imported\)/);
  const keys = readFileSync(join(ROOT, "components/passkey/keys-view.tsx"), "utf8");
  assert.match(keys, /One passkey, a second job/);
  assert.match(keys, /if \(!passkey\.signedIn\) setBook\(undefined\)/, "the plaintext is dropped when the session ends");
});
