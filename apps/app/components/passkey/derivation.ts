/**
 * One passkey, many keys: the derivation, and nothing that touches a browser.
 *
 * ## Where the keys come from
 *
 * A passkey with the WebAuthn PRF extension returns 32 bytes that are a pure
 * function of the credential, the relying party and a fixed salt. Mera
 * evaluates that PRF; this file turns the 32 bytes into accounts the way the
 * Mera recipe does, so an account made here can be recomputed by anything
 * that follows the same recipe:
 *
 *   PRF output (32 bytes)
 *     -> BIP-39 mnemonic (the bytes as entropy)
 *     -> BIP-39 seed (PBKDF2, empty passphrase)
 *     -> BIP-32 root
 *     -> m/44'/60'/0'/0/<index>
 *
 * Index 0 is the owner key: the root identity behind the passkey, and the key
 * this Dashboard signs with unless another is chosen. Indices 1 and up are
 * session keys, the ones an agent runtime holds. The owner is never offered
 * as a session key, which `isSessionKeyIndex` is the single source of.
 *
 * ## Nothing here is stored
 *
 * Every function takes bytes and returns bytes or a session. The caller owns
 * the seed and zeroes it; `account.ts` is where that lifecycle lives.
 */

import { createSecp256k1SigningSession, getEvmAddress, type Secp256k1SigningSession } from "@category-labs/mera";
// Pinned to the 1.x line on purpose: every 2.x release ships `index.ts` beside
// `index.js` with no `exports` map, and both TypeScript and Turbopack then
// resolve the package to the source file, which neither will compile. 1.7.0
// ships a built `lib/` behind an `exports` map and the same `HDKey` API.
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/** The BIP-44 account every key shares. Only the last index varies. */
export const DERIVATION_ROOT = "m/44'/60'/0'/0";

/** The owner key's index. The Agent's root identity, never a session key. */
export const OWNER_INDEX = 0;

/** The first index a session key may take. */
export const FIRST_SESSION_INDEX = 1;

/** The full path for a key index, `m/44'/60'/0'/0/<index>`. */
export function pathFor(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`A key index is a non-negative integer, not ${index}`);
  }
  return `${DERIVATION_ROOT}/${index}`;
}

/** True for every index a session key may have. Index 0 is the owner, never a session. */
export function isSessionKeyIndex(index: number): boolean {
  return Number.isInteger(index) && index >= FIRST_SESSION_INDEX;
}

/** "Owner key" or "Session key 3": how every view names a key. */
export function keyLabel(index: number): string {
  return index === OWNER_INDEX ? "Owner key" : `Session key ${index}`;
}

/**
 * The BIP-39 seed for a PRF output, exactly as the Mera recipe computes it.
 *
 * The PRF output is used as entropy, not as the seed directly, so the same
 * bytes could be written down as 24 words by a tool that wanted to. This
 * Dashboard never shows those words; the passkey is the backup.
 */
export function seedFromPrfOutput(prfOutput: Uint8Array): Uint8Array {
  if (prfOutput.length !== 32) {
    throw new RangeError(`A PRF output is 32 bytes, not ${prfOutput.length}`);
  }
  return mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
}

/** One derived key: the address, and the session that signs for it. */
export interface DerivedKey {
  readonly index: number;
  readonly path: string;
  /** EIP-55 checksummed, as Mera reports it. */
  readonly address: string;
  readonly session: Secp256k1SigningSession;
}

/**
 * The raw private key at an index, in a fresh buffer the caller must zero.
 *
 * Kept separate from `deriveKey` because two callers need the bytes and
 * neither should hold them longer than one expression: the session, which
 * copies them in and zeroes them on `end`, and the one-time reveal on the
 * Keys page.
 */
export function derivePrivateKey(seed: Uint8Array, index: number): Uint8Array {
  const root = HDKey.fromMasterSeed(seed);
  const node = root.derive(pathFor(index));
  try {
    const key = node.privateKey;
    if (key === null) throw new Error(`Derivation at ${pathFor(index)} produced no key`);
    return new Uint8Array(key);
  } finally {
    // Both nodes hold the scalar. Wiping them bounds how long it is readable
    // to the length of this call.
    node.wipePrivateData();
    root.wipePrivateData();
  }
}

/** A session for the key at an index. The private key lives only inside it. */
export function deriveKey(seed: Uint8Array, index: number): DerivedKey {
  const privateKey = derivePrivateKey(seed, index);
  try {
    const session = createSecp256k1SigningSession({ privateKey });
    return { index, path: pathFor(index), address: getEvmAddress(session.publicKey), session };
  } finally {
    privateKey.fill(0);
  }
}

/** Bytes as `0x` hex, the form an `AGENT_PRIVATE_KEY` variable takes. */
export function toHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
