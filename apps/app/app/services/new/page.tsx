/**
 * `/services/new` - registering a Service from the browser.
 *
 * Everything a Service needs to exist is a Creditcoin transaction the operator
 * signs: an identity, the Assets it accepts and where it collects them, the tools
 * it meters and their prices, and a Settlement Window. The SDK has always been
 * able to send it. This is the same call with the arguments laid out, checked
 * before a wallet is opened, and shown in full before it is signed.
 *
 * The page is a shell. Everything below the heading needs a wallet and a form,
 * so it is one island, and this route resolves the two addresses it reads from
 * the environment the same way `/register` does - refusing plainly where the
 * deployment has not been configured rather than offering a form that could only
 * fail.
 *
 * Requirements: 11.1, 24.3, 24.5, 24.9
 */

import { NewServiceWizard } from "./_wizard";
import { EmptyChain } from "../../../components/views/empty-chain";

export const dynamic = "force-dynamic";

function serviceRegistryAddress(): string | undefined {
  const address = process.env["SERVICE_REGISTRY_ADDRESS"]?.trim();
  if (address === undefined || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  if (/^0x0{40}$/i.test(address)) return undefined;
  return address.toLowerCase();
}

function creditcoinChainId(): number {
  const raw = process.env["CREDITCOIN_CHAIN_ID"]?.trim();
  return raw !== undefined && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 102031;
}

function creditcoinRpcUrl(): string {
  return process.env["CREDITCOIN_RPC_URL"] ?? "https://rpc.cc3-testnet.creditcoin.network";
}

export default function NewServicePage() {
  const registry = serviceRegistryAddress();

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
          You sign one Creditcoin transaction that records who operates the Service, which Assets it
          takes, where it collects them, what each tool costs, and how long a tab may stay open. From
          then on the chain is the authority on your prices, and this site reads them the same way it
          reads everyone else&apos;s.
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
          chainId={creditcoinChainId()}
          rpcUrl={creditcoinRpcUrl()}
        />
      )}
    </section>
  );
}
