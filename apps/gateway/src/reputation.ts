/**
 * ERC-8004 reputation: after each Settlement a Service receives, the Service
 * writes one feedback entry about the Agent that paid it.
 *
 * ## What this is, and what it is not
 *
 * An Agent's repayment record already exists on Monad as `Settled` events, and
 * the Credit Limit is a pure function of them. What it lacks is a place where
 * anyone who does not read Tab's contracts can find it. The ERC-8004 Reputation
 * registry is that place: a feedback entry per Settlement, from the Service that
 * was paid, keyed by the Agent's ERC-8004 agentId, readable with `getSummary`.
 *
 * **This feedback is a derived signal and plays no part in the Credit Limit.**
 * Nothing in `TabBook`, `LimitLib` or this gateway's metering reads it back.
 * It restates a fact the chain already holds, and each entry's `feedbackURI`
 * names the Settlement so a reader can check it against the `Settled` event.
 *
 * ## The entry
 *
 * `TAB_SETTLEMENT_FEEDBACK` in `@tabai/shared`: value `100` at zero decimals,
 * `tag1` `tab`, `tag2` `settled`, one entry per Settlement. The value never
 * varies, so the count is the signal and the mean is not. `endpoint` is this
 * gateway's public URL, `feedbackURI` is `<public URL>/reputation/<settlementId>`,
 * which this gateway serves, and `feedbackHash` is the keccak-256 of exactly
 * the bytes served there. The document is a pure function of the Settlement
 * row and its block's timestamp, so the hash still matches whenever it is read.
 *
 * ## What the deployed registry allows (ReputationRegistryUpgradeable 2.0.0)
 *
 * - `giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1,
 *   string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)`.
 *   No authorisation from the Agent is needed or accepted: any address may rate
 *   any agent that exists.
 * - Except the agent's own owner or approved operator: the registry reverts
 *   `Self-feedback not allowed` when `isAuthorizedOrOwner(msg.sender, agentId)`.
 *   An agent minted by the Service operator's key therefore cannot be rated by
 *   that Service until the Agent holds its own identity. The simulation below
 *   names that case and the writer skips the agent rather than paying for it.
 * - The rated agent must exist; an unknown agentId reverts.
 * - Only value, decimals and the two tags are stored. `endpoint`, `feedbackURI`
 *   and `feedbackHash` live only in the `NewFeedback` event.
 *
 * ## Idempotent across restarts, with no storage of its own
 *
 * The gateway keeps nothing on disk, and the registry cannot be asked "did I
 * rate Settlement X" because the URI is not stored. It can be asked how many
 * entries this operator wrote about the agent under Tab's tags
 * (`readAllFeedback(agentId, [operator], "tab", "settled", true)`, revoked
 * ones included since they were written). Entries are written one Settlement
 * at a time, oldest first, stopping at the first that fails, so that count is
 * exactly how many of the agent's Settlements to this Service (in chain order)
 * already have one, and the rest are what remains. A transaction sent but not
 * yet mined is held in memory and the agent is left alone until its receipt
 * answers. The one gap is a restart inside that window, which Monad's
 * one-second finality makes narrow; the worst outcome is one duplicate entry.
 *
 * ## Never in the way of metering
 *
 * The writer runs on its own timer, one tick at a time, and nothing a request
 * does waits on it. A registry read, an RPC read or a write that fails is
 * logged and retried on a later tick. It shares the operator key with
 * metering, so it sends one transaction at a time and waits for its receipt
 * before the next. Gas is estimated and padded, as every other write here, and
 * clamped, because Monad charges the stated limit rather than the gas used.
 */

import { Interface, keccak256, toUtf8Bytes, type JsonRpcProvider, type Signer } from "ethers";
import {
  ERC8004_REPUTATION_REGISTRY_ABI,
  TAB_SETTLEMENT_FEEDBACK,
  causeOf,
  erc8004RegistriesFor,
  err,
  ok,
  type Result,
  type TabError,
} from "@tabai/shared";

const REPUTATION_INTERFACE = new Interface([...ERC8004_REPUTATION_REGISTRY_ABI, "error Error(string)"]);

/**
 * The most gas a feedback write is ever stated with, and the least.
 *
 * A first entry from a new client measured 299,924 on Testnet (it appends the
 * client to the agent's list and stores two strings); later ones cost less.
 * The estimate is padded by {@link REPUTATION_GAS_MARGIN_BPS} and clamped
 * between these two, and an estimate that cannot be made states the ceiling.
 */
export const REPUTATION_GAS_LIMIT = 600_000n;
export const REPUTATION_GAS_FLOOR = 200_000n;
export const REPUTATION_GAS_MARGIN_BPS = 3_000n;

/** How long a write waits for its receipt before the next tick picks it up instead. */
export const REPUTATION_RECEIPT_WAIT_MS = 60_000;

/** How often the writer looks for new Settlements, by default. */
export const REPUTATION_INTERVAL_MS = 60_000;

/** Every this many ticks, every Agent is looked at again: an identity registered or transferred since, a write that failed. */
export const REPUTATION_RECHECK_TICKS = 30;

/** The registry's page size ceiling, so a catch-up takes as few reads as it can. */
const PAGE_SIZE = 200;

// ------------------------------------------------------------------ settlements

/** A Settlement to this Service, as the registry serves it, narrowed to what the feedback describes. */
export interface FeedbackSettlement {
  readonly settlementId: string;
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: string;
  readonly applied: string;
  readonly toPrepaid: string;
  readonly collection: string;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly logIndex: number;
}

const isWord = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const isAddress = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const isDigits = (value: unknown): value is string => typeof value === "string" && /^[0-9]+$/.test(value);
const isIndex = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** One registry Settlement row, checked field by field, or `undefined` for a row of the wrong shape. */
export function settlementFromBody(value: unknown): FeedbackSettlement | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const monad = row["monad"] as Record<string, unknown> | undefined;
  if (typeof monad !== "object" || monad === null) return undefined;
  if (!isWord(row["settlementId"]) || !isAddress(row["agent"]) || !isWord(row["serviceId"]) || !isAddress(row["asset"])) return undefined;
  if (!isDigits(row["amount"]) || !isDigits(row["applied"]) || !isDigits(row["toPrepaid"]) || !isAddress(row["collection"])) return undefined;
  if (!isWord(monad["txHash"]) || !isIndex(monad["blockNumber"]) || !isIndex(monad["logIndex"])) return undefined;
  return {
    settlementId: row["settlementId"].toLowerCase(),
    agent: row["agent"].toLowerCase(),
    serviceId: row["serviceId"].toLowerCase(),
    asset: row["asset"].toLowerCase(),
    amount: row["amount"],
    applied: row["applied"],
    toPrepaid: row["toPrepaid"],
    collection: row["collection"].toLowerCase(),
    txHash: monad["txHash"].toLowerCase(),
    blockNumber: monad["blockNumber"],
    logIndex: monad["logIndex"],
  };
}

const chainOrder = (left: FeedbackSettlement, right: FeedbackSettlement): number =>
  left.blockNumber - right.blockNumber || left.logIndex - right.logIndex;

// ------------------------------------------------------------------ the document

/**
 * The feedback document for one Settlement, as the exact text that is hashed
 * and served.
 *
 * Built from the Settlement row and its block's timestamp and nothing else,
 * with the keys in a fixed order, so the same Settlement always yields the same
 * bytes and the `feedbackHash` written on chain always matches what the URI
 * serves.
 */
export function feedbackDocument(chainId: number, settlement: FeedbackSettlement, settledAtSeconds: bigint): string {
  return JSON.stringify({
    type: "tab-settlement-feedback",
    version: 1,
    chainId,
    value: Number(TAB_SETTLEMENT_FEEDBACK.value),
    valueDecimals: TAB_SETTLEMENT_FEEDBACK.valueDecimals,
    tag1: TAB_SETTLEMENT_FEEDBACK.tag1,
    tag2: TAB_SETTLEMENT_FEEDBACK.tag2,
    meaning:
      "The Agent paid this Service: one entry per Settlement applied on chain, written by the Service afterwards. Check it against the Settled event in txHash. A derived signal; the Credit Limit never reads it.",
    settlement: {
      settlementId: settlement.settlementId,
      agent: settlement.agent,
      serviceId: settlement.serviceId,
      asset: settlement.asset,
      amount: settlement.amount,
      applied: settlement.applied,
      toPrepaid: settlement.toPrepaid,
      collection: settlement.collection,
      settledAt: new Date(Number(settledAtSeconds) * 1000).toISOString(),
      txHash: settlement.txHash,
      blockNumber: settlement.blockNumber,
      logIndex: settlement.logIndex,
    },
  });
}

/** `keccak256` of the document's UTF-8 bytes: the `feedbackHash` written on chain. */
export const feedbackHashOf = (document: string): string => keccak256(toUtf8Bytes(document));

/** Where the document is served. */
export const feedbackUriOf = (publicUrl: string, settlementId: string): string =>
  `${publicUrl.replace(/\/+$/, "")}/reputation/${settlementId.toLowerCase()}`;

/** The `giveFeedback` calldata for one entry. */
export function encodeGiveFeedback(input: {
  readonly agentId: bigint;
  readonly endpoint: string;
  readonly feedbackURI: string;
  readonly feedbackHash: string;
}): string {
  return REPUTATION_INTERFACE.encodeFunctionData("giveFeedback", [
    input.agentId,
    TAB_SETTLEMENT_FEEDBACK.value,
    TAB_SETTLEMENT_FEEDBACK.valueDecimals,
    TAB_SETTLEMENT_FEEDBACK.tag1,
    TAB_SETTLEMENT_FEEDBACK.tag2,
    input.endpoint,
    input.feedbackURI,
    input.feedbackHash,
  ]);
}

/**
 * Which agentId feedback about an address is written against.
 *
 * An address may hold several ERC-8004 agents. The one it acts for, where its
 * `agentWallet` is this address, comes first; failing that, one it owns. The
 * lowest id wins inside each, so the choice is the same on every tick.
 */
export function chooseAgentId(agents: readonly { readonly agentId: string; readonly matchedBy: readonly string[] }[]): bigint | undefined {
  const lowest = (list: readonly { readonly agentId: string }[]): bigint | undefined =>
    list.map((agent) => BigInt(agent.agentId)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
  const valid = agents.filter((agent) => /^[0-9]+$/.test(agent.agentId));
  return lowest(valid.filter((agent) => agent.matchedBy.includes("agentWallet"))) ?? lowest(valid.filter((agent) => agent.matchedBy.includes("owner")));
}

// ------------------------------------------------------------------ registry reads

/** What the reads need to reach the registry API. */
interface RegistryClient {
  readonly url: string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}

async function readJson(client: RegistryClient, path: string): Promise<Result<unknown>> {
  const url = `${client.url}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), client.timeoutMs);
  try {
    const response = await client.fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (response.status === 404) {
      return err({ category: "NOT_FOUND", code: "REGISTRY_NOT_FOUND", message: `the registry has nothing at ${path}`, retryable: false });
    }
    if (!response.ok) {
      return err({ category: "UPSTREAM", code: "REGISTRY_READ_FAILED", message: `the registry answered ${response.status} for ${path}`, retryable: true });
    }
    return ok(await response.json());
  } catch (error) {
    return err({
      category: "UPSTREAM",
      code: "REGISTRY_READ_FAILED",
      message: `the registry could not be read at ${path}: ${controller.signal.aborted ? `no answer within ${client.timeoutMs} ms` : causeOf(error).message}`,
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ the documents

export interface FeedbackDocumentsOptions {
  readonly provider: Pick<JsonRpcProvider, "getBlock">;
  readonly chainId: number;
  /** This gateway's Service. A document is served for its own Settlements only. */
  readonly serviceId: string;
  readonly registryUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface FeedbackDocuments {
  /** The document for a Settlement row already in hand. */
  documentFor(settlement: FeedbackSettlement): Promise<Result<string>>;
  /** The document for a Settlement id, read from the registry: what `/reputation/:settlementId` serves. */
  document(settlementId: string): Promise<Result<string>>;
}

/**
 * Builds and holds feedback documents. The writer hashes what this builds and
 * the route serves what this builds, so the two cannot disagree.
 */
export function createFeedbackDocuments(options: FeedbackDocumentsOptions): FeedbackDocuments {
  const registry: RegistryClient = {
    url: options.registryUrl.replace(/\/+$/, ""),
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? 5_000,
  };
  const serviceId = options.serviceId.toLowerCase();
  const held = new Map<string, string>();
  const blockTimes = new Map<number, bigint>();

  const settledAtOf = async (blockNumber: number): Promise<Result<bigint>> => {
    const known = blockTimes.get(blockNumber);
    if (known !== undefined) return ok(known);
    try {
      const block = await options.provider.getBlock(blockNumber);
      if (block === null) {
        return err({ category: "UPSTREAM", code: "BLOCK_UNAVAILABLE", message: `block ${blockNumber} is not available from the RPC`, retryable: true });
      }
      const seconds = BigInt(block.timestamp);
      blockTimes.set(blockNumber, seconds);
      return ok(seconds);
    } catch (error) {
      return err({ category: "UPSTREAM", code: "CHAIN_READ_FAILED", message: `block ${blockNumber} could not be read: ${causeOf(error).message}`, retryable: true });
    }
  };

  const documentFor = async (settlement: FeedbackSettlement): Promise<Result<string>> => {
    const cached = held.get(settlement.settlementId);
    if (cached !== undefined) return ok(cached);
    const settledAt = await settledAtOf(settlement.blockNumber);
    if (!settledAt.ok) return settledAt;
    const document = feedbackDocument(options.chainId, settlement, settledAt.value);
    if (held.size >= 10_000) held.clear();
    held.set(settlement.settlementId, document);
    return ok(document);
  };

  return {
    documentFor,
    async document(settlementId): Promise<Result<string>> {
      const id = settlementId.toLowerCase();
      if (!isWord(id)) {
        return err({ category: "VALIDATION", code: "PARAMETER_MALFORMED", message: "settlementId must be a 32-byte hex word", retryable: false });
      }
      const cached = held.get(id);
      if (cached !== undefined) return ok(cached);
      const body = await readJson(registry, `/settlements/${id}`);
      if (!body.ok) {
        return body.error.category === "NOT_FOUND"
          ? err({ category: "NOT_FOUND", code: "SETTLEMENT_NOT_INDEXED", message: "no Settlement is indexed under that id", retryable: false })
          : body;
      }
      const settlement = settlementFromBody((body.value as { settlement?: unknown } | null)?.settlement);
      if (settlement === undefined) {
        return err({ category: "UPSTREAM", code: "REGISTRY_SETTLEMENT_MALFORMED", message: "the registry's Settlement row did not have the expected shape", retryable: true });
      }
      if (settlement.serviceId !== serviceId) {
        return err({ category: "NOT_FOUND", code: "SETTLEMENT_NOT_THIS_SERVICE", message: "that Settlement was not paid to this Service, so this Service wrote no feedback about it", retryable: false });
      }
      return documentFor(settlement);
    },
  };
}

// ------------------------------------------------------------------ the writer

export interface ReputationLogger {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
}

export interface ReputationWriterOptions {
  readonly provider: Pick<JsonRpcProvider, "call" | "estimateGas" | "waitForTransaction" | "getTransactionReceipt">;
  readonly signer: Pick<Signer, "sendTransaction" | "getAddress">;
  readonly documents: FeedbackDocuments;
  readonly reputationRegistry: string;
  readonly serviceId: string;
  readonly registryUrl: string;
  /** This gateway's public URL: the `endpoint` of every entry and the base of every `feedbackURI`. */
  readonly publicUrl: string;
  /** Simulate each write and report it, but send nothing. The backfill script's default. */
  readonly dryRun?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: ReputationLogger;
  readonly receiptWaitMs?: number;
  readonly recheckEveryTicks?: number;
  readonly registryTimeoutMs?: number;
}

/** One entry written, or that would be in a dry run. */
export interface FeedbackWrite {
  readonly agent: string;
  readonly agentId: string;
  readonly settlementId: string;
  readonly feedbackURI: string;
  readonly feedbackHash: string;
  readonly gasLimit: string;
  /** Absent in a dry run. */
  readonly txHash?: string;
}

export interface TickReport {
  /** False when a tick was already running, so this one did nothing. */
  readonly ran: boolean;
  readonly written: readonly FeedbackWrite[];
  /** Agents left alone this tick, with the reason. */
  readonly skipped: readonly { readonly agent: string; readonly agentId?: string; readonly reason: string }[];
  readonly failures: readonly TabError[];
}

export interface ReputationWriter {
  /** One pass: new Settlements read, identities resolved, missing entries written. Never throws. */
  tick(): Promise<TickReport>;
  /** Ticks on a timer, the first immediately, never two at once. Returns the stop. */
  start(intervalMs?: number): () => void;
}

/** The revert string a simulation came back with, where there is one. */
function revertReason(error: unknown): string {
  const shaped = error as { reason?: unknown; data?: unknown; error?: { data?: unknown } } | null;
  if (typeof shaped?.reason === "string" && shaped.reason.length > 0) return shaped.reason;
  const data = shaped?.data ?? shaped?.error?.data;
  if (typeof data === "string" && data.startsWith("0x08c379a0")) {
    try {
      const parsed = REPUTATION_INTERFACE.parseError(data);
      if (parsed !== null) return String(parsed.args[0]);
    } catch {
      // Not an Error(string). Reported from the message below.
    }
  }
  return causeOf(error).message;
}

export function createReputationWriter(options: ReputationWriterOptions): ReputationWriter {
  const logger: ReputationLogger = options.logger ?? { info: () => undefined, warn: () => undefined };
  const registry: RegistryClient = {
    url: options.registryUrl.replace(/\/+$/, ""),
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.registryTimeoutMs ?? 5_000,
  };
  const serviceId = options.serviceId.toLowerCase();
  const reputationRegistry = options.reputationRegistry.toLowerCase();
  const receiptWaitMs = options.receiptWaitMs ?? REPUTATION_RECEIPT_WAIT_MS;
  const recheckEvery = options.recheckEveryTicks ?? REPUTATION_RECHECK_TICKS;
  const dryRun = options.dryRun ?? false;

  /** Every Settlement to this Service seen so far, by id. */
  const known = new Map<string, FeedbackSettlement>();
  /** The newest position read, so a tick reads only what landed since. */
  let newest: { blockNumber: number; logIndex: number } | undefined;
  /** Agent address to its agentId, or `null` for none, as last resolved. */
  const identities = new Map<string, bigint | null>();
  /** Agents to look at on the next tick. */
  const dirty = new Set<string>();
  /** A write sent and not yet confirmed, per agentId. */
  const inFlight = new Map<string, string>();
  /** Why an agentId was last refused, so the log says it once rather than every tick. */
  const refusedFor = new Map<string, string>();
  let ticks = 0;
  let running = false;

  /** Reads Settlements newest first until it reaches what it already has. */
  const readNewSettlements = async (): Promise<Result<number>> => {
    let cursor: string | null = null;
    let added = 0;
    let top: { blockNumber: number; logIndex: number } | undefined;
    for (;;) {
      const query: string = `/settlements?serviceId=${serviceId}&limit=${PAGE_SIZE}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const page = await readJson(registry, query);
      if (!page.ok) return page;
      const body = page.value as { settlements?: unknown; nextCursor?: unknown } | null;
      if (!Array.isArray(body?.settlements)) {
        return err({ category: "UPSTREAM", code: "REGISTRY_SETTLEMENTS_MALFORMED", message: "the registry's Settlement page carried no list", retryable: true });
      }
      let reachedKnown = false;
      for (const entry of body.settlements) {
        const settlement = settlementFromBody(entry);
        if (settlement === undefined) {
          return err({ category: "UPSTREAM", code: "REGISTRY_SETTLEMENTS_MALFORMED", message: "a Settlement row from the registry did not have the expected shape", retryable: true });
        }
        if (settlement.serviceId !== serviceId) continue;
        if (newest !== undefined && chainOrder(settlement, { ...settlement, ...newest }) <= 0) {
          reachedKnown = true;
          break;
        }
        top ??= { blockNumber: settlement.blockNumber, logIndex: settlement.logIndex };
        if (!known.has(settlement.settlementId)) {
          known.set(settlement.settlementId, settlement);
          dirty.add(settlement.agent);
          added += 1;
        }
      }
      if (reachedKnown || typeof body.nextCursor !== "string" || body.nextCursor.length === 0) break;
      cursor = body.nextCursor;
    }
    if (top !== undefined) newest = top;
    return ok(added);
  };

  /** The agentId the registry's identity index gives an address, `null` for none. */
  const resolveIdentity = async (agent: string): Promise<Result<bigint | null>> => {
    const body = await readJson(registry, `/agents/${agent}/reputation`);
    if (!body.ok) return body;
    const reputation = (body.value as { reputation?: unknown } | null)?.reputation;
    if (reputation === null || reputation === undefined) {
      return err({
        category: "UNAVAILABLE",
        code: "REGISTRY_IDENTITY_OFF",
        message: "the registry serves no ERC-8004 identity, so no agentId can be found for any Agent",
        retryable: true,
      });
    }
    const agents = (reputation as { agents?: unknown }).agents;
    if (!Array.isArray(agents)) {
      return err({ category: "UPSTREAM", code: "REGISTRY_IDENTITY_MALFORMED", message: "the registry's reputation read carried no agent list", retryable: true });
    }
    const shaped = agents.filter(
      (entry): entry is { agentId: string; matchedBy: string[] } =>
        typeof entry === "object" && entry !== null && typeof (entry as { agentId?: unknown }).agentId === "string" && Array.isArray((entry as { matchedBy?: unknown }).matchedBy),
    );
    return ok(chooseAgentId(shaped) ?? null);
  };

  /** How many entries this operator already wrote about the agent under Tab's tags. */
  const writtenCount = async (agentId: bigint, operator: string): Promise<Result<number>> => {
    try {
      const data = REPUTATION_INTERFACE.encodeFunctionData("readAllFeedback", [
        agentId,
        [operator],
        TAB_SETTLEMENT_FEEDBACK.tag1,
        TAB_SETTLEMENT_FEEDBACK.tag2,
        true,
      ]);
      const returned = await options.provider.call({ to: reputationRegistry, data });
      const decoded = REPUTATION_INTERFACE.decodeFunctionResult("readAllFeedback", returned);
      return ok((decoded[0] as readonly unknown[]).length);
    } catch (error) {
      return err({ category: "UPSTREAM", code: "CHAIN_READ_FAILED", message: `ReputationRegistry.readAllFeedback could not be read for agent ${agentId}: ${causeOf(error).message}`, retryable: true });
    }
  };

  type WriteOutcome = { readonly kind: "written"; readonly write: FeedbackWrite } | { readonly kind: "refused"; readonly reason: string } | { readonly kind: "failed"; readonly error: TabError };

  const writeOne = async (agentId: bigint, settlement: FeedbackSettlement, operator: string): Promise<WriteOutcome> => {
    const document = await options.documents.documentFor(settlement);
    if (!document.ok) return { kind: "failed", error: document.error };
    const feedbackURI = feedbackUriOf(options.publicUrl, settlement.settlementId);
    const feedbackHash = feedbackHashOf(document.value);
    const data = encodeGiveFeedback({ agentId, endpoint: options.publicUrl, feedbackURI, feedbackHash });

    // Simulated first, from the operator: a refusal is read for free.
    try {
      await options.provider.call({ to: reputationRegistry, data, from: operator });
    } catch (error) {
      const reason = revertReason(error);
      if (/self-feedback/i.test(reason)) {
        return {
          kind: "refused",
          reason: `the registry refuses it (${reason}): this Service's operator ${operator} owns or operates ERC-8004 agent ${agentId}, and an agent cannot be rated by its own owner. The Agent has to hold its identity itself, for example by the owner transferring agent ${agentId} to the Agent's key`,
        };
      }
      return { kind: "refused", reason: `the registry refuses it: ${reason}` };
    }

    // Stated from an estimate, because Monad charges the limit.
    let gasLimit = REPUTATION_GAS_LIMIT;
    try {
      const estimate = await options.provider.estimateGas({ to: reputationRegistry, data, from: operator });
      const padded = (estimate * (10_000n + REPUTATION_GAS_MARGIN_BPS)) / 10_000n;
      gasLimit = padded < REPUTATION_GAS_FLOOR ? REPUTATION_GAS_FLOOR : padded > REPUTATION_GAS_LIMIT ? REPUTATION_GAS_LIMIT : padded;
    } catch {
      gasLimit = REPUTATION_GAS_LIMIT;
    }

    const base = {
      agent: settlement.agent,
      agentId: agentId.toString(),
      settlementId: settlement.settlementId,
      feedbackURI,
      feedbackHash,
      gasLimit: gasLimit.toString(),
    };
    if (dryRun) return { kind: "written", write: base };

    let hash: string;
    try {
      hash = (await options.signer.sendTransaction({ to: reputationRegistry, data, gasLimit })).hash;
    } catch (error) {
      return { kind: "failed", error: { category: "CHAIN", code: "FEEDBACK_SUBMISSION_FAILED", message: `giveFeedback could not be submitted: ${causeOf(error).message}`, retryable: true } };
    }
    inFlight.set(agentId.toString(), hash);
    let receipt;
    try {
      receipt = await options.provider.waitForTransaction(hash, 1, receiptWaitMs);
    } catch (error) {
      return { kind: "failed", error: { category: "CHAIN", code: "FEEDBACK_UNCONFIRMED", message: `giveFeedback ${hash} has no receipt yet: ${causeOf(error).message}`, retryable: true } };
    }
    if (receipt === null) {
      return { kind: "failed", error: { category: "CHAIN", code: "FEEDBACK_UNCONFIRMED", message: `giveFeedback ${hash} has no receipt within ${receiptWaitMs / 1000}s`, retryable: true } };
    }
    inFlight.delete(agentId.toString());
    if (receipt.status !== 1) {
      return { kind: "failed", error: { category: "CHAIN", code: "FEEDBACK_REVERTED", message: `giveFeedback ${hash} was mined and reverted, consuming ${receipt.gasUsed} of ${gasLimit} gas`, retryable: true } };
    }
    return { kind: "written", write: { ...base, txHash: hash } };
  };

  const tick = async (): Promise<TickReport> => {
    if (running) return { ran: false, written: [], skipped: [], failures: [] };
    running = true;
    const written: FeedbackWrite[] = [];
    const skipped: { agent: string; agentId?: string; reason: string }[] = [];
    const failures: TabError[] = [];
    try {
      ticks += 1;
      const operator = (await options.signer.getAddress()).toLowerCase();
      // A recheck re-reads the whole list as well, so a row the registry
      // indexed late, behind the newest position, is still found.
      const recheck = ticks % recheckEvery === 0;
      if (recheck) newest = undefined;

      const read = await readNewSettlements();
      if (!read.ok) {
        failures.push(read.error);
        logger.warn(`reputation: ${read.error.message}; trying again next tick`);
        return { ran: true, written, skipped, failures };
      }
      if (recheck) for (const settlement of known.values()) dirty.add(settlement.agent);
      if (dirty.size === 0) return { ran: true, written, skipped, failures };

      // Resolve every dirty address afresh; others keep what was last resolved.
      // An address resolved for the first time is needed even if not dirty,
      // because entries are counted per agentId across all its addresses.
      const toResolve = new Set<string>(dirty);
      for (const settlement of known.values()) if (!identities.has(settlement.agent)) toResolve.add(settlement.agent);
      const retry = new Set<string>();
      for (const agent of toResolve) {
        const resolved = await resolveIdentity(agent);
        if (!resolved.ok) {
          failures.push(resolved.error);
          logger.warn(`reputation: no identity read for ${agent}: ${resolved.error.message}`);
          retry.add(agent);
          continue;
        }
        const before = identities.get(agent);
        identities.set(agent, resolved.value);
        if (resolved.value === null) {
          skipped.push({ agent, reason: "no ERC-8004 identity" });
          if (before !== null) logger.info(`reputation: ${agent} holds no ERC-8004 identity, so no feedback is written about it`);
        }
      }

      const agentIds = new Map<string, bigint>();
      for (const agent of dirty) {
        const id = identities.get(agent);
        if (id !== undefined && id !== null) agentIds.set(id.toString(), id);
      }

      for (const [key, agentId] of agentIds) {
        const addresses = [...identities.entries()].filter(([, id]) => id === agentId).map(([agent]) => agent);
        const pendingHash = inFlight.get(key);
        if (pendingHash !== undefined) {
          const receipt = await options.provider.getTransactionReceipt(pendingHash).catch(() => null);
          if (receipt === null) {
            skipped.push({ agent: addresses[0] ?? "", agentId: key, reason: `an earlier write ${pendingHash} is not mined yet` });
            for (const agent of addresses) retry.add(agent);
            continue;
          }
          inFlight.delete(key);
        }

        const settlements = [...known.values()].filter((settlement) => addresses.includes(settlement.agent)).sort(chainOrder);
        const count = await writtenCount(agentId, operator);
        if (!count.ok) {
          failures.push(count.error);
          logger.warn(`reputation: ${count.error.message}`);
          for (const agent of addresses) retry.add(agent);
          continue;
        }
        if (count.value > settlements.length) {
          const reason = `this operator already wrote ${count.value} entries about agent ${key} and the registry lists ${settlements.length} Settlements from it, so nothing is written`;
          skipped.push({ agent: addresses[0] ?? "", agentId: key, reason });
          if (refusedFor.get(key) !== reason) logger.warn(`reputation: ${reason}`);
          refusedFor.set(key, reason);
          continue;
        }

        for (const settlement of settlements.slice(count.value)) {
          const outcome = await writeOne(agentId, settlement, operator);
          if (outcome.kind === "written") {
            written.push(outcome.write);
            refusedFor.delete(key);
            logger.info(
              dryRun
                ? `reputation: would write feedback about agent ${key} (${settlement.agent}) for Settlement ${settlement.settlementId}, gas limit ${outcome.write.gasLimit}`
                : `reputation: wrote feedback about agent ${key} (${settlement.agent}) for Settlement ${settlement.settlementId} in ${outcome.write.txHash}, gas limit ${outcome.write.gasLimit}`,
            );
            continue;
          }
          if (outcome.kind === "refused") {
            skipped.push({ agent: settlement.agent, agentId: key, reason: outcome.reason });
            if (refusedFor.get(key) !== outcome.reason) logger.warn(`reputation: no feedback about agent ${key}: ${outcome.reason}`);
            refusedFor.set(key, outcome.reason);
            break;
          }
          failures.push(outcome.error);
          logger.warn(`reputation: feedback about agent ${key} for Settlement ${settlement.settlementId} not written: ${outcome.error.message}`);
          for (const agent of addresses) retry.add(agent);
          break;
        }
      }

      dirty.clear();
      for (const agent of retry) dirty.add(agent);
      return { ran: true, written, skipped, failures };
    } catch (error) {
      // Nothing above should throw; this keeps a bug from stopping the timer.
      const failure: TabError = { category: "INTERNAL", code: "REPUTATION_TICK_FAILED", message: causeOf(error).message, retryable: true };
      failures.push(failure);
      logger.warn(`reputation: the tick failed: ${failure.message}`);
      return { ran: true, written, skipped, failures };
    } finally {
      running = false;
    }
  };

  return {
    tick,
    start(intervalMs = REPUTATION_INTERVAL_MS) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const loop = async (): Promise<void> => {
        await tick();
        if (!stopped) timer = setTimeout(() => void loop(), intervalMs);
      };
      void loop();
      return () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    },
  };
}

// ------------------------------------------------------------------ configuration

/** The environment the writer reads, one name per line so `scripts/env-check.mjs` sees each. */
export interface ReputationEnv {
  readonly GATEWAY_REPUTATION_ENABLED?: string | undefined;
  readonly GATEWAY_PUBLIC_URL?: string | undefined;
  readonly GATEWAY_REPUTATION_INTERVAL_MS?: string | undefined;
  readonly ERC8004_REPUTATION_REGISTRY_ADDRESS?: string | undefined;
}

export function processReputationEnv(): ReputationEnv {
  return {
    GATEWAY_REPUTATION_ENABLED: process.env.GATEWAY_REPUTATION_ENABLED,
    GATEWAY_PUBLIC_URL: process.env.GATEWAY_PUBLIC_URL,
    GATEWAY_REPUTATION_INTERVAL_MS: process.env.GATEWAY_REPUTATION_INTERVAL_MS,
    ERC8004_REPUTATION_REGISTRY_ADDRESS: process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS,
  };
}

export type ReputationConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly publicUrl: string;
      readonly reputationRegistry: string;
      readonly intervalMs: number;
    };

const configInvalid = (variable: string, message: string): Result<never> =>
  err({ category: "VALIDATION", code: "GATEWAY_CONFIG_INVALID", message: `${variable} ${message}`, retryable: false, details: { variable } });

/**
 * The writer's configuration, or the variable that is wrong. Off unless
 * `GATEWAY_REPUTATION_ENABLED=true`; on, it needs the public URL the
 * documents are served at and a Reputation registry, which defaults to the
 * canonical one for the chain.
 */
export function loadReputationConfig(env: ReputationEnv, chainId: number): Result<ReputationConfig> {
  if (env.GATEWAY_REPUTATION_ENABLED?.trim() !== "true") return ok({ enabled: false });

  const publicUrl = env.GATEWAY_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (publicUrl === undefined || !/^https?:\/\/[^\s]+$/.test(publicUrl)) {
    return configInvalid("GATEWAY_PUBLIC_URL", "must be the http(s) URL this gateway is reached at, because every feedback entry points at a document served there");
  }

  const override = env.ERC8004_REPUTATION_REGISTRY_ADDRESS?.trim();
  let reputationRegistry: string | undefined;
  if (override !== undefined && override.length > 0) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(override) || /^0x0{40}$/i.test(override)) {
      return configInvalid("ERC8004_REPUTATION_REGISTRY_ADDRESS", "must be a deployed 20-byte address, or empty for the canonical registry");
    }
    reputationRegistry = override.toLowerCase();
  } else {
    reputationRegistry = erc8004RegistriesFor(chainId)?.reputation.toLowerCase();
  }
  if (reputationRegistry === undefined) {
    return configInvalid("ERC8004_REPUTATION_REGISTRY_ADDRESS", `is unset and chain ${chainId} has no canonical Reputation registry`);
  }

  const intervalRaw = env.GATEWAY_REPUTATION_INTERVAL_MS?.trim();
  const intervalMs = intervalRaw === undefined || intervalRaw.length === 0 ? REPUTATION_INTERVAL_MS : Number(intervalRaw);
  if (!Number.isInteger(intervalMs) || intervalMs < 5_000) {
    return configInvalid("GATEWAY_REPUTATION_INTERVAL_MS", "must be a whole number of milliseconds, at least 5000");
  }

  return ok({ enabled: true, publicUrl, reputationRegistry, intervalMs });
}
