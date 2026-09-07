/**
 * Live harness — configuration.
 *
 * Every address, endpoint, and key the harness uses is read from the environment. Nothing is written
 * down here, because a harness carrying its own addresses stops testing the deployment and starts
 * testing itself.
 *
 * The one thing read from the repository is the direction of the check: `deployments.json` at the
 * root is the tracked deployment record, and the harness refuses to run when the environment
 * disagrees with it. A live negative-path result aimed at the wrong contract is worse than no result,
 * because it reads as evidence. The record is compared against, never substituted for the
 * environment.
 *
 * Every environment read is indexed by one of the module-level string constants below, so
 * `scripts/env-check.mjs` resolves all of them statically. Each name is already declared in
 * `.env.example`; the harness introduces none of its own, and so needs no addition to a file it does
 * not own.
 *
 * Requirements: 27.3
 */

import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve as resolvePath} from 'node:path';
import {fileURLToPath} from 'node:url';

import {getAddress, isHexString} from 'ethers';

// ------------------------------------------------------------------------------------------ paths

/** `packages/contracts/test/live`. */
export const LIVE_DIR = dirname(fileURLToPath(import.meta.url));

/** `packages/contracts`. */
export const CONTRACTS_DIR = resolvePath(LIVE_DIR, '..', '..');

/** The repository root. */
export const REPO_ROOT = resolvePath(CONTRACTS_DIR, '..', '..');

/** Where every outcome is recorded. */
export const RESULTS_PATH = resolvePath(LIVE_DIR, 'results.json');

/** The tracked deployment record the environment is checked against. */
export const DEPLOYMENTS_PATH = resolvePath(REPO_ROOT, 'deployments.json');

// ------------------------------------------------------------------------------- environment names

const NAME_CREDITCOIN_RPC_URL = 'CREDITCOIN_RPC_URL';
const NAME_CREDITCOIN_CHAIN_ID = 'CREDITCOIN_CHAIN_ID';
const NAME_CREDITCOIN_EXPLORER_URL = 'CREDITCOIN_EXPLORER_URL';
const NAME_SETTLEMENT_VERIFIER_ADDRESS = 'SETTLEMENT_VERIFIER_ADDRESS';
const NAME_BLOCKPROVER_PRECOMPILE = 'BLOCKPROVER_PRECOMPILE';
const NAME_PROOF_BUILDER_URL = 'PROOF_BUILDER_URL';
const NAME_MAINNET_USDC_ADDRESS = 'MAINNET_USDC_ADDRESS';
const NAME_ETHEREUM_MAINNET_RPC_URLS = 'ETHEREUM_MAINNET_RPC_URLS';
const NAME_RPC_BATCH_MAX_COUNT = 'RPC_BATCH_MAX_COUNT';
const NAME_ETHEREUM_SEPOLIA_RPC_URLS = 'ETHEREUM_SEPOLIA_RPC_URLS';
const NAME_SEPOLIA_USDC_ADDRESS = 'SEPOLIA_USDC_ADDRESS';
const NAME_SEPOLIA_SETTLEMENT_ADDRESS = 'SEPOLIA_SETTLEMENT_ADDRESS';
const NAME_SERVICE_REGISTRY_ADDRESS = 'SERVICE_REGISTRY_ADDRESS';
const NAME_AGENT_REGISTRY_ADDRESS = 'AGENT_REGISTRY_ADDRESS';
const NAME_TAB_BOOK_ADDRESS = 'TAB_BOOK_ADDRESS';
const NAME_REGISTRY_START_BLOCK = 'REGISTRY_START_BLOCK';
/**
 * The signing key for `--broadcast`. Read from `WATCHER_PRIVATE_KEY` because that is the one signing
 * key `.env.example` declares for this surface; the variable names the *slot*, not the account. To
 * sign with a different funded account, pass that account's key in this variable for the
 * invocation, which is what task 13.2's runs did with the deployer's key so the Watcher's own nonce
 * sequence was never touched. The submitting address is recorded on every run, so the record says
 * which account actually signed.
 */
const NAME_WATCHER_PRIVATE_KEY = 'WATCHER_PRIVATE_KEY';

/**
 * Minimal `.env` reader, so the harness behaves the same whether or not the caller remembered
 * `--env-file`. Values already in the environment win, and no value is ever printed or recorded.
 */
function loadDotEnv(): void {
  const envPath = resolvePath(REPO_ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

/**
 * One snapshot of every variable the harness reads, taken after `.env` is folded in. Each entry
 * indexes the environment by one of the constants above, which is what the environment gate resolves.
 */
function snapshot(): Record<string, string | undefined> {
  loadDotEnv();
  return {
    [NAME_CREDITCOIN_RPC_URL]: process.env[NAME_CREDITCOIN_RPC_URL],
    [NAME_CREDITCOIN_CHAIN_ID]: process.env[NAME_CREDITCOIN_CHAIN_ID],
    [NAME_CREDITCOIN_EXPLORER_URL]: process.env[NAME_CREDITCOIN_EXPLORER_URL],
    [NAME_SETTLEMENT_VERIFIER_ADDRESS]: process.env[NAME_SETTLEMENT_VERIFIER_ADDRESS],
    [NAME_BLOCKPROVER_PRECOMPILE]: process.env[NAME_BLOCKPROVER_PRECOMPILE],
    [NAME_PROOF_BUILDER_URL]: process.env[NAME_PROOF_BUILDER_URL],
    [NAME_MAINNET_USDC_ADDRESS]: process.env[NAME_MAINNET_USDC_ADDRESS],
    [NAME_ETHEREUM_MAINNET_RPC_URLS]: process.env[NAME_ETHEREUM_MAINNET_RPC_URLS],
    [NAME_RPC_BATCH_MAX_COUNT]: process.env[NAME_RPC_BATCH_MAX_COUNT],
    [NAME_ETHEREUM_SEPOLIA_RPC_URLS]: process.env[NAME_ETHEREUM_SEPOLIA_RPC_URLS],
    [NAME_SEPOLIA_USDC_ADDRESS]: process.env[NAME_SEPOLIA_USDC_ADDRESS],
    [NAME_SEPOLIA_SETTLEMENT_ADDRESS]: process.env[NAME_SEPOLIA_SETTLEMENT_ADDRESS],
    [NAME_SERVICE_REGISTRY_ADDRESS]: process.env[NAME_SERVICE_REGISTRY_ADDRESS],
    [NAME_AGENT_REGISTRY_ADDRESS]: process.env[NAME_AGENT_REGISTRY_ADDRESS],
    [NAME_TAB_BOOK_ADDRESS]: process.env[NAME_TAB_BOOK_ADDRESS],
    [NAME_REGISTRY_START_BLOCK]: process.env[NAME_REGISTRY_START_BLOCK],
    [NAME_WATCHER_PRIVATE_KEY]: process.env[NAME_WATCHER_PRIVATE_KEY],
  };
}

// --------------------------------------------------------------------------------------- redaction

/**
 * Strip anything token-shaped out of an endpoint URL before it reaches `results.json`. Userinfo and
 * query strings go entirely; a long opaque path segment becomes a placeholder.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.pathname = url.pathname
      .split('/')
      .map((segment) => (segment.length >= 20 && /^[A-Za-z0-9_-]+$/.test(segment) ? '<redacted>' : segment))
      .join('/');
    return url.toString().replace(/\/$/, '');
  } catch {
    return '<unparseable endpoint>';
  }
}

// -------------------------------------------------------------------------------- resolved surface

/** Everything the harness needs, validated once. Carries one secret, and never records it. */
export interface LiveConfig {
  readonly creditcoinRpcUrl: string;
  readonly creditcoinChainId: number;
  readonly explorerUrl: string;
  readonly settlementVerifier: string;
  readonly blockProverPrecompile: string;
  readonly proofBuilderUrl: string;
  readonly mainnetUsdc: string;
  readonly mainnetRpcUrls: readonly string[];
  /** Sepolia endpoints, for the cases built on a Settlement lane 1 produced. May be empty. */
  readonly sepoliaRpcUrls: readonly string[];
  /** Sepolia USDC and the settlement contract. Null when the template's zero placeholder is in place. */
  readonly sepoliaUsdc: string | null;
  readonly sepoliaSettlement: string | null;
  /** The verifier's collaborators, read for the acceptance assertions. Null until deployed. */
  readonly serviceRegistry: string | null;
  readonly agentRegistry: string | null;
  readonly tabBook: string | null;
  /** Lowest Creditcoin block an event scan starts from: the deployment block of the earliest contract. */
  readonly eventScanFloor: number;
  readonly rpcBatchMaxCount: number;
  /** Present only when a signing key is configured. Never logged, never recorded. */
  readonly submitterKey: string | null;
  /** What the tracked deployment record says, for the agreement note in `results.json`. */
  readonly deploymentRecord: {
    readonly network: string;
    readonly chainId: number;
    readonly settlementVerifier: string;
    readonly agreesWithEnvironment: boolean;
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is not set. The live harness reads every address from the environment and refuses to guess.`);
  }
  return value.trim();
}

/** An address that may still be the template's zero placeholder, read as null in that case. */
function optionalAddress(env: Record<string, string | undefined>, name: string): string | null {
  const raw = env[name]?.trim() ?? '';
  if (raw.length === 0) return null;
  let checksummed: string;
  try {
    checksummed = getAddress(raw);
  } catch {
    throw new Error(`${name} is not a valid address.`);
  }
  return checksummed === '0x0000000000000000000000000000000000000000' ? null : checksummed;
}

function urlList(raw: string | undefined): readonly string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function requiredAddress(env: Record<string, string | undefined>, name: string): string {
  const raw = required(env, name);
  let checksummed: string;
  try {
    checksummed = getAddress(raw);
  } catch {
    throw new Error(`${name} is not a valid address.`);
  }
  if (checksummed === '0x0000000000000000000000000000000000000000') {
    throw new Error(`${name} is the zero address. Fill it in from deployments.json before running the live harness.`);
  }
  return checksummed;
}

interface DeploymentRecordShape {
  creditcoin?: {
    network?: string;
    chainId?: number;
    contracts?: Record<string, {address?: string}>;
  };
}

/**
 * Resolve and validate the whole surface. Throws with a named cause rather than half-configuring,
 * because every failure mode here is a misconfiguration the operator fixes in one line.
 */
export function loadConfig(): LiveConfig {
  const env = snapshot();

  const creditcoinRpcUrl = required(env, NAME_CREDITCOIN_RPC_URL);
  const creditcoinChainId = Number(required(env, NAME_CREDITCOIN_CHAIN_ID));
  if (!Number.isInteger(creditcoinChainId) || creditcoinChainId <= 0) {
    throw new Error(`${NAME_CREDITCOIN_CHAIN_ID} is not a positive integer.`);
  }

  const settlementVerifier = requiredAddress(env, NAME_SETTLEMENT_VERIFIER_ADDRESS);
  const blockProverPrecompile = requiredAddress(env, NAME_BLOCKPROVER_PRECOMPILE);
  const mainnetUsdc = requiredAddress(env, NAME_MAINNET_USDC_ADDRESS);

  const mainnetRpcUrls = required(env, NAME_ETHEREUM_MAINNET_RPC_URLS)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (mainnetRpcUrls.length === 0) {
    throw new Error(`${NAME_ETHEREUM_MAINNET_RPC_URLS} resolved to an empty endpoint list.`);
  }

  const batchMaxCount = Number(env[NAME_RPC_BATCH_MAX_COUNT] ?? '1');
  const scanFloorRaw = Number(env[NAME_REGISTRY_START_BLOCK] ?? '0');
  const scanFloor = Number.isSafeInteger(scanFloorRaw) && scanFloorRaw > 0 ? scanFloorRaw : 0;
  const rawKey = env[NAME_WATCHER_PRIVATE_KEY]?.trim() ?? '';

  if (!existsSync(DEPLOYMENTS_PATH)) {
    throw new Error('deployments.json is absent, so the harness cannot check the environment against the deployment record.');
  }
  const record = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8')) as DeploymentRecordShape;
  const recorded = record.creditcoin?.contracts?.SettlementVerifier?.address;
  if (recorded === undefined) {
    throw new Error('deployments.json names no Creditcoin SettlementVerifier address.');
  }
  const recordedChecksummed = getAddress(recorded);
  const agrees = recordedChecksummed === settlementVerifier && record.creditcoin?.chainId === creditcoinChainId;
  if (!agrees) {
    throw new Error(
      'the environment and deployments.json disagree about the deployment under test. ' +
        `${NAME_SETTLEMENT_VERIFIER_ADDRESS} resolves to ${settlementVerifier} on chain ${creditcoinChainId}, ` +
        `while deployments.json records ${recordedChecksummed} on chain ${record.creditcoin?.chainId}. ` +
        'A live result aimed at the wrong contract would read as evidence, so the harness stops here.',
    );
  }

  return {
    creditcoinRpcUrl,
    creditcoinChainId,
    explorerUrl: (env[NAME_CREDITCOIN_EXPLORER_URL] ?? '').trim(),
    settlementVerifier,
    blockProverPrecompile,
    proofBuilderUrl: required(env, NAME_PROOF_BUILDER_URL),
    mainnetUsdc,
    mainnetRpcUrls,
    sepoliaRpcUrls: urlList(env[NAME_ETHEREUM_SEPOLIA_RPC_URLS]),
    sepoliaUsdc: optionalAddress(env, NAME_SEPOLIA_USDC_ADDRESS),
    sepoliaSettlement: optionalAddress(env, NAME_SEPOLIA_SETTLEMENT_ADDRESS),
    serviceRegistry: optionalAddress(env, NAME_SERVICE_REGISTRY_ADDRESS),
    agentRegistry: optionalAddress(env, NAME_AGENT_REGISTRY_ADDRESS),
    tabBook: optionalAddress(env, NAME_TAB_BOOK_ADDRESS),
    eventScanFloor: scanFloor,
    rpcBatchMaxCount: Number.isInteger(batchMaxCount) && batchMaxCount > 0 ? batchMaxCount : 1,
    submitterKey: isHexString(rawKey, 32) ? rawKey : null,
    deploymentRecord: {
      network: record.creditcoin?.network ?? 'unknown',
      chainId: record.creditcoin?.chainId ?? 0,
      settlementVerifier: recordedChecksummed,
      agreesWithEnvironment: agrees,
    },
  };
}

/** A Blockscout transaction link, or null when no explorer is configured. */
export function explorerTxLink(config: LiveConfig, txHash: string): string | null {
  if (config.explorerUrl.length === 0) return null;
  return `${config.explorerUrl.replace(/\/$/, '')}/tx/${txHash}`;
}
