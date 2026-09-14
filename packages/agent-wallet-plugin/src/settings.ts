/**
 * Where the plugin's settings come from.
 *
 * Seven names from the environment, each already declared in the repository's
 * tracked `.env.example`. Testnet is the default chain, and the deployment
 * recorded for whichever chain is named is the fallback for every address. Nothing here is a key: the only
 * key this plugin ever uses is the one MetaMask Agent Wallet holds, and it never
 * leaves the host.
 *
 * ## Every read is one name on one line
 *
 * The repository's environment gate finds each read of the process environment
 * statically, so the names are spelled out rather than looped over. A test hands
 * in a plain object instead, which is why {@link resolvePluginSettings} takes
 * the environment as a parameter.
 */

import type { Address, Result } from "@tabai/sdk";
import { ok } from "@tabai/sdk";
import { validationError } from "@tabai/sdk";

import { DEFAULT_CHAIN_ID, MAINNET_CHAIN_ID, TESTNET_DEFAULTS, deploymentDefaults } from "./defaults.js";

/** The environment names this plugin reads. */
export interface PluginEnv {
  readonly TAB_BOOK_ADDRESS?: string | undefined;
  readonly TAB_SETTLEMENT_ADDRESS?: string | undefined;
  readonly NEXT_PUBLIC_REGISTRY_API_URL?: string | undefined;
  readonly MONAD_CHAIN_ID?: string | undefined;
  readonly MONAD_RPC_URL?: string | undefined;
  readonly MONAD_EXPLORER_URL?: string | undefined;
  readonly MOCK_USDC_ADDRESS?: string | undefined;
}

/** The process environment, restricted to what the plugin reads. */
export function processPluginEnv(): PluginEnv {
  return {
    TAB_BOOK_ADDRESS: process.env.TAB_BOOK_ADDRESS,
    TAB_SETTLEMENT_ADDRESS: process.env.TAB_SETTLEMENT_ADDRESS,
    NEXT_PUBLIC_REGISTRY_API_URL: process.env.NEXT_PUBLIC_REGISTRY_API_URL,
    MONAD_CHAIN_ID: process.env.MONAD_CHAIN_ID,
    MONAD_RPC_URL: process.env.MONAD_RPC_URL,
    MONAD_EXPLORER_URL: process.env.MONAD_EXPLORER_URL,
    MOCK_USDC_ADDRESS: process.env.MOCK_USDC_ADDRESS,
  };
}

export interface PluginSettings {
  /** 10143 for Testnet, 143 for Mainnet. */
  readonly chainId: number;
  readonly tabBook: Address;
  readonly tabSettlement: Address;
  /** The registry read API, or undefined when nothing names one. The SDK reports the absence by name. */
  readonly registryUrl: string | undefined;
  /**
   * A Monad JSON-RPC endpoint, when one is named. With it the plugin reads the
   * chain through it; without it the reads go through the wallet's own RPC
   * client for the chain, which needs the `wallet-read` capability.
   */
  readonly rpcUrl: string | undefined;
  readonly explorerUrl: string;
  /**
   * The Testnet test token, so the SDK can name it `mUSDC` with its decimals.
   * Undefined on Mainnet, where every Asset is a real one the SDK already knows.
   */
  readonly mockUsdc: Address | undefined;
  /** Where each setting came from, printed by every command so a wrong address is visible. */
  readonly sources: Readonly<Record<string, string>>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text === undefined || text === "" ? undefined : text;
};

/**
 * An address from the environment, or the recorded deployment's for that chain.
 *
 * The zero address is the template's own placeholder and is refused rather than
 * used: a `.env` copied from `.env.example` and never filled would otherwise
 * point every call at nothing, with an error message a step later that names
 * no variable.
 */
function addressSetting(
  raw: string | undefined,
  name: string,
  chainId: number,
  fallback: Address,
  sources: Record<string, string>,
): Result<Address> {
  const value = trimmed(raw);
  if (value === undefined) {
    sources[name] = `default (Monad ${chainId === MAINNET_CHAIN_ID ? "Mainnet" : "Testnet"} deployment)`;
    return ok(fallback);
  }
  if (!ADDRESS.test(value)) {
    return validationError("ADDRESS_MALFORMED", `${name} must be a 20-byte 0x address, received \`${value}\``, {
      details: { variable: name },
    });
  }
  if (value.toLowerCase() === ZERO_ADDRESS) {
    return validationError(
      "ADDRESS_PLACEHOLDER",
      `${name} is the zero-address placeholder from .env.example; unset it to use the recorded deployment, or set the deployed address`,
      { details: { variable: name } },
    );
  }
  sources[name] = `env ${name}`;
  return ok(value.toLowerCase() as Address);
}

/** Resolves the settings from a plain environment object. Never throws. */
export function resolvePluginSettings(env: PluginEnv): Result<PluginSettings> {
  const sources: Record<string, string> = {};

  const chainText = trimmed(env.MONAD_CHAIN_ID);
  let chainId = DEFAULT_CHAIN_ID;
  if (chainText !== undefined) {
    if (!/^[0-9]+$/.test(chainText)) {
      return validationError("CHAIN_ID_MALFORMED", `MONAD_CHAIN_ID must be a decimal chain id, received \`${chainText}\``, {
        details: { variable: "MONAD_CHAIN_ID" },
      });
    }
    chainId = Number(chainText);
    if (chainId !== DEFAULT_CHAIN_ID && chainId !== MAINNET_CHAIN_ID) {
      return validationError(
        "CHAIN_ID_UNSUPPORTED",
        `MONAD_CHAIN_ID ${chainText} is not a Monad network; use ${DEFAULT_CHAIN_ID} for Testnet or ${MAINNET_CHAIN_ID} for Mainnet`,
        { details: { variable: "MONAD_CHAIN_ID", chainId: chainText } },
      );
    }
    sources["MONAD_CHAIN_ID"] = "env MONAD_CHAIN_ID";
  } else {
    sources["MONAD_CHAIN_ID"] = "default (Monad Testnet)";
  }

  const recorded = deploymentDefaults(chainId);
  const tabBook = addressSetting(env.TAB_BOOK_ADDRESS, "TAB_BOOK_ADDRESS", chainId, recorded.tabBook, sources);
  if (!tabBook.ok) return tabBook;
  const tabSettlement = addressSetting(
    env.TAB_SETTLEMENT_ADDRESS,
    "TAB_SETTLEMENT_ADDRESS",
    chainId,
    recorded.tabSettlement,
    sources,
  );
  if (!tabSettlement.ok) return tabSettlement;

  const registryUrl = trimmed(env.NEXT_PUBLIC_REGISTRY_API_URL);
  if (registryUrl !== undefined) sources["NEXT_PUBLIC_REGISTRY_API_URL"] = "env NEXT_PUBLIC_REGISTRY_API_URL";

  const rpcUrl = trimmed(env.MONAD_RPC_URL);
  if (rpcUrl !== undefined) sources["MONAD_RPC_URL"] = "env MONAD_RPC_URL";

  let mockUsdc: Address | undefined;
  if (chainId === DEFAULT_CHAIN_ID) {
    const mock = addressSetting(env.MOCK_USDC_ADDRESS, "MOCK_USDC_ADDRESS", chainId, TESTNET_DEFAULTS.mockUsdc, sources);
    if (!mock.ok) return mock;
    mockUsdc = mock.value;
  }

  const explorerFromEnv = trimmed(env.MONAD_EXPLORER_URL);
  const explorerUrl =
    explorerFromEnv ?? recorded.explorerUrl;
  sources["MONAD_EXPLORER_URL"] = explorerFromEnv === undefined ? "default" : "env MONAD_EXPLORER_URL";

  return ok({
    chainId,
    tabBook: tabBook.value,
    tabSettlement: tabSettlement.value,
    registryUrl,
    rpcUrl,
    explorerUrl,
    mockUsdc,
    sources,
  });
}

/** A transaction link on the configured explorer. */
export const explorerTxUrl = (settings: PluginSettings, txHash: string): string =>
  `${settings.explorerUrl.replace(/\/+$/, "")}/tx/${txHash}`;
