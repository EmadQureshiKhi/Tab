/**
 * Live harness — the chain surface.
 *
 * Two things happen here and nothing else: a submission is put to the live deployment, and what came
 * back is captured. Both halves are deliberately blunt.
 *
 * **Every claim is read back.** A keyless `eth_call` establishes what the deployment does with the
 * calldata before a transaction is spent, and after the transaction is mined the same call is
 * replayed against the block it landed in, so the recorded returndata belongs to the state the
 * transaction actually met. A success message from a submitting tool is not evidence of anything;
 * the receipt and the read-back are.
 *
 * **Gas limits are explicit and generous.** Estimation on this network comes from a warm simulation
 * and understates a cold-storage write, so a submission sized from an estimate can run out of gas
 * and look exactly like a revert. Every submission therefore carries a stated limit, and every
 * receipt is checked for `gasUsed == gasLimit`, which is the signature of exhaustion rather than of
 * refusal. The distinction is recorded, not inferred by the reader.
 *
 * Requirements: 27.3
 */

import {
  JsonRpcProvider,
  Wallet,
  formatEther,
  keccak256,
  toQuantity,
} from 'ethers';

import {explorerTxLink, type LiveConfig} from './config.mjs';
import {observeRevert, observeSuccess, type ErrorDictionary, type RevertObservation} from './revert.mjs';

/**
 * Gas ceiling every live submission carries.
 *
 * Sized from the measured cost of a full ingestion — the proof call, the receipt decode, the replay
 * ledger write, and the collaborator calls — with generous headroom, then stated rather than
 * estimated. A rejected submission unwinds and refunds the remainder, so an ample limit on a
 * negative-path case costs nothing beyond the gas actually burned. Roughly four percent of the
 * 75,000,000 block gas limit this network runs.
 */
export const SUBMISSION_GAS_LIMIT = 3_000_000n;

/** How long a broadcast submission is given to appear in a block. Blocks here land every 15 seconds. */
const RECEIPT_TIMEOUT_MS = 180_000;

/**
 * Every endpoint in play is constructed one call per request with a fixed network. Batching is
 * rejected outright by several public endpoints, and letting the provider re-detect the network mid
 * run turns a transient read failure into an unrelated-looking error.
 */
export function makeProvider(url: string, chainId: number): JsonRpcProvider {
  return new JsonRpcProvider(url, chainId, {batchMaxCount: 1, staticNetwork: true});
}

/** What the harness knows about the chain it is aimed at, recorded once per run. */
export interface ChainContext {
  readonly chainId: number;
  readonly blockNumber: number;
  readonly blockGasLimit: string;
  readonly gasPriceWei: string | null;
  readonly settlementVerifierCodeBytes: number;
  readonly blockProverCodeBytes: number;
  readonly submitter: string | null;
  readonly submitterBalanceWei: string | null;
  readonly submitterBalanceCtc: string | null;
}

/**
 * Read the chain context and refuse to continue when the deployment is not there. Code presence at
 * the verifier address is the cheapest possible check that the environment names a live contract
 * rather than an address that once held one.
 */
export async function readChainContext(
  provider: JsonRpcProvider,
  config: LiveConfig,
  submitter: Wallet | null,
): Promise<ChainContext> {
  const [network, blockNumber, block, feeData, verifierCode, proverCode] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
    provider.getBlock('latest'),
    provider.getFeeData(),
    provider.getCode(config.settlementVerifier),
    provider.getCode(config.blockProverPrecompile),
  ]);

  if (Number(network.chainId) !== config.creditcoinChainId) {
    throw new Error(
      `the endpoint reports chain ${network.chainId} while the environment names ${config.creditcoinChainId}.`,
    );
  }
  if (verifierCode === '0x') {
    throw new Error(
      `no code at ${config.settlementVerifier}. The environment names a SettlementVerifier that this endpoint cannot see.`,
    );
  }

  let balance: bigint | null = null;
  if (submitter !== null) {
    balance = await provider.getBalance(submitter.address);
  }

  return {
    chainId: Number(network.chainId),
    blockNumber,
    blockGasLimit: (block?.gasLimit ?? 0n).toString(),
    gasPriceWei: feeData.gasPrice === null ? null : feeData.gasPrice.toString(),
    settlementVerifierCodeBytes: (verifierCode.length - 2) / 2,
    // A precompile can answer without publishing code, so this is recorded and never gated on.
    blockProverCodeBytes: (proverCode.length - 2) / 2,
    submitter: submitter?.address ?? null,
    submitterBalanceWei: balance === null ? null : balance.toString(),
    submitterBalanceCtc: balance === null ? null : formatEther(balance),
  };
}

// ------------------------------------------------------------------------------------- observations

/** What went on the wire, in enough detail to replay it by hand. */
export interface SubmissionRecord {
  readonly from: string | null;
  readonly to: string;
  readonly selector: string;
  readonly calldataByteLength: number;
  readonly calldataKeccak: string;
  readonly gasLimit: string;
}

/** A keyless read of what the deployment does with this calldata. Costs nothing. */
export interface PreflightRecord extends RevertObservation {
  readonly method: 'eth_call';
  readonly blockTag: string;
  readonly accepted: boolean;
}

/** The mined transaction, its receipt, and the returndata read back from the block it landed in. */
export interface OnChainRecord {
  readonly transactionHash: string;
  readonly nonce: number;
  readonly blockNumber: number | null;
  readonly blockHash: string | null;
  readonly status: number | null;
  readonly gasLimit: string;
  readonly gasUsed: string | null;
  /** `gasUsed == gasLimit` means the submission was exhausted, not refused. */
  readonly outOfGas: boolean;
  readonly effectiveGasPriceWei: string | null;
  readonly feeSpentWei: string | null;
  readonly feeSpentCtc: string | null;
  readonly explorerUrl: string | null;
  /** The same call replayed against the block the transaction landed in. */
  readonly revertData: (RevertObservation & {method: string; blockTag: string}) | null;
}

/** Everything one submission produced. */
export interface SubmissionOutcome {
  readonly submission: SubmissionRecord;
  readonly preflight: PreflightRecord;
  readonly onChain: OnChainRecord | null;
}

function describe(calldata: string, to: string, from: string | null): SubmissionRecord {
  return {
    from,
    to,
    selector: calldata.slice(0, 10),
    calldataByteLength: (calldata.length - 2) / 2,
    calldataKeccak: keccak256(calldata),
    gasLimit: SUBMISSION_GAS_LIMIT.toString(),
  };
}

/**
 * Put the calldata to the deployment with `eth_call` and record the answer. No key, no gas, no state
 * change. The gas field is set to the same limit a real submission would carry, so an exhaustion
 * that a real submission would hit is visible here too.
 */
async function preflight(
  provider: JsonRpcProvider,
  to: string,
  calldata: string,
  from: string | null,
  dictionary: ErrorDictionary,
  blockTag: string,
): Promise<PreflightRecord> {
  const request: Record<string, string> = {to, data: calldata, gas: toQuantity(SUBMISSION_GAS_LIMIT)};
  if (from !== null) request.from = from;
  try {
    const returnData = (await provider.send('eth_call', [request, blockTag])) as string;
    return {...observeSuccess(returnData), method: 'eth_call', blockTag, accepted: true};
  } catch (error) {
    return {...observeRevert(error, dictionary), method: 'eth_call', blockTag, accepted: false};
  }
}

/**
 * Run one submission.
 *
 * With no signer, the keyless preflight is the whole outcome and the run spends nothing. With a
 * signer, the transaction is broadcast with the stated gas limit — no estimation, so a submission
 * the node would refuse to estimate still reaches the chain and still produces a hash — and the
 * receipt is then read back and the call replayed against the mined block.
 */
export async function submit(
  provider: JsonRpcProvider,
  config: LiveConfig,
  signer: Wallet | null,
  calldata: string,
  dictionary: ErrorDictionary,
): Promise<SubmissionOutcome> {
  const to = config.settlementVerifier;
  const from = signer?.address ?? null;
  const submission = describe(calldata, to, from);
  const before = await preflight(provider, to, calldata, from, dictionary, 'latest');

  if (signer === null) return {submission, preflight: before, onChain: null};

  // No `estimateGas`. A submission that is going to be refused cannot be estimated, and an estimate
  // taken from a warm simulation understates a cold write, so the limit is stated instead.
  const sent = await signer.sendTransaction({to, data: calldata, gasLimit: SUBMISSION_GAS_LIMIT});

  // Deliberately not `sent.wait()`. That throws on a receipt with status 0, which for a negative-path
  // case is the outcome under test — the whole point is to mine a refusal and record it. Waiting on
  // the provider returns the receipt for a reverted transaction the same as for a successful one.
  const receipt = await provider.waitForTransaction(sent.hash, 1, RECEIPT_TIMEOUT_MS);
  if (receipt === null) {
    throw new Error(
      `transaction ${sent.hash} was broadcast but no receipt appeared within ${RECEIPT_TIMEOUT_MS / 1000} seconds. It may still be mined; check the hash before resubmitting.`,
    );
  }

  const gasUsed = receipt.gasUsed;
  const fee = receipt.fee;
  // A quantity, so the minimal form. `toBeHex` would pad to whole bytes and this endpoint refuses a
  // block number carrying a leading zero digit.
  const blockTag = toQuantity(receipt.blockNumber);

  // The receipt says whether the submission succeeded; it never carries the returndata. Replaying
  // the identical call against the block it landed in is what produces the bytes, and pinning the
  // block is what makes those bytes belong to the state the transaction actually met.
  let replay: (RevertObservation & {method: string; blockTag: string}) | null = null;
  try {
    const returnData = (await provider.send('eth_call', [
      {from, to, data: calldata, gas: toQuantity(SUBMISSION_GAS_LIMIT)},
      blockTag,
    ])) as string;
    replay = {...observeSuccess(returnData), method: 'eth_call replayed at the mined block', blockTag};
  } catch (error) {
    replay = {...observeRevert(error, dictionary), method: 'eth_call replayed at the mined block', blockTag};
  }

  return {
    submission,
    preflight: before,
    onChain: {
      transactionHash: sent.hash,
      nonce: sent.nonce,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      status: receipt.status,
      gasLimit: SUBMISSION_GAS_LIMIT.toString(),
      gasUsed: gasUsed.toString(),
      outOfGas: gasUsed === SUBMISSION_GAS_LIMIT,
      effectiveGasPriceWei: receipt.gasPrice.toString(),
      feeSpentWei: fee.toString(),
      feeSpentCtc: formatEther(fee),
      explorerUrl: explorerTxLink(config, sent.hash),
      revertData: replay,
    },
  };
}
