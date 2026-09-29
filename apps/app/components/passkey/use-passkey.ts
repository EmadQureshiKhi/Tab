"use client";

/**
 * The passkey connection, as React state.
 *
 * ## What is state and what is not
 *
 * The account (seed, sessions) is not serialisable and must not be, so it
 * lives in a ref. What React renders from is a view of it: the owner's
 * address, the session keys' addresses, which is active, which have been
 * revealed. Every mutation of the account is followed by `refreshViews`, and
 * the view is what every component reads.
 *
 * ## It never prompts on its own
 *
 * Mount reads localStorage and asks the browser whether WebAuthn exists.
 * Neither opens a prompt. `create` and `signIn` follow a press, and each
 * costs exactly one user-verification gesture.
 *
 * ## A reload ends the session
 *
 * Nothing about the keys is persisted, so a full page load forgets them. The
 * record remembers which passkey to ask for, and one touch brings the same
 * keys back. Client-side navigation keeps the provider mounted and the
 * session with it, which is why the Keys page links with `next/link`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChainSpec } from "../wallet/eip1193";
import { type Result, err, ok } from "../wallet/result";
import { type PasskeyAccount, openPasskeyAccount } from "./account";
import { assertPasskey, createPasskey, relyingPartyId } from "./ceremony";
import {
  MONAD_FAUCET_URL,
  type PasskeyChain,
  selectedPasskeyChain,
  passkeyChainFor,
  providerFor,
  readNativeBalance,
} from "./chain";
import { OWNER_INDEX, isSessionKeyIndex, keyLabel } from "./derivation";
import { SessionSigner } from "./signer";
import {
  type PasskeyRecord,
  browserStorage,
  clearPasskeyRecord,
  readPasskeyRecord,
  writePasskeyRecord,
} from "./storage";
import { webAuthnAvailable } from "./support";

/** One key as the views see it. No key material, ever. */
export interface KeyView {
  readonly index: number;
  readonly role: "owner" | "session";
  /** "Owner key" or "Session key 3". */
  readonly label: string;
  readonly path: string;
  /** EIP-55 checksummed. */
  readonly address: string;
  /** Whether the private key has been shown. Always false for the owner. */
  readonly revealed: boolean;
}

/** The active key's MON, or why it could not be read. Never a spinner. */
export type BalanceReading =
  | { readonly kind: "read"; readonly wei: bigint; readonly address: string; readonly chainId: number }
  | { readonly kind: "failed"; readonly message: string };

export interface PasskeyConnection {
  /** True where a WebAuthn ceremony can be attempted. PRF support is only known once one runs. */
  readonly supported: boolean;
  /** The passkey this browser remembers, if any. Sign-in works without one. */
  readonly remembered: PasskeyRecord | undefined;
  readonly signedIn: boolean;
  /** A ceremony is in progress. Exactly one prompt per press. */
  readonly busy: boolean;
  readonly owner: KeyView | undefined;
  /** Indices 1 and up, in order. Never the owner. */
  readonly sessionKeys: readonly KeyView[];
  /** The key this Dashboard signs with. The owner unless another was chosen. */
  readonly active: KeyView | undefined;
  readonly chain: PasskeyChain;
  readonly balance: BalanceReading | undefined;
  /** Where Testnet MON comes from. Undefined on Mainnet. */
  readonly faucetUrl: string | undefined;
  /** Creates a new passkey under this host. Resolves with the owner address. */
  create(label: string): Promise<Result<string>>;
  /** Signs in with the remembered passkey, or any passkey for this host. Resolves with the owner address. */
  signIn(): Promise<Result<string>>;
  /** Zeroes the seed and every key. The record stays; sign in again to return. */
  end(): void;
  /** Ends the session and forgets the record. The passkey itself stays on the authenticator. */
  forget(): void;
  deriveNext(): Result<KeyView>;
  /** The private key at a session index, as hex. Refuses the owner. */
  reveal(index: number): Result<string>;
  select(index: number): Result<KeyView>;
  /** Signs and broadcasts with the active key on the current chain. */
  send(tx: { readonly to: string; readonly data: string; readonly value?: string }): Promise<Result<string>>;
  /** Takes the chain a page is about to sign on. Refuses anything that is not a Monad network. */
  adoptChain(chain: ChainSpec): Result<true>;
  refreshBalance(): Promise<void>;
}

function toViews(account: PasskeyAccount, revealed: readonly number[]): {
  readonly owner: KeyView;
  readonly sessionKeys: readonly KeyView[];
} {
  const shown = new Set(revealed);
  return {
    owner: {
      index: OWNER_INDEX,
      role: "owner",
      label: keyLabel(OWNER_INDEX),
      path: account.owner.path,
      address: account.owner.address,
      revealed: false,
    },
    sessionKeys: account.sessionKeys.map((key) => ({
      index: key.index,
      role: "session",
      label: keyLabel(key.index),
      path: key.path,
      address: key.address,
      revealed: shown.has(key.index),
    })),
  };
}

/**
 * The endpoint's own words for a failure, dug out from wherever ethers put them.
 *
 * Monad answers an unfunded sender with `-32000 "Signer had insufficient
 * balance"`, which ethers does not recognise and reports as "could not
 * coalesce error". The nested message is the useful one, so it is read from
 * `error`, `info.error` and `shortMessage` before the outer message.
 */
function deepestMessage(cause: unknown): string {
  if (typeof cause !== "object" || cause === null) return "";
  const record = cause as Record<string, unknown>;
  const nested = record["error"] ?? (record["info"] as Record<string, unknown> | undefined)?.["error"];
  const nestedMessage = (nested as { message?: unknown } | undefined)?.message;
  if (typeof nestedMessage === "string" && nestedMessage.trim().length > 0) return nestedMessage;
  const short = record["shortMessage"];
  if (typeof short === "string" && short.trim().length > 0 && short !== "could not coalesce error") return short;
  const message = record["message"];
  return typeof message === "string" ? message : "";
}

/** The sentence for a failed broadcast, in terms of what the reader can do next. */
export function describeSendFailure(cause: unknown, chain: PasskeyChain): string {
  const code = (cause as { code?: unknown } | null)?.code;
  const detail = deepestMessage(cause);

  if (code === "INSUFFICIENT_FUNDS" || /insufficient (funds|balance)/i.test(detail)) {
    return chain.testnet
      ? `The active key holds too little MON to pay for gas on ${chain.name}. Get Testnet MON from ${MONAD_FAUCET_URL} and try again.`
      : `The active key holds too little MON to pay for gas on ${chain.name}.`;
  }
  if (code === "SESSION_ENDED") return "The passkey session has ended. Sign in again before signing.";
  if (code === "CALL_EXCEPTION" || /revert/i.test(detail)) {
    const reason = (cause as { reason?: unknown } | null)?.reason;
    return typeof reason === "string" && reason.length > 0
      ? `The contract would revert: ${reason}. Nothing was sent.`
      : "The contract would revert this call, so nothing was sent. Check the authorisation, the ceiling and the account.";
  }
  if (detail.length > 0) return `The transaction was not sent: ${detail}`;
  return "The transaction was not sent, and the endpoint gave no reason.";
}

/** The network the visitor selected, as the root layout resolves it on the server. */
export interface SelectedNetwork {
  readonly chainId: number;
  readonly rpcUrl: string;
}

export function usePasskeyConnection(selected: SelectedNetwork): PasskeyConnection {
  const accountRef = useRef<PasskeyAccount | undefined>(undefined);
  const [supported, setSupported] = useState(false);
  const [remembered, setRemembered] = useState<PasskeyRecord | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [views, setViews] = useState<{ owner: KeyView; sessionKeys: readonly KeyView[] } | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState<number>(OWNER_INDEX);
  const [chain, setChain] = useState<PasskeyChain>(() => selectedPasskeyChain(selected.chainId, selected.rpcUrl));
  const [balance, setBalance] = useState<BalanceReading | undefined>(undefined);

  // The visitor switched network on the masthead: the account follows, so the
  // balance in the connection menu and the next signature are on the chain the
  // page now shows. The keys themselves are the same on every chain.
  useEffect(() => {
    const next = selectedPasskeyChain(selected.chainId, selected.rpcUrl);
    setChain((current) => (current.id === next.id && current.rpcUrl === next.rpcUrl ? current : next));
  }, [selected.chainId, selected.rpcUrl]);

  // What the browser can do and what it remembers. Neither opens a prompt.
  useEffect(() => {
    setSupported(webAuthnAvailable());
    const storage = browserStorage();
    if (storage !== undefined) setRemembered(readPasskeyRecord(storage));
  }, []);

  // Sessions are zeroed when the provider unmounts, which is a full unload.
  useEffect(
    () => () => {
      accountRef.current?.end();
      accountRef.current = undefined;
    },
    [],
  );

  const persist = useCallback((record: PasskeyRecord): void => {
    const storage = browserStorage();
    if (storage !== undefined) writePasskeyRecord(storage, record);
    setRemembered(record);
  }, []);

  const refreshViews = useCallback((record: PasskeyRecord | undefined): void => {
    const account = accountRef.current;
    setViews(account === undefined || account.ended ? undefined : toViews(account, record?.revealed ?? []));
  }, []);

  const open = useCallback(
    (prfOutput: Uint8Array, record: PasskeyRecord): string => {
      accountRef.current?.end();
      const account = openPasskeyAccount(prfOutput, { sessionKeys: record.sessionKeys });
      accountRef.current = account;
      setActiveIndex(OWNER_INDEX);
      setBalance(undefined);
      persist(record);
      refreshViews(record);
      return account.owner.address;
    },
    [persist, refreshViews],
  );

  const create = useCallback(
    async (label: string): Promise<Result<string>> => {
      const rpId = relyingPartyId();
      if (!webAuthnAvailable() || rpId === undefined) {
        return err("This browser has no WebAuthn, so a passkey cannot be created here.");
      }
      const name = label.trim().length > 0 ? label.trim() : "Tab agent";
      setBusy(true);
      try {
        const created = await createPasskey({ rpId, label: name });
        if (!created.ok) return created;
        const record: PasskeyRecord = {
          version: 1,
          credential: created.value.credential,
          label: name,
          sessionKeys: 0,
          revealed: [],
        };
        return ok(open(created.value.prfOutput, record));
      } finally {
        setBusy(false);
      }
    },
    [open],
  );

  const signIn = useCallback(async (): Promise<Result<string>> => {
    const rpId = relyingPartyId();
    if (!webAuthnAvailable() || rpId === undefined) {
      return err("This browser has no WebAuthn, so a passkey cannot be used here.");
    }
    setBusy(true);
    try {
      const asserted = await assertPasskey({ rpId, credential: remembered?.credential });
      if (!asserted.ok) return asserted;
      // The platform chose the passkey. Where it is the remembered one, the
      // bookkeeping carries over; where it is another, the record starts fresh
      // for it, because the count and the reveals belong to one credential.
      const record: PasskeyRecord =
        remembered !== undefined && remembered.credential.credentialId === asserted.value.credentialId
          ? remembered
          : {
              version: 1,
              credential: { credentialId: asserted.value.credentialId },
              label: "Passkey",
              sessionKeys: 0,
              revealed: [],
            };
      return ok(open(asserted.value.prfOutput, record));
    } finally {
      setBusy(false);
    }
  }, [remembered, open]);

  const end = useCallback((): void => {
    accountRef.current?.end();
    accountRef.current = undefined;
    setViews(undefined);
    setActiveIndex(OWNER_INDEX);
    setBalance(undefined);
  }, []);

  const forget = useCallback((): void => {
    end();
    const storage = browserStorage();
    if (storage !== undefined) clearPasskeyRecord(storage);
    setRemembered(undefined);
  }, [end]);

  const deriveNext = useCallback((): Result<KeyView> => {
    const account = accountRef.current;
    if (account === undefined || remembered === undefined) {
      return err("No passkey is signed in. Create or use one from the Connect menu first.");
    }
    const derived = account.deriveNext();
    if (!derived.ok) return derived;
    const record: PasskeyRecord = { ...remembered, sessionKeys: account.sessionKeys.length };
    persist(record);
    refreshViews(record);
    return ok({
      index: derived.value.index,
      role: "session",
      label: keyLabel(derived.value.index),
      path: derived.value.path,
      address: derived.value.address,
      revealed: false,
    });
  }, [remembered, persist, refreshViews]);

  const reveal = useCallback(
    (index: number): Result<string> => {
      const account = accountRef.current;
      if (account === undefined || remembered === undefined) {
        return err("No passkey is signed in. Create or use one from the Connect menu first.");
      }
      const revealed = account.revealPrivateKey(index);
      if (!revealed.ok) return revealed;
      if (!remembered.revealed.includes(index)) {
        const record: PasskeyRecord = { ...remembered, revealed: [...remembered.revealed, index] };
        persist(record);
        refreshViews(record);
      }
      return revealed;
    },
    [remembered, persist, refreshViews],
  );

  const select = useCallback(
    (index: number): Result<KeyView> => {
      if (views === undefined) return err("No passkey is signed in, so there is no key to choose.");
      const chosen = index === OWNER_INDEX ? views.owner : views.sessionKeys.find((key) => key.index === index);
      if (chosen === undefined) {
        return err(
          isSessionKeyIndex(index)
            ? `${keyLabel(index)} has not been derived. Derive session keys in order from the Keys page.`
            : `There is no key at index ${index}.`,
        );
      }
      setActiveIndex(chosen.index);
      return ok(chosen);
    },
    [views],
  );

  const active = useMemo((): KeyView | undefined => {
    if (views === undefined) return undefined;
    return activeIndex === OWNER_INDEX ? views.owner : views.sessionKeys.find((key) => key.index === activeIndex);
  }, [views, activeIndex]);

  const refreshBalance = useCallback(async (): Promise<void> => {
    if (active === undefined) {
      setBalance(undefined);
      return;
    }
    const read = await readNativeBalance(chain, active.address);
    setBalance(
      read.ok
        ? { kind: "read", wei: read.value, address: active.address, chainId: chain.id }
        : { kind: "failed", message: read.message },
    );
  }, [active, chain]);

  // One read per key and chain. A reading for another key is never shown
  // under this one: the effect clears first, and the reading names its key.
  useEffect(() => {
    if (active === undefined) return undefined;
    let live = true;
    setBalance(undefined);
    void readNativeBalance(chain, active.address).then((read) => {
      if (!live) return;
      setBalance(
        read.ok
          ? { kind: "read", wei: read.value, address: active.address, chainId: chain.id }
          : { kind: "failed", message: read.message },
      );
    });
    return () => {
      live = false;
    };
  }, [active, chain]);

  const adoptChain = useCallback((spec: ChainSpec): Result<true> => {
    const next = passkeyChainFor(spec.id, spec.rpcUrl);
    if (next === undefined) return err(`Chain ${spec.id} is not a Monad network this Dashboard knows.`);
    setChain((current) => (current.id === next.id && current.rpcUrl === next.rpcUrl ? current : next));
    return ok(true);
  }, []);

  const send = useCallback(
    async (tx: { readonly to: string; readonly data: string; readonly value?: string }): Promise<Result<string>> => {
      const account = accountRef.current;
      if (account === undefined || active === undefined) {
        return err("No passkey is signed in. Create or use one from the Connect menu first.");
      }
      const key = account.keyAt(active.index);
      if (key === undefined) return err(`${active.label} is not available in this session.`);

      const provider = providerFor(chain);
      try {
        const signer = new SessionSigner(key.session, key.address, provider);
        const response = await signer.sendTransaction({
          to: tx.to,
          data: tx.data,
          ...(tx.value === undefined ? {} : { value: BigInt(tx.value) }),
        });
        // The balance moves once the block lands, about a second on Monad.
        setTimeout(() => void refreshBalance(), 2_000);
        return ok(response.hash);
      } catch (cause) {
        return err(describeSendFailure(cause, chain));
      } finally {
        provider.destroy();
      }
    },
    [active, chain, refreshBalance],
  );

  return useMemo<PasskeyConnection>(
    () => ({
      supported,
      remembered,
      signedIn: views !== undefined,
      busy,
      owner: views?.owner,
      sessionKeys: views?.sessionKeys ?? [],
      active,
      chain,
      balance,
      faucetUrl: chain.testnet ? MONAD_FAUCET_URL : undefined,
      create,
      signIn,
      end,
      forget,
      deriveNext,
      reveal,
      select,
      send,
      adoptChain,
      refreshBalance,
    }),
    [
      supported,
      remembered,
      views,
      busy,
      active,
      chain,
      balance,
      create,
      signIn,
      end,
      forget,
      deriveNext,
      reveal,
      select,
      send,
      adoptChain,
      refreshBalance,
    ],
  );
}
