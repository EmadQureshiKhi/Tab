/**
 * The `SettlementVerifier` read surface the proof hook depends on, and the two
 * implementations of it: one over `ethers` against the deployed contract, one
 * in memory for tests.
 *
 * ## One event, read by the Agent it names
 *
 * `SettlementVerifier` emits `SettlementRecorded` once per ingested Settlement
 * log (R4.7), and it indexes `agent`, which is the Agent's Creditcoin address.
 * That is the same address a Service already holds for every metered request,
 * in `Tab-Agent`, so the query this interface exposes is "every Verified
 * Settlement recorded for this Agent", answered by one `eth_getLogs` with the
 * Agent in `topics[2]`. Nothing here filters on the Source Chain transaction
 * hash, because the event does not carry it and a hash is not a Settlement's
 * identity in any case; the replay key is, and the event carries that.
 *
 * ## Narrow on purpose
 *
 * {@link SettlementVerifierClient} has one method. The proof hook needs no
 * other read, and a Service that runs its own indexer answers the same question
 * from its database by implementing one method rather than by adapting a
 * provider. The fake below is that same one method over an array.
 *
 * ## Reads at `finalized`
 *
 * The `ethers`-backed client reads at the `finalized` block tag by default, the
 * rule every Creditcoin read in this workspace follows: `latest` was measured
 * two blocks ahead of `finalized`, and a Settlement reported at `latest` can be
 * a Settlement that is later not there.
 *
 * Requirements: 23.5, 24.2
 */

import { Interface } from "ethers";

import {
  CREDITCOIN,
  causeOf,
  err,
  isAddress,
  isBytes32,
  ok,
  type Address,
  type Bytes32,
  type Hex,
  type Result,
} from "@tabai/shared";

import { validationError } from "../errors.js";
import { addressTopic, type SettlementHint } from "../payments/strategy.js";

/**
 * The event, exactly as `SettlementVerifier.sol` declares it. Pinned here rather
 * than generated because it is one line and because the field order is what the
 * decoder below reads positionally.
 */
export const SETTLEMENT_RECORDED_EVENT =
  "event SettlementRecorded(bytes32 indexed replayKey, uint64 chainKey, uint64 blockHeight, uint64 txIndex, uint64 logIndex, address indexed agent, bytes32 indexed serviceId, address asset, uint256 amount, address payerAddress, bytes32 sourceTabId)";

const SETTLEMENT_RECORDED_INTERFACE = new Interface([SETTLEMENT_RECORDED_EVENT]);

/** `topics[0]` of `SettlementRecorded`, derived by `ethers` from the declaration. */
export const SETTLEMENT_RECORDED_TOPIC0 = SETTLEMENT_RECORDED_INTERFACE.getEvent(
  "SettlementRecorded",
)!.topicHash as Bytes32;

/** One `SettlementRecorded` event, decoded, with where on Creditcoin it was emitted. */
export interface RecordedSettlement {
  /** The Settlement's identity: `(chainKey, blockHeight, txIndex, logIndex)` packed. */
  readonly replayKey: Bytes32;
  readonly chainKey: bigint;
  readonly blockHeight: bigint;
  readonly txIndex: bigint;
  readonly logIndex: bigint;
  /** The Agent's Creditcoin address, resolved on chain from the payer. */
  readonly agent: Address;
  readonly serviceId: Bytes32;
  readonly asset: Address;
  /** Integer Asset base units. */
  readonly amount: bigint;
  /** `topics[1]` of the Source Chain log: the account that paid. */
  readonly payerAddress: Address;
  /** The tabId named on the `settlement-contract` surface; the zero word on a plain `Transfer`. */
  readonly sourceTabId: Bytes32;
  /** Where the event sits on Creditcoin, so a reader can fetch it from any node. */
  readonly creditcoin: {
    readonly blockNumber: number;
    readonly txHash: Hex;
    readonly logIndex: number;
  };
}

/** A Verified Settlement attached to a proxied request (R23.5). */
export interface VerifiedSettlementView extends RecordedSettlement {
  /** The Blockscout page for the Creditcoin transaction that recorded it (R24.2). */
  readonly blockscoutUrl: string;
  /** The hint this Settlement was matched against. */
  readonly matchedHint: SettlementHint;
}

export interface RecordedSettlementQuery {
  /** The Agent's Creditcoin address. Indexed on the event, so the read is one filtered `eth_getLogs`. */
  readonly agent: Address;
  /** Lowest Creditcoin block to read. Defaults to the client's lookback. */
  readonly fromBlock?: number;
}

/** The one read the proof hook makes. */
export interface SettlementVerifierClient {
  /** Names the source in logs: `ethers:0xc5c8...` or `fake`. */
  readonly id: string;
  recordedSettlements(query: RecordedSettlementQuery): Promise<Result<readonly RecordedSettlement[]>>;
}

// ---------------------------------------------------------------- the ethers client

/** The fields of one log this module reads. Declared so a test can hand in a plain object. */
export interface VerifierLogLike {
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: number;
  readonly transactionHash: string;
  readonly index: number;
}

export interface VerifierLogFilter {
  readonly address: string;
  readonly topics: readonly (string | null)[];
  readonly fromBlock: number;
  readonly toBlock: number | string;
}

/**
 * The two provider calls the client makes. An `ethers` `JsonRpcProvider`
 * satisfies this as it stands; a test satisfies it with two closures.
 */
export interface VerifierLogProvider {
  getBlockNumber(): Promise<number>;
  getLogs(filter: VerifierLogFilter): Promise<readonly VerifierLogLike[]>;
}

export interface EthersSettlementVerifierClientOptions {
  readonly provider: VerifierLogProvider;
  /** The deployed `SettlementVerifier`. */
  readonly address: Address;
  /**
   * How many blocks below the head a query without `fromBlock` reads. Defaults
   * to {@link DEFAULT_LOOKBACK_BLOCKS}. The deployment block is the right floor
   * for a Service that wants the whole history; supply it as `floorBlock`.
   */
  readonly lookbackBlocks?: number;
  /** Never read below this block. Defaults to 0. */
  readonly floorBlock?: number;
  /** Block tag the read is pinned to. Defaults to `finalized`. */
  readonly blockTag?: "finalized" | "latest";
}

/**
 * The default lookback. Creditcoin produced roughly 6,000 blocks a day in the
 * week the deployment was measured, so this is about three days of history,
 * which comfortably covers a Settlement Window of at most 24 hours (R16.4).
 */
export const DEFAULT_LOOKBACK_BLOCKS = 20_000;

/**
 * Reads `SettlementRecorded` from the deployed verifier through `ethers`.
 *
 * Construction is total. An unusable address is reported by the first read, the
 * only place a caller can act on it, which is the shape every factory in this
 * package has.
 */
export function createEthersSettlementVerifierClient(
  options: EthersSettlementVerifierClientOptions,
): SettlementVerifierClient {
  const lookback = options.lookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS;
  const floor = options.floorBlock ?? 0;
  const blockTag = options.blockTag ?? "finalized";

  return {
    id: `ethers:${options.address.toLowerCase()}`,

    async recordedSettlements(query): Promise<Result<readonly RecordedSettlement[]>> {
      if (!isAddress(options.address)) {
        return validationError(
          "VERIFIER_ADDRESS_INVALID",
          `the SettlementVerifier address must be a 20-byte 0x address, received \`${String(options.address)}\``,
        );
      }
      if (!isAddress(query.agent)) {
        return validationError(
          "AGENT_INVALID",
          `agent must be a 20-byte 0x address, received \`${String(query.agent)}\``,
        );
      }

      let head: number;
      try {
        head = await options.provider.getBlockNumber();
      } catch (error) {
        return err({
          category: "UPSTREAM",
          code: "VERIFIER_HEAD_UNREADABLE",
          message: "the Creditcoin head could not be read, so no SettlementRecorded window can be chosen",
          retryable: true,
          cause: causeOf(error),
        });
      }

      const fromBlock = Math.max(floor, query.fromBlock ?? head - lookback, 0);
      let logs: readonly VerifierLogLike[];
      try {
        logs = await options.provider.getLogs({
          address: options.address,
          topics: [SETTLEMENT_RECORDED_TOPIC0, null, addressTopic(query.agent)],
          fromBlock,
          toBlock: blockTag,
        });
      } catch (error) {
        return err({
          category: "UPSTREAM",
          code: "VERIFIER_LOGS_UNREADABLE",
          message: `SettlementRecorded logs for Agent ${query.agent} could not be read from ${options.address}`,
          retryable: true,
          cause: causeOf(error),
          details: { fromBlock, agent: query.agent },
        });
      }

      const records: RecordedSettlement[] = [];
      for (const log of logs) {
        const decoded = decodeSettlementRecorded(log);
        if (!decoded.ok) return decoded;
        records.push(decoded.value);
      }
      return ok(records);
    },
  };
}

/**
 * Decodes one `SettlementRecorded` log. A log that carries the right `topics[0]`
 * but does not decode is a `CHAIN` error rather than a skip, because it means
 * the deployed contract and this declaration have drifted, and a hook silently
 * matching nothing is the worst way to learn that.
 */
export function decodeSettlementRecorded(log: VerifierLogLike): Result<RecordedSettlement> {
  let parsed;
  try {
    parsed = SETTLEMENT_RECORDED_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
  } catch (error) {
    return err({
      category: "CHAIN",
      code: "SETTLEMENT_RECORDED_UNDECODABLE",
      message: `a log at Creditcoin block ${log.blockNumber} carries the SettlementRecorded topic but does not decode as one`,
      retryable: false,
      cause: causeOf(error),
    });
  }
  if (parsed === null || parsed.name !== "SettlementRecorded") {
    return err({
      category: "CHAIN",
      code: "SETTLEMENT_RECORDED_UNDECODABLE",
      message: `a log at Creditcoin block ${log.blockNumber} is not a SettlementRecorded event`,
      retryable: false,
    });
  }
  const a = parsed.args;
  const replayKey = String(a[0]).toLowerCase();
  const serviceId = String(a[6]).toLowerCase();
  const sourceTabId = String(a[10]).toLowerCase();
  if (!isBytes32(replayKey) || !isBytes32(serviceId) || !isBytes32(sourceTabId)) {
    return err({
      category: "CHAIN",
      code: "SETTLEMENT_RECORDED_UNDECODABLE",
      message: `a SettlementRecorded log at Creditcoin block ${log.blockNumber} carries a word that is not 32 bytes`,
      retryable: false,
    });
  }
  return ok({
    replayKey,
    chainKey: BigInt(a[1] as bigint),
    blockHeight: BigInt(a[2] as bigint),
    txIndex: BigInt(a[3] as bigint),
    logIndex: BigInt(a[4] as bigint),
    agent: String(a[5]).toLowerCase() as Address,
    serviceId,
    asset: String(a[7]).toLowerCase() as Address,
    amount: BigInt(a[8] as bigint),
    payerAddress: String(a[9]).toLowerCase() as Address,
    sourceTabId,
    creditcoin: {
      blockNumber: log.blockNumber,
      txHash: log.transactionHash.toLowerCase() as Hex,
      logIndex: log.index,
    },
  });
}

// ---------------------------------------------------------------- the fake

export interface FakeSettlementVerifierClient extends SettlementVerifierClient {
  /** Every query made, oldest first. */
  readonly queries: readonly RecordedSettlementQuery[];
  /** Replaces the records every later query answers with. */
  set(records: readonly RecordedSettlement[]): void;
  /** Makes every later query fail with this error, or clears the failure. */
  fail(error: import("@tabai/shared").TabError | undefined): void;
}

/**
 * An in-memory verifier: the same one method over an array, filtered by Agent
 * exactly as the indexed topic filters on chain.
 */
export function createFakeSettlementVerifierClient(
  initial: readonly RecordedSettlement[] = [],
): FakeSettlementVerifierClient {
  let records = [...initial];
  let failure: import("@tabai/shared").TabError | undefined;
  const queries: RecordedSettlementQuery[] = [];
  return {
    id: "fake",
    queries,
    set(next) {
      records = [...next];
    },
    fail(error) {
      failure = error;
    },
    async recordedSettlements(query) {
      queries.push(query);
      if (failure !== undefined) return err(failure);
      const agent = query.agent.toLowerCase();
      const from = query.fromBlock ?? 0;
      return ok(
        records.filter(
          (record) => record.agent.toLowerCase() === agent && record.creditcoin.blockNumber >= from,
        ),
      );
    },
  };
}

/** The Blockscout page for a Creditcoin transaction (R24.2). */
export function blockscoutTxUrl(txHash: Hex, explorerUrl: string = defaultExplorerUrl()): string {
  return `${explorerUrl.replace(/\/+$/, "")}/tx/${txHash}`;
}

/**
 * `CREDITCOIN_EXPLORER_URL` when the environment sets it, else the pinned
 * constant. The variable is declared in `.env.example` with the SDK as a
 * consumer, which is what the environment completeness gate checks.
 */
export function defaultExplorerUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CREDITCOIN_EXPLORER_URL?.trim();
  return configured !== undefined && configured.length > 0 ? configured : CREDITCOIN.explorerUrl;
}
