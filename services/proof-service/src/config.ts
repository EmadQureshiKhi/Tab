/**
 * Proof Service configuration, read from the environment and never from a literal.
 *
 * The Proof Service is both halves of the rail at once. It is a Service, so it
 * meters delivered proof material into an Agent's Open Tab on Creditcoin, and it
 * is an Agent, so it settles its own Open Tabs in USDC on a Source Chain. Both
 * roles need addresses, and every one of them comes out of the environment.
 *
 * ## Every read is written out one name at a time, deliberately
 *
 * `scripts/env-check.mjs` extracts environment reads statically and fails the
 * build when one has no declaration in the tracked `.env.example`. It recognises a
 * direct member read off the process environment and nothing else, so reaching
 * these values through a captured record would leave the gate green while this
 * service read undeclared variables. The names below are therefore spelled out one
 * per line rather than looped over.
 *
 * ## Two names are borrowed rather than invented
 *
 * `GATEWAY_SERVICE_ID` already holds `tab.proof-service`, left-aligned and
 * zero-padded, because the gateway meters for this very Service; its declaration
 * says so in `.env.example`. Reading it here rather than declaring a second name
 * for the same 32-byte word keeps one value in one place. `PROOF_SERVICE_PRIVATE_KEY`
 * is the operator key on Creditcoin and the payer key on the Source Chain, because
 * an EVM key is chain-agnostic and the Proof Service is one party in both roles.
 *
 * ## Nothing throws
 *
 * A malformed value comes back as a `TabError` naming the variable. A service that
 * dies on startup with a stack trace tells an operator less than one that names the
 * variable it could not parse.
 *
 * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 28.6
 */

import { err, ok, type Result } from "@tabai/shared";

/** The environment names this service reads, written out so the gate can see them. */
export interface ProofServiceEnv {
  readonly CREDITCOIN_RPC_URL?: string | undefined;
  readonly CREDITCOIN_CHAIN_ID?: string | undefined;
  readonly RPC_BATCH_MAX_COUNT?: string | undefined;
  readonly TAB_BOOK_ADDRESS?: string | undefined;
  readonly SERVICE_REGISTRY_ADDRESS?: string | undefined;
  readonly BOND_ADDRESS?: string | undefined;
  readonly CHAININFO_PRECOMPILE?: string | undefined;
  readonly PROOF_BUILDER_URL?: string | undefined;
  readonly GATEWAY_SERVICE_ID?: string | undefined;
  readonly PROOF_SERVICE_PRICE_BASE_UNITS?: string | undefined;
  readonly PROOF_SERVICE_COLLECTION_ADDRESS?: string | undefined;
  readonly DEFAULT_SETTLEMENT_WINDOW_S?: string | undefined;
  readonly PROOF_SERVICE_PRIVATE_KEY?: string | undefined;
  readonly SEPOLIA_SETTLEMENT_ADDRESS?: string | undefined;
  readonly SEPOLIA_USDC_ADDRESS?: string | undefined;
  readonly MAINNET_USDC_ADDRESS?: string | undefined;
  readonly ETHEREUM_SEPOLIA_RPC_URLS?: string | undefined;
  readonly ETHEREUM_MAINNET_RPC_URLS?: string | undefined;
}

/**
 * The process environment, restricted to what the Proof Service reads.
 *
 * One name per line, so `scripts/env-check.mjs` can see every read.
 */
export function processProofServiceEnv(): ProofServiceEnv {
  return {
    CREDITCOIN_RPC_URL: process.env.CREDITCOIN_RPC_URL,
    CREDITCOIN_CHAIN_ID: process.env.CREDITCOIN_CHAIN_ID,
    RPC_BATCH_MAX_COUNT: process.env.RPC_BATCH_MAX_COUNT,
    TAB_BOOK_ADDRESS: process.env.TAB_BOOK_ADDRESS,
    SERVICE_REGISTRY_ADDRESS: process.env.SERVICE_REGISTRY_ADDRESS,
    BOND_ADDRESS: process.env.BOND_ADDRESS,
    CHAININFO_PRECOMPILE: process.env.CHAININFO_PRECOMPILE,
    PROOF_BUILDER_URL: process.env.PROOF_BUILDER_URL,
    GATEWAY_SERVICE_ID: process.env.GATEWAY_SERVICE_ID,
    PROOF_SERVICE_PRICE_BASE_UNITS: process.env.PROOF_SERVICE_PRICE_BASE_UNITS,
    PROOF_SERVICE_COLLECTION_ADDRESS: process.env.PROOF_SERVICE_COLLECTION_ADDRESS,
    DEFAULT_SETTLEMENT_WINDOW_S: process.env.DEFAULT_SETTLEMENT_WINDOW_S,
    PROOF_SERVICE_PRIVATE_KEY: process.env.PROOF_SERVICE_PRIVATE_KEY,
    SEPOLIA_SETTLEMENT_ADDRESS: process.env.SEPOLIA_SETTLEMENT_ADDRESS,
    SEPOLIA_USDC_ADDRESS: process.env.SEPOLIA_USDC_ADDRESS,
    MAINNET_USDC_ADDRESS: process.env.MAINNET_USDC_ADDRESS,
    ETHEREUM_SEPOLIA_RPC_URLS: process.env.ETHEREUM_SEPOLIA_RPC_URLS,
    ETHEREUM_MAINNET_RPC_URLS: process.env.ETHEREUM_MAINNET_RPC_URLS,
  };
}

/** The default Proof Builder for this network, matching design section 8.4. */
export const DEFAULT_PROOF_BUILDER_URL = "https://prover.cc3-testnet.creditcoin.network";

/** The ChainInfo Precompile address, used when the environment names none. */
export const DEFAULT_CHAIN_INFO_PRECOMPILE = "0x0000000000000000000000000000000000000fd3";

/** The port the served app listens on when no `--port` is given. */
export const DEFAULT_PROOF_SERVICE_PORT = 8789;

/**
 * The registered price of one proof, in Asset base units.
 *
 * A fallback for a missing variable, not a second source of truth: the applied
 * price list on chain is the authority, and `recordDelivery` reverts
 * `PriceListChangedMidCall` when the quoted price disagrees with it.
 */
export const DEFAULT_PROOF_PRICE_BASE_UNITS = 10_000n;

/** The registered Settlement Window, in seconds, when the environment names none. */
export const DEFAULT_SETTLEMENT_WINDOW_SECONDS = 21_600;

/** The Source Chain surfaces the Proof Service can settle its own tabs on. */
export interface SourceChainConfig {
  readonly chainKey: bigint;
  readonly usdc: string;
  readonly decimals: number;
  /** `TabSettlement` on this chain, absent where Tab deploys nothing. */
  readonly settlementContract: string | undefined;
  /** Endpoints in priority order, empty when none is configured. */
  readonly rpcUrls: readonly string[];
}

export interface ProofServiceConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  /** Several endpoints on this network refuse JSON-RPC batching, so this defaults to 1. */
  readonly batchMaxCount: number;
  readonly tabBook: string;
  readonly serviceRegistry: string;
  readonly bond: string;
  readonly chainInfo: string;
  readonly proofBuilderUrl: string;
  /** The 32-byte registry key of this Service. */
  readonly serviceId: string;
  /** Base units per proof, as the applied price list holds it. */
  readonly unitPrice: bigint;
  /** Where this Service collects Settlements owed to it. */
  readonly collectionAddress: string | undefined;
  readonly settlementWindowSeconds: number;
  /**
   * The operator key. Absent on a read-only run, which is the default: simulating
   * a delivery or a Settlement needs no key at all, and only a broadcast does.
   */
  readonly operatorKey: string | undefined;
  /** Settlement surfaces, keyed by chainKey as a decimal string. */
  readonly sourceChains: Readonly<Record<string, SourceChainConfig>>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

const invalid = (name: string, why: string): Result<never> =>
  err({
    category: "VALIDATION",
    code: "PROOF_SERVICE_CONFIG_INVALID",
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

/**
 * An address that may be absent or a placeholder.
 *
 * Used for surfaces the Proof Service can run without. A Settlement Window and a
 * price are enough to meter; a Collection Address is only needed once this Service
 * settles, and a Source Chain with no deployment has no contract to name.
 */
function optionalAddress(raw: string | undefined, name: string): Result<string | undefined> {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return ok(undefined);
  if (!ADDRESS.test(value)) return invalid(name, "must be a 20-byte 0x address");
  if (value.toLowerCase() === ZERO_ADDRESS) return ok(undefined);
  return ok(value.toLowerCase());
}

function integer(raw: string | undefined, name: string, fallback: bigint): Result<bigint> {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return ok(fallback);
  if (!/^\d+$/.test(value)) return invalid(name, "must be a non-negative integer");
  return ok(BigInt(value));
}

/** A comma-separated endpoint list, trimmed and emptied of blanks. */
function endpoints(raw: string | undefined): readonly string[] {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Loads the configuration, or names the first variable that is wrong.
 *
 * A pure function of a plain map, so a test exercises every rejection without
 * touching the real environment.
 */
export function loadProofServiceConfig(
  env: ProofServiceEnv = processProofServiceEnv(),
): Result<ProofServiceConfig> {
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

  const chainInfoRaw = env.CHAININFO_PRECOMPILE?.trim();
  const chainInfo =
    chainInfoRaw === undefined || chainInfoRaw.length === 0 ? DEFAULT_CHAIN_INFO_PRECOMPILE : chainInfoRaw;
  if (!ADDRESS.test(chainInfo)) return invalid("CHAININFO_PRECOMPILE", "must be a 20-byte 0x address");

  const serviceIdRaw = env.GATEWAY_SERVICE_ID?.trim();
  if (serviceIdRaw === undefined || !BYTES32.test(serviceIdRaw)) {
    return invalid(
      "GATEWAY_SERVICE_ID",
      "must be the 32-byte registry key of this Service; it already holds `tab.proof-service` in the tracked template",
    );
  }

  const batch = integer(env.RPC_BATCH_MAX_COUNT, "RPC_BATCH_MAX_COUNT", 1n);
  if (!batch.ok) return batch;
  const price = integer(
    env.PROOF_SERVICE_PRICE_BASE_UNITS,
    "PROOF_SERVICE_PRICE_BASE_UNITS",
    DEFAULT_PROOF_PRICE_BASE_UNITS,
  );
  if (!price.ok) return price;
  if (price.value <= 0n) {
    return invalid("PROOF_SERVICE_PRICE_BASE_UNITS", "must be greater than zero; a free tool cannot be metered");
  }
  const window = integer(
    env.DEFAULT_SETTLEMENT_WINDOW_S,
    "DEFAULT_SETTLEMENT_WINDOW_S",
    BigInt(DEFAULT_SETTLEMENT_WINDOW_SECONDS),
  );
  if (!window.ok) return window;

  const collection = optionalAddress(
    env.PROOF_SERVICE_COLLECTION_ADDRESS,
    "PROOF_SERVICE_COLLECTION_ADDRESS",
  );
  if (!collection.ok) return collection;

  const sepoliaUsdc = optionalAddress(env.SEPOLIA_USDC_ADDRESS, "SEPOLIA_USDC_ADDRESS");
  if (!sepoliaUsdc.ok) return sepoliaUsdc;
  const mainnetUsdc = optionalAddress(env.MAINNET_USDC_ADDRESS, "MAINNET_USDC_ADDRESS");
  if (!mainnetUsdc.ok) return mainnetUsdc;
  const sepoliaSettlement = optionalAddress(
    env.SEPOLIA_SETTLEMENT_ADDRESS,
    "SEPOLIA_SETTLEMENT_ADDRESS",
  );
  if (!sepoliaSettlement.ok) return sepoliaSettlement;

  const sourceChains: Record<string, SourceChainConfig> = {};
  if (sepoliaUsdc.value !== undefined) {
    sourceChains["1"] = {
      chainKey: 1n,
      usdc: sepoliaUsdc.value,
      decimals: 6,
      settlementContract: sepoliaSettlement.value,
      rpcUrls: endpoints(env.ETHEREUM_SEPOLIA_RPC_URLS),
    };
  }
  if (mainnetUsdc.value !== undefined) {
    // Tab deploys nothing on Mainnet, so this surface has no contract by design
    // rather than by omission: a plain USDC Transfer to the Collection Address is
    // the Settlement.
    sourceChains["3"] = {
      chainKey: 3n,
      usdc: mainnetUsdc.value,
      decimals: 6,
      settlementContract: undefined,
      rpcUrls: endpoints(env.ETHEREUM_MAINNET_RPC_URLS),
    };
  }

  // A key that is present but unfilled is worse than an absent one, because it
  // reads as "ready to broadcast" right up to the moment it is used. The template
  // ships a deliberately non-hexadecimal placeholder so this check can catch it.
  const rawKey = env.PROOF_SERVICE_PRIVATE_KEY?.trim();
  const operatorKey =
    rawKey === undefined || rawKey.length === 0 || !BYTES32.test(rawKey) ? undefined : rawKey;

  const builderRaw = env.PROOF_BUILDER_URL?.trim();

  return ok({
    rpcUrl,
    chainId: Number.parseInt(chainIdRaw, 10),
    batchMaxCount: Number(batch.value),
    tabBook: tabBook.value,
    serviceRegistry: serviceRegistry.value,
    bond: bond.value,
    chainInfo: chainInfo.toLowerCase(),
    proofBuilderUrl:
      builderRaw === undefined || builderRaw.length === 0
        ? DEFAULT_PROOF_BUILDER_URL
        : builderRaw.replace(/\/+$/, ""),
    serviceId: serviceIdRaw.toLowerCase(),
    unitPrice: price.value,
    collectionAddress: collection.value,
    settlementWindowSeconds: Number(window.value),
    operatorKey,
    sourceChains,
  });
}

/** The operator key, or an error naming the variable, for a path that must broadcast. */
export function requireOperatorKey(config: ProofServiceConfig): Result<string> {
  if (config.operatorKey === undefined) {
    return err({
      category: "VALIDATION",
      code: "PROOF_SERVICE_KEY_MISSING",
      message:
        "PROOF_SERVICE_PRIVATE_KEY is unset or is still the template placeholder, so this run can simulate a delivery or a Settlement but cannot make one",
      retryable: false,
      details: { variable: "PROOF_SERVICE_PRIVATE_KEY" },
    });
  }
  return ok(config.operatorKey);
}

/** The Collection Address, or an error, for a path that must name where money goes. */
export function requireCollectionAddress(config: ProofServiceConfig): Result<string> {
  if (config.collectionAddress === undefined) {
    return err({
      category: "VALIDATION",
      code: "PROOF_SERVICE_COLLECTION_MISSING",
      message:
        "PROOF_SERVICE_COLLECTION_ADDRESS is unset or is still the zero-address placeholder, so a Settlement has no registered recipient and would never be credited",
      retryable: false,
      details: { variable: "PROOF_SERVICE_COLLECTION_ADDRESS" },
    });
  }
  return ok(config.collectionAddress);
}
