/**
 * Gateway configuration, read from the environment and never from a literal.
 *
 * The gateway is the Service side of the rail. It meters delivered work into an
 * Agent's Open Tab on Creditcoin, which means it holds the Service operator's key
 * and is the only component here that can spend CTC. Everything it needs to do
 * that comes out of the environment, and every name below is already declared in
 * the tracked `.env.example`, so this file introduces no new variable.
 *
 * ## Every read is written out one name at a time, deliberately
 *
 * `scripts/env-check.mjs` extracts environment reads statically and fails the build
 * when one has no declaration in the tracked `.env.example`. It only recognises a direct member read off the process
 * environment, so reaching those values through a captured record would leave the gate green while this service read undeclared variables,
 * which is the "passes and checks nothing" failure the repository takes seriously.
 * The names below are therefore spelled out one per line rather than looped over.
 *
 * ## Nothing throws
 *
 * A malformed value comes back as a `TabError` naming the variable. A metering
 * service that dies on startup with a stack trace tells an operator less than one
 * that names the variable it could not parse, and the Service operator is often
 * not the person who wrote the deployment.
 *
 * Requirements: 12.1, 12.2, 12.3, 23.3, 28.6
 */

import { err, ok, type Result } from "@tabai/shared";

/** The environment names this service reads, written out so the gate can see them. */
export interface GatewayEnv {
  readonly CREDITCOIN_RPC_URL?: string | undefined;
  readonly CREDITCOIN_CHAIN_ID?: string | undefined;
  readonly TAB_BOOK_ADDRESS?: string | undefined;
  readonly SERVICE_REGISTRY_ADDRESS?: string | undefined;
  readonly BOND_ADDRESS?: string | undefined;
  readonly GATEWAY_PRIVATE_KEY?: string | undefined;
  readonly RPC_BATCH_MAX_COUNT?: string | undefined;
  readonly CREDIT_BASELINE_BASE_UNITS?: string | undefined;
  readonly GROWTH_FACTOR_BPS?: string | undefined;
}

/**
 * The process environment, restricted to what the gateway reads.
 *
 * One name per line, so `scripts/env-check.mjs` can see every read.
 */
export function processGatewayEnv(): GatewayEnv {
  return {
    CREDITCOIN_RPC_URL: process.env.CREDITCOIN_RPC_URL,
    CREDITCOIN_CHAIN_ID: process.env.CREDITCOIN_CHAIN_ID,
    TAB_BOOK_ADDRESS: process.env.TAB_BOOK_ADDRESS,
    SERVICE_REGISTRY_ADDRESS: process.env.SERVICE_REGISTRY_ADDRESS,
    BOND_ADDRESS: process.env.BOND_ADDRESS,
    GATEWAY_PRIVATE_KEY: process.env.GATEWAY_PRIVATE_KEY,
    RPC_BATCH_MAX_COUNT: process.env.RPC_BATCH_MAX_COUNT,
    CREDIT_BASELINE_BASE_UNITS: process.env.CREDIT_BASELINE_BASE_UNITS,
    GROWTH_FACTOR_BPS: process.env.GROWTH_FACTOR_BPS,
  };
}

export interface GatewayConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  /** Several endpoints on this network refuse JSON-RPC batching, so this defaults to 1. */
  readonly batchMaxCount: number;
  readonly tabBook: string;
  readonly serviceRegistry: string;
  readonly bond: string;
  /**
   * The Service operator's key. Absent on a read-only run, which is the default:
   * simulating a delivery needs no key at all, and only a broadcast does.
   */
  readonly operatorKey: string | undefined;
  /** `LimitLib.Params.baseline`, in Asset base units. */
  readonly baseline: bigint;
  /** `LimitLib.Params.growthFactorBps`. */
  readonly growthFactorBps: bigint;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

const invalid = (name: string, why: string): Result<never> =>
  err({
    category: "VALIDATION",
    code: "GATEWAY_CONFIG_INVALID",
    message: `${name} ${why}`,
    retryable: false,
    details: { variable: name },
  });

/** An address that must be present and must not be the zero placeholder. */
function requiredAddress(raw: string | undefined, name: string): Result<string> {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return invalid(name, "is required and is unset or empty");
  if (!ADDRESS.test(value)) return invalid(name, "must be a 20-byte 0x address");
  if (value.toLowerCase() === ZERO_ADDRESS) {
    return invalid(name, "is the zero-address placeholder, so the contract it names is not deployed yet");
  }
  return ok(value.toLowerCase());
}

function integer(raw: string | undefined, name: string, fallback: bigint): Result<bigint> {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return ok(fallback);
  if (!/^\d+$/.test(value)) return invalid(name, "must be a non-negative integer");
  return ok(BigInt(value));
}

/**
 * Loads the configuration, or names the first variable that is wrong.
 *
 * A pure function of a plain map, so a test exercises every rejection without
 * touching the real environment.
 */
export function loadGatewayConfig(env: GatewayEnv = processGatewayEnv()): Result<GatewayConfig> {
  const rpcUrl = env.CREDITCOIN_RPC_URL?.trim();
  if (rpcUrl === undefined || rpcUrl.length === 0) {
    return invalid("CREDITCOIN_RPC_URL", "is required and is unset or empty");
  }

  const chainIdRaw = env.CREDITCOIN_CHAIN_ID?.trim();
  if (chainIdRaw === undefined || !/^\d+$/.test(chainIdRaw)) {
    return invalid("CREDITCOIN_CHAIN_ID", "must be a decimal chain id");
  }

  const tabBook = requiredAddress(env.TAB_BOOK_ADDRESS, "TAB_BOOK_ADDRESS");
  if (!tabBook.ok) return tabBook;
  const serviceRegistry = requiredAddress(env.SERVICE_REGISTRY_ADDRESS, "SERVICE_REGISTRY_ADDRESS");
  if (!serviceRegistry.ok) return serviceRegistry;
  const bond = requiredAddress(env.BOND_ADDRESS, "BOND_ADDRESS");
  if (!bond.ok) return bond;

  const batch = integer(env.RPC_BATCH_MAX_COUNT, "RPC_BATCH_MAX_COUNT", 1n);
  if (!batch.ok) return batch;
  const baseline = integer(env.CREDIT_BASELINE_BASE_UNITS, "CREDIT_BASELINE_BASE_UNITS", 5_000_000n);
  if (!baseline.ok) return baseline;
  const growth = integer(env.GROWTH_FACTOR_BPS, "GROWTH_FACTOR_BPS", 5_000n);
  if (!growth.ok) return growth;

  // A key that is present but unfilled is worse than an absent one, because it
  // reads as "ready to broadcast" right up to the moment it is used. The template
  // ships a deliberately non-hexadecimal placeholder so this check can catch it.
  const rawKey = env.GATEWAY_PRIVATE_KEY?.trim();
  const operatorKey =
    rawKey === undefined || rawKey.length === 0 || !/^0x[0-9a-fA-F]{64}$/.test(rawKey) ? undefined : rawKey;

  return ok({
    rpcUrl,
    chainId: Number.parseInt(chainIdRaw, 10),
    batchMaxCount: Number(batch.value),
    tabBook: tabBook.value,
    serviceRegistry: serviceRegistry.value,
    bond: bond.value,
    operatorKey,
    baseline: baseline.value,
    growthFactorBps: growth.value,
  });
}

/** The operator key, or an error naming the variable, for a path that must broadcast. */
export function requireOperatorKey(config: GatewayConfig): Result<string> {
  if (config.operatorKey === undefined) {
    return err({
      category: "VALIDATION",
      code: "GATEWAY_KEY_MISSING",
      message:
        "GATEWAY_PRIVATE_KEY is unset or is still the template placeholder, so this run can simulate a delivery but cannot record one",
      retryable: false,
      details: { variable: "GATEWAY_PRIVATE_KEY" },
    });
  }
  return ok(config.operatorKey);
}
