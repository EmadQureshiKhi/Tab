/**
 * A passkey account: the seed, the keys derived from it so far, and the one
 * place the lifecycle of both is decided.
 *
 * ## The key model
 *
 * In Tab the Agent is whoever signs. `TabBook.authorise` records `msg.sender`
 * as the Agent and `TabSettlement.settle` moves the Asset from `msg.sender`,
 * so there is no way to act on another account's behalf and no reason to want
 * one. That fixes the model:
 *
 *   - A **session key** is the Agent for one runtime. It signs its own
 *     `authorise`, settles its own tab, and its credit history is its own.
 *     It is revealed once, deliberately, and pasted into that runtime.
 *   - The **owner key** is the root the passkey stands behind. It can always
 *     re-derive every session key, so a runtime that loses its key has not
 *     lost the account, and it is what this Dashboard signs with when nothing
 *     else is chosen. It is never revealed.
 *
 * ## What is held, and for how long
 *
 * The seed stays in this object for as long as the passkey is signed in, so
 * the next session key can be derived without another ceremony. `end` zeroes
 * it and ends every session. Nothing here is serialisable, which is the point:
 * a reload forgets all of it, and one touch on the authenticator brings it
 * back, identical.
 */

import type { Result } from "../wallet/result";
import {
  type DerivedKey,
  FIRST_SESSION_INDEX,
  OWNER_INDEX,
  deriveKey,
  derivePrivateKey,
  isSessionKeyIndex,
  keyLabel,
  pathFor,
  seedFromPrfOutput,
  toHex,
} from "./derivation";

export interface PasskeyAccount {
  readonly owner: DerivedKey;
  /** Every session key derived so far, in index order, starting at 1. Never the owner. */
  readonly sessionKeys: readonly DerivedKey[];
  /** True once `end` has run. Nothing signs after that. */
  readonly ended: boolean;
  /** The key at an index, where one has been derived. */
  keyAt(index: number): DerivedKey | undefined;
  /** Derives the next session key. Deterministic: the same passkey always yields the same key at the same index. */
  deriveNext(): Result<DerivedKey>;
  /**
   * The private key at a session index, as hex, in a fresh string.
   *
   * Refuses the owner. The owner's key is the recovery root and there is no
   * flow in which a person should hold it in a text field.
   */
  revealPrivateKey(index: number): Result<string>;
  /** Zeroes the seed and ends every session. Permanent. */
  end(): void;
}

/**
 * Opens an account from a PRF output.
 *
 * The output buffer belongs to the caller and is zeroed here once the seed is
 * computed, because there is no reason for two copies of the root secret to
 * exist. `sessionKeys` restores the count a browser remembered, so a returning
 * reader sees the same list they left; the keys themselves come out of the
 * derivation, never out of storage.
 */
export function openPasskeyAccount(
  prfOutput: Uint8Array,
  options: { readonly sessionKeys?: number } = {},
): PasskeyAccount {
  const seed = seedFromPrfOutput(prfOutput);
  prfOutput.fill(0);

  const owner = deriveKey(seed, OWNER_INDEX);
  const sessions: DerivedKey[] = [];
  let ended = false;

  const restore = Math.max(0, Math.floor(options.sessionKeys ?? 0));
  for (let index = FIRST_SESSION_INDEX; index < FIRST_SESSION_INDEX + restore; index += 1) {
    sessions.push(deriveKey(seed, index));
  }

  const keyAt = (index: number): DerivedKey | undefined => {
    if (index === OWNER_INDEX) return owner;
    return sessions.find((key) => key.index === index);
  };

  return {
    owner,
    get sessionKeys() {
      return [...sessions];
    },
    get ended() {
      return ended;
    },
    keyAt,
    deriveNext() {
      if (ended) return { ok: false, message: "The passkey session has ended. Sign in again to derive a key." };
      const index = FIRST_SESSION_INDEX + sessions.length;
      const key = deriveKey(seed, index);
      sessions.push(key);
      return { ok: true, value: key };
    },
    revealPrivateKey(index: number) {
      if (ended) return { ok: false, message: "The passkey session has ended. Sign in again to reveal a key." };
      if (!isSessionKeyIndex(index)) {
        return {
          ok: false,
          message: `${keyLabel(index)} is never revealed. It is the root the passkey stands behind; derive a session key for a runtime instead.`,
        };
      }
      if (keyAt(index) === undefined) {
        return { ok: false, message: `No key has been derived at ${pathFor(index)} yet.` };
      }
      const bytes = derivePrivateKey(seed, index);
      try {
        return { ok: true, value: toHex(bytes) };
      } finally {
        bytes.fill(0);
      }
    },
    end() {
      if (ended) return;
      ended = true;
      seed.fill(0);
      owner.session.end();
      for (const key of sessions) key.session.end();
    },
  };
}
