/**
 * Keeper configuration, read from the environment and never from a literal.
 *
 * The keeper is the one process in this workspace whose whole job is a
 * permissionless call: `TabBook.markDelinquent`. It needs a chain endpoint, the
 * two contract addresses, the registry read API that names the candidate tabs,
 * and, only when it broadcasts, a key with MON for gas. The HTTP surface adds a
 * port and a shared secret for `POST /tick`.
 *
 * Every name is a direct member read off the process environment on its own
 * line, because `scripts/env-check.mjs` finds reads statically and every read
 * must be declared in the tracked `.env.example`.
 */

import { err, ok, type Result } from "@tabai/shared";

export interface KeeperEnv {
  readonly MONAD_RPC_URL?: string | undefined;
  readonly MONAD_CHAIN_ID?: string | undefined;
  readonly TAB_BOOK_ADDRESS?: string | undefined;
  readonly SERVICE_REGISTRY_ADDRESS?: string | undefined;
  readonly NEXT_PUBLIC_REGISTRY_API_URL?: string | undefined;
  readonly KEEPER_PRIVATE_KEY?: string | undefined;
  readonly KEEPER_PORT?: string | undefined;
  readonly KEEPER_SHARED_SECRET?: string | undefined;
  readonly KEEPER_MAX_FEED_PAGES?: string | undefined;
}

/** The process environment, restricted to what the keeper reads. One name per line. */
export function processKeeperEnv(): KeeperEnv {
  return {
    MONAD_RPC_URL: process.env.MONAD_RPC_URL,
    MONAD_CHAIN_ID: process.env.MONAD_CHAIN_ID,
    TAB_BOOK_ADDRESS: process.env.TAB_BOOK_ADDRESS,
    SERVICE_REGISTRY_ADDRESS: process.env.SERVICE_REGISTRY_ADDRESS,
    NEXT_PUBLIC_REGISTRY_API_URL: process.env.NEXT_PUBLIC_REGISTRY_API_URL,
    KEEPER_PRIVATE_KEY: process.env.KEEPER_PRIVATE_KEY,
    KEEPER_PORT: process.env.KEEPER_PORT,
    KEEPER_SHARED_SECRET: process.env.KEEPER_SHARED_SECRET,
    KEEPER_MAX_FEED_PAGES: process.env.KEEPER_MAX_FEED_PAGES,
  };
}

export interface KeeperConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly tabBook: string;
  readonly serviceRegistry: string;
  readonly registryUrl: string;
  /** Absent on a dry run. Present only when the value is a real 32-byte key. */
  readonly keeperKey: string | undefined;
  readonly port: number;
  /** Absent means `POST /tick` is refused outright. */
  readonly sharedSecret: string | undefined;
  /** How many pages of the delivery feed one tick will walk before it refuses to judge. */
  readonly maxFeedPages: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

const invalid = (name: string, why: string): Result<never> =>
  err({
    category: "VALIDATION",
    code: "KEEPER_CONFIG_INVALID",
    message: `${name} ${why}`,
    retryable: false,
    details: { variable: name },
  });

function requiredAddress(raw: string | undefined, name: string): Result<string> {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return invalid(name, "is required and is unset or empty");
  if (!ADDRESS.test(value)) return invalid(name, "must be a 20-byte 0x address");
  if (value.toLowerCase() === ZERO_ADDRESS) {
    return invalid(name, "is the zero-address placeholder, so the contract it names is not deployed yet");
  }
  return ok(value.toLowerCase());
}

function integer(raw: string | undefined, name: string, fallback: number, minimum: number, maximum: number): Result<number> {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return ok(fallback);
  if (!/^\d+$/.test(value)) return invalid(name, "must be a non-negative integer");
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) return invalid(name, `must be between ${minimum} and ${maximum}`);
  return ok(parsed);
}

/** Loads the configuration, or names the first variable that is wrong. A pure function of a plain map. */
export function loadKeeperConfig(env: KeeperEnv = processKeeperEnv()): Result<KeeperConfig> {
  const rpcUrl = env.MONAD_RPC_URL?.trim();
  if (rpcUrl === undefined || rpcUrl.length === 0) return invalid("MONAD_RPC_URL", "is required and is unset or empty");

  const chainIdRaw = env.MONAD_CHAIN_ID?.trim();
  if (chainIdRaw === undefined || !/^\d+$/.test(chainIdRaw)) return invalid("MONAD_CHAIN_ID", "must be a decimal chain id");

  const tabBook = requiredAddress(env.TAB_BOOK_ADDRESS, "TAB_BOOK_ADDRESS");
  if (!tabBook.ok) return tabBook;
  const serviceRegistry = requiredAddress(env.SERVICE_REGISTRY_ADDRESS, "SERVICE_REGISTRY_ADDRESS");
  if (!serviceRegistry.ok) return serviceRegistry;

  const registryUrl = env.NEXT_PUBLIC_REGISTRY_API_URL?.trim();
  if (registryUrl === undefined || registryUrl.length === 0) {
    return invalid("NEXT_PUBLIC_REGISTRY_API_URL", "is required: the delivery feed is where the candidate tabs come from");
  }
  if (!/^https?:\/\//.test(registryUrl)) return invalid("NEXT_PUBLIC_REGISTRY_API_URL", "must be an http(s) URL");

  const port = integer(env.KEEPER_PORT, "KEEPER_PORT", 8791, 1, 65_535);
  if (!port.ok) return port;
  const maxFeedPages = integer(env.KEEPER_MAX_FEED_PAGES, "KEEPER_MAX_FEED_PAGES", 200, 1, 100_000);
  if (!maxFeedPages.ok) return maxFeedPages;

  // A key that is present but unfilled reads as "ready to broadcast" right up to
  // the moment it is used. The template's placeholder is deliberately not hex.
  const rawKey = env.KEEPER_PRIVATE_KEY?.trim();
  const keeperKey = rawKey !== undefined && /^0x[0-9a-fA-F]{64}$/.test(rawKey) ? rawKey : undefined;

  const rawSecret = env.KEEPER_SHARED_SECRET?.trim();
  const sharedSecret = rawSecret === undefined || rawSecret.length === 0 ? undefined : rawSecret;

  return ok({
    rpcUrl,
    chainId: Number.parseInt(chainIdRaw, 10),
    tabBook: tabBook.value,
    serviceRegistry: serviceRegistry.value,
    registryUrl: registryUrl.replace(/\/+$/, ""),
    keeperKey,
    port: port.value,
    sharedSecret,
    maxFeedPages: maxFeedPages.value,
  });
}

/** The keeper key, or an error naming the variable, for a run that must broadcast. */
export function requireKeeperKey(config: KeeperConfig): Result<string> {
  if (config.keeperKey === undefined) {
    return err({
      category: "VALIDATION",
      code: "KEEPER_KEY_MISSING",
      message: "KEEPER_PRIVATE_KEY is unset or is still the template placeholder, so this run can judge tabs but cannot mark one",
      retryable: false,
      details: { variable: "KEEPER_PRIVATE_KEY" },
    });
  }
  return ok(config.keeperKey);
}
