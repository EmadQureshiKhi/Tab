/**
 * `LabelsStrip` - Nansen's labels for an address, beside the credit gauges.
 *
 * ## An overlay, said to be one
 *
 * A Nansen label says what an address is known to be off chain: an exchange
 * deposit, a fund, a bridge, a behavioural pattern. None of it is checkable
 * against Monad and none of it is read by `TabBook`, so the strip carries the
 * source and the fetch time on every render and says, in one sentence that is
 * always present, that labels change nothing in the Credit Limit. A reader is
 * given the context and left to weigh it.
 *
 * ## A missing key is a fact about the deployment, not a fault
 *
 * A fresh deployment configures no Nansen key, and the registry says so with
 * `NANSEN_KEY_MISSING`. That is rendered as a configuration statement in the
 * same voice as the rest of the page, never in the danger tone: nothing has
 * failed, and a strip that looked broken on every fresh install would teach
 * readers to ignore it.
 *
 * This is a server component. It has no state and no clock.
 */

import { Badge } from "../ui/badge";
import { cn } from "../ui/cn";
import { formatInstantUtc } from "./format";

export interface LabelsStripLabel {
  readonly label: string;
  readonly category: string | undefined;
  readonly kind: string | undefined;
}

/** The labels view, as the view model shapes it. Structural, so the composition layer supplies it. */
export interface LabelsStripView {
  readonly source: "nansen";
  readonly status: "served" | "empty" | "not-configured" | "unavailable" | "not-served";
  readonly statement: string;
  readonly chain: string | undefined;
  readonly fetchedAt: string | undefined;
  readonly entity: string | undefined;
  readonly labels: readonly LabelsStripLabel[];
}

export interface LabelsStripProps {
  readonly view: LabelsStripView;
  /** The one sentence about what a label is not. Supplied so the page and the test share the wording. */
  readonly offchainStatement: string;
  readonly className?: string | undefined;
}

/** An ISO instant as `YYYY-MM-DD HH:MM UTC`, or the raw text where it will not parse. */
function fetchedText(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : formatInstantUtc(ms);
}

export function LabelsStrip({ view, offchainStatement, className }: LabelsStripProps) {
  return (
    <aside
      aria-label="Labels from Nansen"
      className={cn("flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/30 p-5", className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
          Labels, from Nansen
        </p>
        {view.fetchedAt === undefined ? null : (
          <p className="font-mono text-[11px] text-muted-foreground">
            fetched {fetchedText(view.fetchedAt)}
            {view.chain === undefined ? "" : `, chain ${view.chain}`}
          </p>
        )}
      </div>

      {view.status === "served" ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={view.statement}>
          {view.labels.map((label) => (
            <li key={`${label.label}:${label.category ?? ""}`}>
              <Badge
                variant="outline"
                tone="neutral"
                title={[label.category, label.kind].filter((part) => part !== undefined).join(" · ") || undefined}
              >
                {label.label}
                {label.category === undefined ? null : (
                  <span className="text-muted-foreground"> · {label.category}</span>
                )}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-foreground">{view.statement}</p>
      )}

      {view.entity === undefined ? null : (
        <p className="font-mono text-xs text-foreground">
          <span className="text-muted-foreground">Entity </span>
          {view.entity}
        </p>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">{offchainStatement}</p>
    </aside>
  );
}

export default LabelsStrip;
