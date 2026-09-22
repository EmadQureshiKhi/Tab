/**
 * `/services` - the Service directory, and the timelock made visible.
 *
 * ## A queued change is shown beside the applied value, never in place of it
 *
 * `ServiceRegistry` holds every change to a tier, a price, a Collection Address,
 * an accepted Asset or a Settlement Window for 48 hours, and keeps serving the
 * previously applied value for the whole hold. So this page shows
 * the tier a Service holds *today* through `TierBadge`, and lists any queued
 * change separately with its ETA. Showing the queued tier as current would be
 * reporting a credit weight the chain does not yet grant, which is exactly the
 * confusion the timelock exists to prevent.
 *
 * ## Tier gates weight, not recognition
 *
 * A Permissionless Service is registered, metered and paid in full. What its
 * Settlements do not do is add weight to an Agent's Credit Limit. The
 * badge says so, and so does the credit-weight line beside it, so nothing here
 * can be read as permission to transact.
 *
 * ## The operator's identity, and x402, under each card
 *
 * The registry serves the operator's ERC-8004 identity on the detail read only,
 * so this page reads one detail per listed Service beside the page read and
 * prints the operator's name, or the stated absence, in a strip under the card.
 * The same strip says whether the Service offers x402 on a credit refusal, which
 * is a fact from the published directory rather than from the chain: a call
 * that runs out of credit can then be paid per request, and those payments
 * settle to the Service directly rather than as Settlements on Tab.
 */

import { EmptyChain } from "../../components/views/empty-chain";
import { CurationAuthority } from "../../components/views/curation-authority";
import { ServiceOperatorStrip } from "../../components/views/service-operator-strip";
import { Link } from "../../components/ui/link";
import { Reveal, RevealGroup, RevealItem } from "../../components/motion/reveal";
import { ServiceCard } from "../../components/shell/service-card";
import { formatAssetAmount } from "../../components/custom-ui/format";
import { offersX402 } from "../../src/dashboard/catalogue";
import { readPublishedDirectory } from "../../src/dashboard/published";
import {
  assetUnitFor,
  serviceNameOf,
  toBigInt,
  toIdentitySummary,
  toIdentityView,
} from "../../src/dashboard/views";
import type { IdentityRow, RegistryClient, ServiceRow } from "../../src/dashboard/client";
import { chain, explorerBaseUrl, routeContext } from "../_lib/context";
import { readCurationAuthority, type CurationAuthorityView } from "../../src/dashboard/curation";

export const dynamic = "force-dynamic";

/**
 * The curation authority, from the environment contract, or nothing.
 *
 * The template ships the zero address, which is present and well formed and holds
 * no contract, so it is treated as absent rather than drawn as a party.
 */
function curationAuthorityAddress(): string | undefined {
  const value = process.env["CURATION_AUTHORITY_ADDRESS"]?.trim();
  if (value === undefined || !/^0x[0-9a-fA-F]{40}$/.test(value)) return undefined;
  if (/^0x0{40}$/i.test(value)) return undefined;
  return value;
}

/**
 * What that address is, asked of the chain.
 *
 * A read that cannot be made is reported as one, not guessed at: the address is
 * what the registry checks whatever this page manages to learn about it.
 */
async function curationAuthority(): Promise<CurationAuthorityView | undefined> {
  const address = curationAuthorityAddress();
  if (address === undefined) return undefined;
  const reader = chain();
  const head = await reader.latestBlock();
  if (!head.ok) {
    return { address, kind: "unreadable", unreadable: `the chain could not be read (${head.error.code})` };
  }
  return readCurationAuthority(reader, address, head.value.number);
}

/** Seconds to a readable duration, for a Settlement Window. */
function hours(seconds: number): string {
  const whole = seconds / 3600;
  return Number.isInteger(whole) ? `${whole} hours` : `${(seconds / 3600).toFixed(1)} hours`;
}

/** What one detail read came to: the operator's identity, or why it was not read. */
type OperatorIdentity =
  | { readonly ok: true; readonly identity: IdentityRow | null | undefined }
  | { readonly ok: false; readonly message: string };

/**
 * One detail read per listed Service, for the operator's identity.
 *
 * The reads run together and a failed one is carried as its reason rather than
 * failing the page: the directory row is chain state and stands on its own, and
 * the strip under it says the identity was not read.
 */
async function operatorIdentities(
  services: readonly ServiceRow[],
  read: RegistryClient["service"],
): Promise<ReadonlyMap<string, OperatorIdentity>> {
  const entries = await Promise.all(
    services.map(async (service): Promise<readonly [string, OperatorIdentity]> => {
      const detail = await read(service.serviceId);
      return [
        service.serviceId,
        detail.ok ? { ok: true, identity: detail.value.service.identity } : { ok: false, message: detail.error.message },
      ];
    }),
  );
  return new Map(entries);
}

export default async function ServicesPage() {
  const context = routeContext();
  const [page, published, authority] = await Promise.all([
    context.registry.services(25),
    readPublishedDirectory(),
    curationAuthority(),
  ]);
  const identities = page.ok
    ? await operatorIdentities(page.value.services, context.registry.service)
    : new Map<string, OperatorIdentity>();
  const publishedById = new Map(published.map((entry) => [entry.serviceId.toLowerCase(), entry]));

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
          Every registered Service on {context.network.name}, with the tier it holds today. A tier
          decides what a Service&apos;s Settlements weigh toward an Agent&apos;s Credit Limit, and
          nothing else: a Permissionless Service is registered, metered and paid exactly like a
          Curated one.
        </p>
      </Reveal>

      {/*
        Who holds the one privileged role, said on the page the role acts on
        rather than only in the threat model. It is the sentence a reader would
        otherwise have to go looking for, and the part worth knowing is the last
        clause: the role is fixed at construction, so it cannot be moved quietly.
      */}
      <Reveal>
        <CurationAuthority authority={authority} explorerBaseUrl={explorerBaseUrl()} />
      </Reveal>

      {!page.ok ? (
        <EmptyChain
          message={`The registry could not be read: ${page.error.message}`}
          indexedBlock={null}
        />
      ) : page.value.services.length === 0 ? (
        <EmptyChain
          message={`No Service is registered on ${context.network.name} yet.`}
          indexedBlock={page.value.index.lastBlock}
        />
      ) : (
        <RevealGroup className="flex flex-col gap-6">
          {page.value.services.map((service) => {
            const name = serviceNameOf(service.serviceId);
            const tier =
              service.tier.name.toLowerCase() === "curated" ? "curated" : "permissionless";

            // All three figures come from the row. Free is staked less withdrawn,
            // which is what `TabBook` reads when it caps a Credit Limit, so
            // overstating it is the direction that misleads.
            const ledgers = service.bond.map((row) => ({
              asset: assetUnitFor(row.asset),
              stakedBaseUnits: toBigInt(row.staked) ?? 0n,
              withdrawnBaseUnits: toBigInt(row.withdrawn) ?? 0n,
              freeBaseUnits: toBigInt(row.free) ?? 0n,
            }));

            const assets =
              service.acceptedAssets.length === 0
                ? "none"
                : service.acceptedAssets
                    .map((entry) => assetUnitFor(entry.asset).symbol)
                    .filter((symbol, index, all) => all.indexOf(symbol) === index)
                    .join(", ");

            const priced = service.prices[0];
            const price =
              priced === undefined
                ? "none set"
                : formatAssetAmount(toBigInt(priced.baseUnits) ?? 0n, assetUnitFor(priced.asset)).text;

            // The identity from the detail read, or the reason it was not read.
            // `undefined` here means the read was not made at all, which cannot
            // happen for a listed row but is stated rather than assumed.
            const read = identities.get(service.serviceId);
            const identity = toIdentitySummary(toIdentityView(read?.ok === true ? read.identity : undefined));
            const identityUnavailable =
              read === undefined ? "the detail read was not made" : read.ok ? undefined : read.message;

            return (
              <RevealItem key={service.serviceId} as="div" className="flex flex-col gap-2">
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
                      note: "how long a tab may stay open before anyone may mark it delinquent",
                    },
                    {
                      label: "Accepted Assets",
                      value: assets,
                      note: `paid to the Service's collection address on ${context.network.name}`,
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
                <ServiceOperatorStrip
                  identity={identity}
                  identityUnavailable={identityUnavailable}
                  x402={offersX402(publishedById.get(service.serviceId.toLowerCase()))}
                />
              </RevealItem>
            );
          })}
        </RevealGroup>
      )}
    </section>
  );
}
