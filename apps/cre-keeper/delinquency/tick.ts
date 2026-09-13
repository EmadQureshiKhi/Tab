/**
 * One tick, as a function of three ports.
 *
 * The CRE wiring in `workflow.ts` builds the ports from the SDK: the read and
 * the write are HTTP requests under consensus, the secret comes from the Vault
 * DON. This module is everything else, and it takes only what it needs, so a
 * Node test can drive it with fakes while the SDK, which loads only inside the
 * WASM build, stays out of the picture.
 *
 * Every verdict is logged, one line per tab, because the logs are the only
 * window into a deployed workflow and "3 marked" says less than which three.
 */

import type { Result } from "@tabai/shared";

import type { OverdueRead, TickOutcome } from "./keeper-client.js";

export interface TickConfig {
  readonly keeperUrl: string;
  readonly maxMarksPerTick: number;
}

/** The little of `Runtime<Config>` a tick uses. */
export interface TickRuntime {
  readonly config: TickConfig;
  log(message: string): void;
}

export interface TickPorts {
  /** `GET /overdue`, decided, under consensus. */
  readOverdue(): Result<OverdueRead>;
  /** The shared secret, from the Vault DON or the simulator's environment. */
  secret(): Result<string>;
  /** `POST /tick` for these tabs, under consensus. */
  postTick(secret: string, tabIds: readonly string[]): Result<TickOutcome>;
}

export interface TickSummary {
  readonly keeperUrl: string;
  readonly candidates: number;
  readonly overdue: number;
  readonly pending: number;
  readonly requested: readonly string[];
  readonly declined: number;
  readonly deferred: number;
  /** Absent when nothing was requested. */
  readonly tick?: {
    readonly blockNumber: number;
    readonly broadcast: boolean;
    readonly marked: number;
    readonly skipped: number;
    readonly failed: number;
    readonly wouldMark: number;
    readonly notMarkable: number;
  };
}

/** A failed `Result` as the error CRE reports for the run. The message is the whole of what an operator sees. */
export class TickFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "TickFailure";
    this.code = code;
  }
}

const unwrap = <T>(result: Result<T>): T => {
  if (result.ok) return result.value;
  throw new TickFailure(result.error.code, result.error.message);
};

/** Reads, decides, logs, and asks the keeper to mark. Throws `TickFailure` where a port failed. */
export function runDelinquencyTick(runtime: TickRuntime, ports: TickPorts): TickSummary {
  const keeperUrl = runtime.config.keeperUrl;
  runtime.log(`tab keeper: reading ${keeperUrl}/overdue`);
  const read = unwrap(ports.readOverdue());
  runtime.log(
    `tab keeper: ${read.candidates} candidate tabs, ${read.overdueCount} overdue, ${read.pendingCount} inside their window; ${read.decision.tabIds.length} to mark, ${read.decision.declined.length} declined, ${read.decision.deferred} deferred to the next tick`,
  );
  for (const entry of read.decision.declined) runtime.log(`tab keeper: declined ${entry.tabId}: ${entry.reason}`);

  const summary: TickSummary = {
    keeperUrl,
    candidates: read.candidates,
    overdue: read.overdueCount,
    pending: read.pendingCount,
    requested: read.decision.tabIds,
    declined: read.decision.declined.length,
    deferred: read.decision.deferred,
  };
  if (read.decision.tabIds.length === 0) {
    runtime.log("tab keeper: nothing to mark");
    return summary;
  }

  const secret = unwrap(ports.secret());
  for (const tabId of read.decision.tabIds) runtime.log(`tab keeper: requesting mark for ${tabId}`);
  const outcome = unwrap(ports.postTick(secret, read.decision.tabIds));

  let marked = 0;
  let skipped = 0;
  let failed = 0;
  let wouldMark = 0;
  for (const action of outcome.actions) {
    switch (action.outcome) {
      case "marked":
        marked += 1;
        runtime.log(`tab keeper: marked ${action.tabId} in ${action.txHash ?? "?"}`);
        break;
      case "skipped":
        skipped += 1;
        runtime.log(`tab keeper: skipped ${action.tabId}: ${action.reason ?? "?"}`);
        break;
      case "would-mark":
        wouldMark += 1;
        runtime.log(`tab keeper: would mark ${action.tabId} (the keeper holds no key, so this was a dry run)`);
        break;
      default:
        failed += 1;
        runtime.log(`tab keeper: failed ${action.tabId}: ${action.error?.code ?? action.outcome}: ${action.error?.message ?? ""}`);
    }
  }
  for (const tabId of outcome.notMarkable) runtime.log(`tab keeper: ${tabId} was no longer markable at block ${outcome.at.blockNumber}`);
  runtime.log(`tab keeper: block ${outcome.at.blockNumber}: ${marked} marked, ${skipped} skipped, ${failed} failed, ${wouldMark} would mark, ${outcome.notMarkable.length} no longer markable`);

  return {
    ...summary,
    tick: {
      blockNumber: outcome.at.blockNumber,
      broadcast: outcome.broadcast,
      marked,
      skipped,
      failed,
      wouldMark,
      notMarkable: outcome.notMarkable.length,
    },
  };
}
