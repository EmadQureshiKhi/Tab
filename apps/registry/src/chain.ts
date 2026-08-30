/**
 * The live-chain implementation of {@link LogSource}, over `ethers` v6.
 *
 * ## Two measured properties of this RPC, and what they cost
 *
 * **Block objects come back without `mixHash`.** A client that requires the field
 * fails with a deserialization error on every block read. `ethers` v6 tolerates the
 * omission, which is why it is the client here. The consequence for this file is
 * narrow but worth stating: nothing on the indexing path *needs* a block object at
 * all. Logs carry their own `blockNumber`, `blockHash`, `transactionHash`,
 * `transactionIndex`, and `index`, so the whole envelope comes from
 * `eth_getLogs`. The only block read is the optional timestamp, and it is allowed
 * to fail — {@link EthersLogSource.blockTime} returns `null` rather than
 * propagating, so a client or a node that cannot produce a block header costs a
 * timestamp and never a settled amount.
 *
 * **Batching is rejected outright by several endpoints.** So the provider is
 * constructed with `batchMaxCount: 1` — one JSON-RPC call per request — from
 * `RPC_BATCH_MAX_COUNT`, which `.env.example` pins to `1`. `staticNetwork: true`
 * goes with it: the chain id is configuration, so re-discovering it on every call
 * is a round trip that buys nothing and an extra way to fail.
 *
 * Requirements: 12.6, 24.4
 */

import { JsonRpcProvider, Network, type Log } from "ethers";

import { ALL_TOPIC0, toRawLog, type RawLog } from "./events.js";
import type { LogSource } from "./indexer.js";

/** The configuration this module needs. A subset of `RegistryConfig`. */
export interface ProviderConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly batchMaxCount: number;
}

/**
 * A provider pinned to one network and one call per request.
 *
 * Both options are deliberate and neither is a default. See the module comment.
 */
export function createProvider(config: ProviderConfig): JsonRpcProvider {
  return new JsonRpcProvider(config.rpcUrl, Network.from(config.chainId), {
    batchMaxCount: config.batchMaxCount,
    staticNetwork: true,
  });
}

/** Reads logs from the five watched contracts. */
export class EthersLogSource implements LogSource {
  private readonly provider: JsonRpcProvider;
  private readonly addresses: readonly string[];

  constructor(provider: JsonRpcProvider, addresses: Readonly<Record<string, string>>) {
    this.provider = provider;
    this.addresses = Object.values(addresses);
    if (this.addresses.length === 0) throw new Error("chain: no watched addresses configured");
  }

  async headBlock(): Promise<number> {
    // `eth_blockNumber` returns a quantity, not a block object, so the absent
    // `mixHash` field cannot bite here.
    return this.provider.getBlockNumber();
  }

  /**
   * Every indexed signature from every watched address in one call.
   *
   * The `topics[0]` set is part of the filter rather than applied after the fact,
   * so the five contracts' other events - wiring, `DeliveryRecorded`,
   * `TabDelinquencyCleared` - never cross the wire. The decoder
   * still tolerates one arriving, because an endpoint that ignores the topic filter
   * must not be able to stop the indexer.
   */
  async getLogs(fromBlock: number, toBlock: number): Promise<readonly RawLog[]> {
    const logs: Log[] = await this.provider.getLogs({
      address: [...this.addresses],
      topics: [[...ALL_TOPIC0]],
      fromBlock,
      toBlock,
    });
    return logs.map(toRawLog);
  }

  /**
   * The block's timestamp, or `null`.
   *
   * This is the one place a block object is read, and the only place this service
   * tolerates a failed read silently: the timestamp feeds the settlement timeline,
   * and a timeline missing a tick is a lesser fault than an indexer that stops.
   */
  async blockTime(blockNumber: number): Promise<Date | null> {
    try {
      const block = await this.provider.getBlock(blockNumber);
      if (block === null) return null;
      return new Date(block.timestamp * 1000);
    } catch {
      return null;
    }
  }
}
