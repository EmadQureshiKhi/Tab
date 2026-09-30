/**
 * Configuration, read from the environment and never from a literal.
 *
 * Every address this service watches comes out of the environment. The deployed
 * addresses are recorded in `deployments.json` at the repository root, and that
 * file is the operator's source for the values, but it is deployment output, not
 * code, so nothing here reads it and nothing here hardcodes an address. A
 * redeployment is then a change to one environment block and to no source file.
 *
 * The loader is a pure function of a plain map, so a test can exercise every
 * rejection path without touching `process.env`. Failures name the variable and
 * what was wrong with it, and never print the value, `DATABASE_URL` carries a
 * password.
 */

import { canonicalErc8004Registries } from "./erc8004.js";
import type { TabContract } from "./events.js";

/** Chain id of Monad Testnet, which is what the provider is pinned to unless told otherwise. */
export const MONAD_TESTNET_CHAIN_ID = 10143;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface RegistryConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  /**
   * Several endpoints on this network reject JSON-RPC batching outright, so the
   * provider is constructed with a batch size of one. `.env.example` pins
   * `RPC_BATCH_MAX_COUNT=1` and this is the value that reaches the provider.
   */
  readonly batchMaxCount: number;
  /** Tab's four contracts whose logs are indexed, by name, lowercase hex. */
  readonly addresses: Readonly<Record<TabContract, string>>;
  /**
   * The ERC-8004 registries, or `null` when identity is off for this deployment.
   *
   * Defaults to the canonical addresses for the chain id, so a Monad deployment
   * gets identity without naming anything. `ERC8004_IDENTITY_REGISTRY_ADDRESS`
   * overrides the Identity registry; setting it to the zero address switches
   * identity off, which is the one place the zero address is an instruction
   * rather than an unfilled placeholder. The Reputation registry is read-only and
   * optional: without it, reputation is served as unavailable and named so.
   */
  readonly erc8004: {
    readonly identityRegistry: string;
    readonly reputationRegistry: string | null;
  } | null;
  /**
   * Envio HyperSync, the fast log source for catch-up, or `null` to read every
   * range from the RPC. See `hypersync.ts` for what it is used for and what it
   * is not.
   */
  readonly hypersync: {
    readonly url: string;
    /** Sent as the client's bearer token. Required by the public instances. */
    readonly apiToken: string | null;
    /** Ranges that end within this many blocks of the head are read from the RPC. */
    readonly liveWindowBlocks: number;
    /** Blocks per HyperSync request during catch-up. */
    readonly chunkBlocks: number;
  } | null;
  /**
   * Nansen, the off-chain label overlay, or `null` when no key is configured.
   * `chain` is the Nansen chain slug the lookup is scoped to; `all` searches
   * every chain that shares the address format.
   */
  readonly nansen: { readonly apiKey: string; readonly chain: string } | null;
  /**
   * The Nansen profile, bought per call over x402 in Mainnet USDC and kept for a
   * week. `payerKey` is null when unset, and stored profiles are still served;
   * `dailyBudget` is the most spent on it over any 24 hours, in USDC base units.
   */
  readonly nansenProfile: { readonly payerKey: string | null; readonly dailyBudget: bigint };
  readonly databaseUrl: string;
  readonly port: number;
  /**
   * First block scanned on a cold start. The deployment block of the earliest
   * watched contract is the right value; anything lower costs a long catch-up and
   * anything higher silently loses history.
   */
  readonly startBlock: number;
  readonly pollIntervalMs: number;
  /** Blocks per `eth_getLogs` request during catch-up. */
  readonly logChunkBlocks: number;
  /**
   * Depth, in blocks, that every poll re-scans and rewrites. This is what makes
   * the indexer reorganisation-tolerant: see `indexer.ts`.
   */
  readonly reorgWindowBlocks: number;
}

/** What a caller needs, when it needs less than everything. */
export type EnvironmentMap = Readonly<Record<string, string | undefined>>;

class ConfigError extends Error {}

const required = (env: EnvironmentMap, name: string): string => {
  const raw = env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    throw new ConfigError(`config: ${name} is required and is unset or empty`);
  }
  return raw;
};

const integer = (env: EnvironmentMap, name: string, fallback: number, min: number): number => {
  const raw = env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`config: ${name} must be a non-negative integer`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new ConfigError(`config: ${name} must be an integer of at least ${min}`);
  }
  return value;
};

/**
 * A 20-byte address, lowercased.
 *
 * The zero address is rejected by name. `.env.example` ships every address slot
 * as the zero address, so an unfilled environment is the expected mistake, and a
 * provider filtering on the zero address returns nothing at all, an indexer that
 * looks healthy and indexes nothing.
 */
const address = (env: EnvironmentMap, name: string): string => {
  const raw = required(env, name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new ConfigError(`config: ${name} is not a 20-byte hex address`);
  }
  const lowered = raw.toLowerCase();
  if (lowered === ZERO_ADDRESS) {
    throw new ConfigError(
      `config: ${name} is the zero address, which is the unfilled placeholder from .env.example`,
    );
  }
  return lowered;
};

const optional = (env: EnvironmentMap, name: string): string | null => {
  const raw = env[name]?.trim();
  return raw === undefined || raw.length === 0 ? null : raw;
};

/**
 * An address that may be left unset, with the zero address meaning "off".
 *
 * Returns `undefined` when the variable is unset, so the caller can fall back to a
 * chain default, and `null` when it is the zero address, which here is an explicit
 * instruction rather than the unfilled placeholder it is for a Tab contract.
 */
const optionalAddress = (env: EnvironmentMap, name: string): string | null | undefined => {
  const raw = optional(env, name);
  if (raw === null) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new ConfigError(`config: ${name} is not a 20-byte hex address`);
  }
  const lowered = raw.toLowerCase();
  return lowered === ZERO_ADDRESS ? null : lowered;
};

/**
 * The ERC-8004 block of the configuration: the chain's canonical registries
 * unless overridden, and off when the Identity registry is overridden to zero or
 * the chain has no canonical deployment.
 */
function loadErc8004(env: EnvironmentMap, chainId: number): RegistryConfig["erc8004"] {
  const canonical = canonicalErc8004Registries(chainId);
  const identity = optionalAddress(env, "ERC8004_IDENTITY_REGISTRY_ADDRESS");
  const reputation = optionalAddress(env, "ERC8004_REPUTATION_REGISTRY_ADDRESS");
  const identityRegistry = identity === undefined ? (canonical?.identity ?? null) : identity;
  if (identityRegistry === null) return null;
  const reputationRegistry = reputation === undefined ? (canonical?.reputation ?? null) : reputation;
  return { identityRegistry, reputationRegistry };
}

function loadHypersync(env: EnvironmentMap): RegistryConfig["hypersync"] {
  const url = optional(env, "HYPERSYNC_URL");
  if (url === null) return null;
  if (!/^https?:\/\//.test(url)) {
    throw new ConfigError("config: HYPERSYNC_URL must be an http(s) URL");
  }
  return {
    url,
    apiToken: optional(env, "HYPERSYNC_API_TOKEN"),
    liveWindowBlocks: integer(env, "HYPERSYNC_LIVE_WINDOW_BLOCKS", 512, 0),
    chunkBlocks: integer(env, "HYPERSYNC_CHUNK_BLOCKS", 100_000, 1),
  };
}

function loadNansen(env: EnvironmentMap): RegistryConfig["nansen"] {
  const apiKey = optional(env, "NANSEN_API_KEY");
  if (apiKey === null) return null;
  const chain = optional(env, "NANSEN_CHAIN") ?? "all";
  if (!/^[a-z0-9-]+$/.test(chain)) {
    throw new ConfigError("config: NANSEN_CHAIN must be a lowercase chain slug such as monad or all");
  }
  return { apiKey, chain };
}

function loadNansenProfile(env: EnvironmentMap): RegistryConfig["nansenProfile"] {
  const payerKey = optional(env, "NANSEN_X402_PRIVATE_KEY");
  if (payerKey !== null && !/^0x[0-9a-fA-F]{64}$/.test(payerKey)) {
    throw new ConfigError("config: NANSEN_X402_PRIVATE_KEY must be a 32-byte hex private key");
  }
  const budget = optional(env, "NANSEN_DAILY_BUDGET_BASE_UNITS") ?? "250000";
  if (!/^[0-9]+$/.test(budget)) {
    throw new ConfigError("config: NANSEN_DAILY_BUDGET_BASE_UNITS must be a whole number of USDC base units");
  }
  return { payerKey, dailyBudget: BigInt(budget) };
}

/**
 * Reads the configuration.
 *
 * @throws Error naming the offending variable. Never prints a value.
 */
export function loadConfig(env: EnvironmentMap): RegistryConfig {
  const addresses: Record<TabContract, string> = {
    TabBook: address(env, "TAB_BOOK_ADDRESS"),
    TabSettlement: address(env, "TAB_SETTLEMENT_ADDRESS"),
    ServiceRegistry: address(env, "SERVICE_REGISTRY_ADDRESS"),
    Bond: address(env, "BOND_ADDRESS"),
  };
  const chainId = integer(env, "MONAD_CHAIN_ID", MONAD_TESTNET_CHAIN_ID, 1);

  const config: RegistryConfig = {
    rpcUrl: required(env, "MONAD_RPC_URL"),
    chainId,
    batchMaxCount: integer(env, "RPC_BATCH_MAX_COUNT", 1, 1),
    addresses,
    erc8004: loadErc8004(env, chainId),
    hypersync: loadHypersync(env),
    nansen: loadNansen(env),
    nansenProfile: loadNansenProfile(env),
    databaseUrl: required(env, "DATABASE_URL"),
    port: integer(env, "REGISTRY_PORT", 8787, 1),
    startBlock: integer(env, "REGISTRY_START_BLOCK", 0, 0),
    pollIntervalMs: integer(env, "REGISTRY_POLL_INTERVAL_MS", 5000, 250),
    logChunkBlocks: integer(env, "REGISTRY_LOG_CHUNK_BLOCKS", 100, 1),
    reorgWindowBlocks: integer(env, "REGISTRY_REORG_WINDOW_BLOCKS", 32, 0),
  };

  const duplicated = new Set<string>();
  const seen = new Set<string>();
  const watched = [
    ...Object.values(config.addresses),
    ...(config.erc8004 === null ? [] : [config.erc8004.identityRegistry]),
  ];
  for (const value of watched) {
    if (seen.has(value)) duplicated.add(value);
    seen.add(value);
  }
  if (duplicated.size > 0) {
    throw new ConfigError(
      "config: two watched contracts are configured at the same address, so one of the address variables is wrong",
    );
  }

  return config;
}

/**
 * Every address the log source watches, by the name the decoder files its events
 * under. The Identity registry is present only when identity is on.
 */
export function watchedAddresses(config: RegistryConfig): Readonly<Record<string, string>> {
  return {
    ...config.addresses,
    ...(config.erc8004 === null ? {} : { IdentityRegistry: config.erc8004.identityRegistry }),
  };
}

/**
 * The environment this service reads, named one variable at a time.
 *
 * Written out rather than handing `process.env` straight to {@link loadConfig},
 * for two reasons. It is the complete list of what the process touches, so a
 * reader needs no grep to find it. And the completeness check extracts
 * `process.env.*` reads to assert every one is declared in `.env.example`, so
 * spelling each name here is what keeps that gate meaningful for this workspace
 * instead of vacuous.
 */
export const readProcessEnvironment = (): EnvironmentMap => ({
  MONAD_RPC_URL: process.env.MONAD_RPC_URL,
  MONAD_CHAIN_ID: process.env.MONAD_CHAIN_ID,
  RPC_BATCH_MAX_COUNT: process.env.RPC_BATCH_MAX_COUNT,
  TAB_BOOK_ADDRESS: process.env.TAB_BOOK_ADDRESS,
  TAB_SETTLEMENT_ADDRESS: process.env.TAB_SETTLEMENT_ADDRESS,
  SERVICE_REGISTRY_ADDRESS: process.env.SERVICE_REGISTRY_ADDRESS,
  BOND_ADDRESS: process.env.BOND_ADDRESS,
  DATABASE_URL: process.env.DATABASE_URL,
  REGISTRY_PORT: process.env.REGISTRY_PORT,
  REGISTRY_START_BLOCK: process.env.REGISTRY_START_BLOCK,
  REGISTRY_POLL_INTERVAL_MS: process.env.REGISTRY_POLL_INTERVAL_MS,
  REGISTRY_LOG_CHUNK_BLOCKS: process.env.REGISTRY_LOG_CHUNK_BLOCKS,
  REGISTRY_REORG_WINDOW_BLOCKS: process.env.REGISTRY_REORG_WINDOW_BLOCKS,
  ERC8004_IDENTITY_REGISTRY_ADDRESS: process.env.ERC8004_IDENTITY_REGISTRY_ADDRESS,
  ERC8004_REPUTATION_REGISTRY_ADDRESS: process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS,
  HYPERSYNC_URL: process.env.HYPERSYNC_URL,
  HYPERSYNC_API_TOKEN: process.env.HYPERSYNC_API_TOKEN,
  HYPERSYNC_LIVE_WINDOW_BLOCKS: process.env.HYPERSYNC_LIVE_WINDOW_BLOCKS,
  HYPERSYNC_CHUNK_BLOCKS: process.env.HYPERSYNC_CHUNK_BLOCKS,
  NANSEN_API_KEY: process.env.NANSEN_API_KEY,
  NANSEN_CHAIN: process.env.NANSEN_CHAIN,
  NANSEN_X402_PRIVATE_KEY: process.env.NANSEN_X402_PRIVATE_KEY,
  NANSEN_DAILY_BUDGET_BASE_UNITS: process.env.NANSEN_DAILY_BUDGET_BASE_UNITS,
  TEAM_ADDRESSES_PATH: process.env.TEAM_ADDRESSES_PATH,
});

/**
 * The configuration a chain reader needs, which is everything except the
 * database. Useful for a keyless read against the live chain with no Postgres in
 * reach.
 */
export type ChainConfig = Omit<RegistryConfig, "databaseUrl" | "port">;

export function loadChainConfig(env: EnvironmentMap): ChainConfig {
  return loadConfig({ ...env, DATABASE_URL: env.DATABASE_URL ?? "postgres://unused" });
}
