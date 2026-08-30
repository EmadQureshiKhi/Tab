/**
 * Configuration, read from the environment and never from a literal.
 *
 * Every address this service watches comes out of the environment. The deployed
 * addresses are recorded in `deployments.json` at the repository root, and that
 * file is the operator's source for the values — but it is deployment output, not
 * code, so nothing here reads it and nothing here hardcodes an address. A
 * redeployment is then a change to one environment block and to no source file.
 *
 * The loader is a pure function of a plain map, so a test can exercise every
 * rejection path without touching `process.env`. Failures name the variable and
 * what was wrong with it, and never print the value — `DATABASE_URL` carries a
 * password.
 *
 * Requirements: 12.6, 24.4, 28.6
 */

import type { EventSource } from "./events.js";

/** Chain id of Creditcoin CC3 Testnet, which is what the provider is pinned to. */
export const CREDITCOIN_CC3_TESTNET_CHAIN_ID = 102031;

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
  /** The five contracts whose logs are indexed, by name, lowercase hex. */
  readonly addresses: Readonly<Record<EventSource, string>>;
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
 * provider filtering on the zero address returns nothing at all — an indexer that
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

/**
 * Reads the configuration.
 *
 * @throws Error naming the offending variable. Never prints a value.
 */
export function loadConfig(env: EnvironmentMap): RegistryConfig {
  const addresses: Record<EventSource, string> = {
    SettlementVerifier: address(env, "SETTLEMENT_VERIFIER_ADDRESS"),
    TabBook: address(env, "TAB_BOOK_ADDRESS"),
    AgentRegistry: address(env, "AGENT_REGISTRY_ADDRESS"),
    ServiceRegistry: address(env, "SERVICE_REGISTRY_ADDRESS"),
    Bond: address(env, "BOND_ADDRESS"),
  };

  const config: RegistryConfig = {
    rpcUrl: required(env, "CREDITCOIN_RPC_URL"),
    chainId: integer(env, "CREDITCOIN_CHAIN_ID", CREDITCOIN_CC3_TESTNET_CHAIN_ID, 1),
    batchMaxCount: integer(env, "RPC_BATCH_MAX_COUNT", 1, 1),
    addresses,
    databaseUrl: required(env, "DATABASE_URL"),
    port: integer(env, "REGISTRY_PORT", 8787, 1),
    startBlock: integer(env, "REGISTRY_START_BLOCK", 0, 0),
    pollIntervalMs: integer(env, "REGISTRY_POLL_INTERVAL_MS", 5000, 250),
    logChunkBlocks: integer(env, "REGISTRY_LOG_CHUNK_BLOCKS", 2000, 1),
    reorgWindowBlocks: integer(env, "REGISTRY_REORG_WINDOW_BLOCKS", 32, 0),
  };

  const duplicated = new Set<string>();
  const seen = new Set<string>();
  for (const value of Object.values(config.addresses)) {
    if (seen.has(value)) duplicated.add(value);
    seen.add(value);
  }
  if (duplicated.size > 0) {
    throw new ConfigError(
      "config: two watched contracts are configured at the same address, so one of the five address variables is wrong",
    );
  }

  return config;
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
  CREDITCOIN_RPC_URL: process.env.CREDITCOIN_RPC_URL,
  CREDITCOIN_CHAIN_ID: process.env.CREDITCOIN_CHAIN_ID,
  RPC_BATCH_MAX_COUNT: process.env.RPC_BATCH_MAX_COUNT,
  SETTLEMENT_VERIFIER_ADDRESS: process.env.SETTLEMENT_VERIFIER_ADDRESS,
  TAB_BOOK_ADDRESS: process.env.TAB_BOOK_ADDRESS,
  AGENT_REGISTRY_ADDRESS: process.env.AGENT_REGISTRY_ADDRESS,
  SERVICE_REGISTRY_ADDRESS: process.env.SERVICE_REGISTRY_ADDRESS,
  BOND_ADDRESS: process.env.BOND_ADDRESS,
  DATABASE_URL: process.env.DATABASE_URL,
  REGISTRY_PORT: process.env.REGISTRY_PORT,
  REGISTRY_START_BLOCK: process.env.REGISTRY_START_BLOCK,
  REGISTRY_POLL_INTERVAL_MS: process.env.REGISTRY_POLL_INTERVAL_MS,
  REGISTRY_LOG_CHUNK_BLOCKS: process.env.REGISTRY_LOG_CHUNK_BLOCKS,
  REGISTRY_REORG_WINDOW_BLOCKS: process.env.REGISTRY_REORG_WINDOW_BLOCKS,
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
