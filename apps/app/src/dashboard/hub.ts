/**
 * The Hub section of the catalogue: x402 APIs a Service fronts on credit.
 *
 * ## Two prices, and both are named for what they are
 *
 * A Hub endpoint carries the Hub's own USD price, which is what the Service pays
 * the upstream per call with its own key. The Tab price is that figure plus the
 * Service's margin, and it is what lands on the Agent's Open Tab. The first is
 * the Hub's word and the second is this page's arithmetic from the published
 * margin, so a card prints both and says which is which. Neither is chain
 * state: `ServiceRegistry` prices the tool the fronted calls are metered under,
 * and the per-call figure is whatever the upstream's `402` asks on the day.
 *
 * ## Fronted, and drawn as fronted
 *
 * These entries sort after every on-chain-priced tool and carry the word
 * `fronted` where a listed tool carries `metered`. A listed price is read from
 * the chain; a fronted price is read from the Hub's manifest, which is a
 * different source, and the card labels it as that.
 *
 * ## Money stays text
 *
 * The manifest's price arrives as decimal USD text and the SDK's reader has
 * already turned it into six-decimal base units as text. The margin is applied
 * with `bigint` arithmetic and rounded up, because a catalogue must not
 * understate a price. Nothing here passes a figure through `number`.
 */

import type { ServiceRow } from "./client.js";
import type { PublishedService } from "./catalogue.js";
import { assetUnitFor, serviceNameOf, type AssetUnitView } from "./views.js";

/**
 * One endpoint as the SDK's `fetchHubManifest` reports it.
 *
 * Structural, and a subset of the SDK's `HubEndpoint`, so this module compiles
 * without the SDK and a page can hand the SDK's rows straight in.
 */
export interface HubEndpointInput {
  readonly provider: string;
  readonly providerName: string | null;
  /** The provider-relative path, for example `/protocols`. */
  readonly endpoint: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly priceType: string;
  /** The Hub's decimal USD figure, as text. */
  readonly priceUsd: string | null;
  /** The same in six-decimal base units, for a per-call price. */
  readonly priceBaseUnits: string | null;
  readonly networks: readonly string[];
  readonly categories: readonly string[];
}

/**
 * The mark for an API Hub provider a Service fronts, by the Hub's provider id.
 *
 * A fronted endpoint is sold through a Tab Service, so a provider with no mark
 * of its own here is drawn with Tab's rather than left blank. A mark is listed
 * only when it is the provider's own, because a wrong logo says something false
 * about who made a thing.
 */
const HUB_PROVIDER_LOGO: Readonly<Record<string, string>> = {
  defillama: "/logos/providers/defillama.png",
};

export function hubProviderLogo(provider: string): string {
  return HUB_PROVIDER_LOGO[provider.toLowerCase()] ?? "/logo.png";
}

/** What one Service's manifest read came to. */
export type HubManifestOutcome =
  | { readonly ok: true; readonly endpoints: readonly HubEndpointInput[]; readonly total: number }
  | { readonly ok: false; readonly message: string };

/** One fronted endpoint, shaped for a catalogue card. */
export interface HubEntry {
  readonly key: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly serviceNamed: boolean;
  readonly provider: string;
  readonly providerName: string;
  /** The provider-relative path the Hub names the endpoint by. */
  readonly path: string;
  /** The path on the Service where the call is sent: `/hub/<prefix>/run`. */
  readonly hubPath: string;
  /** The tool the fronted calls are metered under, from the directory. */
  readonly tool: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly priceType: string;
  /** The Hub's USD figure, as text. Absent where the manifest carries none. */
  readonly upstreamUsd: string | undefined;
  /** Upstream plus margin, in base units of the Service's Asset. Per-call prices only. */
  readonly tabPriceBaseUnits: string | undefined;
  readonly marginBps: number | undefined;
  /** The Asset the Service meters in, or a six-decimal dollar unit where it accepts none the index names. */
  readonly asset: AssetUnitView;
  readonly assetAddress: string | undefined;
  readonly chainId: number;
  readonly networks: readonly string[];
  readonly categories: readonly string[];
  readonly endpoint: string;
  readonly tier: string;
}

/** The statements the Hub section makes beside its cards, one per Service read. */
export interface HubNote {
  readonly serviceName: string;
  readonly provider: string;
  readonly text: string;
}

/**
 * The upstream figure plus the margin, rounded up.
 *
 * `bigint` throughout. A margin of 500 bps on 10,000 base units is 10,500; on
 * 10,001 it is 10,501.05 and rounds to 10,502, because the Service's pricing
 * rounds against itself and a catalogue that printed one unit less would be
 * understating what lands on the tab.
 */
export function withMargin(baseUnits: string, marginBps: number | undefined): string | undefined {
  if (!/^\d+$/.test(baseUnits)) return undefined;
  const upstream = BigInt(baseUnits);
  if (marginBps === undefined || marginBps === 0) return upstream.toString(10);
  if (!Number.isInteger(marginBps) || marginBps < 0) return undefined;
  const scaled = upstream * BigInt(10_000 + marginBps);
  const whole = scaled / 10_000n;
  return (scaled % 10_000n === 0n ? whole : whole + 1n).toString(10);
}

/** A six-decimal dollar unit, for a Service whose accepted Asset the index does not name. */
const DOLLAR_UNIT: AssetUnitView = { symbol: "USD", decimals: 6 };

/**
 * Joins the directory, the chain and the manifests into Hub cards.
 *
 * A published Service with a `hub` block that is not registered on chain gets a
 * note and no cards: nothing it fronts can be metered onto a tab, and a card
 * for it would be a price with no rail under it. A manifest that could not be
 * read gets a note saying so. Every note names the Service and the provider so
 * a reader can tell one Service's outage from another's.
 */
export function toHubEntries(
  services: readonly ServiceRow[],
  published: readonly PublishedService[],
  manifests: ReadonlyMap<string, HubManifestOutcome>,
  chainId: number,
): { readonly entries: readonly HubEntry[]; readonly notes: readonly HubNote[] } {
  const byId = new Map(services.map((row) => [row.serviceId.toLowerCase(), row]));
  const entries: HubEntry[] = [];
  const notes: HubNote[] = [];

  for (const listing of published) {
    const hub = listing.hub;
    if (hub === undefined) continue;
    const service = byId.get(listing.serviceId.toLowerCase());
    const serviceName = serviceNameOf(listing.serviceId) ?? listing.name;
    if (service === undefined) {
      notes.push({
        serviceName,
        provider: hub.provider,
        text: `${serviceName} publishes a Hub block for ${hub.provider} but is not registered on chain, so nothing it fronts can be metered onto a tab and none of its endpoints are listed.`,
      });
      continue;
    }
    const manifest = manifests.get(listing.serviceId.toLowerCase());
    if (manifest === undefined) {
      notes.push({
        serviceName,
        provider: hub.provider,
        text: `The API Hub manifest for ${hub.provider}, fronted by ${serviceName}, was not read, so its endpoints are not listed.`,
      });
      continue;
    }
    if (!manifest.ok) {
      notes.push({
        serviceName,
        provider: hub.provider,
        text: `The API Hub manifest for ${hub.provider}, fronted by ${serviceName}, could not be read: ${manifest.message}. Its endpoints are not listed, and the Service is still callable for its on-chain tools.`,
      });
      continue;
    }

    const accepted = service.acceptedAssets[0];
    const asset = accepted === undefined ? DOLLAR_UNIT : assetUnitFor(accepted.asset);
    const tool = hub.tool ?? `${hub.prefix}.run`;
    const hubPath = `/hub/${hub.prefix}/run`;

    for (const endpoint of manifest.endpoints) {
      const perCall = endpoint.priceType === "PER_CALL" && endpoint.priceBaseUnits !== null;
      entries.push({
        key: `hub:${listing.serviceId}:${hub.provider}:${endpoint.endpoint}`,
        serviceId: listing.serviceId,
        serviceName,
        serviceNamed: serviceNameOf(listing.serviceId) !== undefined,
        provider: hub.provider,
        providerName: endpoint.providerName ?? hub.provider,
        path: endpoint.endpoint,
        hubPath,
        tool,
        name: endpoint.name ?? endpoint.endpoint,
        description: endpoint.description ?? undefined,
        priceType: endpoint.priceType,
        upstreamUsd: endpoint.priceUsd ?? undefined,
        tabPriceBaseUnits: perCall ? withMargin(endpoint.priceBaseUnits as string, hub.marginBps) : undefined,
        marginBps: hub.marginBps,
        asset,
        assetAddress: accepted?.asset,
        chainId,
        networks: endpoint.networks,
        categories: endpoint.categories,
        endpoint: listing.endpoint,
        tier: service.tier.name,
      });
    }
    if (manifest.total > manifest.endpoints.length) {
      notes.push({
        serviceName,
        provider: hub.provider,
        text: `The Hub lists ${manifest.total} endpoints for ${manifest.endpoints[0]?.providerName ?? hub.provider}; the first ${manifest.endpoints.length} are shown.`,
      });
    }
  }

  // Cheapest per-call first, then the ones with no fixed price, then by path,
  // so the order is stable between renders and a reader comparing prices is
  // not made to do the comparison.
  entries.sort((left, right) => {
    const leftPrice = left.tabPriceBaseUnits === undefined ? undefined : BigInt(left.tabPriceBaseUnits);
    const rightPrice = right.tabPriceBaseUnits === undefined ? undefined : BigInt(right.tabPriceBaseUnits);
    if (leftPrice !== undefined && rightPrice !== undefined && leftPrice !== rightPrice) {
      return leftPrice < rightPrice ? -1 : 1;
    }
    if ((leftPrice === undefined) !== (rightPrice === undefined)) return leftPrice === undefined ? 1 : -1;
    return left.path.localeCompare(right.path);
  });

  return { entries, notes };
}

/** The commands a reader copies to call one fronted endpoint. */
export interface HubRecipe {
  readonly connect: string;
  readonly prompt: string;
  readonly call: string;
  /** The same call over plain HTTP, against the Service's published endpoint. */
  readonly http: string;
}

/**
 * What to run, for one fronted endpoint.
 *
 * The Hub is called through the Service at `<endpoint>/hub/<prefix>/run` with
 * the provider, the endpoint path and the input in the body, and the charge is
 * metered under the Service's tool for the Hub. Both forms are filled in for
 * the endpoint the reader is looking at rather than left as a template.
 */
export function hubRecipeFor(entry: HubEntry): HubRecipe {
  const body = JSON.stringify({ provider: entry.provider, endpoint: entry.path, input: {} });
  const call = [
    "tab_call with",
    `  service:   ${entry.serviceNamed ? entry.serviceName : entry.serviceId}`,
    `  tool:      ${entry.tool}`,
    ...(entry.assetAddress === undefined ? [] : [`  asset:     ${entry.chainId}:${entry.assetAddress}`]),
    `  path:      ${entry.hubPath}`,
    `  arguments: ${body}`,
  ].join("\n");
  const http = [
    `POST ${entry.endpoint.replace(/\/+$/, "")}${entry.hubPath}`,
    "content-type: application/json",
    "",
    body,
  ].join("\n");
  return {
    connect: "pnpm dlx @tabai/sdk connect",
    prompt: `Use tab_discover to find ${entry.serviceName}, then call ${entry.provider} ${entry.path} through it with tab_call.`,
    call,
    http,
  };
}
