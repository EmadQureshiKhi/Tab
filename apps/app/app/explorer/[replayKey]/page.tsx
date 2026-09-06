/**
 * `/explorer/[replayKey]` - one Verified Settlement and its clearing lineage.
 *
 * ## Why the replay key is the route
 *
 * A transaction hash names more than one thing. One Creditcoin transaction can
 * record several Verified Settlements, and one Source Chain transaction can carry
 * several recognised logs, so a route keyed on either would sometimes be
 * ambiguous. The packed `(chainKey, blockHeight, txIndex, logIndex)` tuple names
 * exactly one Settlement, on chain and here.
 *
 * ## The lineage is shown whole, including what it cannot contain
 *
 * A declined observation creates no clearing, so it carries no clearing identity
 * and can never appear in a lineage keyed by one. The read API says so in its own
 * words and this route repeats it rather than leaving a reader to conclude that a
 * decline was hidden. A decline is not a failed Settlement.
 *
 * Requirements: 24.4, 24.2, 15.7, 24.9
 */

import { notFound } from "next/navigation";

import { Link } from "../../../components/ui/link";
import { AttestationStrip } from "../../../components/motion/attestation-strip";
import { ProofCard } from "../../../components/custom-ui/proof-card";
import { SettlementTimeline } from "../../../components/custom-ui/settlement-timeline";
import { clearingStateOf, toSettlementView } from "../../../src/dashboard/views";
import { routeContext, type SearchParams } from "../../_lib/context";

export const dynamic = "force-dynamic";

export default async function SettlementDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly replayKey: string }>;
  readonly searchParams: Promise<SearchParams>;
}) {
  const { replayKey } = await params;
  const context = routeContext(await searchParams);

  const detail = await context.registry.settlement(replayKey);
  if (!detail.ok) {
    if (detail.error.category === "NOT_FOUND") notFound();
    return (
      <section className="flex flex-col gap-3">
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">Settlement</h1>
        <p className="text-sm text-muted-foreground">
          The registry could not be read: {detail.error.message}
        </p>
      </section>
    );
  }

  const view = toSettlementView(
    detail.value.settlement,
    "permissionless",
    detail.value.clearing.state,
  );
  if (view === undefined) {
    return (
      <section className="flex flex-col gap-3">
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">Settlement</h1>
        <p className="text-sm text-muted-foreground">
          This Settlement is indexed but its coordinates will not decode, so it is not shown rather
          than shown with invented figures.
        </p>
      </section>
    );
  }

  const lineage = detail.value.clearing.lineage.map((entry) => ({
    id: `${entry.creditcoin.blockNumber}:${entry.creditcoin.logIndex}`,
    state: clearingStateOf(entry.state),
    atMs:
      entry.creditcoin.blockTime === null
        ? 0
        : new Date(entry.creditcoin.blockTime).getTime(),
    amountBaseUnits: view.amountBaseUnits,
    asset: view.asset,
  }));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">Verified Settlement</h1>
        <Link href={`/explorer?chainKey=${context.chainKey}`}>Back to the explorer</Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <ProofCard settlement={view} />
        <AttestationStrip blockHeight={view.blockHeight.toLocaleString("en-GB")} />
      </div>

      {/*
        The heading belongs to whichever element is actually rendered. `SettlementTimeline`
        captions itself, so a section heading above it printed "Clearing lineage" twice,
        one line apart. The empty state has no caption of its own and keeps one.
      */}
      <div className="flex flex-col gap-3">
        {lineage.length === 0 ? (
          <>
            <h2 className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
              Clearing lineage
            </h2>
            <p className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-5 py-6 text-sm text-muted-foreground">
              No Provisional Clearing was opened under this replay key, so the Settlement went
              straight to confirmed when its proof was accepted. {detail.value.clearing.note}
            </p>
          </>
        ) : (
          <SettlementTimeline entries={lineage} caption="Clearing lineage" />
        )}
      </div>

      {view.creditcoinTxHash === undefined ? null : (
        <p className="font-mono text-xs text-muted-foreground">
          Recorded on Creditcoin in{" "}
          <Link href={context.explorerHrefFor(view.creditcoinTxHash)} external mono>
            {view.creditcoinTxHash}
          </Link>
        </p>
      )}
    </section>
  );
}
