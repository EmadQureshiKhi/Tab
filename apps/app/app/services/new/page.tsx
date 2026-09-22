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
 * so it is one island, and this route resolves the addresses it reads from the
 * environment the same way `/authorise` does - refusing plainly where the
 * deployment has not been configured rather than offering a form that could only
 * fail.
 */

import { NewServiceWizard } from "./_wizard";
import { EmptyChain } from "../../../components/views/empty-chain";
import {
  chainId,
  explorerBaseUrl,
  mockUsdcAddress,
  monadRpcUrl,
  network,
  serviceRegistryAddress,
} from "../../_lib/context";

export const dynamic = "force-dynamic";

export default function NewServicePage() {
  const registry = serviceRegistryAddress();
  const chain = network();

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

      {registry === undefined ? (
        <EmptyChain
          message="SERVICE_REGISTRY_ADDRESS is not configured, so this deployment cannot register a Service."
          indexedBlock={null}
        />
      ) : (
        <NewServiceWizard
          serviceRegistry={registry}
          chainId={chainId()}
          chainName={chain.name}
          networkKind={chain.network}
          rpcUrl={monadRpcUrl()}
          explorerUrl={explorerBaseUrl()}
          defaultAsset={chain.network === "testnet" ? mockUsdcAddress() : undefined}
        />
      )}
    </section>
  );
}
