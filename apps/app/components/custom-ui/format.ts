/**
 * The presentation rules for numbers and time in the Dashboard.
 *
 * Two rules live here and nothing in `custom-ui` formats a number or an instant
 * without going through them.
 *
 * ## The numeric rule (design section 12.4)
 *
 * Every amount in the contracts is an integer count of Asset base units, and
 * USDC carries six decimals. A view therefore renders the **decimal Asset unit
 * with its symbol** — `5.00 USDC` — and carries the **exact base-unit integer**
 * in `title`, so a screen reader never announces a bare nine-digit integer and
 * nothing is lost to rounding. The conversion is exact: it is integer division
 * on `bigint`, never a float, so `1234567` base units renders `1.234567 USDC`
 * rather than a rounded figure.
 *
 * ## The time rule
 *
 * Instants render in UTC from the ISO form, so a server render and a client
 * render agree byte for byte and hydration is stable. A countdown degrades
 * honestly: once the deadline has passed it says so and states how long ago,
 * rather than clamping to zero and implying time still remains.
 *
 * Requirements: 24.10, 11.8, 11.9
 */

/** The minimum an Asset descriptor must carry for an amount to be renderable. */
export interface AssetUnit {
  readonly symbol: string;
  readonly decimals: number;
}

/** One amount, rendered every way a view needs it. */
/**
 * Assets this Dashboard can name, keyed by lowercase address.
 *
 * An unknown Asset is rendered by its address at zero decimals, so the figure
 * shown is the exact base-unit integer and is not scaled by a guess. Labelling it
 * USDC would be inventing a fact, and scaling by 6 would print a wrong number.
 *
 * **This table is mirrored in `src/dashboard/views.ts` and the two must agree.**
 * The mirror is structural rather than sloppy: `components/` is a build project
 * with its own `rootDir` and cannot import from `src/`, which is what keeps the
 * composites free of the registry client and renderable in a client bundle. The
 * same isolation is why `AssetUnit` itself is mirrored there. The single copy both
 * trees could share belongs in `@tabai/shared`, which is another package.
 */
const KNOWN_ASSETS: Readonly<Record<string, AssetUnit>> = {
  "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": { symbol: "USDC", decimals: 6 },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
};

/** The Asset an amount is denominated in, by contract address. */
export function assetUnitFor(address: string): AssetUnit {
  const known = KNOWN_ASSETS[address.toLowerCase()];
  if (known !== undefined) return known;
  return { symbol: `${address.slice(0, 6)}\u2026${address.slice(-4)}`, decimals: 0 };
}

export interface FormattedAmount {
  /** Decimal Asset units with the symbol, for display: `5.00 USDC`. */
  readonly text: string;
  /** Decimal Asset units alone: `5.00`. */
  readonly decimal: string;
  readonly symbol: string;
  /** The exact base-unit integer, for the `title` attribute. */
  readonly baseUnits: string;
  /** The full `title` string: the base-unit integer plus the scale it is on. */
  readonly title: string;
}

const GROUP_EVERY = 3;

/** Inserts a comma every three digits, from the right. */
function groupDigits(digits: string): string {
  let grouped = "";
  for (let index = digits.length; index > 0; index -= GROUP_EVERY) {
    const from = Math.max(0, index - GROUP_EVERY);
    const chunk = digits.slice(from, index);
    grouped = grouped.length === 0 ? chunk : `${chunk},${grouped}`;
  }
  return grouped.length === 0 ? "0" : grouped;
}

/**
 * Converts an integer count of base units to its exact decimal form.
 *
 * Trailing zeros are trimmed, but never below `minimumFractionDigits`, so a
 * whole amount still reads `5.00` while a precise one keeps every digit it has.
 * No rounding occurs at any point.
 *
 * @param baseUnits integer base units; a negative value keeps its sign rather
 *        than throwing, because a render is the wrong place to fail
 * @throws RangeError when `decimals` is not a plausible token scale
 */
export function toDecimalUnits(
  baseUnits: bigint,
  decimals: number,
  minimumFractionDigits = 2,
): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(
      `toDecimalUnits: decimals must be an integer in [0, 36], received ${decimals}`,
    );
  }

  const negative = baseUnits < 0n;
  const magnitude = negative ? -baseUnits : baseUnits;
  const scale = 10n ** BigInt(decimals);
  const whole = groupDigits((magnitude / scale).toString());
  const sign = negative ? "-" : "";

  if (decimals === 0) return `${sign}${whole}`;

  const padded = (magnitude % scale).toString().padStart(decimals, "0");
  const floor = Math.max(0, Math.min(minimumFractionDigits, decimals));
  let end = padded.length;
  while (end > floor && padded.charAt(end - 1) === "0") end -= 1;
  const fraction = padded.slice(0, end);

  return fraction.length === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

/**
 * The numeric rule in one call: decimal units with the symbol for display, the
 * exact base-unit integer for `title`.
 */
export function formatAssetAmount(
  baseUnits: bigint,
  asset: AssetUnit,
  minimumFractionDigits = 2,
): FormattedAmount {
  const decimal = toDecimalUnits(baseUnits, asset.decimals, minimumFractionDigits);
  const exact = baseUnits.toString();
  return {
    text: `${decimal} ${asset.symbol}`,
    decimal,
    symbol: asset.symbol,
    baseUnits: exact,
    title: `${exact} base units (${asset.symbol}, ${asset.decimals} decimals)`,
  };
}

/** `part` as a percentage of `total`, to two decimals, clamped to [0, 100]. */
export function shareOf(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  const clamped = part < 0n ? 0n : part > total ? total : part;
  return Number((clamped * 10000n) / total) / 100;
}

/**
 * A number ARIA can carry in `aria-valuenow`, derived from the exact decimal
 * string. ARIA takes a float, so this is the one place a base-unit amount
 * becomes approximate — which is why every caller also supplies the exact text
 * in `aria-valuetext`.
 */
export function toAriaValue(baseUnits: bigint, decimals: number): number {
  const parsed = Number(toDecimalUnits(baseUnits, decimals, 0).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

interface DurationPart {
  readonly value: number;
  readonly short: string;
  readonly singular: string;
}

function splitDuration(ms: number): readonly DurationPart[] {
  const total = Math.max(0, Math.floor(ms));
  return [
    { value: Math.floor(total / MS_PER_DAY), short: "d", singular: "day" },
    { value: Math.floor((total % MS_PER_DAY) / MS_PER_HOUR), short: "h", singular: "hour" },
    { value: Math.floor((total % MS_PER_HOUR) / MS_PER_MINUTE), short: "m", singular: "minute" },
    { value: Math.floor((total % MS_PER_MINUTE) / MS_PER_SECOND), short: "s", singular: "second" },
  ];
}

/** The two most significant non-zero units, compactly: `12m 30s`, `1d 3h`. */
export function formatDurationShort(ms: number): string {
  const parts = splitDuration(ms).filter((part) => part.value > 0).slice(0, 2);
  if (parts.length === 0) return "0s";
  return parts.map((part) => `${part.value}${part.short}`).join(" ");
}

/** The same duration in words, for an accessible name. */
export function formatDurationSpoken(ms: number): string {
  const parts = splitDuration(ms).filter((part) => part.value > 0).slice(0, 2);
  if (parts.length === 0) return "less than a second";
  return parts
    .map((part) => `${part.value} ${part.singular}${part.value === 1 ? "" : "s"}`)
    .join(" ");
}

/** Where a deadline stands relative to a given clock. */
export interface DeadlineDescription {
  /** True once the deadline is at or behind `nowMs`. */
  readonly passed: boolean;
  /** Absolute milliseconds between the deadline and `nowMs`. */
  readonly distanceMs: number;
  /** Compact form for display: `12m 30s`. */
  readonly short: string;
  /** Worded form for an accessible name: `12 minutes 30 seconds`. */
  readonly spoken: string;
}

/**
 * Compares a deadline against a clock the caller supplies.
 *
 * The clock is a parameter rather than a read of `Date.now()` so a server render
 * is reproducible and a test needs no fake timers.
 */
export function describeDeadline(deadlineMs: number, nowMs: number): DeadlineDescription {
  const delta = deadlineMs - nowMs;
  const distanceMs = Math.abs(delta);
  return {
    passed: delta <= 0,
    distanceMs,
    short: formatDurationShort(distanceMs),
    spoken: formatDurationSpoken(distanceMs),
  };
}

/**
 * An instant as `2026-08-30 14:03 UTC`.
 *
 * UTC, and derived from the ISO form rather than from a locale formatter, so the
 * server and the client produce the same characters and hydration is stable.
 */
export function formatInstantUtc(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** The clock time alone, as `14:03 UTC`. */
export function formatClockUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

/** The machine-readable form for a `<time dateTime>` attribute. */
export function toDateTimeAttribute(ms: number): string {
  return new Date(ms).toISOString();
}
