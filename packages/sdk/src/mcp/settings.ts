/**
 * Where the MCP server gets its settings, and the order it prefers them in.
 *
 * Three sources, most specific first:
 *
 * 1. the options handed to {@link resolveTabMcpSettings}, which is what a test
 *    and an embedding host use;
 * 2. `tab.config.{ts,mts,mjs,js,cjs}`, discovered by walking up from the working
 *    directory -- the mechanism this package already has for consumer
 *    configuration, so the MCP surface adds no second one;
 * 3. the environment, which is what the `mcpServers` stanza `tab connect` writes
 *    actually carries.
 *
 * Every environment variable read here is already declared in the tracked
 * `.env.example` contract. That is not incidental: the repository's environment
 * gate extracts every `process.env` read in the tree and fails the build when
 * one has no declaration, so a new name would be a new line in a contract this
 * surface has no business changing. The RPC endpoint is `MONAD_RPC_URL`, in the
 * stanza and here.
 *
 * ## No key is a setting
 *
 * Nothing in this module reads a private key and nothing returns one. The
 * settlement signing key is read from the environment at the moment a Settlement
 * is signed, by the strategy that signs it, and never travels through a config
 * file or an MCP client's `mcpServers` stanza. That is what makes `tab connect`
 * safe to run against a file the client software rewrites.
 *
 * The hosted demo Service is the one place a key is used outside a Settlement:
 * its gateway refuses an unsigned metered call, so the entry this module fills
 * in signs each call with `AGENT_PRIVATE_KEY`, read at the moment the call is
 * signed and only when that key is the Agent the call is metered against. The
 * Agent itself is an address, from `AGENT_ADDRESS` when nothing else names one.
 */

import type { Address } from "@tabai/shared";
import { CHAINS, MAINNET_ASSETS, MONAD_MAINNET, TAB_HOSTED, TESTNET_ASSETS, isAddress, isMonadChainId } from "@tabai/shared";
import type { AssetRef } from "../payments/strategy.js";
import { Wallet } from "ethers";

import type { TabServiceEntry } from "../payments/config.js";
import { loadTabConfig, type TabConfig } from "../payments/config.js";
import { defaultLogger, type Logger } from "../logger.js";
import { agentSignedMetering } from "../http/metering-claim.js";
import type { X402SignerFactory } from "../x402/client.js";

/** The settings every tool reads. Each field is resolved or explicitly absent. */
export interface TabMcpSettings {
  /** Whose Open Tab a metered call lands on. Undefined until one is configured. */
  readonly agent: Address | undefined;
  /** Absolute base URL of the registry read API, or undefined when none is configured. */
  readonly registryUrl: string | undefined;
  /** The Monad JSON-RPC endpoint, used by `doctor` and by nothing that signs. */
  readonly rpcUrl: string | undefined;
  /**
   * Where a Settlement goes when no `tab.config` registers a strategy: the hosted
   * deployment's `TabSettlement` and the Assets it settles in, on this network.
   * Undefined when the hosted defaults are off or the chain is not Monad.
   */
  readonly hostedSettlement:
    | { readonly tabSettlement: Address; readonly assets: Readonly<Record<string, AssetRef>>; readonly rpcUrl: string }
    | undefined;
  /** The EVM chain id every Asset is named against: 143 for Mainnet, 10143 for Testnet. */
  readonly chainId: number;
  /** Where a Monad transaction is linked. Always resolved; a default is fine for a link. */
  readonly explorerUrl: string;
  /** The endpoint directory, keyed by lower-case serviceId. */
  readonly services: readonly TabServiceEntry[];
  /** Which strategy `tab_settle` settles through when the call names none. */
  readonly strategyId: string | undefined;
  /**
   * The x402 signer factory, for `tab_call`'s prepaid fallback. Never called
   * while settings are resolved; only when a refused call carries an offer.
   */
  readonly x402: X402SignerFactory | undefined;
  /** Where each setting came from, so `doctor` can print it. */
  readonly sources: Readonly<Record<string, string>>;
}

/** Explicit settings, which beat both the config file and the environment. */
export interface TabMcpSettingsOptions {
  readonly agent?: string;
  readonly chainId?: number;
  readonly registryUrl?: string;
  /**
   * Whether the project's hosted read API and demo Service fill in what nothing
   * else names. Default true; `TAB_HOSTED_DEFAULTS=off` in the environment
   * turns them off as well.
   */
  readonly hostedDefaults?: boolean;
  readonly rpcUrl?: string;
  readonly explorerUrl?: string;
  readonly services?: readonly TabServiceEntry[];
  readonly strategyId?: string;
  readonly x402?: X402SignerFactory;
  /** Where the `tab.config` walk starts. Defaults to the working directory. */
  readonly cwd?: string;
  /** `false` skips config discovery entirely, which is what a hermetic test wants. */
  readonly config?: TabConfig | false;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
}

/** The public Monad Testnet explorer, used when nothing names one. */
export const DEFAULT_EXPLORER_URL = "https://testnet.monadvision.com";

/** Monad Testnet, used when nothing names a chain. */
export const DEFAULT_CHAIN_ID = 10143;

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text === undefined || text === "" ? undefined : text;
};

/**
 * The registry read API the environment names.
 *
 * `NEXT_PUBLIC_REGISTRY_API_URL` is the deployment's own name for this value and
 * is already in the environment contract, so it is what is read. When only
 * `REGISTRY_PORT` is set the read API is taken to be local, which is exactly the
 * developer case and saves a second variable that would say the same thing.
 */
const registryUrlFromEnv = (env: NodeJS.ProcessEnv): { url: string; source: string } | undefined => {
  const declared = trimmed(env["NEXT_PUBLIC_REGISTRY_API_URL"]);
  if (declared !== undefined) return { url: declared, source: "env NEXT_PUBLIC_REGISTRY_API_URL" };
  const port = trimmed(env["REGISTRY_PORT"]);
  if (port !== undefined && /^[0-9]{1,5}$/.test(port)) {
    return { url: `http://127.0.0.1:${port}`, source: "env REGISTRY_PORT" };
  }
  return undefined;
};

/** Keeps the first entry for each serviceId, so a more specific source wins. */
function mergeServices(...groups: readonly (readonly TabServiceEntry[])[]): readonly TabServiceEntry[] {
  const byId = new Map<string, TabServiceEntry>();
  for (const group of groups) {
    for (const entry of group) {
      if (typeof entry?.serviceId !== "string" || typeof entry?.endpoint !== "string") continue;
      const key = entry.serviceId.toLowerCase();
      if (!byId.has(key)) byId.set(key, { ...entry, serviceId: key });
    }
  }
  return [...byId.values()];
}

/**
 * Resolves the settings, loading `tab.config` unless one was handed in.
 *
 * Never fails. A config file that cannot be imported is logged and skipped
 * rather than taking the server down: the tools each report their own missing
 * settings by name, which is a better message than a startup failure that names
 * a file the caller may not have known existed.
 */
export async function resolveTabMcpSettings(
  options: TabMcpSettingsOptions = {},
): Promise<TabMcpSettings> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? defaultLogger;
  const sources: Record<string, string> = {};

  let config: TabConfig = {};
  if (options.config === undefined) {
    const loaded = await loadTabConfig({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      registry: false,
      logger,
    });
    if (loaded.ok) {
      config = loaded.value.config;
      if (loaded.value.path !== undefined) sources["config"] = loaded.value.path;
    } else {
      logger.warn("tab config could not be loaded; continuing without it", {
        code: loaded.error.code,
        message: loaded.error.message,
      });
    }
  } else if (options.config !== false) {
    config = options.config;
    sources["config"] = "supplied";
  }

  const pick = (
    key: string,
    explicit: string | undefined,
    fromConfig: string | undefined,
    fromEnv: { value: string; source: string } | undefined,
  ): string | undefined => {
    if (trimmed(explicit) !== undefined) {
      sources[key] = "options";
      return trimmed(explicit);
    }
    if (trimmed(fromConfig) !== undefined) {
      sources[key] = "tab.config";
      return trimmed(fromConfig);
    }
    if (fromEnv !== undefined) {
      sources[key] = fromEnv.source;
      return fromEnv.value;
    }
    return undefined;
  };

  const envAgent = trimmed(env["AGENT_ADDRESS"]);
  const rawAgent = pick(
    "agent",
    options.agent,
    config.agent,
    envAgent === undefined ? undefined : { value: envAgent, source: "env AGENT_ADDRESS" },
  );
  const agent = rawAgent !== undefined && isAddress(rawAgent) ? (rawAgent.toLowerCase() as Address) : undefined;
  if (rawAgent !== undefined && agent === undefined) {
    logger.warn("the configured agent is not a 20-byte address and was ignored", { agent: rawAgent });
    delete sources["agent"];
  }

  const envRpc = trimmed(env["MONAD_RPC_URL"]);
  const rpcUrl = pick(
    "rpcUrl",
    options.rpcUrl,
    undefined,
    envRpc === undefined ? undefined : { value: envRpc, source: "env MONAD_RPC_URL" },
  );

  const envChain = trimmed(env["MONAD_CHAIN_ID"]);
  const chainIdText = pick(
    "chainId",
    options.chainId === undefined ? undefined : String(options.chainId),
    undefined,
    envChain === undefined ? undefined : { value: envChain, source: "env MONAD_CHAIN_ID" },
  );
  const chainId = chainIdText !== undefined && /^[0-9]+$/.test(chainIdText) ? Number(chainIdText) : DEFAULT_CHAIN_ID;

  /*
    What this project hosts on the chosen network: its read API and its demo
    Service. The lowest-priority source for both, so anything configured wins,
    and switched off with TAB_HOSTED_DEFAULTS=off for a setup that must reach
    nothing it did not name.
  */
  const hosted =
    options.hostedDefaults !== false && trimmed(env["TAB_HOSTED_DEFAULTS"]) !== "off" && isMonadChainId(chainId)
      ? TAB_HOSTED[chainId]
      : undefined;

  const envRegistry = registryUrlFromEnv(env);
  let registryUrl = pick(
    "registryUrl",
    options.registryUrl,
    config.registryUrl,
    envRegistry === undefined ? undefined : { value: envRegistry.url, source: envRegistry.source },
  );
  if (registryUrl === undefined && hosted !== undefined) {
    registryUrl = hosted.registryUrl;
    sources["registryUrl"] = "default (the project's hosted read API)";
  }

  const envExplorer = trimmed(env["MONAD_EXPLORER_URL"]);
  const explorerUrl =
    pick(
      "explorerUrl",
      options.explorerUrl,
      undefined,
      envExplorer === undefined ? undefined : { value: envExplorer, source: "env MONAD_EXPLORER_URL" },
    ) ?? (isMonadChainId(chainId) ? CHAINS[chainId].explorerUrl : DEFAULT_EXPLORER_URL);

  const configured = mergeServices(options.services ?? [], config.services ?? []);
  if (configured.length > 0) sources["services"] = options.services === undefined ? "tab.config" : "options";
  /*
    The hosted gateway meters only a signed call, so the demo Service signs with
    the Agent's own key when one is in the environment. The key is read per call
    and never held here, and a key for any other address signs nothing.
  */
  const agentKey = () => {
    const key = trimmed(env["AGENT_PRIVATE_KEY"]);
    if (key === undefined) return undefined;
    try {
      return new Wallet(key);
    } catch {
      return undefined;
    }
  };
  const services =
    hosted === undefined
      ? configured
      : mergeServices(configured, [{ ...hosted.demoService, headers: agentSignedMetering(agentKey) }]);
  if (configured.length === 0 && services.length > 0) sources["services"] = "default (the project's hosted demo Service)";

  const strategyId = trimmed(options.strategyId);
  if (strategyId !== undefined) sources["strategyId"] = "options";

  const x402 = options.x402 ?? (typeof config.x402 === "function" ? config.x402 : undefined);
  if (x402 !== undefined) sources["x402"] = options.x402 === undefined ? "tab.config" : "options";

  const hostedSettlement =
    hosted === undefined || !isMonadChainId(chainId)
      ? undefined
      : (() => {
          const listed = chainId === MONAD_MAINNET.chainId
            ? Object.values(MAINNET_ASSETS)
            : [
                ...Object.values(TESTNET_ASSETS),
                ...("testAsset" in hosted && hosted.testAsset !== undefined
                  ? [{ symbol: "mUSDC", decimals: 6, address: hosted.testAsset }]
                  : []),
              ];
          const assets: Record<string, AssetRef> = {};
          for (const asset of listed) {
            const address = asset.address.toLowerCase() as Address;
            assets[chainId + ":" + address] = { chainId: BigInt(chainId), address, decimals: asset.decimals, symbol: asset.symbol };
          }
          return { tabSettlement: hosted.tabSettlement as Address, assets, rpcUrl: rpcUrl ?? CHAINS[chainId].rpcUrl };
        })();

  return {
    agent,
    registryUrl,
    rpcUrl,
    hostedSettlement,
    chainId,
    explorerUrl,
    services,
    strategyId,
    x402,
    sources,
  };
}
