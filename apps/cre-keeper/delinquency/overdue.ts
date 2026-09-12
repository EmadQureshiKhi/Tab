/**
 * What the keeper's `GET /overdue` says, and which of it to act on.
 *
 * Pure functions, so the decision can be tested without the CRE runtime and
 * so every node in the DON reaches the same answer from the same bytes: no
 * clock, no randomness, no iteration order that depends on anything but the
 * input. The verdicts themselves are the keeper's, computed at one block from
 * the same fields `TabBook.markDelinquent` compares; this module only decides
 * which of them to hand back, in what order, and how many at a time.
 */

import { err, ok, type Result } from "@tabai/shared";

/** One tab as the keeper serves it. Every figure is a string or a number; nothing is a bigint. */
export interface OverdueTab {
  readonly tabId: string;
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly openBaseUnits: string;
  readonly windowEnd: number;
  readonly secondsUntilWindowEnd: number;
  readonly markable: boolean;
  readonly delinquent: boolean;
}

/** The part of `GET /overdue` this workflow reads. */
export interface OverdueSnapshot {
  readonly at: { readonly blockNumber: number; readonly timestamp: number };
  readonly candidates: number;
  readonly overdue: readonly OverdueTab[];
  readonly pendingCount: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const TAB_ID = /^0x[0-9a-fA-F]{64}$/;

const malformed = (message: string): Result<never> =>
  err({ category: "UPSTREAM", code: "OVERDUE_MALFORMED", message: `the keeper's /overdue answer ${message}`, retryable: true });

/** Reads the keeper's JSON into a snapshot, refusing anything that does not carry the fields a verdict needs. */
export function parseOverdue(body: unknown): Result<OverdueSnapshot> {
  if (!isRecord(body)) return malformed("is not an object");
  const at = body["at"];
  if (!isRecord(at) || typeof at["blockNumber"] !== "number" || typeof at["timestamp"] !== "number") {
    return malformed("carries no block the verdicts were read at");
  }
  if (!Array.isArray(body["overdue"]) || !Array.isArray(body["pending"])) return malformed("carries no overdue and pending lists");
  const overdue: OverdueTab[] = [];
  for (const row of body["overdue"]) {
    if (!isRecord(row)) return malformed("lists a tab that is not an object");
    const tabId = row["tabId"];
    if (typeof tabId !== "string" || !TAB_ID.test(tabId)) return malformed("lists a tab without a 32-byte id");
    const windowEnd = row["windowEnd"];
    const seconds = row["secondsUntilWindowEnd"];
    if (typeof windowEnd !== "number" || typeof seconds !== "number") return malformed(`lists ${tabId} without its window`);
    const open = row["openBaseUnits"];
    if (typeof open !== "string" || !/^[0-9]+$/.test(open)) return malformed(`lists ${tabId} without its open figure`);
    overdue.push({
      tabId: tabId.toLowerCase(),
      agent: typeof row["agent"] === "string" ? row["agent"].toLowerCase() : "",
      serviceId: typeof row["serviceId"] === "string" ? row["serviceId"].toLowerCase() : "",
      asset: typeof row["asset"] === "string" ? row["asset"].toLowerCase() : "",
      openBaseUnits: open,
      windowEnd,
      secondsUntilWindowEnd: seconds,
      markable: row["markable"] === true,
      delinquent: row["delinquent"] === true,
    });
  }
  return ok({
    at: { blockNumber: at["blockNumber"], timestamp: at["timestamp"] },
    candidates: typeof body["candidates"] === "number" ? body["candidates"] : overdue.length,
    overdue,
    pendingCount: body["pending"].length,
  });
}

export interface MarkDecision {
  /** The tabs to ask the keeper to mark, oldest window first, capped. */
  readonly tabIds: readonly string[];
  /** Tabs the keeper listed as overdue that this workflow declined to act on, and why. */
  readonly declined: readonly { readonly tabId: string; readonly reason: string }[];
  /** How many markable tabs were left for the next tick by the cap. */
  readonly deferred: number;
}

/**
 * Which overdue tabs to mark this tick.
 *
 * The keeper already judged each tab against the chain's clock, so the rule
 * here is a re-check of the fields it published rather than a second opinion:
 * a tab is asked for only when it is marked markable, is not already marked,
 * still has something open, and its window end has passed. Oldest first, so
 * the cap defers the newest, and a cap so one tick never asks for more marks
 * than the keeper can send inside the trigger's interval.
 */
export function decideMarks(snapshot: OverdueSnapshot, options: { readonly maxMarks: number }): MarkDecision {
  const declined: { tabId: string; reason: string }[] = [];
  const seen = new Set<string>();
  const eligible: OverdueTab[] = [];
  for (const tab of snapshot.overdue) {
    if (seen.has(tab.tabId)) continue;
    seen.add(tab.tabId);
    if (tab.delinquent) {
      declined.push({ tabId: tab.tabId, reason: "already marked" });
      continue;
    }
    if (!tab.markable) {
      declined.push({ tabId: tab.tabId, reason: "the keeper did not judge it markable" });
      continue;
    }
    if (tab.openBaseUnits === "0") {
      declined.push({ tabId: tab.tabId, reason: "nothing is open" });
      continue;
    }
    if (tab.secondsUntilWindowEnd > 0) {
      declined.push({ tabId: tab.tabId, reason: "the Settlement Window has not closed" });
      continue;
    }
    eligible.push(tab);
  }
  eligible.sort((left, right) => (left.windowEnd === right.windowEnd ? (left.tabId < right.tabId ? -1 : 1) : left.windowEnd - right.windowEnd));
  const cap = Math.max(0, Math.floor(options.maxMarks));
  return {
    tabIds: eligible.slice(0, cap).map((tab) => tab.tabId),
    declined,
    deferred: Math.max(0, eligible.length - cap),
  };
}
