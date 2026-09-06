/**
 * `SplitChart` - one measure, split external against internal.
 *
 * ## Why this is a bar and not a chart library
 *
 * The measure is a two-part split of one total. That is a single proportion, and a
 * proportion is drawn by two rectangles. Recharts is not a dependency of this
 * package and adding one to draw two rectangles would be a poor trade: it is a
 * large client bundle, it needs a client boundary, and it would make this the only
 * server-rendered view on the Dashboard that could not render without JavaScript.
 * The bar below is CSS, renders on the server, and needs no runtime at all.
 *
 * ## Three ways to read the same numbers
 *
 * R24.7 asks for the split and the house rule asks that a chart is never the only
 * way to reach its data. So each of these carries three redundant channels, in the
 * same spirit as `ClearingBadge`:
 *
 * 1. the bar itself, marked `role="img"` and named by an `aria-label` that states
 *    both figures in words, so a screen reader gets the finding rather than the
 *    geometry;
 * 2. a sentence under it, visible to everyone, because a reader who can see the
 *    bar still cannot read a value off it; and
 * 3. a real `<table>` carrying the exact figures.
 *
 * Colour is never the only signal: each segment is labelled in the table, and the
 * summary sentence names which is which.
 *
 * This is a server component. It has no state and no clock.
 *
 * Requirements: 24.7, 29.2, 29.3, 29.4, 24.10
 */

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { SplitBar } from "./split-bar";

export interface SplitChartProps {
  readonly title: string;
  /** What one unit is, for the summary sentence. Singular, e.g. "Verified Settlement". */
  readonly noun: string;
  /**
   * The plural, supplied rather than derived.
   *
   * English plurals are not a suffix rule, and deriving one gave "Metered
   * Deliverys" on this very page. A component that renders a sentence should be
   * given the words rather than guess at them.
   */
  readonly plural: string;
  readonly external: number;
  readonly internal: number;
  /** Rendered under the figures, in the registry's own words. */
  readonly basis: string;
  /**
   * Set where the figures are lower bounds rather than totals, which changes the
   * sentence from "N are" to "at least N are". Not decoration: publishing a lower
   * bound as a total is the specific way this page could mislead.
   */
  readonly lowerBound?: boolean | undefined;
}

/** A percentage for the bar geometry only. Never shown as a figure. */
function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return (part / total) * 100;
}

export function SplitChart({
  title,
  noun,
  plural,
  external,
  internal,
  basis,
  lowerBound,
}: SplitChartProps) {
  const total = external + internal;
  const qualifier = lowerBound === true ? "at least " : "";
  const summary =
    total === 0
      ? `No ${plural} are indexed yet, so there is no split to report.`
      : `${qualifier}${external.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${total === 1 ? noun : plural} came from an address outside this project, and ${internal.toLocaleString("en-US")} from an address inside it.`;

  return (
    <figure className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/30 p-5">
      <figcaption className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
        {title}
      </figcaption>

      {/*
        Named by a label that states the finding, so the bar is announced as one
        thing rather than as a pair of unlabelled boxes.
      */}
      <SplitBar label={`${title}. ${summary}`} externalPercent={percent(external, total)} />

      <p className="text-sm text-foreground">{summary}</p>

      <Table caption={`${title}, exact figures`} captionVisible={false}>
        <TableHeader>
          <TableRow>
            <TableHead>Source</TableHead>
            <TableHead>{lowerBound === true ? "At least" : "Count"}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>External</TableCell>
            <TableCell className="font-mono text-xs">{external.toLocaleString("en-US")}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Internal</TableCell>
            <TableCell className="font-mono text-xs">{internal.toLocaleString("en-US")}</TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <p className="font-mono text-xs text-muted-foreground">{basis}</p>
    </figure>
  );
}
