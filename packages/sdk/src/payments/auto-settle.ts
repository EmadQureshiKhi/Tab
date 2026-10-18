/**
 * When an Agent should pay its own tab, without being asked.
 *
 * Tab is post-paid, so an Agent that never settles runs into two walls: its
 * Credit Limit, where the next call is refused, and its Settlement Window, after
 * which anyone may mark the tab delinquent and its credit stops. Auto-settle is
 * the Agent keeping clear of both on its own: it settles once its Open Tab
 * reaches an amount it chose, and settles before retrying a call its limit
 * refused. A host that can see the tab's age (the Dashboard's Try it can) may
 * also settle a tab that has aged past a share of its window, or one already
 * marked delinquent, so the next call is never the one that finds it frozen.
 *
 * This module only decides. It holds no key and sends nothing: the caller pays
 * through whatever strategy it already settles with, so an automatic Settlement
 * is the same transaction `tab_settle` would send, from the Agent's own key.
 * Pure, so the MCP server, a host and the tests share one rule.
 */

import { ok, type Result } from "@tabai/shared";

import { validationError } from "../errors.js";

/** What the Agent chose. */
export interface AutoSettlePolicy {
  /** Settle once the Open Tab for an Asset reaches this many base units. */
  readonly atBaseUnits: bigint;
  /**
   * Also settle when the oldest unsettled charge has used this share of its
   * Settlement Window, from 0 to 1. Needs the tab's age, which only a caller
   * that reads the chain has; `tab_call` alone does not use it.
   */
  readonly windowShare?: number;
}

/** What the caller knows about the tab right now. */
export interface AutoSettleState {
  readonly openTab: bigint;
  /** The call that was just made was refused for lack of headroom. */
  readonly declined?: boolean;
  readonly delinquent?: boolean;
  /** Unix seconds of the oldest unsettled charge, when known. */
  readonly oldestUnsettledAt?: bigint;
  /** The Service's Settlement Window, in seconds, when known. */
  readonly windowSeconds?: bigint;
  /** Unix seconds. */
  readonly now?: bigint;
}

export type AutoSettleReason = "delinquent" | "limit" | "window" | "threshold";

export type AutoSettleDecision =
  | { readonly settle: false }
  | { readonly settle: true; readonly amount: bigint; readonly reason: AutoSettleReason };

/**
 * Whether to settle now, and how much: always the whole Open Tab, because a
 * partial payment leaves the same tab ageing toward the same window.
 *
 * Nothing open is nothing to settle, whatever else is true. Otherwise the
 * reasons are checked from the most urgent: a delinquent tab (credit is frozen
 * until it is paid), a call the limit refused, a tab past its share of the
 * window, then the amount the Agent chose.
 */
export function decideAutoSettle(policy: AutoSettlePolicy, state: AutoSettleState): AutoSettleDecision {
  if (state.openTab <= 0n) return { settle: false };
  const settle = (reason: AutoSettleReason): AutoSettleDecision => ({ settle: true, amount: state.openTab, reason });
  if (state.delinquent === true) return settle("delinquent");
  if (state.declined === true) return settle("limit");
  if (
    policy.windowShare !== undefined &&
    state.oldestUnsettledAt !== undefined &&
    state.oldestUnsettledAt > 0n &&
    state.windowSeconds !== undefined &&
    state.windowSeconds > 0n &&
    state.now !== undefined
  ) {
    const share = BigInt(Math.round(Math.min(Math.max(policy.windowShare, 0), 1) * 10_000));
    const age = state.now - state.oldestUnsettledAt;
    if (age * 10_000n >= state.windowSeconds * share) return settle("window");
  }
  if (state.openTab >= policy.atBaseUnits) return settle("threshold");
  return { settle: false };
}

/**
 * The policy from a config value or an environment string: a whole number of
 * base units, at least one. Undefined or empty means auto-settle is off.
 */
export function parseAutoSettleAt(value: unknown, field = "autoSettle.atBaseUnits"): Result<AutoSettlePolicy | undefined> {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return ok(undefined);
  const text = typeof value === "bigint" ? value.toString(10) : typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^[0-9]{1,78}$/.test(text) || BigInt(text) === 0n) {
    return validationError("AUTO_SETTLE_INVALID", `${field} must be a whole number of base units, at least 1`, { details: { field } });
  }
  return ok({ atBaseUnits: BigInt(text) });
}
