/**
 * `OverdueTabs` - the tabs anybody may mark delinquent, and the call to make.
 *
 * ## Why a Dashboard shows this at all
 *
 * `TabBook.markDelinquent` is permissionless, and the contract says why: the
 * Service that metered a tab is also the party whose Credit Limit weight
 * benefits from the Agent staying in good standing, so delinquency liveness must
 * not depend on it. Anyone may mark a tab once its Settlement Window has passed,
 * and the mark zeroes the Agent's Credit Limit in that Asset until it settles.
 *
 * A permissionless call is only permissionless in practice if an outsider can
 * discover that it is due and what to pass it. So this view prints the tab id
 * and the whole command, filled in, rather than describing the mechanism and
 * leaving a reader to assemble calldata. The difference between those two is the
 * difference between a guarantee and a claim about one.
 *
 * ## Every figure states the block it came from
 *
 * The verdict is a comparison against a block timestamp, not against the viewer's
 * clock, so the block it was computed at is shown beside it. A reader can then see
 * how fresh the answer is instead of assuming it is current, which matters here
 * more than elsewhere: somebody may mark or settle a row between this render and
 * the reader's click, and the honest presentation of that is a stated age rather
 * than a promise of liveness.
 *
 * This is a server component. It has no state and no clock.
 */

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { AssetAmount } from "../custom-ui/asset-amount";
import { CopyButton } from "../custom-ui/copy-button";
import type { AssetUnit } from "../custom-ui/format";

/** One tab, reduced to what a reader needs to act. */
export interface OverdueTabRowView {
  readonly tabId: string;
  readonly agent: string;
  readonly serviceName?: string | undefined;
  readonly serviceId: string;
  readonly asset: AssetUnit;
  /** What is unsettled on the tab. */
  readonly openBaseUnits: bigint;
  /** The Service's Settlement Window, in seconds. */
  readonly windowSeconds: number;
  /** Seconds past the window end, as a positive number. */
  readonly overdueSeconds: number;
  /** Rendered elsewhere, from the chain's clock, never from the browser's. */
  readonly overdueLabel: string;
  /** The whole `cast send` command, already filled in. */
  readonly command: string;
}

export interface OverdueTabsProps {
  readonly rows: readonly OverdueTabRowView[];
  /** How many are open but still inside their window, so "none overdue" is distinguishable from "none at all". */
  readonly pendingCount: number;
  /** The block every state and verdict here was read at. */
  readonly atBlock: number;
  /** The `TabBook` address the command targets. Shown so a reader can check it against the deployment. */
  readonly tabBook: string;
  readonly className?: string | undefined;
}

const MONO = "font-mono text-xs";

/** Middle-truncated, with the full value in `title` so nothing is lost. */
function short(value: string, head = 10, tail = 6): string {
  return value.length <= head + tail + 1
    ? value
    : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** `1d 2h`, `45m`, from a whole number of seconds. */
function windowLabel(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

export function OverdueTabs({ rows, pendingCount, atBlock, tabBook, className }: OverdueTabsProps) {
  if (rows.length === 0) {
    return (
      <div
        className={
          className ??
          "rounded-md border border-dashed border-border bg-card px-6 py-10 text-center"
        }
      >
        <p className="text-sm text-foreground">
          No Open Tab has passed its Settlement Window unmarked, so there is nothing to mark.
        </p>
        {/*
          The two numbers below are what make this an answer rather than a blank.
          A reader can see that tabs were looked at, how many are still inside
          their window, and which block the verdict describes.
        */}
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          {pendingCount === 0
            ? "No tab is currently open"
            : `${pendingCount} tab${pendingCount === 1 ? " is" : "s are"} open and still inside the Settlement Window`}
          , read at Monad block {atBlock.toLocaleString("en-US")}.
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <Table
        caption="Open Tabs past their Settlement Window, which anyone may mark delinquent"
        captionVisible={false}
      >
        <TableHeader>
          <TableRow>
            <TableHead>Tab</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Service</TableHead>
            <TableHead>Open</TableHead>
            <TableHead>Window</TableHead>
            <TableHead>Overdue by</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.tabId}>
              <TableCell className={MONO} title={row.tabId}>
                {short(row.tabId)}
              </TableCell>
              <TableCell className={MONO} title={row.agent}>
                {short(row.agent, 8, 4)}
              </TableCell>
              <TableCell className={MONO} title={row.serviceId}>
                {row.serviceName ?? `${row.serviceId.slice(0, 10)}…`}
              </TableCell>
              <TableCell>
                <AssetAmount baseUnits={row.openBaseUnits} asset={row.asset} />
              </TableCell>
              <TableCell className={`${MONO} tabular-nums`}>{windowLabel(row.windowSeconds)}</TableCell>
              <TableCell className={`${MONO} tabular-nums`}>{row.overdueLabel}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="mt-4 flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Marking is permissionless. Anyone may call{" "}
          <code className="font-mono">markDelinquent</code> on{" "}
          <code className="font-mono break-all" title={tabBook}>
            TabBook
          </code>{" "}
          once the Settlement Window has closed, and the Service that metered the tab has no
          special standing to do it. The mark zeroes the Agent&apos;s Credit Limit in that Asset
          until it settles. The Service&apos;s Bond is untouched: an Agent that has not paid
          costs the Service nothing beyond the unpaid tab.
        </p>
        {rows.map((row) => (
          <div
            key={`${row.tabId}-command`}
            className="flex items-start gap-2 rounded-md border border-border bg-background p-3"
          >
            <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs text-foreground">
              <code>{row.command}</code>
            </pre>
            <CopyButton text={row.command} label={`the mark command for tab ${short(row.tabId)}`} />
          </div>
        ))}
        <p className="font-mono text-xs text-muted-foreground">
          State and window read from <span title={tabBook}>{short(tabBook, 8, 4)}</span> at Monad
          block {atBlock.toLocaleString("en-US")}. Somebody may have marked or settled a row since.
        </p>
      </div>
    </div>
  );
}
