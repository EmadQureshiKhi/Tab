/**
 * `/browse` - every priced tool on the chain, and what it costs to call one.
 *
 * ## Why this is not the Service directory again
 *
 * `/services` answers "who is registered, and on what terms": one card per
 * Service, with its tier, its window and the Bond behind it. That is the right
 * shape for judging a counterparty and the wrong shape for finding a tool. A
 * reader who wants a thing done is comparing tools and prices across Services,
 * so the row here is a tool, and the Service is a column on it.
 *
 * ## Every figure is the chain's; the address is ours
 *
 * The tools, the prices, the Assets, the tier and the Bond come from
 * `ServiceRegistry` through the index. The endpoint cannot: `Service` stores no
 * URL, so it comes from the committed `service-endpoints.json` and is labelled as
 * published by this project. A Service with no published address keeps all its
 * real figures and simply cannot be called from here, which the page says.
 *
 * ## The Hub is a third source, and it sorts last
 *
 * A published Service with a `hub` block fronts an API Hub provider: the
 * Service pays the Hub's x402 price per call with its own key and meters the
 * Agent's Open Tab for that price plus a margin. The Hub's manifest is read
 * here, server side, with a short timeout, and its endpoints are listed as
 * cards after every on-chain-priced tool, marked as fronted. A manifest that
 * cannot be read is a stated sentence on the page, not an absence: the chain's
 * prices stand without it.
 */

import type { HubFetch } from "@tabai/sdk";

import { CatalogueView } from "./_catalogue";
import { SHOWCASE } from "../../src/dashboard/showcase";
import { EmptyChain } from "../../components/views/empty-chain";
import { toCatalogue, type PublishedService } from "../../src/dashboard/catalogue";
import { toHubEntries, type HubManifestOutcome } from "../../src/dashboard/hub";
import { readPublishedDirectory } from "../../src/dashboard/published";
import { chainId, network, registry } from "../_lib/context";

export const dynamic = "force-dynamic";

/** How long one manifest read may take before the page states it did not answer. */
const HUB_MANIFEST_TIMEOUT_MS = 3_000;

/**
 * One manifest read per published Service with a `hub` block, keyed by serviceId.
 *
 * One page per provider, because the first hundred endpoints are a catalogue
 * and the rest is a count the note states. The reads run together and each is
 * bounded: a Hub that does not answer costs this page three seconds and one
 * sentence, never the chain's rows.
 */
async function hubManifests(
  published: readonly PublishedService[],
): Promise<ReadonlyMap<string, HubManifestOutcome>> {
  const fronting = published.filter((entry) => entry.hub !== undefined);
  if (fronting.length === 0) return new Map();
  /*
    Loaded at run time rather than bundled. The SDK's barrel also carries the
    `tab.config` discovery, which walks the filesystem, and a bundler that
    traces that walk pulls the whole repository into the server output. The
    page needs one pure reader from the package, so the package is resolved
    from `node_modules` when the page runs, the way the gateway resolves it.
  */
  const { fetchHubManifest } = await import(/* turbopackIgnore: true */ "@tabai/sdk");
  const timed: HubFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(HUB_MANIFEST_TIMEOUT_MS) });
  const outcomes = await Promise.all(
    fronting.map(async (entry): Promise<readonly [string, HubManifestOutcome]> => {
      const hub = entry.hub as NonNullable<PublishedService["hub"]>;
      const manifest = await fetchHubManifest({
        provider: hub.provider,
        ...(hub.manifest === undefined ? {} : { manifestUrl: hub.manifest }),
        fetchImpl: timed,
        maxPages: 1,
      });
      return [
        entry.serviceId.toLowerCase(),
        manifest.ok
          ? { ok: true, endpoints: manifest.value.endpoints, total: manifest.value.total }
          : { ok: false, message: manifest.error.message },
      ];
    }),
  );
  return new Map(outcomes);
}

export default async function BrowsePage() {
  const [services, published] = await Promise.all([registry().services(50), readPublishedDirectory()]);
  const manifests = await hubManifests(published);
  const hub = services.ok
    ? toHubEntries(services.value.services, published, manifests, chainId())
    : { entries: [], notes: [] };

  return (
    <section className="flex flex-col">
      {/*
        Centred, and the widest type on the site. The catalogue is the one page a
        reader can arrive at cold and act on, so it opens like a front door rather
        than like the seventh tab of a dashboard.
      */}
      <div className="px-4 pt-12 pb-14 text-center sm:pt-20">
        <h1 className="font-host text-3xl leading-[1.1] font-bold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
          The best tools
          <br />
          for autonomous agents
        </h1>
        <p className="mx-auto mt-5 max-w-lg text-sm leading-relaxed text-muted-foreground sm:text-base">
          No subscriptions, no credits and no API keys. Nothing is prepaid: the work is delivered
          first and the charge lands on an Open Tab you can read on chain.
        </p>
      </div>

      {!services.ok ? (
        <EmptyChain
          message={`The Service directory could not be read: ${services.error.message}`}
          indexedBlock={null}
        />
      ) : (
        <CatalogueView
          entries={toCatalogue(services.value.services, published, chainId()).map((entry) => ({
            ...entry,
            priceBaseUnits: entry.priceBaseUnits.toString(),
            freeBondBaseUnits: entry.freeBondBaseUnits?.toString(),
          }))}
          hub={hub.entries}
          hubNotes={hub.notes}
          showcase={SHOWCASE}
          indexedBlock={services.value.index.lastBlock}
          networkName={network().name}
          networkKind={network().network}
        />
      )}
    </section>
  );
}
