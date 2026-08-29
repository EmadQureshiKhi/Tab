/**
 * Provisional Clearing, and the reorganisation check that keeps it honest.
 *
 * Two writes live here, and they are the only two the Watcher is authorised to make
 * against `TabBook`: `applyProvisionalClearing`, which restores an Agent's headroom
 * against the Service's Bond before any proof exists, and `reportReorg`, which
 * supersedes a Confirmed Clearing whose Source Chain block turned out not to be
 * canonical. Both are gated on `msg.sender == TabBook.watcher`, so both spend real
 * CTC and a mistaken call spends it for nothing.
 *
 * ## What is eligible, and why each exclusion exists
 *
 * A row is offered a clearing only when all of the following hold, and every one of
 * them is a revert avoided rather than a preference:
 *
 * - **`amount > 0`.** `_openClearing` reverts `AmountOutOfRange(0)`. A zero-value
 *   `Transfer` is perfectly legal ERC-20 and does turn up on chain.
 * - **`collectionKind == "TAB"`.** A Settlement to a Bond Collection Address funds
 *   stake; it pays no tab down, so there is no headroom to restore and no clearing
 *   to apply. Observing it is right, clearing it is a category error.
 * - **no clearing exists yet.** `_openClearing` reverts `ClearingAlreadyExists` for
 *   any identity that already carries a record, *including a declined one*. So a
 *   decline is terminal: the identity is spent, and a second attempt is a certain
 *   revert rather than a retry that might succeed once the Bond is topped up.
 * - **the signer is the wired Watcher.** `applyProvisionalClearing` reverts
 *   `NotWatcher` for anyone else, and a reverted transaction still costs gas, so the
 *   address is compared against `WATCHER_ADDRESS` before anything is broadcast.
 *
 * ## The reorg check runs against the Source Chain, and this is a correction
 *
 * Design section 8.11 has the Watcher store the digest it observed for a
 * Settlement's block and, at confirmation, ask
 * `ChainInfo.get_attestation_height_for_digest(chainKey, observedDigest)`, treating
 * `exists: false` as the reorg signal. That primitive does round-trip — feeding it a
 * digest the precompile itself reported returns the matching height — but it does
 * **not** answer for a Source Chain block hash, which is the only digest a Watcher
 * can observe. Measured against CC3 Testnet on both chains at a pinned `finalized`
 * tag:
 *
 * | Question | chainKey 1 | chainKey 3 |
 * | --- | --- | --- |
 * | attested frontier height | 11642850 | 25913730 |
 * | attested digest at that height | `0x3a0aa273…6c86` | `0xeb9bbd4d…4a90` |
 * | Source Chain block hash at that height | `0xdb89423b…9a5b` | `0x57ad50be…8b31` |
 * | digest lookup of the attested digest | `{height: 11642850, exists: true}` | `{height: 25913730, exists: true}` |
 * | digest lookup of the Source Chain block hash | `{height: 0, exists: false}` | `{height: 0, exists: false}` |
 *
 * The attested digest and the block hash are different words for the same height, and
 * the block hash is in no attestation record at all. Nor is it an off-by-one: on
 * Mainnet the attested digest at 25913710 matched none of `hash`, `parentHash`,
 * `stateRoot`, `receiptsRoot`, `transactionsRoot`, or `parentBeaconBlockRoot` across
 * heights 25913707 to 25913713. So a Watcher that used `exists: false` as its reorg
 * trigger would report a reorganisation for **every healthy Settlement it ever
 * cleared**, and `reportReorg` slashes the Service's Bond. That is the same class of
 * error as reaching for `get_checkpoint_for_height`, and it is why the check below
 * asks the Source Chain what digest a height now carries and treats the precompile
 * as corroboration rather than as the trigger.
 *
 * The check therefore runs in three steps, and cannot fire on an unproven premise:
 *
 * 1. `get_attestation_bounds(chainKey, blockHeight)`. `isAttested: false` means the
 *    block is not yet covered by the attested frontier, which is not a reorg and not
 *    a clean bill of health either — the verdict is `NOT_YET_ATTESTED` and nothing is
 *    reported. Attested heights land on a stride of 10, so a Settlement almost never
 *    sits *on* an endpoint; asking whether the height is covered is the only question
 *    that has an answer for an arbitrary height.
 * 2. The canonical Source Chain block digest at that height. Equal to the digest
 *    recorded at apply time is `CANONICAL`, and the overwhelmingly common case.
 * 3. Different, or the height no longer exists, is `REORGED`, and only then is
 *    `reportReorg(replayKey, observedDigest, attestedDigest)` submitted — with
 *    `attestedDigest` the digest the chain now carries, or `bytes32(0)` when the
 *    block has left the chain entirely. `TabBook` reverts `NoReorgDetected` on equal
 *    digests, so the contract refuses the spurious case even if this module got it
 *    wrong.
 *
 * Requirements: 14.7, 15.1, 15.2, 15.3, 20.1, 20.6
 */

import { Interface, type BlockTag, type JsonRpcProvider, type Signer } from "ethers";

import {
  causeOf,
  err,
  ok,
  unpackReplayKey,
  type ChainKey,
  type Result,
  type TabError,
} from "@tabai/shared";

import type { AgentRegistryReader } from "./agent-registry.js";
import { requireAddress, type WatcherConfig } from "./config.js";
import type { ClearingStateName } from "./db/schema.js";
import type { PendingSettlement } from "./db/observation-store.js";
import type { WatchTarget } from "./observation.js";

/** The 32-byte zero word: "this height carries no digest at all". */
export const ZERO_DIGEST = `0x${"00".repeat(32)}`;

/** `ITabBook.ClearingState` by ordinal, so a raw read decodes to a name. */
export const CLEARING_STATE_BY_ORDINAL: readonly ClearingStateName[] = [
  "NONE",
  "APPLIED",
  "CONFIRMED",
  "REVERSED",
  "DECLINED",
  "SUPERSEDED",
];

/**
 * The three `TabBook` members the clearing path touches. Component order is wire
 * order and matches `ITabBook` exactly; `Clearing` is read positionally.
 */
export const TAB_BOOK_ABI = [
  {
    type: "function",
    name: "applyProvisionalClearing",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "o",
        type: "tuple",
        components: [
          { name: "replayKey", type: "bytes32" },
          { name: "agent", type: "address" },
          { name: "serviceId", type: "bytes32" },
          { name: "asset", type: "address" },
          { name: "amount", type: "uint128" },
          { name: "chainKey", type: "uint64" },
          { name: "sourceTxHash", type: "bytes32" },
          { name: "attestedDigestAtApply", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "applied", type: "bool" }],
  },
  {
    type: "function",
    name: "reportReorg",
    stateMutability: "nonpayable",
    inputs: [
      { name: "replayKey", type: "bytes32" },
      { name: "observedDigest", type: "bytes32" },
      { name: "attestedDigest", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "reverseExpiredClearing",
    stateMutability: "nonpayable",
    inputs: [{ name: "clearingId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "clearingOf",
    stateMutability: "view",
    inputs: [{ name: "clearingId", type: "bytes32" }],
    outputs: [
      {
        name: "clearing",
        type: "tuple",
        components: [
          { name: "agent", type: "address" },
          { name: "serviceId", type: "bytes32" },
          { name: "asset", type: "address" },
          { name: "amount", type: "uint128" },
          { name: "reduced", type: "uint128" },
          { name: "chainKey", type: "uint64" },
          { name: "appliedAt", type: "uint64" },
          { name: "deadline", type: "uint64" },
          { name: "sourceTxHash", type: "bytes32" },
          { name: "attestedDigestAtApply", type: "bytes32" },
          { name: "state", type: "uint8" },
        ],
      },
    ],
  },
] as const;

/** The `ChainInfo` reads the reorg check uses. Field order is wire order. */
export const CHAIN_INFO_REORG_ABI = [
  {
    type: "function",
    name: "get_attestation_bounds",
    stateMutability: "view",
    inputs: [
      { name: "chainKey", type: "uint64" },
      { name: "targetHeight", type: "uint64" },
    ],
    outputs: [
      {
        name: "result",
        type: "tuple",
        components: [
          { name: "parentHeight", type: "uint64" },
          { name: "parentHash", type: "bytes32" },
          { name: "parentIsAttestation", type: "bool" },
          { name: "childHeight", type: "uint64" },
          { name: "childHash", type: "bytes32" },
          { name: "childIsAttestation", type: "bool" },
          { name: "isAttested", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "get_attestation_height_for_digest",
    stateMutability: "view",
    inputs: [
      { name: "chainKey", type: "uint64" },
      { name: "digest", type: "bytes32" },
    ],
    outputs: [
      {
        name: "result",
        type: "tuple",
        components: [
          { name: "height", type: "uint64" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
] as const;

/** One clearing record as `TabBook` holds it. */
export interface ClearingRead {
  readonly state: ClearingStateName;
  readonly amount: bigint;
  readonly reduced: bigint;
  readonly deadline: bigint;
  readonly attestedDigestAtApply: string;
}

/** The observation `applyProvisionalClearing` takes, in wire order. */
export interface ProvisionalObservationArgs {
  readonly replayKey: string;
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: bigint;
  readonly chainKey: bigint;
  readonly sourceTxHash: string;
  readonly attestedDigestAtApply: string;
}

/** A mined write, with the block it landed in so its effect can be read at that height. */
interface SendReceipt {
  readonly txHash: string;
  readonly blockNumber: number;
}

/** One submitted Creditcoin transaction, and what the chain said afterwards. */
export interface ClearingSubmission {
  readonly txHash: string;
  readonly clearingState: ClearingStateName;
}

/** The `TabBook` surface the clearing path needs. */
export interface TabBookClient {
  clearingOf(replayKey: string): Promise<Result<ClearingRead>>;
  applyProvisionalClearing(args: ProvisionalObservationArgs): Promise<Result<ClearingSubmission>>;
  reportReorg(replayKey: string, observedDigest: string, attestedDigest: string): Promise<Result<string>>;
  /** Cranks one expired clearing, reading the record back at the block the write landed in. */
  reverseExpiredClearing(clearingId: string): Promise<Result<ClearingSubmission>>;
}

/** The attested-side reads. Both return heights, so both can be checked at a pinned tag. */
export interface AttestationBounds {
  readonly parentHeight: bigint;
  readonly childHeight: bigint;
  readonly childHash: string;
  readonly isAttested: boolean;
}

export interface AttestationReader {
  bounds(chainKey: bigint, height: bigint): Promise<Result<AttestationBounds>>;
  /**
   * Which attested height a digest belongs to.
   *
   * Measured to answer only for digests from the precompile's own space: a Source
   * Chain block hash returns `{height: 0, exists: false}` even at an attested
   * height. Kept as corroboration, never as the reorg trigger.
   */
  heightForDigest(chainKey: bigint, digest: string): Promise<Result<{ height: bigint; exists: boolean }>>;
}

/** The one Source Chain read the reorg check needs. */
export interface SourceChainReader {
  /** The canonical block digest at a height, or `undefined` when the chain has no such block. */
  blockDigestAt(chainKey: ChainKey, height: bigint): Promise<Result<string | undefined>>;
}

function callError(what: string, error: unknown): TabError {
  return {
    category: "UPSTREAM",
    code: "TAB_BOOK_READ_FAILED",
    message: `\`${what}\` could not be read from TabBook`,
    retryable: true,
    cause: causeOf(error),
  };
}

/**
 * Builds the `TabBook` client.
 *
 * Reads go through the provider at a pinned tag; writes go through the signer. The
 * clearing state after a write is taken from `clearingOf` rather than from the
 * transaction's return value, because a mined transaction carries no return data and
 * the alternative — parsing which of two events was emitted — would infer chain state
 * from logs when the state itself can simply be read. It also happens to be the same
 * read crash recovery needs, so there is one authority and not two.
 */
export function createTabBookClient(
  provider: JsonRpcProvider,
  address: string,
  blockTag: BlockTag,
  signer?: Signer,
): TabBookClient {
  const iface = new Interface(TAB_BOOK_ABI);

  /**
   * Reads one clearing record.
   *
   * `at` overrides the pinned tag, and confirming a write is the one place that must use it.
   * Creditcoin's `finalized` view lags `latest` by a couple of blocks, so a read pinned to
   * `finalized` immediately after a mined transaction can miss the write it is checking. That is not
   * hypothetical: an `applyProvisionalClearing` that had genuinely applied, with the Bond reserved
   * and the record on chain reading `Applied`, was read back as `None` and recorded as declined, and
   * because a decline is terminal in this pipeline the Settlement would never have been retried while
   * the Service's stake stayed pledged. Discovery reads keep the pinned tag, because there the point
   * is that every answer in one pass comes from one view of the chain.
   */
  const readClearing = async (
    replayKey: string,
    at: BlockTag = blockTag,
  ): Promise<Result<ClearingRead>> => {
    let returnData: string;
    try {
      returnData = await provider.call({
        to: address,
        data: iface.encodeFunctionData("clearingOf", [replayKey]),
        blockTag: at,
      });
    } catch (error) {
      return err(callError("clearingOf", error));
    }
    try {
      const [raw] = iface.decodeFunctionResult("clearingOf", returnData).toArray();
      if (!Array.isArray(raw) || raw.length < 11) {
        return err({
          category: "CHAIN",
          code: "TAB_BOOK_DECODE_FAILED",
          message: "`clearingOf` returned a shape this ABI cannot read",
          retryable: false,
        });
      }
      const state = CLEARING_STATE_BY_ORDINAL[Number(raw[10])];
      if (state === undefined) {
        return err({
          category: "CHAIN",
          code: "TAB_BOOK_UNKNOWN_CLEARING_STATE",
          message: `\`clearingOf\` reported clearing state ${String(raw[10])}, which this build has no name for`,
          retryable: false,
        });
      }
      return ok({
        state,
        amount: BigInt(raw[3]),
        reduced: BigInt(raw[4]),
        deadline: BigInt(raw[7]),
        attestedDigestAtApply: String(raw[9]),
      });
    } catch (error) {
      return err(callError("clearingOf", error));
    }
  };

  const send = async (data: string, what: string): Promise<Result<SendReceipt>> => {
    if (signer === undefined) {
      return err({
        category: "VALIDATION",
        code: "WATCHER_KEY_MISSING",
        message: `${what} is a write and no signer was supplied, so this client is read-only`,
        retryable: false,
      });
    }
    try {
      const sent = await signer.sendTransaction({ to: address, data });
      const receipt = await sent.wait();
      if (receipt === null || receipt.status !== 1) {
        return err({
          category: "CHAIN",
          code: "CLEARING_TX_REVERTED",
          message: `${what} was mined with a failing status`,
          retryable: false,
          details: { txHash: sent.hash },
        });
      }
      return ok({ txHash: sent.hash, blockNumber: receipt.blockNumber });
    } catch (error) {
      return err({
        category: "CHAIN",
        code: "CLEARING_TX_FAILED",
        message: `${what} could not be submitted`,
        retryable: true,
        cause: causeOf(error),
      });
    }
  };

  return {
    clearingOf: readClearing,

    async applyProvisionalClearing(args): Promise<Result<ClearingSubmission>> {
      const data = iface.encodeFunctionData("applyProvisionalClearing", [
        [
          args.replayKey,
          args.agent,
          args.serviceId,
          args.asset,
          args.amount,
          args.chainKey,
          args.sourceTxHash,
          args.attestedDigestAtApply,
        ],
      ]);
      const sent = await send(data, "applyProvisionalClearing");
      if (!sent.ok) return err(sent.error);
      // Read the outcome at the block the write landed in, never at the pinned tag. See the note on
      // `readClearing`: a `finalized` read here can miss its own write and report a real Applied
      // clearing as declined.
      const after = await readClearing(args.replayKey, sent.value.blockNumber);
      if (!after.ok) return err(after.error);
      return ok({ txHash: sent.value.txHash, clearingState: after.value.state });
    },

    async reportReorg(replayKey, observedDigest, attestedDigest): Promise<Result<string>> {
      const data = iface.encodeFunctionData("reportReorg", [replayKey, observedDigest, attestedDigest]);
      const sent = await send(data, "reportReorg");
      return sent.ok ? ok(sent.value.txHash) : err(sent.error);
    },

    async reverseExpiredClearing(clearingId): Promise<Result<ClearingSubmission>> {
      const data = iface.encodeFunctionData("reverseExpiredClearing", [clearingId]);
      const sent = await send(data, "reverseExpiredClearing");
      if (!sent.ok) return err(sent.error);
      // Read back at the block the write landed in, never at the pinned tag, for the
      // reason `readClearing` documents: Creditcoin's `finalized` view lags `latest`,
      // and a reversal read back as still `Applied` would be cranked again on the next
      // pass, burning gas on a certain `ClearingNotInState` revert.
      const after = await readClearing(clearingId, sent.value.blockNumber);
      if (!after.ok) return err(after.error);
      return ok({ txHash: sent.value.txHash, clearingState: after.value.state });
    },
  };
}

/** Builds the attested-side reader at one pinned block tag. */
export function createAttestationReader(
  provider: JsonRpcProvider,
  precompile: string,
  blockTag: BlockTag,
): AttestationReader {
  const iface = new Interface(CHAIN_INFO_REORG_ABI);

  const call = async (name: string, args: readonly unknown[]): Promise<Result<readonly unknown[]>> => {
    try {
      const returnData = await provider.call({
        to: precompile,
        data: iface.encodeFunctionData(name, args),
        blockTag,
      });
      const [raw] = iface.decodeFunctionResult(name, returnData).toArray();
      if (!Array.isArray(raw)) {
        return err({
          category: "CHAIN",
          code: "CHAININFO_DECODE_FAILED",
          message: `\`${name}\` returned a shape this ABI cannot read`,
          retryable: false,
        });
      }
      return ok(raw);
    } catch (error) {
      const unknownSelector = /unknown selector/i.test(causeOf(error).message);
      return err({
        category: unknownSelector ? "CHAIN" : "UPSTREAM",
        code: unknownSelector ? "CHAININFO_SELECTOR_UNKNOWN" : "CHAININFO_READ_FAILED",
        message: unknownSelector
          ? `the ChainInfo Precompile does not expose \`${name}\`, so the pinned ABI no longer matches the chain`
          : `the ChainInfo Precompile did not answer \`${name}\``,
        retryable: !unknownSelector,
        cause: causeOf(error),
      });
    }
  };

  return {
    async bounds(chainKey, height): Promise<Result<AttestationBounds>> {
      const raw = await call("get_attestation_bounds", [chainKey, height]);
      if (!raw.ok) return err(raw.error);
      const fields = raw.value;
      if (fields.length < 7) {
        return err({
          category: "CHAIN",
          code: "CHAININFO_DECODE_FAILED",
          message: "`get_attestation_bounds` returned fewer than 7 fields",
          retryable: false,
        });
      }
      return ok({
        parentHeight: BigInt(String(fields[0])),
        childHeight: BigInt(String(fields[3])),
        childHash: String(fields[4]),
        isAttested: fields[6] === true,
      });
    },

    async heightForDigest(chainKey, digest): Promise<Result<{ height: bigint; exists: boolean }>> {
      const raw = await call("get_attestation_height_for_digest", [chainKey, digest]);
      if (!raw.ok) return err(raw.error);
      const fields = raw.value;
      if (fields.length < 2) {
        return err({
          category: "CHAIN",
          code: "CHAININFO_DECODE_FAILED",
          message: "`get_attestation_height_for_digest` returned fewer than 2 fields",
          retryable: false,
        });
      }
      return ok({ height: BigInt(String(fields[0])), exists: fields[1] === true });
    },
  };
}

/** Builds the Source Chain digest reader over one provider per chainKey. */
export function createSourceChainReader(
  providers: Readonly<Partial<Record<ChainKey, JsonRpcProvider>>>,
): SourceChainReader {
  return {
    async blockDigestAt(chainKey, height): Promise<Result<string | undefined>> {
      const provider = providers[chainKey];
      if (provider === undefined) {
        return err({
          category: "VALIDATION",
          code: "SOURCE_PROVIDER_MISSING",
          message: `no Source Chain provider is configured for chainKey ${chainKey}, so the canonical digest at height ${height} cannot be read`,
          retryable: false,
        });
      }
      try {
        const raw: unknown = await provider.send("eth_getBlockByNumber", [
          `0x${height.toString(16)}`,
          false,
        ]);
        if (raw === null || typeof raw !== "object") return ok(undefined);
        const digest = (raw as { hash?: unknown }).hash;
        return ok(typeof digest === "string" ? digest.toLowerCase() : undefined);
      } catch (error) {
        return err({
          category: "UPSTREAM",
          code: "SOURCE_BLOCK_READ_FAILED",
          message: `the canonical digest at chainKey ${chainKey} height ${height} could not be read`,
          retryable: true,
          cause: causeOf(error),
        });
      }
    },
  };
}

// ---------------------------------------------------------------- eligibility

/** Why an observation is not offered a Provisional Clearing. */
export type ClearingSkipReason =
  /** `_openClearing` reverts `AmountOutOfRange(0)`; a zero-value Transfer is legal */
  | "ZERO_AMOUNT"
  /** a Bond deposit funds stake and pays no tab down, so there is no headroom to restore */
  | "BOND_COLLECTION"
  /** a record already exists under this identity, and a second attempt is a certain revert */
  | "CLEARING_EXISTS"
  /** the row's Collection Address resolves to no current target, so its Service is unknown */
  | "UNKNOWN_TARGET"
  /** the row has already moved past `OBSERVED` */
  | "NOT_OBSERVED"
  /** the Source Chain would not say what digest the Settlement's block carries */
  | "DIGEST_UNAVAILABLE"
  /** no Agent has bound this payer, so there is no tab to clear and no identity to pledge against */
  | "UNBOUND_PAYER"
  /** the AgentRegistry could not be read, so the payer's Agent is unknown rather than absent */
  | "AGENT_UNRESOLVED";

/** Key of the `(chainKey, collection)` pair a row is resolved through. */
export const targetKeyOf = (chainKey: ChainKey, collection: string): string =>
  `${chainKey}:${collection.toLowerCase()}`;

/** Indexes targets for resolution by `(chainKey, collection)`. */
export function indexTargets(targets: readonly WatchTarget[]): Map<string, WatchTarget> {
  const index = new Map<string, WatchTarget>();
  for (const target of targets) index.set(targetKeyOf(target.chainKey, target.collection), target);
  return index;
}

/** One eligibility verdict, with the target it resolved through when it has one. */
export interface ClearingEligibility {
  readonly eligible: boolean;
  readonly reason: ClearingSkipReason | undefined;
  readonly target: WatchTarget | undefined;
}

/**
 * Whether a row may be offered a clearing, on locally held facts alone.
 *
 * Local facts only, deliberately: this decides which rows are worth an `eth_call`,
 * and the authoritative "does a clearing already exist" question is answered by
 * `clearingOf` afterwards. Ordering it this way means the free checks run first.
 */
export function clearingEligibility(
  settlement: PendingSettlement,
  targets: Map<string, WatchTarget>,
): ClearingEligibility {
  const target = targets.get(targetKeyOf(settlement.chainKey, settlement.collection));
  if (target === undefined) return { eligible: false, reason: "UNKNOWN_TARGET", target: undefined };
  if (settlement.state !== "OBSERVED") return { eligible: false, reason: "NOT_OBSERVED", target };
  if (settlement.clearingState !== undefined && settlement.clearingState !== "NONE") {
    return { eligible: false, reason: "CLEARING_EXISTS", target };
  }
  if (target.collectionKind === "BOND") return { eligible: false, reason: "BOND_COLLECTION", target };
  if (settlement.amount <= 0n) return { eligible: false, reason: "ZERO_AMOUNT", target };
  return { eligible: true, reason: undefined, target };
}

// ---------------------------------------------------------------- applying

/** What happened to one row in the clearing sweep. */
export interface ClearingAttempt {
  readonly replayKey: string;
  readonly applied: boolean;
  readonly clearingState: ClearingStateName | undefined;
  readonly skipped: ClearingSkipReason | undefined;
  /** The digest the clearing was applied against, when one was applied. */
  readonly digest: string | undefined;
  readonly txHash: string | undefined;
  readonly error: TabError | undefined;
}

/** Written back onto a row once its clearing outcome is known. */
export interface ClearingPersist {
  readonly replayKey: string;
  readonly clearingState: ClearingStateName;
  readonly state: "OBSERVED" | "PROVISIONAL";
  readonly attestedDigest?: string | undefined;
}

export interface ClearingSweepDeps {
  readonly client: TabBookClient;
  readonly source: SourceChainReader;
  /**
   * Resolves a Settlement's Ethereum payer to the Creditcoin Agent that bound it.
   *
   * Required rather than optional: a clearing pledges the Service's Bond against
   * whatever address it is handed, and the payer is not that address. See
   * `agent-registry.ts`.
   */
  readonly agents: AgentRegistryReader;
  readonly targets: readonly WatchTarget[];
  /** Persists one outcome. Called after every state-changing answer, including a discovery. */
  readonly persist: (record: ClearingPersist) => Promise<Result<number>>;
  /** Address the signer will send from, when the sweep is going to send anything. */
  readonly signerAddress?: string | undefined;
  /** Address `TabBook.watcher` holds, from `WATCHER_ADDRESS`. */
  readonly watcherAddress?: string | undefined;
  /** False leaves the sweep read-only: it reports what it would do and sends nothing. */
  readonly submit: boolean;
}

export interface ClearingSweepReport {
  readonly attempted: number;
  readonly applied: number;
  readonly declined: number;
  readonly discovered: number;
  readonly skipped: number;
  readonly failed: number;
  readonly attempts: readonly ClearingAttempt[];
}

/**
 * Offers a Provisional Clearing to every eligible row.
 *
 * The digest stored on the clearing is read here rather than at observation, because
 * "the digest observed for the Settlement's block at apply time" is what
 * `reportReorg` later insists the reported observation equals. Reading it at
 * observation and reusing it would record a digest from before the clearing, and a
 * shallow reorganisation between the two — entirely possible, since the whole point
 * of a Provisional Clearing is that the block is not final — would leave the stored
 * digest describing a block the clearing was never applied against.
 *
 * A row whose clearing turns out to already exist is not an error and not a retry:
 * the discovered state is persisted, which is exactly what crash recovery needs after
 * a broadcast whose receipt was lost.
 */
export async function sweepClearings(
  deps: ClearingSweepDeps,
  settlements: readonly PendingSettlement[],
): Promise<Result<ClearingSweepReport>> {
  if (deps.submit) {
    const signer = deps.signerAddress?.toLowerCase();
    const wired = deps.watcherAddress?.toLowerCase();
    if (signer === undefined) {
      return err({
        category: "VALIDATION",
        code: "WATCHER_SIGNER_MISSING",
        message: "a submitting sweep needs a signer, and none was supplied",
        retryable: false,
      });
    }
    if (wired !== undefined && signer !== wired) {
      // Checked before anything is broadcast: `applyProvisionalClearing` reverts
      // `NotWatcher` for any other sender, and a reverted transaction still costs gas.
      return err({
        category: "AUTHORISATION",
        code: "WATCHER_ADDRESS_MISMATCH",
        message: `the signer is ${signer} but TabBook.watcher is wired to ${wired}, so every clearing would revert NotWatcher`,
        retryable: false,
      });
    }
  }

  const index = indexTargets(deps.targets);
  const attempts: ClearingAttempt[] = [];
  let applied = 0;
  let declined = 0;
  let discovered = 0;
  let skipped = 0;
  let failed = 0;

  for (const settlement of settlements) {
    const eligibility = clearingEligibility(settlement, index);
    if (!eligibility.eligible) {
      skipped += 1;
      attempts.push({
        replayKey: settlement.replayKey,
        applied: false,
        clearingState: settlement.clearingState,
        skipped: eligibility.reason,
        digest: undefined,
        txHash: undefined,
        error: undefined,
      });
      continue;
    }

    // The authority on whether an identity is spent. Also the recovery read: a
    // clearing broadcast before a crash is found here rather than attempted twice.
    const existing = await deps.client.clearingOf(settlement.replayKey);
    if (!existing.ok) {
      failed += 1;
      attempts.push({
        replayKey: settlement.replayKey,
        applied: false,
        clearingState: undefined,
        skipped: undefined,
        digest: undefined,
        txHash: undefined,
        error: existing.error,
      });
      continue;
    }
    if (existing.value.state !== "NONE") {
      discovered += 1;
      const persisted = await deps.persist({
        replayKey: settlement.replayKey,
        clearingState: existing.value.state,
        state: existing.value.state === "APPLIED" ? "PROVISIONAL" : "OBSERVED",
        ...(existing.value.attestedDigestAtApply === ZERO_DIGEST
          ? {}
          : { attestedDigest: existing.value.attestedDigestAtApply }),
      });
      attempts.push({
        replayKey: settlement.replayKey,
        applied: existing.value.state === "APPLIED",
        clearingState: existing.value.state,
        skipped: "CLEARING_EXISTS",
        digest: existing.value.attestedDigestAtApply,
        txHash: undefined,
        error: persisted.ok ? undefined : persisted.error,
      });
      continue;
    }

    // The payer is an Ethereum address and a tab is keyed on a Creditcoin Agent.
    // Resolved before the digest read, because an unbound payer is not offered a
    // clearing at all and a Source Chain round trip for it would be wasted.
    const resolution = await deps.agents.agentOf(settlement.chainKey, settlement.payer);
    if (!resolution.ok) {
      skipped += 1;
      attempts.push({
        replayKey: settlement.replayKey,
        applied: false,
        clearingState: "NONE",
        skipped: "AGENT_UNRESOLVED",
        digest: undefined,
        txHash: undefined,
        error: resolution.error,
      });
      continue;
    }
    const agent = resolution.value.agent;
    if (agent === undefined) {
      // Not an error and not a loss. The Settlement still reaches the Service on
      // the Source Chain, and the Verified Settlement still applies once proven,
      // because `resolveOrBind` can finalise a pending binding this read cannot
      // see. Only the instant headroom restoration is forgone.
      skipped += 1;
      attempts.push({
        replayKey: settlement.replayKey,
        applied: false,
        clearingState: "NONE",
        skipped: "UNBOUND_PAYER",
        digest: undefined,
        txHash: undefined,
        error: undefined,
      });
      continue;
    }

    const digest = await deps.source.blockDigestAt(settlement.chainKey, settlement.blockHeight);
    if (!digest.ok || digest.value === undefined) {
      skipped += 1;
      attempts.push({
        replayKey: settlement.replayKey,
        applied: false,
        clearingState: "NONE",
        skipped: "DIGEST_UNAVAILABLE",
        digest: undefined,
        txHash: undefined,
        error: digest.ok ? undefined : digest.error,
      });
      continue;
    }

    if (!deps.submit) {
      attempts.push({
        replayKey: settlement.replayKey,
        applied: false,
        clearingState: "NONE",
        skipped: undefined,
        digest: digest.value,
        txHash: undefined,
        error: undefined,
      });
      continue;
    }

    const submission = await deps.client.applyProvisionalClearing({
      replayKey: settlement.replayKey,
      agent,
      serviceId: settlement.serviceId,
      asset: settlement.asset,
      amount: settlement.amount,
      chainKey: BigInt(settlement.chainKey),
      sourceTxHash: settlement.sourceTxHash,
      attestedDigestAtApply: digest.value,
    });
    if (!submission.ok) {
      failed += 1;
      attempts.push({
        replayKey: settlement.replayKey,
        applied: false,
        clearingState: undefined,
        skipped: undefined,
        digest: digest.value,
        txHash: undefined,
        error: submission.error,
      });
      continue;
    }

    const wasApplied = submission.value.clearingState === "APPLIED";
    if (wasApplied) applied += 1;
    else declined += 1;

    const persisted = await deps.persist({
      replayKey: settlement.replayKey,
      clearingState: submission.value.clearingState,
      state: wasApplied ? "PROVISIONAL" : "OBSERVED",
      attestedDigest: digest.value,
    });
    attempts.push({
      replayKey: settlement.replayKey,
      applied: wasApplied,
      clearingState: submission.value.clearingState,
      skipped: undefined,
      digest: digest.value,
      txHash: submission.value.txHash,
      error: persisted.ok ? undefined : persisted.error,
    });
  }

  return ok({
    attempted: settlements.length,
    applied,
    declined,
    discovered,
    skipped,
    failed,
    attempts,
  });
}

// ---------------------------------------------------------------- reversal crank

/** What happened to one candidate in the reversal sweep. */
export interface ReversalAttempt {
  readonly replayKey: string;
  /** The state the chain reported before anything was attempted. */
  readonly stateBefore: ClearingStateName | undefined;
  /** The state the chain reported after the crank, read at the block it landed in. */
  readonly stateAfter: ClearingStateName | undefined;
  readonly reversed: boolean;
  /** Set when nothing was attempted, saying why in the Watcher's own words. */
  readonly skipped: "NOT_APPLIED" | "NOT_EXPIRED" | "READ_ONLY" | undefined;
  /** Seconds remaining until the deadline, negative once it has passed. */
  readonly secondsUntilDeadline: number | undefined;
  readonly txHash: string | undefined;
  readonly error: TabError | undefined;
}

export interface ReversalSweepReport {
  readonly attempted: number;
  readonly reversed: number;
  readonly notExpired: number;
  readonly skipped: number;
  readonly failed: number;
  readonly attempts: readonly ReversalAttempt[];
}

export interface ReversalSweepDeps {
  readonly client: TabBookClient;
  /** Persists the state the chain reported, so the next pass starts from the truth. */
  readonly persist: (replayKey: string, clearingState: ClearingStateName) => Promise<Result<number>>;
  /** Creditcoin's own clock, which is what `TabBook` compares the deadline against. */
  readonly chainTimestamp: () => Promise<Result<number>>;
  /** False leaves the sweep read-only: it reports what it would crank and sends nothing. */
  readonly submit: boolean;
}

/**
 * Cranks every Provisional Clearing that passed its deadline unconfirmed (R15.5).
 *
 * `reverseExpiredClearing` is permissionless by design, so that reversal liveness
 * never depends on the Watcher that applied the clearing and therefore benefits from
 * never reversing it. This sweep is the normal path rather than the guarantee: the
 * guarantee is that anybody else can do it too.
 *
 * Two decisions are made from the chain and from nothing else.
 *
 * The state is re-read per candidate rather than trusted from the row, because a
 * permissionless crank means somebody else may already have reversed it, and a stored
 * `APPLIED` that is really `Reversed` would send a transaction that reverts with
 * certainty. The same read settles the confirmed case, where the Verified Settlement
 * arrived and there is nothing left to reverse.
 *
 * The deadline is compared against **Creditcoin's** block timestamp, not against wall
 * clock time. `TabBook` compares it against `block.timestamp`, so a Watcher host whose
 * clock ran fast would crank early and pay gas for a `ClearingNotExpired` revert. The
 * two clocks are close but they are not the same clock, and only one of them decides.
 *
 * Every read-back after a send uses the block the write landed in, for the reason
 * `readClearing` documents: a `finalized` read immediately after a mined transaction
 * can miss it.
 */
export async function sweepReversals(
  deps: ReversalSweepDeps,
  candidates: readonly { readonly replayKey: string }[],
): Promise<Result<ReversalSweepReport>> {
  const now = await deps.chainTimestamp();
  if (!now.ok) return err(now.error);

  const attempts: ReversalAttempt[] = [];
  let reversed = 0;
  let notExpired = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const read = await deps.client.clearingOf(candidate.replayKey);
    if (!read.ok) {
      failed += 1;
      attempts.push({ replayKey: candidate.replayKey, stateBefore: undefined, stateAfter: undefined, reversed: false, skipped: undefined, secondsUntilDeadline: undefined, txHash: undefined, error: read.error });
      continue;
    }

    const record = read.value;
    const remaining = Number(record.deadline) - now.value;

    // Somebody else already resolved it, or it was never applied. Persist what the
    // chain says so the row stops being a candidate, and send nothing.
    if (record.state !== "APPLIED") {
      skipped += 1;
      await deps.persist(candidate.replayKey, record.state);
      attempts.push({ replayKey: candidate.replayKey, stateBefore: record.state, stateAfter: record.state, reversed: false, skipped: "NOT_APPLIED", secondsUntilDeadline: remaining, txHash: undefined, error: undefined });
      continue;
    }

    if (remaining > 0) {
      notExpired += 1;
      attempts.push({ replayKey: candidate.replayKey, stateBefore: record.state, stateAfter: record.state, reversed: false, skipped: "NOT_EXPIRED", secondsUntilDeadline: remaining, txHash: undefined, error: undefined });
      continue;
    }

    if (!deps.submit) {
      skipped += 1;
      attempts.push({ replayKey: candidate.replayKey, stateBefore: record.state, stateAfter: record.state, reversed: false, skipped: "READ_ONLY", secondsUntilDeadline: remaining, txHash: undefined, error: undefined });
      continue;
    }

    const sent = await deps.client.reverseExpiredClearing(candidate.replayKey);
    if (!sent.ok) {
      failed += 1;
      attempts.push({ replayKey: candidate.replayKey, stateBefore: record.state, stateAfter: undefined, reversed: false, skipped: undefined, secondsUntilDeadline: remaining, txHash: undefined, error: sent.error });
      continue;
    }

    const written = await deps.persist(candidate.replayKey, sent.value.clearingState);
    const didReverse = sent.value.clearingState === "REVERSED";
    if (didReverse) reversed += 1;
    else failed += 1;
    attempts.push({ replayKey: candidate.replayKey, stateBefore: record.state, stateAfter: sent.value.clearingState, reversed: didReverse, skipped: undefined, secondsUntilDeadline: remaining, txHash: sent.value.txHash, error: written.ok ? undefined : written.error });
  }

  return ok({ attempted: candidates.length, reversed, notExpired, skipped, failed, attempts });
}

// ---------------------------------------------------------------- reorg check

/** What the reorg check concluded about one Settlement's block. */
export type ReorgVerdict =
  /** the digest recorded at apply time is still the canonical digest at that height */
  | "CANONICAL"
  /** the height carries a different digest now, or no block at all */
  | "REORGED"
  /** the block is not yet covered by the attested frontier, so there is nothing to conclude */
  | "NOT_YET_ATTESTED"
  /** a read failed, so no conclusion was reached and nothing was reported */
  | "UNVERIFIABLE";

export interface ReorgFinding {
  readonly replayKey: string;
  readonly chainKey: ChainKey;
  readonly blockHeight: bigint;
  readonly observedDigest: string;
  /** The digest the chain carries now: `ZERO_DIGEST` when the height has no block. */
  readonly attestedDigest: string | undefined;
  readonly verdict: ReorgVerdict;
  /**
   * What `get_attestation_height_for_digest` said about the observed digest.
   *
   * Recorded, never acted on. A Source Chain block hash was measured to answer
   * `exists: false` on both chains even at an attested height, so this field is
   * evidence about the precompile's digest space rather than a reorg signal.
   */
  readonly digestResolvesOnChainInfo: boolean | undefined;
  readonly detail: string;
  /** Creditcoin transaction hash of the `reportReorg` call, when one was sent. */
  readonly reportedTxHash: string | undefined;
  readonly error: TabError | undefined;
}

export interface ReorgCheckDeps {
  readonly attestation: AttestationReader;
  readonly source: SourceChainReader;
  readonly client: TabBookClient;
  /** Persists a supersession once the report is mined. */
  readonly persist: (record: ClearingPersist) => Promise<Result<number>>;
  /** False leaves the check read-only: it concludes and reports nothing on chain. */
  readonly submit: boolean;
}

/**
 * Decides whether one Settlement's block is still the block it was cleared against.
 *
 * The order of the reads is the whole of the correctness argument. Coverage first,
 * because an unattested height has no answer and treating "not yet" as "gone" would
 * slash a Service for latency. Then the canonical digest at that height from the
 * Source Chain, which is the only place a block hash can be compared against a block
 * hash. The precompile's digest lookup is taken last and only recorded, because it
 * answers within its own digest space and a Source Chain block hash is not in it.
 */
export async function checkForReorg(
  deps: ReorgCheckDeps,
  settlement: PendingSettlement,
): Promise<ReorgFinding> {
  const base = {
    replayKey: settlement.replayKey,
    chainKey: settlement.chainKey,
    blockHeight: settlement.blockHeight,
    reportedTxHash: undefined,
  } as const;

  const observedDigest = settlement.attestedDigest;
  if (observedDigest === undefined) {
    return {
      ...base,
      observedDigest: ZERO_DIGEST,
      attestedDigest: undefined,
      verdict: "UNVERIFIABLE",
      digestResolvesOnChainInfo: undefined,
      detail:
        "the row carries no digest from apply time, and `reportReorg` refuses an observation that disagrees with the digest the clearing recorded",
      error: undefined,
    };
  }

  const bounds = await deps.attestation.bounds(BigInt(settlement.chainKey), settlement.blockHeight);
  if (!bounds.ok) {
    return {
      ...base,
      observedDigest,
      attestedDigest: undefined,
      verdict: "UNVERIFIABLE",
      digestResolvesOnChainInfo: undefined,
      detail: `the attestation bounds around height ${settlement.blockHeight} could not be read`,
      error: bounds.error,
    };
  }
  if (!bounds.value.isAttested) {
    return {
      ...base,
      observedDigest,
      attestedDigest: undefined,
      verdict: "NOT_YET_ATTESTED",
      digestResolvesOnChainInfo: undefined,
      detail: `height ${settlement.blockHeight} sits above the attested frontier, between endpoints ${bounds.value.parentHeight} and ${bounds.value.childHeight}, so nothing about it is settled yet`,
      error: undefined,
    };
  }

  const canonical = await deps.source.blockDigestAt(settlement.chainKey, settlement.blockHeight);
  if (!canonical.ok) {
    return {
      ...base,
      observedDigest,
      attestedDigest: undefined,
      verdict: "UNVERIFIABLE",
      digestResolvesOnChainInfo: undefined,
      detail: `the canonical digest at height ${settlement.blockHeight} could not be read, so the comparison was not made`,
      error: canonical.error,
    };
  }

  // Corroboration only. Measured to answer `exists: false` for a Source Chain block
  // hash even at an attested height, so it never decides anything here.
  const lookup = await deps.attestation.heightForDigest(BigInt(settlement.chainKey), observedDigest);
  const digestResolvesOnChainInfo = lookup.ok ? lookup.value.exists : undefined;

  if (canonical.value !== undefined && canonical.value.toLowerCase() === observedDigest.toLowerCase()) {
    return {
      ...base,
      observedDigest,
      attestedDigest: canonical.value,
      verdict: "CANONICAL",
      digestResolvesOnChainInfo,
      detail: `height ${settlement.blockHeight} still carries the digest the clearing was applied against`,
      error: undefined,
    };
  }

  const attestedDigest = canonical.value ?? ZERO_DIGEST;
  const detail =
    canonical.value === undefined
      ? `height ${settlement.blockHeight} no longer carries a block, so the Settlement has left the chain`
      : `height ${settlement.blockHeight} now carries ${canonical.value} rather than the ${observedDigest} the clearing was applied against`;

  if (!deps.submit) {
    return {
      ...base,
      observedDigest,
      attestedDigest,
      verdict: "REORGED",
      digestResolvesOnChainInfo,
      detail: `${detail}; not reported, because this check is read-only`,
      error: undefined,
    };
  }

  const reported = await deps.client.reportReorg(settlement.replayKey, observedDigest, attestedDigest);
  if (!reported.ok) {
    return {
      ...base,
      observedDigest,
      attestedDigest,
      verdict: "REORGED",
      digestResolvesOnChainInfo,
      detail: `${detail}; the report could not be submitted`,
      error: reported.error,
    };
  }

  const persisted = await deps.persist({
    replayKey: settlement.replayKey,
    clearingState: "SUPERSEDED",
    state: "OBSERVED",
    attestedDigest: observedDigest,
  });

  return {
    replayKey: settlement.replayKey,
    chainKey: settlement.chainKey,
    blockHeight: settlement.blockHeight,
    observedDigest,
    attestedDigest,
    verdict: "REORGED",
    digestResolvesOnChainInfo,
    detail,
    reportedTxHash: reported.value,
    error: persisted.ok ? undefined : persisted.error,
  };
}

/** Runs {@link checkForReorg} over a batch, one at a time so one failure is local. */
export async function checkForReorgs(
  deps: ReorgCheckDeps,
  settlements: readonly PendingSettlement[],
): Promise<readonly ReorgFinding[]> {
  const findings: ReorgFinding[] = [];
  for (const settlement of settlements) findings.push(await checkForReorg(deps, settlement));
  return findings;
}

/**
 * The chainKey and height a replay key was built from, for a caller holding only the
 * key. Thin pass-through to `@tabai/shared`, exported so nothing here re-derives it.
 */
export function replayKeyFields(replayKey: string): {
  chainKey: bigint;
  blockHeight: bigint;
  txIndex: bigint;
  logIndex: bigint;
} {
  return unpackReplayKey(replayKey);
}

/** The `TabBook` address, or an error naming the variable. */
export function requireTabBook(config: WatcherConfig): Result<string> {
  return requireAddress(config.creditcoin.tabBook, "TAB_BOOK_ADDRESS", "the clearing path");
}

/** The `ServiceRegistry` address, or an error naming the variable. */
export function requireServiceRegistry(config: WatcherConfig): Result<string> {
  return requireAddress(
    config.creditcoin.serviceRegistry,
    "SERVICE_REGISTRY_ADDRESS",
    "watch-target resolution",
  );
}
