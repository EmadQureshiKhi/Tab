/**
 * `AssetAmount` — the numeric rule, as a component.
 *
 * Every amount in the contracts is an integer count of Asset base units, and
 * USDC carries six decimals. Rendering that integer raw would put a nine-digit
 * number in front of a reader and a nine-digit number into a screen reader's
 * mouth, and rendering it as a float would lose the exact value. So:
 *
 * - the visible text is decimal Asset units followed by the symbol — `5.00 USDC`
 *   — which is also what a screen reader announces, units included, so WCAG
 *   1.3.1 gets an explicit unit rather than an abbreviation to guess at;
 * - the `title` carries the exact base-unit integer and the scale it sits on, so
 *   the precise on-chain figure is one hover away and nothing is lost.
 *
 * The conversion is integer arithmetic on `bigint` throughout. There is no
 * rounding step anywhere, so `1234567` base units renders `1.234567 USDC`.
 *
 * A note on the limits of `title`. It is what the design specifies, and it is
 * reliable for a pointer, but it is not reachable by keyboard alone and its
 * exposure to assistive technology varies. It is therefore an addition to the
 * visible decimal figure, never the only place a fact lives — the amount that
 * matters is on screen and in the accessible name of whatever contains it.
 *
 * Requirements: 24.10
 */

import { cn } from "../ui/cn";
import { formatAssetAmount, type AssetUnit } from "./format";

export interface AssetAmountProps {
  /** The exact base-unit integer, as it appears in the contracts. */
  readonly baseUnits: bigint;
  readonly asset: AssetUnit;
  /**
   * Fraction digits kept even when they are zero, so a whole amount still reads
   * `5.00`. Digits beyond this are kept whenever they are significant.
   */
  readonly minimumFractionDigits?: number | undefined;
  /** Emphasis. `strong` is for the figure a view is actually about. */
  readonly emphasis?: "strong" | "muted" | undefined;
  readonly className?: string | undefined;
}

export function AssetAmount({
  baseUnits,
  asset,
  minimumFractionDigits = 2,
  emphasis,
  className,
}: AssetAmountProps) {
  const amount = formatAssetAmount(baseUnits, asset, minimumFractionDigits);

  return (
    <span
      title={amount.title}
      className={cn(
        "font-mono tabular-nums whitespace-nowrap",
        emphasis === "muted" ? "text-muted-foreground" : "text-foreground",
        emphasis === "strong" ? "font-medium" : undefined,
        className,
      )}
    >
      {amount.decimal} <span className="text-muted-foreground">{amount.symbol}</span>
    </span>
  );
}

export default AssetAmount;
