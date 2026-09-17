/**
 * `SettlementTimeline` - what one Settlement transaction did, in order.
 *
 * A Settlement on Monad is one transaction with several effects: the Asset
 * leaves the Agent for the Service's collection address, `TabBook` applies as
 * much as the Open Tab can absorb, and any excess is banked as prepaid credit.
 * They happen atomically, but they are still distinct facts with distinct
 * amounts, and a reader checking a tab needs them one at a time. The timeline
 * is that sequence, each entry carrying its own amount and one line of context.
 *
 * It is generic on purpose: an entry is a label, an instant and an amount, so
 * the same list can show a single transaction's effects, or an Agent's history
 * of Settlements against one Service, without knowing which. The caller writes
 * the labels, because only the caller knows what the entries are.
 *
 * It is an ordered list, not a table, because the relationship between rows is
 * sequence rather than a shared set of columns. The ordering is stated in text
 * as well as implied by the markup, and each instant is a `<time>` element with a
 * machine-readable `dateTime`, in UTC so a server render and a client render
 * agree.
 */

import { cn } from "../ui/cn";
import { AssetAmount } from "./asset-amount";
import { formatInstantUtc, toDateTimeAttribute, type AssetUnit } from "./format";

export interface SettlementTimelineEntry {
  /** Stable key. The settlement id, or the id plus an effect name for one transaction. */
  readonly id: string;
  /** What happened, in a few words: `Asset moved to collection`, `Applied to Open Tab`. */
  readonly label: string;
  /** When it happened, in epoch milliseconds. Usually the block time. */
  readonly atMs: number;
  readonly amountBaseUnits: bigint;
  readonly asset: AssetUnit;
  /** One short clause of context, where a view has something to add. */
  readonly note?: string | undefined;
}

export interface SettlementTimelineProps {
  readonly entries: readonly SettlementTimelineEntry[];
  /** The heading above the list. */
  readonly caption?: string | undefined;
  /** The sentence under the heading. Defaults to describing one transaction's effects. */
  readonly description?: string | undefined;
  readonly className?: string | undefined;
}

export function SettlementTimeline({
  entries,
  caption = "Settlement timeline",
  description = "What this transaction did, in the order the contracts did it. Every effect landed in the same Monad block, so there is no interval between the rows.",
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
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>

      {entries.length === 0 ? (
        <p className="font-mono text-sm text-muted-foreground">Nothing recorded yet.</p>
      ) : (
        <ol className="flex flex-col">
          {entries.map((entry, index) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-3 first:border-t-0"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span
                  aria-hidden="true"
                  className="font-mono text-[11px] tracking-widest tabular-nums text-muted-foreground"
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <time
                  dateTime={toDateTimeAttribute(entry.atMs)}
                  className="font-mono text-xs tabular-nums text-muted-foreground"
                >
                  {formatInstantUtc(entry.atMs)}
                </time>
                <span className="font-mono text-xs uppercase tracking-wider text-foreground">
                  {entry.label}
                </span>
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
