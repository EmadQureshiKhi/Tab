"use client";

/**
 * One connection, shared by every route that needs one.
 *
 * ## Why a context rather than a hook per page
 *
 * Four routes ask a wallet to sign: `/authorise`, `/services/new`,
 * `/services/bond` and `/keys`. They need the same account, and a reader who
 * connected on one and found themselves disconnected on another would reasonably conclude
 * the site had lost track of them. The masthead shows the connection, so it has
 * to be the same one the forms use.
 *
 * ## Two kinds of connection, one surface
 *
 * An injected wallet (EIP-1193, found through EIP-6963) or a passkey account
 * (Mera, keys derived from the passkey's PRF output). A page that signs does
 * not know which it has: `account`, `chainId`, `ensureChain` and `send` mean
 * the same thing for both, and `kind` says which is behind them for the copy
 * that wants to say so. The two are exclusive; connecting one ends the other,
 * because "which account signs" must have exactly one answer.
 *
 * ## It never connects on its own
 *
 * On mount it asks `eth_accounts`, which reports an existing grant and prompts
 * nobody, and reads which passkey this browser remembers, which prompts nobody
 * either. A site that opens a wallet dialog or a biometric prompt because
 * someone arrived at a page is a site people close. Every prompt here follows a
 * press.
 *
 * ## One chain, and it says which
 *
 * Everything Tab signs is on the Monad network the visitor selected on the
 * masthead. The connection carries the chain the wallet is actually on, and
 * the callers compare that against the chain their action needs, so a wallet
 * left on some other network is caught before a transaction is built rather
 * than after it reverts. A passkey account follows the selected network and
 * takes the page's own chain and endpoint when asked to sign.
 */

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  type ChainSpec,
  type Eip1193Provider,
  currentChainId,
  requestAccount,
  sendTransaction,
  silentAccount,
  switchChain,
} from "./eip1193";
import { type DiscoveredWallet, watchWallets } from "./discovery";
import { useTransactionToast } from "../shell/transaction-toast";
import { type PasskeyConnection, type SelectedNetwork, usePasskeyConnection } from "../passkey/use-passkey";
import type { Result } from "./result";

/** What stands behind the connected account. */
export type ConnectionKind = "injected" | "passkey";

export interface WalletState {
  /** True once the browser has been inspected. Before that nothing is known. */
  readonly ready: boolean;
  /** False when no wallet is installed, which is a different thing from not connected. */
  readonly available: boolean;
  /** Every wallet that announced itself, so the reader picks rather than the page. */
  readonly wallets: readonly DiscoveredWallet[];
  /** Which one is connected, for the label on the control. */
  readonly walletName: string | undefined;
  /** Injected wallet or passkey account. Undefined while nothing is connected. */
  readonly kind: ConnectionKind | undefined;
  /** Lowercase, so callers can compare it with addresses the index reports. */
  readonly account: string | undefined;
  readonly chainId: number | undefined;
  readonly connecting: boolean;
  /** The last failure, in a sentence. Cleared by the next attempt. */
  readonly error: string | undefined;
  /** The passkey side of the connection: its keys, its balance, its ceremonies. */
  readonly passkey: PasskeyConnection;
  /**
   * Connects an injected wallet by uuid, or the obvious thing without one: the
   * first announced wallet, else the passkey this browser remembers.
   */
  connect(uuid?: string): Promise<Result<string>>;
  disconnect(): void;
  ensureChain(chain: ChainSpec): Promise<Result<true>>;
  send(tx: { readonly to: string; readonly data: string; readonly value?: string }): Promise<Result<string>>;
}

const WalletContext = createContext<WalletState | undefined>(undefined);

/** The connection, or a refusal that says why. Never throws. */
export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (value === undefined) {
    // A component that reads this outside the provider is a wiring mistake, and a
    // thrown error at render is the only way it gets noticed. It cannot happen at
    // runtime: the provider is mounted in the root layout.
    throw new Error("useWallet was called outside WalletProvider");
  }
  return value;
}

const NOTHING_TO_CONNECT =
  "No wallet is available in this browser. Install one that can add Monad, or create a passkey account from Connect in the masthead. Every read on this site works without one; only signing needs it.";

export function WalletProvider({
  children,
  network,
}: {
  readonly children: ReactNode;
  /** The network the visitor selected, which a passkey account signs on. */
  readonly network: SelectedNetwork;
}) {
  /*
    Every wallet-driven write in this Dashboard goes through `send` below, which
    is why the announcement belongs there and not in each caller: three flows
    send four transactions between them, and hooking the one shared path is what
    stops a fifth being added later without one.
  */
  const { announce } = useTransactionToast();
  const passkey = usePasskeyConnection(network);
  const [provider, setProvider] = useState<Eip1193Provider | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [injectedAccount, setInjectedAccount] = useState<string | undefined>(undefined);
  const [injectedChainId, setInjectedChainId] = useState<number | undefined>(undefined);
  const [connecting, setConnecting] = useState(false);
  const [walletName, setWalletName] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const [wallets, setWallets] = useState<readonly DiscoveredWallet[]>([]);

  // Discovery, and nothing else. Announcements can arrive at any time, so the
  // list is state rather than a one-off read.
  useEffect(() => {
    const stop = watchWallets(setWallets);
    // One frame is enough for every installed wallet to have answered. Anything
    // still silent after it is not installed, which is a finding rather than a
    // wait, and the control needs to be able to say so.
    const settle = setTimeout(() => setReady(true), 120);
    return () => {
      stop();
      clearTimeout(settle);
    };
  }, []);

  /*
    Restores an existing grant without prompting, and only once a wallet is
    known. `eth_accounts` reports what was already permitted; a site that opened
    a wallet dialog because someone arrived at a page is a site people close.
    A passkey signed in meanwhile wins: it followed a press, and this did not.
  */
  useEffect(() => {
    if (provider !== undefined || passkey.signedIn) return undefined;
    const first = wallets[0];
    if (first === undefined) return undefined;

    let live = true;
    void (async () => {
      for (const candidate of wallets) {
        const existing = await silentAccount(candidate.provider);
        if (!live) return;
        if (existing !== undefined) {
          // The chain is read before anything is set: setting the provider re-runs this
          // effect, and a read still in flight then would be dropped as stale, leaving
          // the page showing an unknown chain for a wallet that is on the right one.
          const chain = await currentChainId(candidate.provider);
          if (!live) return;
          setProvider(candidate.provider);
          setWalletName(candidate.name);
          setInjectedAccount(existing);
          if (chain.ok) setInjectedChainId(chain.value);
          return;
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [wallets, provider, passkey.signedIn]);

  // A wallet can change account or chain without this page asking, and a stale
  // account here would put a transaction in front of the wrong signer.
  useEffect(() => {
    if (provider === undefined) return undefined;
    const onAccounts = (accounts: readonly string[]): void => {
      setInjectedAccount(typeof accounts[0] === "string" ? accounts[0].toLowerCase() : undefined);
    };
    const onChain = (hex: string): void => {
      const parsed = Number.parseInt(hex, 16);
      setInjectedChainId(Number.isInteger(parsed) ? parsed : undefined);
    };
    provider.on?.("accountsChanged", onAccounts as (payload: never) => void);
    provider.on?.("chainChanged", onChain as (payload: never) => void);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts as (payload: never) => void);
      provider.removeListener?.("chainChanged", onChain as (payload: never) => void);
    };
  }, [provider]);

  const forgetInjected = useCallback((): void => {
    setInjectedAccount(undefined);
    setProvider(undefined);
    setWalletName(undefined);
    setInjectedChainId(undefined);
  }, []);

  const connect = useCallback(
    async (uuid?: string): Promise<Result<string>> => {
      setError(undefined);
      const chosen =
        uuid === undefined ? wallets[0] : wallets.find((entry) => entry.uuid === uuid);

      if (chosen === undefined) {
        // Nothing injected, but a passkey this browser remembers is the obvious
        // thing to connect, and the press that got here is the press it needs.
        if (uuid === undefined && passkey.supported && passkey.remembered !== undefined) {
          setConnecting(true);
          try {
            const signed = await passkey.signIn();
            if (!signed.ok) setError(signed.message);
            else forgetInjected();
            return signed;
          } finally {
            setConnecting(false);
          }
        }
        const refusal = { ok: false as const, message: NOTHING_TO_CONNECT };
        setError(refusal.message);
        return refusal;
      }

      setConnecting(true);
      try {
        const result = await requestAccount(chosen.provider);
        if (!result.ok) {
          setError(result.message);
          return result;
        }
        // One connection at a time. The passkey's keys are zeroed, not merely hidden.
        passkey.end();
        setProvider(chosen.provider);
        setWalletName(chosen.name);
        setInjectedAccount(result.value);
        const chain = await currentChainId(chosen.provider);
        if (chain.ok) setInjectedChainId(chain.value);
        return result;
      } finally {
        setConnecting(false);
      }
    },
    [wallets, passkey, forgetInjected],
  );

  // Signing in with a passkey from its own controls also has to displace an
  // injected connection, and those controls do not go through `connect`.
  useEffect(() => {
    if (passkey.signedIn && provider !== undefined) forgetInjected();
  }, [passkey.signedIn, provider, forgetInjected]);

  /*
    There is no wallet method for this. `wallet_revokePermissions` is not
    universal, and calling it would disconnect the wallet from the whole origin
    rather than from this tab, which is more than a reader asking to disconnect
    means. Forgetting the account here is what they asked for. For a passkey it
    is more than forgetting: the seed and every session are zeroed.
  */
  const disconnect = useCallback((): void => {
    if (passkey.signedIn) passkey.end();
    forgetInjected();
    setError(undefined);
  }, [passkey, forgetInjected]);

  const kind: WalletState["kind"] = passkey.signedIn ? "passkey" : injectedAccount !== undefined ? "injected" : undefined;
  const account = passkey.signedIn ? passkey.active?.address.toLowerCase() : injectedAccount;
  const chainId = passkey.signedIn ? passkey.chain.id : injectedChainId;
  const name = passkey.signedIn
    ? `Passkey${passkey.active === undefined ? "" : ` (${passkey.active.label.toLowerCase()})`}`
    : walletName;

  const ensureChain = useCallback(
    async (chain: ChainSpec): Promise<Result<true>> => {
      if (passkey.signedIn) {
        const adopted = passkey.adoptChain(chain);
        if (!adopted.ok) setError(adopted.message);
        return adopted;
      }
      if (provider === undefined) return { ok: false, message: "No wallet is available in this browser." };
      if (injectedChainId === chain.id) return { ok: true, value: true };
      const switched = await switchChain(provider, chain);
      if (switched.ok) setInjectedChainId(chain.id);
      else setError(switched.message);
      return switched;
    },
    [passkey, provider, injectedChainId],
  );

  const send = useCallback(
    async (tx: { readonly to: string; readonly data: string; readonly value?: string }): Promise<Result<string>> => {
      let sent: Result<string>;
      if (passkey.signedIn) {
        sent = await passkey.send(tx);
      } else {
        if (provider === undefined) return { ok: false, message: "No wallet is available in this browser." };
        if (injectedAccount === undefined) return { ok: false, message: "Connect a wallet before sending a transaction." };
        sent = await sendTransaction(provider, { from: injectedAccount, ...tx });
      }
      if (!sent.ok) setError(sent.message);
      else {
        announce({
          hash: sent.value,
          title: "Transaction broadcast",
          detail: "It is on Monad once the block that carries it is finalised.",
        });
      }
      return sent;
    },
    [passkey, provider, injectedAccount, announce],
  );

  const value = useMemo<WalletState>(
    () => ({
      ready,
      available: wallets.length > 0,
      wallets,
      walletName: name,
      kind,
      account,
      chainId,
      connecting: connecting || passkey.busy,
      error,
      passkey,
      connect,
      disconnect,
      ensureChain,
      send,
    }),
    [ready, wallets, name, kind, account, chainId, connecting, passkey, error, connect, disconnect, ensureChain, send],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
