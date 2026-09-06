/**
 * The overdue-clearing section of `/explorer`, as its own streamed component.
 *
 * ## Why it lives here and not on a route of its own
 *
 * Design section 12.0 lists the navigation model among the things that may not
 * change, and section 12.2's route table has no clearings route. So this is a
 * section of the explorer rather than a new nav item, and the explorer is the
 * right host: a clearing is keyed by a replay key and the explorer is the
 * replay-key surface.
 *
 * It also reads well as a pair. The table below it is the Verified Settlements
 * that arrived; this is the Provisional Clearings whose Verified Settlement never
 * did. The second is exactly the complement of the first, which is also why the
 * registry's settlement feed could not have supplied it.
 *
 * ## Why it streams
 *
 * Finding the candidates means scanning `ProvisionalClearingApplied` logs from the
 * deployment block, which takes about ten seconds against the public endpoint and
 * cannot be narrowed: a clearing nobody cranked stays applied indefinitely, so any
 * recent-window shortcut would miss precisely the oldest and most overdue rows,
 * which are the ones this section exists for.
 *
 * Ten seconds is too long to hold the settlement table behind, and caching it
 * would mean publishing a crank verdict that may already be wrong. So the section
 * suspends instead: the rest of the page renders at once and this arrives when the
 * chain has answered. Nothing is cached and every figure is current as of the
 * block it names.
 *
 * Requirements: 15.5, 14.6, 24.8
 */

import { OverdueClearings } from "../../components/views/overdue-clearings";
import { crankCommand, overdueBy, readClearings } from "../../src/dashboard/clearings";
import { assetUnitFor, serviceNameOf } from "../../src/dashboard/views";
import { CLEARING_SCAN_FROM_BLOCK, chain, tabBookAddress } from "../_lib/context";

/** The stated reason a section could not answer, in the shape the empty state uses. */
function Unavailable({ reason }: { readonly reason: string }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-card px-6 py-10 text-center">
      <p className="text-sm text-foreground">{reason}</p>
      <p className="mt-2 font-mono text-xs text-muted-foreground">
        This is a stated failure to read, not a statement that no clearing is overdue.
      </p>
    </div>
  );
}

export async function OverdueClearingsSection() {
  const tabBook = tabBookAddress();
  if (tabBook === undefined) {
    return (
      <Unavailable reason="TAB_BOOK_ADDRESS is not configured, so the clearings cannot be read from the chain." />
    );
  }

  const report = await readClearings({
    chain: chain(),
    tabBook,
    fromBlock: CLEARING_SCAN_FROM_BLOCK,
  });
  if (!report.ok) {
    return <Unavailable reason={`The chain could not be read: ${report.error.message}`} />;
  }

  const rows = report.value.overdue.map((view) => {
    const serviceName = serviceNameOf(view.record.serviceId);
    return {
      clearingId: view.clearingId,
      agent: view.record.agent,
      ...(serviceName === undefined ? {} : { serviceName }),
      serviceId: view.record.serviceId,
      asset: assetUnitFor(view.record.asset),
      amountBaseUnits: view.record.amount,
      overdueSeconds: -view.secondsUntilDeadline,
      overdueLabel: overdueBy(view.secondsUntilDeadline),
      command: crankCommand(tabBook, view.clearingId),
    };
  });

  return (
    <OverdueClearings
      rows={rows}
      pendingCount={report.value.pending.length}
      atBlock={report.value.at.blockNumber}
    />
  );
}
