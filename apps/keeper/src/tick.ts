/**
 * One tick: find every overdue tab, then mark the ones the chain will accept.
 *
 * The verdicts come from `readOverdueTabs`, copied from the Dashboard so the
 * keeper and the page a person reads agree tab for tab. Every state is read at
 * one block and every verdict is against that block's clock. The keeper then
 * simulates each markable tab before sending, because a tab can stop being
 * markable between the read and the send, and a named skip is the honest
 * answer where a reverted transaction would be a wasted one.
 *
 * A tick with `broadcast: false` does everything but send. It still simulates,
 * so a dry run reports `would-mark` only for tabs the chain would accept right
 * now, which is what makes its output a plan rather than a guess.
 */

import { ok, type Result, type TabError } from "@tabai/shared";

import type { ChainReader } from "./chain.js";
import type { FeedWalk } from "./feed.js";
import type { Marker, SkipReason } from "./marker.js";
import { readOverdueTabs, type OverdueReport, type OverdueTabView } from "./overdue.js";

/** One tab's verdict, with every figure a string so it survives JSON. */
export interface OverdueTabJson {
  readonly tabId: string;
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly openBaseUnits: string;
  readonly prepaidBaseUnits: string;
  readonly oldestUnsettledAt: number;
  readonly lastDeliveryAt: number;
  readonly deliveryCount: number;
  readonly delinquent: boolean;
  readonly settlementWindowSeconds: number;
  readonly windowEnd: number;
  readonly secondsUntilWindowEnd: number;
  readonly markable: boolean;
}

/** What `GET /overdue` serves: the verdicts, and how they were arrived at. */
export interface OverdueJson {
  readonly at: { readonly blockNumber: number; readonly timestamp: number };
  readonly candidates: number;
  readonly feed: { readonly rows: number; readonly pages: number };
  readonly overdue: readonly OverdueTabJson[];
  readonly pending: readonly OverdueTabJson[];
}

export type MarkOutcome = "marked" | "would-mark" | "skipped" | "failed";

export interface MarkAction {
  readonly tabId: string;
  readonly outcome: MarkOutcome;
  readonly reason?: SkipReason;
  readonly txHash?: string;
  readonly blockNumber?: number | null;
  readonly error?: TabError;
}

export interface TickReport extends OverdueJson {
  readonly broadcast: boolean;
  /** One entry per markable tab, in window-end order, oldest first. */
  readonly actions: readonly MarkAction[];
  /** Tabs the caller asked for that were not markable at this block. */
  readonly notMarkable: readonly string[];
}

export interface TickDeps {
  readonly chain: ChainReader;
  readonly walkFeed: () => Promise<Result<FeedWalk>>;
  readonly marker: Marker;
  readonly tabBook: string;
  readonly serviceRegistry: string;
}

export interface TickOptions {
  readonly broadcast: boolean;
  /**
   * Restricts the marks to these tab ids. The verdicts are still recomputed at
   * a fresh block; a requested tab that is not markable now is listed under
   * `notMarkable` rather than sent to a certain revert.
   */
  readonly only?: readonly string[] | undefined;
}

export const toOverdueJson = (view: OverdueTabView): OverdueTabJson => ({
  tabId: view.tabId,
  agent: view.ref.agent,
  serviceId: view.ref.serviceId,
  asset: view.ref.asset,
  openBaseUnits: view.tab.open.toString(10),
  prepaidBaseUnits: view.tab.prepaid.toString(10),
  oldestUnsettledAt: Number(view.tab.oldestUnsettledAt),
  lastDeliveryAt: Number(view.tab.lastDeliveryAt),
  deliveryCount: view.tab.deliveryCount,
  delinquent: view.tab.delinquent,
  settlementWindowSeconds: view.settlementWindowSeconds,
  windowEnd: Number(view.windowEnd),
  secondsUntilWindowEnd: view.secondsUntilWindowEnd,
  markable: view.markable,
});

/** The verdicts alone: the feed walked, every tab judged at one block, nothing sent. */
export async function readOverdue(deps: Omit<TickDeps, "marker">): Promise<Result<{ report: OverdueReport; json: OverdueJson }>> {
  const walked = await deps.walkFeed();
  if (!walked.ok) return walked;
  const report = await readOverdueTabs({
    chain: deps.chain,
    tabBook: deps.tabBook,
    serviceRegistry: deps.serviceRegistry,
    candidates: walked.value.candidates,
  });
  if (!report.ok) return report;
  return ok({
    report: report.value,
    json: {
      at: report.value.at,
      candidates: report.value.candidates,
      feed: { rows: walked.value.rows, pages: walked.value.pages },
      overdue: report.value.overdue.map(toOverdueJson),
      pending: report.value.pending.map(toOverdueJson),
    },
  });
}

/** Judges, simulates, and marks. Never throws; a failed mark is an action with an error. */
export async function runTick(deps: TickDeps, options: TickOptions): Promise<Result<TickReport>> {
  const judged = await readOverdue(deps);
  if (!judged.ok) return judged;

  const wanted = options.only === undefined ? undefined : new Set(options.only.map((id) => id.toLowerCase()));
  const markableIds = new Set(judged.value.report.overdue.map((view) => view.tabId));
  const notMarkable = wanted === undefined ? [] : [...wanted].filter((id) => !markableIds.has(id));

  const actions: MarkAction[] = [];
  for (const view of judged.value.report.overdue) {
    if (wanted !== undefined && !wanted.has(view.tabId)) continue;
    const simulated = await deps.marker.simulate(view.tabId);
    if (!simulated.ok) {
      actions.push({ tabId: view.tabId, outcome: "failed", error: simulated.error });
      continue;
    }
    if (simulated.value.outcome === "skip") {
      actions.push({ tabId: view.tabId, outcome: "skipped", reason: simulated.value.reason });
      continue;
    }
    if (!options.broadcast) {
      actions.push({ tabId: view.tabId, outcome: "would-mark" });
      continue;
    }
    const sent = await deps.marker.send(view.tabId);
    if (!sent.ok) {
      actions.push({ tabId: view.tabId, outcome: "failed", error: sent.error });
      continue;
    }
    actions.push({ tabId: view.tabId, outcome: "marked", txHash: sent.value.txHash, blockNumber: sent.value.blockNumber });
  }

  return ok({ ...judged.value.json, broadcast: options.broadcast, actions, notMarkable });
}
