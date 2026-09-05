/**
 * `SettlementTimeline` — the clearing lineage of an Agent, a Service, or a single
 * Settlement, oldest first.
 *
 * A tab is reduced by clearings, and a clearing moves through states: applied
 * provisionally against a Bond, then confirmed by a Verified Settlement,
 * reversed at its deadline, declined for want of free Bond, or superseded by a
 * Source Chain reorganisation. The timeline is that sequence, so every row
 * carries the state badge rather than only a date and an amount. Labelling each
 * row is the point: no row in the Dashboard shows a clearing without saying
 * which kind it is.
 *
 * It is an ordered list, not a table, because the relationship between rows is
 * sequence rather than a shared set of columns. The ordering is stated in text
 * as well as implied by the markup, and each instant is a `<time>` element with a
 * machine-readable `dateTime`, in UTC so a server render and a client render
 * agree.
 *
 * Requirements: 15.7, 24.10
 */

import { cn } from "../ui/cn";
import { AssetAmount } from "./asset-amount";
import { ClearingBadge } from "./clearing-badge";
import type { ClearingState } from "./clearing-state";
import { formatInstantUtc, toDateTimeAttribute, type AssetUnit } from "./format";

export interface SettlementTimelineEntry {
  /** Stable key. The clearing id, or the replay key where one exists. */
  readonly id: string;
  readonly state: ClearingState;
  /** When the state was reached, in epoch milliseconds. */
  readonly atMs: number;
  readonly amountBaseUnits: bigint;
  readonly asset: AssetUnit;
  /** The confirmation deadline, where the entry is still provisional. */
  readonly deadlineMs?: number | undefined;
  /** One short clause of context, where a view has something to add. */
  readonly note?: string | undefined;
}

export interface SettlementTimelineProps {
  readonly entries: readonly SettlementTimelineEntry[];
  /** The heading above the list. */
  readonly caption?: string | undefined;
  /** A fixed clock, forwarded to every clearing badge. */
  readonly nowMs?: number | undefined;
  readonly className?: string | undefined;
}

export function SettlementTimeline({
  entries,
  caption = "Settlement timeline",
  nowMs,
  className,
}: SettlementTimelineProps) {
  const headingId = "settlement-timeline-heading";

  return (
    <section
      aria-labelledby={headingId}
      className={cn("raised-panel flex flex-col gap-4 rounded-[2px] p-6", className)}
    >
      <header className="flex flex-col gap-1">
        <h3
          id={headingId}
          className="font-mono text-sm uppercase tracking-wider text-foreground"
        >
          {caption}
        </h3>
        <p className="text-xs text-muted-foreground">
          Clearing lineage, oldest first. Every clearing is labelled with its state; a provisional
          clearing also carries the time left before it may be reversed.
        </p>
      </header>

      {entries.length === 0 ? (
        <p className="font-mono text-sm text-muted-foreground">
          No clearing recorded yet.
        </p>
      ) : (
        <ol className="flex flex-col">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-3 first:border-t-0"
            >
              <div className="flex flex-wrap items-center gap-3">
                <time
                  dateTime={toDateTimeAttribute(entry.atMs)}
                  className="font-mono text-xs tabular-nums text-muted-foreground"
                >
                  {formatInstantUtc(entry.atMs)}
                </time>
                <ClearingBadge
                  state={entry.state}
                  deadlineMs={entry.deadlineMs}
                  nowMs={nowMs}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {entry.note === undefined ? null : (
                  <span className="text-xs text-muted-foreground">{entry.note}</span>
                )}
                <AssetAmount
                  baseUnits={entry.amountBaseUnits}
                  asset={entry.asset}
                  emphasis="strong"
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default SettlementTimeline;
