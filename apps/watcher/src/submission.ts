/**
 * Submission: the one place the Watcher spends CTC on a proof, and how it reacts
 * when the chain refuses (R9.5, R20.9, R20.10, design sections 8.6, 13.2, D16).
 *
 * ## Order of operations, which is the whole of R20.9
 *
 * 1. **Simulate first.** `submitSettlementBatch` is replayed over a keyless
 *    `eth_call` from the Watcher's address before anything is signed. A refusal
 *    here costs nothing where the same refusal as a transaction costs a receipt,
 *    and it also answers the question a batch revert cannot: *which* member. On
 *    a batch refusal every member is simulated alone, the refused ones take the
 *    action their error names, and only the members the chain will accept go on.
 * 2. **Write `SUBMITTED` before broadcast.** Every replay key in the batch is
 *    recorded as claimed before the transaction leaves the process. A crash
 *    between the write and the broadcast leaves rows whose on-chain state is
 *    unknown, and {@link reconcileSubmitted} settles them from `claimedLog`.
 * 3. **Broadcast, wait, read back.** A mined transaction is confirmed member by
 *    member through `claimedLog(replayKey)` rather than by trusting the receipt's
 *    status alone, because the replay key is the identity the contract actually
 *    claimed.
 * 4. **A batch that reverts on chain falls back to single submissions** (D16),
 *    each simulated first, so one bad member never blocks the others and never
 *    costs a second reverted batch.
 *
 * ## Every refusal has one of six actions, and unknown means conservative
 *
 * The table in {@link SUBMISSION_REFUSALS} is design section 13.2 as code. A
 * refusal it does not name is skipped and flagged rather than retried, for the
 * same reason `proof.ts` refuses to guess on an unrecognised string revert:
 * retrying an unknown refusal spends gas twice to learn nothing. Transport
 * failures with no revert data are the one thing retried on the backoff
 * schedule, because they say nothing about the material.
 *
 * ## `SKIP` and `HALT` share the `HALTED` state and differ in the category
 *
 * `state.ts` fixes seven states and none of them is "skipped". A permanently
 * refused Settlement and one needing an operator are both rows the pipeline will
 * never touch again, so both land in `HALTED`; `last_error_category` carries
 * `SKIP:<error>` or `HALT:<error>` so the health endpoint and the explorer can
 * tell "this can never succeed" from "somebody has to look at this".
 *
 * Requirements: 9.2, 9.5, 20.9, 20.10, 16.6
 */

import { Interface, type BlockTag, type JsonRpcProvider, type Signer, type TransactionReceipt } from "ethers";

import { err, ok, type Result, type TabError } from "@tabai/shared";

import { DEFAULT_BACKOFF, nextAttemptAt, type BackoffSchedule } from "./backoff.js";
import { describeCause } from "./errors.js";
import { classifyPrecompileRefusal, type ProofMaterial } from "./proof.js";
import type { SettlementState } from "./state.js";

/**
 * The `SettlementVerifier` surface the Watcher uses, in human-readable form.
 *
 * `SourceTx` is the contract's own struct, one argument per submission, so a
 * Continuity Proof cannot be paired with a transaction it was not built for. The
 * error fragments are every custom error the five deployed contracts declare,
 * with their selectors confirmed against `forge inspect` on 2026-09-06, so a
 * revert from any contract the verifier calls into decodes to a name here.
 */
const SOURCE_TX =
  "(uint64 chainKey, uint64 blockHeight, bytes encodedTransaction, (bytes32 root, (bytes32 hash, bool isLeft)[] siblings) merkleProof, (bytes32 lowerEndpointDigest, bytes32[] roots) continuityProof)";

export const SETTLEMENT_VERIFIER_ABI: readonly string[] = [
  `function submitSettlement(${SOURCE_TX} sourceTx) returns (uint256 ingestedLogs)`,
  `function submitSettlementBatch(${SOURCE_TX}[] sourceTxs) returns (uint256 ingestedLogs)`,
  "function claimedLog(bytes32 key) view returns (bool claimed)",
  "event SettlementRecorded(bytes32 indexed replayKey, uint64 chainKey, uint64 blockHeight, uint64 txIndex, uint64 logIndex, address indexed agent, bytes32 indexed serviceId, address asset, uint256 amount, address payerAddress, bytes32 sourceTabId)",
  "event BondDepositRecorded(bytes32 indexed replayKey, uint64 chainKey, uint64 blockHeight, uint64 txIndex, uint64 logIndex, address indexed depositor, bytes32 indexed serviceId, address asset, uint256 amount, address payerAddress, bytes32 party)",
  // TabAscBase
  "error EmptyBatch()",
  "error BatchTooLarge(uint256 provided, uint256 maximum)",
  "error BatchRangeExceeded(uint64 lowestHeight, uint64 highestHeight, uint64 maximumSpan)",
  "error UnsupportedChainKey(uint64 chainKey)",
  "error ProofRejected(uint64 chainKey, uint64 blockHeight, bytes32 merkleRoot)",
  "error UnsupportedTransactionType(uint8 txType)",
  "error SourceTransactionReverted(uint64 chainKey, uint64 blockHeight, uint64 txIndex)",
  "error NoRecognisedSettlement(uint64 chainKey, uint64 blockHeight, uint64 txIndex)",
  "error AlreadyClaimed(bytes32 key)",
  "error LogCountMismatch(uint256 sweepCount, uint256 filterCount)",
  // SettlementVerifier
  "error UnknownCollectionAddress(uint64 chainKey, address recipient, address asset)",
  "error UnauthorizedSourceChain(uint64 submittedChainKey, address emitter, uint64 authorisedMask)",
  "error UnboundPayer(uint64 chainKey, address payerAddress)",
  "error AssetMismatch(address logAsset, address collectionAsset)",
  "error MalformedSettlementLog(bytes32 signature, uint256 topicCount, uint256 dataLength)",
  "error BondDepositOutOfRange(uint256 amount)",
  "error ZeroAddressField()",
  // AgentRegistry
  "error AddressAlreadyBound(uint64 chainKey, address ethAddress, address agent)",
  "error BindingAlreadyPending(address agent, uint64 chainKey, address ethAddress, uint16 nonce, uint64 expiry)",
  "error BindingWindowActive(uint64 chainKey, uint64 issuedAt, uint64 expiry)",
  "error BindingWindowElapsed(uint64 expiry, uint64 nowTs)",
  "error NoOpenBinding(uint64 chainKey, address ethAddress, address agent)",
  "error NonceOutOfRange(uint16 nonce)",
  "error NonceSpaceExhausted()",
  "error TooManyBoundAddresses(address agent, uint64 chainKey, uint256 maximum)",
  "error ZeroEthAddress()",
  "error NotSettlementVerifier(address caller)",
  // TabBook
  "error AmountOutOfRange(uint256 amount)",
  "error HistoryCommitmentMismatch(bytes32 expected, bytes32 provided)",
  "error HistoryLengthMismatch(uint32 expected, uint256 provided)",
  "error HistoryTooLong(uint256 provided, uint256 maximum)",
  "error TooManyCounterparties(uint256 provided, uint256 maximum)",
  "error IneligibleBondEntry(bytes32 serviceId, address party)",
  "error DuplicateBondEntry(bytes32 serviceId)",
  "error TooManyBondEntries(uint256 provided, uint256 maximum)",
  "error ReplayKeyChainKeyMismatch(uint64 packed, uint64 provided)",
  "error SettlementAlreadyApplied(bytes32 replayKey)",
  "error UnknownSettlement(bytes32 replayKey)",
  "error UnknownClearing(bytes32 clearingId)",
  "error ClearingAlreadyExists(bytes32 clearingId, uint8 state)",
  "error ClearingNotInState(bytes32 clearingId, uint8 state)",
  "error UnknownTab(bytes32 tabId)",
  "error NotWatcher(address caller)",
  "error NotWiringAuthority(address caller)",
  // Bond
  "error AssetNotRegistered(address asset)",
  "error ClearingAlreadyResolved(bytes32 clearingId)",
  "error InsufficientFreeBond(bytes32 party, address asset, uint128 free, uint128 requested)",
  "error NotTabBook(address caller)",
  "error ReorgAlreadySlashed(bytes32 replayKey)",
  "error ReservationUnknown(bytes32 clearingId)",
  "error ZeroAmount()",
  "error ZeroBeneficiary()",
  // ServiceRegistry
  "error UnknownService(bytes32 serviceId)",
  "error CollectionNotHeld(uint64 chainKey, address collection, bytes32 serviceId)",
  "error NotServiceOperator(bytes32 serviceId, address caller)",
];

/** What the pipeline does with one refused member. Design section 13.2's three verbs, refined. */
export type SubmissionAction =
  /** transient; keep READY and retry on the backoff schedule */
  | "RETRY"
  /** the material may be wrong; withhold and let the proof stage ask the other builder */
  | "RETRY_ALTERNATE_BUILDER"
  /** the payer may bind later; re-queue once after 24 hours, then skip */
  | "RETRY_AFTER_24H"
  /** can never succeed; terminal, no operator needed */
  | "SKIP"
  /** stop this chain's pipeline and flag the health endpoint */
  | "HALT"
  /** the chain already holds the claim; read `claimedLog` and settle the row from it */
  | "RECONCILE";

/** Design section 13.2, keyed by decoded error name. */
export const SUBMISSION_REFUSALS: Readonly<Record<string, SubmissionAction>> = {
  EmptyBatch: "HALT",
  BatchTooLarge: "HALT",
  BatchRangeExceeded: "HALT",
  UnsupportedChainKey: "SKIP",
  ProofRejected: "RETRY_ALTERNATE_BUILDER",
  UnsupportedTransactionType: "SKIP",
  SourceTransactionReverted: "SKIP",
  NoRecognisedSettlement: "SKIP",
  AlreadyClaimed: "RECONCILE",
  LogCountMismatch: "HALT",
  UnknownCollectionAddress: "SKIP",
  UnauthorizedSourceChain: "HALT",
  UnboundPayer: "RETRY_AFTER_24H",
  AssetMismatch: "SKIP",
  MalformedSettlementLog: "SKIP",
  BondDepositOutOfRange: "SKIP",
  ZeroAddressField: "SKIP",
  BindingWindowElapsed: "SKIP",
  AddressAlreadyBound: "SKIP",
  TooManyBoundAddresses: "SKIP",
  NonceSpaceExhausted: "RETRY",
  HistoryCommitmentMismatch: "HALT",
  HistoryLengthMismatch: "HALT",
  HistoryTooLong: "HALT",
  TooManyCounterparties: "HALT",
  IneligibleBondEntry: "HALT",
  DuplicateBondEntry: "HALT",
  ReplayKeyChainKeyMismatch: "HALT",
  SettlementAlreadyApplied: "RECONCILE",
  UnknownClearing: "RECONCILE",
  ClearingAlreadyResolved: "RECONCILE",
  AssetNotRegistered: "HALT",
  NotSettlementVerifier: "HALT",
  NotTabBook: "HALT",
  NotWatcher: "HALT",
  UnknownService: "SKIP",
  CollectionNotHeld: "SKIP",
};

/** Transport-level messages that mean the key, not the material, needs an operator. */
const OPERATOR_TRANSPORT_FAILURES = [/insufficient funds/i, /invalid sender/i, /unknown account/i];

/** The classified reason one submission was refused. */
export interface SubmissionRefusal {
  readonly action: SubmissionAction;
  /** The decoded custom error name, `Error(string)` for a string revert, or `TRANSPORT`. */
  readonly errorName: string;
  /** Decoded arguments as strings, or the revert message for `Error(string)`. */
  readonly args: readonly string[];
  readonly raw: string | undefined;
  readonly recognised: boolean;
  readonly detail: string;
}

/** Pulls revert data out of whatever `ethers` threw. */
export function revertDataOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { data?: unknown; info?: { error?: { data?: unknown } } };
  if (typeof candidate.data === "string" && candidate.data.startsWith("0x") && candidate.data.length > 2) {
    return candidate.data;
  }
  const nested = candidate.info?.error?.data;
  return typeof nested === "string" && nested.startsWith("0x") && nested.length > 2 ? nested : undefined;
}

const ERROR_STRING_SELECTOR = "0x08c379a0";

/**
 * Classifies a refusal from the chain.
 *
 * Three shapes: a custom error decodable against the verifier ABI, the builtin
 * `Error(string)` which is what the precompile raises, and no revert data at all,
 * which is a transport failure and the only shape retried on the schedule.
 */
export function classifySubmissionFailure(error: unknown, iface: Interface = VERIFIER_INTERFACE): SubmissionRefusal {
  const data = revertDataOf(error);

  if (data === undefined) {
    const cause = describeCause(error);
    const operator = OPERATOR_TRANSPORT_FAILURES.some((pattern) => pattern.test(cause.message));
    return {
      action: operator ? "HALT" : "RETRY",
      errorName: "TRANSPORT",
      args: [cause.message],
      raw: undefined,
      recognised: false,
      detail: operator
        ? `the transaction was refused before execution with "${cause.message}", which is a key or funding problem for an operator`
        : `the transaction did not reach a verdict ("${cause.message}"), which says nothing about the material, so it is retried on the backoff schedule`,
    };
  }

  if (data.startsWith(ERROR_STRING_SELECTOR)) {
    let message = "";
    try {
      const decoded = iface.decodeErrorResult("Error(string)", data);
      message = typeof decoded[0] === "string" ? decoded[0] : "";
    } catch {
      message = "";
    }
    const classification = classifyPrecompileRefusal(message);
    return {
      action: classification.action === "RETRY_ALTERNATE_BUILDER" ? "RETRY_ALTERNATE_BUILDER" : "SKIP",
      errorName: "Error(string)",
      args: [message],
      raw: data,
      recognised: classification.recognised,
      detail: classification.detail,
    };
  }

  try {
    const parsed = iface.parseError(data);
    if (parsed !== null) {
      const action = SUBMISSION_REFUSALS[parsed.name];
      const args = parsed.args.map((value) => String(value));
      if (action !== undefined) {
        return {
          action,
          errorName: parsed.name,
          args,
          raw: data,
          recognised: true,
          detail: `the chain refused with ${parsed.name}(${args.join(", ")}), whose action is ${action}`,
        };
      }
      return {
        action: "SKIP",
        errorName: parsed.name,
        args,
        raw: data,
        recognised: false,
        detail: `the chain refused with ${parsed.name}(${args.join(", ")}), which design section 13.2 does not name, so the Settlement is skipped and flagged rather than retried`,
      };
    }
  } catch {
    // fall through to the undecodable case
  }

  return {
    action: "SKIP",
    errorName: "UNDECODABLE",
    args: [],
    raw: data,
    recognised: false,
    detail: `the chain refused with revert data ${data.slice(0, 10)}... that no known ABI decodes, so the Settlement is skipped and flagged`,
  };
}

/** The interface every client and classifier shares. */
export const VERIFIER_INTERFACE = new Interface([...SETTLEMENT_VERIFIER_ABI]);

/** The tuple `ethers` encodes for one `SourceTx`. */
export function sourceTxTuple(material: ProofMaterial): readonly unknown[] {
  return [
    BigInt(material.chainKey),
    material.blockHeight,
    material.encodedTransaction,
    [material.merkleProof.root, material.merkleProof.siblings.map((sibling) => [sibling.hash, sibling.isLeft])],
    [material.continuityProof.lowerEndpointDigest, material.continuityProof.roots],
  ];
}

/** Calldata for one submission or one batch. Exported so the live harness can reuse it. */
export function encodeSubmission(materials: readonly ProofMaterial[]): string {
  if (materials.length === 1 && materials[0] !== undefined) {
    return VERIFIER_INTERFACE.encodeFunctionData("submitSettlement", [sourceTxTuple(materials[0])]);
  }
  return VERIFIER_INTERFACE.encodeFunctionData("submitSettlementBatch", [materials.map(sourceTxTuple)]);
}

/** A Settlement or Bond deposit the verifier recorded in one transaction. */
export interface RecordedSettlement {
  readonly kind: "settlement" | "bond-deposit";
  readonly replayKey: string;
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: bigint;
  readonly payerAddress: string;
}

/** What a keyless simulation established. */
export interface SimulationVerdict {
  readonly accepted: boolean;
  /** `ingestedLogs` as the contract would return it. */
  readonly ingestedLogs: bigint | undefined;
  readonly refusal: SubmissionRefusal | undefined;
}

/** What a broadcast produced. */
export interface SubmissionReceipt {
  readonly txHash: string;
  readonly blockNumber: number;
  readonly status: 0 | 1;
  readonly gasUsed: bigint;
  readonly gasLimit: bigint;
  /** Set when the transaction was mined with status 0 and the revert could be replayed. */
  readonly refusal: SubmissionRefusal | undefined;
  readonly recorded: readonly RecordedSettlement[];
}

/** The verifier surface the pipeline needs, narrow enough to fake. */
export interface SettlementVerifierClient {
  readonly address: string;
  /**
   * Whether the verifier already holds this replay key.
   *
   * `at` names the block to read at, defaulting to the pinned tag every other
   * read here uses. Reconciliation after a crash wants the pinned tag, because it
   * must not act on a block that may vanish. Confirming a submission this pass
   * just watched land must pass the receipt's own block: the pinned tag is
   * `finalized`, which lags `latest`, so a claim written seconds ago reads back
   * false and the row is sent round again to be refused `LogAlreadyClaimed` at
   * full cost. Measured on this deployment, and the same lag produced the false
   * decline the clearing reader was fixed for.
   */
  claimedLog(replayKey: string, at?: number): Promise<Result<boolean>>;
  /** `eth_call` from `from` with the exact calldata a broadcast would carry. */
  simulate(materials: readonly ProofMaterial[], from: string): Promise<Result<SimulationVerdict>>;
  /** Broadcasts and waits. Fails without a signer. */
  submit(materials: readonly ProofMaterial[]): Promise<Result<SubmissionReceipt>>;
}

function decodeIngested(data: string, single: boolean): bigint | undefined {
  try {
    const decoded = VERIFIER_INTERFACE.decodeFunctionResult(single ? "submitSettlement" : "submitSettlementBatch", data);
    return typeof decoded[0] === "bigint" ? decoded[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Parses the verifier's own events out of a receipt. Other contracts' logs are ignored. */
export function recordedSettlementsOf(receipt: TransactionReceipt, verifier: string): readonly RecordedSettlement[] {
  const recorded: RecordedSettlement[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== verifier.toLowerCase()) continue;
    let parsed;
    try {
      parsed = VERIFIER_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed === null) continue;
    if (parsed.name !== "SettlementRecorded" && parsed.name !== "BondDepositRecorded") continue;
    recorded.push({
      kind: parsed.name === "SettlementRecorded" ? "settlement" : "bond-deposit",
      replayKey: String(parsed.args[0]).toLowerCase(),
      agent: String(parsed.args[5]).toLowerCase(),
      serviceId: String(parsed.args[6]).toLowerCase(),
      asset: String(parsed.args[7]).toLowerCase(),
      amount: BigInt(String(parsed.args[8])),
      payerAddress: String(parsed.args[9]).toLowerCase(),
    });
  }
  return recorded;
}

/** How long a broadcast is waited for before the row is left `SUBMITTED` for reconciliation. */
export const RECEIPT_WAIT_MS = 180 * 1000;

/**
 * Gas for a submission. Estimated from a warm simulation, which under-counts cold
 * storage writes on this chain (task 12.2 measured a wiring call at 62,561
 * estimated against 101,535 needed), so the estimate is doubled and padded. When
 * estimation itself fails the fallback is a flat allowance per member, sized off
 * the 3,000,000 the live suite states for one Settlement.
 */
export function gasLimitFor(estimate: bigint | undefined, members: number): bigint {
  if (estimate !== undefined) return estimate * 2n + 100_000n;
  return 3_000_000n * BigInt(Math.max(1, members));
}

/**
 * Builds the client over one provider at one pinned tag, with a signer only when
 * the caller intends to broadcast.
 */
export function createSettlementVerifierClient(
  provider: JsonRpcProvider,
  address: string,
  blockTag: BlockTag,
  signer?: Signer,
): SettlementVerifierClient {
  const readError = (what: string, error: unknown): TabError => ({
    category: "UPSTREAM",
    code: "VERIFIER_READ_FAILED",
    message: `\`${what}\` could not be read from the SettlementVerifier`,
    retryable: true,
    cause: describeCause(error),
  });

  return {
    address,

    async claimedLog(replayKey, at) {
      try {
        const data = await provider.call({
          to: address,
          data: VERIFIER_INTERFACE.encodeFunctionData("claimedLog", [replayKey]),
          blockTag: at ?? blockTag,
        });
        const decoded = VERIFIER_INTERFACE.decodeFunctionResult("claimedLog", data);
        return ok(decoded[0] === true);
      } catch (error) {
        return err(readError("claimedLog", error));
      }
    },

    async simulate(materials, from) {
      if (materials.length === 0) {
        return err({ category: "VALIDATION", code: "EMPTY_SUBMISSION", message: "nothing to simulate", retryable: false });
      }
      const data = encodeSubmission(materials);
      try {
        const returned = await provider.call({ to: address, data, from, blockTag });
        return ok({ accepted: true, ingestedLogs: decodeIngested(returned, materials.length === 1), refusal: undefined });
      } catch (error) {
        const refusal = classifySubmissionFailure(error);
        if (refusal.errorName === "TRANSPORT") {
          return err({
            category: "UPSTREAM",
            code: "SIMULATION_UNREADABLE",
            message: `the simulation neither answered nor reverted: ${refusal.args[0] ?? ""}`,
            retryable: true,
          });
        }
        return ok({ accepted: false, ingestedLogs: undefined, refusal });
      }
    },

    async submit(materials) {
      if (signer === undefined) {
        return err({
          category: "VALIDATION",
          code: "WATCHER_KEY_MISSING",
          message: "a submission is a write and no signer was supplied, so this client is read-only",
          retryable: false,
        });
      }
      if (materials.length === 0) {
        return err({ category: "VALIDATION", code: "EMPTY_SUBMISSION", message: "nothing to submit", retryable: false });
      }
      const data = encodeSubmission(materials);
      const from = await signer.getAddress();

      let estimate: bigint | undefined;
      try {
        estimate = await provider.estimateGas({ to: address, data, from });
      } catch {
        estimate = undefined;
      }
      const gasLimit = gasLimitFor(estimate, materials.length);

      let txHash: string;
      try {
        const sent = await signer.sendTransaction({ to: address, data, gasLimit });
        txHash = sent.hash;
      } catch (error) {
        const refusal = classifySubmissionFailure(error);
        return err({
          category: refusal.action === "HALT" ? "AUTHORISATION" : "UPSTREAM",
          code: "SUBMISSION_NOT_BROADCAST",
          message: `the submission was not broadcast: ${refusal.detail}`,
          retryable: refusal.action !== "HALT",
          cause: describeCause(error),
        });
      }

      // `TransactionResponse.wait()` throws on a status-0 receipt, and a reverted
      // submission is an outcome this pipeline has to read, not an exception.
      let receipt: TransactionReceipt | null;
      try {
        receipt = await provider.waitForTransaction(txHash, 1, RECEIPT_WAIT_MS);
      } catch (error) {
        return err({
          category: "UPSTREAM",
          code: "SUBMISSION_RECEIPT_UNAVAILABLE",
          message: `submission ${txHash} was broadcast but its receipt could not be read; the rows stay SUBMITTED for reconciliation`,
          retryable: true,
          details: { txHash },
          cause: describeCause(error),
        });
      }
      if (receipt === null) {
        return err({
          category: "UPSTREAM",
          code: "SUBMISSION_RECEIPT_TIMEOUT",
          message: `submission ${txHash} was not mined within ${RECEIPT_WAIT_MS / 1000}s; the rows stay SUBMITTED for reconciliation`,
          retryable: true,
          details: { txHash },
        });
      }

      const status: 0 | 1 = receipt.status === 1 ? 1 : 0;
      let refusal: SubmissionRefusal | undefined;
      if (status === 0) {
        // A receipt carries no returndata; the revert is recovered by replaying the
        // identical call at the block the transaction landed in.
        try {
          await provider.call({ to: address, data, from, blockTag: receipt.blockNumber });
          refusal = {
            action: "RETRY",
            errorName: "TRANSPORT",
            args: ["the replay at the mined block succeeded, so the revert was not reproducible"],
            raw: undefined,
            recognised: false,
            detail:
              receipt.gasUsed === gasLimit
                ? `submission ${txHash} used exactly its gas limit of ${gasLimit}, which is the signature of an exhausted limit rather than a revert`
                : `submission ${txHash} reverted on chain but the replay at block ${receipt.blockNumber} succeeded, so the cause is not reproducible`,
          };
        } catch (error) {
          refusal = classifySubmissionFailure(error);
        }
      }

      return ok({
        txHash,
        blockNumber: receipt.blockNumber,
        status,
        gasUsed: receipt.gasUsed,
        gasLimit,
        refusal,
        recorded: status === 1 ? recordedSettlementsOf(receipt, address) : [],
      });
    },
  };
}

// ------------------------------------------------------------------ the sweep

/** One member ready to go, with the fresh material it will be submitted with. */
export interface SubmissionMember {
  readonly replayKey: string;
  readonly material: ProofMaterial;
  /** Attempts so far, from the row, so the backoff schedule continues rather than restarts. */
  readonly attempts: number;
}

/** What is written back onto one row after the sweep decided about it. */
export interface SubmissionOutcomeRecord {
  readonly replayKey: string;
  readonly state: SettlementState;
  readonly attempts: number;
  readonly nextAttemptAt: Date | undefined;
  readonly ccTxHash: string | undefined;
  readonly lastErrorCategory: string | undefined;
}

export interface SubmissionDeps {
  readonly client: SettlementVerifierClient;
  /** The address a broadcast would come from; simulation runs as it. */
  readonly from: string;
  /** False leaves the sweep keyless: it simulates, reports, and writes nothing. */
  readonly submit: boolean;
  /** Writes `SUBMITTED` for every key about to be broadcast. Called before the broadcast, always. */
  readonly markSubmitted: (replayKeys: readonly string[]) => Promise<Result<number>>;
  readonly recordOutcome: (record: SubmissionOutcomeRecord) => Promise<Result<number>>;
  readonly now?: () => Date;
  readonly backoff?: BackoffSchedule;
  readonly random?: () => number;
}

/** What happened to one member. */
export interface MemberOutcome {
  readonly replayKey: string;
  readonly state: SettlementState;
  readonly action: SubmissionAction | "CONFIRMED" | "WOULD_SUBMIT" | undefined;
  readonly txHash: string | undefined;
  readonly detail: string;
  readonly error: TabError | undefined;
}

export interface SubmissionReport {
  /** The whole-batch simulation, before any member was singled out. */
  readonly simulation: SimulationVerdict | undefined;
  readonly members: readonly MemberOutcome[];
  readonly txHashes: readonly string[];
  readonly confirmed: number;
  /** True when a HALT action fired; the caller stops this chain's pipeline. */
  readonly halted: boolean;
}

/** Twenty-four hours, the re-queue delay an unbound payer gets. */
const RETRY_AFTER_24H_MS = 24 * 60 * 60 * 1000;

/** How many scheduled retries a row gets before it is halted as never succeeding. */
export const MAX_SUBMIT_ATTEMPTS = 8;

/**
 * Turns an action into the row update it implies. Pure, so the table above is
 * testable without a chain.
 */
export function outcomeForAction(
  member: SubmissionMember,
  refusal: SubmissionRefusal,
  now: Date,
  schedule: BackoffSchedule,
  random: () => number,
): SubmissionOutcomeRecord {
  const attempts = member.attempts + 1;
  const category = `${refusal.action}:${refusal.errorName}`;
  switch (refusal.action) {
    case "RETRY":
      if (attempts >= MAX_SUBMIT_ATTEMPTS) {
        return { replayKey: member.replayKey, state: "HALTED", attempts, nextAttemptAt: undefined, ccTxHash: undefined, lastErrorCategory: `HALT:RETRIES_EXHAUSTED:${refusal.errorName}` };
      }
      return { replayKey: member.replayKey, state: "READY", attempts, nextAttemptAt: nextAttemptAt(now, attempts, schedule, random), ccTxHash: undefined, lastErrorCategory: category };
    case "RETRY_ALTERNATE_BUILDER":
      return { replayKey: member.replayKey, state: "WITHHELD", attempts, nextAttemptAt: undefined, ccTxHash: undefined, lastErrorCategory: category };
    case "RETRY_AFTER_24H":
      if (member.attempts >= 1) {
        return { replayKey: member.replayKey, state: "HALTED", attempts, nextAttemptAt: undefined, ccTxHash: undefined, lastErrorCategory: `SKIP:${refusal.errorName}` };
      }
      return { replayKey: member.replayKey, state: "READY", attempts, nextAttemptAt: new Date(now.getTime() + RETRY_AFTER_24H_MS), ccTxHash: undefined, lastErrorCategory: category };
    case "SKIP":
      return { replayKey: member.replayKey, state: "HALTED", attempts, nextAttemptAt: undefined, ccTxHash: undefined, lastErrorCategory: `SKIP:${refusal.errorName}` };
    case "HALT":
      return { replayKey: member.replayKey, state: "HALTED", attempts, nextAttemptAt: undefined, ccTxHash: undefined, lastErrorCategory: `HALT:${refusal.errorName}` };
    case "RECONCILE":
      // Decided by `claimedLog`, which the caller reads; until then the row is READY.
      return { replayKey: member.replayKey, state: "READY", attempts, nextAttemptAt: undefined, ccTxHash: undefined, lastErrorCategory: category };
  }
}

/**
 * Submits one planned batch, simulation first, fallback per member.
 *
 * The returned report is complete whether or not anything was broadcast, so a
 * read-only pass shows exactly what a submitting pass would have done.
 */
export async function submitBatch(deps: SubmissionDeps, members: readonly SubmissionMember[]): Promise<Result<SubmissionReport>> {
  const now = deps.now ?? (() => new Date());
  const schedule = deps.backoff ?? DEFAULT_BACKOFF;
  const random = deps.random ?? Math.random;
  const outcomes: MemberOutcome[] = [];
  const txHashes: string[] = [];
  let halted = false;
  let confirmed = 0;

  /** Applies a refusal to one member, writing the row when the sweep is live. */
  const refuse = async (member: SubmissionMember, refusal: SubmissionRefusal): Promise<void> => {
    if (refusal.action === "HALT") halted = true;
    let record = outcomeForAction(member, refusal, now(), schedule, random);
    if (refusal.action === "RECONCILE") {
      const claimed = await deps.client.claimedLog(member.replayKey);
      if (claimed.ok && claimed.value) {
        record = { ...record, state: "CONFIRMED", nextAttemptAt: undefined, lastErrorCategory: undefined };
        confirmed += 1;
      }
    }
    const written = deps.submit ? await deps.recordOutcome(record) : ok(0);
    outcomes.push({
      replayKey: member.replayKey,
      state: record.state,
      action: refusal.action,
      txHash: undefined,
      detail: refusal.detail,
      error: written.ok ? undefined : written.error,
    });
  };

  const confirm = async (member: SubmissionMember, txHash: string, atBlock?: number): Promise<void> => {
    // Read at the block the submission landed in, not at the pinned tag. See the
    // note on `claimedLog`: the pinned tag lags, and a claim read back false here
    // sends a settled row round again to be refused at full cost.
    const claimed = await deps.client.claimedLog(member.replayKey, atBlock);
    if (claimed.ok && claimed.value) {
      confirmed += 1;
      const written = await deps.recordOutcome({
        replayKey: member.replayKey,
        state: "CONFIRMED",
        attempts: member.attempts + 1,
        nextAttemptAt: undefined,
        ccTxHash: txHash,
        lastErrorCategory: undefined,
      });
      outcomes.push({ replayKey: member.replayKey, state: "CONFIRMED", action: "CONFIRMED", txHash, detail: `replay key ${member.replayKey} is claimed on chain in ${txHash}`, error: written.ok ? undefined : written.error });
      return;
    }
    // Mined, but the key is not claimed: the row goes back to READY, as design 8.6 says.
    const written = await deps.recordOutcome({
      replayKey: member.replayKey,
      state: "READY",
      attempts: member.attempts + 1,
      nextAttemptAt: nextAttemptAt(now(), member.attempts + 1, schedule, random),
      ccTxHash: undefined,
      lastErrorCategory: "RETRY:NOT_CLAIMED_AFTER_MINING",
    });
    outcomes.push({ replayKey: member.replayKey, state: "READY", action: "RETRY", txHash, detail: `transaction ${txHash} was mined but claimedLog(${member.replayKey}) is still false, so the row returns to READY`, error: claimed.ok ? (written.ok ? undefined : written.error) : claimed.error });
  };

  // 1. Simulate the whole batch, keylessly.
  const simulation = await deps.client.simulate(members.map((member) => member.material), deps.from);
  if (!simulation.ok) return err(simulation.error);

  let candidates: SubmissionMember[] = [...members];
  if (!simulation.value.accepted) {
    // Name the refused members one at a time; a batch refusal names nobody.
    candidates = [];
    for (const member of members) {
      const alone = await deps.client.simulate([member.material], deps.from);
      if (!alone.ok) return err(alone.error);
      if (alone.value.accepted) {
        candidates.push(member);
      } else if (alone.value.refusal !== undefined) {
        await refuse(member, alone.value.refusal);
      }
    }
  }

  if (candidates.length === 0) {
    return ok({ simulation: simulation.value, members: outcomes, txHashes, confirmed, halted });
  }

  if (!deps.submit) {
    for (const member of candidates) {
      outcomes.push({ replayKey: member.replayKey, state: "READY", action: "WOULD_SUBMIT", txHash: undefined, detail: `the simulation accepted ${member.replayKey}; a submitting pass would broadcast it`, error: undefined });
    }
    return ok({ simulation: simulation.value, members: outcomes, txHashes, confirmed, halted });
  }

  // 2. SUBMITTED before broadcast (R20.9).
  const marked = await deps.markSubmitted(candidates.map((member) => member.replayKey));
  if (!marked.ok) return err(marked.error);

  // 3. Broadcast the batch.
  const sent = await deps.client.submit(candidates.map((member) => member.material));
  if (!sent.ok) {
    // Not broadcast, or broadcast with an unreadable receipt. Rows stay SUBMITTED
    // only in the second case; the first returns them to READY on the schedule.
    const broadcast = sent.error.code === "SUBMISSION_RECEIPT_UNAVAILABLE" || sent.error.code === "SUBMISSION_RECEIPT_TIMEOUT";
    for (const member of candidates) {
      if (broadcast) {
        outcomes.push({ replayKey: member.replayKey, state: "SUBMITTED", action: "RETRY", txHash: String(sent.error.details?.["txHash"] ?? ""), detail: sent.error.message, error: sent.error });
        continue;
      }
      const record = outcomeForAction(member, { action: sent.error.category === "AUTHORISATION" ? "HALT" : "RETRY", errorName: "TRANSPORT", args: [sent.error.message], raw: undefined, recognised: false, detail: sent.error.message }, now(), schedule, random);
      if (record.state === "HALTED") halted = true;
      const written = await deps.recordOutcome(record);
      outcomes.push({ replayKey: member.replayKey, state: record.state, action: record.state === "HALTED" ? "HALT" : "RETRY", txHash: undefined, detail: sent.error.message, error: written.ok ? undefined : written.error });
    }
    return ok({ simulation: simulation.value, members: outcomes, txHashes, confirmed, halted });
  }

  txHashes.push(sent.value.txHash);
  if (sent.value.status === 1) {
    for (const member of candidates) await confirm(member, sent.value.txHash, sent.value.blockNumber);
    return ok({ simulation: simulation.value, members: outcomes, txHashes, confirmed, halted });
  }

  // 4. The batch reverted on chain after passing simulation: fall back to single
  //    submissions, each simulated again first (D16).
  for (const member of candidates) {
    const alone = await deps.client.simulate([member.material], deps.from);
    if (!alone.ok) {
      outcomes.push({ replayKey: member.replayKey, state: "SUBMITTED", action: "RETRY", txHash: undefined, detail: alone.error.message, error: alone.error });
      continue;
    }
    if (!alone.value.accepted && alone.value.refusal !== undefined) {
      await refuse(member, alone.value.refusal);
      continue;
    }
    const single = await deps.client.submit([member.material]);
    if (!single.ok) {
      outcomes.push({ replayKey: member.replayKey, state: "SUBMITTED", action: "RETRY", txHash: undefined, detail: single.error.message, error: single.error });
      continue;
    }
    txHashes.push(single.value.txHash);
    if (single.value.status === 1) {
      await confirm(member, single.value.txHash, single.value.blockNumber);
    } else {
      await refuse(member, single.value.refusal ?? { action: "RETRY", errorName: "TRANSPORT", args: [], raw: undefined, recognised: false, detail: `submission ${single.value.txHash} reverted and the cause could not be replayed` });
    }
  }
  return ok({ simulation: simulation.value, members: outcomes, txHashes, confirmed, halted });
}

/** A row left `SUBMITTED` whose on-chain state is unknown. */
export interface SubmittedRow {
  readonly replayKey: string;
  readonly attempts: number;
  readonly ccTxHash: string | undefined;
}

export interface ReconciliationReport {
  readonly confirmed: readonly string[];
  readonly returnedToReady: readonly string[];
  readonly unreadable: readonly { readonly replayKey: string; readonly error: TabError }[];
}

/**
 * Settles every `SUBMITTED` row from `claimedLog` (design section 8.6). Claimed
 * means the chain saw the submission and the row is `CONFIRMED`; unclaimed means
 * it never landed and the row returns to `READY` under the same replay key, which
 * is safe because at most one submission of that key can ever be claimed.
 */
export async function reconcileSubmitted(
  client: SettlementVerifierClient,
  rows: readonly SubmittedRow[],
  recordOutcome: (record: SubmissionOutcomeRecord) => Promise<Result<number>>,
  dryRun = false,
): Promise<ReconciliationReport> {
  const confirmed: string[] = [];
  const returnedToReady: string[] = [];
  const unreadable: { replayKey: string; error: TabError }[] = [];

  for (const row of rows) {
    const claimed = await client.claimedLog(row.replayKey);
    if (!claimed.ok) {
      unreadable.push({ replayKey: row.replayKey, error: claimed.error });
      continue;
    }
    const record: SubmissionOutcomeRecord = claimed.value
      ? { replayKey: row.replayKey, state: "CONFIRMED", attempts: row.attempts, nextAttemptAt: undefined, ccTxHash: row.ccTxHash, lastErrorCategory: undefined }
      : { replayKey: row.replayKey, state: "READY", attempts: row.attempts, nextAttemptAt: undefined, ccTxHash: undefined, lastErrorCategory: "RECONCILED:NOT_CLAIMED" };
    if (!dryRun) {
      const written = await recordOutcome(record);
      if (!written.ok) {
        unreadable.push({ replayKey: row.replayKey, error: written.error });
        continue;
      }
    }
    (claimed.value ? confirmed : returnedToReady).push(row.replayKey);
  }
  return { confirmed, returnedToReady, unreadable };
}
