/**
 * `/keys` - the keys behind a passkey account, and what each one is for.
 *
 * One passkey, many keys. The owner key at `m/44'/60'/0'/0/0` is the root the
 * passkey stands behind; the session keys at `m/44'/60'/0'/0/<n>` for n >= 1
 * are the ones an agent runtime holds. This page lists them, derives the next
 * one, lets a session key be revealed once for a runtime, and sends the reader
 * to `/authorise` with that key active so it can authorise a Service as itself.
 *
 * Like `/authorise`, it is a server component that resolves the deployment's
 * chain and hands it to a client island, because `MONAD_CHAIN_ID` and
 * `MONAD_RPC_URL` are server-side variables the client bundle cannot read.
 * The island renders fully with no wallet and no passkey: the empty state is
 * an explanation of what a passkey account is and two ways to have one.
 */

import { chainId, explorerBaseUrl, monadRpcUrl, network } from "../_lib/context";
import { KeysView } from "../../components/passkey/keys-view";

export const dynamic = "force-dynamic";

export default function KeysPage() {
  const chain = network();
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Agent
        </p>
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">
          Keys
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          A passkey account is one passkey and as many keys as you derive from it. The owner key
          is the root; each session key is the Agent for one runtime, and it can always be
          derived again from the same passkey. Nothing on this page is stored: the keys exist
          while the page is open and come back from one touch on the authenticator.
        </p>
      </div>

      <KeysView
        chainId={chainId()}
        chainName={chain.name}
        rpcUrl={monadRpcUrl()}
        explorerUrl={explorerBaseUrl()}
      />
    </section>
  );
}
