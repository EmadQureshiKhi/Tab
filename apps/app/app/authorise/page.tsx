/**
 * `/authorise` - let a Service put charges on your tab.
 *
 * One of the four routes on this Dashboard that sign, beside `/services/new`,
 * `/services/bond` and `/keys`: every read renders without a wallet, and this
 * cannot act without one, because an authorisation is a transaction the Agent
 * must sign as itself. `TabBook.recordDelivery` refuses to meter an
 * Agent that has not authorised the Service, refuses once the cumulative charge
 * would pass the ceiling the Agent set, and refuses once the expiry has lapsed.
 * Nothing in Tab can raise that ceiling on the Agent's behalf.
 *
 * The page is a server component that resolves the selected network and hands
 * it to a client island. That split is not ceremony: the network is a cookie
 * the server reads before rendering, `TabBook` is that network's address from
 * the built-in deployment table, and the endpoint is a server-side variable the
 * client bundle cannot see.
 */

import { assetUnitFor, serviceNameOf } from "../../src/dashboard/views";
import { routeContext } from "../_lib/context";
import { AuthoriseForm, type ServiceChoice } from "./_form";

export const dynamic = "force-dynamic";

export default async function AuthorisePage() {
  const context = await routeContext();
  const services = await context.registry.services(50);

  /*
    Every Service and every Asset it accepts, named where it can be. The symbol
    is resolved here rather than in the island because the Testnet token is
    registered at server startup from the deployment table, and the client
    bundle has no such registration to consult.
  */
  const choices: readonly ServiceChoice[] = services.ok
    ? services.value.services.map((service) => ({
        serviceId: service.serviceId,
        name: serviceNameOf(service.serviceId),
        operator: service.operator,
        settlementWindowSeconds: service.settlementWindowSeconds.value,
        assets: service.acceptedAssets.map((term) => {
          const unit = assetUnitFor(term.asset);
          return {
            address: term.asset,
            symbol: unit.symbol,
            decimals: unit.decimals,
            collection: term.collection,
          };
        }),
      }))
    : [];

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Agent
        </p>
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">
          Authorise a Service
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Before a Service can put a single charge on your tab, you tell <code className="font-mono">TabBook</code> how much it may
          charge, in which Asset, until when. <code className="font-mono">recordDelivery</code> refuses an unauthorised Service, refuses
          a delivery that would take the cumulative charge past your ceiling, and refuses one after
          the expiry. The ceiling is yours alone: no Service, no operator and no component of Tab can
          raise it on your behalf, and only a transaction you sign can change it.
        </p>
      </div>

      <AuthoriseForm
        tabBook={context.contracts.tabBook}
        chainId={context.chainId}
        chainName={context.network.name}
        rpcUrl={context.rpcUrl}
        explorerUrl={context.explorerUrl}
        services={choices}
        servicesError={services.ok ? undefined : services.error.message}
      />
    </section>
  );
}
