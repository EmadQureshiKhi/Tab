/**
 * The overdue-tab section of `/explorer`, as its own streamed component.
 *
 * ## Why it lives here and not on a route of its own
 *
 * The masthead already carries seven routes, and a delinquency list is not a
 * destination a reader sets out for. So this is a section of the explorer rather
 * than a new nav item, and the explorer is the right host: it is the page about
 * what has settled, and this is the list of what should have and has not.
 *
 * It also reads well as a pair. The table below it is the Settlements that
 * arrived; this is the Open Tabs whose Settlement Window closed without one. The
 * second is exactly the complement of the first, which is also why the
 * registry's settlement feed could not have supplied it.
 *
 * ## Where the candidates come from, and where the verdict does
 *
 * A tab exists from its first delivery, so the candidates are the distinct
 * tabs the registry's delivery feed has ever seen. That feed is walked to its
 * end, because a tab nobody marked stays open indefinitely and any recent-page
 * shortcut would miss precisely the oldest and most overdue rows, which are the
 * ones this section exists for.
 *
 * The verdict is never the index's. Every candidate's state and its Service's
 * window are read from the chain at one block, so a tab somebody marked or
 * settled a moment ago is judged on what the contract holds now. A reader who
 * trusts no index can rebuild the same list with `scanTabCandidates`, which
 * reads the same logs straight off a node.
 *
 * ## Why it streams
 *
 * Walking the feed and reading each tab takes a moment against the public
 * endpoint, and caching the answer would mean publishing a verdict that may
 * already be wrong. So the section suspends: the rest of the page renders at
 * once and this arrives when the chain has answered.
 */

import { OverdueTabs } from "../../components/views/overdue-tabs";
import type { RegistryClient } from "../../src/dashboard/client";
import { markCommand, overdueBy, readOverdueTabs, type TabCandidate } from "../../src/dashboard/overdue";
import { assetUnitFor, serviceNameOf } from "../../src/dashboard/views";
import type { NetworkContext } from "../_lib/context";

/** How many feed pages the walk will turn before it stops and says so. */
const MAX_FEED_PAGES = 200;

/**
 * Every tab the delivery feed has ever seen, or the reason it could not be read.
 *
 * The walk follows the registry's own cursor to the end of the feed. A bound on
 * the number of pages keeps a runaway feed from holding the page forever, and
 * hitting it is reported as a failure rather than as a shorter list, because a
 * silently short list of overdue tabs reads as "none overdue".
 */
async function everyTab(reads: RegistryClient): Promise<{ ok: true; candidates: TabCandidate[] } | { ok: false; reason: string }> {
  const candidates: TabCandidate[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_FEED_PAGES; page += 1) {
    const result = await reads.deliveries({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    if (!result.ok) return { ok: false, reason: result.error.message };
    for (const row of result.value.deliveries) {
      candidates.push({ agent: row.agent, serviceId: row.serviceId, asset: row.asset });
    }
    if (result.value.nextCursor === null) return { ok: true, candidates };
    cursor = result.value.nextCursor;
  }
  return { ok: false, reason: `the delivery feed ran past ${MAX_FEED_PAGES} pages, so the candidate list would be incomplete` };
}

/** The stated reason a section could not answer, in the shape the empty state uses. */
function Unavailable({ reason }: { readonly reason: string }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-card px-6 py-10 text-center">
      <p className="text-sm text-foreground">{reason}</p>
      <p className="mt-2 font-mono text-xs text-muted-foreground">
        This is a stated failure to read, not a statement that no tab is overdue.
      </p>
    </div>
  );
}

export async function OverdueTabsSection({ context }: { readonly context: NetworkContext }) {
  const { tabBook, serviceRegistry } = context.contracts;

  const candidates = await everyTab(context.registry);
  if (!candidates.ok) {
    return <Unavailable reason={`The delivery feed could not be read: ${candidates.reason}`} />;
  }

  const report = await readOverdueTabs({
    chain: context.chain,
    tabBook,
    serviceRegistry,
    candidates: candidates.candidates,
  });
  if (!report.ok) {
    return <Unavailable reason={`The chain could not be read: ${report.error.message}`} />;
  }

  const rows = report.value.overdue.map((view) => {
    const serviceName = serviceNameOf(view.ref.serviceId);
    return {
      tabId: view.tabId,
      agent: view.ref.agent,
      ...(serviceName === undefined ? {} : { serviceName }),
      serviceId: view.ref.serviceId,
      asset: assetUnitFor(view.ref.asset),
      openBaseUnits: view.tab.open,
      windowSeconds: view.settlementWindowSeconds,
      overdueSeconds: -view.secondsUntilWindowEnd,
      overdueLabel: overdueBy(view.secondsUntilWindowEnd),
      command: markCommand(tabBook, view.tabId),
    };
  });

  return (
    <OverdueTabs
      rows={rows}
      pendingCount={report.value.pending.length}
      atBlock={report.value.at.blockNumber}
      tabBook={tabBook}
    />
  );
}
