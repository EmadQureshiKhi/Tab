"use client";

/**
 * One connection, shared by every route that needs one.
 *
 * ## Why a context rather than a hook per page
 *
 * Two routes now ask a wallet to sign: binding an address and registering a
 * Service. They need the same account, and a reader who connected on one and
 * found themselves disconnected on the other would reasonably conclude the site
 * had lost track of them. The masthead shows the connection, so it has to be the
 * same one the forms use.
 *
 * ## It never connects on its own
 *
 * On mount it asks `eth_accounts`, which reports an existing grant and prompts
 * nobody. A site that opens a wallet dialog because someone arrived at a page is
 * a site people close. Every prompt here follows a press.
 *
 * ## Two chains, and it says which
 *
 * Registry writes are Creditcoin; a Settlement is on the Source Chain. The
 * connection carries the chain the wallet is actually on, and the callers compare
 * that against the chain their action needs, so the mismatch is caught before a
 * transaction is built rather than after it reverts.
 *
 * Requirements: 24.5, 24.9, 24.10
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
import type { Result } from "./result";

export interface WalletState {
  /** True once the browser has been inspected. Before that nothing is known. */
  readonly ready: boolean;
  /** False when no wallet is installed, which is a different thing from not connected. */
  readonly available: boolean;
  /** Every wallet that announced itself, so the reader picks rather than the page. */
  readonly wallets: readonly DiscoveredWallet[];
  /** Which one is connected, for the label on the control. */
  readonly walletName: string | undefined;
  readonly account: string | undefined;
  readonly chainId: number | undefined;
  readonly connecting: boolean;
  /** The last failure, in a sentence. Cleared by the next attempt. */
  readonly error: string | undefined;
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

export function WalletProvider({ children }: { readonly children: ReactNode }) {
  /*
    Every wallet-driven write in this Dashboard goes through `send` below, which
    is why the announcement belongs there and not in each caller: three flows
    send four transactions between them, and hooking the one shared path is what
    stops a fifth being added later without one.
  */
  const { announce } = useTransactionToast();
  const [provider, setProvider] = useState<Eip1193Provider | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [chainId, setChainId] = useState<number | undefined>(undefined);
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
  */
  useEffect(() => {
    if (provider !== undefined) return undefined;
    const first = wallets[0];
    if (first === undefined) return undefined;

    let live = true;
    void (async () => {
      for (const candidate of wallets) {
        const existing = await silentAccount(candidate.provider);
        if (!live) return;
        if (existing !== undefined) {
          setProvider(candidate.provider);
          setWalletName(candidate.name);
          setAccount(existing);
          const chain = await currentChainId(candidate.provider);
          if (live && chain.ok) setChainId(chain.value);
          return;
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [wallets, provider]);

  // A wallet can change account or chain without this page asking, and a stale
  // account here would put a transaction in front of the wrong signer.
  useEffect(() => {
    if (provider === undefined) return undefined;
    const onAccounts = (accounts: readonly string[]): void => {
      setAccount(typeof accounts[0] === "string" ? accounts[0].toLowerCase() : undefined);
    };
    const onChain = (hex: string): void => {
      const parsed = Number.parseInt(hex, 16);
      setChainId(Number.isInteger(parsed) ? parsed : undefined);
    };
    provider.on?.("accountsChanged", onAccounts as (payload: never) => void);
    provider.on?.("chainChanged", onChain as (payload: never) => void);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts as (payload: never) => void);
      provider.removeListener?.("chainChanged", onChain as (payload: never) => void);
    };
  }, [provider]);

  const connect = useCallback(
    async (uuid?: string): Promise<Result<string>> => {
      setError(undefined);
      const chosen =
        uuid === undefined ? wallets[0] : wallets.find((entry) => entry.uuid === uuid);

      if (chosen === undefined) {
        const refusal = {
          ok: false as const,
          message:
            "No wallet answered. Install one that supports Creditcoin, then reload this page. Every read on this site works without one; only signing needs it.",
        };
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
        setProvider(chosen.provider);
        setWalletName(chosen.name);
        setAccount(result.value);
        const chain = await currentChainId(chosen.provider);
        if (chain.ok) setChainId(chain.value);
        return result;
      } finally {
        setConnecting(false);
      }
    },
    [wallets],
  );

  /*
    There is no wallet method for this. `wallet_revokePermissions` is not
    universal, and calling it would disconnect the wallet from the whole origin
    rather than from this tab, which is more than a reader asking to disconnect
    means. Forgetting the account here is what they asked for.
  */
  const disconnect = useCallback((): void => {
    setAccount(undefined);
    setProvider(undefined);
    setWalletName(undefined);
    setError(undefined);
  }, []);

  const ensureChain = useCallback(
    async (chain: ChainSpec): Promise<Result<true>> => {
      if (provider === undefined) return { ok: false, message: "No wallet is available in this browser." };
      if (chainId === chain.id) return { ok: true, value: true };
      const switched = await switchChain(provider, chain);
      if (switched.ok) setChainId(chain.id);
      else setError(switched.message);
      return switched;
    },
    [provider, chainId],
  );

  const send = useCallback(
    async (tx: { readonly to: string; readonly data: string; readonly value?: string }): Promise<Result<string>> => {
      if (provider === undefined) return { ok: false, message: "No wallet is available in this browser." };
      if (account === undefined) return { ok: false, message: "Connect a wallet before sending a transaction." };
      const sent = await sendTransaction(provider, { from: account, ...tx });
      if (!sent.ok) setError(sent.message);
      else {
        announce({
          hash: sent.value,
          title: "Transaction broadcast",
          detail: "It is on Creditcoin once the block that carries it is mined.",
        });
      }
      return sent;
    },
    [provider, account, announce],
  );

  const value = useMemo<WalletState>(
    () => ({
      ready,
      available: wallets.length > 0,
      wallets,
      walletName,
      account,
      chainId,
      connecting,
      error,
      connect,
      disconnect,
      ensureChain,
      send,
    }),
    [ready, wallets, walletName, account, chainId, connecting, error, connect, disconnect, ensureChain, send],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
