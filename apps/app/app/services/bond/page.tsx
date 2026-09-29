/**
 * `/services/bond` - escrowing the stake that gives a Service credit weight.
 *
 * A Bond is what a Service escrows in `Bond` so that Settlements paid to it
 * count toward an Agent's Credit Limit. `LimitLib` caps every limit at 95% of
 * the counterparty's free stake, so a Service with nothing escrowed is still
 * registered, still priced and still callable; it simply earns its Agents no
 * credit until it has something at risk.
 *
 * Funding is two Monad transactions and both are signed here: approve `Bond` to
 * pull the Asset, then `deposit`, which escrows it under the caller's party.
 * `depositFor` lets a treasury fund a Service's bond account without holding its
 * key, and only that account can ever withdraw what is credited. Both are on the
 * network the visitor selected, and the stake is readable the block after the
 * second lands.
 */

import { BondFlow } from "./_flow";
import { assetUnitFor, serviceNameOf } from "../../../src/dashboard/views";
import { routeContext } from "../../_lib/context";

export const dynamic = "force-dynamic";

export default async function BondPage() {
  const context = await routeContext();
  const chain = context.network;
  const services = await context.registry.services(50);

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Monetise
        </p>
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">
          Post a Bond, in two transactions
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          A Bond is stake a Service escrows so that the Settlements paid to it count toward an
          Agent&apos;s Credit Limit. A limit never exceeds 95% of the counterparty&apos;s free stake,
          so a Service with nothing escrowed earns its Agents nothing. Funding it is two {chain.name}{" "}
          transactions from your own wallet: an ERC-20 approval so <code className="font-mono">Bond</code> may pull the Asset, then
          the deposit itself. Tab holds the stake in escrow and only the bond account it is credited
          to can ever withdraw it.
        </p>
      </div>

      <BondFlow
        bond={context.contracts.bond}
        chainId={context.chainId}
        chainName={chain.name}
        rpcUrl={context.rpcUrl}
        explorerUrl={context.explorerUrl}
        services={
          services.ok
            ? services.value.services.map((service) => ({
                serviceId: service.serviceId,
                name: serviceNameOf(service.serviceId),
                operator: service.operator,
                assets: service.acceptedAssets.map((term) => {
                  const unit = assetUnitFor(term.asset);
                  const ledger = service.bond.find(
                    (row) => row.asset.toLowerCase() === term.asset.toLowerCase(),
                  );
                  return {
                    address: term.asset,
                    symbol: unit.symbol,
                    decimals: unit.decimals,
                    freeBaseUnits: ledger?.crossCheck?.agrees === false ? undefined : ledger?.free,
                  };
                }),
              }))
            : []
        }
        servicesError={services.ok ? undefined : services.error.message}
      />
    </section>
  );
}
