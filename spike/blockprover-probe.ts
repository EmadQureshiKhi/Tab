/**
 * Tab spike 1.3 — BlockProver Precompile end-to-end probe.
 *
 * This is the risk gate for the whole project. It answers one question with a live transaction on
 * CC3 Testnet rather than an argument: can a contract prove a *historical Ethereum Mainnet* USDC
 * `Transfer` through the BlockProver Precompile at 0x...0FD2, and does the payer it reads out of
 * `topics[1]` differ from the transaction's `from` field?
 *
 * The target is chosen deliberately, not scanned for. A plain EOA-to-EOA transfer has
 * `topics[1] == from` and proves nothing; the probe only accepts a target where the two differ,
 * which is what any contract-routed transfer gives — a DEX swap, an aggregator, a multisig, a
 * smart account, a batching router.
 *
 * What it does, in order:
 *   1. Read the attested frontier for chainKey 3 straight off the ChainInfo Precompile at 0x...0fd3,
 *      using the verified snake_case ABI from spike/chaininfo-findings.md.
 *   2. Walk back from a height comfortably below that frontier and pick a mainnet USDC `Transfer`
 *      whose log sender is not the gas payer. Record why it qualifies.
 *   3. Ask the Proof Builder for the proof material, through the SDK's own client.
 *   4. Cross-check `calculateTxIndex` against the transaction index read independently from a
 *      mainnet RPC.
 *   5. Deploy spike/Probe.sol, dry-run the submission with eth_call, then submit it for real.
 *   6. Assert programmatically that the emitted payer equals `topics[1]` and differs from `from`.
 *   7. Write everything, success or failure, to spike/probe-transcript.json.
 *
 * If mainnet verification fails, a Sepolia (chainKey 1) control runs so the transcript can tell
 * "mainnet path broken" apart from "our proof material is malformed".
 *
 * No Ethereum gas is spent. Nothing is sent to Ethereum. The only transactions are on Creditcoin:
 * one deployment and one probe call.
 *
 * Secrets: the signing key is read from the environment, used to construct a Wallet, and never
 * printed, logged, or written. Only the derived address reaches the transcript. Endpoint URLs are
 * passed through a redactor before they are written, so an endpoint carrying an API token in its
 * path or query string cannot leak into a tracked file.
 *
 * Prerequisite: `forge build` inside spike/ (the artifact at spike/out/Probe.sol/Probe.json).
 *
 * Run: pnpm tsx spike/blockprover-probe.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve as resolvePath } from 'node:path';

import { proofProvider } from '@gluwa/usc-sdk';
import {
  Contract,
  ContractFactory,
  FunctionFragment,
  Interface,
  JsonRpcProvider,
  Wallet,
  keccak256,
  toUtf8Bytes,
} from 'ethers';

// --------------------------------------------------------------------------- paths and constants

const SPIKE_DIR = basename(process.cwd()) === 'spike' ? process.cwd() : resolvePath(process.cwd(), 'spike');
const REPO_ROOT = resolvePath(SPIKE_DIR, '..');
const OUT_PATH = resolvePath(SPIKE_DIR, 'probe-transcript.json');
const ARTIFACT_PATH = resolvePath(SPIKE_DIR, 'out', 'Probe.sol', 'Probe.json');

/** Ethereum Mainnet as the Attestcoin Protocol keys it. */
const MAINNET_CHAIN_KEY = 3;
/** Ethereum Sepolia, used only as a control when mainnet fails. */
const SEPOLIA_CHAIN_KEY = 1;

const CHAIN_INFO_PRECOMPILE = '0x0000000000000000000000000000000000000fd3';
const BLOCK_PROVER_PRECOMPILE = '0x0000000000000000000000000000000000000FD2';

const TRANSFER_TOPIC0 = keccak256(toUtf8Bytes('Transfer(address,address,uint256)'));
const TRANSACTION_VERIFIED_TOPIC0 = keccak256(toUtf8Bytes('TransactionVerified(uint64,uint64,uint64)'));

/** How far below the attested frontier to start looking. ~20 minutes of mainnet time. */
const HEIGHT_MARGIN_BELOW_FRONTIER = Number(process.env.PROBE_HEIGHT_MARGIN ?? 100);
/** How many blocks to walk back before giving up on finding a qualifying target. */
const MAX_BLOCKS_SCANNED = Number(process.env.PROBE_MAX_BLOCKS ?? 6);
/** Gas ceiling for the probe transaction when estimation is unavailable. */
const FALLBACK_GAS_LIMIT = 30_000_000n;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

type Json = Record<string, unknown>;

// ------------------------------------------------------------------------------------- utilities

const errText = (e: unknown): string => {
  if (e instanceof Error) {
    const extra = e as Error & { shortMessage?: string; data?: unknown; code?: string };
    const parts = [`${e.name}: ${e.message}`];
    if (extra.shortMessage && !e.message.includes(extra.shortMessage)) parts.push(`short=${extra.shortMessage}`);
    if (extra.code) parts.push(`code=${extra.code}`);
    if (typeof extra.data === 'string') parts.push(`data=${extra.data}`);
    return parts.join(' | ');
  }
  return String(e);
};

/** Full error shape, including revert data, so a negative result is reproducible. */
const errRecord = (e: unknown): Json => {
  const anyErr = e as Record<string, unknown> | null;
  return {
    text: errText(e),
    code: anyErr && typeof anyErr.code === 'string' ? anyErr.code : null,
    shortMessage: anyErr && typeof anyErr.shortMessage === 'string' ? anyErr.shortMessage : null,
    revertData: anyErr && typeof anyErr.data === 'string' ? anyErr.data : null,
    reason: anyErr && typeof anyErr.reason === 'string' ? anyErr.reason : null,
  };
};

/**
 * Strip anything token-shaped out of an endpoint URL before it is written to a tracked file.
 * Userinfo and query strings go entirely; a long opaque path segment becomes a placeholder.
 */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    const segments = u.pathname
      .split('/')
      .map((s) => (s.length >= 20 && /^[A-Za-z0-9_-]+$/.test(s) ? '<redacted>' : s));
    u.pathname = segments.join('/');
    return u.toString().replace(/\/$/, '');
  } catch {
    return '<unparseable endpoint>';
  }
}

const jsonReplacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);

function writeTranscript(transcript: Json): void {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(transcript, jsonReplacer, 2) + '\n', 'utf8');
}

/**
 * Minimal `.env` reader. Node's `--env-file` would do this, but the probe should run the same way
 * whether or not the caller remembered the flag, and pulling in a dependency for four lines is
 * worse than four lines. Values already present in the environment win.
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is not set. The probe needs it and refuses to guess.`);
  }
  return value.trim();
}

const hexQuantity = (n: number): string => `0x${n.toString(16)}`;
const topicToAddress = (topic: string): string => `0x${topic.slice(-40)}`;
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Every public endpoint in play rejects JSON-RPC batching, so one call per request, always. */
function makeProvider(url: string, chainId: number): JsonRpcProvider {
  return new JsonRpcProvider(url, chainId, { batchMaxCount: 1, staticNetwork: true });
}

// -------------------------------------------------------------------- ChainInfo Precompile reads

const CHAIN_INFO_SIGNATURES = {
  latestAttestation: 'get_latest_attestation_height_and_hash(uint64) returns ((uint64,bytes32,bool,bool))',
  isHeightAttested: 'is_height_attested(uint64,uint64) returns (bool)',
  attestationBounds:
    'get_attestation_bounds(uint64,uint64) returns ((uint64,bytes32,bool,uint64,bytes32,bool,bool))',
} as const;

/** Raw `eth_call` against a precompile with a human-readable signature, decoded. */
async function precompileCall(
  provider: JsonRpcProvider,
  to: string,
  signature: string,
  args: unknown[],
): Promise<{ record: Json; decoded: unknown }> {
  const fragment = FunctionFragment.from(signature);
  const iface = new Interface([fragment]);
  const data = iface.encodeFunctionData(fragment, args);
  const record: Json = { signature, selector: data.slice(0, 10), calldata: data };
  try {
    const raw = await provider.call({ to, data });
    record.rawReturnData = raw;
    const decoded = iface.decodeFunctionResult(fragment, raw);
    record.decoded = JSON.parse(JSON.stringify(decoded, jsonReplacer));
    record.reverted = false;
    return { record, decoded };
  } catch (e) {
    record.reverted = true;
    record.error = errRecord(e);
    return { record, decoded: null };
  }
}

interface AttestationFrontier {
  height: number;
  digest: string;
  isAttestation: boolean;
  exists: boolean;
}

async function readFrontier(
  provider: JsonRpcProvider,
  chainKey: number,
): Promise<{ frontier: AttestationFrontier | null; record: Json }> {
  const { record, decoded } = await precompileCall(
    provider,
    CHAIN_INFO_PRECOMPILE,
    CHAIN_INFO_SIGNATURES.latestAttestation,
    [chainKey],
  );
  if (decoded === null) return { frontier: null, record };
  const tuple = (decoded as unknown[])[0] as [bigint, string, boolean, boolean];
  return {
    frontier: {
      height: Number(tuple[0]),
      digest: tuple[1],
      isAttestation: tuple[2],
      exists: tuple[3],
    },
    record,
  };
}

// ---------------------------------------------------------------------- Source Chain RPC helpers

interface SourceRpc {
  provider: JsonRpcProvider;
  url: string;
  supportsBlockReceipts: boolean;
}

/** First endpoint in the configured list that answers, plus whether it serves eth_getBlockReceipts. */
async function firstWorkingSourceRpc(
  urls: string[],
  chainId: number,
  probeHeight: number,
): Promise<{ rpc: SourceRpc; attempts: Json[] }> {
  const attempts: Json[] = [];
  for (const url of urls) {
    const provider = makeProvider(url, chainId);
    try {
      const head = await provider.getBlockNumber();
      let supportsBlockReceipts = false;
      try {
        const receipts = await provider.send('eth_getBlockReceipts', [hexQuantity(probeHeight)]);
        supportsBlockReceipts = Array.isArray(receipts);
      } catch (e) {
        attempts.push({ endpoint: redactUrl(url), note: 'eth_getBlockReceipts unavailable', error: errText(e) });
      }
      attempts.push({ endpoint: redactUrl(url), reachable: true, headHeight: head, supportsBlockReceipts });
      return { rpc: { provider, url, supportsBlockReceipts }, attempts };
    } catch (e) {
      attempts.push({ endpoint: redactUrl(url), reachable: false, error: errText(e) });
      provider.destroy();
    }
  }
  throw new Error('no configured Source Chain endpoint answered');
}

interface RpcTransaction {
  hash: string;
  from: string;
  to: string | null;
  transactionIndex: string;
  type: string;
  input: string;
}

/** ERC-20 selectors, so the transcript can name the mechanism instead of guessing at it. */
const SELECTOR_TRANSFER = '0xa9059cbb';
const SELECTOR_TRANSFER_FROM = '0x23b872dd';

/**
 * Say *why* this target has a log sender that is not the gas payer, from what the chain shows
 * rather than from assumption. Two mechanisms produce the split, and they are worth telling apart:
 * a `transferFrom` where an approved spender moves someone else's balance, and a call routed
 * through a contract that then moves its own or a user's balance.
 */
function explainQualification(to: string | null, selector: string, asset: string): string {
  const direct = to !== null && sameAddress(to, asset);
  if (direct && selector === SELECTOR_TRANSFER_FROM) {
    return (
      'Direct `transferFrom` on the Asset: an approved spender paid the gas while the Asset debited a ' +
      'different account, so `topics[1]` names the account whose balance moved and the transaction `from` ' +
      'field names only whoever submitted the call. Crediting `from` would credit the spender rather than ' +
      'the party that actually paid.'
    );
  }
  if (direct && selector === SELECTOR_TRANSFER) {
    return (
      'Direct `transfer` on the Asset whose log sender still differs from the transaction `from` field. ' +
      'That means the caller is a contract account rather than the submitting EOA.'
    );
  }
  if (!direct) {
    return (
      'Contract-routed transfer: the transaction was sent to an intermediary rather than to the Asset, and ' +
      'the Asset recorded that intermediary or its user in `topics[1]`. The gas payer is a third address ' +
      'entirely, so credit resolved from the transaction `from` field would land on the wrong party.'
    );
  }
  return (
    'The Asset recorded a sender in `topics[1]` that is not the transaction `from` field. Whatever the ' +
    'mechanism, credit resolved from `from` would land on the wrong party.'
  );
}

interface RpcLog {
  address: string;
  topics: string[];
  logIndex: string;
}

interface RpcReceipt {
  transactionHash: string;
  transactionIndex: string;
  status: string;
  from: string;
  to: string | null;
  logs: RpcLog[];
  gasUsed: string;
}

/** All receipts for a block, preferring one round-trip over one call per transaction. */
async function blockReceipts(rpc: SourceRpc, height: number, txCount: number): Promise<RpcReceipt[] | null> {
  if (rpc.supportsBlockReceipts) {
    const receipts = (await rpc.provider.send('eth_getBlockReceipts', [hexQuantity(height)])) as RpcReceipt[];
    if (Array.isArray(receipts) && receipts.length === txCount) return receipts;
  }
  return null;
}

// ------------------------------------------------------------------------------ target selection

interface Target {
  chainKey: number;
  height: number;
  blockHash: string;
  txHash: string;
  txIndex: number;
  txType: number;
  txFrom: string;
  txTo: string | null;
  logIndexInTx: number;
  blockWideLogIndex: number;
  topic1Payer: string;
  topic2Recipient: string;
  amountBaseUnits: string;
  logCountInTx: number;
  callSelector: string;
  qualifies: string;
}

/**
 * Walk back from `startHeight` and return the first mainnet USDC `Transfer` whose `topics[1]`
 * differs from the transaction's `from` field.
 *
 * Candidates are ranked by how few logs their transaction emitted, because a smaller encoded
 * transaction keeps the proof submission — and therefore the gas figure task 1.4 inherits — as
 * close to the floor as the target allows.
 */
async function findTarget(
  rpc: SourceRpc,
  usdc: string,
  startHeight: number,
  scanned: Json[],
): Promise<Target> {
  for (let height = startHeight; height > startHeight - MAX_BLOCKS_SCANNED; height -= 1) {
    const block = (await rpc.provider.send('eth_getBlockByNumber', [hexQuantity(height), true])) as {
      hash: string;
      transactions: RpcTransaction[];
    } | null;
    if (block === null) {
      scanned.push({ height, note: 'block not returned' });
      continue;
    }

    const receipts = await blockReceipts(rpc, height, block.transactions.length);
    if (receipts === null) {
      scanned.push({ height, note: 'eth_getBlockReceipts unavailable or incomplete; block skipped' });
      continue;
    }

    const candidates: Target[] = [];
    for (const receipt of receipts) {
      if (BigInt(receipt.status) !== 1n) continue;
      const tx = block.transactions.find((t) => sameAddress(t.hash, receipt.transactionHash));
      if (tx === undefined) continue;
      // Most clients repeat `from` on the receipt, but the block's transaction list is the
      // authoritative source for it, so fall back rather than assume.
      const txFrom = receipt.from ?? tx.from;
      if (typeof txFrom !== 'string') continue;

      for (let j = 0; j < receipt.logs.length; j += 1) {
        const log = receipt.logs[j];
        if (!sameAddress(log.address, usdc)) continue;
        if (log.topics.length !== 3 || log.topics[0].toLowerCase() !== TRANSFER_TOPIC0) continue;

        const payer = topicToAddress(log.topics[1]);
        const recipient = topicToAddress(log.topics[2]);
        // A mint or burn is degenerate: the zero address trivially differs from the gas payer
        // without demonstrating anything about routed payments.
        if (sameAddress(payer, ZERO_ADDRESS) || sameAddress(recipient, ZERO_ADDRESS)) continue;
        // The whole point. Equality here proves nothing, so it is not an acceptable target.
        if (sameAddress(payer, txFrom)) continue;

        candidates.push({
          chainKey: MAINNET_CHAIN_KEY,
          height,
          blockHash: block.hash,
          txHash: receipt.transactionHash,
          txIndex: Number(BigInt(receipt.transactionIndex)),
          txType: Number(BigInt(tx.type ?? '0x0')),
          txFrom,
          txTo: receipt.to ?? tx.to,
          logIndexInTx: j,
          blockWideLogIndex: Number(BigInt(log.logIndex)),
          topic1Payer: payer,
          topic2Recipient: recipient,
          amountBaseUnits: '0',
          logCountInTx: receipt.logs.length,
          callSelector: (tx.input ?? '0x').slice(0, 10),
          qualifies: explainQualification(receipt.to ?? tx.to, (tx.input ?? '0x').slice(0, 10), usdc),
        });
      }
    }

    scanned.push({
      height,
      transactions: block.transactions.length,
      qualifyingCandidates: candidates.length,
    });

    if (candidates.length > 0) {
      candidates.sort((a, b) => a.logCountInTx - b.logCountInTx || a.txIndex - b.txIndex);
      return candidates[0];
    }
  }
  throw new Error(
    `no mainnet USDC Transfer with topics[1] != from found in ${MAX_BLOCKS_SCANNED} blocks below ${startHeight}`,
  );
}

/** Read the log's amount word straight from the receipt, so the transcript carries the figure. */
async function readAmount(rpc: SourceRpc, target: Target): Promise<string> {
  const receipt = (await rpc.provider.send('eth_getTransactionReceipt', [target.txHash])) as RpcReceipt & {
    logs: (RpcLog & { data: string })[];
  };
  const log = receipt.logs[target.logIndexInTx];
  return BigInt(log.data).toString();
}

// -------------------------------------------------------------------------------- proof material

type SdkMerkleProof = { root: string; siblings: { hash: string; isLeft: boolean }[] };
type SdkContinuityProof = { lowerEndpointDigest: string; roots: string[] };

/** Plain, JSON-safe copies of the proof structures, so the transcript is replayable by hand. */
function plainMerkleProof(p: SdkMerkleProof): Json {
  return {
    root: p.root,
    siblings: p.siblings.map((s) => ({ hash: s.hash, isLeft: s.isLeft })),
    siblingCount: p.siblings.length,
  };
}

function plainContinuityProof(p: SdkContinuityProof): Json {
  return { lowerEndpointDigest: p.lowerEndpointDigest, roots: p.roots, rootCount: p.roots.length };
}

/**
 * Positional forms of the two proof structs.
 *
 * A `FunctionFragment` built from a bare type signature has unnamed tuple components, and ethers
 * refuses to encode a named object against one. Passing arrays sidesteps that without inventing an
 * ABI with names the precompile never published.
 */
const tupleMerkleProof = (p: SdkMerkleProof): unknown[] => [
  p.root,
  p.siblings.map((s) => [s.hash, s.isLeft]),
];

const tupleContinuityProof = (p: SdkContinuityProof): unknown[] => [p.lowerEndpointDigest, p.roots];

// --------------------------------------------------------------------------------- Sepolia control

/**
 * Control experiment. Runs only when the mainnet submission fails, and answers a narrower question
 * with a keyless `eth_call`: does the *same* code path verify on chainKey 1? A Sepolia pass with a
 * mainnet failure points at the mainnet attestation path; a failure on both points at our proof
 * handling.
 */
async function sepoliaControl(creditcoin: JsonRpcProvider, proverUrl: string): Promise<Json> {
  const record: Json = {
    purpose:
      'Distinguish "mainnet path broken" from "our proof material is malformed" by running the same ' +
      'submission shape against chainKey 1. Read-only: verify() is a view call, so no transaction and no gas.',
    chainKey: SEPOLIA_CHAIN_KEY,
  };
  try {
    const { frontier, record: frontierRecord } = await readFrontier(creditcoin, SEPOLIA_CHAIN_KEY);
    record.frontierRead = frontierRecord;
    if (frontier === null || !frontier.exists) {
      record.outcome = 'chainKey 1 reports no attestation; control could not run';
      return record;
    }
    record.attestedFrontier = frontier;

    const urls = (process.env.ETHEREUM_SEPOLIA_RPC_URLS ?? 'https://ethereum-sepolia-rpc.publicnode.com')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('http'));
    const height = frontier.height - HEIGHT_MARGIN_BELOW_FRONTIER;
    const { rpc, attempts } = await firstWorkingSourceRpc(urls, 11155111, height);
    record.endpointAttempts = attempts;

    const block = (await rpc.provider.send('eth_getBlockByNumber', [hexQuantity(height), true])) as {
      transactions: RpcTransaction[];
    };
    if (block.transactions.length === 0) {
      record.outcome = `Sepolia block ${height} carries no transactions; control could not run`;
      rpc.provider.destroy();
      return record;
    }
    const tx = block.transactions[0];
    record.controlTarget = { height, txHash: tx.hash, txIndex: Number(BigInt(tx.transactionIndex)) };

    const builder = new proofProvider.service.ProofBuilder(SEPOLIA_CHAIN_KEY, proverUrl, 60_000);
    const result = await builder.getProof(tx.hash);
    record.proofRequest = { success: result.success, error: result.error ?? null };
    if (!result.success || !result.data) {
      record.outcome = 'Proof Builder refused a Sepolia proof, so the control is inconclusive';
      rpc.provider.destroy();
      return record;
    }

    const data = result.data;
    record.proofMaterial = {
      headerNumber: data.headerNumber,
      txIndex: data.txIndex,
      merkleProof: plainMerkleProof(data.merkleProof as unknown as SdkMerkleProof),
      continuityProof: plainContinuityProof(data.continuityProof as SdkContinuityProof),
      encodedTransactionByteLength: (data.txBytes.length - 2) / 2,
    };

    const iface = new Interface([
      FunctionFragment.from(
        'verify(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[])) view returns (bool)',
      ),
    ]);
    const calldata = iface.encodeFunctionData('verify', [
      SEPOLIA_CHAIN_KEY,
      data.headerNumber,
      data.txBytes,
      tupleMerkleProof(data.merkleProof as unknown as SdkMerkleProof),
      tupleContinuityProof(data.continuityProof as SdkContinuityProof),
    ]);
    try {
      const raw = await creditcoin.call({ to: BLOCK_PROVER_PRECOMPILE, data: calldata });
      const verified = iface.decodeFunctionResult('verify', raw)[0] as boolean;
      record.verifyReturned = verified;
      record.outcome = verified
        ? 'chainKey 1 verifies through the same code path'
        : 'chainKey 1 also returns false';
    } catch (e) {
      record.verifyReturned = null;
      record.verifyError = errRecord(e);
      record.outcome = 'chainKey 1 verify() reverted';
    }
    rpc.provider.destroy();
  } catch (e) {
    record.error = errRecord(e);
    record.outcome = 'control could not run';
  }
  return record;
}

// ------------------------------------------------------------------------------------------- main

async function main(): Promise<void> {
  loadDotEnv();

  const creditcoinRpcUrl = requiredEnv('CREDITCOIN_RPC_URL');
  const creditcoinChainId = Number(requiredEnv('CREDITCOIN_CHAIN_ID'));
  const proverUrl = requiredEnv('PROOF_BUILDER_URL');
  const usdc = requiredEnv('MAINNET_USDC_ADDRESS');
  const mainnetUrls = requiredEnv('ETHEREUM_MAINNET_RPC_URLS')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('http'));
  const signingKey = requiredEnv('WATCHER_PRIVATE_KEY');

  const transcript: Json = {
    probedAt: new Date().toISOString(),
    task: 'tab 1.3 — deploy a throwaway probe contract that exercises the BlockProver Precompile',
    question:
      'Does a contract on CC3 Testnet verify a historical Ethereum Mainnet USDC Transfer through the ' +
      'BlockProver Precompile, and does the payer it reads from topics[1] differ from the transaction from field?',
    endpoints: {
      creditcoinRpc: redactUrl(creditcoinRpcUrl),
      creditcoinChainId,
      proofBuilder: redactUrl(proverUrl),
      ethereumMainnetRpcCandidates: mainnetUrls.map(redactUrl),
      chainInfoPrecompile: CHAIN_INFO_PRECOMPILE,
      blockProverPrecompile: BLOCK_PROVER_PRECOMPILE,
      mainnetUsdc: usdc,
    },
    constants: { transferTopic0: TRANSFER_TOPIC0, transactionVerifiedTopic0: TRANSACTION_VERIFIED_TOPIC0 },
    settings: {
      heightMarginBelowFrontier: HEIGHT_MARGIN_BELOW_FRONTIER,
      maxBlocksScanned: MAX_BLOCKS_SCANNED,
      jsonRpcBatchMaxCount: 1,
    },
  };

  const creditcoin = makeProvider(creditcoinRpcUrl, creditcoinChainId);
  const wallet = new Wallet(signingKey, creditcoin);

  let mainnetRpc: SourceRpc | null = null;

  try {
    // --- Creditcoin reachability and the submitting account ------------------------------------
    const [net, latest, feeData, balance, nonce] = await Promise.all([
      creditcoin.getNetwork(),
      creditcoin.getBlockNumber(),
      creditcoin.getFeeData(),
      creditcoin.getBalance(wallet.address),
      creditcoin.getTransactionCount(wallet.address),
    ]);
    const latestBlock = await creditcoin.getBlock(latest);
    transcript.creditcoin = {
      chainId: Number(net.chainId),
      latestBlock: latest,
      blockGasLimit: latestBlock?.gasLimit ?? null,
      gasPriceWei: feeData.gasPrice,
    };
    // Address only. The key itself never reaches this file or the log.
    transcript.submitter = { address: wallet.address, balanceWei: balance, nonce };

    // --- Attested frontier for chainKey 3 -----------------------------------------------------
    const { frontier, record: frontierRecord } = await readFrontier(creditcoin, MAINNET_CHAIN_KEY);
    transcript.attestationFrontier = { chainKey: MAINNET_CHAIN_KEY, read: frontierRecord, value: frontier };
    if (frontier === null || !frontier.exists) {
      throw new Error('ChainInfo reports no attestation for chainKey 3; there is nothing to prove against');
    }

    const startHeight = frontier.height - HEIGHT_MARGIN_BELOW_FRONTIER;
    console.log(`chainKey 3 attested frontier ${frontier.height}; searching from ${startHeight} downwards`);

    // --- Pick the target ----------------------------------------------------------------------
    const endpointResult = await firstWorkingSourceRpc(mainnetUrls, 1, startHeight);
    mainnetRpc = endpointResult.rpc;
    transcript.mainnetEndpointAttempts = endpointResult.attempts;
    transcript.mainnetEndpointUsed = redactUrl(mainnetRpc.url);

    const scanned: Json[] = [];
    const target = await findTarget(mainnetRpc, usdc, startHeight, scanned);
    target.amountBaseUnits = await readAmount(mainnetRpc, target);
    transcript.targetSearch = { startHeight, blocksInspected: scanned };
    transcript.target = {
      ...target,
      amountUsdc: (Number(target.amountBaseUnits) / 1e6).toFixed(6),
      payerDiffersFromTxFrom: !sameAddress(target.topic1Payer, target.txFrom),
      heightBelowFrontierBy: frontier.height - target.height,
    };
    console.log(
      `target ${target.txHash} at height ${target.height}: from=${target.txFrom} topics[1]=${target.topic1Payer}`,
    );

    // --- Attestation coverage for the chosen height -------------------------------------------
    const attested = await precompileCall(
      creditcoin,
      CHAIN_INFO_PRECOMPILE,
      CHAIN_INFO_SIGNATURES.isHeightAttested,
      [MAINNET_CHAIN_KEY, target.height],
    );
    const bounds = await precompileCall(
      creditcoin,
      CHAIN_INFO_PRECOMPILE,
      CHAIN_INFO_SIGNATURES.attestationBounds,
      [MAINNET_CHAIN_KEY, target.height],
    );
    transcript.attestationCoverage = {
      isHeightAttested: attested.record,
      attestationBounds: bounds.record,
      note:
        'Attestations land on a stride of 10 source blocks, so the chosen height is normally not itself an ' +
        'attestation endpoint. Closing that gap is exactly what the Continuity Proof does.',
    };

    // --- Proof material -----------------------------------------------------------------------
    const builder = new proofProvider.service.ProofBuilder(MAINNET_CHAIN_KEY, proverUrl, 60_000);
    transcript.sdkProofBuilding = {
      found: '@gluwa/usc-sdk@0.18.0 ships proofProvider.service.ProofBuilder',
      client: 'proofProvider.service.ProofBuilder(chainKey, builderUrl, timeoutMs)',
      endpointsItCalls: [
        'GET /api/v1/proof-by-tx/{chainKey}/{txHash}',
        'POST /api/v1/proof-batch-by-tx/{chainKey}',
        'GET /api/v1/attested-height/{chainKey}',
      ],
      note: 'No hand-rolled HTTP against the Proof Builder. The SDK client is used as published.',
    };

    await builder.waitUntilHeightAttested(MAINNET_CHAIN_KEY, target.height, 15_000, 900_000, 2_000);
    const proofResult = await builder.getProof(target.txHash);
    transcript.proofRequest = { success: proofResult.success, error: proofResult.error ?? null };
    if (!proofResult.success || !proofResult.data) {
      throw new Error(`Proof Builder returned no proof: ${proofResult.error}`);
    }
    const proof = proofResult.data;
    const merkleProof = proof.merkleProof as unknown as SdkMerkleProof;
    const continuityProof = proof.continuityProof as SdkContinuityProof;

    transcript.proofMaterial = {
      chainKey: proof.chainKey,
      headerNumber: proof.headerNumber,
      txIndexReportedByProofBuilder: proof.txIndex,
      txHash: proof.txHash,
      cached: proof.cached,
      generatedAt: proof.generatedAt,
      merkleProof: plainMerkleProof(merkleProof),
      continuityProof: plainContinuityProof(continuityProof),
      encodedTransaction: proof.txBytes,
      encodedTransactionByteLength: (proof.txBytes.length - 2) / 2,
    };

    const proofAgreesWithTarget = {
      heightMatches: proof.headerNumber === target.height,
      txHashMatches: sameAddress(proof.txHash, target.txHash),
      txIndexMatches: proof.txIndex === target.txIndex,
    };
    transcript.proofAgreesWithTarget = proofAgreesWithTarget;

    // --- Read-only precompile checks before spending anything ----------------------------------
    const verifyIface = new Interface([
      FunctionFragment.from(
        'verify(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[])) view returns (bool)',
      ),
      FunctionFragment.from('calculateTxIndex((bytes32,(bytes32,bool)[])) view returns (uint64)'),
    ]);

    const preflight: Json = {};
    try {
      const raw = await creditcoin.call({
        to: BLOCK_PROVER_PRECOMPILE,
        data: verifyIface.encodeFunctionData('verify', [
          MAINNET_CHAIN_KEY,
          proof.headerNumber,
          proof.txBytes,
          tupleMerkleProof(merkleProof),
          tupleContinuityProof(continuityProof),
        ]),
      });
      preflight.verifyReturned = verifyIface.decodeFunctionResult('verify', raw)[0] as boolean;
    } catch (e) {
      preflight.verifyReturned = null;
      preflight.verifyError = errRecord(e);
    }
    try {
      const raw = await creditcoin.call({
        to: BLOCK_PROVER_PRECOMPILE,
        data: verifyIface.encodeFunctionData('calculateTxIndex', [tupleMerkleProof(merkleProof)]),
      });
      preflight.calculateTxIndexDirect = Number(
        verifyIface.decodeFunctionResult('calculateTxIndex', raw)[0] as bigint,
      );
    } catch (e) {
      preflight.calculateTxIndexDirect = null;
      preflight.calculateTxIndexError = errRecord(e);
    }
    transcript.precompilePreflight = preflight;

    // --- Deploy the probe ----------------------------------------------------------------------
    if (!existsSync(ARTIFACT_PATH)) {
      throw new Error(`Probe artifact missing at ${ARTIFACT_PATH}. Run \`forge build\` inside spike/ first.`);
    }
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as {
      abi: unknown[];
      bytecode: { object: string };
      metadata?: { compiler?: { version?: string } };
    };
    const factory = new ContractFactory(artifact.abi as never, artifact.bytecode.object, wallet);
    const deployed = await factory.deploy();
    const deployTx = deployed.deploymentTransaction();
    const deployReceipt = await deployed.deploymentTransaction()?.wait();
    const probeAddress = await deployed.getAddress();
    transcript.probeContract = {
      source: 'spike/Probe.sol',
      solcVersion: artifact.metadata?.compiler?.version ?? '0.8.23',
      address: probeAddress,
      deploymentTxHash: deployTx?.hash ?? null,
      deploymentBlock: deployReceipt?.blockNumber ?? null,
      deploymentGasUsed: deployReceipt?.gasUsed ?? null,
      deployedBytecodeLength: (artifact.bytecode.object.length - 2) / 2,
      libraryLinkingRequired: false,
    };
    console.log(`probe deployed at ${probeAddress} (tx ${deployTx?.hash})`);

    const probe = new Contract(probeAddress, artifact.abi as never, wallet);

    // `calculateTxIndex` through the probe, keyless and gasless, cross-checked against the index
    // read straight from the mainnet RPC.
    const txIndexFromProof = Number((await probe.txIndexOf.staticCall(merkleProof)) as bigint);
    transcript.txIndexCrossCheck = {
      fromMainnetRpc: target.txIndex,
      fromCalculateTxIndexViaProbe: txIndexFromProof,
      fromCalculateTxIndexDirect: preflight.calculateTxIndexDirect ?? null,
      fromProofBuilder: proof.txIndex,
      agrees: txIndexFromProof === target.txIndex,
    };

    // Decode-only, so a decoding problem is separable from a proving problem.
    try {
      const decoded = (await probe.decodeOnly.staticCall(
        proof.txBytes,
        target.logIndexInTx,
        usdc,
        TRANSFER_TOPIC0,
      )) as unknown as [string, string, string, bigint, bigint, bigint];
      transcript.decodeOnly = {
        payer: decoded[0],
        txFrom: decoded[1],
        recipient: decoded[2],
        amountBaseUnits: decoded[3],
        receiptStatus: Number(decoded[4]),
        logCount: Number(decoded[5]),
      };
    } catch (e) {
      transcript.decodeOnly = { error: errRecord(e) };
    }

    // --- Submit ---------------------------------------------------------------------------------
    const input = {
      chainKey: MAINNET_CHAIN_KEY,
      height: proof.headerNumber,
      encodedTransaction: proof.txBytes,
      merkleProof,
      continuityProof,
      asset: usdc,
      transferTopic0: TRANSFER_TOPIC0,
      logIndexInTx: target.logIndexInTx,
    };
    transcript.submittedCalldata = {
      function: 'probe(ProofInput)',
      argumentsAsSubmitted: {
        chainKey: input.chainKey,
        height: input.height,
        asset: input.asset,
        transferTopic0: input.transferTopic0,
        logIndexInTx: input.logIndexInTx,
        merkleProof: plainMerkleProof(merkleProof),
        continuityProof: plainContinuityProof(continuityProof),
        encodedTransaction: proof.txBytes,
      },
      note: 'Every field above is what went on the wire. A third party can replay the submission from this alone.',
    };

    // Dry run first, so a revert costs nothing and still yields exact revert data.
    const dryRun: Json = {};
    try {
      const result = (await probe.probe.staticCall(input)) as unknown as [string, string, bigint, bigint];
      dryRun.reverted = false;
      dryRun.payer = result[0];
      dryRun.txFrom = result[1];
      dryRun.txIndex = Number(result[2]);
      dryRun.verifyAndEmitGasUsed = result[3];
    } catch (e) {
      dryRun.reverted = true;
      dryRun.error = errRecord(e);
    }
    transcript.dryRun = dryRun;

    let gasLimit = FALLBACK_GAS_LIMIT;
    try {
      const estimate = await probe.probe.estimateGas(input);
      gasLimit = (estimate * 15n) / 10n;
      transcript.gasEstimate = { estimated: estimate, gasLimitUsed: gasLimit };
    } catch (e) {
      transcript.gasEstimate = { estimated: null, gasLimitUsed: gasLimit, error: errRecord(e) };
    }

    const submission: Json = {};
    try {
      const tx = await probe.probe(input, { gasLimit });
      submission.creditcoinTxHash = tx.hash;
      console.log(`probe submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      submission.status = receipt?.status ?? null;
      submission.blockNumber = receipt?.blockNumber ?? null;
      submission.totalGasUsed = receipt?.gasUsed ?? null;
      submission.effectiveGasPriceWei = receipt?.gasPrice ?? null;
      submission.logCount = receipt?.logs.length ?? 0;

      // The precompile's own event is independent evidence that verification happened.
      const precompileEvents = (receipt?.logs ?? [])
        .filter((l) => l.topics[0]?.toLowerCase() === TRANSACTION_VERIFIED_TOPIC0)
        .map((l) => ({
          emitter: l.address,
          chainKey: Number(BigInt(l.topics[1])),
          height: Number(BigInt(l.topics[2])),
          transactionIndex: Number(BigInt(l.data)),
        }));
      submission.transactionVerifiedEvents = precompileEvents;

      const probeEvents = (receipt?.logs ?? [])
        .map((l) => {
          try {
            return probe.interface.parseLog({ topics: [...l.topics], data: l.data });
          } catch {
            return null;
          }
        })
        .filter((p): p is NonNullable<typeof p> => p !== null && p.name === 'ProbeResult');

      if (probeEvents.length === 0) {
        submission.probeResultEvent = null;
        submission.verifyAndEmitReturnedTrue = false;
      } else {
        const args = probeEvents[0].args;
        submission.probeResultEvent = {
          chainKey: Number(args.chainKey as bigint),
          height: Number(args.height as bigint),
          txIndex: Number(args.txIndex as bigint),
          payerFromTopic1: args.payerFromTopic1 as string,
          txFrom: args.txFrom as string,
          recipientFromTopic2: args.recipientFromTopic2 as string,
          amountBaseUnits: (args.amount as bigint).toString(),
          payerDiffersFromTxFrom: args.payerDiffersFromTxFrom as boolean,
          verifyAndEmitGasUsed: (args.verifyAndEmitGasUsed as bigint).toString(),
          sourceReceiptStatus: Number(args.sourceReceiptStatus as bigint),
          sourceLogCount: Number(args.sourceLogCount as bigint),
        };
        // The probe reverts unless verifyAndEmit returned true, so a receipt carrying this event is
        // itself the positive answer.
        submission.verifyAndEmitReturnedTrue = true;
      }
    } catch (e) {
      submission.reverted = true;
      submission.error = errRecord(e);
      submission.verifyAndEmitReturnedTrue = false;
    }
    transcript.submission = submission;

    // --- Assertions ------------------------------------------------------------------------------
    const emitted = submission.probeResultEvent as Json | null | undefined;
    const emittedPayer = emitted ? (emitted.payerFromTopic1 as string) : null;
    const emittedTxFrom = emitted ? (emitted.txFrom as string) : null;

    const assertions = {
      verifyAndEmitReturnedTrue: submission.verifyAndEmitReturnedTrue === true,
      emittedPayerEqualsTopic1: emittedPayer !== null && sameAddress(emittedPayer, target.topic1Payer),
      emittedPayerDiffersFromTxFrom: emittedPayer !== null && !sameAddress(emittedPayer, target.txFrom),
      emittedTxFromEqualsMainnetFrom: emittedTxFrom !== null && sameAddress(emittedTxFrom, target.txFrom),
      calculateTxIndexAgreesWithMainnetRpc: txIndexFromProof === target.txIndex,
      emittedTxIndexAgreesWithMainnetRpc: emitted ? Number(emitted.txIndex) === target.txIndex : false,
      proofHeightMatchesTarget: proofAgreesWithTarget.heightMatches,
      chosenHeightBelowAttestedFrontier: target.height < frontier.height,
    };
    transcript.assertions = assertions;
    transcript.comparison = {
      topic1Payer: target.topic1Payer,
      transactionFrom: target.txFrom,
      emittedPayer: emittedPayer,
      emittedTxFrom: emittedTxFrom,
      statement:
        'Credit must follow topics[1]. On this target the gas payer is a different address entirely, so ' +
        'resolving the payer from the transaction from field would credit the wrong party.',
    };

    const allPassed = Object.values(assertions).every(Boolean);
    transcript.verdict = {
      mainnetPathVerifiesEndToEnd: allPassed,
      verifyAndEmitGasUsed: emitted ? emitted.verifyAndEmitGasUsed : null,
      totalCreditcoinGasUsedForOneProbeCall: submission.totalGasUsed ?? null,
      failedAssertions: Object.entries(assertions)
        .filter(([, v]) => !v)
        .map(([k]) => k),
      demoPath: allPassed
        ? 'Ethereum Mainnet, chainKey 3. Tasks 12 through 29 stand as planned.'
        : 'Not established by this probe. Re-plan against the Sepolia-only degraded mode on chainKey 1.',
    };

    if (!allPassed) {
      console.log('mainnet path did not verify; running the Sepolia control');
      transcript.sepoliaControl = await sepoliaControl(creditcoin, proverUrl);
    } else {
      transcript.sepoliaControl = {
        skipped: true,
        reason: 'The mainnet path verified end to end, so no control was needed to attribute a failure.',
      };
    }

    writeTranscript(transcript);
    console.log(JSON.stringify(transcript.verdict, jsonReplacer, 2));
    console.log(`\nTranscript written to ${OUT_PATH}`);
    if (!allPassed) process.exitCode = 1;
  } catch (e) {
    transcript.fatal = errRecord(e);
    transcript.verdict = {
      mainnetPathVerifiesEndToEnd: false,
      demoPath: 'Not established. The probe could not complete; see `fatal`.',
    };
    try {
      transcript.sepoliaControl = await sepoliaControl(creditcoin, proverUrl);
    } catch (inner) {
      transcript.sepoliaControl = { error: errRecord(inner) };
    }
    writeTranscript(transcript);
    console.error(errText(e));
    console.error(`\nTranscript written to ${OUT_PATH}`);
    process.exitCode = 1;
  } finally {
    mainnetRpc?.provider.destroy();
    creditcoin.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
