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

/**
 * What a published Service says about x402.
 *
 * `offerOn402` means a credit refusal from this Service carries an x402 offer
 * for the same charge, so a call that ran out of credit can be paid per request
 * instead. Those payments settle to the Service directly and never become
 * Settlements on Tab.
 */
export interface PublishedX402 {
  readonly offerOn402?: boolean | undefined;
  readonly facilitator?: string | undefined;
  readonly scheme?: string | undefined;
  readonly note?: string | undefined;
}

/**
 * The API Hub provider a published Service fronts, from the directory.
 *
 * The Service pays the Hub's x402 price with its own key and meters the Agent's
 * Open Tab for that price plus `marginBps`. `manifest` is where the Hub publishes
 * the provider's endpoints, and `prefix` is the mount under the Service endpoint.
 */
export interface PublishedHub {
  readonly provider: string;
  readonly prefix: string;
  readonly upstream?: string | undefined;
  readonly manifest?: string | undefined;
  readonly marginBps?: number | undefined;
  /** The tool the fronted calls are metered under. Defaults to `<prefix>.run`. */
  readonly tool?: string | undefined;
  readonly note?: string | undefined;
}

/** One Service's published address, from the committed directory. */
export interface PublishedService {
  readonly serviceId: string;
  readonly name: string;
  readonly summary: string;
  readonly endpoint: string;
  readonly transport: string;
  readonly operatedBy: string;
  readonly tools: Readonly<Record<string, string>>;
  readonly x402?: PublishedX402 | undefined;
  readonly hub?: PublishedHub | undefined;
}

/** Whether a published entry says the Service takes x402 beside credit. */
export function offersX402(entry: PublishedService | undefined): boolean {
  if (entry === undefined) return false;
  return entry.x402?.offerOn402 === true || entry.hub !== undefined;
}

const stringOr = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);
const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * The directory file, narrowed to the shape the pages take.
 *
 * Only `serviceId` and `endpoint` are required; an entry without them names
 * nowhere to call and is dropped. Everything else is carried where it is the
 * right type and left out where it is not, so a typo in the file makes a field
 * absent rather than making the page fail. The file is this project's and a
 * malformed one is a bug to fix, but a catalogue that stopped rendering the
 * chain's prices over a bad note would be the wrong way to find out.
 */
export function parsePublishedDirectory(parsed: unknown): readonly PublishedService[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const list = (parsed as { services?: unknown }).services;
  if (!Array.isArray(list)) return [];
  const services: PublishedService[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record["serviceId"] !== "string" || typeof record["endpoint"] !== "string") continue;
    const tools: Record<string, string> = {};
    if (typeof record["tools"] === "object" && record["tools"] !== null) {
      for (const [name, text] of Object.entries(record["tools"] as Record<string, unknown>)) {
        if (typeof text === "string") tools[name] = text;
      }
    }
    const x402 = record["x402"];
    const hub = record["hub"];
    const hubRecord = typeof hub === "object" && hub !== null ? (hub as Record<string, unknown>) : undefined;
    const provider = hubRecord === undefined ? undefined : optionalString(hubRecord["provider"]);
    services.push({
      serviceId: record["serviceId"],
      endpoint: record["endpoint"],
      name: stringOr(record["name"], record["serviceId"]),
      summary: stringOr(record["summary"], ""),
      transport: stringOr(record["transport"], "http"),
      operatedBy: stringOr(record["operatedBy"], "unstated"),
      tools,
      ...(typeof x402 === "object" && x402 !== null
        ? {
            x402: {
              offerOn402: (x402 as Record<string, unknown>)["offerOn402"] === true,
              facilitator: optionalString((x402 as Record<string, unknown>)["facilitator"]),
              scheme: optionalString((x402 as Record<string, unknown>)["scheme"]),
              note: optionalString((x402 as Record<string, unknown>)["note"]),
            },
          }
        : {}),
      ...(hubRecord !== undefined && provider !== undefined
        ? {
            hub: {
              provider,
              prefix: stringOr(hubRecord["prefix"], provider).replace(/^\/+|\/+$/g, ""),
              upstream: optionalString(hubRecord["upstream"]),
              manifest: optionalString(hubRecord["manifest"]),
              marginBps:
                typeof hubRecord["marginBps"] === "number" &&
                Number.isInteger(hubRecord["marginBps"]) &&
                hubRecord["marginBps"] >= 0
                  ? hubRecord["marginBps"]
                  : undefined,
              tool: optionalString(hubRecord["tool"]),
              note: optionalString(hubRecord["note"]),
            },
          }
        : {}),
    });
  }
  return services;
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
  /** Where a Settlement in this Asset is paid to, as the registry holds it. */
  readonly collection: string | undefined;
  /** The chain this deployment settles on, so the Asset can be named `chainId:address`. */
  readonly chainId: number;
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
  chainId: number,
): readonly CatalogueEntry[] {
  const byId = new Map(published.map((entry) => [entry.serviceId.toLowerCase(), entry]));
  const entries: CatalogueEntry[] = [];

  for (const service of services) {
    const listing = byId.get(service.serviceId.toLowerCase());
    const serviceName = serviceNameOf(service.serviceId);
    const collectionOf = new Map<string, string>(
      service.acceptedAssets.map(
        (row: ServiceRow["acceptedAssets"][number]) => [row.asset.toLowerCase(), row.collection] as const,
      ),
    );
    // A ledger the index would not stand behind is left out rather than shown as
    // zero, which is the same rule the Bond meter follows: a figure the registry
    // refused is absent, never nought. An Asset with no ledger at all is the
    // other case: nothing was ever staked in it, which the index does stand
    // behind, and the honest figure is zero.
    const freeOf = new Map<string, bigint>(
      service.bond
        .filter((row: ServiceBondRow) => row.crossCheck?.agrees !== false)
        .map((row: ServiceBondRow) => [row.asset.toLowerCase(), BigInt(row.free)] as const),
    );
    const refused = new Set<string>(
      service.bond
        .filter((row: ServiceBondRow) => row.crossCheck?.agrees === false)
        .map((row: ServiceBondRow) => row.asset.toLowerCase()),
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
        collection: collectionOf.get(price.asset.toLowerCase()),
        chainId,
        tier: service.tier.name,
        creditWeight: service.tier.creditWeight,
        settlementWindowSeconds: service.settlementWindowSeconds.value,
        operator: service.operator,
        freeBondBaseUnits: freeOf.get(price.asset.toLowerCase()) ?? (refused.has(price.asset.toLowerCase()) ? undefined : 0n),
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
    `  asset:   ${entry.chainId}:${entry.assetAddress}`,
  ].join("\n");

  return {
    connect: "pnpm dlx @tabai/sdk connect",
    prompt: `Use tab_discover to find ${entry.tool}, then call it with tab_call.`,
    call,
  };
}
