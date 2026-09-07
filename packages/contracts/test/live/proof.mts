/**
 * Live harness - real proof material, and the targets it is built from.
 *
 * A negative-path case only means something if the material it starts from is genuine. So every case
 * begins with a Source Chain transaction that already exists, at a height the Attestcoin Protocol has
 * already attested, and with proof material built by the Proof Builder rather than by this file. The
 * mutation a case applies is then the only difference between a submission that would verify and one
 * that must not, which is what makes the recorded rejection attributable.
 *
 * Task 13.1 needed one kind of target: a historical Ethereum Mainnet USDC `Transfer`. Task 13.2
 * needs four, and each is a different question put to the same block-receipt scan:
 *
 *   - **a Mainnet USDC Transfer** to an address no Service registered, which is what any Mainnet
 *     transfer is on this deployment, for the forged, tampered, wrong-chain, and unregistered cases;
 *   - **a reverted Mainnet transaction**, whose receipt carries `status == 0`;
 *   - **a Mainnet transaction carrying a zero-topic log before a USDC Transfer**, so the ordinal sweep
 *     has to step over the anonymous log to reach the recognised one; and
 *   - **a named Source Chain transaction**, by hash and chainKey, for the cases that need a Settlement
 *     the rail actually accepted: the replay, the relayed payer, and the batch. Those are produced on
 *     Sepolia by the Watcher lane and handed over by hash.
 *
 * Three things follow from that and are worth stating:
 *
 *   - **No Ethereum transaction is sent, ever.** Every target is a transaction that already exists,
 *     so the harness spends no Ethereum gas and creates no Source Chain state.
 *   - **Every mutated case carries a keyless control.** Before the mutation is submitted, the
 *     unmutated material is put to the BlockProver Precompile over `eth_call`, with no key and no
 *     gas. A control that verifies is what tells "the deployment refused the forgery" apart from
 *     "our proof material was malformed all along".
 *   - **The chain keys are read off the deployment.** `CHAIN_KEY_MAINNET` and `CHAIN_KEY_SEPOLIA` are
 *     public constants of the deployed verifier, so the harness asks rather than assumes.
 *
 * Requirements: 27.3
 */

import {proofProvider} from '@gluwa/usc-sdk';
import {
  FunctionFragment,
  Interface,
  type JsonRpcProvider,
  concat,
  dataSlice,
  hexlify,
  keccak256,
  randomBytes,
  toBeHex,
  toQuantity,
  toUtf8Bytes,
} from 'ethers';

import {redactUrl, type LiveConfig} from './config.mjs';
import {makeProvider} from './chain.mjs';
import {extractRevertData} from './revert.mjs';

/** Signature topic of the ERC-20 `Transfer` event, the Settlement shape on a chain Tab deploys to. */
export const TRANSFER_TOPIC0 = keccak256(toUtf8Bytes('Transfer(address,address,uint256)'));

/** Signature topic of `TabSettled`, the Settlement shape on Ethereum Sepolia. */
export const TAB_SETTLED_TOPIC0 = keccak256(toUtf8Bytes('TabSettled(address,address,uint256,bytes32)'));

/** How far below the attested frontier to start looking, in Source Chain blocks. */
const HEIGHT_MARGIN_BELOW_FRONTIER = 100;

/** How many blocks to walk back before giving up on a common target. */
const MAX_BLOCKS_SCANNED = 8;

/**
 * How many blocks to walk back for a rare target. A zero-topic log is an anonymous event, which few
 * contracts emit, so the scan for one is allowed to go a good deal further before giving up.
 */
const MAX_BLOCKS_SCANNED_RARE = 120;

/** How long the Proof Builder client is given per request. */
const PROOF_BUILDER_TIMEOUT_MS = 60_000;

const CHAIN_INFO_PRECOMPILE = '0x0000000000000000000000000000000000000fd3';

const SIG_LATEST_ATTESTATION =
  'get_latest_attestation_height_and_hash(uint64) returns ((uint64,bytes32,bool,bool))';
const SIG_VERIFY_AND_EMIT =
  'verifyAndEmit(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[])) returns (bool)';

// ------------------------------------------------------------------------------------- proof shapes

export interface MerkleProofShape {
  root: string;
  siblings: {hash: string; isLeft: boolean}[];
}

export interface ContinuityProofShape {
  lowerEndpointDigest: string;
  roots: string[];
}

/** One Source Chain transaction with its proof material, in the shape `SourceTx` declares. */
export interface SourceTxShape {
  chainKey: number;
  blockHeight: number;
  encodedTransaction: string;
  merkleProof: MerkleProofShape;
  continuityProof: ContinuityProofShape;
}

/**
 * Positional tuples, never named objects.
 *
 * A fragment built from a bare type signature has unnamed components and ethers refuses to encode a
 * named object against one. The failure looks like a chain problem and is not — the request never
 * leaves the process — so both encodings here are positional and stay that way.
 */
export const tupleMerkleProof = (p: MerkleProofShape): unknown[] => [
  p.root,
  p.siblings.map((s) => [s.hash, s.isLeft]),
];

export const tupleContinuityProof = (p: ContinuityProofShape): unknown[] => [p.lowerEndpointDigest, p.roots];

export const tupleSourceTx = (tx: SourceTxShape): unknown[] => [
  tx.chainKey,
  tx.blockHeight,
  tx.encodedTransaction,
  tupleMerkleProof(tx.merkleProof),
  tupleContinuityProof(tx.continuityProof),
];

/** JSON-safe copy, so `results.json` is replayable by hand. */
export function plainSourceTx(tx: SourceTxShape): Record<string, unknown> {
  return {
    chainKey: tx.chainKey,
    blockHeight: tx.blockHeight,
    encodedTransaction: tx.encodedTransaction,
    encodedTransactionByteLength: (tx.encodedTransaction.length - 2) / 2,
    merkleProof: {
      root: tx.merkleProof.root,
      siblings: tx.merkleProof.siblings,
      siblingCount: tx.merkleProof.siblings.length,
    },
    continuityProof: {
      lowerEndpointDigest: tx.continuityProof.lowerEndpointDigest,
      roots: tx.continuityProof.roots,
      rootCount: tx.continuityProof.roots.length,
    },
  };
}

/** Deep copy, so a mutation cannot reach the genuine material a control still has to verify. */
export function cloneSourceTx(tx: SourceTxShape): SourceTxShape {
  return {
    chainKey: tx.chainKey,
    blockHeight: tx.blockHeight,
    encodedTransaction: tx.encodedTransaction,
    merkleProof: {root: tx.merkleProof.root, siblings: tx.merkleProof.siblings.map((s) => ({...s}))},
    continuityProof: {
      lowerEndpointDigest: tx.continuityProof.lowerEndpointDigest,
      roots: [...tx.continuityProof.roots],
    },
  };
}

// ------------------------------------------------------------------------------- deployment reads

/** The chain keys the deployment itself declares. */
export interface ChainKeys {
  readonly mainnet: number;
  readonly sepolia: number;
}

/** Ask the deployed verifier which chain keys it settles from, rather than writing them down here. */
export async function readChainKeys(provider: JsonRpcProvider, config: LiveConfig): Promise<ChainKeys> {
  const iface = new Interface([
    'function CHAIN_KEY_MAINNET() view returns (uint64)',
    'function CHAIN_KEY_SEPOLIA() view returns (uint64)',
  ]);
  const read = async (name: string): Promise<number> => {
    const raw = (await provider.send('eth_call', [
      {to: config.settlementVerifier, data: iface.encodeFunctionData(name, [])},
      'latest',
    ])) as string;
    return Number(iface.decodeFunctionResult(name, raw)[0] as bigint);
  };
  const [mainnet, sepolia] = await Promise.all([read('CHAIN_KEY_MAINNET'), read('CHAIN_KEY_SEPOLIA')]);
  return {mainnet, sepolia};
}

/** The attested frontier for one Source Chain, straight off the ChainInfo Precompile. */
export async function readAttestedFrontier(
  provider: JsonRpcProvider,
  chainKey: number,
): Promise<{height: number; digest: string; isAttestation: boolean; exists: boolean}> {
  const fragment = FunctionFragment.from(SIG_LATEST_ATTESTATION);
  const iface = new Interface([fragment]);
  const raw = (await provider.send('eth_call', [
    {to: CHAIN_INFO_PRECOMPILE, data: iface.encodeFunctionData(fragment, [chainKey])},
    'latest',
  ])) as string;
  const [tuple] = iface.decodeFunctionResult(fragment, raw) as unknown as [
    [bigint, string, boolean, boolean],
  ];
  return {height: Number(tuple[0]), digest: tuple[1], isAttestation: tuple[2], exists: tuple[3]};
}

// ----------------------------------------------------------------------------------- targets

/** One Settlement-shaped log inside a receipt, read the way the verifier will read it. */
export interface SettlementLogView {
  /** Ordinal inside the receipt's own log array, which is the `logIndex` a replay key packs. */
  readonly ordinal: number;
  readonly emitter: string;
  readonly signature: 'Transfer' | 'TabSettled';
  readonly topicCount: number;
  readonly payerFromTopic1: string;
  readonly recipientFromTopic2: string;
  readonly amountBaseUnits: string;
}

/** A genuine Source Chain transaction the harness can build a case from. */
export interface SourceTarget {
  readonly chainKey: number;
  readonly sourceTxHash: string;
  readonly blockHeight: number;
  readonly txIndexFromSourceRpc: number;
  readonly txFrom: string;
  /** `1` succeeded, `0` reverted. */
  readonly receiptStatus: number;
  readonly receiptLogCount: number;
  /** The log a case is built around, or null for a target with no Settlement-shaped log. */
  readonly settlementLog: SettlementLogView | null;
  /** Every Settlement-shaped log from an emitter this deployment could recognise, in receipt order. */
  readonly settlementLogs: readonly SettlementLogView[];
  /** Ordinals of logs carrying no topics at all. */
  readonly zeroTopicLogOrdinals: readonly number[];
  /** Whether the transaction sender differs from the payer the log names. Null with no log. */
  readonly payerDiffersFromTxFrom: boolean | null;
  readonly attestedFrontierAtSelection: number;
  readonly sourceEndpoint: string;
  /** How the target was chosen. */
  readonly selection: string;
  readonly note: string;
}

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: string;
}

interface RpcReceipt {
  transactionHash: string;
  transactionIndex: string;
  blockNumber: string;
  from: string;
  status: string;
  logs: RpcLog[];
}

/**
 * A block number as a JSON-RPC *quantity*.
 *
 * `toQuantity` and not `toBeHex`, and the difference is not cosmetic. `toBeHex` pads to a whole
 * number of bytes, so height 25,916,720 encodes as `0x018b7530`, and the JSON-RPC specification
 * forbids leading zeros in a quantity. Measured against every configured Mainnet endpoint: drpc and
 * publicnode both answer `-32602 invalid argument 0: hex number with leading zero digits`, which
 * reads like a malformed request rather than like a padding rule, and only bites at heights whose
 * hex digit count happens to be odd. `toQuantity` emits the minimal form `0x18b7530`.
 */
const hexQuantity = (n: number): string => toQuantity(n);
const topicToAddress = (topic: string): string => `0x${topic.slice(-40)}`;
const sameAddress = (left: string, right: string | null): boolean =>
  right !== null && left.toLowerCase() === right.toLowerCase();

/** The emitters whose logs could be Settlements on a given chain, from the environment. */
function emittersOfInterest(config: LiveConfig, chainKeys: ChainKeys, chainKey: number): {
  readonly assets: readonly string[];
  readonly settlementContracts: readonly string[];
} {
  if (chainKey === chainKeys.sepolia) {
    return {
      assets: config.sepoliaUsdc === null ? [] : [config.sepoliaUsdc],
      settlementContracts: config.sepoliaSettlement === null ? [] : [config.sepoliaSettlement],
    };
  }
  return {assets: [config.mainnetUsdc], settlementContracts: []};
}

/** Every Settlement-shaped log in a receipt, in receipt order. */
function settlementLogsOf(
  receipt: RpcReceipt,
  emitters: {readonly assets: readonly string[]; readonly settlementContracts: readonly string[]},
): SettlementLogView[] {
  const views: SettlementLogView[] = [];
  receipt.logs.forEach((log, ordinal) => {
    const topic0 = (log.topics[0] ?? '').toLowerCase();
    const isTransfer =
      topic0 === TRANSFER_TOPIC0.toLowerCase() &&
      log.topics.length === 3 &&
      emitters.assets.some((asset) => sameAddress(log.address, asset));
    const isTabSettled =
      topic0 === TAB_SETTLED_TOPIC0.toLowerCase() &&
      log.topics.length === 4 &&
      emitters.settlementContracts.some((contract) => sameAddress(log.address, contract));
    if (!isTransfer && !isTabSettled) return;
    views.push({
      ordinal,
      emitter: log.address,
      signature: isTransfer ? 'Transfer' : 'TabSettled',
      topicCount: log.topics.length,
      payerFromTopic1: topicToAddress(log.topics[1]),
      recipientFromTopic2: topicToAddress(log.topics[2]),
      amountBaseUnits: log.data.length >= 66 ? BigInt(dataSlice(log.data, 0, 32)).toString() : '0',
    });
  });
  return views;
}

function targetFromReceipt(
  receipt: RpcReceipt,
  chainKey: number,
  emitters: {readonly assets: readonly string[]; readonly settlementContracts: readonly string[]},
  frontierHeight: number,
  endpoint: string,
  selection: string,
  note: string,
): SourceTarget {
  const settlementLogs = settlementLogsOf(receipt, emitters);
  const settlementLog = settlementLogs[0] ?? null;
  return {
    chainKey,
    sourceTxHash: receipt.transactionHash,
    blockHeight: Number(BigInt(receipt.blockNumber)),
    txIndexFromSourceRpc: Number(BigInt(receipt.transactionIndex)),
    txFrom: receipt.from,
    receiptStatus: Number(BigInt(receipt.status)),
    receiptLogCount: receipt.logs.length,
    settlementLog,
    settlementLogs,
    zeroTopicLogOrdinals: receipt.logs.flatMap((log, ordinal) => (log.topics.length === 0 ? [ordinal] : [])),
    payerDiffersFromTxFrom:
      settlementLog === null ? null : settlementLog.payerFromTopic1.toLowerCase() !== receipt.from.toLowerCase(),
    attestedFrontierAtSelection: frontierHeight,
    sourceEndpoint: redactUrl(endpoint),
    selection,
    note,
  };
}

/** Which receipt in a block a scan wants, or null to move on to the next block. */
type Picker = (receipts: readonly RpcReceipt[]) => RpcReceipt | null;

/**
 * Walk Mainnet blocks below the attested frontier until a picker is satisfied.
 *
 * The walk-back is deliberate rather than random: it starts a fixed margin below the frontier so the
 * height is comfortably attested. `eth_getLogs` is never called - its mainnet range limits are severe
 * and unnecessary, because `eth_getBlockReceipts` answers the same question in one round trip.
 */
async function scanMainnetBelowFrontier(
  config: LiveConfig,
  chainKey: number,
  chainKeys: ChainKeys,
  frontierHeight: number,
  maxBlocks: number,
  pick: Picker,
  selection: string,
): Promise<SourceTarget> {
  const attempts: string[] = [];
  const emitters = emittersOfInterest(config, chainKeys, chainKey);

  for (const url of config.mainnetRpcUrls) {
    const provider = makeProvider(url, 1);
    try {
      let height = frontierHeight - HEIGHT_MARGIN_BELOW_FRONTIER;
      for (let scanned = 0; scanned < maxBlocks; scanned += 1, height -= 1) {
        const receipts = (await provider.send('eth_getBlockReceipts', [hexQuantity(height)])) as RpcReceipt[];
        if (!Array.isArray(receipts)) throw new Error('eth_getBlockReceipts did not answer with an array');
        const chosen = pick(receipts);
        if (chosen === null) continue;
        return targetFromReceipt(
          chosen,
          chainKey,
          emitters,
          frontierHeight,
          url,
          selection,
          `Historical Ethereum Mainnet transaction, ${frontierHeight - height} blocks below the attested frontier ` +
            'at selection time. Nothing was sent to Ethereum: the transaction already existed.',
        );
      }
      attempts.push(`${redactUrl(url)}: nothing qualifying in ${maxBlocks} block(s)`);
    } catch (error) {
      attempts.push(`${redactUrl(url)}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      provider.destroy();
    }
  }

  throw new Error(`no Source Chain endpoint produced a target for "${selection}". Attempts: ${attempts.join(' | ')}`);
}

const usdcTransferOrdinal = (receipt: RpcReceipt, usdc: string): number =>
  receipt.logs.findIndex(
    (log) =>
      log.topics.length === 3 &&
      (log.topics[0] ?? '').toLowerCase() === TRANSFER_TOPIC0.toLowerCase() &&
      sameAddress(log.address, usdc),
  );

/**
 * A historical Ethereum Mainnet USDC `Transfer`, taking the qualifying transaction with the fewest
 * logs so the encoded transaction stays small and the calldata cheap. On this deployment every
 * Mainnet recipient is unregistered, so this doubles as the unregistered-recipient target.
 */
export function findMainnetTransferTarget(
  config: LiveConfig,
  chainKeys: ChainKeys,
  frontierHeight: number,
): Promise<SourceTarget> {
  return scanMainnetBelowFrontier(
    config,
    chainKeys.mainnet,
    chainKeys,
    frontierHeight,
    MAX_BLOCKS_SCANNED,
    (receipts) => {
      let best: RpcReceipt | null = null;
      for (const receipt of receipts) {
        if (BigInt(receipt.status) !== 1n) continue;
        if (usdcTransferOrdinal(receipt, config.mainnetUsdc) < 0) continue;
        if (best === null || receipt.logs.length < best.logs.length) best = receipt;
      }
      return best;
    },
    'the successful Mainnet transaction carrying a USDC Transfer with the fewest logs, below the frontier',
  );
}

/** A historical Ethereum Mainnet transaction whose receipt carries `status == 0`. */
export function findMainnetRevertedTarget(
  config: LiveConfig,
  chainKeys: ChainKeys,
  frontierHeight: number,
): Promise<SourceTarget> {
  return scanMainnetBelowFrontier(
    config,
    chainKeys.mainnet,
    chainKeys,
    frontierHeight,
    MAX_BLOCKS_SCANNED,
    (receipts) => receipts.find((receipt) => BigInt(receipt.status) === 0n) ?? null,
    'the first reverted Mainnet transaction below the frontier',
  );
}

/**
 * A successful Mainnet transaction carrying a zero-topic log *before* a USDC `Transfer`.
 *
 * The order is the point. The verifier sweeps a receipt's logs in order and skips one with no topics;
 * only a zero-topic log that sits ahead of the recognised log proves the sweep stepped over it and
 * carried on, because the recognised log is where this deployment's refusal will come from.
 */
export function findMainnetZeroTopicTarget(
  config: LiveConfig,
  chainKeys: ChainKeys,
  frontierHeight: number,
): Promise<SourceTarget> {
  return scanMainnetBelowFrontier(
    config,
    chainKeys.mainnet,
    chainKeys,
    frontierHeight,
    MAX_BLOCKS_SCANNED_RARE,
    (receipts) => {
      let best: RpcReceipt | null = null;
      for (const receipt of receipts) {
        if (BigInt(receipt.status) !== 1n) continue;
        const transfer = usdcTransferOrdinal(receipt, config.mainnetUsdc);
        if (transfer < 0) continue;
        const anonymous = receipt.logs.findIndex((log) => log.topics.length === 0);
        if (anonymous < 0 || anonymous > transfer) continue;
        if (best === null || receipt.logs.length < best.logs.length) best = receipt;
      }
      return best;
    },
    'a successful Mainnet transaction with a zero-topic log ahead of a USDC Transfer, below the frontier',
  );
}

/**
 * A named Source Chain transaction, by hash and chainKey.
 *
 * This is how the cases built on an accepted Settlement get their target: the Watcher lane produces
 * the Settlement on Sepolia and hands its hash over, and the harness reads the receipt back from the
 * Source Chain rather than trusting anything about it.
 */
export async function targetFromSourceTx(
  config: LiveConfig,
  chainKeys: ChainKeys,
  chainKey: number,
  sourceTxHash: string,
  frontierHeight: number,
): Promise<SourceTarget> {
  const urls = chainKey === chainKeys.sepolia ? config.sepoliaRpcUrls : config.mainnetRpcUrls;
  const evmChainId = chainKey === chainKeys.sepolia ? 11155111 : 1;
  if (urls.length === 0) {
    throw new Error(`no Source Chain endpoint is configured for chainKey ${chainKey}, so ${sourceTxHash} cannot be read.`);
  }
  const emitters = emittersOfInterest(config, chainKeys, chainKey);
  const attempts: string[] = [];

  for (const url of urls) {
    const provider = makeProvider(url, evmChainId);
    try {
      const receipt = (await provider.send('eth_getTransactionReceipt', [sourceTxHash])) as RpcReceipt | null;
      if (receipt === null) {
        attempts.push(`${redactUrl(url)}: no receipt for ${sourceTxHash}`);
        continue;
      }
      return targetFromReceipt(
        receipt,
        chainKey,
        emitters,
        frontierHeight,
        url,
        `the Source Chain transaction named on the command line, chainKey ${chainKey}`,
        'A Settlement produced on the Source Chain by the Watcher lane during this wave and handed over by hash. ' +
          'The harness read its receipt back from the Source Chain and sent nothing to Ethereum itself.',
      );
    } catch (error) {
      attempts.push(`${redactUrl(url)}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      provider.destroy();
    }
  }
  throw new Error(`no Source Chain endpoint returned ${sourceTxHash} on chainKey ${chainKey}. Attempts: ${attempts.join(' | ')}`);
}

// ------------------------------------------------------------------------------ proof material

/** What the Proof Builder returned, and what it took to get it. */
export interface ProofMaterial {
  readonly sourceTx: SourceTxShape;
  readonly txIndexFromProofBuilder: number;
  readonly cached: boolean;
  readonly generatedAt: string | null;
  readonly builderEndpoint: string;
  readonly fetchedAt: string;
}

/**
 * Ask the Proof Builder for the material, through the pinned SDK client rather than by hand-rolling
 * the HTTP surface. The attestation wait polls the service's own cache, which can lag the precompile,
 * so it is the right thing to wait on before requesting anything.
 *
 * Fetched fresh for every case rather than cached across a run: a Continuity Proof perishes as
 * attestations age onto the checkpoint grid, and a case that waited on an input for an hour must not
 * submit material built an hour ago.
 */
export async function fetchProofMaterial(
  config: LiveConfig,
  target: SourceTarget,
): Promise<ProofMaterial> {
  const builder = new proofProvider.service.ProofBuilder(
    target.chainKey,
    config.proofBuilderUrl,
    PROOF_BUILDER_TIMEOUT_MS,
  );
  await builder.waitUntilHeightAttested(target.chainKey, target.blockHeight, 15_000, 900_000, 2_000);

  const result = await builder.getProof(target.sourceTxHash);
  if (!result.success || !result.data) {
    throw new Error(`the Proof Builder returned no material for ${target.sourceTxHash}: ${result.error ?? 'no reason given'}`);
  }
  const data = result.data;

  const material: ProofMaterial = {
    sourceTx: {
      chainKey: target.chainKey,
      blockHeight: Number(data.headerNumber),
      encodedTransaction: data.txBytes,
      merkleProof: data.merkleProof as unknown as MerkleProofShape,
      continuityProof: data.continuityProof as unknown as ContinuityProofShape,
    },
    txIndexFromProofBuilder: Number(data.txIndex),
    cached: Boolean(data.cached),
    generatedAt: data.generatedAt === undefined ? null : String(data.generatedAt),
    builderEndpoint: redactUrl(config.proofBuilderUrl),
    fetchedAt: new Date().toISOString(),
  };
  if (material.txIndexFromProofBuilder !== target.txIndexFromSourceRpc) {
    throw new Error(
      `the Proof Builder reports transaction index ${material.txIndexFromProofBuilder} where the Source Chain reports ${target.txIndexFromSourceRpc} for ${target.sourceTxHash}. The material does not belong to the target, so no case built on it would mean anything.`,
    );
  }
  return material;
}

// ----------------------------------------------------------------------------- the keyless control

/** Whether the precompile accepts a given piece of material, established with no key and no gas. */
export interface PrecompileControl {
  readonly method: string;
  readonly verified: boolean | null;
  readonly rawReturnData: string | null;
  readonly reverted: boolean;
  readonly nodeMessage: string | null;
}

/**
 * Put material to the BlockProver Precompile over `eth_call`.
 *
 * `verifyAndEmit` is nonpayable because it emits, but `eth_call` runs it happily and discards the
 * event, so this is a genuine keyless preflight. Run against the genuine material it establishes that
 * the material is sound; run against the mutated material it establishes that the mutation is what
 * the chain objects to.
 */
export async function precompileControl(
  provider: JsonRpcProvider,
  config: LiveConfig,
  tx: SourceTxShape,
): Promise<PrecompileControl> {
  const fragment = FunctionFragment.from(SIG_VERIFY_AND_EMIT);
  const iface = new Interface([fragment]);
  const data = iface.encodeFunctionData(fragment, [
    tx.chainKey,
    tx.blockHeight,
    tx.encodedTransaction,
    tupleMerkleProof(tx.merkleProof),
    tupleContinuityProof(tx.continuityProof),
  ]);
  try {
    const raw = (await provider.send('eth_call', [
      {to: config.blockProverPrecompile, data},
      'latest',
    ])) as string;
    return {
      method: 'eth_call verifyAndEmit on the BlockProver Precompile',
      verified: Boolean(iface.decodeFunctionResult(fragment, raw)[0]),
      rawReturnData: raw,
      reverted: false,
      nodeMessage: null,
    };
  } catch (error) {
    // A reverting control is an outcome, not a failure, and its bytes matter as much as any other
    // refusal: they are what says the precompile itself objected rather than the contract above it.
    const observed = extractRevertData(error);
    return {
      method: 'eth_call verifyAndEmit on the BlockProver Precompile',
      verified: null,
      rawReturnData: observed.data,
      reverted: true,
      nodeMessage: observed.message,
    };
  }
}

// ----------------------------------------------------------------------------------- mutations

/** What a case changed, stated as before and after so a reader can check the mutation itself. */
export interface Mutation {
  readonly field: string;
  readonly genuine: string;
  readonly submitted: string;
  readonly rationale: string;
}

/** Replace the transaction-trie root with 32 random bytes the proof cannot reproduce. */
export function forgeMerkleRoot(tx: SourceTxShape): {mutated: SourceTxShape; mutation: Mutation} {
  const mutated = cloneSourceTx(tx);
  const forged = hexlify(randomBytes(32));
  mutated.merkleProof.root = forged;
  return {
    mutated,
    mutation: {
      field: 'merkleProof.root',
      genuine: tx.merkleProof.root,
      submitted: forged,
      rationale:
        'The sibling path, the encoded transaction, and the Continuity Proof are all genuine. Only the ' +
        'root claimed for the transaction trie is invented, so the proof cannot reproduce it and inclusion ' +
        'is unproven.',
    },
  };
}

/** Flip one byte in the middle of the encoded transaction, leaving its length and everything else. */
export function tamperEncodedTransaction(tx: SourceTxShape): {mutated: SourceTxShape; mutation: Mutation} {
  const mutated = cloneSourceTx(tx);
  const byteLength = (tx.encodedTransaction.length - 2) / 2;
  const offset = Math.floor(byteLength / 2);
  const original = dataSlice(tx.encodedTransaction, offset, offset + 1);
  const flipped = toBeHex(Number(original) ^ 0xff, 1);
  mutated.encodedTransaction = hexlify(
    concat([
      dataSlice(tx.encodedTransaction, 0, offset),
      flipped,
      dataSlice(tx.encodedTransaction, offset + 1),
    ]),
  );
  return {
    mutated,
    mutation: {
      field: `encodedTransaction byte ${offset} of ${byteLength}`,
      genuine: original,
      submitted: flipped,
      rationale:
        'One byte inverted in an otherwise genuine payload. The proof material is untouched, so the ' +
        'submitted bytes no longer hash to the leaf the sibling path commits to and the transaction under ' +
        'proof is not the transaction supplied.',
    },
  };
}

/**
 * Submit genuine Mainnet material under the Sepolia chainKey.
 *
 * Every byte of the proof is genuine and the height is genuine; only the chain the proof is claimed
 * for changes. The Continuity Proof chains to a Mainnet attestation digest, and chainKey 1's registry
 * holds Sepolia digests, so the precompile has nothing to match it against.
 */
export function substituteChainKey(
  tx: SourceTxShape,
  chainKey: number,
): {mutated: SourceTxShape; mutation: Mutation} {
  const mutated = cloneSourceTx(tx);
  mutated.chainKey = chainKey;
  return {
    mutated,
    mutation: {
      field: 'chainKey',
      genuine: String(tx.chainKey),
      submitted: String(chainKey),
      rationale:
        'Genuine Ethereum Mainnet material, claimed to be Sepolia history. The Continuity Proof chains to ' +
        'a Mainnet attestation digest that the Sepolia attestation registry does not hold, and even if the ' +
        'precompile accepted it, the emitter is authorised as a Mainnet Asset and not a Sepolia one.',
    },
  };
}

/** Calldata for `submitSettlement`, encoded against the deployed contract's own ABI. */
export function encodeSubmitSettlement(abi: unknown[], tx: SourceTxShape): string {
  return new Interface(abi).encodeFunctionData('submitSettlement', [tupleSourceTx(tx)]);
}
