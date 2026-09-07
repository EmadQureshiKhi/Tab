/**
 * `/services/bond` - posting the stake that lets a Service clear provisionally.
 *
 * A Bond is what a Service puts at risk so a Provisional Clearing can be applied
 * against it before the Settlement has been proved. Without one a Service is
 * still registered, still priced and still callable; it simply cannot have a
 * clearing applied in its favour until the proof lands.
 *
 * Two things about this flow are unlike anything else on the site and both are
 * said on the page rather than discovered.
 *
 * The first is that a Bond is not funded by a transfer to the contract. `Bond`
 * has no deposit function: stake arrives through `fundFromVerifiedSettlement`,
 * which credits it only from a Settlement that has already been verified. So the
 * deposit is a payment on a Source Chain, and the Bond appears afterwards.
 *
 * The second follows from it: there is a wait, and it is not this page's to
 * shorten. Between the transfer and the credited stake sits the same observation,
 * proof and verification every Settlement goes through.
 *
 * Requirements: 14.1, 24.3, 24.5
 */

import { BondFlow } from "./_flow";
import { EmptyChain } from "../../../components/views/empty-chain";
import { registry } from "../../_lib/context";

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

export default async function BondPage() {
  const [services, address] = await Promise.all([
    registry().services(50),
    Promise.resolve(serviceRegistryAddress()),
  ]);

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Monetise
        </p>
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">
          Post a Bond, by proven deposit
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          A Bond is stake a Service puts at risk so a clearing can be applied in its favour before
          the Settlement behind it has been proved. It is not funded by a transfer to a contract:
          `Bond` has no deposit function, and stake is credited only from a Settlement that has
          already been verified. So you pay on a Source Chain, exactly as an Agent does, and the
          stake appears once that payment has been proved.
        </p>
      </div>

      {address === undefined ? (
        <EmptyChain
          message="SERVICE_REGISTRY_ADDRESS is not configured, so a Bond collection cannot be registered."
          indexedBlock={null}
        />
      ) : (
        <BondFlow
          serviceRegistry={address}
          chainId={creditcoinChainId()}
          services={
            services.ok
              ? services.value.services.map((service) => ({
                  serviceId: service.serviceId,
                  operator: service.operator,
                  assets: service.acceptedAssets.map((asset) => ({
                    chainKey: asset.chainKey,
                    asset: asset.asset,
                    bondCollection: asset.bondCollection,
                  })),
                }))
              : []
          }
        />
      )}
    </section>
  );
}
