/**
 * `/agents/[agent]` - one Agent's credit, per Asset, and the Settlements behind it.
 *
 * ## A figure is shown only where the chain agrees with it
 *
 * The Credit Limit here is not this service's opinion. The read API rebuilds the
 * `LimitWitness` from indexed `HistoryExtended` rows, recomputes `LimitLib` in
 * TypeScript, and then asks `TabBook.creditLimit` for the same figure at the same
 * block. It serves a number only where the two agree, and a stated reason where
 * they do not. This route carries that distinction through instead of flattening
 * it: an absent Credit Limit is a refusal to guess, and it says so.
 *
 * ## The Settlements are the reason for the figure
 *
 * A Credit Limit is a pure function of the Settlements already applied on chain
 * and the Bonds of the Services they were paid to, so the Agent's own Settlements
 * sit under the credit they earned. A reader who doubts the gauge can read the
 * rows it was computed from, and follow any of them to the transaction on Monad.
 *
 * ## Identity and labels are context, and drawn as context
 *
 * More blocks describe the address rather than its credit. The ERC-8004
 * identity is what the Identity registry's own events say about who owns or
 * runs this address as an agent, with the registration file fetched beside it.
 * The reputation is the Reputation registry's summary for that agent, read
 * live: what Tab Services wrote after each Settlement they received, and what
 * every client wrote, kept apart. The Nansen profile is an off-chain overlay
 * with a named source, a fetch time and the x402 payments that bought it: the
 * registry buys it once a week per Agent and serves that answer to every
 * visitor. None of these feeds the gauge above them, and the Nansen section
 * says so in one sentence on every render. A deployment with no Identity
 * registry or no Nansen payer is told so in words, because "not configured" and
 * "nothing found" are different answers.
 */

import { CreditGauge } from "../../../components/custom-ui/credit-gauge";
import { AssetAmount } from "../../../components/custom-ui/asset-amount";
import { Suspense } from "react";

import { Link } from "../../../components/ui/link";
import { Skeleton } from "../../../components/ui/skeleton";
import { EmptyChain } from "../../../components/views/empty-chain";
import { IdentitySection } from "../../../components/views/identity-section";
import { ReputationSection } from "../../../components/views/reputation-section";
import { SettlementTable } from "../../../components/views/settlement-table";
import {
  REPUTATION_DERIVED_STATEMENT,
  toCreditView,
  toIdentityView,
  toReputationSectionView,
  toSettlementViews,
} from "../../../src/dashboard/views";
import { routeContext } from "../../_lib/context";
import { NansenSection } from "./_nansen";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly agent: string }>;
}) {
  const { agent } = await params;
  const context = await routeContext();
  const [detail, settlements] = await Promise.all([
    context.registry.agent(agent),
    context.registry.settlements({ agent, limit: 25 }),
  ]);

  if (!detail.ok) {
    return (
      <section className="flex flex-col gap-3">
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">Agent</h1>
        <p className="text-sm text-muted-foreground">
          The registry could not be read: {detail.error.message}
        </p>
      </section>
    );
  }

  const identity = toIdentityView(detail.value.identity);
  const reputation = toReputationSectionView(detail.value.identity);

  return (
    <section className="flex flex-col gap-8">
      <div>
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">Agent</h1>
        <p className="mt-1 font-mono text-sm break-all text-muted-foreground">
          <Link href={context.explorerAddressHrefFor(detail.value.agent)} external mono>
            {detail.value.agent}
          </Link>
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
          Identity, from the ERC-8004 registry
        </h2>
        <IdentitySection identity={identity} explorerAddressHrefFor={context.explorerAddressHrefFor} hideReputation />
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
          Reputation, from the ERC-8004 registry
        </h2>
        <ReputationSection
          reputation={reputation}
          derivedStatement={REPUTATION_DERIVED_STATEMENT}
          explorerAddressHrefFor={context.explorerAddressHrefFor}
        />
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
          Credit, per Asset
        </h2>
        {detail.value.assets.length === 0 ? (
          <EmptyChain
            message="This Agent has no indexed activity. That is a truthful answer about a real Monad address, not a missing record."
            indexedBlock={detail.value.index.lastBlock}
          />
        ) : (
          // Two columns from `lg` once there is more than one Asset. With one, the
          // card takes the full measure so the page does not change shape halfway
          // down; with several, they sit beside each other because a reader is
          // comparing them.
          <div className={detail.value.assets.length > 1 ? "grid gap-4 lg:grid-cols-2" : "grid gap-4"}>
            {detail.value.assets.map((row) => {
              const credit = toCreditView(row);
              return (
                <div
                  key={row.asset}
                  className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/30 p-5"
                >
                  {credit.creditLimitBaseUnits === undefined ||
                  credit.headroomBaseUnits === undefined ? (
                    <div className="flex flex-col gap-2">
                      <p className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
                        {credit.asset.symbol}
                      </p>
                      <p className="text-sm text-foreground">
                        No Credit Limit is served for this Asset.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {credit.unavailable ??
                          "The index will not serve a figure the contract disagrees with."}
                      </p>
                    </div>
                  ) : (
                    <CreditGauge
                      asset={credit.asset}
                      creditLimitBaseUnits={credit.creditLimitBaseUnits}
                      openTabBaseUnits={credit.openTabBaseUnits}
                      headroomBaseUnits={credit.headroomBaseUnits}
                      delinquent={credit.delinquent}
                    />
                  )}

                  <dl className="grid grid-cols-2 gap-2 border-t border-border pt-3 font-mono text-xs">
                    <dt className="text-muted-foreground">Settlements</dt>
                    <dd className="text-foreground">{credit.settlementCount}</dd>
                    <dt className="text-muted-foreground">Settled in total</dt>
                    <dd>
                      <AssetAmount baseUnits={credit.settledTotalBaseUnits} asset={credit.asset} />
                    </dd>
                    <dt className="text-muted-foreground">Prepaid credit</dt>
                    <dd>
                      <AssetAmount baseUnits={credit.prepaidTotalBaseUnits} asset={credit.asset} />
                    </dd>
                  </dl>

                  {credit.crossChecked ? (
                    <p className="text-xs text-muted-foreground">
                      Checked against <code className="font-mono">TabBook.creditLimit</code> on chain, and the two agreed.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {/*
          Under the gauges rather than beside them, and after the figures the
          page is about. Nansen's view is context for reading the credit
          picture, not part of it, and the section says so itself. Suspended,
          because the first read of the week buys it and takes a few seconds.
        */}
        <Suspense fallback={<Skeleton className="h-40 w-full" />}>
          <NansenSection context={context} agent={detail.value.agent} labels={detail.value.labels} />
        </Suspense>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
          Settlements by this Agent on {context.network.name}
        </h2>
        {!settlements.ok ? (
          <EmptyChain
            message={`The registry could not be read: ${settlements.error.message}`}
            indexedBlock={null}
          />
        ) : settlements.value.settlements.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-5 py-6 text-sm text-muted-foreground">
            This Agent has settled nothing on {context.network.name} yet. A Credit Limit is a pure
            function of applied Settlements, so until one lands the limit is the baseline capped by
            counterparty Bond, and nothing here can raise it.
          </p>
        ) : (
          <SettlementTable
            caption={`Settlements by ${detail.value.agent}`}
            rows={toSettlementViews(settlements.value.settlements)}
            hrefFor={(settlementId) => `/explorer/${settlementId}`}
            explorerHrefFor={context.explorerHrefFor}
          />
        )}
      </div>
    </section>
  );
}
