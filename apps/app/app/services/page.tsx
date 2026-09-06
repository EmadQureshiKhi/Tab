/**
 * `/services` - the Service directory, and the timelock made visible.
 *
 * ## A queued change is shown beside the applied value, never in place of it
 *
 * `ServiceRegistry` holds every change to a tier, a price, a Collection Address,
 * an accepted Asset or a Settlement Window for 48 hours, and keeps serving the
 * previously applied value for the whole hold (R11.6, R11.7). So this page shows
 * the tier a Service holds *today* through `TierBadge`, and lists any queued
 * change separately with its ETA. Showing the queued tier as current would be
 * reporting a credit weight the chain does not yet grant, which is exactly the
 * confusion the timelock exists to prevent.
 *
 * ## Tier gates weight, not recognition
 *
 * A Permissionless Service is registered, metered and paid in full. What its
 * Verified Settlements do not do is add weight to an Agent's Credit Limit
 * (R11.4). The badge says so, and so does the credit-weight line beside it, so
 * nothing here can be read as permission to transact.
 *
 * Requirements: 24.3, 11.6, 11.7, 11.8, 11.9, 24.9
 */

import { EmptyChain } from "../../components/views/empty-chain";
import { CurationAuthority } from "../../components/views/curation-authority";
import { Link } from "../../components/ui/link";
import { Reveal, RevealGroup, RevealItem } from "../../components/motion/reveal";
import { ServiceCard } from "../../components/shell/service-card";
import { formatAssetAmount } from "../../components/custom-ui/format";
import { assetUnitFor, serviceNameOf, toBigInt } from "../../src/dashboard/views";
import { explorerBaseUrl, routeContext, type SearchParams } from "../_lib/context";

export const dynamic = "force-dynamic";

/**
 * An address from the environment, or nothing.
 *
 * The template ships the zero address, which is present and well formed and holds
 * no contract, so it is treated as absent rather than drawn as a party.
 */
function configuredAddress(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (value === undefined || !/^0x[0-9a-fA-F]{40}$/.test(value)) return undefined;
  if (/^0x0{40}$/i.test(value)) return undefined;
  return value;
}

/** Seconds to a readable duration, for a Settlement Window. */
function hours(seconds: number): string {
  const whole = seconds / 3600;
  return Number.isInteger(whole) ? `${whole} hours` : `${(seconds / 3600).toFixed(1)} hours`;
}

export default async function ServicesPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const context = routeContext(await searchParams);
  const page = await context.registry.services(25);

  return (
    <section className="flex flex-col gap-10">
      <Reveal className="flex flex-col gap-1">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Directory
        </p>
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">
            Service directory
          </h1>
          {/* The two writes that put a Service in this list, beside the list. */}
          <div className="flex flex-wrap gap-4">
            <Link href="/services/new" size="xs" className="font-mono tracking-wide uppercase">
              Register a Service
            </Link>
            <Link href="/services/bond" size="xs" className="font-mono tracking-wide uppercase">
              Post a Bond
            </Link>
          </div>
        </div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Every registered Service, with the tier it holds today. A tier decides what a
          Service&apos;s Verified Settlements weigh toward an Agent&apos;s Credit Limit, and nothing
          else: a Permissionless Service is registered, metered and paid exactly like a Curated one.
        </p>
      </Reveal>

      {/*
        Who holds the one privileged role, said on the page the role acts on
        rather than only in the threat model. It is the sentence a reader would
        otherwise have to go looking for, and the part worth knowing is the last
        clause: the role is fixed at construction, so it cannot be moved quietly.
      */}
      <Reveal>
        <CurationAuthority
          authority={configuredAddress("CURATION_AUTHORITY_ADDRESS")}
          multisig={configuredAddress("CURATION_MULTISIG_ADDRESS")}
          explorerBaseUrl={explorerBaseUrl()}
        />
      </Reveal>

      {!page.ok ? (
        <EmptyChain
          message={`The registry could not be read: ${page.error.message}`}
          indexedBlock={null}
        />
      ) : page.value.services.length === 0 ? (
        <EmptyChain
          message="No Service is registered yet."
          indexedBlock={page.value.index.lastBlock}
        />
      ) : (
        <RevealGroup className="flex flex-col gap-6">
          {page.value.services.map((service) => {
            const name = serviceNameOf(service.serviceId);
            const tier =
              service.tier.name.toLowerCase() === "curated" ? "curated" : "permissionless";

            // All four figures come from the row. Three of them were once hardcoded
            // to zero here, which drew a Service whose Bond had been reserved
            // against, slashed, or partly withdrawn as though every unit of it were
            // still free. Free Bond is what covers the next Provisional Clearing, so
            // overstating it is the direction that misleads.
            const ledgers = service.bond.map((row) => ({
              asset: assetUnitFor(row.asset),
              stakedBaseUnits: toBigInt(row.staked) ?? 0n,
              reservedBaseUnits: toBigInt(row.reserved) ?? 0n,
              slashedBaseUnits: toBigInt(row.slashed) ?? 0n,
              releasedBaseUnits: toBigInt(row.released) ?? 0n,
            }));

            const assets =
              service.acceptedAssets.length === 0
                ? "none"
                : service.acceptedAssets
                    .map((entry) => assetUnitFor(entry.asset).symbol)
                    .filter((symbol, index, all) => all.indexOf(symbol) === index)
                    .join(", ");

            const chains =
              service.acceptedAssets.length === 0
                ? undefined
                : `on chainKey ${service.acceptedAssets
                    .map((entry) => String(entry.chainKey))
                    .filter((key, index, all) => all.indexOf(key) === index)
                    .join(" and ")}`;

            const priced = service.prices[0];
            const price =
              priced === undefined
                ? "none set"
                : formatAssetAmount(toBigInt(priced.baseUnits) ?? 0n, assetUnitFor(priced.asset)).text;

            return (
              <RevealItem key={service.serviceId} as="div">
                <ServiceCard
                  name={name ?? "Service"}
                  serviceId={service.serviceId}
                  operator={service.operator}
                  tier={tier}
                  creditWeight={service.tier.creditWeight}
                  facts={[
                    {
                      label: "Settlement Window",
                      value: hours(service.settlementWindowSeconds.value),
                      note: "how long a tab may stay open before it is delinquent",
                    },
                    {
                      label: "Accepted Assets",
                      value: assets,
                      ...(chains === undefined ? {} : { note: chains }),
                    },
                    {
                      label: "Price per call",
                      value: price,
                      ...(service.prices.length > 1
                        ? { note: `${service.prices.length} priced tools` }
                        : {}),
                    },
                    {
                      label: "Tools priced",
                      value: String(service.prices.length),
                      note: "a tool with no price cannot be metered",
                    },
                  ]}
                  ledgers={ledgers}
                  pendingChanges={service.pendingChanges.map((change) => ({
                    changeId: change.changeId,
                    kindName: change.kindName,
                    summary:
                      change.decoded === null
                        ? change.payload
                        : Object.entries(change.decoded)
                            .map(([key, value]) => `${key}=${String(value)}`)
                            .join(" "),
                    etaIso: change.etaIso ?? null,
                  }))}
                />
              </RevealItem>
            );
          })}
        </RevealGroup>
      )}
    </section>
  );
}
