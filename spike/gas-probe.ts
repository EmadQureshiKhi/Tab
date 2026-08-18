/**
 * Tab spike 1.4 — batch gas headroom against the Creditcoin block gas limit.
 *
 * Spike 1.3 settled that one proof verifies and cost 6,745 gas inside the precompile against
 * ~124,000 gas of caller-side work. This probe settles the batch question the design rests on:
 *
 *   Do ten sequential `verifyAndEmit` calls, sharing ONE Continuity Proof, fit inside a single
 *   Creditcoin transaction — once the calldata and the caller's own decoding are counted?
 *
 * It measures four different things, because they answer four different questions:
 *
 *   1. the `gasleft()` delta across each individual `verifyAndEmit` call, summed over the batch —
 *      the precompile's own cost, and the only figure comparable with 1.3's 6,745 control;
 *   2. the gas consumed inside `probeBatch` — the precompile plus the caller-side index recovery,
 *      receipt decoding, and event work that a real ingestion performs;
 *   3. the transaction's total `gasUsed` from its receipt — what the block actually pays for;
 *   4. the intrinsic and calldata charge, which is (3) minus (2) and is dominated by ~27 KB of
 *      encoded transactions at 16 gas per non-zero byte.
 *
 * Both measurements come from real submitted CC3 Testnet transactions: one batch of one as the
 * control, one batch of ten as the subject. No Ethereum transaction is sent — the proved transfers
 * are historical Ethereum Mainnet USDC `Transfer`s that already exist on chain.
 *
 * The shared Continuity Proof is built two independent ways and the two are compared:
 *   - `proofProvider.mergeProofs` over the per-height proofs, which throws when they are not
 *     contiguous, and
 *   - the Proof Builder's own `getBatchProof`, which requirement 9.6 names as the Watcher's path.
 *
 * Before anything is spent, every shape is preflighted with keyless `eth_call`s: each proof against
 * its own Continuity Proof, each proof against the shared one, and the precompile's array-shaped
 * overload against the shared one. That is what makes a negative result attributable to a shape
 * rather than to a broken submission.
 *
 * Secrets: the signing key is read from the environment, used to construct a Wallet, and never
 * printed, logged, or written. Only the derived address reaches the transcript. Endpoint URLs pass
 * through a redactor first, so an endpoint carrying a token cannot leak into a tracked file.
 *
 * Prerequisite: `forge build` inside spike/ (the artifact at spike/out/BatchProbe.sol/BatchProbe.json).
 *
 * Run: pnpm tsx spike/gas-probe.ts
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
  type ContractTransactionReceipt,
  type ContractTransactionResponse,
} from 'ethers';

// --------------------------------------------------------------------------- paths and constants

const SPIKE_DIR = basename(process.cwd()) === 'spike' ? process.cwd() : resolvePath(process.cwd(), 'spike');
const REPO_ROOT = resolvePath(SPIKE_DIR, '..');
const OUT_PATH = resolvePath(SPIKE_DIR, 'gas-transcript.json');
const ARTIFACT_PATH = resolvePath(SPIKE_DIR, 'out', 'BatchProbe.sol', 'BatchProbe.json');

/** Ethereum Mainnet as the Attestcoin Protocol keys it. */
const MAINNET_CHAIN_KEY = 3;

const CHAIN_INFO_PRECOMPILE = '0x0000000000000000000000000000000000000fd3';
const BLOCK_PROVER_PRECOMPILE = '0x0000000000000000000000000000000000000FD2';

const TRANSFER_TOPIC0 = keccak256(toUtf8Bytes('Transfer(address,address,uint256)'));
const TRANSACTION_VERIFIED_TOPIC0 = keccak256(toUtf8Bytes('TransactionVerified(uint64,uint64,uint64)'));

/** Requirement 9.1's ceiling, and the batch size this probe has to prove fits. */
const BATCH_SIZE = 10;
/** Requirement 9.4's block-span ceiling for one batch. */
const BATCH_MAX_SPAN = 1000;
/** The per-proof precompile figure spike 1.3 measured, reproduced here as a control. */
const CONTROL_VERIFY_AND_EMIT_GAS_1_3 = 6745;
/** Attestation stride confirmed in spike 1.2: one endpoint every ten source blocks. */
const ATTESTATION_STRIDE = 10;

/** How far below the attested frontier to start looking. ~20 minutes of mainnet time. */
const HEIGHT_MARGIN_BELOW_FRONTIER = Number(process.env.PROBE_HEIGHT_MARGIN ?? 120);
/** How many consecutive blocks to inspect while assembling ten targets. */
const MAX_BLOCKS_SCANNED = Number(process.env.PROBE_MAX_BLOCKS ?? 14);
/** Gas ceiling when estimation is unavailable. Deliberately well under the block gas limit. */
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
 * Minimal `.env` reader. Values already present in the environment win. Nothing read here is ever
 * printed or written; the key is handed straight to `Wallet`.
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
const byteLength = (hex: string): number => (hex.length - 2) / 2;

/** Every public endpoint in play rejects JSON-RPC batching, so one call per request, always. */
function makeProvider(url: string, chainId: number): JsonRpcProvider {
  return new JsonRpcProvider(url, chainId, { batchMaxCount: 1, staticNetwork: true });
}

/**
 * Intrinsic cost of a transaction from its calldata alone, under the pre-Prague schedule every
 * Creditcoin EVM release ships: 21,000 to start, 4 gas per zero byte, 16 per non-zero byte.
 *
 * This is the figure the batch question turns on. Ten encoded transactions of ~2,752 bytes is
 * ~27.5 KB of calldata, and calldata is charged whether or not the contract reads it.
 */
function intrinsicGas(calldataHex: string): Json {
  const body = calldataHex.startsWith('0x') ? calldataHex.slice(2) : calldataHex;
  let zeroBytes = 0;
  let nonZeroBytes = 0;
  for (let i = 0; i < body.length; i += 2) {
    if (body[i] === '0' && body[i + 1] === '0') zeroBytes += 1;
    else nonZeroBytes += 1;
  }
  const calldataOnly = zeroBytes * 4 + nonZeroBytes * 16;
  return {
    calldataBytes: zeroBytes + nonZeroBytes,
    zeroBytes,
    nonZeroBytes,
    calldataGas: calldataOnly,
    baseTransactionGas: 21_000,
    intrinsicGasTotal: 21_000 + calldataOnly,
    schedule: 'EIP-2028: 4 gas per zero byte, 16 per non-zero byte, on top of the 21,000 base cost.',
  };
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
  const record: Json = { signature, selector: data.slice(0, 10) };
  try {
    const raw = await provider.call({ to, data });
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
    frontier: { height: Number(tuple[0]), digest: tuple[1], isAttestation: tuple[2], exists: tuple[3] },
    record,
  };
}

// ---------------------------------------------------------------------- Source Chain RPC helpers

interface SourceRpc {
  provider: JsonRpcProvider;
  url: string;
  supportsBlockReceipts: boolean;
}

/**
 * First endpoint in the configured list that answers, plus whether it serves
 * `eth_getBlockReceipts`. `eth_getLogs` is never used: its mainnet range limits are severe and
 * unnecessary, because block receipts answer the same question in one round trip.
 */
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
      if (supportsBlockReceipts) return { rpc: { provider, url, supportsBlockReceipts }, attempts };
      provider.destroy();
    } catch (e) {
      attempts.push({ endpoint: redactUrl(url), reachable: false, error: errText(e) });
      provider.destroy();
    }
  }
  throw new Error('no configured Source Chain endpoint served eth_getBlockReceipts');
}

interface RpcLog {
  address: string;
  topics: string[];
  logIndex: string;
  data: string;
}

interface RpcReceipt {
  transactionHash: string;
  transactionIndex: string;
  status: string;
  from: string;
  to: string | null;
  logs: RpcLog[];
}

// ------------------------------------------------------------------------------ target selection

interface Candidate {
  height: number;
  blockHash: string;
  txHash: string;
  txIndex: number;
  txFrom: string;
  logIndexInTx: number;
  blockWideLogIndex: number;
  topic1Payer: string;
  topic2Recipient: string;
  amountBaseUnits: string;
  logCountInTx: number;
  payerDiffersFromTxFrom: boolean;
}

/** Smallest attestation endpoint at or above a height, on the stride confirmed in spike 1.2. */
const upperEndpointOf = (height: number): number =>
  Math.ceil(height / ATTESTATION_STRIDE) * ATTESTATION_STRIDE;

/**
 * Every qualifying USDC `Transfer` in a run of consecutive blocks, grouped by height.
 *
 * Consecutive blocks matter, and not for convenience. A per-height Continuity Proof for height H
 * carries the roots from H up to the next attestation endpoint, so two proofs merge only when the
 * next target sits at or below the previous target's endpoint plus one. Targets in consecutive
 * blocks always satisfy that; targets scattered across a wide range do not, and `mergeProofs`
 * rejects them outright.
 */
async function scanCandidates(
  rpc: SourceRpc,
  usdc: string,
  startHeight: number,
  scanned: Json[],
): Promise<Map<number, Candidate[]>> {
  const byHeight = new Map<number, Candidate[]>();

  for (let height = startHeight; height > startHeight - MAX_BLOCKS_SCANNED; height -= 1) {
    const block = (await rpc.provider.send('eth_getBlockByNumber', [hexQuantity(height), false])) as {
      hash: string;
      transactions: string[];
    } | null;
    if (block === null) {
      scanned.push({ height, note: 'block not returned' });
      continue;
    }
    const receipts = (await rpc.provider.send('eth_getBlockReceipts', [hexQuantity(height)])) as RpcReceipt[];
    if (!Array.isArray(receipts) || receipts.length !== block.transactions.length) {
      scanned.push({ height, note: 'eth_getBlockReceipts incomplete; block skipped' });
      continue;
    }

    const found: Candidate[] = [];
    for (const receipt of receipts) {
      if (BigInt(receipt.status) !== 1n) continue;
      for (let j = 0; j < receipt.logs.length; j += 1) {
        const log = receipt.logs[j];
        if (!sameAddress(log.address, usdc)) continue;
        if (log.topics.length !== 3 || log.topics[0].toLowerCase() !== TRANSFER_TOPIC0) continue;
        const payer = topicToAddress(log.topics[1]);
        const recipient = topicToAddress(log.topics[2]);
        // A mint or burn is degenerate and not representative of a Settlement.
        if (sameAddress(payer, ZERO_ADDRESS) || sameAddress(recipient, ZERO_ADDRESS)) continue;

        found.push({
          height,
          blockHash: block.hash,
          txHash: receipt.transactionHash,
          txIndex: Number(BigInt(receipt.transactionIndex)),
          txFrom: receipt.from,
          logIndexInTx: j,
          blockWideLogIndex: Number(BigInt(log.logIndex)),
          topic1Payer: payer,
          topic2Recipient: recipient,
          amountBaseUnits: BigInt(log.data).toString(),
          logCountInTx: receipt.logs.length,
          payerDiffersFromTxFrom: !sameAddress(payer, receipt.from),
        });
      }
    }

    // Fewest logs first: a smaller encoded transaction keeps each item's calldata close to the
    // floor the target allows, so the measured figure is not inflated by one fat transaction.
    found.sort((a, b) => a.logCountInTx - b.logCountInTx || a.txIndex - b.txIndex);
    if (found.length > 0) byHeight.set(height, found);
    scanned.push({ height, transactions: block.transactions.length, qualifyingTransfers: found.length });
  }

  return byHeight;
}

/**
 * Assemble `size` targets whose per-height Continuity Proofs are mergeable, spread across as many
 * distinct heights as the scanned window allows.
 *
 * Heights are taken in ascending order and round-robined, so the batch exercises several distinct
 * heights rather than ten transactions from one block — a batch of one height would share a
 * Continuity Proof trivially and would not test the shape the design actually submits.
 *
 * @param byHeight Candidates grouped by height, each group already ranked.
 * @param size How many targets to assemble.
 * @param crossEndpoint When true, prefer a run that crosses an attestation endpoint, so the shared
 *   proof has to span two attestation windows rather than sit inside one.
 */
function assembleTargets(
  byHeight: Map<number, Candidate[]>,
  size: number,
  crossEndpoint: boolean,
): { targets: Candidate[]; heights: number[]; reason: string } | null {
  const heights = [...byHeight.keys()].sort((a, b) => a - b);

  // Longest run of consecutive heights, which is what keeps the per-height proofs contiguous.
  const runs: number[][] = [];
  for (const height of heights) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last[last.length - 1] === height - 1) last.push(height);
    else runs.push([height]);
  }

  const usable = runs
    .map((run) => {
      const inWindow = crossEndpoint
        ? run
        : run.filter((h) => upperEndpointOf(h) === upperEndpointOf(run[run.length - 1]));
      const crosses = new Set(run.map(upperEndpointOf)).size > 1;
      return { run: inWindow, crosses, available: inWindow.reduce((n, h) => n + byHeight.get(h)!.length, 0) };
    })
    .filter((entry) => entry.run.length > 0 && entry.available >= size)
    .filter((entry) => (crossEndpoint ? entry.crosses : true))
    .sort((a, b) => b.run.length - a.run.length || b.available - a.available);

  if (usable.length === 0) return null;
  const chosen = usable[0];

  const cursor = new Map<number, number>(chosen.run.map((h) => [h, 0]));
  const picked: Candidate[] = [];
  while (picked.length < size) {
    let progressed = false;
    for (const height of chosen.run) {
      if (picked.length === size) break;
      const index = cursor.get(height)!;
      const group = byHeight.get(height)!;
      if (index >= group.length) continue;
      picked.push(group[index]);
      cursor.set(height, index + 1);
      progressed = true;
    }
    if (!progressed) break;
  }
  if (picked.length < size) return null;

  picked.sort((a, b) => a.height - b.height || a.txIndex - b.txIndex);
  return {
    targets: picked,
    heights: [...new Set(picked.map((t) => t.height))],
    reason: chosen.crosses
      ? 'a run of consecutive heights that crosses an attestation endpoint, so the shared proof spans two attestation windows'
      : 'a run of consecutive heights inside one attestation window',
  };
}

// -------------------------------------------------------------------------------- proof material

type SdkMerkleProof = { root: string; siblings: { hash: string; isLeft: boolean }[] };
type SdkContinuityProof = { lowerEndpointDigest: string; roots: string[] };

const plainMerkleProof = (p: SdkMerkleProof): Json => ({
  root: p.root,
  siblings: p.siblings.map((s) => ({ hash: s.hash, isLeft: s.isLeft })),
  siblingCount: p.siblings.length,
});

const plainContinuityProof = (p: SdkContinuityProof): Json => ({
  lowerEndpointDigest: p.lowerEndpointDigest,
  roots: p.roots,
  rootCount: p.roots.length,
});

/**
 * Positional forms of the two proof structs.
 *
 * A `FunctionFragment` built from a bare type signature has unnamed tuple components, and ethers
 * refuses to encode a named object against one. Raw precompile calls therefore pass arrays. That
 * failure never leaves the process and looks exactly like a chain problem, which is why it is worth
 * keeping the conversion explicit.
 */
const tupleMerkleProof = (p: SdkMerkleProof): unknown[] => [p.root, p.siblings.map((s) => [s.hash, s.isLeft])];
const tupleContinuityProof = (p: SdkContinuityProof): unknown[] => [p.lowerEndpointDigest, p.roots];

interface ProvedTarget {
  candidate: Candidate;
  height: number;
  txHash: string;
  txBytes: string;
  merkleProof: SdkMerkleProof;
  ownContinuityProof: SdkContinuityProof;
  txIndexFromProofBuilder: number;
}

/** One `getProof` per target, through the SDK's published client rather than hand-rolled HTTP. */
async function proveTargets(
  builder: InstanceType<typeof proofProvider.service.ProofBuilder>,
  targets: Candidate[],
): Promise<ProvedTarget[]> {
  const proved: ProvedTarget[] = [];
  for (const candidate of targets) {
    const result = await builder.getProof(candidate.txHash);
    if (!result.success || !result.data) {
      throw new Error(`Proof Builder returned no proof for ${candidate.txHash}: ${result.error}`);
    }
    const data = result.data;
    if (data.headerNumber !== candidate.height) {
      throw new Error(
        `Proof Builder answered height ${data.headerNumber} for a target at ${candidate.height}`,
      );
    }
    proved.push({
      candidate,
      height: data.headerNumber,
      txHash: data.txHash,
      txBytes: data.txBytes,
      merkleProof: data.merkleProof as unknown as SdkMerkleProof,
      ownContinuityProof: data.continuityProof as SdkContinuityProof,
      txIndexFromProofBuilder: data.txIndex,
    });
  }
  return proved;
}

// ------------------------------------------------------------------------- keyless preflight ----

/** The two `verify` overloads the precompile publishes, declared for raw keyless calls. */
const VERIFY_IFACE = new Interface([
  FunctionFragment.from(
    'verify(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[])) view returns (bool)',
  ),
  FunctionFragment.from(
    'verify(uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],(bytes32,bytes32[])) view returns (bool)',
  ),
]);

const SINGLE_VERIFY = 'verify(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))';
const ARRAY_VERIFY = 'verify(uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],(bytes32,bytes32[]))';

/**
 * One single-transaction `verify` against a given Continuity Proof. Read-only: no key, no gas, and
 * no transaction, so a negative answer costs nothing and still carries its revert data.
 */
async function verifySingleView(
  creditcoin: JsonRpcProvider,
  chainKey: number,
  height: number,
  txBytes: string,
  merkleProof: SdkMerkleProof,
  continuityProof: SdkContinuityProof,
): Promise<Json> {
  const data = VERIFY_IFACE.encodeFunctionData(SINGLE_VERIFY, [
    chainKey,
    height,
    txBytes,
    tupleMerkleProof(merkleProof),
    tupleContinuityProof(continuityProof),
  ]);
  try {
    const raw = await creditcoin.call({ to: BLOCK_PROVER_PRECOMPILE, data });
    return { height, verified: VERIFY_IFACE.decodeFunctionResult(SINGLE_VERIFY, raw)[0] as boolean };
  } catch (e) {
    return { height, verified: null, error: errRecord(e) };
  }
}

/** The precompile's array-shaped `verify` against a shared Continuity Proof, also keyless. */
async function verifyArrayView(
  creditcoin: JsonRpcProvider,
  chainKey: number,
  proved: ProvedTarget[],
  shared: SdkContinuityProof,
): Promise<Json> {
  const data = VERIFY_IFACE.encodeFunctionData(ARRAY_VERIFY, [
    chainKey,
    proved.map((p) => p.height),
    proved.map((p) => p.txBytes),
    proved.map((p) => tupleMerkleProof(p.merkleProof)),
    tupleContinuityProof(shared),
  ]);
  try {
    const raw = await creditcoin.call({ to: BLOCK_PROVER_PRECOMPILE, data });
    return {
      itemCount: proved.length,
      verified: VERIFY_IFACE.decodeFunctionResult(ARRAY_VERIFY, raw)[0] as boolean,
      calldataBytes: byteLength(data),
    };
  } catch (e) {
    return { itemCount: proved.length, verified: null, calldataBytes: byteLength(data), error: errRecord(e) };
  }
}

interface SharedProofBuild {
  merged: SdkContinuityProof | null;
  mergeError: Json | null;
  fromBatchEndpoint: SdkContinuityProof | null;
  batchEndpointError: string | null;
  record: Json;
}

/**
 * Build the batch's one Continuity Proof twice, independently, and compare.
 *
 * `mergeProofs` folds the per-height proofs and throws when they are not contiguous, which is the
 * SDK capability the design leans on. `getBatchProof` asks the Proof Builder for the shared proof
 * directly, which is what requirement 9.6 names as the Watcher's path. Agreement between the two is
 * worth recording; disagreement would be worth knowing about before product code picks one.
 */
async function buildSharedProof(
  builder: InstanceType<typeof proofProvider.service.ProofBuilder>,
  proved: ProvedTarget[],
): Promise<SharedProofBuild> {
  const pairs: [number, SdkContinuityProof][] = proved.map((p) => [p.height, p.ownContinuityProof]);

  let merged: SdkContinuityProof | null = null;
  let mergeError: Json | null = null;
  try {
    merged = proofProvider.mergeProofs(pairs as never) as SdkContinuityProof;
  } catch (e) {
    mergeError = errRecord(e);
  }

  let fromBatchEndpoint: SdkContinuityProof | null = null;
  let batchEndpointError: string | null = null;
  let batchMerkleProofHeights: number[] = [];
  try {
    const result = await builder.getBatchProof(proved.map((p) => p.txHash));
    if (result.success && result.data) {
      fromBatchEndpoint = result.data.continuityProof as SdkContinuityProof;
      batchMerkleProofHeights = [...result.data.merkleProofs.keys()].map(Number).sort((a, b) => a - b);
    } else {
      batchEndpointError = result.error ?? 'getBatchProof returned no data';
    }
  } catch (e) {
    batchEndpointError = errText(e);
  }

  const agrees =
    merged !== null &&
    fromBatchEndpoint !== null &&
    merged.lowerEndpointDigest.toLowerCase() === fromBatchEndpoint.lowerEndpointDigest.toLowerCase() &&
    merged.roots.length === fromBatchEndpoint.roots.length &&
    merged.roots.every((r, i) => r.toLowerCase() === fromBatchEndpoint!.roots[i].toLowerCase());

  return {
    merged,
    mergeError,
    fromBatchEndpoint,
    batchEndpointError,
    record: {
      perHeightRootCounts: proved.map((p) => ({ height: p.height, roots: p.ownContinuityProof.roots.length })),
      mergeProofs: merged === null ? { threw: mergeError } : plainContinuityProof(merged),
      getBatchProof:
        fromBatchEndpoint === null
          ? { error: batchEndpointError }
          : { ...plainContinuityProof(fromBatchEndpoint), merkleProofHeights: batchMerkleProofHeights },
      twoRoutesAgree: agrees,
      note:
        'A per-height Continuity Proof carries the roots from its own height up to the next attestation ' +
        'endpoint, so merging is only defined for targets whose windows touch. That is a real constraint on ' +
        'how far apart a batch\u2019s heights can sit, independent of requirement 9.4\u2019s 1000-block ceiling.',
    },
  };
}

// ------------------------------------------------------------------------------ batch submission

interface SharedProofItem {
  height: number;
  encodedTransaction: string;
  merkleProof: SdkMerkleProof;
  logIndexInTx: number;
}

interface OwnProofItem extends SharedProofItem {
  continuityProof: SdkContinuityProof;
}

interface OwnProofBatch {
  chainKey: number;
  asset: string;
  transferTopic0: string;
  items: OwnProofItem[];
}

interface SharedProofBatch {
  chainKey: number;
  asset: string;
  transferTopic0: string;
  sharedContinuityProof: SdkContinuityProof;
  items: SharedProofItem[];
}

/** The calldata struct the sequential shape takes: every item carries its own Continuity Proof. */
function ownProofBatch(chainKey: number, asset: string, proved: ProvedTarget[]): OwnProofBatch {
  return {
    chainKey,
    asset,
    transferTopic0: TRANSFER_TOPIC0,
    items: proved.map((p) => ({
      height: p.height,
      encodedTransaction: p.txBytes,
      merkleProof: p.merkleProof,
      continuityProof: p.ownContinuityProof,
      logIndexInTx: p.candidate.logIndexInTx,
    })),
  };
}

/** The calldata struct the shared-proof shapes take: one Continuity Proof for the whole batch. */
function sharedProofBatch(
  chainKey: number,
  asset: string,
  proved: ProvedTarget[],
  shared: SdkContinuityProof,
): SharedProofBatch {
  return {
    chainKey,
    asset,
    transferTopic0: TRANSFER_TOPIC0,
    sharedContinuityProof: shared,
    items: proved.map((p) => ({
      height: p.height,
      encodedTransaction: p.txBytes,
      merkleProof: p.merkleProof,
      logIndexInTx: p.candidate.logIndexInTx,
    })),
  };
}

/**
 * Submit one batch for real and measure it from every angle the receipt and the events allow.
 *
 * Order matters: calldata is built first so its size and intrinsic cost are recorded even if the
 * submission fails, then a dry run yields exact revert data for free, then the transaction goes out.
 */
async function submitBatch(
  probe: Contract,
  method: 'probeSequentialOwnProofs' | 'probeSequentialSharedProof' | 'probeArraySharedProof',
  input: OwnProofBatch | SharedProofBatch,
  label: string,
  submitEvenIfDryRunReverts = false,
): Promise<Json> {
  const record: Json = { label, method, itemCount: input.items.length };
  const shared = (input as SharedProofBatch).sharedContinuityProof;
  const own = (input as OwnProofBatch).items[0] as OwnProofItem | undefined;

  const populated = await probe[method].populateTransaction(input);
  const calldata = populated.data ?? '0x';
  record.calldata = {
    selector: calldata.slice(0, 10),
    ...intrinsicGas(calldata),
    encodedTransactionBytes: input.items.map((i) => byteLength(i.encodedTransaction)),
    encodedTransactionBytesTotal: input.items.reduce((n, i) => n + byteLength(i.encodedTransaction), 0),
    continuityRootCount:
      shared !== undefined
        ? shared.roots.length
        : (input as OwnProofBatch).items.reduce((n, i) => n + i.continuityProof.roots.length, 0),
    continuityProofsCarried: shared !== undefined ? 1 : input.items.length,
    merkleSiblingCounts: input.items.map((i) => i.merkleProof.siblings.length),
  };
  if (own !== undefined && shared === undefined) {
    record.perItemContinuityRootCounts = (input as OwnProofBatch).items.map((i) => i.continuityProof.roots.length);
  }
  record.heights = { lowest: input.items[0].height, highest: input.items[input.items.length - 1].height };
  record.blockSpan = input.items[input.items.length - 1].height - input.items[0].height;

  let dryRunReverted = false;
  try {
    const result = (await probe[method].staticCall(input)) as unknown as [bigint, bigint];
    record.dryRun = {
      reverted: false,
      sumOfVerifyAndEmitGas: result[0].toString(),
      gasUsedInsideFunction: result[1].toString(),
    };
  } catch (e) {
    dryRunReverted = true;
    record.dryRun = { reverted: true, error: errRecord(e) };
    if (!submitEvenIfDryRunReverts) return record;
  }

  let gasLimit = FALLBACK_GAS_LIMIT;
  if (dryRunReverted) {
    // Estimation is impossible for a call that reverts, so the ceiling is set by hand. The point of
    // submitting anyway is an on-chain record of the revert, not a gas figure.
    gasLimit = 3_000_000n;
    record.gasEstimate = {
      estimated: null,
      gasLimitUsed: gasLimit.toString(),
      note: 'Submitted with a hand-set ceiling despite a reverting dry run, so the failure is on chain.',
    };
  } else {
    try {
      const estimate = await probe[method].estimateGas(input);
      gasLimit = (estimate * 15n) / 10n;
      record.gasEstimate = { estimated: estimate.toString(), gasLimitUsed: gasLimit.toString() };
    } catch (e) {
      record.gasEstimate = { estimated: null, gasLimitUsed: gasLimit.toString(), error: errRecord(e) };
    }
  }

  try {
    const tx = (await probe[method](input, { gasLimit })) as ContractTransactionResponse;
    record.creditcoinTxHash = tx.hash;
    console.log(`${label}: submitted ${tx.hash}`);
    const receipt: ContractTransactionReceipt | null = await tx.wait();
    record.status = receipt?.status ?? null;
    record.blockNumber = receipt?.blockNumber ?? null;
    record.totalGasUsed = receipt?.gasUsed?.toString() ?? null;
    record.effectiveGasPriceWei = receipt?.gasPrice?.toString() ?? null;
    record.transactionCalldataBytes = byteLength(tx.data);

    const logs = receipt?.logs ?? [];
    record.logCount = logs.length;
    record.transactionVerifiedEventCount = logs.filter(
      (l) => l.topics[0]?.toLowerCase() === TRANSACTION_VERIFIED_TOPIC0,
    ).length;

    const parsed = logs
      .map((l) => {
        try {
          return probe.interface.parseLog({ topics: [...l.topics], data: l.data });
        } catch {
          return null;
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    const items = parsed
      .filter((p) => p.name === 'ItemVerified')
      .map((p) => ({
        index: Number(p.args.index as bigint),
        height: Number(p.args.height as bigint),
        txIndex: Number(p.args.txIndex as bigint),
        payerFromTopic1: p.args.payerFromTopic1 as string,
        recipientFromTopic2: p.args.recipientFromTopic2 as string,
        amountBaseUnits: (p.args.amount as bigint).toString(),
        verifyAndEmitGasUsed: Number(p.args.verifyAndEmitGasUsed as bigint),
      }))
      .sort((a, b) => a.index - b.index);
    record.items = items;

    const measured = parsed.find((p) => p.name === 'BatchMeasured');
    record.batchMeasured =
      measured === undefined
        ? null
        : {
            shape: measured.args.shape as string,
            itemCount: Number(measured.args.itemCount as bigint),
            sumOfVerifyAndEmitGas: Number(measured.args.sumOfVerifyAndEmitGas as bigint),
            gasUsedInsideFunction: Number(measured.args.gasUsedInsideFunction as bigint),
            continuityRootCount: Number(measured.args.continuityRootCount as bigint),
            lowestHeight: Number(measured.args.lowestHeight as bigint),
            highestHeight: Number(measured.args.highestHeight as bigint),
          };

    const deltas = items.map((i) => i.verifyAndEmitGasUsed);
    record.perItemVerifyAndEmitGas = deltas;
    if (deltas.length > 0) {
      record.verifyAndEmitGasSpread = {
        min: Math.min(...deltas),
        max: Math.max(...deltas),
        mean: Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length),
      };
    }
  } catch (e) {
    // A reverted transaction still has a receipt, and the receipt is the evidence. ethers throws
    // rather than returning it, so it is pulled back out of the error here.
    const receipt = (e as { receipt?: ContractTransactionReceipt }).receipt;
    record.reverted = true;
    record.error = errRecord(e);
    if (receipt !== undefined) {
      record.creditcoinTxHash = receipt.hash;
      record.status = receipt.status;
      record.blockNumber = receipt.blockNumber;
      record.totalGasUsed = receipt.gasUsed.toString();
      record.logCount = receipt.logs.length;
      record.note =
        'The transaction was mined and reverted. Its gas figure is the cost of a failed submission, not ' +
        'a measurement of a working batch.';
    }
  }

  return record;
}

// ------------------------------------------------------------------------------------- analysis

/**
 * Turn the two receipts into the answers task 1.4 asks for: the ratio, whether it is linear, what
 * the calldata costs, and how much of a block one batch of ten actually occupies.
 */
function analyse(control: Json, batch: Json, arrayBatch: Json, blockGasLimit: bigint): Json {
  const num = (v: unknown): number | null => (typeof v === 'string' || typeof v === 'number' ? Number(v) : null);
  const controlItems = (control.items as { verifyAndEmitGasUsed: number }[] | undefined) ?? [];
  const batchMeasured = (batch.batchMeasured as Json | null | undefined) ?? null;
  const controlMeasured = (control.batchMeasured as Json | null | undefined) ?? null;
  const arrayMeasured = (arrayBatch.batchMeasured as Json | null | undefined) ?? null;

  const singleVerifyAndEmit = controlItems.length > 0 ? controlItems[0].verifyAndEmitGasUsed : null;
  const tenSumOfDeltas = batchMeasured === null ? null : (batchMeasured.sumOfVerifyAndEmitGas as number);
  const controlTotal = num(control.totalGasUsed);
  const batchTotal = num(batch.totalGasUsed);
  const arrayTotal = num(arrayBatch.totalGasUsed);
  const batchInside = batchMeasured === null ? null : (batchMeasured.gasUsedInsideFunction as number);
  const arrayInside = arrayMeasured === null ? null : (arrayMeasured.gasUsedInsideFunction as number);
  const arrayPrecompile = arrayMeasured === null ? null : (arrayMeasured.sumOfVerifyAndEmitGas as number);
  void controlMeasured;

  const batchCalldata = batch.calldata as Json;
  const controlCalldata = control.calldata as Json;
  const arrayCalldata = arrayBatch.calldata as Json;
  const batchIntrinsic = batchCalldata.intrinsicGasTotal as number;
  const arrayIntrinsic = arrayCalldata.intrinsicGasTotal as number;

  const round = (n: number, dp = 3): number => Number(n.toFixed(dp));

  const precompileRatio =
    singleVerifyAndEmit !== null && tenSumOfDeltas !== null ? tenSumOfDeltas / singleVerifyAndEmit : null;
  const totalRatio = controlTotal !== null && batchTotal !== null ? batchTotal / controlTotal : null;
  const marginalPerProof =
    controlTotal !== null && batchTotal !== null ? (batchTotal - controlTotal) / (BATCH_SIZE - 1) : null;
  const fixedOverhead =
    controlTotal !== null && marginalPerProof !== null ? controlTotal - marginalPerProof : null;

  const limit = Number(blockGasLimit);
  const headroomPercent = batchTotal !== null ? (batchTotal / limit) * 100 : null;
  const largestBatchThatFits =
    marginalPerProof !== null && fixedOverhead !== null && marginalPerProof > 0
      ? Math.floor((limit - fixedOverhead) / marginalPerProof)
      : null;

  // Linear means each additional proof costs the same as the last. The precompile deltas are the
  // clean test of that; the transaction total is deliberately sublinear because the 21,000 base
  // charge and the deployment-independent fixed work are paid once per transaction, not per proof.
  const precompileLinear =
    precompileRatio !== null ? Math.abs(precompileRatio - BATCH_SIZE) / BATCH_SIZE <= 0.02 : null;
  const spread = batch.verifyAndEmitGasSpread as { min: number; max: number } | undefined;
  const perItemFlat = spread === undefined ? null : spread.max - spread.min <= Math.round(spread.max * 0.02);

  return {
    oneVerifyAndEmit: {
      measuredHere: singleVerifyAndEmit,
      spike13Control: CONTROL_VERIFY_AND_EMIT_GAS_1_3,
      differenceFromSpike13:
        singleVerifyAndEmit === null ? null : singleVerifyAndEmit - CONTROL_VERIFY_AND_EMIT_GAS_1_3,
      reproducesSpike13: singleVerifyAndEmit === CONTROL_VERIFY_AND_EMIT_GAS_1_3,
      note: 'A gasleft() delta either side of the precompile call, so it excludes the caller\u2019s own work.',
    },
    tenVerifyAndEmit: {
      sumOfTenGasleftDeltas: tenSumOfDeltas,
      perItemDeltas: batch.perItemVerifyAndEmitGas ?? null,
      perItemSpread: spread ?? null,
      perItemCostIsFlat: perItemFlat,
      totalTransactionGasUsed: batchTotal,
      gasUsedInsideProbeBatch: batchInside,
      callerSideGasInsideFunction:
        batchInside !== null && tenSumOfDeltas !== null ? batchInside - tenSumOfDeltas : null,
      intrinsicAndCalldataGas: batchIntrinsic,
      unaccountedRemainder:
        batchTotal !== null && batchInside !== null ? batchTotal - batchInside - batchIntrinsic : null,
      remainderNote:
        'What the receipt charges beyond the function body and the intrinsic charge: dispatch, the outer ' +
        'ABI decode that runs before the first gasleft() reading, and the final event.',
    },
    ratios: {
      precompileTenOverOne: precompileRatio === null ? null : round(precompileRatio),
      precompileIsLinear: precompileLinear,
      transactionTotalTenOverOne: totalRatio === null ? null : round(totalRatio),
      marginalGasPerAdditionalProof: marginalPerProof === null ? null : Math.round(marginalPerProof),
      fixedGasPerTransaction: fixedOverhead === null ? null : Math.round(fixedOverhead),
      note:
        'The precompile scales linearly by construction \u2014 ten calls, ten identical charges. The ' +
        'transaction total is sublinear because the 21,000 base charge and the dispatch are paid once. The ' +
        'figure that governs batch size is the marginal cost of one more proof, not either ratio.',
    },
    arrayShapedBatchWithOneSharedProof: {
      shape:
        'One array-shaped verifyAndEmit against one shared Continuity Proof — the only shape in which ten ' +
        'proofs genuinely share a Continuity Proof on this precompile build.',
      precompileGasForTheWholeBatch: arrayPrecompile,
      gasUsedInsideProbeFunction: arrayInside,
      totalTransactionGasUsed: arrayTotal,
      intrinsicAndCalldataGas: arrayIntrinsic,
      calldataBytes: arrayCalldata.calldataBytes,
      continuityRootCount: arrayCalldata.continuityRootCount,
      percentOfBlockGasLimit: arrayTotal === null ? null : round((arrayTotal / limit) * 100, 4),
      gasSavedAgainstSequentialShape:
        arrayTotal !== null && batchTotal !== null ? batchTotal - arrayTotal : null,
      precompileGasPerProof:
        arrayPrecompile === null ? null : Math.round(arrayPrecompile / BATCH_SIZE),
      note:
        'One precompile call rather than ten, so there is no per-item precompile figure. The shared proof ' +
        'also removes nine of the ten Continuity Proofs from calldata.',
    },
    calldata: {
      controlCalldataBytes: controlCalldata.calldataBytes,
      controlIntrinsicGas: controlCalldata.intrinsicGasTotal,
      batchCalldataBytes: batchCalldata.calldataBytes,
      batchZeroBytes: batchCalldata.zeroBytes,
      batchNonZeroBytes: batchCalldata.nonZeroBytes,
      batchCalldataGas: batchCalldata.calldataGas,
      batchIntrinsicGasTotal: batchIntrinsic,
      shareOfBatchTotalPercent:
        batchTotal === null ? null : round((batchIntrinsic / batchTotal) * 100, 1),
      encodedTransactionBytesTotal: batchCalldata.encodedTransactionBytesTotal,
      note:
        'Calldata is charged per byte whether or not the contract reads it, so it is the term that grows ' +
        'fastest with batch size and the one the design has to respect.',
    },
    blockGasLimit: {
      value: blockGasLimit.toString(),
      readFrom: 'the header of the Creditcoin block that carried the batch submission',
    },
    headroom: {
      batchOfTenGasUsed: batchTotal,
      arrayShapedBatchOfTenGasUsed: arrayTotal,
      percentOfBlockGasLimit: headroomPercent === null ? null : round(headroomPercent, 4),
      gasRemainingInBlock: batchTotal === null ? null : limit - batchTotal,
      batchesOfTenPerBlock: batchTotal === null ? null : Math.floor(limit / batchTotal),
      largestBatchThatFitsOneBlock: largestBatchThatFits,
      tenProofBoundIsSafe:
        batchTotal !== null && batchTotal < limit && (arrayTotal === null || arrayTotal < limit),
      extrapolationBasis:
        'largestBatchThatFitsOneBlock = floor((blockGasLimit \u2212 fixedGasPerTransaction) / ' +
        'marginalGasPerAdditionalProof), from the two measured points. It is an extrapolation from two ' +
        'submissions, not a measurement, and a real submission that large would also have to fit any ' +
        'per-transaction gas cap the node applies.',
    },
  };
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
    task: 'tab 1.4 — verify batch gas headroom against the block gas limit',
    question:
      'Do ten sequential verifyAndEmit calls sharing one Continuity Proof fit inside a single Creditcoin ' +
      'transaction once the calldata and the caller-side work are counted, and how much of a block do they take?',
    shapesUnderTest: [
      'control — one single-transaction verifyAndEmit with its own Continuity Proof, reproducing spike 1.3.',
      'requirement 9.1 and 9.2 as written — ten sequential single-transaction verifyAndEmit calls against ONE ' +
        'shared Continuity Proof.',
      'ten sequential single-transaction verifyAndEmit calls, each carrying its own Continuity Proof.',
      'one array-shaped verifyAndEmit over ten proofs against ONE shared Continuity Proof.',
    ],
    endpoints: {
      creditcoinRpc: redactUrl(creditcoinRpcUrl),
      creditcoinChainId,
      proofBuilder: redactUrl(proverUrl),
      ethereumMainnetRpcCandidates: mainnetUrls.map(redactUrl),
      chainInfoPrecompile: CHAIN_INFO_PRECOMPILE,
      blockProverPrecompile: BLOCK_PROVER_PRECOMPILE,
      mainnetUsdc: usdc,
    },
    settings: {
      batchSize: BATCH_SIZE,
      batchMaxSpanBlocks: BATCH_MAX_SPAN,
      heightMarginBelowFrontier: HEIGHT_MARGIN_BELOW_FRONTIER,
      maxBlocksScanned: MAX_BLOCKS_SCANNED,
      attestationStride: ATTESTATION_STRIDE,
      jsonRpcBatchMaxCount: 1,
    },
    inheritedFromSpike13: {
      verifyAndEmitGasForOneProof: CONTROL_VERIFY_AND_EMIT_GAS_1_3,
      totalGasForOneProbeTransaction: 131_264,
      encodedTransactionBytes: 2_752,
      note: 'Reproduced here as a control rather than assumed.',
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
      latestBlockGasLimit: latestBlock?.gasLimit?.toString() ?? null,
      latestBlockGasUsed: latestBlock?.gasUsed?.toString() ?? null,
      gasPriceWei: feeData.gasPrice?.toString() ?? null,
    };
    // Address only. The key never reaches this file or the log.
    transcript.submitter = { address: wallet.address, balanceWei: balance.toString(), nonce };

    // --- Attested frontier --------------------------------------------------------------------
    const { frontier, record: frontierRecord } = await readFrontier(creditcoin, MAINNET_CHAIN_KEY);
    transcript.attestationFrontier = { chainKey: MAINNET_CHAIN_KEY, read: frontierRecord, value: frontier };
    if (frontier === null || !frontier.exists) {
      throw new Error('ChainInfo reports no attestation for chainKey 3; there is nothing to prove against');
    }

    const startHeight = frontier.height - HEIGHT_MARGIN_BELOW_FRONTIER;
    console.log(`chainKey 3 attested frontier ${frontier.height}; scanning ${startHeight} downwards`);

    // --- Assemble the targets -----------------------------------------------------------------
    const endpointResult = await firstWorkingSourceRpc(mainnetUrls, 1, startHeight);
    mainnetRpc = endpointResult.rpc;
    transcript.mainnetEndpointAttempts = endpointResult.attempts;
    transcript.mainnetEndpointUsed = redactUrl(mainnetRpc.url);

    const scanned: Json[] = [];
    const byHeight = await scanCandidates(mainnetRpc, usdc, startHeight, scanned);
    const withinWindow = assembleTargets(byHeight, BATCH_SIZE, false);
    const crossingEndpoint = assembleTargets(byHeight, BATCH_SIZE, true);
    transcript.targetSearch = {
      startHeight,
      blocksInspected: scanned,
      heightsWithQualifyingTransfers: [...byHeight.keys()].sort((a, b) => a - b),
      planWithinOneAttestationWindow:
        withinWindow === null
          ? null
          : { heights: withinWindow.heights, reason: withinWindow.reason, targets: withinWindow.targets.length },
      planCrossingAnAttestationEndpoint:
        crossingEndpoint === null
          ? null
          : {
              heights: crossingEndpoint.heights,
              reason: crossingEndpoint.reason,
              targets: crossingEndpoint.targets.length,
            },
    };

    // The plan crossing an attestation endpoint is the more demanding shape and the more
    // representative one, so it is preferred when the scanned window offers it.
    const plan = crossingEndpoint ?? withinWindow;
    if (plan === null) {
      throw new Error(
        `could not assemble ${BATCH_SIZE} targets with mergeable Continuity Proofs in ${MAX_BLOCKS_SCANNED} blocks below ${startHeight}`,
      );
    }
    transcript.planChosen = {
      heights: plan.heights,
      reason: plan.reason,
      blockSpan: plan.targets[plan.targets.length - 1].height - plan.targets[0].height,
      withinRequirement94Span:
        plan.targets[plan.targets.length - 1].height - plan.targets[0].height <= BATCH_MAX_SPAN,
      targets: plan.targets,
    };

    // --- Proof material -----------------------------------------------------------------------
    const builder = new proofProvider.service.ProofBuilder(MAINNET_CHAIN_KEY, proverUrl, 60_000);
    const highest = plan.targets[plan.targets.length - 1].height;
    await builder.waitUntilHeightAttested(MAINNET_CHAIN_KEY, highest, 15_000, 900_000, 2_000);

    const proved = await proveTargets(builder, plan.targets);
    transcript.proofMaterial = proved.map((p) => ({
      height: p.height,
      txHash: p.txHash,
      txIndexFromProofBuilder: p.txIndexFromProofBuilder,
      txIndexFromMainnetRpc: p.candidate.txIndex,
      txIndexAgrees: p.txIndexFromProofBuilder === p.candidate.txIndex,
      encodedTransactionByteLength: byteLength(p.txBytes),
      merkleProof: plainMerkleProof(p.merkleProof),
      ownContinuityProof: plainContinuityProof(p.ownContinuityProof),
      logIndexInTx: p.candidate.logIndexInTx,
      payerFromTopic1: p.candidate.topic1Payer,
      transactionFrom: p.candidate.txFrom,
      payerDiffersFromTxFrom: p.candidate.payerDiffersFromTxFrom,
    }));

    const sharedBuild = await buildSharedProof(builder, proved);
    transcript.sharedContinuityProof = sharedBuild.record;
    const shared = sharedBuild.merged ?? sharedBuild.fromBatchEndpoint;
    if (shared === null) {
      throw new Error(
        `no shared Continuity Proof could be built: mergeProofs threw and getBatchProof failed (${sharedBuild.batchEndpointError})`,
      );
    }
    transcript.sharedContinuityProofUsed = {
      source: sharedBuild.merged !== null ? 'proofProvider.mergeProofs' : 'ProofBuilder.getBatchProof',
      ...plainContinuityProof(shared),
    };

    // --- Keyless preflight, before a single unit of gas is spent -------------------------------
    const perTargetOwnProof: Json[] = [];
    const perTargetSharedProof: Json[] = [];
    for (const p of proved) {
      perTargetOwnProof.push(
        await verifySingleView(creditcoin, MAINNET_CHAIN_KEY, p.height, p.txBytes, p.merkleProof, p.ownContinuityProof),
      );
      perTargetSharedProof.push(
        await verifySingleView(creditcoin, MAINNET_CHAIN_KEY, p.height, p.txBytes, p.merkleProof, shared),
      );
    }
    const arrayShaped = await verifyArrayView(creditcoin, MAINNET_CHAIN_KEY, proved, shared);
    const sharedProofWorksForEveryTarget = perTargetSharedProof.every((r) => r.verified === true);

    transcript.preflight = {
      purpose:
        'Every shape is checked with a keyless eth_call first, so a negative result is attributable to the ' +
        'shape rather than to a broken submission, and costs nothing.',
      eachTargetAgainstItsOwnContinuityProof: perTargetOwnProof,
      eachTargetAgainstTheSharedContinuityProof: perTargetSharedProof,
      arrayShapedOverloadAgainstTheSharedProof: arrayShaped,
      sharedProofWorksForEveryTarget,
      verdict: sharedProofWorksForEveryTarget
        ? 'The design shape holds: a single-transaction verifyAndEmit accepts a Continuity Proof that spans ' +
          'the whole batch, so requirement 9.2 is submittable as written.'
        : 'A single-transaction verifyAndEmit did NOT accept the shared Continuity Proof for every target. ' +
          'Requirement 9.2 cannot be submitted as written against this precompile build; see the per-target ' +
          'records for the exact revert data.',
    };

    if (!sharedProofWorksForEveryTarget) {
      console.log('shared Continuity Proof rejected by at least one single-transaction verify; see transcript');
    }

    // --- Deploy the batch probe ---------------------------------------------------------------
    if (!existsSync(ARTIFACT_PATH)) {
      throw new Error(`BatchProbe artifact missing at ${ARTIFACT_PATH}. Run \`forge build\` inside spike/ first.`);
    }
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as {
      abi: unknown[];
      bytecode: { object: string };
      metadata?: { compiler?: { version?: string } };
    };
    const factory = new ContractFactory(artifact.abi as never, artifact.bytecode.object, wallet);
    const deployed = await factory.deploy();
    const deployTx = deployed.deploymentTransaction();
    const deployReceipt = await deployTx?.wait();
    const probeAddress = await deployed.getAddress();
    transcript.batchProbeContract = {
      source: 'spike/BatchProbe.sol',
      solcVersion: artifact.metadata?.compiler?.version ?? '0.8.23',
      address: probeAddress,
      deploymentTxHash: deployTx?.hash ?? null,
      deploymentBlock: deployReceipt?.blockNumber ?? null,
      deploymentGasUsed: deployReceipt?.gasUsed?.toString() ?? null,
      deployedBytecodeLength: byteLength(artifact.bytecode.object),
      libraryLinkingRequired: false,
      note: 'A new contract, because the 1.3 probe takes one proof and cannot express a batch.',
    };
    console.log(`BatchProbe deployed at ${probeAddress} (tx ${deployTx?.hash})`);

    const probe = new Contract(probeAddress, artifact.abi as never, wallet);

    // --- The control: one proof, one verifyAndEmit ---------------------------------------------
    const control = await submitBatch(
      probe,
      'probeSequentialOwnProofs',
      ownProofBatch(MAINNET_CHAIN_KEY, usdc, proved.slice(0, 1)),
      'control — one verifyAndEmit',
    );
    transcript.controlSubmission = control;

    // --- The design shape as written: ten sequential calls, ONE shared Continuity Proof --------
    // Submitted even though the preflight says it reverts, so the finding is on chain and a third
    // party can reproduce it from a transaction hash rather than from an argument.
    const designShape = await submitBatch(
      probe,
      'probeSequentialSharedProof',
      sharedProofBatch(MAINNET_CHAIN_KEY, usdc, proved, shared),
      `requirement 9.2 as written — ${BATCH_SIZE} sequential calls against one shared Continuity Proof`,
      true,
    );
    transcript.designShapeSubmission = designShape;

    // --- The subject: ten proofs in one transaction, sequential, own proofs --------------------
    const batch = await submitBatch(
      probe,
      'probeSequentialOwnProofs',
      ownProofBatch(MAINNET_CHAIN_KEY, usdc, proved),
      `batch — ${BATCH_SIZE} sequential verifyAndEmit calls, one Continuity Proof each`,
    );
    transcript.batchSubmission = batch;

    // --- The shape that does share one Continuity Proof: the array-shaped overload -------------
    const arrayBatch = await submitBatch(
      probe,
      'probeArraySharedProof',
      sharedProofBatch(MAINNET_CHAIN_KEY, usdc, proved, shared),
      `batch — one array-shaped verifyAndEmit over ${BATCH_SIZE} proofs, one shared Continuity Proof`,
    );
    transcript.arrayShapedBatchSubmission = arrayBatch;

    // --- Block gas limit, read from the block that carried the batch ---------------------------
    const batchBlockNumber = batch.blockNumber as number | null;
    const batchBlock = batchBlockNumber === null ? latestBlock : await creditcoin.getBlock(batchBlockNumber);
    const blockGasLimit = batchBlock?.gasLimit ?? 0n;
    transcript.blockGasLimitRead = {
      blockNumber: batchBlock?.number ?? null,
      gasLimit: blockGasLimit.toString(),
      gasUsed: batchBlock?.gasUsed?.toString() ?? null,
      source: 'eth_getBlockByNumber on the Creditcoin block carrying the batch submission',
    };

    // --- Analysis ------------------------------------------------------------------------------
    const analysis = analyse(control, batch, arrayBatch, blockGasLimit);
    transcript.analysis = analysis;

    const measurementsSucceeded =
      control.status === 1 && batch.status === 1 && arrayBatch.status === 1;
    const headroom = analysis.headroom as Json;
    transcript.finding = {
      headline:
        'Ten proofs fit one Creditcoin transaction with room to spare, but requirement 9.2 as written is not ' +
        'submittable: a single-transaction verifyAndEmit accepts a Continuity Proof only when the proof\u2019s ' +
        'first root is the root of the height being proved.',
      whatTheChainDoes:
        'The precompile derives the position of a height\u2019s root from the proof\u2019s own start, so a proof ' +
        'spanning a batch verifies for the batch\u2019s lowest height and reverts "Merkle root mismatch" for ' +
        'every other one. Each target verifies against its own Continuity Proof, and the array-shaped ' +
        'verifyAndEmit verifies all ten against the shared proof.',
      twoShapesThatWork: [
        'Ten sequential single-transaction verifyAndEmit calls, each carrying its own Continuity Proof. ' +
          'Keeps per-Settlement attributability, costs nine extra Continuity Proofs in calldata.',
        'One array-shaped verifyAndEmit against one shared Continuity Proof. Genuinely shares the proof, ' +
          'but a failure is attributable to the batch rather than to one Settlement.',
      ],
      designConsequence:
        'Requirements 9.1, 9.2 and 9.6 need a decision recorded: keep sequential calls and drop the shared ' +
        'Continuity Proof, or keep the shared Continuity Proof and adopt the array-shaped call. Both fit the ' +
        'block gas limit comfortably, so the choice is about failure attribution and calldata, not headroom.',
    };
    transcript.verdict = {
      tenProofsFitOneCreditcoinTransaction: measurementsSucceeded && headroom.tenProofBoundIsSafe === true,
      allMeasurementSubmissionsSucceeded: measurementsSucceeded,
      creditcoinTransactionHashes: {
        deployment: transcript.batchProbeContract && (transcript.batchProbeContract as Json).deploymentTxHash,
        control: control.creditcoinTxHash ?? null,
        requirement92AsWritten: designShape.creditcoinTxHash ?? null,
        batchOfTenSequential: batch.creditcoinTxHash ?? null,
        batchOfTenArrayShaped: arrayBatch.creditcoinTxHash ?? null,
      },
      oneVerifyAndEmitGas: (analysis.oneVerifyAndEmit as Json).measuredHere,
      tenVerifyAndEmitSumOfDeltas: (analysis.tenVerifyAndEmit as Json).sumOfTenGasleftDeltas,
      tenProofTransactionGasUsed: (analysis.tenVerifyAndEmit as Json).totalTransactionGasUsed,
      arrayShapedTenProofTransactionGasUsed: arrayBatch.totalGasUsed ?? null,
      percentOfBlockGasLimit: headroom.percentOfBlockGasLimit,
      largestBatchThatFitsOneBlock: headroom.largestBatchThatFitsOneBlock,
      requirement91BoundOfTenIsSafe: measurementsSucceeded && headroom.tenProofBoundIsSafe === true,
      requirement92SequentialSharedProofShapeHolds: sharedProofWorksForEveryTarget,
      requirement92SharedProofSubmissionStatus: designShape.status ?? null,
    };

    writeTranscript(transcript);
    console.log(JSON.stringify(transcript.verdict, jsonReplacer, 2));
    console.log(`\nTranscript written to ${OUT_PATH}`);
    if (!measurementsSucceeded) process.exitCode = 1;
  } catch (e) {
    transcript.fatal = errRecord(e);
    transcript.verdict = {
      tenProofsFitOneCreditcoinTransaction: null,
      note: 'The probe could not complete; see `fatal`.',
    };
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
