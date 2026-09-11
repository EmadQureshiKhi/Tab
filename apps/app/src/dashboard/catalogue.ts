/**
 * The catalogue: every priced tool on the chain, joined to where it can be called.
 *
 * ## Two sources, and the page says which is which
 *
 * The tools, the prices, the Assets and the tier come from `ServiceRegistry` by
 * way of the index. Those are facts about money and they are on chain.
 *
 * The endpoint does not exist on chain and cannot: `Service` stores an operator,
 * a tier, a window, a bond account and a timestamp, and no URL. So the endpoint
 * comes from `service-endpoints.json`, which this project publishes, and every
 * entry carries `published` saying so. A Service registered on chain but absent
 * from that file keeps all its real figures and simply has nowhere to be called;
 * that is drawn as a missing address, never as a missing Service.
 *
 * ## A price is per Asset, so a tool is a row per Asset
 *
 * `ToolPriceSet` is keyed by `(serviceId, asset, tool)`. One tool priced in two
 * Assets is two prices, not one price with two currencies, and flattening them
 * would invent a conversion nobody performed.
 */

import type { ServiceBondRow, ServiceRow } from "./client.js";
import { assetUnitFor, nameOrWord, serviceNameOf, type AssetUnitView } from "./views.js";

/** One Service's published address, from the committed directory. */
export interface PublishedService {
  readonly serviceId: string;
  readonly name: string;
  readonly summary: string;
  readonly endpoint: string;
  readonly transport: string;
  readonly operatedBy: string;
  readonly tools: Readonly<Record<string, string>>;
}

/** One tool, at one price, in one Asset. */
export interface CatalogueEntry {
  readonly key: string;
  readonly serviceId: string;
  readonly serviceName: string;
  /** True where the serviceId decodes to a name rather than being shown as a word. */
  readonly serviceNamed: boolean;
  readonly tool: string;
  readonly toolNamed: boolean;
  readonly toolWord: string;
  readonly priceBaseUnits: bigint;
  readonly asset: AssetUnitView;
  readonly assetAddress: string;
  readonly chainKey: string | undefined;
  readonly tier: string;
  readonly creditWeight: string;
  readonly settlementWindowSeconds: number;
  readonly operator: string;
  /** Free Bond behind the Service in this Asset, where the index would stand behind it. */
  readonly freeBondBaseUnits: bigint | undefined;
  /** The published entry, or undefined where this project publishes no address. */
  readonly published: PublishedService | undefined;
  /** What the tool does, where the directory says. Never invented. */
  readonly description: string | undefined;
}

/** Flattens the directory into one row per tool per Asset. */
export function toCatalogue(
  services: readonly ServiceRow[],
  published: readonly PublishedService[],
): readonly CatalogueEntry[] {
  const byId = new Map(published.map((entry) => [entry.serviceId.toLowerCase(), entry]));
  const entries: CatalogueEntry[] = [];

  for (const service of services) {
    const listing = byId.get(service.serviceId.toLowerCase());
    const serviceName = serviceNameOf(service.serviceId);
    const chainKeyOf = new Map<string, string>(
      service.acceptedAssets.map(
        (row: ServiceRow["acceptedAssets"][number]) => [row.asset.toLowerCase(), row.chainKey] as const,
      ),
    );
    // A ledger the index would not stand behind is left out rather than shown as
    // zero, which is the same rule the Bond meter follows: a figure the registry
    // refused is absent, never nought.
    const freeOf = new Map<string, bigint>(
      service.bond
        .filter((row: ServiceBondRow) => row.crossCheck?.agrees !== false)
        .map((row: ServiceBondRow) => [row.asset.toLowerCase(), BigInt(row.free)] as const),
    );

    for (const price of service.prices) {
      const toolName = serviceNameOf(price.tool);
      entries.push({
        key: `${service.serviceId}:${price.asset}:${price.tool}`,
        serviceId: service.serviceId,
        serviceName: serviceName ?? service.serviceId,
        serviceNamed: serviceName !== undefined,
        tool: nameOrWord(price.tool),
        toolNamed: toolName !== undefined,
        toolWord: price.tool,
        priceBaseUnits: BigInt(price.baseUnits),
        asset: assetUnitFor(price.asset),
        assetAddress: price.asset,
        chainKey: chainKeyOf.get(price.asset.toLowerCase()),
        tier: service.tier.name,
        creditWeight: service.tier.creditWeight,
        settlementWindowSeconds: service.settlementWindowSeconds.value,
        operator: service.operator,
        freeBondBaseUnits: freeOf.get(price.asset.toLowerCase()),
        published: listing,
        description: toolName === undefined ? undefined : listing?.tools[toolName],
      });
    }
  }

  /*
    Callable first, then cheapest.

    Registration is permissionless and a Service needs no address to be listed, so
    this catalogue accumulates entries that are real on chain and have nowhere to
    send a call. That is correct - the chain is the authority on prices and this
    page shows what it says - but it is the wrong thing to rank first on a page
    whose purpose is tools an Agent can call. Nothing is hidden by this: an entry
    with no published address is still listed in full, with its real tier and
    price, and still says why it has no run command. It just stops sitting above
    the ones that work.

    Within each group, cheapest first, because a reader scanning a catalogue is
    comparing price and any other order makes them do the comparison themselves.
    Ties fall back to the name so the order is stable between renders.
  */
  return entries.sort((left, right) => {
    const leftCallable = left.published?.endpoint === undefined ? 1 : 0;
    const rightCallable = right.published?.endpoint === undefined ? 1 : 0;
    if (leftCallable !== rightCallable) return leftCallable - rightCallable;
    if (left.priceBaseUnits !== right.priceBaseUnits) {
      return left.priceBaseUnits < right.priceBaseUnits ? -1 : 1;
    }
    return left.tool.localeCompare(right.tool);
  });
}

/** The commands a reader copies to call one entry. */
export interface RunRecipe {
  readonly connect: string;
  readonly prompt: string;
  readonly call: string;
}

/**
 * What to run, for one entry.
 *
 * Written against the tool the reader is looking at rather than as a generic
 * example, because an example with placeholders is a thing to adapt and a filled
 * command is a thing to paste.
 */
export function recipeFor(entry: CatalogueEntry): RunRecipe {
  const call = [
    "tab_call with",
    `  service: ${entry.serviceNamed ? entry.serviceName : entry.serviceId}`,
    `  tool:    ${entry.tool}`,
    `  asset:   ${entry.chainKey ?? "?"}:${entry.assetAddress}`,
  ].join("\n");

  return {
    connect: "pnpm dlx @tabai/sdk connect",
    prompt: `Use tab_discover to find ${entry.tool}, then call it with tab_call.`,
    call,
  };
}
