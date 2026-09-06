/**
 * The wallet surface this Dashboard uses, and nothing beyond it.
 *
 * Described structurally rather than imported, which is why there is no wallet
 * library here. Everything this product asks a wallet to do is four methods and
 * two events, and a connector library would be a large client dependency for a
 * site whose every other route needs no wallet at all (R24.9).
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
 * 4902 is the code for that, and Creditcoin CC3 is not in any wallet's shipped
 * list, so without the add step every first-time reader hits a dead end that
 * reads like a bug in this site.
 */
export async function switchChain(
  provider: Eip1193Provider,
  chain: ChainSpec,
): Promise<Result<true>> {
  const hex = `0x${chain.id.toString(16)}`;
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
            nativeCurrency: chain.currency ?? { name: "Creditcoin", symbol: "CTC", decimals: 18 },
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
