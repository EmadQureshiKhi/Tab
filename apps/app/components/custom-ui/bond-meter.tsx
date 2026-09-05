/**
 * `BondMeter` — a bonded party's Bond, one Asset at a time.
 *
 * ## Why there is no total
 *
 * A Bond is accounted per Asset in an isolated balance, and a Provisional
 * Clearing is covered only by free Bond in the Settlement's own Asset. A single
 * pooled figure would therefore be a false claim about coverage, so this
 * component renders one panel per Asset, each with its own heading, its own bar,
 * and its own five figures. Nothing here adds up across Assets, and the caption
 * says so, because the absence of a total is a fact about the design rather than
 * an omission.
 *
 * ## Reading the bar
 *
 * Each bar is one Asset's stake, divided into reserved, slashed, released, and
 * free. Every segment is also a labelled row underneath with its exact amount, so
 * the bar is a summary of information that is fully present in text; the bar
 * itself is `role="img"` with a name that states every part in words.
 *
 * Segments are separated by a gap that shows the panel behind them rather than by
 * a border between neighbours. Each segment fill is a design token checked
 * against both surfaces at the 3:1 non-text threshold, so separation rests on a
 * pair the contrast script actually evaluates instead of on an unchecked
 * segment-against-segment comparison.
 *
 * ## When the reads disagree
 *
 * If reserved, slashed, and released together exceed staked, the derived free
 * amount is negative and something upstream is wrong. The panel says that
 * plainly instead of clamping the number and rendering a plausible bar.
 *
 * Requirements: 24.10
 */

import { cn } from "../ui/cn";
import { AssetAmount } from "./asset-amount";
import {
  bondSegments,
  derivedFreeBaseUnits,
  isLedgerConsistent,
  type BondAssetLedger,
} from "./bond";
import { formatAssetAmount, shareOf } from "./format";
import { WarningIcon } from "./icons";

export interface BondMeterProps {
  /** One ledger per accepted Asset. Order is the caller's. */
  readonly ledgers: readonly BondAssetLedger[];
  /** The heading above the set of panels. */
  readonly caption?: string | undefined;
  readonly className?: string | undefined;
}

const LABEL_CLASS = "font-mono text-xs uppercase tracking-wider text-muted-foreground";

function LedgerPanel({ ledger }: { readonly ledger: BondAssetLedger }) {
  const { asset } = ledger;
  const headingId = `bond-${asset.symbol}-heading`;
  const consistent = isLedgerConsistent(ledger);
  const staked = formatAssetAmount(ledger.stakedBaseUnits, asset);
  const segments = bondSegments(ledger);

  const spokenParts = segments.map(
    (segment) => `${segment.label} ${formatAssetAmount(segment.baseUnits, asset).text}`,
  );
  const barName = `Bond in ${asset.symbol}: staked ${staked.text}, of which ${spokenParts.join(
    ", ",
  )}.`;

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 border-t border-border pt-4 first:border-t-0 first:pt-0"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 id={headingId} className="font-mono text-sm uppercase tracking-wider text-foreground">
          {asset.symbol}
        </h4>
        <span className={LABEL_CLASS}>
          Staked <AssetAmount baseUnits={ledger.stakedBaseUnits} asset={asset} emphasis="strong" />
        </span>
      </header>

      {ledger.stakedBaseUnits <= 0n ? (
        <p className="font-mono text-sm text-muted-foreground">No Bond posted in {asset.symbol}.</p>
      ) : consistent ? (
        <div
          role="img"
          aria-label={barName}
          className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-[2px] border border-border bg-background"
        >
          {segments.map((segment) => (
            <div
              key={segment.key}
              className={cn("h-full", segment.fillClassName)}
              style={{ width: `${shareOf(segment.baseUnits, ledger.stakedBaseUnits)}%` }}
            />
          ))}
        </div>
      ) : (
        <p className="inline-flex items-start gap-2 text-sm font-medium text-foreground">
          <WarningIcon className="mt-0.5 size-4" />
          <span>
            These reads disagree: reserved, slashed, and released together exceed staked, which
            leaves a free amount of{" "}
            <AssetAmount baseUnits={derivedFreeBaseUnits(ledger)} asset={asset} />. No bar is drawn
            for figures that cannot coexist.
          </span>
        </p>
      )}

      <dl className="flex flex-col">
        {segments.map((segment) => (
          <div
            key={segment.key}
            className="flex items-center justify-between gap-4 border-t border-border py-2 first:border-t-0"
          >
            <dt className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn("size-2.5 shrink-0 rounded-[1px]", segment.fillClassName)}
              />
              <span className={LABEL_CLASS}>{segment.label}</span>
              <span className="text-xs text-muted-foreground">{segment.meaning}</span>
            </dt>
            <dd>
              <AssetAmount baseUnits={segment.baseUnits} asset={asset} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function BondMeter({ ledgers, caption = "Bond", className }: BondMeterProps) {
  const headingId = "bond-meter-heading";

  return (
    <section
      aria-labelledby={headingId}
      // `rounded-lg` rather than the `rounded-[2px]` its sibling panels use: this
      // one's neighbours are the analytics figures and the Service card, and both
      // of those are soft-cornered.
      className={cn("raised-panel flex flex-col gap-4 rounded-lg p-6", className)}
    >
      <header className="flex flex-col gap-1">
        {/*
          `break-all` because this caption ends in a 42-character address, and a
          heading that cannot break sets the min-content width of the panel it is
          in. At 390px that carried the whole analytics page 33px past the viewport
          and scrolled the document sideways.
        */}
        <h3
          id={headingId}
          className="font-mono text-sm tracking-wider break-all text-foreground uppercase"
        >
          {caption}
        </h3>
        <p className="text-xs text-muted-foreground">
          One ledger per Asset, accounted in isolation. Free Bond in one Asset cannot cover a
          clearing in another, so no figure below is a total across Assets. Free is staked minus
          reserved, slashed, and released.
        </p>
      </header>

      {ledgers.length === 0 ? (
        <p className="font-mono text-sm text-muted-foreground">No Bond posted in any Asset.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {ledgers.map((ledger) => (
            <LedgerPanel key={ledger.asset.symbol} ledger={ledger} />
          ))}
        </div>
      )}
    </section>
  );
}

export default BondMeter;
