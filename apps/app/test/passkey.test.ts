/**
 * Tests for the passkey account: the derivation, the signer, the record, and
 * the rules the views depend on.
 *
 * Two kinds of assertion, matching the shape the other suites take.
 *
 * **Behaviour.** The derivation, the account, the signer, the record and the
 * balance formatting are pure or take their inputs as arguments, so each is
 * exercised directly. The expected addresses are computed here from the same
 * standards (`@scure` BIP-39 and BIP-32, ethers' address derivation) rather
 * than copied from the code under test, so the assertion is that the module
 * follows the published recipe and not that it agrees with itself.
 *
 * **Source contract.** That every colour the passkey views name is a theme
 * token, that the Keys page states the key model in words, and that the
 * localStorage record can never carry key material.
 *
 * What is *not* here is WebAuthn. Node has no authenticator, so the ceremony
 * wrappers and the hook are verified in a browser; what can be checked here
 * is that the sentences they produce for each Mera error code say what to do.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MeraError } from "@category-labs/mera";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Transaction, computeAddress, hexlify, verifyMessage, verifyTypedData } from "ethers";

import { openPasskeyAccount } from "../components/passkey/account";
import { describeCeremonyFailure } from "../components/passkey/ceremony";
import { formatMon, passkeyChainFor } from "../components/passkey/chain";
import {
  DERIVATION_ROOT,
  FIRST_SESSION_INDEX,
  OWNER_INDEX,
  deriveKey,
  isSessionKeyIndex,
  keyLabel,
  pathFor,
  seedFromPrfOutput,
  toHex,
} from "../components/passkey/derivation";
import { SessionSigner } from "../components/passkey/signer";
import {
  PASSKEY_RECORD_KEY,
  clearPasskeyRecord,
  readPasskeyRecord,
  writePasskeyRecord,
  type PasskeyRecord,
  type StorageLike,
} from "../components/passkey/storage";
import { SUPPORTED_AUTHENTICATORS } from "../components/passkey/support";
import { describeSendFailure } from "../components/passkey/use-passkey";
import { WalletProvider } from "../components/wallet/wallet-context";
import { KeysView } from "../components/passkey/keys-view";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A fixed PRF output: the bytes 1..32. Any 32 bytes would do; this one is legible in a failure. */
function fixedPrf(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => index + 1);
}

/** The address at an index, computed from the standards rather than from the module. */
function expectedAddress(index: number): string {
  const seed = mnemonicToSeedSync(entropyToMnemonic(fixedPrf(), wordlist));
  const node = HDKey.fromMasterSeed(seed).derive(`m/44'/60'/0'/0/${index}`);
  assert.ok(node.privateKey !== null);
  return computeAddress(hexlify(node.privateKey));
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

/* --------------------------------------------------------------- derivation */

test("the owner and the session keys derive deterministically from a PRF output", () => {
  const seed = seedFromPrfOutput(fixedPrf());
  const owner = deriveKey(seed, OWNER_INDEX);
  const first = deriveKey(seed, 1);
  const second = deriveKey(seed, 2);

  assert.equal(owner.address, expectedAddress(0));
  assert.equal(first.address, expectedAddress(1));
  assert.equal(second.address, expectedAddress(2));
  assert.equal(owner.path, `${DERIVATION_ROOT}/0`);
  assert.equal(first.path, "m/44'/60'/0'/0/1");

  // Deriving again from the same bytes gives the same keys: that is the whole
  // reason a passkey needs no backup phrase.
  const again = openPasskeyAccount(fixedPrf(), { sessionKeys: 2 });
  assert.equal(again.owner.address, owner.address);
  assert.deepEqual(
    again.sessionKeys.map((key) => key.address),
    [first.address, second.address],
  );
  for (const key of [owner, first, second]) key.session.end();
  again.end();
});

test("session keys differ from the owner and from each other", () => {
  const account = openPasskeyAccount(fixedPrf(), { sessionKeys: 4 });
  const addresses = [account.owner.address, ...account.sessionKeys.map((key) => key.address)];
  assert.equal(new Set(addresses).size, addresses.length);
  assert.deepEqual(
    account.sessionKeys.map((key) => key.index),
    [1, 2, 3, 4],
  );
  account.end();
});

test("index 0 is the owner and is never offered as a session key", () => {
  assert.equal(isSessionKeyIndex(0), false);
  assert.equal(isSessionKeyIndex(-1), false);
  assert.equal(isSessionKeyIndex(1.5), false);
  assert.equal(isSessionKeyIndex(1), true);
  assert.equal(FIRST_SESSION_INDEX, 1);
  assert.equal(keyLabel(0), "Owner key");
  assert.equal(keyLabel(3), "Session key 3");
  assert.throws(() => pathFor(-1), RangeError);

  const account = openPasskeyAccount(fixedPrf());
  assert.equal(account.sessionKeys.length, 0);
  const next = account.deriveNext();
  assert.equal(next.ok, true);
  assert.equal(next.ok && next.value.index, 1);
  assert.ok(account.sessionKeys.every((key) => key.index >= 1));

  const owner = account.revealPrivateKey(OWNER_INDEX);
  assert.equal(owner.ok, false);
  assert.match(owner.ok ? "" : owner.message, /never revealed/);
  account.end();
});

test("a session key reveals as the hex that maps to its own address, and only after derivation", () => {
  const account = openPasskeyAccount(fixedPrf());
  assert.equal(account.revealPrivateKey(1).ok, false, "not derived yet");

  const derived = account.deriveNext();
  assert.equal(derived.ok, true);
  const revealed = account.revealPrivateKey(1);
  assert.equal(revealed.ok, true);
  if (!revealed.ok) return;
  assert.match(revealed.value, /^0x[0-9a-f]{64}$/);
  assert.equal(computeAddress(revealed.value), expectedAddress(1));
  assert.notEqual(computeAddress(revealed.value), account.owner.address);
  account.end();
});

test("ending the account zeroes the seed and refuses everything after", async () => {
  const prf = fixedPrf();
  const account = openPasskeyAccount(prf, { sessionKeys: 1 });
  // The PRF output belongs to the caller and is zeroed once the seed exists.
  assert.ok(prf.every((byte) => byte === 0), "the PRF buffer was not zeroed");

  account.end();
  assert.equal(account.ended, true);
  assert.equal(account.deriveNext().ok, false);
  assert.equal(account.revealPrivateKey(1).ok, false);
  await assert.rejects(
    () => account.owner.session.signDigest(new Uint8Array(32)),
    (error: unknown) => error instanceof MeraError && error.code === "SESSION_ENDED",
  );
  // Ending twice is harmless.
  account.end();
});

test("toHex is the 0x form an AGENT_PRIVATE_KEY takes", () => {
  assert.equal(toHex(Uint8Array.from([0, 1, 255])), "0x0001ff");
});

/* ------------------------------------------------------------------ signer */

test("the session signer signs a transaction the derived address can be recovered from", async () => {
  const seed = seedFromPrfOutput(fixedPrf());
  const key = deriveKey(seed, 1);
  const signer = new SessionSigner(key.session, key.address);
  assert.equal(await signer.getAddress(), key.address);

  const serialized = await signer.signTransaction({
    to: key.address,
    chainId: 10143,
    nonce: 0,
    gasLimit: 21_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    value: 0n,
    data: "0x",
    type: 2,
  });
  const recovered = Transaction.from(serialized);
  assert.equal(recovered.from, key.address);
  assert.equal(recovered.chainId, 10143n);

  // A `from` that is not this key is refused before anything is signed.
  await assert.rejects(() =>
    signer.signTransaction({ to: key.address, from: expectedAddress(2), chainId: 10143 }),
  );
  key.session.end();
});

test("the session signer signs messages and typed data as the same address", async () => {
  const seed = seedFromPrfOutput(fixedPrf());
  const key = deriveKey(seed, 2);
  const signer = new SessionSigner(key.session, key.address);

  const message = "Tab: prove you hold session key 2";
  assert.equal(verifyMessage(message, await signer.signMessage(message)), key.address);

  const domain = { name: "Tab", version: "1", chainId: 10143 };
  const types = { Claim: [{ name: "agent", type: "address" }] };
  const value = { agent: key.address };
  assert.equal(verifyTypedData(domain, types, value, await signer.signTypedData(domain, types, value)), key.address);
  key.session.end();
});

/* ------------------------------------------------------------------ record */

test("the record round-trips and never contains key material", () => {
  const storage = memoryStorage();
  const record: PasskeyRecord = {
    version: 1,
    credential: { credentialId: "AQIDBA", transports: ["internal", "hybrid"] },
    label: "Tab agent",
    sessionKeys: 2,
    revealed: [2, 1, 2],
  };
  writePasskeyRecord(storage, record);

  const raw = storage.map.get(PASSKEY_RECORD_KEY);
  assert.ok(raw !== undefined);
  assert.doesNotMatch(raw, /0x[0-9a-fA-F]{40,}/, "an address or a key is in the record");
  assert.doesNotMatch(raw, /privateKey|seed|mnemonic|prfOutput|prf/i);
  assert.deepEqual(Object.keys(JSON.parse(raw) as object).sort(), ["credential", "label", "revealed", "sessionKeys", "version"]);

  const read = readPasskeyRecord(storage);
  assert.deepEqual(read, { ...record, revealed: [1, 2] });

  clearPasskeyRecord(storage);
  assert.equal(readPasskeyRecord(storage), undefined);
});

test("a record somebody else wrote cannot smuggle in a key, and a malformed one reads as none", () => {
  const storage = memoryStorage();
  storage.setItem(
    PASSKEY_RECORD_KEY,
    JSON.stringify({
      version: 1,
      credential: { credentialId: "AQIDBA" },
      privateKey: "0x" + "11".repeat(32),
      seed: [1, 2, 3],
      sessionKeys: -4,
      revealed: [0, "x", 2],
    }),
  );
  const read = readPasskeyRecord(storage);
  assert.ok(read !== undefined);
  assert.equal("privateKey" in read, false);
  assert.equal("seed" in read, false);
  assert.equal(read.sessionKeys, 0, "a negative count reads as none");
  assert.deepEqual(read.revealed, [2], "only session indices survive");

  for (const junk of ["not json", "null", "[]", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, credential: {} })]) {
    storage.setItem(PASSKEY_RECORD_KEY, junk);
    assert.equal(readPasskeyRecord(storage), undefined, junk);
  }
});

/* ------------------------------------------------------------------- chain */

test("MON formats to four decimals without rounding up", () => {
  assert.equal(formatMon(0n), "0.0000 MON");
  assert.equal(formatMon(1_000_000_000_000_000_000n), "1.0000 MON");
  assert.equal(formatMon(123_456_789_000_000_000n), "0.1234 MON");
  assert.equal(formatMon(999_999_999_999_999_999n), "0.9999 MON");
});

test("a passkey account is only ever on a Monad network", () => {
  assert.equal(passkeyChainFor(10143)?.testnet, true);
  assert.equal(passkeyChainFor(10143)?.rpcUrl, "https://testnet-rpc.monad.xyz");
  assert.equal(passkeyChainFor(10143, "https://example.invalid/rpc")?.rpcUrl, "https://example.invalid/rpc");
  assert.equal(passkeyChainFor(143)?.testnet, false);
  assert.equal(passkeyChainFor(1), undefined);
});

/* --------------------------------------------------------------- sentences */

test("each Mera failure becomes a sentence that names what to do", () => {
  const prf = describeCeremonyFailure(new MeraError("PRF_UNAVAILABLE", "no prf"), "create");
  assert.match(prf, /returned no PRF/);
  for (const entry of SUPPORTED_AUTHENTICATORS) assert.ok(prf.includes(entry.authenticator), entry.authenticator);

  const cancelled = describeCeremonyFailure(
    new MeraError("PASSKEY_OPERATION_FAILED", "failed", { cause: { name: "NotAllowedError" } }),
    "assert",
  );
  assert.match(cancelled, /Cancelled/);
  assert.match(describeCeremonyFailure(new MeraError("CRYPTO_UNAVAILABLE", "x"), "create"), /HTTPS/);
  assert.match(describeCeremonyFailure(new Error("boom"), "assert"), /could not be used: boom/);
  assert.match(describeCeremonyFailure(undefined, "create"), /gave no reason/);

  const testnet = passkeyChainFor(10143);
  assert.ok(testnet !== undefined);
  assert.match(describeSendFailure({ code: "INSUFFICIENT_FUNDS" }, testnet), /faucet\.monad\.xyz/);
  // Monad's own wording, which ethers reports as an error it could not coalesce.
  assert.match(
    describeSendFailure(
      { code: "UNKNOWN_ERROR", shortMessage: "could not coalesce error", error: { code: -32000, message: "Signer had insufficient balance" } },
      testnet,
    ),
    /faucet\.monad\.xyz/,
  );
  assert.doesNotMatch(describeSendFailure({ code: "INSUFFICIENT_FUNDS" }, passkeyChainFor(143)!), /faucet/);
  assert.match(describeSendFailure({ code: "UNKNOWN_ERROR", error: { message: "execution reverted" } }, testnet), /would revert/);
  assert.match(describeSendFailure({ code: "UNKNOWN_ERROR", info: { error: { message: "nonce too low" } } }, testnet), /nonce too low/);
  assert.match(describeSendFailure({ code: "CALL_EXCEPTION", reason: "not authorised" }, testnet), /would revert: not authorised/);
  assert.match(describeSendFailure({ code: "SESSION_ENDED" }, testnet), /Sign in again/);
});

/* --------------------------------------------------------- source contract */

/*
 * Every colour name a passkey view may reach for: the generated tokens the
 * contrast gate measures, and the presentation vocabulary `styles/presentation.css`
 * declares. The same list the primitives and the composites are held to.
 */
const TOKEN_COLOURS = new Set([
  "surface",
  "surface-raised",
  "text",
  "text-muted",
  "accent",
  "stroke",
  "status-pending",
  "status-settled",
  "status-danger",
  "status-muted",
  "status-notice",
  "tier-curated",
  "tier-permissionless",
  "badge-ink",
  "focus-ring",
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "muted-2",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "white",
  "black",
  "teal-200",
  "teal-300",
  "teal-400",
  "teal-500",
  "teal-600",
  "teal-700",
  "teal-800",
  "neutral-400",
  "amber-500",
  "slate-300",
  "slate-400",
  "slate-500",
  "slate-600",
  "slate-700",
  "blue-400",
  "blue-600",
  "amber-400",
  "amber-600",
  "gray-200",
  "gray-400",
  "gray-600",
  "gray-800",
]);

const COLOUR_PREFIXES = ["bg", "text", "border", "outline", "ring", "fill", "stroke", "decoration", "divide", "shadow", "accent", "caret", "from", "via", "to"];

const NOT_COLOURS = new Set([
  "balance", "base", "left", "center", "right", "start", "end", "justify", "nowrap", "wrap", "pretty",
  "ellipsis", "clip", "inherit", "current", "transparent", "none", "solid", "dashed", "dotted", "double",
  "sm", "md", "lg", "xl", "xs", "full", "fit", "max", "min", "auto", "hidden", "visible", "y", "x",
  "1", "2", "4", "8", "px",
]);

function passkeySources(): readonly { readonly name: string; readonly text: string }[] {
  const directories = ["components/passkey", "components/wallet", "app/keys"];
  return directories.flatMap((directory) =>
    readdirSync(join(ROOT, directory))
      .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
      .map((name) => ({ name: `${directory}/${name}`, text: readFileSync(join(ROOT, directory, name), "utf8") })),
  );
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

test("every colour the passkey views name is a theme token", () => {
  const pattern = new RegExp(`\\b(${COLOUR_PREFIXES.join("|")})-([a-z][a-z0-9-]*)\\b`, "g");
  for (const file of passkeySources()) {
    const code = withoutComments(file.text).replace(/\[[^\]]*\]/g, "");
    for (const [utility, , value = ""] of code.matchAll(pattern)) {
      if (NOT_COLOURS.has(value)) continue;
      if (TOKEN_COLOURS.has(value)) continue;
      if (/^(offset|solid|width)-/.test(value)) continue;
      if (/^([btlrse]-)?\d+$/.test(value) || /^[btlrse]$/.test(value)) continue;
      assert.fail(`${file.name} names a colour outside the token set: ${utility}`);
    }
    assert.doesNotMatch(
      withoutComments(file.text),
      /#[0-9a-fA-F]{6}\b|rgb\(|hsl\(/,
      `${file.name} hard-codes a colour instead of naming a token`,
    );
  }
});

test("the Keys page states the key model and why there is no seed phrase or custodian", () => {
  const view = readFileSync(join(ROOT, "components/passkey/keys-view.tsx"), "utf8");
  assert.match(view, /session key is the Agent for one runtime/);
  assert.match(view, /owner key is the recovery root/);
  assert.match(view, /no seed phrase and no custodian/i);
  assert.match(view, /AGENT_PRIVATE_KEY/);
  assert.match(view, /mera\.category\.xyz/);
  // The session list is filtered to indices from 1, so the owner cannot appear in it.
  assert.match(view, /key\.role === "session" && key\.index >= 1/);
  // The hop to /authorise is client-side, so the in-memory session survives it.
  assert.match(view, /<Link href="\/authorise" onClick=\{onSelect\}>/);
});

test("no passkey source uses an em dash", () => {
  // The product vocabulary itself is gated repo-wide by `scripts/vocab-check.mjs`.
  const emDash = String.fromCharCode(0x2014);
  for (const file of passkeySources()) {
    assert.equal(file.text.includes(emDash), false, `${file.name} uses an em dash`);
  }
});

/* ----------------------------------------------- renders without a wallet */

test("the Keys view renders with no wallet and no passkey as an explanation, not a gate", () => {
  const markup = renderToStaticMarkup(
    createElement(
      WalletProvider,
      { network: { chainId: 10143, rpcUrl: "https://testnet-rpc.monad.xyz" } },
      createElement(KeysView, {
        chainId: 10143,
        chainName: "Monad Testnet",
        rpcUrl: "https://testnet-rpc.monad.xyz",
        explorerUrl: "https://testnet.monadvision.com",
      }),
    ),
  );
  assert.match(markup, /No passkey account is signed in/);
  assert.match(markup, /Which key is the Agent/);
  assert.doesNotMatch(markup, /0x[0-9a-fA-F]{40}/, "no address is invented");
  assert.doesNotMatch(markup, /connect (your )?wallet|please connect/i);
});
