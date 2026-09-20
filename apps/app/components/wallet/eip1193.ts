/**
 * The wallet surface this Dashboard uses, and nothing beyond it.
 *
 * Described structurally rather than imported, which is why there is no wallet
 * library here. Everything this product asks a wallet to do is four methods and
 * two events, and a connector library would be a large client dependency for a
 * site whose every other route needs no wallet at all.
 *
 * Nothing in this file throws. A wallet is a hostile boundary - it can be absent,
 * it can refuse, it can be on another chain, it can return a shape nobody
 * expected - so every call returns a `Result` and every failure carries a
 * sentence a reader can act on.
 */

import { type Result, err, ok } from "./result";

/** The subset of EIP-1193 this product calls. */
export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  on?(event: string, handler: (payload: never) => void): void;
  removeListener?(event: string, handler: (payload: never) => void): void;
}

/** The injected provider, or nothing. Reads `window` lazily so it is SSR-safe. */
export function injectedProvider(): Eip1193Provider | undefined {
  const candidate = (globalThis as { ethereum?: Eip1193Provider }).ethereum;
  return typeof candidate?.request === "function" ? candidate : undefined;
}

/** A chain this product asks a wallet to be on. */
export interface ChainSpec {
  readonly id: number;
  readonly name: string;
  /** Only needed to add the chain to a wallet that does not know it. */
  readonly rpcUrl?: string;
  readonly explorerUrl?: string;
  readonly currency?: { readonly name: string; readonly symbol: string; readonly decimals: number };
}

/** The native currency on both Monad networks. Gas is paid in it. */
export const MON = { name: "MON", symbol: "MON", decimals: 18 } as const;

/** Monad Testnet, chain id 10143 (`0x279f`). */
export const MONAD_TESTNET_CHAIN: ChainSpec = {
  id: 10143,
  name: "Monad Testnet",
  rpcUrl: "https://testnet-rpc.monad.xyz",
  explorerUrl: "https://testnet.monadvision.com",
  currency: MON,
};

/** Monad Mainnet, chain id 143 (`0x8f`). */
export const MONAD_MAINNET_CHAIN: ChainSpec = {
  id: 143,
  name: "Monad Mainnet",
  rpcUrl: "https://rpc.monad.xyz",
  explorerUrl: "https://monadvision.com",
  currency: MON,
};

/**
 * The two chains Tab can be deployed to, keyed by chain id.
 *
 * Written out here rather than imported from `@tabai/shared`, because this
 * folder is a client bundle and the shared package carries ABI tables it has no
 * use for. The values are the same and `test/` is where that is checked.
 */
export const MONAD_CHAINS: Readonly<Record<number, ChainSpec>> = {
  [MONAD_TESTNET_CHAIN.id]: MONAD_TESTNET_CHAIN,
  [MONAD_MAINNET_CHAIN.id]: MONAD_MAINNET_CHAIN,
};

/** The chain id as `wallet_switchEthereumChain` takes it: hex, no padding. */
export function chainIdHex(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

function message(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  return fallback;
}

/** Asks for accounts. The first is the one every call here signs with. */
export async function requestAccount(provider: Eip1193Provider): Promise<Result<string>> {
  try {
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as unknown;
    const first = Array.isArray(accounts) ? accounts[0] : undefined;
    if (typeof first !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(first)) {
      return err("The wallet connected but returned no account, so there is nothing to sign with.");
    }
    return ok(first.toLowerCase());
  } catch (cause) {
    return err(message(cause, "The wallet refused the connection and gave no reason."));
  }
}

/** Accounts already granted, without prompting. Used to restore a session. */
export async function silentAccount(provider: Eip1193Provider): Promise<string | undefined> {
  try {
    const accounts = (await provider.request({ method: "eth_accounts" })) as unknown;
    const first = Array.isArray(accounts) ? accounts[0] : undefined;
    return typeof first === "string" ? first.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Which chain the wallet is on. */
export async function currentChainId(provider: Eip1193Provider): Promise<Result<number>> {
  try {
    const raw = (await provider.request({ method: "eth_chainId" })) as unknown;
    const parsed = typeof raw === "string" ? Number.parseInt(raw, 16) : Number.NaN;
    if (!Number.isInteger(parsed)) return err("The wallet did not say which chain it is on.");
    return ok(parsed);
  } catch (cause) {
    return err(message(cause, "The wallet did not say which chain it is on."));
  }
}

/**
 * Moves the wallet to a chain, adding it first where the wallet has never heard
 * of it.
 *
 * 4902 is the code for that, and Monad is not yet in every wallet's shipped
 * list, so without the add step a first-time reader hits a dead end that reads
 * like a bug in this site. The parameters sent are exactly the ones a wallet's
 * "add network" dialog shows, so a reader can check them against the Monad
 * documentation before accepting.
 */
export async function switchChain(
  provider: Eip1193Provider,
  chain: ChainSpec,
): Promise<Result<true>> {
  const hex = chainIdHex(chain.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    return ok(true);
  } catch (cause) {
    const code = (cause as { code?: number } | null)?.code;
    if (code !== 4902 || chain.rpcUrl === undefined) {
      return err(message(cause, `The wallet would not switch to ${chain.name}.`));
    }
    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hex,
            chainName: chain.name,
            rpcUrls: [chain.rpcUrl],
            nativeCurrency: chain.currency ?? MON,
            ...(chain.explorerUrl === undefined ? {} : { blockExplorerUrls: [chain.explorerUrl] }),
          },
        ],
      });
      return ok(true);
    } catch (addCause) {
      return err(message(addCause, `${chain.name} could not be added to the wallet.`));
    }
  }
}

/**
 * Moves the wallet to the Monad network a deployment runs on.
 *
 * A chain id outside the two Monad networks is refused rather than sent to the
 * wallet, because a wallet asked to add a chain this product cannot name would
 * show the reader a dialog this site cannot vouch for.
 */
export async function switchToMonad(
  provider: Eip1193Provider,
  chainId: number,
): Promise<Result<true>> {
  const chain = MONAD_CHAINS[chainId];
  if (chain === undefined) {
    return err(`Chain ${chainId} is not a Monad network this Dashboard knows.`);
  }
  return switchChain(provider, chain);
}

/** Sends a transaction and returns its hash. */
export async function sendTransaction(
  provider: Eip1193Provider,
  tx: { readonly from: string; readonly to: string; readonly data: string; readonly value?: string },
): Promise<Result<string>> {
  try {
    const hash = (await provider.request({ method: "eth_sendTransaction", params: [tx] })) as unknown;
    if (typeof hash !== "string") return err("The wallet accepted the transaction but returned no hash.");
    return ok(hash);
  } catch (cause) {
    const code = (cause as { code?: number } | null)?.code;
    // 4001 is the user closing the dialog. That is a decision, not a fault, and
    // it should not be reported in the language of an error.
    if (code === 4001) return err("Cancelled in the wallet. Nothing was sent.");
    return err(message(cause, "The transaction was not sent, and the wallet gave no reason."));
  }
}
