/**
 * `/agents/[agent]` - one Agent's credit, per Asset.
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
 * ## Bound addresses are per chain
 *
 * A binding is proven per chainKey (R10.3), so the bound addresses are filtered to
 * the selected chain. Credit itself is per Asset and is not filtered, because an
 * Agent's Credit Limit for an Asset is not a per-chain quantity.
 *
 * Requirements: 24.1, 24.2, 24.9, 10.3
 */

import { Link } from "../../../components/ui/link";
import { CreditGauge } from "../../../components/custom-ui/credit-gauge";
import { AssetAmount } from "../../../components/custom-ui/asset-amount";
import { EmptyChain } from "../../../components/views/empty-chain";
import { toCreditView } from "../../../src/dashboard/views";
import { routeContext, type SearchParams } from "../../_lib/context";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly agent: string }>;
  readonly searchParams: Promise<SearchParams>;
}) {
  const { agent } = await params;
  const context = routeContext(await searchParams);
  const detail = await context.registry.agent(agent);

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

  const bound = detail.value.boundAddresses.filter(
    (row) => row.chainKey === String(context.chainKey),
  );

  return (
    <section className="flex flex-col gap-8">
      <div>
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">Agent</h1>
        <p className="mt-1 font-mono text-sm break-all text-muted-foreground">{detail.value.agent}</p>
      </div>

      {/*
        Two columns from `lg`. With one Asset the credit card is the page's only
        substantial block, and at a desktop width it left half the measure empty
        while the sections under it ran full width, so the page changed shape
        halfway down. Pairing credit with what is bound to it fixes that and also
        puts the two facts a reader is comparing beside each other.
      */}
      <div className="grid gap-8 lg:grid-cols-2 lg:items-start">
      <div className="flex flex-col gap-3">
        <h2 className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
          Credit, per Asset
        </h2>
        {detail.value.assets.length === 0 ? (
          <EmptyChain
            message="This Agent has no indexed activity. That is a truthful answer about a real Creditcoin address, not a missing record."
            indexedBlock={detail.value.index.lastBlock}
          />
        ) : (
          <div className="grid gap-4">
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
                    <dt className="text-muted-foreground">Verified Settlements</dt>
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
                      Checked against `TabBook.creditLimit` on chain, and the two agreed.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
          Bound Ethereum addresses on {context.chain.name}
        </h2>
        {bound.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-5 py-6 text-sm text-muted-foreground">
            This Agent has bound no address on {context.chain.name}. A binding is proven per chain by
            a Settlement of an exact amount, so an address bound on one chain is not bound on another.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {bound.map((row) => (
              <li
                key={row.ethAddress}
                className="rounded-lg border border-border/60 bg-muted/30 p-4 font-mono text-xs"
              >
                <p className="break-all text-foreground">{row.ethAddress}</p>
                <p className="mt-1 text-muted-foreground">
                  proven by{" "}
                  <Link
                    href={`/explorer/${row.provingReplayKey}?chainKey=${context.chainKey}`}
                    mono
                  >
                    the Settlement it paid
                  </Link>
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
      </div>
    </section>
  );
}
