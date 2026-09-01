/**
 * The Attestcoin proof hook: in the `after` phase, finds the Verified Settlement
 * that covers a proxied request and attaches it (R23.5).
 *
 * ## What "covers" means, and how a hint becomes a match
 *
 * An Agent settles on a Source Chain and gets a {@link SettlementHint} back from
 * its payment strategy. The hint names everything the log will carry, and the
 * Service records it against the Agent, so that once the Watcher has proven the
 * Settlement on Creditcoin the Service can recognise the `SettlementRecorded`
 * event as the one the hint announced. Nothing here trusts the hint: it is the
 * *question*, and the answer is read off the chain through the verifier client.
 *
 * A record matches a hint when every fact both of them carry agrees: the
 * chainKey, the Asset, the amount, the payer (`topics[1]` of the hint against
 * `payerAddress` of the record, which the contract read from `topics[1]` too),
 * and, on the `settlement-contract` surface, the tabId. A hint that already
 * knows its replay key matches on that alone, because the key is the identity.
 * A transaction hash is matched on nowhere: the event does not carry one, and
 * one transaction can carry many Settlements.
 *
 * ## The Agent is read where the plugin reads it
 *
 * The Agent is the metered charge's Agent when the request was metered, else
 * `Tab-Agent` on the request. Both are the Agent's Creditcoin address, which is
 * exactly the indexed `agent` topic of `SettlementRecorded`, so the verifier
 * read is one filtered `eth_getLogs` and never a scan.
 *
 * ## Non-critical, and cheap by construction
 *
 * The hook defaults to non-critical: a verifier that cannot be reached is a
 * missing annotation, not a reason to withhold work already delivered. Reads
 * are throttled per Agent so a busy Service asks the chain at most once per
 * {@link DEFAULT_MIN_REFRESH_MS} for each Agent, and a hint that has matched is
 * retired from its store so it is never asked about again.
 *
 * Requirements: 23.5, 24.2
 */

import { isAddress, ok, type Address, type Bytes32, type Result } from "@tabai/shared";

import { defaultLogger, type Logger } from "../logger.js";
import { headerReaderOf, TAB_HEADER } from "../http/headers.js";
import { sameAsset, type AssetRef, type SettlementHint } from "../payments/strategy.js";
import type { ProxyHook, ProxyHookContext } from "./hooks.js";
import {
  blockscoutTxUrl,
  defaultExplorerUrl,
  type RecordedSettlement,
  type SettlementVerifierClient,
  type VerifiedSettlementView,
} from "./verifier.js";

/** The hook's default name, and the `state` key its matches are stored under. */
export const ATTESTCOIN_PROOF_HOOK_NAME = "attestcoin-proof";

/** Least time between two verifier reads for one Agent. */
export const DEFAULT_MIN_REFRESH_MS = 15_000;

/**
 * A hint, optionally already carrying its identity. Once a Watcher or an indexer
 * has told the Service which log position a Settlement landed at, the replay
 * key is the only thing worth matching on.
 */
export interface ProofHint extends SettlementHint {
  readonly replayKey?: Bytes32;
}

/** Where the hook finds the hints recorded against an Agent. */
export interface SettlementHintSource {
  /** Hints recorded for this Agent, narrowed to the Asset when one is given. */
  hintsFor(agent: Address, asset: AssetRef | undefined): readonly ProofHint[] | Promise<readonly ProofHint[]>;
  /** Called once a hint has matched, so the source can stop offering it. Optional. */
  retire?(agent: Address, hint: ProofHint): void;
}

export interface SettlementHintStore extends SettlementHintSource {
  add(agent: Address, hint: ProofHint): void;
  remove(agent: Address, hint: ProofHint): boolean;
  retire(agent: Address, hint: ProofHint): void;
  /** Every hint still open for the Agent. */
  open(agent: Address): readonly ProofHint[];
  clear(): void;
}

export interface SettlementHintStoreOptions {
  /** Oldest hints are dropped past this many per Agent. Defaults to 64. */
  readonly maxPerAgent?: number;
}

/**
 * An in-memory hint store, keyed by Agent. Enough for one Service process; a
 * Service with several replicas puts the same four methods over its database.
 */
export function createSettlementHintStore(options: SettlementHintStoreOptions = {}): SettlementHintStore {
  const cap = options.maxPerAgent ?? 64;
  const byAgent = new Map<string, ProofHint[]>();
  const keyOf = (agent: Address): string => agent.toLowerCase();

  const remove = (agent: Address, hint: ProofHint): boolean => {
    const list = byAgent.get(keyOf(agent));
    if (list === undefined) return false;
    const at = list.findIndex((candidate) => sameHint(candidate, hint));
    if (at === -1) return false;
    list.splice(at, 1);
    if (list.length === 0) byAgent.delete(keyOf(agent));
    return true;
  };

  return {
    add(agent, hint) {
      const list = byAgent.get(keyOf(agent)) ?? [];
      if (list.some((candidate) => sameHint(candidate, hint))) return;
      list.push(hint);
      if (list.length > cap) list.splice(0, list.length - cap);
      byAgent.set(keyOf(agent), list);
    },
    remove,
    retire: (agent, hint) => {
      remove(agent, hint);
    },
    open: (agent) => [...(byAgent.get(keyOf(agent)) ?? [])],
    hintsFor(agent, asset) {
      const list = byAgent.get(keyOf(agent)) ?? [];
      return asset === undefined ? [...list] : list.filter((hint) => sameAsset(hint.asset, asset));
    },
    clear() {
      byAgent.clear();
    },
  };
}

/** Two hints name the same Settlement when their identifying fields agree. */
export function sameHint(a: ProofHint, b: ProofHint): boolean {
  if (a.replayKey !== undefined && b.replayKey !== undefined) {
    return a.replayKey.toLowerCase() === b.replayKey.toLowerCase();
  }
  return (
    a.chainKey === b.chainKey &&
    a.sourceTxHash.toLowerCase() === b.sourceTxHash.toLowerCase() &&
    a.expectedPayerTopic.toLowerCase() === b.expectedPayerTopic.toLowerCase() &&
    a.expectedCollectionTopic.toLowerCase() === b.expectedCollectionTopic.toLowerCase() &&
    (a.expectedTabIdTopic ?? "").toLowerCase() === (b.expectedTabIdTopic ?? "").toLowerCase() &&
    a.amount === b.amount &&
    sameAsset(a.asset, b.asset)
  );
}

/** The last 20 bytes of an indexed `address` topic, as the address. */
export const addressFromTopic = (topic: string): Address => `0x${topic.slice(-40).toLowerCase()}`;

/**
 * Whether one recorded Settlement is the one a hint announced.
 *
 * Every fact both sides carry has to agree. The comparison is deliberately not
 * "any of"; a hint for 5 USDC must not be satisfied by a record of 5 USDC from a
 * different payer, or on a different chain, or against a different tab.
 */
export function hintMatches(hint: ProofHint, record: RecordedSettlement): boolean {
  if (hint.replayKey !== undefined) {
    return hint.replayKey.toLowerCase() === record.replayKey.toLowerCase();
  }
  if (hint.chainKey !== record.chainKey) return false;
  if (hint.asset.address.toLowerCase() !== record.asset.toLowerCase()) return false;
  if (hint.amount !== record.amount) return false;
  if (addressFromTopic(hint.expectedPayerTopic) !== record.payerAddress.toLowerCase()) return false;
  if (hint.expectedTabIdTopic !== undefined) {
    return hint.expectedTabIdTopic.toLowerCase() === record.sourceTabId.toLowerCase();
  }
  return true;
}

export interface AttestcoinProofHookOptions {
  readonly verifier: SettlementVerifierClient;
  readonly hints: SettlementHintSource;
  /** Called once per Settlement the first time it is matched. Consumer code; a throw is logged and ignored. */
  readonly onVerified?: (view: VerifiedSettlementView) => void;
  /**
   * Narrows matching to one Asset. Defaults to the metered charge's Asset when
   * the request was metered, and to every Asset otherwise.
   */
  readonly asset?: AssetRef;
  /** Base of the Blockscout links. Defaults to `CREDITCOIN_EXPLORER_URL` or the pinned constant. */
  readonly explorerUrl?: string;
  /** Defaults to {@link DEFAULT_MIN_REFRESH_MS}. Zero reads the chain on every request. */
  readonly minRefreshMs?: number;
  readonly name?: string;
  /** Defaults to false. See the module note. */
  readonly critical?: boolean;
  readonly logger?: Logger;
  readonly now?: () => number;
}

/** What the hook stores under its name in `context.state`: every match for this request. */
export interface ProofHookState {
  readonly agent: Address;
  readonly matches: readonly VerifiedSettlementView[];
  readonly hintsChecked: number;
  /** True when the verifier was asked on this request rather than answered from the throttle. */
  readonly refreshed: boolean;
}

/**
 * Builds the hook.
 *
 * Construction is total. Everything fallible reports through the `after` phase's
 * `Result`, which the proxy logs and, unless `critical`, skips.
 */
export function createAttestcoinProofHook(options: AttestcoinProofHookOptions): ProxyHook {
  const name = options.name ?? ATTESTCOIN_PROOF_HOOK_NAME;
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => Date.now());
  const minRefreshMs = options.minRefreshMs ?? DEFAULT_MIN_REFRESH_MS;
  const explorerUrl = options.explorerUrl ?? defaultExplorerUrl();

  /** Last read per Agent, so a busy Service does not ask the chain per request. */
  const cache = new Map<string, { readAt: number; records: readonly RecordedSettlement[] }>();
  /** Replay keys already reported through `onVerified`. */
  const reported = new Set<string>();

  const recordsFor = async (
    agent: Address,
  ): Promise<Result<{ records: readonly RecordedSettlement[]; refreshed: boolean }>> => {
    const key = agent.toLowerCase();
    const cached = cache.get(key);
    if (cached !== undefined && now() - cached.readAt < minRefreshMs) {
      return ok({ records: cached.records, refreshed: false });
    }
    const read = await options.verifier.recordedSettlements({ agent });
    if (!read.ok) return read;
    cache.set(key, { readAt: now(), records: read.value });
    return ok({ records: read.value, refreshed: true });
  };

  const hook: ProxyHook = {
    name,
    ...(options.critical === undefined ? {} : { critical: options.critical }),

    async after(context: ProxyHookContext): Promise<Result<void>> {
      const agent = agentOf(context);
      if (agent === undefined) return ok(undefined);
      const asset = options.asset ?? context.charge?.asset;

      const hints = await options.hints.hintsFor(agent, asset);
      const candidates = asset === undefined ? hints : hints.filter((hint) => sameAsset(hint.asset, asset));
      if (candidates.length === 0) {
        context.state.set(name, { agent, matches: [], hintsChecked: 0, refreshed: false } satisfies ProofHookState);
        return ok(undefined);
      }

      const read = await recordsFor(agent);
      if (!read.ok) return read;

      const matches: VerifiedSettlementView[] = [];
      for (const hint of candidates) {
        for (const record of read.value.records) {
          if (!hintMatches(hint, record)) continue;
          const view: VerifiedSettlementView = {
            ...record,
            blockscoutUrl: blockscoutTxUrl(record.creditcoin.txHash, explorerUrl),
            matchedHint: hint,
          };
          matches.push(view);
          options.hints.retire?.(agent, hint);
          if (!reported.has(record.replayKey.toLowerCase())) {
            reported.add(record.replayKey.toLowerCase());
            notify(options.onVerified, view, logger);
          }
        }
      }

      if (matches.length > 0) {
        // The newest on Creditcoin is the one attached; every match is in `state`.
        matches.sort(byCreditcoinPosition);
        const newest = matches.at(-1);
        if (newest !== undefined) context.settlement = newest;
      }
      context.state.set(name, {
        agent,
        matches,
        hintsChecked: candidates.length,
        refreshed: read.value.refreshed,
      } satisfies ProofHookState);
      return ok(undefined);
    },
  };
  return hook;
}

/** The Agent this request was metered against, else the one it claimed. */
function agentOf(context: ProxyHookContext): Address | undefined {
  if (context.charge !== undefined) return context.charge.agent;
  let claimed: string | null | undefined;
  try {
    claimed = headerReaderOf(context.request.headers).get(TAB_HEADER.agent);
  } catch {
    return undefined;
  }
  const trimmed = claimed?.trim();
  return trimmed !== undefined && isAddress(trimmed) ? trimmed : undefined;
}

function byCreditcoinPosition(a: VerifiedSettlementView, b: VerifiedSettlementView): number {
  if (a.creditcoin.blockNumber !== b.creditcoin.blockNumber) {
    return a.creditcoin.blockNumber - b.creditcoin.blockNumber;
  }
  return a.creditcoin.logIndex - b.creditcoin.logIndex;
}

function notify(
  onVerified: AttestcoinProofHookOptions["onVerified"],
  view: VerifiedSettlementView,
  logger: Logger,
): void {
  if (onVerified === undefined) return;
  try {
    onVerified(view);
  } catch (error) {
    logger.warn("onVerified threw and was ignored", {
      replayKey: view.replayKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
