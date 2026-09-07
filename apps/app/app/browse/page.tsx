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
 * Requirements: 24.3, 24.9, 24.10
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CatalogueView } from "./_catalogue";
import { SHOWCASE } from "../../src/dashboard/showcase";
import { EmptyChain } from "../../components/views/empty-chain";
import { toCatalogue, type PublishedService } from "../../src/dashboard/catalogue";
import { registry } from "../_lib/context";

export const dynamic = "force-dynamic";

/**
 * The published directory, read from the repository root.
 *
 * A missing or malformed file is not an error worth failing the page for: every
 * price on this page is chain state and stands without it. The catalogue renders
 * with no run commands, and each row says why it has none.
 */
async function publishedServices(): Promise<readonly PublishedService[]> {
  try {
    const path = join(process.cwd(), "..", "..", "service-endpoints.json");
    const parsed = JSON.parse(await readFile(path, "utf8")) as { services?: unknown };
    if (!Array.isArray(parsed.services)) return [];
    return parsed.services.filter(
      (entry): entry is PublishedService =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as PublishedService).serviceId === "string" &&
        typeof (entry as PublishedService).endpoint === "string",
    );
  } catch {
    return [];
  }
}

export default async function BrowsePage() {
  const [services, published] = await Promise.all([registry().services(50), publishedServices()]);

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
          entries={toCatalogue(services.value.services, published).map((entry) => ({
            ...entry,
            priceBaseUnits: entry.priceBaseUnits.toString(),
            freeBondBaseUnits: entry.freeBondBaseUnits?.toString(),
          }))}
          showcase={SHOWCASE}
          indexedBlock={services.value.index.lastBlock}
        />
      )}
    </section>
  );
}
