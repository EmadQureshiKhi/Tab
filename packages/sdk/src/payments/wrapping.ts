/**
 * What a strategy that wraps another one (a funded strategy: Kuru, NEAR
 * Intents) says about itself, rather than letting the inner strategy speak
 * for it.
 */

import { ok, type Result } from "@tabai/shared";

import type { SettlementReceipt } from "./strategy.js";

/**
 * Joins what a wrapping strategy adds to its inner strategy's `feeNote`, as
 * sentences: the inner note keeps its own words, and the addition follows as
 * one more sentence rather than being spliced on after a semicolon.
 */
export function extendFeeNote(inner: string, addition: string): string {
  const base = inner.trim().replace(/[\s.;,]+$/, "");
  const sentence = addition.trim().replace(/[\s.;,]+$/, "");
  const capitalised = sentence.length === 0 ? sentence : `${sentence[0]!.toUpperCase()}${sentence.slice(1)}`;
  if (base.length === 0) return `${capitalised}.`;
  if (capitalised.length === 0) return `${base}.`;
  return `${base}. ${capitalised}.`;
}

/**
 * The inner strategy's receipt, named for the strategy the caller asked for.
 * The Settlement is the inner strategy's transaction, but the strategy that
 * decided to fund it first and then settle is the wrapper.
 */
export function settledBy(id: string, receipt: Result<SettlementReceipt>): Result<SettlementReceipt> {
  return receipt.ok ? ok({ ...receipt.value, strategyId: id }) : receipt;
}

/** {@link settledBy} for a batch. */
export function batchSettledBy(id: string, receipts: Result<readonly SettlementReceipt[]>): Result<readonly SettlementReceipt[]> {
  return receipts.ok ? ok(receipts.value.map((receipt) => ({ ...receipt, strategyId: id }))) : receipts;
}
