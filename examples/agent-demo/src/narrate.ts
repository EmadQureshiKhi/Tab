/**
 * Turning the readings into something a person can follow.
 *
 * This demo exists to be watched, so the narration is part of the deliverable
 * rather than decoration around it. Everything here is a pure function of values
 * the acts already hold, which means the wording is testable and the acts stay
 * free of formatting.
 *
 * Two conventions the whole file keeps:
 *
 * - **Base units are shown twice.** Once as the integer the chain holds and once
 *   as a decimal, because a demo that only prints `0.01 USDC` invites the reader
 *   to forget that nothing on the rail is ever a float.
 * - **A delta is signed and it keeps its sign.** A tab going down is `-10000`,
 *   not `10000` under a word like "reduced". The reader is comparing these
 *   against the chain, and re-signing them in prose would make that harder.
 */

import type { LedgerDelta, PayerResolution } from "./ledger.js";

/** Renders base units as an exact decimal, with no rounding and no exponent. */
export function formatBaseUnits(amount: bigint, decimals: number, symbol: string): string {
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = magnitude / scale;
  const fraction = magnitude % scale;
  const rendered =
    decimals === 0
      ? whole.toString()
      : `${whole.toString()}.${fraction.toString().padStart(decimals, "0")}`;
  return `${negative ? "-" : ""}${rendered} ${symbol} (${amount.toString()} base units)`;
}

/** An address shortened for prose, keeping enough of both ends to be checkable. */
export const shortAddress = (address: string): string =>
  address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;

/** A signed integer with an explicit `+`, so a rise and a fall are visibly different. */
export const signed = (value: bigint | number): string =>
  value > 0 ? `+${value.toString()}` : value.toString();

/** The banner that opens an act. */
export function actHeader(number: number, title: string, synopsis: string): string {
  const heading = `Act ${String(number)}. ${title}`;
  return [heading, "-".repeat(heading.length), synopsis, ""].join("\n");
}

/**
 * What moved for one Agent, one line per field, silent fields omitted.
 *
 * An unchanged field is left out rather than printed as zero. A pass over the
 * rail touches three or four fields out of eight, and printing the other four as
 * zeroes buries the ones that matter.
 */
export function describeDelta(
  name: string,
  delta: LedgerDelta,
  decimals: number,
  symbol: string,
): readonly string[] {
  if (delta.quiet) return [`  ${name}: nothing moved`];
  const lines: string[] = [`  ${name}:`];
  const money = (label: string, value: bigint): void => {
    if (value !== 0n) lines.push(`    ${label} ${signed(value)} = ${formatBaseUnits(value, decimals, symbol)}`);
  };
  money("open tab", delta.open);
  money("prepaid credit", delta.prepaid);
  money("authorisation spent", delta.authorisationSpent);
  money("wallet balance", delta.walletBalance);
  money("smart account balance", delta.smartAccountBalance);
  if (delta.deliveryCount !== 0) lines.push(`    deliveries ${signed(delta.deliveryCount)}`);
  if (delta.historyCount !== 0) lines.push(`    settlement history entries ${signed(delta.historyCount)}`);
  return lines;
}

/** The verdict of act four, with each check on its own line under it. */
export function describeVerdict(resolution: PayerResolution): readonly string[] {
  return [
    `  payer resolution: ${resolution.verdict}`,
    ...resolution.reasons.map((reason) => `    - ${reason}`),
  ];
}
