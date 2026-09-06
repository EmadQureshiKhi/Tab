/**
 * `SettlementTable` - the Verified Settlement feed, as rows.
 *
 * ## Every coordinate that identifies a Settlement is shown
 *
 * R24.4 asks the explorer to show the chainKey, block height, transaction index,
 * log index, resolved Agent, Service, Asset and amount, and this table shows all
 * of them rather than a friendly summary. The reason is that those four
 * coordinates *are* the identity: packed together they form the replay key, and a
 * reader holding them can fetch the same log from any node and check this page.
 * A row that hid them would be asking to be believed.
 *
 * The log ordinal is the position **within the proved receipt**, not the
 * block-wide index. Those differ, and conflating them names a different log
 * entirely, so the column is labelled for what it is.
 *
 * ## Amounts are exact
 *
 * Every amount renders through `AssetAmount`, which shows decimal Asset units and
 * carries the exact base-unit integer in its title. No figure here passes
 * through a float.
 *
 * This is a server component. It has no state and no clock.
 *
 * Requirements: 24.4, 24.2, 15.7
 */

import { Link } from "../ui/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { AssetAmount } from "../custom-ui/asset-amount";
import { ClearingBadge } from "../custom-ui/clearing-badge";
import type { ClearingState } from "../custom-ui/clearing-state";
import type { AssetUnit } from "../custom-ui/format";

/** One row of the feed. Structural, so the composition layer supplies it. */
export interface SettlementRowView {
  readonly replayKey: string;
  readonly chainKey: number;
  readonly blockHeight: bigint;
  readonly txIndex: bigint;
  readonly logIndex: bigint;
  readonly agent: string;
  readonly serviceName?: string | undefined;
  readonly serviceId: string;
  readonly asset: AssetUnit;
  readonly amountBaseUnits: bigint;
  readonly clearing: ClearingState;
  readonly creditcoinTxHash?: string | undefined;
}

export interface SettlementTableProps {
  readonly rows: readonly SettlementRowView[];
  readonly caption: string;
  /** Builds the Dashboard link for one Settlement. */
  readonly hrefFor: (replayKey: string) => string;
  /** Builds the Blockscout link for a Creditcoin transaction. */
  readonly explorerHrefFor: (txHash: string) => string;
}

const MONO = "font-mono text-xs";

/** Middle-truncated, with the full value in `title` so nothing is lost. */
function short(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

/**
 * A replay key is never middle-truncated, and the reason is arithmetic rather than
 * taste.
 *
 * The key packs `(chainKey, blockHeight, txIndex, logIndex)` into four 8-byte fields,
 * so a chainKey of 1 and a logIndex of 0 make the first sixteen and last sixteen hex
 * characters zeros. `short()` shows exactly those ends, so every row rendered
 * `0x000000…000000` and twelve settlements looked like one settlement twelve times.
 *
 * The four coordinates below are that same key decoded, which is what makes them
 * readable and also what made a separate column of them redundant. So the identifier
 * and the coordinates are one column: the coordinates are the link, the full key is in
 * `title`, and the detail page is one click away under the key itself.
 */

export function SettlementTable({
  rows,
  caption,
  hrefFor,
  explorerHrefFor,
}: SettlementTableProps) {
  return (
    <Table caption={caption} captionVisible={false}>
      <TableHeader>
        <TableRow>
          <TableHead>Settlement</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Service</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Clearing</TableHead>
          <TableHead>Creditcoin</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.replayKey}>
            <TableCell>
              <Link href={hrefFor(row.replayKey)} mono title={row.replayKey}>
                <span className="text-muted-foreground">chainKey</span> {row.chainKey}{" "}
                <span className="text-muted-foreground">block</span> {row.blockHeight.toString()}{" "}
                <span className="text-muted-foreground">tx</span> {row.txIndex.toString()}{" "}
                <span className="text-muted-foreground">log</span> {row.logIndex.toString()}
              </Link>
            </TableCell>
            <TableCell className={MONO} title={row.agent}>
              {short(row.agent)}
            </TableCell>
            <TableCell className={MONO} title={row.serviceId}>
              {row.serviceName ?? short(row.serviceId)}
            </TableCell>
            <TableCell>
              <AssetAmount baseUnits={row.amountBaseUnits} asset={row.asset} />
            </TableCell>
            <TableCell>
              <ClearingBadge state={row.clearing} />
            </TableCell>
            <TableCell>
              {row.creditcoinTxHash === undefined ? (
                <span className={`${MONO} text-muted-foreground`}>not recorded</span>
              ) : (
                <Link
                  href={explorerHrefFor(row.creditcoinTxHash)}
                  external
                  mono
                  title={row.creditcoinTxHash}
                >
                  {short(row.creditcoinTxHash)}
                </Link>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
