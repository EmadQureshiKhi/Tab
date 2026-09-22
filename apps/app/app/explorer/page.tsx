/**
 * `/explorer` - every Settlement on this deployment's chain.
 *
 * The feed is cursor-paginated by the registry's own keyset cursor, passed
 * straight through in both directions rather than re-derived. That cursor names a
 * position in a total order rather than a count of rows skipped, so a page
 * edge stays stable while the indexer writes above it, and a reader walking
 * the feed neither repeats nor loses a row.
 */

import { Suspense } from "react";

import { Link } from "../../components/ui/link";
import { Skeleton } from "../../components/ui/skeleton";
import { EmptyChain } from "../../components/views/empty-chain";
import { SettlementTable } from "../../components/views/settlement-table";
import { toSettlementViews } from "../../src/dashboard/views";
import { firstParam, routeContext, type SearchParams } from "../_lib/context";
import { OverdueTabsSection } from "./_overdue";

export const dynamic = "force-dynamic";

export default async function ExplorerPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const context = routeContext();
  const cursor = firstParam(params, "cursor");

  const page = await context.registry.settlements({
    limit: 25,
    ...(cursor === undefined ? {} : { cursor }),
  });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">
          Settlement explorer
        </h1>
        <p className="font-mono text-xs text-muted-foreground">
          {context.network.name} · chain {context.chainId}
        </p>
      </div>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Each row is one Settlement: the identifier <code className="font-mono">TabBook</code> assigned when it applied the payment,
        and the Monad transaction that both moved the Asset and recorded it. The two halves happened
        together or not at all, so the transaction hash is the whole receipt, and any row here can be
        checked against the chain independently of this page.
      </p>
      <p className="max-w-3xl text-sm text-muted-foreground">
        A call that ran out of credit can also be paid per request with x402; those payments settle
        to the Service directly and never appear here as Settlements.
      </p>

      {/*
        The complement of the table below: Open Tabs whose Settlement Window has
        passed without a Settlement, so they can never appear in the feed.
        Suspended because the chain scan behind it can take seconds and must not
        hold up the feed.
      */}
      <section aria-labelledby="overdue-tabs" className="flex flex-col gap-3">
        <h2
          id="overdue-tabs"
          className="font-mono text-xs tracking-wider text-muted-foreground uppercase"
        >
          Overdue tabs anyone may mark delinquent
        </h2>
        <Suspense fallback={<Skeleton className="h-28 w-full" />}>
          <OverdueTabsSection />
        </Suspense>
      </section>

      {!page.ok ? (
        <EmptyChain message={`The registry could not be read: ${page.error.message}`} indexedBlock={null} />
      ) : page.value.settlements.length === 0 ? (
        <EmptyChain message={context.network.emptyMeans} indexedBlock={page.value.index.lastBlock} />
      ) : (
        <>
          <SettlementTable
            caption={`Settlements on ${context.network.name}`}
            rows={toSettlementViews(page.value.settlements)}
            hrefFor={(settlementId) => `/explorer/${settlementId}`}
            explorerHrefFor={context.explorerHrefFor}
          />
          {page.value.nextCursor === null ? null : (
            <div>
              <Link href={`/explorer?cursor=${encodeURIComponent(page.value.nextCursor)}`}>
                Next page
              </Link>
            </div>
          )}
        </>
      )}
    </section>
  );
}
