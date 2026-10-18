/**
 * `CreditCurveChart` - an Agent's Credit Limit over time, as a step line.
 *
 * Every point comes from the registry's `/agents/:agent/credit-curve/:asset`,
 * which is `LimitLib.creditLimit` recomputed with the time moved: at each
 * Settlement, between them as the repayments it already counts age, and now.
 * So the line is not a trend drawn through a few readings; each step is the
 * figure the contract would have returned at that moment.
 *
 * ## How it reads
 *
 * A step line, because the limit holds its value until something changes it.
 * A dot on the line for each Settlement, so a reader can see that the rises
 * follow repayments and the gentle climb between them is aging.
 *
 * The time axis gives every step a minimum width. Settlements often land
 * seconds apart and the aging that follows takes weeks, so a strictly linear
 * axis stacks the repayments into one edge and hides the jump they cause. A
 * step that lands on a Settlement is drawn at least `MIN_SETTLEMENT_STEP` of the
 * span and any other at least `MIN_STEP`; the rest stays in proportion, and the
 * axis says so. The figures
 * that matter (where it started, where it is now) are text beside the plot,
 * never only shapes, and the SVG carries a sentence for assistive technology.
 *
 * A flat line is a true answer and says why: below three curated, bonded
 * counterparties the limit is the baseline, capped by the Bond, and nothing
 * else moves it.
 *
 * Pure: points in, markup out, no fetch and no state, so it renders on the
 * server and in the tests alike.
 */
import { cn } from "../ui/cn";
import { formatAssetAmount, type AssetUnit } from "./format";

export interface CreditCurvePointInput {
  /** Unix seconds. */
  readonly at: number;
  /** Base units, as the registry serves them. */
  readonly limit: string;
  readonly settlements: number;
  readonly kind: "start" | "settlement" | "aging" | "now";
}

export interface CreditCurveChartProps {
  readonly points: readonly CreditCurvePointInput[];
  readonly asset: AssetUnit;
  /** Whether the curve's last point agrees with the cross-checked limit. A curve that does not is not drawn. */
  readonly agrees: boolean;
  readonly delinquent?: boolean;
  readonly className?: string;
}

const W = 600;
const H = 160;
/** The least share of the span a step that lands on a Settlement is drawn at. */
const MIN_SETTLEMENT_STEP = 0.08;
/** The least share of the span any other step is drawn at. */
const MIN_STEP = 0.01;
/** Settlements drawn as dots on the line; more than this are drawn as ticks on the axis. */
const MAX_DOTS = 12;
const PAD_TOP = 10;
const PAD_BOTTOM = 6;

const dateOf = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export function CreditCurveChart({ points, asset, agrees, delinquent = false, className }: CreditCurveChartProps) {
  const EYEBROW = "font-mono text-[11px] tracking-wider text-muted-foreground uppercase";

  if (!agrees || points.length === 0) {
    return (
      <div className={cn("flex flex-col gap-1", className)}>
        <p className={EYEBROW}>Credit Limit over time</p>
        <p className="text-xs text-muted-foreground">
          The curve is not drawn: its last point could not be matched to the limit TabBook returns now.
        </p>
      </div>
    );
  }

  const limits = points.map((point) => BigInt(point.limit));
  const first = limits[0] ?? 0n;
  const last = limits.at(-1) ?? 0n;
  const max = limits.reduce((top, value) => (value > top ? value : top), 0n);
  const t0 = points[0]?.at ?? 0;
  const t1 = points.at(-1)?.at ?? t0;
  const span = Math.max(1, t1 - t0);
  const scaleMax = max === 0n ? 1 : Number(max) * 1.12;

  // Positions along the axis: each gap at least its minimum share of the span, then normalised.
  // Many Settlements share the room, so the dots never pile into one another.
  const settlementCount = points.filter((point) => point.kind === "settlement").length;
  const settlementStep = Math.min(MIN_SETTLEMENT_STEP, 0.9 / Math.max(1, settlementCount));
  // Past a dozen, Settlements are ticks on the axis rather than dots on the line, which would overlap.
  const asTicks = settlementCount > MAX_DOTS;
  const positions: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    const least = points[i]?.kind === "settlement" ? settlementStep : MIN_STEP;
    const gap = Math.max((points[i]?.at ?? 0) - (points[i - 1]?.at ?? 0), span * least);
    positions.push((positions[i - 1] ?? 0) + gap);
  }
  const total = positions.at(-1) || 1;
  const xAt = (i: number): number => (points.length === 1 ? W : ((positions[i] ?? 0) / total) * W);
  const y = (limit: bigint): number => PAD_TOP + (1 - Number(limit) / scaleMax) * (H - PAD_TOP - PAD_BOTTOM);

  // Step after: the limit holds until the next point.
  let path = "";
  points.forEach((point, i) => {
    const px = xAt(i).toFixed(1);
    const py = y(limits[i] ?? 0n).toFixed(1);
    path += i === 0 ? `M${px},${py}` : ` H${px} V${py}`;
  });
  if (points.length === 1) path = `M0,${y(first).toFixed(1)} H${W}`;
  const area = `${path} V${H} H0 Z`;

  const settlements = points.filter((point) => point.kind === "settlement");
  const dots = points.flatMap((point, i) =>
    point.kind === "settlement" ? [{ key: `${point.at}-${point.settlements}`, left: (xAt(i) / W) * 100, top: (y(limits[i] ?? 0n) / H) * 100 }] : [],
  );
  const start = formatAssetAmount(first, asset, 2);
  const now = formatAssetAmount(last, asset, 2);
  const flat = first === last;
  const summary = flat
    ? `Credit Limit flat at ${now.decimal} ${now.symbol} across ${settlements.length} Settlements.`
    : `Credit Limit ${last > first ? "rose" : "fell"} from ${start.decimal} to ${now.decimal} ${now.symbol} across ${settlements.length} Settlements since ${dateOf(t0)}.`;

  return (
    <figure className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <figcaption className={EYEBROW}>Credit Limit over time</figcaption>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          {flat ? (
            <>
              flat at <span className="text-foreground">{now.decimal}</span> {now.symbol}
            </>
          ) : (
            <>
              {start.decimal} <span aria-hidden="true">&rarr;</span>{" "}
              <span className="text-foreground">{now.decimal}</span> {now.symbol}
            </>
          )}
        </p>
      </div>

      {/* Dots sit over the stretched plot as real circles, so the line can fill any width without bending them into ovals. */}
      <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        className="h-32 w-full overflow-visible"
      >
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="stroke-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d={area} className="fill-teal-600 opacity-[0.08] dark:fill-teal-400" />
        <path d={path} fill="none" className="stroke-teal-700 dark:stroke-teal-400" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      {dots.map((dot) =>
        asTicks ? (
          <span
            key={dot.key}
            aria-hidden="true"
            data-settlement-dot=""
            className="absolute bottom-0 h-1.5 w-px -translate-x-1/2 bg-teal-700 dark:bg-teal-400"
            style={{ left: `${dot.left}%` }}
          />
        ) : (
          <span
            key={dot.key}
            aria-hidden="true"
            data-settlement-dot=""
            className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-teal-700 bg-background dark:border-teal-400"
            style={{ left: `${dot.left}%`, top: `${dot.top}%` }}
          />
        ),
      )}
      </div>

      <div className="flex justify-between gap-3 font-mono text-[11px] text-muted-foreground">
        <span className="whitespace-nowrap">{dateOf(t0)}</span>
        <span className="text-center">
          {settlements.length} Settlement{settlements.length === 1 ? "" : "s"}
          <span className="hidden sm:inline">{asTicks ? ", ticks on the axis" : ", dots on the line"}, spaced so each shows</span>
        </span>
        <span className="whitespace-nowrap">now</span>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {delinquent
          ? "A delinquent tab holds the limit at zero until it is settled; the line shows what the repayments alone would give."
          : flat
            ? "Flat is a true answer: below three curated, bonded counterparties the limit is the baseline capped by the Bond, and only repayments to more of them move it."
            : "Each step is LimitLib's own figure at that moment: rises follow repayments, and the climb between them is what is already repaid aging in."}{" "}
        Stake is today&apos;s.
      </p>
    </figure>
  );
}
