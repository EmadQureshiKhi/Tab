/**
 * `/explorer` - every Verified Settlement on the selected chain.
 *
 * The feed is cursor-paginated by the registry's own keyset cursor, passed
 * straight through in both directions rather than re-derived. That cursor names a
 * position in a total order rather than a count of rows skipped, so a page
 * boundary stays stable while the indexer writes above it, and a reader walking
 * the feed neither repeats nor loses a row.
 *
 * Requirements: 24.4, 24.2, 24.9
 */

import { Suspense } from "react";

import { Link } from "../../components/ui/link";
import { Skeleton } from "../../components/ui/skeleton";
import { EmptyChain } from "../../components/views/empty-chain";
import { SettlementTable } from "../../components/views/settlement-table";
import { toSettlementViews } from "../../src/dashboard/views";
import { firstParam, routeContext, type SearchParams } from "../_lib/context";
import { OverdueClearingsSection } from "./_overdue";

export const dynamic = "force-dynamic";

export default async function ExplorerPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const context = routeContext(params);
  const cursor = firstParam(params, "cursor");

  const page = await context.registry.settlements({
    chainKey: context.chainKey,
    limit: 25,
    ...(cursor === undefined ? {} : { cursor }),
  });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">
          Settlement and proof explorer
        </h1>
        <p className="font-mono text-xs text-muted-foreground">
          {context.chain.name} · {context.chain.network}
        </p>
      </div>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Each row carries the four coordinates that identify a Verified Settlement: the chainKey, the
        Source Chain block height, the transaction index taken from the proof, and the ordinal of the
        recognised log within the proved receipt. Packed together they are the replay key, so any row
        here can be checked against the Source Chain independently of this page.
      </p>

      {/*
        The complement of the table below: clearings whose Verified Settlement
        never arrived, so they can never appear in the feed. Suspended because the
        chain scan behind it takes about ten seconds and must not hold up the feed.
      */}
      <section aria-labelledby="overdue-clearings" className="flex flex-col gap-3">
        <h2
          id="overdue-clearings"
          className="font-mono text-xs tracking-wider text-muted-foreground uppercase"
        >
          Provisional Clearings anyone may reverse
        </h2>
        <Suspense fallback={<Skeleton className="h-28 w-full" />}>
          <OverdueClearingsSection />
        </Suspense>
      </section>

      {!page.ok ? (
        <EmptyChain message={`The registry could not be read: ${page.error.message}`} indexedBlock={null} />
      ) : page.value.settlements.length === 0 ? (
        <EmptyChain message={context.chain.emptyMeans} indexedBlock={page.value.index.lastBlock} />
      ) : (
        <>
          <SettlementTable
            caption={`Verified Settlements on ${context.chain.name}`}
            rows={toSettlementViews(page.value.settlements)}
            hrefFor={(replayKey) => `/explorer/${replayKey}?chainKey=${context.chainKey}`}
            explorerHrefFor={context.explorerHrefFor}
          />
          {page.value.nextCursor === null ? null : (
            <div>
              <Link
                href={`/explorer?chainKey=${context.chainKey}&cursor=${encodeURIComponent(page.value.nextCursor)}`}
              >
                Next page
              </Link>
            </div>
          )}
        </>
      )}
    </section>
  );
}
