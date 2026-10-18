/**
 * The charge a metered Try it call left, read from the gateway's response headers.
 *
 * A Service that meters after delivery answers with the work in the body and the charge in
 * headers (the SDK's TAB_HEADER names): what was charged, in which Asset, and the Open Tab and
 * headroom the charge left. `/api/try` passes these through, and the panel shows them under the
 * answer, so the claim the page makes ("the charge is written after the work") is visible on the
 * call that makes it.
 */

/** The charge headers `/api/try` passes through from the Service. */
export const CHARGE_HEADERS = ["Tab-Charge-Amount", "Tab-Charge-Asset", "Tab-Open-Tab", "Tab-Headroom"] as const;

/** The charge one call left, in base units of the Asset the call was metered in. */
export interface TryCharge {
  readonly amount: bigint;
  /** `chainId:address`, as the gateway writes it. */
  readonly asset: string;
  readonly openTab: bigint | undefined;
  readonly headroom: bigint | undefined;
}

const digits = (value: string | null): bigint | undefined =>
  value !== null && /^[0-9]{1,78}$/.test(value.trim()) ? BigInt(value.trim()) : undefined;

/** The charge from a response's headers, or undefined when the call was not metered. */
export function chargeFrom(headers: { get(name: string): string | null }): TryCharge | undefined {
  const amount = digits(headers.get("Tab-Charge-Amount"));
  const asset = headers.get("Tab-Charge-Asset")?.trim();
  if (amount === undefined || asset === undefined || asset === "") return undefined;
  return { amount, asset, openTab: digits(headers.get("Tab-Open-Tab")), headroom: digits(headers.get("Tab-Headroom")) };
}

/**
 * The headers `/api/try` reports an automatic Settlement in: the demonstration
 * Agent paying its own tab before the call (see `try-settle.ts`). Here rather
 * than there because the panel reads them in the browser, and that module
 * holds a signer.
 */
export const AUTO_SETTLE_HEADERS = {
  reason: "Tab-Auto-Settle-Reason",
  amount: "Tab-Auto-Settle-Amount",
  txHash: "Tab-Auto-Settle-Tx",
  error: "Tab-Auto-Settle-Error",
} as const;

/** Why the Agent settled, in words a reader of the panel uses. */
export const AUTO_SETTLE_REASON_WORDS: Readonly<Record<string, string>> = {
  delinquent: "its tab had been marked delinquent",
  window: "half its Settlement Window had passed",
  threshold: "its tab had reached 0.10",
  limit: "its Credit Limit was reached",
  read: "it checks its tab before every call",
};

export type TryAutoSettle =
  | { readonly kind: "settled"; readonly reason: string; readonly amount: bigint; readonly txHash: string }
  | { readonly kind: "failed"; readonly reason: string; readonly message: string };

/** The automatic Settlement a trial call reported, or undefined when there was none. */
export function autoSettleFrom(headers: { get(name: string): string | null }): TryAutoSettle | undefined {
  const reason = headers.get(AUTO_SETTLE_HEADERS.reason)?.trim();
  if (reason === undefined || reason === "") return undefined;
  const error = headers.get(AUTO_SETTLE_HEADERS.error);
  if (error !== null) return { kind: "failed", reason, message: error };
  const amount = digits(headers.get(AUTO_SETTLE_HEADERS.amount));
  const txHash = headers.get(AUTO_SETTLE_HEADERS.txHash)?.trim();
  if (amount === undefined || txHash === undefined || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return undefined;
  return { kind: "settled", reason, amount, txHash };
}

/** A JSON body laid out for reading, or the body as it came when it is not JSON. */
export function readableBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
