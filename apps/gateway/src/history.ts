/**
 * The Agent's history, held between calls so a witness costs one read, not a scan.
 *
 * ## The problem this solves
 *
 * `buildWitness` needs every `HistoryExtended` record for the Agent and Asset,
 * and the chain reader finds them by scanning logs from the deployment block
 * to the head, one hundred blocks at a time, because that is the window Monad's
 * public endpoint allows. The deployment block never moves and the head never
 * stops, so the scan grows by a request every hundred blocks: a minute on the
 * day of the deployment, an hour a week later, and it ran before every single
 * metered call. A rail whose per-call cost is proportional to the age of its
 * deployment is not a rail.
 *
 * ## Three facts that make it cheap
 *
 * 1. **`TabBook.historyCommitment` reports the count.** One `eth_call` says how
 *    many records exist. Zero means no scan at all, which is every new Agent's
 *    first call. A count equal to what is already held means nothing has landed
 *    since, because the count only ever grows.
 * 2. **The records never change once appended.** A record held is a record
 *    held forever, so what this module keeps per Agent and Asset is the records
 *    it has seen and the block it has seen them to, and a call that finds the
 *    count has grown scans only from that block onward.
 * 3. **The registry already indexed them.** `GET /agents/:agent/witness/:asset`
 *    serves the history complete to the index horizon, so the first sight of an
 *    Agent with a long history is one HTTP read and a scan of the few blocks
 *    since the horizon, not a scan from the deployment block.
 *
 * ## What is trusted, and what is not
 *
 * Nothing here is trusted. Whatever this module hands back, `buildWitness`
 * folds it and compares the root and the count with the contract's own before
 * a byte of it reaches `recordDelivery`, and a witness that does not fold is
 * refused there for free. So the registry can be stale, the cache can be
 * wrong, and the only cost is a mismatch that names itself; neither can make
 * a delivery meter against a history that is not the Agent's. That is also why
 * the registry is an optimisation and not a dependency: with it unreachable
 * the module scans from the deployment block, exactly as it did before.
 */

import { err, ok, type Result, type TabError } from "@tabai/shared";

import { recordFromLog, type CountedRecord, type SettlementRecord, type WitnessReader } from "./witness.js";

/** The registry's `GET /agents/:agent/witness/:asset` body, narrowed to what is read. */
interface WitnessBody {
  readonly index?: { readonly lastBlock?: unknown };
  readonly commitment?: { readonly root?: unknown; readonly count?: unknown };
  readonly history?: readonly unknown[];
}

/** What is held per Agent and Asset between calls. */
interface HeldHistory {
  /** The records seen, in commitment order, `count` 1..n. */
  readonly records: readonly CountedRecord[];
  /** The block the records are complete to. Later blocks have not been read. */
  readonly completeTo: number;
}

export interface HistorySourceOptions {
  /** The chain reader the scan and the commitment read go through. */
  readonly chain: WitnessReader;
  /** The block the contracts were deployed in: where a scan with nothing held starts. */
  readonly fromBlock: number;
  /** The head block, resolved fresh per call so a scan ends at one view of the chain. */
  readonly head: () => Promise<Result<number>>;
  /** The registry read API, or nothing. Without it every first sight is a scan. */
  readonly registryUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: { readonly warn: (message: string) => void };
  /** How long a registry read may take before the scan runs instead. */
  readonly registryTimeoutMs?: number;
}

/** A logger that says nothing, for a process that has its own way of saying things. */
const silent = { warn: () => undefined };

const isDigits = (value: unknown): value is string => typeof value === "string" && /^[0-9]+$/.test(value);
const isHexWord = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const isHexAddress = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

/**
 * One registry history entry, checked field by field.
 *
 * A field of the wrong shape fails the whole read rather than the one entry,
 * because a witness with a record dropped cannot fold and the scan is the
 * better answer than a list that is nearly right.
 */
function recordFromBody(value: unknown, position: number): Result<CountedRecord> {
  const malformed = (field: string): Result<CountedRecord> =>
    err({
      category: "UPSTREAM",
      code: "REGISTRY_WITNESS_MALFORMED",
      message: `the registry's witness carried record ${position + 1} with a malformed \`${field}\``,
      retryable: true,
      details: { position: position + 1, field },
    });
  if (typeof value !== "object" || value === null) return malformed("record");
  const entry = value as Record<string, unknown>;
  if (!isHexWord(entry["serviceId"])) return malformed("serviceId");
  if (!isHexAddress(entry["asset"])) return malformed("asset");
  if (!isDigits(entry["amount"])) return malformed("amount");
  if (!isDigits(entry["settledAt"])) return malformed("settledAt");
  if (!isDigits(entry["firstDeliveryAt"])) return malformed("firstDeliveryAt");
  if (typeof entry["curated"] !== "boolean") return malformed("curated");
  if (typeof entry["bonded"] !== "boolean") return malformed("bonded");
  const record: SettlementRecord = {
    serviceId: entry["serviceId"].toLowerCase(),
    asset: entry["asset"].toLowerCase(),
    amount: BigInt(entry["amount"]),
    settledAt: BigInt(entry["settledAt"]),
    firstDeliveryAt: BigInt(entry["firstDeliveryAt"]),
    curated: entry["curated"],
    bonded: entry["bonded"],
  };
  return ok({ count: position + 1, record });
}

/**
 * Wraps a chain reader so the history is held between calls and read from
 * the registry on first sight.
 *
 * The three other reads pass straight through. Only `historyRecords` is added,
 * and `buildWitness` prefers it to the log scan when it is present.
 */
export function createHistorySource(options: HistorySourceOptions): WitnessReader {
  const { chain, fromBlock, head } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? silent;
  const timeoutMs = options.registryTimeoutMs ?? 5_000;
  const registryUrl = options.registryUrl?.replace(/\/+$/, "");
  const held = new Map<string, HeldHistory>();

  const keyOf = (agent: string, asset: string): string => `${agent.toLowerCase()}:${asset.toLowerCase()}`;

  /**
   * The registry's copy, complete to the index horizon, or nothing.
   *
   * Nothing is an answer, not a failure: the registry being down, slow, behind,
   * or wrong about the count all mean the same thing here, which is that the
   * scan runs from the deployment block. Each is logged once so an operator
   * can see why calls got slower, and none is surfaced to the Agent, whose
   * delivery does not depend on which reader found its history.
   */
  const fromRegistry = async (agent: string, asset: string): Promise<HeldHistory | undefined> => {
    if (registryUrl === undefined) return undefined;
    const url = `${registryUrl}/agents/${agent.toLowerCase()}/witness/${asset.toLowerCase()}`;
    let body: WitnessBody;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
        if (!response.ok) {
          logger.warn(`history: the registry answered ${response.status} for ${url}; scanning the chain instead`);
          return undefined;
        }
        body = (await response.json()) as WitnessBody;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      logger.warn(`history: the registry at ${url} could not be read (${error instanceof Error ? error.message : String(error)}); scanning the chain instead`);
      return undefined;
    }

    const lastBlock = Number(body.index?.lastBlock);
    if (!Number.isInteger(lastBlock) || lastBlock < 0 || !Array.isArray(body.history)) {
      logger.warn(`history: the registry's witness for ${agent} carried no index horizon; scanning the chain instead`);
      return undefined;
    }
    const records: CountedRecord[] = [];
    for (const [position, entry] of body.history.entries()) {
      const one = recordFromBody(entry, position);
      if (!one.ok) {
        logger.warn(`history: ${one.error.message}; scanning the chain instead`);
        return undefined;
      }
      records.push(one.value);
    }
    if (Number(body.commitment?.count) !== records.length) {
      logger.warn(`history: the registry's witness for ${agent} lists ${records.length} records against a count of ${String(body.commitment?.count)}; scanning the chain instead`);
      return undefined;
    }
    return { records, completeTo: lastBlock };
  };

  /**
   * The records from `completeTo + 1` to the head, decoded.
   *
   * A base that reaches the head already asks the chain for nothing.
   */
  const scanSince = async (agent: string, asset: string, base: HeldHistory | undefined): Promise<Result<HeldHistory>> => {
    const to = await head();
    if (!to.ok) return to;
    const from = base === undefined ? fromBlock : base.completeTo + 1;
    const records = [...(base?.records ?? [])];
    if (from <= to.value) {
      const logs = await chain.historyLogs(agent, asset, { fromBlock: from, toBlock: to.value });
      if (!logs.ok) return logs;
      for (const log of logs.value) {
        const one = recordFromLog(log);
        if (!one.ok) return one;
        records.push(one.value);
      }
    }
    records.sort((left, right) => left.count - right.count);
    return ok({ records, completeTo: Math.max(to.value, base?.completeTo ?? fromBlock - 1) });
  };

  return {
    historyLogs: (agent, asset, range) => chain.historyLogs(agent, asset, range),
    commitment: (agent, asset) => chain.commitment(agent, asset),
    staked: (serviceId, asset) => chain.staked(serviceId, asset),
    operatorOf: (serviceId) => chain.operatorOf(serviceId),

    async historyRecords(agent, asset): Promise<Result<readonly CountedRecord[]>> {
      const onChain = await chain.commitment(agent, asset);
      if (!onChain.ok) return onChain;
      // The contract's count is the whole question. Nothing to hold, nothing
      // to scan, and a fresh Agent's first call reads the chain exactly once.
      if (onChain.value.count === 0) return ok([]);

      const key = keyOf(agent, asset);
      const have = held.get(key);
      if (have !== undefined && have.records.length === onChain.value.count) return ok(have.records);

      const base = have ?? (await fromRegistry(agent, asset));
      const scanned = await scanSince(agent, asset, base);
      if (!scanned.ok) return scanned;
      held.set(key, scanned.value);
      return ok(scanned.value.records);
    },
  };
}

/** The error a head read turns into, for the reader's `head` option. */
export const headReadFailed = (error: unknown): TabError => ({
  category: "UPSTREAM",
  code: "CHAIN_READ_FAILED",
  message: `the head block could not be read: ${error instanceof Error ? error.message : String(error)}`,
  retryable: true,
});
