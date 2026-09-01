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
 * surface has no business changing. The design sketches the stanza with
 * `TAB_RPC_URL`; the deployed name for the same value is `CREDITCOIN_RPC_URL`
 * and that is what is used, in the stanza and here.
 *
 * ## No key is a setting
 *
 * Nothing in this module reads a private key and nothing returns one. The
 * settlement signing key is read from the environment at the moment a Settlement
 * is signed, by the strategy that signs it, and never travels through a config
 * file or an MCP client's `mcpServers` stanza. That is what makes `tab connect`
 * safe to run against a file the client software rewrites.
 *
 * Requirements: 25.3, 25.5, 28.6
 */

import type { Address } from "@tabai/shared";
import { isAddress } from "@tabai/shared";

import type { TabServiceEntry } from "../payments/config.js";
import { loadTabConfig, type TabConfig } from "../payments/config.js";
import { defaultLogger, type Logger } from "../logger.js";

/** The settings every tool reads. Each field is resolved or explicitly absent. */
export interface TabMcpSettings {
  /** Whose Open Tab a metered call lands on. Undefined until one is configured. */
  readonly agent: Address | undefined;
  /** Absolute base URL of the registry read API, or undefined when none is configured. */
  readonly registryUrl: string | undefined;
  /** The Creditcoin JSON-RPC endpoint, used by `doctor` and by nothing that signs. */
  readonly rpcUrl: string | undefined;
  /** Where a Creditcoin transaction is linked. Always resolved; a default is fine for a link. */
  readonly explorerUrl: string;
  /** The endpoint directory, keyed by lower-case serviceId. */
  readonly services: readonly TabServiceEntry[];
  /** Which strategy `tab_settle` settles through when the call names none. */
  readonly strategyId: string | undefined;
  /** Where each setting came from, so `doctor` can print it. */
  readonly sources: Readonly<Record<string, string>>;
}

/** Explicit settings, which beat both the config file and the environment. */
export interface TabMcpSettingsOptions {
  readonly agent?: string;
  readonly registryUrl?: string;
  readonly rpcUrl?: string;
  readonly explorerUrl?: string;
  readonly services?: readonly TabServiceEntry[];
  readonly strategyId?: string;
  /** Where the `tab.config` walk starts. Defaults to the working directory. */
  readonly cwd?: string;
  /** `false` skips config discovery entirely, which is what a hermetic test wants. */
  readonly config?: TabConfig | false;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
}

/** The public Creditcoin CC3 Testnet explorer, used when nothing names one. */
export const DEFAULT_EXPLORER_URL = "https://creditcoin-testnet.blockscout.com";

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

  const rawAgent = pick("agent", options.agent, config.agent, undefined);
  const agent = rawAgent !== undefined && isAddress(rawAgent) ? (rawAgent.toLowerCase() as Address) : undefined;
  if (rawAgent !== undefined && agent === undefined) {
    logger.warn("the configured agent is not a 20-byte address and was ignored", { agent: rawAgent });
    delete sources["agent"];
  }

  const envRegistry = registryUrlFromEnv(env);
  const registryUrl = pick(
    "registryUrl",
    options.registryUrl,
    config.registryUrl,
    envRegistry === undefined ? undefined : { value: envRegistry.url, source: envRegistry.source },
  );

  const envRpc = trimmed(env["CREDITCOIN_RPC_URL"]);
  const rpcUrl = pick(
    "rpcUrl",
    options.rpcUrl,
    undefined,
    envRpc === undefined ? undefined : { value: envRpc, source: "env CREDITCOIN_RPC_URL" },
  );

  const envExplorer = trimmed(env["CREDITCOIN_EXPLORER_URL"]);
  const explorerUrl =
    pick(
      "explorerUrl",
      options.explorerUrl,
      undefined,
      envExplorer === undefined ? undefined : { value: envExplorer, source: "env CREDITCOIN_EXPLORER_URL" },
    ) ?? DEFAULT_EXPLORER_URL;

  const services = mergeServices(options.services ?? [], config.services ?? []);
  if (services.length > 0) sources["services"] = options.services === undefined ? "tab.config" : "options";

  const strategyId = trimmed(options.strategyId);
  if (strategyId !== undefined) sources["strategyId"] = "options";

  return {
    agent,
    registryUrl,
    rpcUrl,
    explorerUrl,
    services,
    strategyId,
    sources,
  };
}
