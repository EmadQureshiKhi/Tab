/**
 * `/register` - bind a Source Chain address to an Agent.
 *
 * The one route on this Dashboard that needs a wallet, and design section 12.2 says
 * so. Everything else here renders fully without one; this cannot, because the
 * binding request is a transaction the Agent must sign as itself.
 *
 * The page is a server component that resolves configuration and hands it to a
 * client island. That split is not ceremony: `AGENT_REGISTRY_ADDRESS` and
 * `CREDITCOIN_CHAIN_ID` are server-side variables, and a client component reading
 * `process.env` for them would compile and then find them undefined in the browser,
 * because only `NEXT_PUBLIC_` names are inlined into the client bundle.
 *
 * Requirements: 24.5, 10.1, 10.4, 10.6
 */

import { EmptyChain } from "../../components/views/empty-chain";
import { chainOptionFor } from "../../src/dashboard/chains";
import { creditcoinRpcUrl, type SearchParams } from "../_lib/context";
import { routeContext } from "../_lib/context";
import { RegisterForm } from "./_form";

export const dynamic = "force-dynamic";

/** `AgentRegistry`, from the environment contract. */
function agentRegistryAddress(): string | undefined {
  const address = process.env["AGENT_REGISTRY_ADDRESS"]?.trim();
  if (address === undefined || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  // The template ships the zero address, which is well formed and holds no
  // contract. Treated as absent, so an unfilled environment says "not configured"
  // rather than offering a form that could only ever fail.
  if (/^0x0{40}$/i.test(address)) return undefined;
  return address.toLowerCase();
}

function creditcoinChainId(): number {
  const raw = process.env["CREDITCOIN_CHAIN_ID"]?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return 102031;
  return Number.parseInt(raw, 10);
}

export default async function RegisterPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const context = routeContext(await searchParams);
  const registryAddress = agentRegistryAddress();
  const chain = chainOptionFor(context.chainKey);

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">Bind an address</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          A binding proves you control an address on {chain.name}, and it proves it by payment
          rather than by signature. Ask for a nonce below, then settle the exact amount you are given from
          the address you are claiming. The last four digits of that amount are the nonce, so a
          Verified Settlement of exactly that figure from exactly that address is the proof. No
          component of Tab has to be trusted for it, and nobody can bind an address they cannot
          spend from.
        </p>
      </div>

      {registryAddress === undefined ? (
        <EmptyChain
          message="AGENT_REGISTRY_ADDRESS is not configured, so this deployment cannot issue a binding nonce."
          indexedBlock={null}
        />
      ) : (
        <RegisterForm
          agentRegistry={registryAddress}
          rpcUrl={creditcoinRpcUrl()}
          chainId={creditcoinChainId()}
          chainKey={context.chainKey}
          chainName={chain.name}
        />
      )}
    </section>
  );
}
