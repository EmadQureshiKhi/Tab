/**
 * `CreditGauge` — an Agent's Credit Limit, Open Tab, and headroom for one Asset.
 *
 * ## One Asset at a time
 *
 * Credit is computed per Asset and a Verified Settlement in another Asset is
 * excluded from that computation, so a gauge is always about one Asset and its
 * symbol appears on every figure. There is no aggregate reading here to mistake
 * for a portfolio.
 *
 * ## The three figures are read, not derived
 *
 * `TabBook` exposes the Credit Limit, the Open Tab, and the available headroom as
 * separate public reads, and this component displays what it was given rather
 * than recomputing headroom from the other two. If the three ever disagree, the
 * right outcome is a visible disagreement a reader can report, not a number this
 * component invented to paper over it.
 *
 * ## Accessibility
 *
 * The bar is a `meter` with `aria-valuetext` carrying the exact figures in
 * words, because `aria-valuenow` takes a float and every amount here is an
 * integer count of base units. Support for the `meter` role varies across
 * assistive technology, so nothing depends on it: all three figures are also
 * plain text immediately below, in a description list, formatted by the same
 * numeric rule.
 *
 * Delinquency is carried by an icon and by words, and deliberately not by a
 * colour. The palette publishes no delinquency colour — its checked colours are
 * the accent, the two tiers, and the five clearing states — and borrowing a
 * clearing colour for a tab state would say something untrue about the clearing.
 * Words and a shape say it exactly.
 *
 * Requirements: 24.10
 */

import { cn } from "../ui/cn";
import { AssetAmount } from "./asset-amount";
import { formatAssetAmount, shareOf, toAriaValue, type AssetUnit } from "./format";
import { WarningIcon } from "./icons";

export interface CreditGaugeProps {
  readonly asset: AssetUnit;
  /** The Credit Limit for this Asset, in base units. */
  readonly creditLimitBaseUnits: bigint;
  /** The Open Tab for this Asset, in base units. */
  readonly openTabBaseUnits: bigint;
  /** The headroom read from the same source, in base units. */
  readonly headroomBaseUnits: bigint;
  /**
   * True once the tab has passed its Settlement Window. The Credit Limit for the
   * Asset is zero while this holds, and no Bond is slashed for it.
   */
  readonly delinquent?: boolean | undefined;
  readonly className?: string | undefined;
}

const LABEL_CLASS = "font-mono text-xs uppercase tracking-wider text-muted-foreground";

export function CreditGauge({
  asset,
  creditLimitBaseUnits,
  openTabBaseUnits,
  headroomBaseUnits,
  delinquent = false,
  className,
}: CreditGaugeProps) {
  const limit = formatAssetAmount(creditLimitBaseUnits, asset);
  const open = formatAssetAmount(openTabBaseUnits, asset);
  const headroom = formatAssetAmount(headroomBaseUnits, asset);
  const utilisation = shareOf(openTabBaseUnits, creditLimitBaseUnits);

  const valueText =
    creditLimitBaseUnits <= 0n
      ? `Open Tab ${open.text}. Credit Limit ${limit.text}, so there is no headroom to draw on.`
      : `Open Tab ${open.text} of a Credit Limit of ${limit.text}. Headroom ${headroom.text}.`;

  return (
    <section
      aria-labelledby="credit-gauge-heading"
      className={cn("raised-panel flex flex-col gap-4 rounded-[2px] p-6", className)}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="credit-gauge-heading" className="font-mono text-sm uppercase tracking-wider text-foreground">
          Credit in {asset.symbol}
        </h3>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {utilisation.toFixed(2)}% drawn
        </span>
      </header>

      <div
        role="meter"
        aria-label={`Open Tab against Credit Limit in ${asset.symbol}`}
        aria-valuemin={0}
        aria-valuemax={toAriaValue(creditLimitBaseUnits, asset.decimals)}
        aria-valuenow={toAriaValue(openTabBaseUnits, asset.decimals)}
        aria-valuetext={valueText}
        className="h-2.5 w-full overflow-hidden rounded-[2px] border border-border bg-background"
      >
        <div className="h-full bg-accent" style={{ width: `${utilisation}%` }} />
      </div>

      <dl className="flex flex-col">
        <div className="flex items-center justify-between gap-4 py-2">
          <dt className={LABEL_CLASS}>Credit Limit</dt>
          <dd>
            <AssetAmount baseUnits={creditLimitBaseUnits} asset={asset} emphasis="strong" />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-border py-2">
          <dt className={LABEL_CLASS}>Open Tab</dt>
          <dd>
            <AssetAmount baseUnits={openTabBaseUnits} asset={asset} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-border py-2">
          <dt className={LABEL_CLASS}>Headroom</dt>
          <dd>
            <AssetAmount baseUnits={headroomBaseUnits} asset={asset} />
          </dd>
        </div>
      </dl>

      {delinquent ? (
        <p className="inline-flex items-start gap-2 border-t border-border pt-3 text-sm font-medium text-foreground">
          <WarningIcon className="mt-0.5 size-4" />
          <span>
            Delinquent. This tab passed its Settlement Window, so the Credit Limit for{" "}
            {asset.symbol} is zero until it is settled. No Bond is slashed for an Agent that has
            not settled.
          </span>
        </p>
      ) : null}
    </section>
  );
}

export default CreditGauge;
