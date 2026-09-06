/**
 * `OverdueClearings` - the clearings anybody may crank, and the call to make.
 *
 * ## Why a Dashboard shows this at all
 *
 * `TabBook.reverseExpiredClearing` is permissionless, and the contract says why:
 * the Watcher that applied a clearing is also the party that benefits from never
 * reversing it, so reversal liveness must not depend on it. Anyone may crank once
 * the deadline passes.
 *
 * A permissionless call is only permissionless in practice if an outsider can
 * discover that it is due and what to pass it. So this view prints the identifier
 * and the whole command, filled in, rather than describing the mechanism and
 * leaving a reader to assemble calldata. The difference between those two is the
 * difference between a guarantee and a claim about one.
 *
 * ## Every figure states the block it came from
 *
 * The verdict is a comparison against a block timestamp, not against the viewer's
 * clock, so the block it was computed at is shown beside it. A reader can then see
 * how fresh the answer is instead of assuming it is current, which matters here
 * more than elsewhere: somebody may crank a row between this render and the
 * reader's click, and the honest presentation of that is a stated age rather than
 * a promise of liveness.
 *
 * This is a server component. It has no state and no clock.
 *
 * Requirements: 15.5, 14.6, 15.8, 24.8
 */

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { AssetAmount } from "../custom-ui/asset-amount";
import type { AssetUnit } from "../custom-ui/format";

/** One clearing, reduced to what a reader needs to act. */
export interface OverdueClearingView {
  readonly clearingId: string;
  readonly agent: string;
  readonly serviceName?: string | undefined;
  readonly serviceId: string;
  readonly asset: AssetUnit;
  readonly amountBaseUnits: bigint;
  /** Seconds past the deadline, as a positive number. */
  readonly overdueSeconds: number;
  /** Rendered elsewhere, from the chain's clock, never from the browser's. */
  readonly overdueLabel: string;
  /** The whole command, already filled in. */
  readonly command: string;
}

export interface OverdueClearingsProps {
  readonly rows: readonly OverdueClearingView[];
  /** How many are applied but not yet due, so "none overdue" is distinguishable from "none at all". */
  readonly pendingCount: number;
  /** The block every state and verdict here was read at. */
  readonly atBlock: number;
  readonly className?: string | undefined;
}

const MONO = "font-mono text-xs";

export function OverdueClearings({ rows, pendingCount, atBlock, className }: OverdueClearingsProps) {
  if (rows.length === 0) {
    return (
      <div
        className={
          className ??
          "rounded-md border border-dashed border-border bg-card px-6 py-10 text-center"
        }
      >
        <p className="text-sm text-foreground">
          No Provisional Clearing has passed its deadline unconfirmed, so there is nothing to crank.
        </p>
        {/*
          The two numbers below are what make this an answer rather than a blank.
          A reader can see that clearings were looked at, how many are still
          running, and which block the verdict describes.
        */}
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          {pendingCount === 0
            ? "No clearing is currently applied"
            : `${pendingCount} clearing${pendingCount === 1 ? " is" : "s are"} applied and still inside the deadline`}
          , read at Creditcoin block {atBlock.toLocaleString("en-US")}.
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <Table
        caption="Provisional Clearings past their deadline, which anyone may reverse"
        captionVisible={false}
      >
        <TableHeader>
          <TableRow>
            <TableHead>Clearing</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Service</TableHead>
            <TableHead>Pledged</TableHead>
            <TableHead>Overdue by</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.clearingId}>
              <TableCell className={MONO} title={row.clearingId}>
                {`${row.clearingId.slice(0, 10)}…${row.clearingId.slice(-6)}`}
              </TableCell>
              <TableCell className={MONO} title={row.agent}>
                {`${row.agent.slice(0, 8)}…${row.agent.slice(-4)}`}
              </TableCell>
              <TableCell className={MONO} title={row.serviceId}>
                {row.serviceName ?? `${row.serviceId.slice(0, 10)}…`}
              </TableCell>
              <TableCell>
                <AssetAmount baseUnits={row.amountBaseUnits} asset={row.asset} />
              </TableCell>
              <TableCell className={MONO}>{row.overdueLabel}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="mt-4 flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Reversal is permissionless. Anyone may send the call below once the deadline has passed,
          and the Watcher that applied the clearing has no special standing to do it. The Open Tab is
          restored by the amount the clearing actually removed, and the pledged Bond is slashed to
          the Agent as prepaid credit.
        </p>
        {rows.map((row) => (
          <pre
            key={`${row.clearingId}-command`}
            className="overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground"
          >
            <code>{row.command}</code>
          </pre>
        ))}
        <p className="font-mono text-xs text-muted-foreground">
          State and deadline read from the chain at Creditcoin block{" "}
          {atBlock.toLocaleString("en-US")}. Somebody may have cranked a row since.
        </p>
      </div>
    </div>
  );
}
