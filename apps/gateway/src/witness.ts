/**
 * The `LimitWitness`, rebuilt from chain logs.
 *
 * `TabBook.recordDelivery` will not charge an Agent without one. The witness is
 * the Agent's full ordered Verified Settlement history plus one Bond entry per
 * counterparty Service, and `TabBook` validates it against the rolling commitment
 * before it computes anything, so a witness that is wrong by one field is not a
 * slightly wrong Credit Limit. It is a reverted charge and an unmetered delivery.
 *
 * ## Why the history is read from logs rather than from storage
 *
 * `TabBook` commits the history to a rolling hash and keeps no array of it, which
 * is deliberate: an unbounded per-Agent array on chain is exactly what design
 * decision 20 forbids. The records themselves ride out on `HistoryExtended`, which
 * carries the appended `SettlementRecord` in full and is indexed by Agent and by
 * Asset. That event exists so a third party can rebuild the witness from logs
 * alone, and this module is a third party doing precisely that.
 *
 * The fold is `TabBook._fold`, field for field:
 * `keccak256(abi.encode(previousRoot, serviceId, asset, amount, settledAt,
 * firstDeliveryAt, chainKey, curated, bonded))`. Every field of the record is
 * bound, which is what stops a caller flipping `curated` or `bonded` to
 * manufacture credit through the very commitment meant to prevent it.
 *
 * `apps/registry/src/credit.ts` performs the same reconstruction from indexed rows
 * and folds to the same root. Both were checked against the same live Agent and
 * agree with `TabBook.historyCommitment` on chain, which is the only check that
 * matters: two independent readers reaching the contract's own answer.
 *
 * ## The bond half is smaller than it looks
 *
 * `TabBook._resolveBonds` **discards the amount the caller supplies** and replaces
 * it with `_stakedOf(serviceId, asset)` read from the `Bond` ledger. So a witness
 * only has to name the right `(serviceId, asset)` pairs, each at most once, and
 * each a genuine counterparty of this Agent. Supplying a real staked figure is
 * still worth doing, because it lets a caller compute the same Credit Limit
 * locally and notice a disagreement before spending gas, but it is never trusted.
 *
 * Requirements: 12.1, 12.3, 13.1, 13.2, 17.2, 17.3
 */

import { AbiCoder, Interface, keccak256, type JsonRpcProvider } from "ethers";

import { causeOf, err, ok, type Result, type TabError } from "@tabai/shared";

/** `LimitLib.SettlementRecord`, as `HistoryExtended` carries it. */
export interface SettlementRecord {
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: bigint;
  readonly settledAt: bigint;
  /** Zero means no Metered Delivery preceded the Settlement. (R17.3) */
  readonly firstDeliveryAt: bigint;
  readonly chainKey: bigint;
  readonly curated: boolean;
  readonly bonded: boolean;
}

/** `LimitLib.BondEntry`. The amount is advisory; the contract reads its own. */
export interface BondEntry {
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: bigint;
}

/** `TabBook.LimitWitness`. */
export interface LimitWitness {
  readonly history: readonly SettlementRecord[];
  readonly bonds: readonly BondEntry[];
}

/** The 32-byte zero word the rolling commitment starts from. */
export const ZERO_ROOT = `0x${"00".repeat(32)}`;

/**
 * The Creditcoin RPC's `eth_getLogs` query timeout, measured rather than assumed.
 *
 * The endpoint answers `-32603: query timeout of 10 seconds exceeded` and it is a
 * **time** bound, not a block-range cap: the full span from the deployment block to
 * the head, carrying this module's exact four-topic filter, served fine when asked
 * for a pinned numeric `toBlock`, while the same query against `latest` timed out
 * outright and the failure recurred under load.
 *
 * That distinction is why this module chunks. A range cap would be a fixed ceiling
 * to sit under; a time bound moves with how busy the node is, so a span that works
 * three times running can fail the fourth. And the span only grows, because the
 * scan starts at a fixed deployment block while the head advances every few
 * seconds, so an unchunked read is a query that gets slower forever until no Agent
 * can be metered at all.
 */
export const GET_LOGS_TIMEOUT_SECONDS = 10;

/** Blocks per `eth_getLogs` request before any narrowing. */
export const HISTORY_CHUNK_MAX = 2_000;

/** Narrowest window the scan will ask for. A refusal here cannot be narrowed away. */
export const HISTORY_CHUNK_MIN = 1;

/**
 * How the endpoint says "that query took too long", measured on this RPC.
 *
 * Matched on the decoded message rather than on a JSON-RPC code, because `-32603`
 * is the generic internal-error code and carries no information on its own. A
 * timeout is retryable at a narrower window; anything else is not, and narrowing on
 * an unrelated fault would spend ten halvings learning nothing.
 */
export const QUERY_TIMEOUT_PATTERNS: readonly RegExp[] = [
  /query timeout/i,
  /timeout of \d+ seconds exceeded/i,
  // Kept beside the measured phrase because several endpoints in this project
  // report a width refusal instead, and the response to both is the same: narrow.
  /query returned more than/i,
  /response size exceeded/i,
  /block range/i,
];

/** Whether a failed read is worth retrying at a narrower window. */
export function isNarrowable(error: unknown): boolean {
  const { message } = causeOf(error);
  const extra =
    typeof error === "object" && error !== null && "shortMessage" in error
      ? String((error as { shortMessage?: unknown }).shortMessage ?? "")
      : "";
  const text = `${message} ${extra}`;
  return QUERY_TIMEOUT_PATTERNS.some((pattern) => pattern.test(text));
}

/** Halves a window, never below the floor. Mirrors the Watcher's own helper. */
export const shrinkWindow = (size: number, min: number): number => Math.max(min, Math.floor(size / 2));

/** Doubles a window after a clean pass, never above the ceiling. */
export const growWindow = (size: number, max: number): number => Math.min(max, size * 2);

/** `LimitLib.MAX_HISTORY`, past which the library refuses to compute. */
export const MAX_HISTORY = 512;

/** `LimitLib.MAX_COUNTERPARTIES`. */
export const MAX_COUNTERPARTIES = 32;

const CODER = AbiCoder.defaultAbiCoder();

/**
 * The reads and the one event this module needs.
 *
 * Component order is wire order. `HistoryExtended`'s record is a tuple and is
 * decoded positionally, so reordering a field here still compiles and silently
 * produces a root that matches nothing.
 */
export const HISTORY_ABI = [
  "event HistoryExtended(address indexed agent, address indexed asset, bytes32 root, uint32 count, (bytes32 serviceId, address asset, uint128 amount, uint64 settledAt, uint64 firstDeliveryAt, uint64 chainKey, bool curated, bool bonded) record)",
  "function historyCommitment(address agent, address asset) view returns (bytes32 root, uint32 count)",
] as const;

export const HISTORY_INTERFACE = new Interface([...HISTORY_ABI]);

/** `Bond.ledgerOf`, for the advisory staked figure. */
export const BOND_ABI = [
  "function partyOf(address account) pure returns (bytes32 party)",
  "function ledgerOf(bytes32 party, address asset) view returns ((uint128 staked, uint128 reserved, uint128 slashed, uint128 released) ledger)",
] as const;

/**
 * `ServiceRegistry.serviceOf`, to reach a Service's bond account.
 *
 * **The struct carries no leading `serviceId`, and assuming one reads every field
 * a place out.** Measured: with a spurious `serviceId` at the front, `bondAccount`
 * resolved to `registeredAt`, `partyOf` was handed a timestamp, and the ledger came
 * back `staked: 0` for a party that holds 5,000,000. Nothing reverts and nothing
 * warns, because every field is still the right width; the Credit Limit simply
 * computes against a bond cap of zero. The order below is the contract's own.
 */
export const SERVICE_ABI = [
  "function serviceOf(bytes32 serviceId) view returns ((address operator, uint8 tier, uint32 settlementWindow, address bondAccount, uint64 registeredAt, bool exists) service)",
] as const;

/** Field positions in {@link SERVICE_ABI}'s tuple, named so an index is never guessed. */
export const SERVICE_FIELD = {
  operator: 0,
  tier: 1,
  settlementWindow: 2,
  bondAccount: 3,
  registeredAt: 4,
  exists: 5,
} as const;

/**
 * `TabBook._fold`, exactly.
 *
 * Any divergence here is undetectable by inspection and fatal in use, so the
 * encoding is written out in the contract's own order and the test asserts it
 * against a root the chain produced rather than one this file produced.
 */
export function foldRoot(previousRoot: string, record: SettlementRecord): string {
  return keccak256(
    CODER.encode(
      ["bytes32", "bytes32", "address", "uint128", "uint64", "uint64", "uint64", "bool", "bool"],
      [
        previousRoot,
        record.serviceId,
        record.asset,
        record.amount,
        record.settledAt,
        record.firstDeliveryAt,
        record.chainKey,
        record.curated,
        record.bonded,
      ],
    ),
  ).toLowerCase();
}

/** The rolling commitment over an ordered history, as `historyCommitment` reports it. */
export function commitmentOf(history: readonly SettlementRecord[]): {
  readonly root: string;
  readonly count: number;
} {
  let root = ZERO_ROOT;
  for (const record of history) root = foldRoot(root, record);
  return { root, count: history.length };
}

/**
 * The distinct counterparties of a history, in first-appearance order.
 *
 * One entry per `(serviceId, asset)` pair, because `_resolveBonds` reverts
 * `DuplicateBondEntry` on a repeat and `IneligibleBondEntry` on a Service that
 * never settled with this Agent in this Asset.
 */
export function counterpartiesOf(
  history: readonly SettlementRecord[],
  asset: string,
): readonly string[] {
  const scoped = asset.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const record of history) {
    if (record.asset.toLowerCase() !== scoped) continue;
    const key = record.serviceId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record.serviceId);
  }
  return out;
}

function readFailed(what: string, error: unknown): TabError {
  return {
    category: "UPSTREAM",
    code: "CHAIN_READ_FAILED",
    message: `\`${what}\` could not be read from Creditcoin`,
    retryable: true,
    cause: causeOf(error),
  };
}

/** One log as `eth_getLogs` returns it, declared so a test can build one plainly. */
export interface RawLog {
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: number;
  readonly logIndex: number;
}

/**
 * Decodes one `HistoryExtended` log into its record and its position.
 *
 * The count the event carries is the authority on order, not the log's position
 * in the response: `count` is assigned by the contract as it appends, so sorting
 * on it reconstructs the exact sequence the commitment was folded over even if
 * the logs come back out of order or span a reorganisation rewrite.
 */
export function recordFromLog(log: RawLog): Result<{ readonly count: number; readonly record: SettlementRecord }> {
  try {
    const parsed = HISTORY_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed === null || parsed.name !== "HistoryExtended") {
      return err({
        category: "VALIDATION",
        code: "HISTORY_LOG_UNRECOGNISED",
        message: "a log offered to the witness builder is not a HistoryExtended",
        retryable: false,
      });
    }
    const raw = parsed.args["record"] as unknown as readonly unknown[];
    return ok({
      count: Number(parsed.args["count"]),
      record: {
        serviceId: String(raw[0]).toLowerCase(),
        asset: String(raw[1]).toLowerCase(),
        amount: BigInt(raw[2] as bigint),
        settledAt: BigInt(raw[3] as bigint),
        firstDeliveryAt: BigInt(raw[4] as bigint),
        chainKey: BigInt(raw[5] as bigint),
        curated: raw[6] === true,
        bonded: raw[7] === true,
      },
    });
  } catch (error) {
    return err({
      category: "CHAIN",
      code: "HISTORY_LOG_UNDECODABLE",
      message: "a HistoryExtended log could not be decoded with the pinned ABI",
      retryable: false,
      cause: causeOf(error),
    });
  }
}

/** What the witness builder needs from the chain, narrow enough to fake. */
export interface WitnessReader {
  /** Every `HistoryExtended` log for one Agent and Asset, in any order. */
  historyLogs(agent: string, asset: string): Promise<Result<readonly RawLog[]>>;
  /** `TabBook.historyCommitment`, the answer the rebuilt history must reproduce. */
  commitment(agent: string, asset: string): Promise<Result<{ root: string; count: number }>>;
  /** `Bond` staked for one Service in one Asset. Advisory only. */
  staked(serviceId: string, asset: string): Promise<Result<bigint>>;
  /** The address `ServiceRegistry` holds as the Service's operator. */
  operatorOf(serviceId: string): Promise<Result<string>>;
}

/**
 * Builds the reader over a provider pinned to one block tag.
 *
 * Every read is pinned, so one witness is assembled from one view of Creditcoin.
 * Mixing tags across the history read and the commitment read would let a
 * Settlement land between them and produce a witness that cannot fold to the
 * commitment it is checked against, which presents as a mysterious revert.
 */
export function createWitnessReader(
  provider: JsonRpcProvider,
  addresses: { readonly tabBook: string; readonly bond: string; readonly serviceRegistry: string },
  blockTag: string | number,
  fromBlock: number,
): WitnessReader {
  const bondInterface = new Interface([...BOND_ABI]);
  const serviceInterface = new Interface([...SERVICE_ABI]);

  const call = async (to: string, data: string, what: string): Promise<Result<string>> => {
    try {
      return ok(await provider.call({ to, data, blockTag }));
    } catch (error) {
      return err(readFailed(what, error));
    }
  };

  return {
    /**
     * Every `HistoryExtended` log for one Agent and Asset, read in chunks.
     *
     * Chunked because the endpoint bounds this query by **time** rather than by
     * block range; see {@link GET_LOGS_TIMEOUT_SECONDS}. One unchunked read from
     * the deployment block was measured succeeding three times and failing once,
     * and the span it covers grows every block, so it fails more often over time
     * rather than settling. A timeout that loses the whole scan means no witness,
     * which means no Agent can be metered at all.
     *
     * The window narrows on a timeout and **retries the same chunk** rather than
     * moving past it, because a skipped chunk is a dropped `HistoryExtended` record
     * and a witness missing one record cannot fold to the commitment. It widens
     * again after a clean pass, so a single slow moment costs round trips rather
     * than permanently narrowing the scan.
     *
     * The upper bound is resolved to a number once, so every chunk reads against
     * one view of the chain. Asking for `latest` per chunk would let the head move
     * underneath the scan, and it is also the exact form measured to time out.
     */
    async historyLogs(agent, asset): Promise<Result<readonly RawLog[]>> {
      const topic = HISTORY_INTERFACE.getEvent("HistoryExtended")?.topicHash;
      if (topic === undefined) {
        return err({
          category: "INTERNAL",
          code: "HISTORY_TOPIC_UNKNOWN",
          message: "the pinned ABI does not declare HistoryExtended",
          retryable: false,
        });
      }
      const pad = (value: string): string => `0x${value.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
      const filter = { address: addresses.tabBook, topics: [topic, pad(agent), pad(asset)] };

      let head: number;
      if (typeof blockTag === "number") {
        head = blockTag;
      } else {
        try {
          const block = await provider.getBlock(blockTag);
          if (block === null) return err(readFailed(`getBlock(${String(blockTag)})`, new Error("no block")));
          head = block.number;
        } catch (error) {
          return err(readFailed(`getBlock(${String(blockTag)})`, error));
        }
      }

      const collected: RawLog[] = [];
      let size = HISTORY_CHUNK_MAX;
      let from = fromBlock;

      while (from <= head) {
        const to = Math.min(head, from + size - 1);
        let page: unknown;
        try {
          page = await provider.send("eth_getLogs", [
            { ...filter, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` },
          ]);
        } catch (error) {
          if (isNarrowable(error) && size > HISTORY_CHUNK_MIN) {
            size = shrinkWindow(size, HISTORY_CHUNK_MIN);
            continue;
          }
          return err({
            ...readFailed("eth_getLogs", error),
            message:
              size <= HISTORY_CHUNK_MIN
                ? `\`eth_getLogs\` was refused even at a ${size}-block window over blocks ${from} to ${to}, which is the floor, so narrowing further is not possible`
                : `\`eth_getLogs\` failed over blocks ${from} to ${to} for a reason narrowing cannot fix`,
            details: { fromBlock: from, toBlock: to, window: size },
          });
        }

        if (!Array.isArray(page)) return err(readFailed("eth_getLogs", new Error("not an array")));
        for (const entry of page) {
          const log = entry as Record<string, unknown>;
          collected.push({
            topics: (log["topics"] as string[]) ?? [],
            data: String(log["data"] ?? "0x"),
            blockNumber: Number(log["blockNumber"]),
            logIndex: Number(log["logIndex"]),
          });
        }

        from = to + 1;
        size = growWindow(size, HISTORY_CHUNK_MAX);
      }

      return ok(collected);
    },

    async commitment(agent, asset): Promise<Result<{ root: string; count: number }>> {
      const data = HISTORY_INTERFACE.encodeFunctionData("historyCommitment", [agent, asset]);
      const returned = await call(addresses.tabBook, data, "historyCommitment");
      if (!returned.ok) return returned;
      const decoded = HISTORY_INTERFACE.decodeFunctionResult("historyCommitment", returned.value);
      return ok({ root: String(decoded[0]).toLowerCase(), count: Number(decoded[1]) });
    },

    async staked(serviceId, asset): Promise<Result<bigint>> {
      const serviceData = serviceInterface.encodeFunctionData("serviceOf", [serviceId]);
      const service = await call(addresses.serviceRegistry, serviceData, "serviceOf");
      if (!service.ok) return service;
      const record = serviceInterface.decodeFunctionResult("serviceOf", service.value)[0] as readonly unknown[];
      const bondAccount = String(record[SERVICE_FIELD.bondAccount]);

      const partyData = bondInterface.encodeFunctionData("partyOf", [bondAccount]);
      const party = await call(addresses.bond, partyData, "partyOf");
      if (!party.ok) return party;
      const partyWord = String(bondInterface.decodeFunctionResult("partyOf", party.value)[0]);

      const ledgerData = bondInterface.encodeFunctionData("ledgerOf", [partyWord, asset]);
      const ledger = await call(addresses.bond, ledgerData, "ledgerOf");
      if (!ledger.ok) return ledger;
      const fields = bondInterface.decodeFunctionResult("ledgerOf", ledger.value)[0] as readonly unknown[];
      return ok(BigInt(fields[0] as bigint));
    },

    async operatorOf(serviceId): Promise<Result<string>> {
      const data = serviceInterface.encodeFunctionData("serviceOf", [serviceId]);
      const service = await call(addresses.serviceRegistry, data, "serviceOf");
      if (!service.ok) return service;
      const record = serviceInterface.decodeFunctionResult("serviceOf", service.value)[0] as readonly unknown[];
      return ok(String(record[SERVICE_FIELD.operator]).toLowerCase());
    },
  };
}

/**
 * Checks the configured key against the operator the registry actually holds.
 *
 * `TabBook.recordDelivery` opens with `_requireOperator`, which compares `msg.sender`
 * against `ServiceRegistry.serviceOf(serviceId).operator` for exact equality. There is
 * no operator setter and no `Operator` change kind, so the operator is fixed at
 * registration and a Service's software must hold that key or it can do nothing.
 *
 * Without this check the mismatch surfaces as a `NotServiceOperator` revert from a
 * broadcast, which costs gas, arrives late, and reads like a contract problem. It was
 * a real confusion on this deployment: the environment shipped a distinct key per
 * process, which looks like good hygiene and is wrong here, because the gateway and
 * the Proof Service are two processes of **one** Service and one Service has one
 * operator. Every delivery that had actually landed was signed by the operator, and
 * neither service key could have signed one.
 *
 * A keyless simulation cannot catch it either, because `eth_call` is made with the
 * operator address as `from`, so the simulated call passes and the broadcast does not.
 */
export async function checkOperatorKey(
  reader: WitnessReader,
  serviceId: string,
  signerAddress: string,
): Promise<Result<string>> {
  const operator = await reader.operatorOf(serviceId);
  if (!operator.ok) return operator;
  if (operator.value !== signerAddress.toLowerCase()) {
    return err({
      category: "AUTHORISATION",
      code: "NOT_SERVICE_OPERATOR",
      message:
        `the configured key signs as ${signerAddress.toLowerCase()}, but ServiceRegistry holds ` +
        `${operator.value} as the operator of ${serviceId}. TabBook.recordDelivery requires exact ` +
        "equality and the operator cannot be reassigned, so this key must be the operator's",
      retryable: false,
      details: { serviceId, configured: signerAddress.toLowerCase(), operator: operator.value },
    });
  }
  return ok(operator.value);
}

/** A rebuilt witness, with the evidence that it is the one the contract will accept. */
export interface BuiltWitness {
  readonly witness: LimitWitness;
  /** The commitment the rebuilt history folds to. */
  readonly rebuilt: { readonly root: string; readonly count: number };
  /** The commitment `TabBook` reports. Equal to {@link rebuilt}, or the build failed. */
  readonly onChain: { readonly root: string; readonly count: number };
}

/**
 * Rebuilds the witness for one Agent and Asset and proves it against the chain.
 *
 * The fold is checked before the witness is returned, and a mismatch is an error
 * rather than a warning. That check is the whole value of this module: a witness
 * that does not fold is refused here, for free, instead of by `recordDelivery`
 * after the gas is spent and with a delivery already handed to the Agent.
 */
export async function buildWitness(
  reader: WitnessReader,
  agent: string,
  asset: string,
): Promise<Result<BuiltWitness>> {
  const logs = await reader.historyLogs(agent, asset);
  if (!logs.ok) return logs;

  const decoded: { count: number; record: SettlementRecord }[] = [];
  for (const log of logs.value) {
    const one = recordFromLog(log);
    if (!one.ok) return one;
    decoded.push(one.value);
  }
  // `count` is assigned by the contract on append, so it is the order the
  // commitment was folded over, whatever order the logs arrived in or in however
  // many chunks they were fetched.
  decoded.sort((left, right) => left.count - right.count);

  // A chunked scan can in principle repeat a chunk or lose one, and either would
  // otherwise surface as an unexplained commitment mismatch further down. The
  // contract assigns `count` as 1, 2, 3 and so on per Agent and Asset, so checking
  // the run is exactly that turns a vague mismatch into the record that is missing.
  for (const [position, entry] of decoded.entries()) {
    const expected = position + 1;
    if (entry.count === expected) continue;
    return err({
      category: entry.count < expected ? "CONFLICT" : "UPSTREAM",
      code: entry.count < expected ? "HISTORY_RECORD_DUPLICATED" : "HISTORY_RECORD_MISSING",
      message:
        entry.count < expected
          ? `the history scan returned record ${entry.count} more than once, so a chunk was read twice`
          : `the history scan jumped from record ${expected - 1} to ${entry.count}, so record ${expected} was not returned and the witness would be incomplete`,
      retryable: true,
      details: { expected, received: entry.count },
    });
  }

  const history = decoded.map((entry) => entry.record);

  if (history.length > MAX_HISTORY) {
    return err({
      category: "LIMIT",
      code: "HISTORY_TOO_LONG",
      message: `this Agent holds ${history.length} Verified Settlements in this Asset, past the ${MAX_HISTORY} LimitLib will compute over, so the history needs compaction`,
      retryable: false,
      details: { length: history.length, max: MAX_HISTORY },
    });
  }

  const onChain = await reader.commitment(agent, asset);
  if (!onChain.ok) return onChain;

  const rebuilt = commitmentOf(history);
  if (rebuilt.root !== onChain.value.root.toLowerCase() || rebuilt.count !== onChain.value.count) {
    return err({
      category: "CONFLICT",
      code: "WITNESS_COMMITMENT_MISMATCH",
      message: `the history rebuilt from HistoryExtended folds to ${rebuilt.root} over ${rebuilt.count} records, and TabBook holds ${onChain.value.root} over ${onChain.value.count}, so this witness would be refused on chain`,
      retryable: true,
      details: {
        rebuiltRoot: rebuilt.root,
        rebuiltCount: rebuilt.count,
        onChainRoot: onChain.value.root,
        onChainCount: onChain.value.count,
      },
    });
  }

  const counterparties = counterpartiesOf(history, asset);
  if (counterparties.length > MAX_COUNTERPARTIES) {
    return err({
      category: "LIMIT",
      code: "TOO_MANY_COUNTERPARTIES",
      message: `this Agent has ${counterparties.length} counterparties in this Asset, past the ${MAX_COUNTERPARTIES} LimitLib will compute over`,
      retryable: false,
    });
  }

  const bonds: BondEntry[] = [];
  for (const serviceId of counterparties) {
    const staked = await reader.staked(serviceId, asset);
    if (!staked.ok) return staked;
    bonds.push({ serviceId, asset, amount: staked.value });
  }

  return ok({ witness: { history, bonds }, rebuilt, onChain: onChain.value });
}
