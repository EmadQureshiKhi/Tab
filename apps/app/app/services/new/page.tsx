/**
 * `/services/new` - registering a Service from the browser.
 *
 * Everything a Service needs to exist is one Monad transaction the operator
 * signs: an identity, the Assets it accepts and where it collects them, the
 * tools it meters and their prices, and a Settlement Window. The SDK has always
 * been able to send it. This is the same call with the arguments laid out,
 * checked before a wallet is opened, and shown in full before it is signed.
 *
 * The page is a shell. Everything below the heading needs a wallet and a form,
 * so it is one island, and this route resolves the selected network and its
 * `ServiceRegistry` the same way `/authorise` does.
 */

import { NewServiceWizard } from "./_wizard";
import { routeContext } from "../../_lib/context";

export const dynamic = "force-dynamic";

export default async function NewServicePage() {
  const context = await routeContext();
  const chain = context.network;

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Monetise
        </p>
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">
          Register a Service, and charge for what it delivers
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Registration is permissionless: nobody approves this and nothing here asks for a review.
          You sign one {chain.name} transaction that records who operates the Service, which Assets
          it takes, where it collects them, what each tool costs, and how long a tab may stay open.
          From then on the chain is the authority on your prices, and this site reads them the same
          way it reads everyone else&apos;s.
        </p>
      </div>

      <NewServiceWizard
        serviceRegistry={context.contracts.serviceRegistry}
        chainId={context.chainId}
        chainName={chain.name}
        networkKind={chain.network}
        rpcUrl={context.rpcUrl}
        explorerUrl={context.explorerUrl}
        defaultAsset={context.contracts.mockUsdc}
      />
    </section>
  );
}
