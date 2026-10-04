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

/** A JSON body laid out for reading, or the body as it came when it is not JSON. */
export function readableBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
