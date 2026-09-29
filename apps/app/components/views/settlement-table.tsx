/**
 * `SettlementTable` - the Settlement feed, as rows.
 *
 * ## Every coordinate that identifies a Settlement is shown
 *
 * A Settlement is the id `TabBook` assigned plus the Monad transaction that paid
 * it, and this table shows both rather than a friendly summary. The id is the
 * link into this Dashboard's own page for the Settlement, and the hash is the
 * link out to the explorer, where a reader holding it can fetch the same
 * transaction from any node and check this page. A row that hid either would be
 * asking to be believed.
 *
 * ## The amount, and what it became
 *
 * A payment splits on chain into what the Open Tab absorbed and what was banked
 * as prepaid credit, so those are two columns beside the amount. Every figure
 * renders through `AssetAmount`, which shows decimal Asset units and carries the
 * exact base-unit integer in its title. No figure here passes through a float.
 *
 * This is a server component. It has no state and no clock.
 */

import { Link } from "../ui/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { AssetAmount } from "../custom-ui/asset-amount";
import type { AssetUnit } from "../custom-ui/format";

/** One row of the feed. Structural, so the composition layer supplies it. */
export interface SettlementRowView {
  readonly settlementId: string;
  /** The Monad transaction that paid and applied this Settlement. */
  readonly txHash: string;
  readonly blockNumber: number;
  readonly agent: string;
  readonly serviceName?: string | undefined;
  readonly serviceId: string;
  readonly asset: AssetUnit;
  readonly amountBaseUnits: bigint;
  readonly appliedBaseUnits: bigint;
  readonly prepaidBaseUnits: bigint;
}

export interface SettlementTableProps {
  readonly rows: readonly SettlementRowView[];
  readonly caption: string;
  /** Builds the Dashboard link for one Settlement. */
  readonly hrefFor: (settlementId: string) => string;
  /** Builds the Monad explorer link for a transaction. */
  readonly explorerHrefFor: (txHash: string) => string;
  readonly className?: string | undefined;
}

const MONO = "font-mono text-xs";
const NO_WRAP = "break-normal whitespace-nowrap";

/** Middle-truncated, with the full value in `title` so nothing is lost. */
function short(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function SettlementTable({
  rows,
  caption,
  hrefFor,
  explorerHrefFor,
  className,
}: SettlementTableProps) {
  return (
    <Table
      caption={caption}
      captionVisible={false}
      {...(className === undefined ? {} : { className })}
    >
      <TableHeader>
        <TableRow>
          <TableHead>Settlement</TableHead>
          <TableHead>Transaction</TableHead>
          <TableHead>Block</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Service</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Applied</TableHead>
          <TableHead>Prepaid</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.settlementId}>
            <TableCell>
              {/*
                Kept on one line. The identifiers are already truncated to a
                fixed length, and the table scrolls sideways inside its own
                region on a narrow screen, so wrapping one only makes the row
                taller and the hash harder to read.
              */}
              <Link href={hrefFor(row.settlementId)} mono title={row.settlementId} className={NO_WRAP}>
                {short(row.settlementId)}
              </Link>
            </TableCell>
            <TableCell>
              <Link href={explorerHrefFor(row.txHash)} external mono title={row.txHash} className={NO_WRAP}>
                {short(row.txHash)}
              </Link>
            </TableCell>
            <TableCell className={`${MONO} tabular-nums`}>
              {row.blockNumber.toLocaleString("en-US")}
            </TableCell>
            <TableCell className={`${MONO} whitespace-nowrap`} title={row.agent}>
              {short(row.agent)}
            </TableCell>
            <TableCell className={MONO} title={row.serviceId}>
              {row.serviceName ?? short(row.serviceId)}
            </TableCell>
            <TableCell>
              <AssetAmount baseUnits={row.amountBaseUnits} asset={row.asset} emphasis="strong" />
            </TableCell>
            <TableCell>
              <AssetAmount baseUnits={row.appliedBaseUnits} asset={row.asset} />
            </TableCell>
            <TableCell>
              <AssetAmount
                baseUnits={row.prepaidBaseUnits}
                asset={row.asset}
                emphasis={row.prepaidBaseUnits === 0n ? "muted" : undefined}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
