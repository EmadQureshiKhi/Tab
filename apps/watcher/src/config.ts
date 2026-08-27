/**
 * Watcher configuration.
 *
 * Every value the Watcher reads from the environment is read here and nowhere
 * else, and every name below is declared in the tracked `.env.example` contract.
 * Nothing throws: a malformed value comes back as a `TabError` naming the
 * variable, because a worker that dies on startup with a stack trace tells an
 * operator less than one that names the variable it could not parse.
 *
 * ## What configuration is allowed to decide, and what it is not
 *
 * Configuration decides *how* to reach a chain: RPC endpoints, batching, the
 * catch-up window. It does **not** decide *which* chains are monitored. That is
 * read from the ChainInfo Precompile at startup (design section 8.1, R20.1), and
 * a chainKey the precompile does not report cannot be monitored no matter what
 * this file says. `sourceRpcUrls` is therefore an offer of endpoints, not a
 * declaration of chains — see `discovery.ts`.
 *
 * ## Two measured constraints encoded as defaults
 *
 * `RPC_BATCH_MAX_COUNT` defaults to 1 because several public endpoints reject
 * JSON-RPC batching outright: `drpc` answers HTTP 500 to a batched request that
 * succeeds unbatched (design section 8.2). Raising it is measured-unsafe on at
 * least one endpoint the design ships first in priority order.
 *
 * `WATCHER_LOG_CHUNK_MAX` and `WATCHER_LOG_CHUNK_MIN` bound an adaptive
 * `eth_getLogs` window rather than a fixed one, because a fixed 2000-block chunk
 * is not portable: measured caps ranged from 10,000 blocks down to a hard 50, and
 * one endpoint rejected the three-topic filter shape outright.
 *
 * ## Addresses are candidates, exactly as endpoints are
 *
 * The Asset, settlement-contract, and Collection Addresses read here are
 * *candidates offered to the registry*, never a declaration of what is watched.
 * `ServiceRegistry.emitterFor` and `collectionFor` decide, and an address the
 * registry does not authorise is reported as unresolved rather than watched. This
 * is the same rule discovery applies to chains, for the same reason: an operator
 * cannot widen what the Watcher accepts by editing an environment file.
 *
 * A zero address reads as absent. That is the convention `.env.example` already
 * uses for an undeployed or undecided address, so an unfilled template yields no
 * candidate instead of a candidate at the zero address.
 *
 * Requirements: 15.1, 20.1, 20.11, 20.12
 */

import {
  CHAIN_KEYS,
  CREDITCOIN,
  PRECOMPILES,
  err,
  ok,
  type ChainKey,
  type Result,
} from "@tabai/shared";

/**
 * The environment names the Watcher reads. Written out as a record of explicit
 * `process.env` accesses so the tracked-contract check can see every one of them
 * statically, and so tests can supply a plain object instead.
 */
export interface WatcherEnv {
  readonly CREDITCOIN_RPC_URL?: string | undefined;
  readonly CREDITCOIN_CHAIN_ID?: string | undefined;
  readonly CHAININFO_PRECOMPILE?: string | undefined;
  readonly ETHEREUM_SEPOLIA_RPC_URLS?: string | undefined;
  readonly ETHEREUM_MAINNET_RPC_URLS?: string | undefined;
  readonly RPC_BATCH_MAX_COUNT?: string | undefined;
  readonly WATCHER_ENDPOINT_FAILURE_THRESHOLD?: string | undefined;
  readonly WATCHER_LOG_CHUNK_MAX?: string | undefined;
  readonly WATCHER_LOG_CHUNK_MIN?: string | undefined;
  readonly WATCHER_BATCH_MAX_PROOFS?: string | undefined;
  readonly WATCHER_BATCH_MAX_SPAN?: string | undefined;
  readonly DATABASE_URL?: string | undefined;
  readonly TAB_BOOK_ADDRESS?: string | undefined;
  readonly SERVICE_REGISTRY_ADDRESS?: string | undefined;
  readonly AGENT_REGISTRY_ADDRESS?: string | undefined;
  readonly WATCHER_ADDRESS?: string | undefined;
  readonly WATCHER_PRIVATE_KEY?: string | undefined;
  readonly PROOF_SERVICE_COLLECTION_ADDRESS?: string | undefined;
  readonly BOND_COLLECTION_ADDRESS?: string | undefined;
  readonly MAINNET_USDC_ADDRESS?: string | undefined;
  readonly SEPOLIA_USDC_ADDRESS?: string | undefined;
  readonly SEPOLIA_SETTLEMENT_ADDRESS?: string | undefined;
}

/** Snapshot of the process environment, restricted to what the Watcher reads. */
export function processWatcherEnv(): WatcherEnv {
  return {
    CREDITCOIN_RPC_URL: process.env.CREDITCOIN_RPC_URL,
    CREDITCOIN_CHAIN_ID: process.env.CREDITCOIN_CHAIN_ID,
    CHAININFO_PRECOMPILE: process.env.CHAININFO_PRECOMPILE,
    ETHEREUM_SEPOLIA_RPC_URLS: process.env.ETHEREUM_SEPOLIA_RPC_URLS,
    ETHEREUM_MAINNET_RPC_URLS: process.env.ETHEREUM_MAINNET_RPC_URLS,
    RPC_BATCH_MAX_COUNT: process.env.RPC_BATCH_MAX_COUNT,
    WATCHER_ENDPOINT_FAILURE_THRESHOLD: process.env.WATCHER_ENDPOINT_FAILURE_THRESHOLD,
    WATCHER_LOG_CHUNK_MAX: process.env.WATCHER_LOG_CHUNK_MAX,
    WATCHER_LOG_CHUNK_MIN: process.env.WATCHER_LOG_CHUNK_MIN,
    WATCHER_BATCH_MAX_PROOFS: process.env.WATCHER_BATCH_MAX_PROOFS,
    WATCHER_BATCH_MAX_SPAN: process.env.WATCHER_BATCH_MAX_SPAN,
    DATABASE_URL: process.env.DATABASE_URL,
    TAB_BOOK_ADDRESS: process.env.TAB_BOOK_ADDRESS,
    SERVICE_REGISTRY_ADDRESS: process.env.SERVICE_REGISTRY_ADDRESS,
    AGENT_REGISTRY_ADDRESS: process.env.AGENT_REGISTRY_ADDRESS,
    WATCHER_ADDRESS: process.env.WATCHER_ADDRESS,
    WATCHER_PRIVATE_KEY: process.env.WATCHER_PRIVATE_KEY,
    PROOF_SERVICE_COLLECTION_ADDRESS: process.env.PROOF_SERVICE_COLLECTION_ADDRESS,
    BOND_COLLECTION_ADDRESS: process.env.BOND_COLLECTION_ADDRESS,
    MAINNET_USDC_ADDRESS: process.env.MAINNET_USDC_ADDRESS,
    SEPOLIA_USDC_ADDRESS: process.env.SEPOLIA_USDC_ADDRESS,
    SEPOLIA_SETTLEMENT_ADDRESS: process.env.SEPOLIA_SETTLEMENT_ADDRESS,
  };
}

/**
 * Endpoints per Source Chain, keyed by chainKey. A chainKey missing from this
 * map has no configured endpoint and cannot be observed even while the precompile
 * attests it — a configuration gap discovery reports rather than hides.
 */
export type SourceRpcUrls = Readonly<Partial<Record<ChainKey, readonly string[]>>>;

/**
 * An address configuration offers to the registry, carrying the variable that
 * offered it so an unresolved candidate can be reported by name.
 */
export interface CandidateAddress {
  readonly address: string;
  readonly source: keyof WatcherEnv;
}

/** Candidate emitters per chainKey, and the Collection Addresses to probe them against. */
export type CandidateEmitters = Readonly<Partial<Record<ChainKey, readonly CandidateAddress[]>>>;

export interface WatcherConfig {
  readonly creditcoin: {
    readonly rpcUrl: string;
    readonly chainId: number;
    readonly chainInfoPrecompile: string;
    /** Absent until deployed; the clearing path refuses to run without it. */
    readonly tabBook: string | undefined;
    /** Absent until deployed; target resolution refuses to run without it. */
    readonly serviceRegistry: string | undefined;
    /**
     * Absent until deployed; the clearing path refuses to pledge Bond without it,
     * because a Settlement's payer is an Ethereum address and a tab is keyed on a
     * Creditcoin Agent, and this registry is the only join between the two.
     */
    readonly agentRegistry: string | undefined;
  };
  readonly watcher: {
    /**
     * The address `TabBook.watcher` was wired to. Checked against the signer
     * before a clearing is submitted, because `applyProvisionalClearing` reverts
     * `NotWatcher` for anyone else and a reverted transaction still costs gas.
     */
    readonly address: string | undefined;
    /** Absent on a read-only run. Never logged, never included in an error. */
    readonly privateKey: string | undefined;
  };
  readonly observation: {
    /**
     * Collection Addresses to resolve through `collectionFor`. One address may be
     * registered on both chains, so these are not per-chainKey.
     */
    readonly candidateCollections: readonly CandidateAddress[];
    readonly candidateEmitters: CandidateEmitters;
  };
  readonly sourceRpcUrls: SourceRpcUrls;
  /** Calls per JSON-RPC request. 1 unless an operator has measured otherwise. */
  readonly rpcBatchMaxCount: number;
  /** Consecutive failures on the active endpoint before rotating (R20.11). */
  readonly endpointFailureThreshold: number;
  /** Bounds of the adaptive `eth_getLogs` catch-up window. */
  readonly logChunk: { readonly max: number; readonly min: number };
  /**
   * The batch planner's two bounds. Both mirror the contract's own, which refuses
   * more than 10 proofs or a span over 1000 blocks, so a value above either is a
   * misconfiguration the planner refuses rather than a preference it honours.
   */
  readonly batch: { readonly maxProofs: number; readonly maxSpan: number };
  /** Absent until an operator supplies it; persistence refuses to run without it. */
  readonly databaseUrl: string | undefined;
}

/** Which environment variable carries the endpoint list for each chainKey. */
export const ENDPOINT_ENV_BY_CHAIN_KEY: Readonly<Record<ChainKey, keyof WatcherEnv>> = {
  1: "ETHEREUM_SEPOLIA_RPC_URLS",
  3: "ETHEREUM_MAINNET_RPC_URLS",
};

/**
 * Endpoints a Source Chain needs before the Watcher will monitor it (R20.11).
 * One endpoint cannot satisfy "move to the next endpoint after 3 consecutive
 * failures", so a single-endpoint chain is a configuration defect rather than a
 * working setup, and discovery names it instead of monitoring anyway.
 */
export const MIN_ENDPOINTS_PER_CHAIN = 2;

const HTTP_URL = /^https?:\/\//i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Which variable offers the emitter candidates of each chainKey. */
export const EMITTER_ENV_BY_CHAIN_KEY: Readonly<Record<ChainKey, readonly (keyof WatcherEnv)[]>> = {
  1: ["SEPOLIA_USDC_ADDRESS", "SEPOLIA_SETTLEMENT_ADDRESS"],
  3: ["MAINNET_USDC_ADDRESS"],
};

/** Which variables offer Collection Addresses. */
export const COLLECTION_ENV_NAMES: readonly (keyof WatcherEnv)[] = [
  "PROOF_SERVICE_COLLECTION_ADDRESS",
  "BOND_COLLECTION_ADDRESS",
];

/** A parse problem, phrased for an operator reading a log line. */
interface Problem {
  readonly name: string;
  readonly detail: string;
}

function parsePositiveInt(
  problems: Problem[],
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    problems.push({ name, detail: `expected an integer of at least 1, received ${raw.trim()}` });
    return fallback;
  }
  return value;
}

/**
 * An address, lower-cased, or `undefined` when it is absent or the zero
 * placeholder. A malformed value is a named problem rather than a silent absence,
 * because "watched nothing" and "watched the wrong thing" must not look alike.
 */
function parseOptionalAddress(
  problems: Problem[],
  name: keyof WatcherEnv,
  raw: string | undefined,
): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (!ADDRESS.test(value)) {
    problems.push({ name, detail: `\`${value}\` is not a 20-byte address` });
    return undefined;
  }
  const lowered = value.toLowerCase();
  return lowered === ZERO_ADDRESS ? undefined : lowered;
}

/** Splits a comma-separated endpoint list, dropping blanks and duplicates. */
function parseUrlList(problems: Problem[], name: string, raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  const urls: string[] = [];
  for (const entry of raw.split(",")) {
    const url = entry.trim();
    if (url.length === 0) continue;
    if (!HTTP_URL.test(url)) {
      problems.push({ name, detail: `\`${url}\` is not an http or https URL` });
      continue;
    }
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * Reads the configuration, or names every problem it found at once.
 *
 * Reporting all problems together rather than the first one matters on a worker:
 * an operator filling in an environment gets one round trip instead of one per
 * mistake.
 */
export function loadWatcherConfig(env: WatcherEnv = processWatcherEnv()): Result<WatcherConfig> {
  const problems: Problem[] = [];

  const rpcUrl = env.CREDITCOIN_RPC_URL?.trim() ?? CREDITCOIN.rpcUrl;
  if (!HTTP_URL.test(rpcUrl)) {
    problems.push({ name: "CREDITCOIN_RPC_URL", detail: `\`${rpcUrl}\` is not an http or https URL` });
  }

  const chainId = parsePositiveInt(
    problems,
    "CREDITCOIN_CHAIN_ID",
    env.CREDITCOIN_CHAIN_ID,
    CREDITCOIN.chainId,
  );

  const precompileRaw = env.CHAININFO_PRECOMPILE?.trim() ?? PRECOMPILES.chainInfo;
  if (!ADDRESS.test(precompileRaw)) {
    problems.push({
      name: "CHAININFO_PRECOMPILE",
      detail: `\`${precompileRaw}\` is not a 20-byte address`,
    });
  }

  const sourceRpcUrls: Partial<Record<ChainKey, readonly string[]>> = {};
  for (const chainKey of CHAIN_KEYS) {
    const name = ENDPOINT_ENV_BY_CHAIN_KEY[chainKey];
    const urls = parseUrlList(problems, name, env[name]);
    if (urls.length > 0) sourceRpcUrls[chainKey] = urls;
  }

  const rpcBatchMaxCount = parsePositiveInt(problems, "RPC_BATCH_MAX_COUNT", env.RPC_BATCH_MAX_COUNT, 1);
  const endpointFailureThreshold = parsePositiveInt(
    problems,
    "WATCHER_ENDPOINT_FAILURE_THRESHOLD",
    env.WATCHER_ENDPOINT_FAILURE_THRESHOLD,
    3,
  );
  const chunkMax = parsePositiveInt(problems, "WATCHER_LOG_CHUNK_MAX", env.WATCHER_LOG_CHUNK_MAX, 2000);
  const chunkMin = parsePositiveInt(problems, "WATCHER_LOG_CHUNK_MIN", env.WATCHER_LOG_CHUNK_MIN, 1);
  // Defaults are the contract's own maxima, so an unset variable plans the widest
  // batch the chain will accept rather than a narrower one nobody chose.
  const batchMaxProofs = parsePositiveInt(problems, "WATCHER_BATCH_MAX_PROOFS", env.WATCHER_BATCH_MAX_PROOFS, 10);
  const batchMaxSpan = parsePositiveInt(problems, "WATCHER_BATCH_MAX_SPAN", env.WATCHER_BATCH_MAX_SPAN, 1000);
  if (chunkMin > chunkMax) {
    problems.push({
      name: "WATCHER_LOG_CHUNK_MIN",
      detail: `${chunkMin} exceeds WATCHER_LOG_CHUNK_MAX of ${chunkMax}, so the window could never widen`,
    });
  }

  const databaseUrlRaw = env.DATABASE_URL?.trim();
  const databaseUrl = databaseUrlRaw !== undefined && databaseUrlRaw.length > 0 ? databaseUrlRaw : undefined;

  const tabBook = parseOptionalAddress(problems, "TAB_BOOK_ADDRESS", env.TAB_BOOK_ADDRESS);
  const serviceRegistry = parseOptionalAddress(
    problems,
    "SERVICE_REGISTRY_ADDRESS",
    env.SERVICE_REGISTRY_ADDRESS,
  );
  const agentRegistry = parseOptionalAddress(
    problems,
    "AGENT_REGISTRY_ADDRESS",
    env.AGENT_REGISTRY_ADDRESS,
  );
  const watcherAddress = parseOptionalAddress(problems, "WATCHER_ADDRESS", env.WATCHER_ADDRESS);

  // The value is never echoed, not even in the problem it raises: a key that is
  // one character short is still a key, and an operator does not need to see it
  // in a log line to fix it.
  const privateKeyRaw = env.WATCHER_PRIVATE_KEY?.trim();
  let privateKey: string | undefined;
  if (privateKeyRaw !== undefined && privateKeyRaw.length > 0) {
    if (PRIVATE_KEY.test(privateKeyRaw)) {
      privateKey = privateKeyRaw;
    } else {
      problems.push({
        name: "WATCHER_PRIVATE_KEY",
        detail: `expected 0x followed by 64 hexadecimal characters, received a ${privateKeyRaw.length}-character value`,
      });
    }
  }

  const candidateCollections: CandidateAddress[] = [];
  for (const name of COLLECTION_ENV_NAMES) {
    const address = parseOptionalAddress(problems, name, env[name]);
    if (address === undefined) continue;
    if (candidateCollections.some((entry) => entry.address === address)) continue;
    candidateCollections.push({ address, source: name });
  }

  const candidateEmitters: Partial<Record<ChainKey, readonly CandidateAddress[]>> = {};
  for (const chainKey of CHAIN_KEYS) {
    const emitters: CandidateAddress[] = [];
    for (const name of EMITTER_ENV_BY_CHAIN_KEY[chainKey]) {
      const address = parseOptionalAddress(problems, name, env[name]);
      if (address === undefined) continue;
      if (emitters.some((entry) => entry.address === address)) continue;
      emitters.push({ address, source: name });
    }
    if (emitters.length > 0) candidateEmitters[chainKey] = emitters;
  }

  if (problems.length > 0) {
    return err({
      category: "VALIDATION",
      code: "WATCHER_CONFIG_INVALID",
      message: problems.map((problem) => `${problem.name}: ${problem.detail}`).join("; "),
      retryable: false,
      details: { problemCount: problems.length },
    });
  }

  return ok({
    creditcoin: {
      rpcUrl,
      chainId,
      chainInfoPrecompile: precompileRaw.toLowerCase(),
      tabBook,
      serviceRegistry,
      agentRegistry,
    },
    watcher: { address: watcherAddress, privateKey },
    observation: { candidateCollections, candidateEmitters },
    sourceRpcUrls,
    rpcBatchMaxCount,
    endpointFailureThreshold,
    logChunk: { max: chunkMax, min: chunkMin },
    batch: { maxProofs: batchMaxProofs, maxSpan: batchMaxSpan },
    databaseUrl,
  });
}

/** Endpoints configured for a chainKey, in priority order. Empty when none are. */
export function endpointsFor(config: WatcherConfig, chainKey: ChainKey): readonly string[] {
  return config.sourceRpcUrls[chainKey] ?? [];
}

/** Emitter candidates offered for a chainKey. Empty when none are. */
export function candidateEmittersFor(
  config: WatcherConfig,
  chainKey: ChainKey,
): readonly CandidateAddress[] {
  return config.observation.candidateEmitters[chainKey] ?? [];
}

/**
 * An address a path cannot run without, or an error naming the variable.
 *
 * Used by the clearing path rather than by `loadWatcherConfig`, so a read-only run
 * against an undeployed environment still starts: the requirement is imposed where
 * the address is spent, not where it is read.
 */
export function requireAddress(
  address: string | undefined,
  name: keyof WatcherEnv,
  purpose: string,
): Result<string> {
  if (address === undefined) {
    return err({
      category: "VALIDATION",
      code: "WATCHER_ADDRESS_MISSING",
      message: `${name} is unset or the zero placeholder, and ${purpose} cannot proceed without it`,
      retryable: false,
      details: { variable: name },
    });
  }
  return ok(address);
}
