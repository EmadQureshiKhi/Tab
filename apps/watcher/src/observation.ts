/**
 * Observation: turning Source Chain logs into persisted Settlement records.
 *
 * This is the front of the pipeline. Nothing here spends gas and nothing here
 * decides anything about credit; its whole job is to see a Settlement, write it
 * down, and only then let the rest of the Watcher act on it (R20.6).
 *
 * ## What is watched is the registry's answer, not configuration's
 *
 * `ServiceRegistry.emitterFor(chainKey, emitter)` says whether a contract may
 * produce Settlements on a chain, and `collectionFor(chainKey, collection)` says
 * which Service and Asset a recipient belongs to. Configuration only *offers*
 * addresses; every one is resolved through those two reads and an address the
 * registry does not authorise is reported as unresolved rather than watched. Same
 * rule discovery applies to chains, for the same reason: an operator must not be
 * able to widen what the Watcher credits by editing an environment file.
 *
 * The two reads answer different questions and both are needed. The emitter table
 * is not per Service — one Asset contract serves every Service that accepts that
 * Asset — so it answers "may this contract emit Settlements here at all", while
 * the collection table answers "whose Settlement is this one". A target exists
 * only where both answer, and where they agree on the Asset.
 *
 * ## Two surfaces, one filter shape
 *
 * - chainKey 3: a plain `Transfer(address,address,uint256)` on the Asset, with
 *   `topics[2]` the Collection Address. Tab deploys nothing on Mainnet.
 * - chainKey 1: `TabSettled(address,address,uint256,bytes32)` on the registered
 *   settlement contract, again with `topics[2]` the Collection Address.
 *
 * So one filter shape covers both: `[topic0, null, collectionTopic]`. The payer is
 * `topics[1]` and never the transaction sender, so a relayer paying gas cannot be
 * credited — the same rule the contracts enforce, applied at the point of
 * observation so a mis-credited row never exists in the first place.
 *
 * **The `topics[2]` match is re-checked after the response arrives.** One measured
 * endpoint rejected a three-topic filter outright, and an endpoint that quietly
 * ignored the third position would return every Transfer of the Asset. Filtering
 * server-side is an optimisation; the client-side check is the guarantee.
 *
 * ## Why this is a poll and not a subscription
 *
 * Every configured Source Chain endpoint is HTTPS, so there is no `eth_subscribe`
 * to hold open; a client would poll underneath regardless. A poll is also the only
 * shape a restart can resume: `chain_cursor.last_processed_block` is the resumption
 * point and gap catch-up is the same code path as steady state, differing only in
 * how far behind it starts (R20.7, R20.8).
 *
 * ## The catch-up window adapts, and the floor is one block
 *
 * `WATCHER_LOG_CHUNK_MAX` (default 2000) is where the window starts, not where it
 * stays. Measured `eth_getLogs` caps across the configured endpoints ranged from
 * 10,000 blocks down to a hard 50, so the window halves on any range or
 * result-volume rejection, never narrows below `WATCHER_LOG_CHUNK_MIN`, and widens
 * again after a clean pass. The cursor advances only over ranges that actually came
 * back, so a narrowed window costs round trips and never coverage.
 *
 * ## The transaction index at observation time is a claim, not a proof
 *
 * A replay key packs `(chainKey, blockHeight, txIndex, logIndex)`, so it cannot be
 * computed without a transaction index — and the only index available at
 * observation is the one the RPC response asserts. It is used, because the identity
 * has to exist before attestation does, and because the alternative is no identity
 * at all. What follows from that is a duty on the proof path rather than here: the
 * *proven* index from `calculateTxIndex` is written to `observed_settlement.tx_index`
 * when proof material arrives, and a disagreement with the index packed into the
 * replay key means the claim was wrong. That is why the column is null until then
 * and is not filled from the log.
 *
 * Requirements: 15.1, 20.1, 20.6, 20.7, 20.8
 */

import { Interface, type BlockTag, type JsonRpcProvider } from "ethers";

import {
  EVENT_TOPIC0,
  causeOf,
  err,
  ok,
  packReplayKey,
  toChainKey,
  wrapSync,
  type ChainKey,
  type EventName,
  type Result,
  type TabError,
} from "@tabai/shared";

import {
  candidateEmittersFor,
  type CandidateAddress,
  type WatcherConfig,
  type WatcherEnv,
} from "./config.js";
import type { CollectionKindName } from "./db/schema.js";

/**
 * `IServiceRegistry.EmitterKind` **by ordinal**, and the zero value is `NONE`.
 *
 * The offset matters and was found the hard way: a two-entry table mapping 0 to
 * `Asset` reads the live registry exactly one place out. Against the deployed
 * registry that turned Sepolia USDC — kind 1, an Asset — into a settlement contract
 * and made the Watcher wait for `TabSettled` on a token that only ever emits
 * `Transfer`, while the real settlement contract came back as kind 2 and fell off the
 * end of the table entirely. Both mistakes are silent: the wrong topic simply matches
 * nothing, so the Watcher would have looked healthy and observed nothing forever.
 */
export const EMITTER_KINDS = ["NONE", "ASSET", "SETTLEMENT_CONTRACT"] as const;

/** An emitter kind as the registry reports it, `NONE` included. */
export type EmitterKindName = (typeof EMITTER_KINDS)[number];

/** The kinds that name a Settlement signature. `NONE` names none, by design. */
export type SettlementEmitterKind = Exclude<EmitterKindName, "NONE">;

/** The event each settlement-bearing emitter kind is recognised through. */
export const EVENT_BY_EMITTER_KIND: Readonly<Record<SettlementEmitterKind, EventName>> = {
  ASSET: "Transfer",
  SETTLEMENT_CONTRACT: "TabSettled",
};

/** `ServiceRegistry.emitterFor` as decoded. */
export interface EmitterResolution {
  readonly kind: EmitterKindName;
  readonly asset: string;
  readonly authorised: boolean;
}

/** `ServiceRegistry.collectionFor` as decoded. */
export interface CollectionResolution {
  readonly serviceId: string;
  readonly asset: string;
  readonly chainKey: bigint;
  readonly exists: boolean;
  readonly kind: CollectionKindName;
}

/**
 * The registry surface observation depends on, narrow enough that a test can
 * supply a stand-in without a network.
 */
export interface ServiceRegistryReader {
  emitterFor(chainKey: bigint, emitter: string): Promise<Result<EmitterResolution>>;
  collectionFor(chainKey: bigint, collection: string): Promise<Result<CollectionResolution>>;
}

/**
 * The two reads, with component order matching `IServiceRegistry` exactly. Field
 * order is wire order and decoding below is positional, so a reordered field would
 * still compile and silently mis-decode.
 */
export const SERVICE_REGISTRY_ABI = [
  {
    type: "function",
    name: "emitterFor",
    stateMutability: "view",
    inputs: [
      { name: "chainKey", type: "uint64" },
      { name: "emitter", type: "address" },
    ],
    outputs: [
      {
        name: "record",
        type: "tuple",
        components: [
          { name: "kind", type: "uint8" },
          { name: "asset", type: "address" },
          { name: "authorised", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "collectionFor",
    stateMutability: "view",
    inputs: [
      { name: "chainKey", type: "uint64" },
      { name: "collection", type: "address" },
    ],
    outputs: [
      {
        name: "record",
        type: "tuple",
        components: [
          { name: "serviceId", type: "bytes32" },
          { name: "asset", type: "address" },
          { name: "chainKey", type: "uint64" },
          { name: "exists", type: "bool" },
          { name: "kind", type: "uint8" },
        ],
      },
    ],
  },
] as const;

function registryError(method: string, error: unknown): TabError {
  return {
    category: "UPSTREAM",
    code: "SERVICE_REGISTRY_READ_FAILED",
    message: `the ServiceRegistry did not answer \`${method}\``,
    retryable: true,
    cause: causeOf(error),
  };
}

function registryDecodeError(method: string, detail: string): TabError {
  return {
    category: "CHAIN",
    code: "SERVICE_REGISTRY_DECODE_FAILED",
    message: `\`${method}\` returned a shape this ABI cannot read: ${detail}`,
    retryable: false,
  };
}

/**
 * Reads the registry through `ethers` at one pinned block tag.
 *
 * The tag is pinned for the same reason every ChainInfo read is: Creditcoin
 * `latest` runs ahead of `finalized`, and a registration that exists at one tag and
 * not the other would make the watched set depend on which read landed first.
 */
export function createServiceRegistryReader(
  provider: JsonRpcProvider,
  address: string,
  blockTag: BlockTag,
): ServiceRegistryReader {
  const iface = new Interface(SERVICE_REGISTRY_ABI);

  const call = async (name: string, args: readonly unknown[]): Promise<Result<readonly unknown[]>> => {
    let returnData: string;
    try {
      returnData = await provider.call({
        to: address,
        data: iface.encodeFunctionData(name, args),
        blockTag,
      });
    } catch (error) {
      return err(registryError(name, error));
    }
    try {
      return ok(iface.decodeFunctionResult(name, returnData).toArray());
    } catch (error) {
      return err(registryDecodeError(name, causeOf(error).message));
    }
  };

  return {
    async emitterFor(chainKey: bigint, emitter: string): Promise<Result<EmitterResolution>> {
      const method = "emitterFor";
      const outputs = await call(method, [chainKey, emitter]);
      if (!outputs.ok) return err(outputs.error);
      const raw = outputs.value[0];
      if (!Array.isArray(raw) || raw.length < 3) {
        return err(registryDecodeError(method, "the result is not a 3-field tuple"));
      }
      // Indexed, not guessed: `EmitterKind` counts from `None`, so an ordinal off
      // the end of this table means the enumeration has grown and this build cannot
      // say what the emitter is. Saying so is safer than defaulting to a kind.
      const kind = EMITTER_KINDS[Number(raw[0])];
      const asset = raw[1];
      const authorised = raw[2];
      if (kind === undefined) {
        return err(
          registryDecodeError(
            method,
            `kind ordinal ${String(raw[0])} is outside the EmitterKind enumeration this build knows (${EMITTER_KINDS.join(", ")})`,
          ),
        );
      }
      if (typeof asset !== "string" || typeof authorised !== "boolean") {
        return err(registryDecodeError(method, "a field carries the wrong type"));
      }
      return ok({ kind, asset: asset.toLowerCase(), authorised });
    },

    async collectionFor(chainKey: bigint, collection: string): Promise<Result<CollectionResolution>> {
      const method = "collectionFor";
      const outputs = await call(method, [chainKey, collection]);
      if (!outputs.ok) return err(outputs.error);
      const raw = outputs.value[0];
      if (!Array.isArray(raw) || raw.length < 5) {
        return err(registryDecodeError(method, "the result is not a 5-field tuple"));
      }
      const serviceId = raw[0];
      const asset = raw[1];
      const recordChainKey = raw[2];
      const exists = raw[3];
      const kind = Number(raw[4]) === 1 ? "BOND" : "TAB";
      if (
        typeof serviceId !== "string" ||
        typeof asset !== "string" ||
        typeof recordChainKey !== "bigint" ||
        typeof exists !== "boolean"
      ) {
        return err(registryDecodeError(method, "a field carries the wrong type"));
      }
      return ok({
        serviceId,
        asset: asset.toLowerCase(),
        chainKey: recordChainKey,
        exists,
        kind,
      });
    },
  };
}

/** Why an offered address is not watched. */
export type CandidateRejection =
  /** the registry does not authorise this `(chainKey, emitter)` pair */
  | "EMITTER_NOT_AUTHORISED"
  /** authorised, but with kind `None`, which matches no Settlement signature */
  | "EMITTER_KIND_NONE"
  /** the emitter read itself failed; other candidates are unaffected */
  | "EMITTER_UNREADABLE"
  /** no Service has claimed this Collection Address on this chain */
  | "COLLECTION_NOT_REGISTERED"
  /** the collection read itself failed */
  | "COLLECTION_UNREADABLE"
  /** the record answers for a different chainKey than the one asked about */
  | "COLLECTION_CHAIN_KEY_MISMATCH"
  /** emitter and collection are registered but denominate different Assets */
  | "ASSET_DISAGREEMENT";

/** One `(chainKey, emitter, collection)` triple the Watcher will read logs for. */
export interface WatchTarget {
  readonly chainKey: ChainKey;
  readonly emitter: string;
  readonly emitterKind: SettlementEmitterKind;
  readonly eventName: EventName;
  /** `topics[0]` of the event this emitter may produce. */
  readonly topic0: string;
  readonly collection: string;
  /** `topics[2]` as a 32-byte word, which is what the filter matches on. */
  readonly collectionTopic: string;
  /**
   * Whether Settlements here reduce an Open Tab or fund stake. A `BOND` deposit is
   * observed and persisted like any other Settlement and is never provisionally
   * cleared: it pays no tab down, so there is no headroom to restore.
   */
  readonly collectionKind: CollectionKindName;
  readonly asset: string;
  readonly serviceId: string;
}

/** An offered address that will not be watched, and why. */
export interface UnresolvedCandidate {
  readonly chainKey: ChainKey;
  readonly address: string;
  /** The environment variable that offered it, so the report is actionable. */
  readonly source: keyof WatcherEnv;
  readonly reason: CandidateRejection;
  readonly detail: string;
}

export interface TargetResolution {
  readonly resolvedAt: Date;
  readonly targets: readonly WatchTarget[];
  readonly unresolved: readonly UnresolvedCandidate[];
}

/** `topics[2]` for an address: left-padded to a 32-byte word, lower case. */
export function addressTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

/**
 * Resolves every offered address against the registry and returns the targets.
 *
 * Fails as a whole for nothing: a candidate that cannot be read is an unresolved
 * entry, so one unreachable read never costs the other targets. An empty target
 * list is a legitimate answer and means nothing is registered yet.
 *
 * @param chainKeys the chains discovery decided to monitor, in its order
 */
export async function resolveWatchTargets(
  reader: ServiceRegistryReader,
  config: WatcherConfig,
  chainKeys: readonly ChainKey[],
  now: Date = new Date(),
): Promise<Result<TargetResolution>> {
  const targets: WatchTarget[] = [];
  const unresolved: UnresolvedCandidate[] = [];

  for (const chainKey of chainKeys) {
    const emitters: {
      candidate: CandidateAddress;
      kind: SettlementEmitterKind;
      asset: string;
    }[] = [];
    for (const candidate of candidateEmittersFor(config, chainKey)) {
      const resolution = await reader.emitterFor(BigInt(chainKey), candidate.address);
      if (!resolution.ok) {
        unresolved.push({
          chainKey,
          address: candidate.address,
          source: candidate.source,
          reason: "EMITTER_UNREADABLE",
          detail: `the emitter record for ${candidate.address} on chainKey ${chainKey} could not be read: ${resolution.error.message}`,
        });
        continue;
      }
      if (!resolution.value.authorised) {
        unresolved.push({
          chainKey,
          address: candidate.address,
          source: candidate.source,
          reason: "EMITTER_NOT_AUTHORISED",
          detail: `${candidate.source} offers ${candidate.address}, which the registry does not authorise as an emitter on chainKey ${chainKey}`,
        });
        continue;
      }
      const kind = resolution.value.kind;
      if (kind === "NONE") {
        unresolved.push({
          chainKey,
          address: candidate.address,
          source: candidate.source,
          reason: "EMITTER_KIND_NONE",
          detail: `${candidate.address} is authorised on chainKey ${chainKey} with kind None, which names no Settlement signature, so there is no event to watch for`,
        });
        continue;
      }
      emitters.push({ candidate, kind, asset: resolution.value.asset });
    }

    for (const candidate of config.observation.candidateCollections) {
      const collection = await reader.collectionFor(BigInt(chainKey), candidate.address);
      if (!collection.ok) {
        unresolved.push({
          chainKey,
          address: candidate.address,
          source: candidate.source,
          reason: "COLLECTION_UNREADABLE",
          detail: `the collection record for ${candidate.address} on chainKey ${chainKey} could not be read: ${collection.error.message}`,
        });
        continue;
      }
      if (!collection.value.exists) {
        unresolved.push({
          chainKey,
          address: candidate.address,
          source: candidate.source,
          reason: "COLLECTION_NOT_REGISTERED",
          detail: `no Service has claimed ${candidate.address} as a Collection Address on chainKey ${chainKey}`,
        });
        continue;
      }
      if (collection.value.chainKey !== BigInt(chainKey)) {
        unresolved.push({
          chainKey,
          address: candidate.address,
          source: candidate.source,
          reason: "COLLECTION_CHAIN_KEY_MISMATCH",
          detail: `the record for ${candidate.address} answers for chainKey ${collection.value.chainKey} rather than the chainKey ${chainKey} it was read at`,
        });
        continue;
      }

      const matching = emitters.filter((entry) => entry.asset === collection.value.asset);
      if (matching.length === 0) {
        unresolved.push({
          chainKey,
          address: candidate.address,
          source: candidate.source,
          reason: "ASSET_DISAGREEMENT",
          detail: `${candidate.address} collects ${collection.value.asset} on chainKey ${chainKey}, and no authorised emitter there denominates that Asset`,
        });
        continue;
      }

      for (const entry of matching) {
        const eventName = EVENT_BY_EMITTER_KIND[entry.kind];
        targets.push({
          chainKey,
          emitter: entry.candidate.address,
          emitterKind: entry.kind,
          eventName,
          topic0: EVENT_TOPIC0[eventName],
          collection: candidate.address,
          collectionTopic: addressTopic(candidate.address),
          collectionKind: collection.value.kind,
          asset: collection.value.asset,
          serviceId: collection.value.serviceId,
        });
      }
    }
  }

  return ok({ resolvedAt: now, targets, unresolved });
}

/** One human-readable line, so an unresolved candidate is stated rather than inferred. */
export function describeTargets(resolution: TargetResolution): string {
  const watched =
    resolution.targets.length === 0
      ? "watching nothing: no registered emitter and Collection Address pair resolved"
      : `watching ${resolution.targets
          .map(
            (target) =>
              `${target.eventName} on ${target.emitter} to ${target.collection} (chainKey ${target.chainKey}, ${target.collectionKind})`,
          )
          .join(", ")}`;
  const rejected =
    resolution.unresolved.length === 0
      ? ""
      : `; unresolved ${resolution.unresolved
          .map((entry) => `${entry.address} on chainKey ${entry.chainKey} (${entry.reason})`)
          .join(", ")}`;
  return `${watched}${rejected}`;
}

/** The `eth_getLogs` filter for one target. `null` leaves `topics[1]` unconstrained. */
export interface LogFilter {
  readonly address: string;
  readonly topics: readonly [string, null, string];
}

/** The filter shape both Settlement surfaces share. */
export function logFilterFor(target: WatchTarget): LogFilter {
  return { address: target.emitter, topics: [target.topic0, null, target.collectionTopic] };
}

/**
 * The fields of an RPC log this module reads. Declared rather than taken from
 * `ethers` so a test can build one as a plain object.
 */
export interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly transactionIndex: number;
  readonly index: number;
}

/** One Settlement, as observed and about to be persisted. */
export interface Observation {
  /** Packed `(chainKey, blockHeight, txIndex, logIndex)`, and the clearing identity. */
  readonly replayKey: string;
  readonly chainKey: ChainKey;
  readonly blockHeight: bigint;
  /**
   * The ordinal of this log **within its own transaction's receipt**, which is what
   * the replay key packs.
   *
   * Not the block-wide `logIndex` the RPC reports, and the two are wildly
   * different: the live binding Settlement carried block-wide 3177 and 3178 for
   * receipt ordinals 0 and 1. `TabAscBase` sweeps `receipt.receiptLogs` and uses
   * the loop counter, so a Watcher packing the block-wide value mints a replay key
   * the chain will never agree with, and every downstream identity check then
   * fails silently. Measured: a submission for a transaction the Watcher had
   * recorded at ordinal 3195 was refused `AlreadyClaimed` naming ordinal 0.
   */
  readonly logIndex: bigint;
  /** The block-wide ordinal the RPC reported. Provenance only; never in a key. */
  readonly blockLogIndex: bigint;
  /**
   * The transaction index the RPC asserted, packed into the replay key. Kept
   * separately so the proof path can compare it against the proven index; it is
   * deliberately not written to `observed_settlement.tx_index`, which holds the
   * proven value only.
   */
  readonly observedTxIndex: bigint;
  readonly sourceTxHash: string;
  /** Digest of the block the log was read from, for the reorg check (D8). */
  readonly blockDigest: string;
  readonly emitter: string;
  readonly eventName: EventName;
  readonly asset: string;
  /** From `topics[1]`. Never the transaction sender. */
  readonly payer: string;
  readonly collection: string;
  readonly collectionKind: CollectionKindName;
  readonly serviceId: string;
  readonly amount: bigint;
}

/** Topics each surface must carry, `topics[0]` included. */
const TOPIC_COUNT: Readonly<Record<EventName, number>> = { Transfer: 3, TabSettled: 4 };

const WORD = /^0x[0-9a-fA-F]{64}$/;

function malformed(detail: string, log: RawLog): TabError {
  return {
    category: "VALIDATION",
    code: "MALFORMED_SETTLEMENT_LOG",
    message: `a log from ${log.address} in block ${log.blockNumber} was skipped: ${detail}`,
    retryable: false,
    details: { emitter: log.address, blockNumber: log.blockNumber, logIndex: log.index },
  };
}

/** `topics[1]`, which is a 32-byte word, read back as a 20-byte address. */
function addressFromTopic(topic: string): string {
  return `0x${topic.slice(26).toLowerCase()}`;
}

/**
 * Decodes one log into an {@link Observation}, or names what was wrong with it.
 *
 * Every check here has a counterpart in `SettlementVerifier`, and the point of
 * duplicating them is that a log failing any of them must never reach persistence:
 * a row the contracts would refuse is a row that would sit in the pipeline forever.
 * A malformed log is skipped and the scan carries on, exactly as the on-chain sweep
 * skips an unrecognised log rather than reverting.
 */
export function observationFrom(
  target: WatchTarget,
  log: RawLog,
  perReceiptLogIndex: number,
): Result<Observation> {
  if (log.address.toLowerCase() !== target.emitter.toLowerCase()) {
    return err(malformed(`it came from ${log.address} rather than the target emitter ${target.emitter}`, log));
  }

  const expectedTopics = TOPIC_COUNT[target.eventName];
  if (log.topics.length !== expectedTopics) {
    return err(
      malformed(`${target.eventName} carries ${expectedTopics} topics, and this log carries ${log.topics.length}`, log),
    );
  }

  const [topic0, payerTopic, collectionTopic] = log.topics;
  if (topic0 === undefined || topic0.toLowerCase() !== target.topic0.toLowerCase()) {
    return err(malformed(`topics[0] is ${String(topic0)}, not the ${target.eventName} signature`, log));
  }
  if (payerTopic === undefined || !WORD.test(payerTopic)) {
    return err(malformed("topics[1] is not a 32-byte word, so no payer can be read from it", log));
  }
  // Re-checked rather than trusted: one measured endpoint rejects a three-topic
  // filter outright, and one that ignored the third position would return every
  // Transfer of the Asset.
  if (collectionTopic === undefined || collectionTopic.toLowerCase() !== target.collectionTopic) {
    return err(
      malformed(
        `topics[2] is ${String(collectionTopic)}, which is not the Collection Address ${target.collection} this filter asked for`,
        log,
      ),
    );
  }
  if (!WORD.test(log.data)) {
    return err(malformed(`the amount word is ${log.data.length - 2} hex digits rather than 64`, log));
  }

  const chainKey = toChainKey(target.chainKey);
  if (chainKey === undefined) {
    return err(malformed(`chainKey ${target.chainKey} is not one this network attests`, log));
  }

  const blockHeight = BigInt(log.blockNumber);
  const observedTxIndex = BigInt(log.transactionIndex);
  if (!Number.isInteger(perReceiptLogIndex) || perReceiptLogIndex < 0) {
    return err(
      malformed(
        `its ordinal within its own receipt could not be resolved, and the block-wide index ${log.index} is not a substitute`,
        log,
      ),
    );
  }
  const logIndex = BigInt(perReceiptLogIndex);

  // `packReplayKey` throws a `RangeError` naming the field that overflowed, which
  // is a better report than any check written here would produce.
  const replayKey = wrapSync(
    () => packReplayKey({ chainKey: BigInt(chainKey), blockHeight, txIndex: observedTxIndex, logIndex }),
    (error) => malformed(`its identity does not pack into a replay key: ${causeOf(error).message}`, log),
  );
  if (!replayKey.ok) return err(replayKey.error);

  return ok({
    replayKey: replayKey.value,
    chainKey,
    blockHeight,
    logIndex,
    blockLogIndex: BigInt(log.index),
    observedTxIndex,
    sourceTxHash: log.transactionHash.toLowerCase(),
    blockDigest: log.blockHash.toLowerCase(),
    emitter: target.emitter,
    eventName: target.eventName,
    asset: target.asset,
    payer: addressFromTopic(payerTopic),
    collection: target.collection,
    collectionKind: target.collectionKind,
    serviceId: target.serviceId,
    amount: BigInt(log.data),
  });
}

// ---------------------------------------------------------------- catch-up scanning

/**
 * How an endpoint says "that range was too wide".
 *
 * There is no standard error for it, and the endpoints measured here do not even
 * agree on what kind of error it is: one calls it a routing failure, one calls it an
 * archive-access problem, one states a block range, and the statuses range across 400
 * and 403. So this is a list of what was actually observed rather than a guess at a
 * convention.
 *
 * Anything unmatched is an ordinary upstream failure, not a hint to narrow. The
 * asymmetry is deliberate: misreading a range refusal as fatal stops a chain dead,
 * while misreading a fatal error as a range refusal costs a bounded run of halvings
 * down to the floor and then stops anyway with a named error.
 */
export const RANGE_REJECTION_PATTERNS: readonly RegExp[] = [
  // Measured against the configured Mainnet endpoints with the observation filter.
  // None of the three phrases the word "range" the same way, and one does not phrase
  // it at all:
  //   drpc       serves 125 blocks, refuses 250 with "Can't route your request to
  //              suitable provider" behind HTTP 400 — no mention of width whatever
  //   publicnode serves 50, refuses 125 with -32602 "Archive requests require a
  //              personal token", because a wider window reaches past free retention
  //   blastapi   serves 10, refuses 50 with -32600 "up to a 10 block range"
  // Kept as a narrowing signal with a caveat measured minutes apart: drpc served 125
  // blocks and refused 250 with this message, then later refused a **one-block**
  // request with the identical message. So it conflates "too wide" with "no upstream
  // right now", and narrowing on it is a bet that costs at most ten halvings before
  // the floor names the failure. The real fix is endpoint rotation, which is task
  // 14.4's; until then a bounded run of halvings is preferred to stopping the chain on
  // an error that sometimes does mean the window.
  /can't route your request/i,
  /archive request/i,
  /up to a \d+ block/i,
  /limited to \d+ ?- ?\d+ blocks?/i,
  /block range/i,
  /range .*too (large|wide)/i,
  /more than \d+ results?/i,
  /query returned more than/i,
  /response size exceeded/i,
  /too many (results|logs)/i,
  /exceeds? the limit/i,
  /log(s)? limit/i,
  /request entity too large/i,
  // 413 only. A bare 400 or 403 is any refusal at all, and the two endpoints that
  // answer with those statuses are matched by name above, so widening the net to the
  // status codes would classify unrelated faults as width problems for no gain.
  /\b413\b/,
];

/** True when the failure is the endpoint refusing the width of the request. */
export function isRangeRejection(error: unknown): boolean {
  const { message } = causeOf(error);
  const text = typeof error === "object" && error !== null && "shortMessage" in error
    ? `${message} ${String((error as { shortMessage?: unknown }).shortMessage ?? "")}`
    : message;
  return RANGE_REJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/** Halves the window, never below `min`. */
export function shrinkWindow(size: number, min: number): number {
  return Math.max(min, Math.floor(size / 2));
}

/** Doubles the window, never above `max`. */
export function growWindow(size: number, max: number): number {
  return Math.min(max, size * 2);
}

/** An inclusive block range to request in one call. */
export interface BlockChunk {
  readonly from: bigint;
  readonly to: bigint;
}

/** The next chunk of at most `size` blocks, or `undefined` when nothing is left. */
export function chunkFor(from: bigint, head: bigint, size: number): BlockChunk | undefined {
  if (from > head || size < 1) return undefined;
  const last = from + BigInt(size) - 1n;
  return { from, to: last > head ? head : last };
}

/**
 * The chunks a fixed window covers between a cursor and a head, exclusive of the
 * cursor and inclusive of the head.
 *
 * This is the shape of the gap catch-up R20.8 requires, and it is separated out
 * because it is worth being able to state and test the plan without a network. The
 * live scan starts from this plan and narrows as endpoints refuse, so the plan is a
 * best case rather than a schedule.
 */
export function planCatchUp(
  lastProcessedBlock: bigint,
  head: bigint,
  size: number,
): readonly BlockChunk[] {
  const chunks: BlockChunk[] = [];
  let from = lastProcessedBlock + 1n;
  for (;;) {
    const chunk = chunkFor(from, head, size);
    if (chunk === undefined) return chunks;
    chunks.push(chunk);
    from = chunk.to + 1n;
  }
}

/**
 * Resolves a log's ordinal within its own transaction's receipt.
 *
 * `eth_getLogs` reports a block-wide `logIndex` and the replay key needs the
 * per-receipt one, so the two have to be joined and the receipt is the only place
 * that join exists. One call per observed transaction, cached per chunk, and only
 * for transactions that actually matched a filter, so a quiet chain pays nothing.
 */
export interface ReceiptLogReader {
  /** Block-wide log indexes of one transaction's own logs, in receipt order. */
  blockLogIndexes(txHash: string): Promise<Result<readonly number[]>>;
}

/** Reads receipts through `ethers`, one transaction at a time. */
export function createReceiptLogReader(provider: JsonRpcProvider): ReceiptLogReader {
  return {
    async blockLogIndexes(txHash: string): Promise<Result<readonly number[]>> {
      try {
        const raw: unknown = await provider.send("eth_getTransactionReceipt", [txHash]);
        if (raw === null || typeof raw !== "object") {
          return err({
            category: "UPSTREAM",
            code: "RECEIPT_MISSING",
            message: `the receipt of ${txHash} could not be read, so no log ordinal can be resolved`,
            retryable: true,
          });
        }
        const logs = (raw as { logs?: unknown }).logs;
        if (!Array.isArray(logs)) {
          return err({
            category: "UPSTREAM",
            code: "RECEIPT_SHAPE",
            message: `the receipt of ${txHash} carries no log array`,
            retryable: true,
          });
        }
        return ok(logs.map((entry) => Number((entry as { logIndex?: string }).logIndex)));
      } catch (error) {
        return err({
          category: "UPSTREAM",
          code: "RECEIPT_READ_FAILED",
          message: `the receipt of ${txHash} could not be read`,
          retryable: true,
          cause: causeOf(error),
        });
      }
    },
  };
}

/**
 * The ordinal of a block-wide log index within a receipt's own logs.
 *
 * `-1` when the log is not in the receipt at all, which means the two reads
 * disagree and the observation is refused rather than guessed at.
 */
export const receiptOrdinalOf = (blockLogIndexes: readonly number[], blockLogIndex: number): number =>
  blockLogIndexes.indexOf(blockLogIndex);

/** The log read a scan needs, narrow enough to fake in a test. */
export interface LogReader {
  logs(filter: LogFilter, from: bigint, to: bigint): Promise<Result<readonly RawLog[]>>;
}

/** Reads logs through `ethers`, with the range carried as hex block numbers. */
export function createSourceLogReader(provider: JsonRpcProvider): LogReader {
  return {
    async logs(filter: LogFilter, from: bigint, to: bigint): Promise<Result<readonly RawLog[]>> {
      try {
        const raw: unknown = await provider.send("eth_getLogs", [
          {
            address: filter.address,
            topics: filter.topics,
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
          },
        ]);
        if (!Array.isArray(raw)) {
          return err({
            category: "UPSTREAM",
            code: "GET_LOGS_SHAPE",
            message: "eth_getLogs did not return an array",
            retryable: true,
          });
        }
        return ok(
          raw.map((entry) => {
            const log = entry as Record<string, string | undefined>;
            return {
              address: String(log.address),
              topics: (entry as { topics?: string[] }).topics ?? [],
              data: String(log.data ?? "0x"),
              blockNumber: Number(log.blockNumber),
              blockHash: String(log.blockHash),
              transactionHash: String(log.transactionHash),
              transactionIndex: Number(log.transactionIndex),
              index: Number(log.logIndex),
            } satisfies RawLog;
          }),
        );
      } catch (error) {
        return err({
          category: "UPSTREAM",
          code: isRangeRejection(error) ? "GET_LOGS_RANGE_REFUSED" : "GET_LOGS_FAILED",
          message: `eth_getLogs over blocks ${from} to ${to} failed`,
          retryable: true,
          cause: causeOf(error),
        });
      }
    },
  };
}

/** What one chunk produced, handed to the caller to persist. */
export interface ChunkResult {
  readonly chunk: BlockChunk;
  readonly observations: readonly Observation[];
  /** Logs the filter returned that no target could decode. */
  readonly malformed: readonly TabError[];
}

/**
 * The pair of readers a scan works through, so a rotation moves both.
 *
 * Both are bound to one provider, and therefore to one endpoint. Rotating the log
 * reader without the receipt reader would leave every ordinal lookup pointed at the
 * endpoint the scan just gave up on, which is the failure that made the rotation
 * necessary in the first place.
 */
export interface ScanReaders {
  readonly reader: LogReader;
  readonly receipts: ReceiptLogReader;
}

export interface ScanRequest {
  readonly chainKey: ChainKey;
  readonly targets: readonly WatchTarget[];
  /** `chain_cursor.last_processed_block`; scanning starts at the block after it. */
  readonly lastProcessedBlock: bigint;
  /** Current Source Chain head. */
  readonly head: bigint;
  readonly window: { readonly max: number; readonly min: number };
  readonly reader: LogReader;
  /**
   * Moves to the next configured endpoint and returns readers bound to it, or
   * `undefined` when there is no other endpoint to move to (R20.11).
   *
   * Optional, and its absence is what keeps a single-endpoint scan exactly as it
   * was: without it a refusal at the floor still ends the scan. Supplied, it is the
   * difference between an endpoint outage costing a pass and costing a round trip.
   */
  readonly rotate?: () => Promise<ScanReaders | undefined>;
  /**
   * Records a failure that was not a width refusal, resolving true once R20.11's
   * threshold of consecutive failures says the endpoint should be abandoned.
   *
   * It must count without moving; the scan calls `rotate` itself when this says so,
   * because it has to rebuild its readers at that exact moment. Absent, every such
   * failure is treated as grounds to move on immediately, which is what a scan with
   * no rotation wired has always effectively done by stopping.
   */
  readonly onFailure?: () => Promise<boolean>;
  /**
   * How many endpoints the rotation can reach, used only to know when a full cycle
   * has been made without progress. `rotate` wraps around rather than running out,
   * so without this the scan could circle a set of dead endpoints forever.
   */
  readonly endpointCount?: number;
  /**
   * Resolves each observed log's ordinal within its own receipt, which is what the
   * replay key packs. Required: without it every key would disagree with the chain.
   */
  readonly receipts: ReceiptLogReader;
  /**
   * Persists one chunk's observations **and** advances the cursor, as one step.
   *
   * The two belong together: a cursor advanced past a block whose observations were
   * not written is a Settlement lost forever, and R20.6 puts persistence before
   * anything else happening. So the scan hands over the chunk and stops if the
   * handover fails, leaving the cursor where it was for the next pass to re-read.
   */
  readonly commit: (result: ChunkResult) => Promise<Result<number>>;
}

export interface ScanReport {
  readonly chainKey: ChainKey;
  readonly fromBlock: bigint;
  readonly head: bigint;
  /** Highest block whose observations are committed. */
  readonly lastProcessedBlock: bigint;
  readonly chunksCommitted: number;
  readonly logsSeen: number;
  readonly observationsPersisted: number;
  readonly malformedSkipped: number;
  /** Window sizes actually used, in order, so a narrowing endpoint is visible. */
  readonly windowSizes: readonly number[];
  readonly rangeRejections: number;
  /** How many times the scan moved to another endpoint, so a rotation is visible too. */
  readonly rotations: number;
  /**
   * Why the scan stopped short of the head, when it did. Progress already committed
   * stands: a scan is a progress-making operation, so a failure half way through
   * reports what it managed rather than discarding it.
   */
  readonly stopped: TabError | undefined;
}

/**
 * Drops an observation that is another observation's mechanical side effect.
 *
 * **The Watcher's half of task 10.12, and it is needed even though the contract is
 * fixed.** `TabSettlement.settle` pulls the Asset with `safeTransferFrom`, emitting an
 * ERC-20 `Transfer` to the Collection Address, and then emits its own `TabSettled`
 * naming the same payer, recipient, and amount. Those two logs come from two different
 * watch targets, the Asset and the settlement contract, so the scan sees both and
 * would write two observations for one payment.
 *
 * The `SettlementVerifier` now ingests only one of them, which fixes the credit. It
 * does not fix this side: two observations become **two Provisional Clearings**, each
 * pledging the Service's Bond, and only one of them can ever be confirmed by a
 * Verified Settlement. The other reaches its deadline and slashes the Service's stake
 * for a payment that was made correctly. So the Watcher has to apply the same rule the
 * contract applies, for the same reason and on the same triple.
 *
 * Matching is by count rather than existence, exactly as in the contract: a `Transfer`
 * is dropped only while the number of matching `Transfer` logs at or before it does not
 * exceed the number of matching `TabSettled` logs in the same Source Chain transaction.
 * A `settleBatch` of two identical instructions therefore keeps two observations, and a
 * genuine direct `Transfer` sharing a transaction with an identical `settle` keeps one.
 *
 * @param observations Every observation decoded from one chunk, in any order.
 * @returns The observations worth persisting, in the order they were given.
 */
export function dropSupersededTransfers(
  observations: readonly Observation[],
): readonly Observation[] {
  const settledKey = (o: Observation): string =>
    `${o.sourceTxHash}|${o.payer}|${o.collection}|${o.amount}`;

  const statements = new Map<string, number>();
  for (const o of observations) {
    if (o.eventName !== "TabSettled") continue;
    const key = settledKey(o);
    statements.set(key, (statements.get(key) ?? 0) + 1);
  }
  if (statements.size === 0) return observations;

  const seen = new Map<string, number>();
  const kept: Observation[] = [];
  // Receipt order, so "at or before" means what it says. Two logs of one transaction
  // are ordered by their ordinal, which is what the replay key packs.
  for (const o of [...observations].sort(inChainOrder)) {
    if (o.eventName !== "Transfer") {
      kept.push(o);
      continue;
    }
    const key = settledKey(o);
    const covered = statements.get(key) ?? 0;
    const before = seen.get(key) ?? 0;
    seen.set(key, before + 1);
    if (before < covered) continue;
    kept.push(o);
  }
  return kept;
}

/** Deterministic order: block, then transaction, then log position within it. */
function inChainOrder(left: Observation, right: Observation): number {
  if (left.blockHeight !== right.blockHeight) return left.blockHeight < right.blockHeight ? -1 : 1;
  if (left.observedTxIndex !== right.observedTxIndex) {
    return left.observedTxIndex < right.observedTxIndex ? -1 : 1;
  }
  return left.logIndex < right.logIndex ? -1 : left.logIndex > right.logIndex ? 1 : 0;
}

/**
 * Scans from the cursor to the head, committing each chunk before moving on.
 *
 * The window starts at `window.max` and halves on any range or volume rejection,
 * down to `window.min`. After a clean chunk it doubles again, so a temporary result
 * spike costs round trips rather than permanently narrowing the scan.
 *
 * ## Narrowing answers one failure and rotation answers the other
 *
 * A width refusal above the floor is answered by narrowing, because the endpoint is
 * saying the range is too wide and a narrower one is exactly what it asked for. Two
 * other failures are not about width at all, and narrowing cannot fix either:
 *
 * - **A refusal still standing at the one-block floor.** An endpoint that will not
 *   serve a single block cannot be narrowed into working. Measured on `drpc`, which
 *   served a 125-block window, refused 250, and minutes later refused a **one-block**
 *   request with the identical `Can't route your request to suitable provider`
 *   message. The same words carry "too wide" and "not serving right now", so the
 *   floor is where the scan stops believing it is a width problem.
 * - **A failure that was never a width refusal**, such as a transport error or an
 *   endpoint answering an unusable shape.
 *
 * Both move to the next configured endpoint and retry the same chunk with the window
 * reset, because the new endpoint's limits have nothing to do with the old one's. The
 * difference is how quickly: a plain failure goes through `rotation.failed()` and so
 * respects R20.11's threshold of three consecutive failures, while a refusal at the
 * floor calls `moveOn()` outright, since counting to three against an endpoint that
 * cannot serve one block only wastes three round trips.
 *
 * **A full cycle without progress ends the scan.** The rotation wraps rather than
 * running out, so `endpointCount` bounds it: once every endpoint has been tried since
 * the last committed chunk the scan stops with `ALL_ENDPOINTS_REFUSED` and names the
 * count, rather than circling a set of dead endpoints forever. A committed chunk
 * clears the count, so a long scan may legitimately rotate many times.
 *
 * Without a `rotate` in the request none of this engages and the scan behaves exactly
 * as it did before: a refusal at the floor is the end.
 */
export async function scanChain(request: ScanRequest): Promise<Result<ScanReport>> {
  const { chainKey, targets, head, window, commit } = request;
  const fromBlock = request.lastProcessedBlock + 1n;
  // Rebound on every rotation, so both reads follow the active endpoint together.
  let reader = request.reader;
  let receipts = request.receipts;
  const endpointCount = Math.max(1, request.endpointCount ?? 1);

  let cursor = request.lastProcessedBlock;
  // Configuration guarantees `min <= max`; the clamp is here so a hand-built
  // request in a test cannot start below its own floor.
  let size = Math.max(window.min, window.max);
  let from = fromBlock;
  let chunksCommitted = 0;
  let logsSeen = 0;
  let observationsPersisted = 0;
  let malformedSkipped = 0;
  let rangeRejections = 0;
  let rotations = 0;
  /** Rotations since the last committed chunk, which is what bounds a dead cycle. */
  let rotationsWithoutProgress = 0;
  const windowSizes: number[] = [];
  /** One receipt read per transaction per scan, however many of its logs match. */
  const receiptOrdinals = new Map<string, readonly number[]>();
  let stopped: TabError | undefined;

  while (from <= head) {
    const chunk = chunkFor(from, head, size);
    if (chunk === undefined) break;

    const observations: Observation[] = [];
    const malformed: TabError[] = [];
    let refusal: { error: TabError; range: boolean } | undefined;

    for (const target of targets) {
      if (target.chainKey !== chainKey) continue;
      const logs = await reader.logs(logFilterFor(target), chunk.from, chunk.to);
      if (!logs.ok) {
        refusal = { error: logs.error, range: logs.error.code === "GET_LOGS_RANGE_REFUSED" };
        break;
      }
      for (const log of logs.value) {
        logsSeen += 1;
        const cached = receiptOrdinals.get(log.transactionHash);
        let indexes = cached;
        if (indexes === undefined) {
          const read = await receipts.blockLogIndexes(log.transactionHash);
          if (!read.ok) {
            // The receipt is the only place the ordinal lives, so without it the
            // row cannot be given an identity the chain will agree with. Reported
            // and skipped rather than stored under a key that can never match.
            malformed.push(read.error);
            continue;
          }
          indexes = read.value;
          receiptOrdinals.set(log.transactionHash, indexes);
        }
        const observation = observationFrom(target, log, receiptOrdinalOf(indexes, log.index));
        if (observation.ok) observations.push(observation.value);
        else malformed.push(observation.error);
      }
    }

    if (refusal !== undefined) {
      /**
       * Moves to the next endpoint and rebinds both readers.
       *
       * Returns the error to stop on, or `undefined` when the scan should retry the
       * same chunk against the endpoint it just moved to.
       */
      const rotateAway = async (atFloor: boolean): Promise<TabError | undefined> => {
        if (request.rotate === undefined) {
          return atFloor
            ? {
                ...refusal.error,
                code: "GET_LOGS_RANGE_REFUSED_AT_FLOOR",
                message: `the endpoint refused a ${size}-block request for chainKey ${chainKey}, which is the configured floor, and no rotation was supplied to move past it`,
              }
            : refusal.error;
        }
        const next = await request.rotate();
        if (next === undefined) {
          return {
            ...refusal.error,
            code: atFloor ? "GET_LOGS_RANGE_REFUSED_AT_FLOOR" : "GET_LOGS_FAILED",
            message: `chainKey ${chainKey} has no other configured endpoint to move to, so the scan stopped at block ${cursor}`,
          };
        }
        reader = next.reader;
        receipts = next.receipts;
        rotations += 1;
        rotationsWithoutProgress += 1;
        // A new endpoint's limits are its own, so the window starts wide again.
        size = Math.max(window.min, window.max);
        if (rotationsWithoutProgress >= endpointCount) {
          return {
            ...refusal.error,
            code: "ALL_ENDPOINTS_REFUSED",
            message: `all ${endpointCount} configured endpoints for chainKey ${chainKey} refused the range at block ${chunk.from}, so the scan stopped at block ${cursor}`,
          };
        }
        return undefined;
      };

      if (refusal.range) {
        rangeRejections += 1;
        if (size > window.min) {
          // The endpoint asked for a narrower range, so give it one.
          size = shrinkWindow(size, window.min);
          continue;
        }
        // Narrowing is exhausted. This is no longer a width problem.
        stopped = await rotateAway(true);
        if (stopped !== undefined) break;
        continue;
      }

      // Never a width refusal, so R20.11's threshold decides when to move on.
      const rotated = request.onFailure === undefined ? true : await request.onFailure();
      if (!rotated) {
        // Below the threshold: the same endpoint gets another attempt, and the
        // count it just took is what bounds this to `threshold` tries.
        continue;
      }
      stopped = await rotateAway(false);
      if (stopped !== undefined) break;
      continue;
    }

    windowSizes.push(size);
    // De-duplicate before persisting, not after: a row written here becomes a Provisional
    // Clearing and pledges the Service's Bond, so a duplicate representation must never
    // reach the store in the first place.
    const persistable = [...dropSupersededTransfers(observations)].sort(inChainOrder);
    const committed = await commit({ chunk, observations: persistable, malformed });
    if (!committed.ok) {
      // The cursor is deliberately left where it was: re-reading a block is free,
      // and skipping one is a Settlement nobody ever proves.
      stopped = committed.error;
      break;
    }

    chunksCommitted += 1;
    observationsPersisted += committed.value;
    malformedSkipped += malformed.length;
    cursor = chunk.to;
    from = chunk.to + 1n;
    size = growWindow(size, window.max);
    // Progress, so the endpoint set has earned a full cycle again. A long scan may
    // legitimately rotate many times; what is not allowed is circling without
    // committing anything.
    rotationsWithoutProgress = 0;
  }

  return ok({
    chainKey,
    fromBlock,
    head,
    lastProcessedBlock: cursor,
    chunksCommitted,
    logsSeen,
    observationsPersisted,
    malformedSkipped,
    windowSizes,
    rangeRejections,
    rotations,
    stopped,
  });
}
