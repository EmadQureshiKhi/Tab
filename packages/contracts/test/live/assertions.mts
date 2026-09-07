/**
 * Live harness — on-chain state reads for the cases whose expected outcome is acceptance.
 *
 * Seven of the nine cases expect a refusal, and a refusal is its own evidence: the returndata says
 * what the deployment objected to. Three do not. The relayed payer (27.10), the two-log transaction
 * (27.11), and the zero-topic tolerance case (27.12) expect the deployment to *accept* a submission,
 * and an acceptance proves nothing by itself: what matters is who was credited and which replay keys
 * were spent. Those facts live in `TabBook`, `AgentRegistry`, and the verifier's own claim ledger,
 * and this module reads them back, before and after, from the deployed contracts.
 *
 * Two things this module refuses to do. It never computes a replay key from anything but the
 * contract's own packing rule, so a mispacked key would be caught by the chain and not hidden by the
 * harness. And it never reads a Creditcoin agent from a Source Chain address by any route other than
 * `AgentRegistry.agentOf`, because that resolution is precisely what 27.10 puts under test.
 *
 * Every read goes through the compiled ABIs in `out/`, for the same reason the error dictionary
 * does: a signature written out here would drift silently, and an ABI read from the artefact cannot.
 *
 * Requirements: 27.7, 27.10, 27.11, 27.12
 */

import {existsSync, readFileSync} from 'node:fs';
import {resolve as resolvePath} from 'node:path';

import {Interface, type JsonRpcProvider, toBeHex, toQuantity, zeroPadValue} from 'ethers';

import {CONTRACTS_DIR, type LiveConfig} from './config.mjs';
import type {ChainKeys, SettlementLogView, SourceTarget} from './proof.mjs';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Blocks per `eth_getLogs` request on Creditcoin, which serves this width without complaint. */
const EVENT_SCAN_CHUNK = 2_000;

/** The compiled ABI of one deployed contract. */
export function loadArtifactAbi(name: string): unknown[] {
  const path = resolvePath(CONTRACTS_DIR, 'out', `${name}.sol`, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`out/${name}.sol/${name}.json is absent. Run \`forge build\` in packages/contracts first.`);
  }
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as {abi?: unknown[]};
  if (!Array.isArray(artifact.abi)) throw new Error(`the ${name} artefact carries no ABI.`);
  return artifact.abi;
}

/** Replay key exactly as `TabAscBase.replayKey` packs it: four `uint64` fields at 192, 128, 64, 0. */
export function replayKeyOf(chainKey: number, blockHeight: number, txIndex: number, logIndex: number): string {
  const packed =
    (BigInt(chainKey) << 192n) | (BigInt(blockHeight) << 128n) | (BigInt(txIndex) << 64n) | BigInt(logIndex);
  return zeroPadValue(toBeHex(packed), 32);
}

function requireAddress(value: string | null, name: string): string {
  if (value === null) {
    throw new Error(`${name} is the zero placeholder, and this case has to read the deployed contract it names.`);
  }
  return value;
}

async function call(
  provider: JsonRpcProvider,
  to: string,
  iface: Interface,
  method: string,
  args: readonly unknown[],
): Promise<ReadonlyArray<unknown>> {
  const raw = (await provider.send('eth_call', [{to, data: iface.encodeFunctionData(method, [...args])}, 'latest'])) as string;
  return iface.decodeFunctionResult(method, raw).toArray();
}

// ------------------------------------------------------------------------------------ reads

/** The reader over the deployed collaborators, built once per run. */
export class DeploymentReads {
  private readonly verifier: Interface;
  private readonly registry: Interface;
  private readonly agents: Interface;
  private readonly tabBook: Interface;

  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly config: LiveConfig,
    verifierAbi: unknown[],
  ) {
    this.verifier = new Interface(verifierAbi);
    this.registry = new Interface(loadArtifactAbi('ServiceRegistry'));
    this.agents = new Interface(loadArtifactAbi('AgentRegistry'));
    this.tabBook = new Interface(loadArtifactAbi('TabBook'));
  }

  /** Whether the verifier has already recorded a replay key. */
  async claimedLog(replayKey: string): Promise<boolean> {
    const [claimed] = await call(this.provider, this.config.settlementVerifier, this.verifier, 'claimedLog', [replayKey]);
    return Boolean(claimed);
  }

  /** The Creditcoin agent bound to a Source Chain address, or the zero address. */
  async agentOf(chainKey: number, ethAddress: string): Promise<string> {
    const registry = requireAddress(this.config.agentRegistry, 'AGENT_REGISTRY_ADDRESS');
    const [agent] = await call(this.provider, registry, this.agents, 'agentOf', [chainKey, ethAddress]);
    return String(agent);
  }

  /** The rolling Verified Settlement history commitment for one agent and Asset. */
  async historyCommitment(agent: string, asset: string): Promise<{root: string; count: number}> {
    const tabBook = requireAddress(this.config.tabBook, 'TAB_BOOK_ADDRESS');
    const [root, count] = await call(this.provider, tabBook, this.tabBook, 'historyCommitment', [agent, asset]);
    return {root: String(root), count: Number(count)};
  }

  /**
   * Whether the verifier would recognise a log, by the rule `SettlementVerifier._isRecognised`
   * applies: the `(chainKey, emitter)` pair must be authorised, a `Transfer` needs an Asset emitter,
   * and a `TabSettled` needs the settlement contract on the Sepolia chainKey. A recognised log then
   * credits only if its recipient is a registered Collection Address; an unregistered one reverts the
   * whole submission, so this reports both facts.
   */
  async recognition(
    chainKeys: ChainKeys,
    chainKey: number,
    log: SettlementLogView,
  ): Promise<{recognised: boolean; collectionRegistered: boolean; serviceId: string | null; asset: string | null}> {
    const registry = requireAddress(this.config.serviceRegistry, 'SERVICE_REGISTRY_ADDRESS');
    const [emitter] = (await call(this.provider, registry, this.registry, 'emitterFor', [chainKey, log.emitter])) as [
      {kind: bigint; asset: string; authorised: boolean},
    ];
    const kind = Number(emitter.kind);
    const recognised =
      emitter.authorised &&
      ((log.signature === 'Transfer' && kind === 1) ||
        (log.signature === 'TabSettled' && kind === 2 && chainKey === chainKeys.sepolia));
    if (!recognised) return {recognised: false, collectionRegistered: false, serviceId: null, asset: null};

    const [collection] = (await call(this.provider, registry, this.registry, 'collectionFor', [
      chainKey,
      log.recipientFromTopic2,
    ])) as [{serviceId: string; asset: string; chainKey: bigint; exists: boolean}];
    return {
      recognised: true,
      collectionRegistered: Boolean(collection.exists),
      serviceId: collection.exists ? String(collection.serviceId) : null,
      asset: collection.exists ? String(collection.asset) : null,
    };
  }

  /**
   * Every `SettlementRecorded` event the verifier emitted for a replay key, scanned in fixed-width
   * chunks from the deployment block. Used when a Settlement was accepted by an earlier submission
   * (the Watcher's, typically) and the harness has to read who was credited rather than submit again.
   */
  async settlementRecorded(replayKey: string): Promise<
    readonly {
      readonly creditcoinTxHash: string;
      readonly blockNumber: number;
      readonly agent: string;
      readonly serviceId: string;
      readonly asset: string;
      readonly amount: string;
      readonly payerAddress: string;
    }[]
  > {
    const fragment = this.verifier.getEvent('SettlementRecorded');
    if (fragment === null) throw new Error('the verifier ABI carries no SettlementRecorded event.');
    const head = Number(BigInt((await this.provider.send('eth_blockNumber', [])) as string));
    const found: {
      creditcoinTxHash: string;
      blockNumber: number;
      agent: string;
      serviceId: string;
      asset: string;
      amount: string;
      payerAddress: string;
    }[] = [];
    for (let from = this.config.eventScanFloor; from <= head; from += EVENT_SCAN_CHUNK) {
      const to = Math.min(from + EVENT_SCAN_CHUNK - 1, head);
      const logs = (await this.provider.send('eth_getLogs', [
        {
          address: this.config.settlementVerifier,
          topics: [fragment.topicHash, replayKey],
          // Quantities, so `toQuantity` and not `toBeHex`: the latter pads to whole bytes and every
          // configured endpoint rejects a leading zero digit in a block number.
          fromBlock: toQuantity(from),
          toBlock: toQuantity(to),
        },
      ])) as {transactionHash: string; blockNumber: string; topics: string[]; data: string}[];
      for (const log of logs) {
        const decoded = this.verifier.decodeEventLog(fragment, log.data, log.topics);
        found.push({
          creditcoinTxHash: log.transactionHash,
          blockNumber: Number(BigInt(log.blockNumber)),
          agent: String(decoded.agent),
          serviceId: String(decoded.serviceId),
          asset: String(decoded.asset),
          amount: String(decoded.amount),
          payerAddress: String(decoded.payerAddress),
        });
      }
    }
    return found;
  }
}

// ------------------------------------------------------------------------------- expectations

/** One recognised log of a target, with the replay key it will spend and how the registry sees it. */
export interface ExpectedIngestion {
  readonly ordinal: number;
  readonly signature: 'Transfer' | 'TabSettled';
  readonly emitter: string;
  readonly payerFromTopic1: string;
  readonly recipientFromTopic2: string;
  readonly amountBaseUnits: string;
  readonly replayKey: string;
  readonly recognised: boolean;
  readonly collectionRegistered: boolean;
  readonly serviceId: string | null;
  readonly asset: string | null;
}

/**
 * What the deployment is expected to do with each Settlement-shaped log of a target, worked out from
 * the registry before anything is submitted. The replay key packs the ordinal inside the receipt,
 * which is the `logIndex` the verifier uses, and never the block-wide log index.
 */
export async function expectedIngestions(
  reads: DeploymentReads,
  chainKeys: ChainKeys,
  target: SourceTarget,
): Promise<readonly ExpectedIngestion[]> {
  const out: ExpectedIngestion[] = [];
  for (const log of target.settlementLogs) {
    const seen = await reads.recognition(chainKeys, target.chainKey, log);
    out.push({
      ordinal: log.ordinal,
      signature: log.signature,
      emitter: log.emitter,
      payerFromTopic1: log.payerFromTopic1,
      recipientFromTopic2: log.recipientFromTopic2,
      amountBaseUnits: log.amountBaseUnits,
      replayKey: replayKeyOf(target.chainKey, target.blockHeight, target.txIndexFromSourceRpc, log.ordinal),
      ...seen,
    });
  }
  return out;
}

/** A credit-relevant snapshot of one Source Chain address: its bound agent and that agent's history. */
export interface AddressSnapshot {
  readonly ethAddress: string;
  readonly agent: string;
  readonly bound: boolean;
  readonly history: {root: string; count: number} | null;
}

export async function snapshotAddress(
  reads: DeploymentReads,
  chainKey: number,
  ethAddress: string,
  asset: string | null,
): Promise<AddressSnapshot> {
  const agent = await reads.agentOf(chainKey, ethAddress);
  const bound = agent.toLowerCase() !== ZERO_ADDRESS;
  const history = bound && asset !== null ? await reads.historyCommitment(agent, asset) : null;
  return {ethAddress, agent, bound, history};
}

/** One assertion, stated so the record reads as a claim and its evidence rather than a boolean. */
export interface Assertion {
  readonly claim: string;
  readonly holds: boolean;
  readonly evidence: string;
}

export const assertion = (claim: string, holds: boolean, evidence: string): Assertion => ({claim, holds, evidence});
