/**
 * The Dashboard's reader for the registry API.
 *
 * ## Every route reads through here, and none of them holds a wallet
 *
 * Every read-only view renders with no connected wallet and no injected
 * provider. That is architectural rather than cosmetic: the figures a
 * reader sees come from the indexed read API and from the chain, never from an
 * account. Nothing in this module knows what a signer is, and there is no code
 * path by which a route could acquire one.
 *
 * ## Amounts stay strings the whole way
 *
 * The read API casts every `numeric` column and every `uint64` coordinate to
 * text precisely so a settled amount cannot lose precision in transit, and this
 * client keeps that discipline: a field that arrives as a decimal string is
 * carried as a string and converted to `bigint` only where a component needs
 * arithmetic. Nothing here parses a money field into a `number`.
 *
 * ## Nothing throws
 *
 * Every call returns a `Result` from `@tabai/shared`. A registry that is down,
 * a body that will not parse, and a 404 are three different answers a view must
 * render differently, so each comes back as a typed error rather than as an
 * exception that collapses them into one.
 *
 * `fetch` is described structurally for the same reason `packages/sdk` does it:
 * this package compiles against the ES2023 library with no DOM types, so the
 * host's global is reached through one documented cast behind a runtime check.
 */

import { err, ok, type Result, type TabError } from "@tabai/shared";

/** The little of a response this client reads. */
export interface RegistryResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

/** The `fetch` this client calls. The host's global is the default. */
export type RegistryFetch = (url: string) => Promise<RegistryResponse>;

export interface RegistryClientOptions {
  /** Absolute base URL of the registry read API. */
  readonly baseUrl: string;
  readonly fetchImpl?: RegistryFetch;
}

/** How far the index has read. Every response carries it, so no answer is horizonless. */
export interface IndexHorizon {
  readonly stream: string;
  readonly lastBlock: number | null;
  readonly lastBlockHash: string | null;
  readonly reorgCount: number;
  readonly updatedAt: string | null;
}

/** Where a row came from on Monad. Carried on every row, so any of it is checkable. */
export interface Provenance {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly logIndex: number;
  readonly txHash: string;
  readonly txIndex: number;
  readonly blockTime: string | null;
}

/**
 * One Settlement, exactly as the read API serves it.
 *
 * `settlementId` is the identity `TabBook` assigned when it applied the
 * Settlement, and `monad` is the transaction that paid it: `TabSettlement`
 * moved the Asset and `TabBook` applied it in the same transaction, so one row
 * describes both halves.
 */
export interface SettlementRow {
  readonly settlementId: string;
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: string;
  readonly applied: string;
  readonly toPrepaid: string;
  readonly collection: string;
  readonly openAfter: string | null;
  readonly monad: Provenance;
}

export interface SettlementsPage {
  readonly index: IndexHorizon;
  readonly settlements: readonly SettlementRow[];
  readonly nextCursor: string | null;
}

/** One Metered Delivery, exactly as the read API serves it. */
export interface DeliveryRow {
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly tool: string;
  readonly units: number;
  readonly amount: string;
  readonly timestamp: number;
  readonly monad: Provenance;
}

export interface DeliveriesPage {
  readonly index: IndexHorizon;
  readonly deliveries: readonly DeliveryRow[];
  readonly nextCursor: string | null;
}

export interface SettlementDetail {
  readonly index: IndexHorizon;
  readonly settlement: SettlementRow;
}

/** A figure the index can serve, or a stated reason it cannot. */
export interface ServedFigure {
  readonly value: string | null;
  readonly basis?: string | undefined;
  readonly unavailable?: { readonly code: string; readonly message: string } | undefined;
  readonly crossCheck?:
    | { readonly read: string; readonly onChain: string; readonly agrees: boolean }
    | undefined;
  readonly computedAt?: { readonly blockNumber: number } | undefined;
}

export interface AgentAssetRow {
  readonly asset: string;
  readonly creditLimit: ServedFigure;
  readonly headroom: ServedFigure;
  readonly openTab: { readonly observed: string; readonly basis: string; readonly liveRead: string };
  readonly delinquency: { readonly delinquent: boolean; readonly openCount: number };
  readonly settlements:
    | {
        readonly settlementCount: number;
        readonly settledTotal: string;
        readonly appliedTotal: string;
        readonly prepaidTotal: string;
      }
    | null;
}

/** A stated reason a block of the response carries no answer. */
export interface UnavailableReason {
  readonly code: string;
  readonly message: string;
}

/**
 * The reputation summary for one ERC-8004 agent, read live from the Reputation
 * registry, or withheld with the reason named.
 *
 * `summaryValue` is a fixed-point decimal as text with `summaryValueDecimals`
 * decimals. It is text on the wire and stays text here; nothing below parses it
 * into a float.
 */
export interface ReputationRow {
  readonly registry: string | null;
  readonly count: number | null;
  readonly clientCount: number | null;
  readonly summaryValue: string | null;
  readonly summaryValueDecimals: number | null;
  readonly basis: string;
  readonly unavailable: UnavailableReason | null;
}

/**
 * One ERC-8004 agent whose owner or `agentWallet` is the address asked about.
 *
 * `card` is the registration file the `agentURI` resolves to, as whatever JSON
 * it was: the registry proves the URI belongs to the agent and reports what was
 * found there without validating it. The view model reads the few fields it
 * shows and leaves the rest.
 */
export interface IdentityAgentRow {
  readonly agentId: string;
  readonly owner: string;
  readonly agentWallet: string | null;
  /** Which of the two keys matched the address asked about. */
  readonly matchedBy: readonly ("owner" | "agentWallet")[];
  readonly agentURI: string | null;
  /** Where the URI came from: the index, or a live `tokenURI` read when the index had none. */
  readonly agentURISource: "index" | "chain" | null;
  readonly card: unknown;
  readonly cardUnavailable: UnavailableReason | null;
  readonly cardFetchedAt: string | null;
  readonly reputation: ReputationRow;
  readonly blocks: {
    readonly registered: number | null;
    readonly owner: number;
    readonly uri: number | null;
    readonly wallet: number | null;
  };
}

/**
 * The ERC-8004 identity view of one address, as the registry serves it.
 *
 * `null` on the wire means the Identity registry is switched off for this
 * deployment. An address with no agent is `{ agents: [] }` under the stated
 * basis: the index looked and found none, which is an answer.
 */
export interface IdentityRow {
  readonly registry: string;
  readonly basis: string;
  readonly agents: readonly IdentityAgentRow[];
}

/** One Nansen label. `kind` is served as a list; a single word is tolerated. */
export interface LabelRow {
  readonly label: string;
  readonly category?: string | undefined;
  readonly kind?: string | readonly string[] | undefined;
}

/**
 * Nansen's view of an address, an off-chain overlay with a named source.
 *
 * An empty `labels` list is served only when Nansen answered and had nothing to
 * say. An unanswered question arrives as `unavailable`, and `NANSEN_KEY_MISSING`
 * is the normal state of a deployment that configured no key.
 */
export type LabelsRow =
  | {
      readonly source: "nansen";
      readonly chain: string;
      readonly fetchedAt: string;
      readonly labels: readonly LabelRow[];
      readonly entity?: string | undefined;
    }
  | {
      readonly source: "nansen";
      readonly unavailable: UnavailableReason;
    };

export interface AgentDetail {
  readonly index: IndexHorizon;
  readonly agent: string;
  readonly assets: readonly AgentAssetRow[];
  /**
   * The Agent's ERC-8004 identity, `null` where the registry is not configured.
   * Absent altogether from a registry older than the identity read.
   */
  readonly identity?: IdentityRow | null | undefined;
  /** Nansen labels, or the stated reason there are none. Absent from an older registry. */
  readonly labels?: LabelsRow | undefined;
}

export interface AgentSummaryRow {
  readonly agent: string;
  readonly settlementCount: number;
  readonly settledTotal: string;
  readonly assetCount: number;
  readonly monad: Provenance;
}

export interface AgentsPage {
  readonly index: IndexHorizon;
  readonly agents: readonly AgentSummaryRow[];
  readonly nextCursor: string | null;
}

/** A value the registry serves, with the change that last wrote it. */
export interface ValueSource {
  readonly appliedBy: string;
  readonly monad: Provenance;
}

/**
 * A change held inside the 48-hour timelock.
 *
 * Reported *beside* the applied value and never in place of it: the registry
 * keeps serving the previous value for the whole hold, so a reader
 * shown the queued figure as current would be reading a price the chain does not
 * charge.
 */
export interface PendingChangeRow {
  readonly changeId: string;
  readonly kind: number;
  readonly kindName: string;
  readonly eta: number | null;
  readonly etaIso: string | null;
  readonly payload: string;
  readonly decoded: Readonly<Record<string, string>> | null;
  readonly queuedAt: Provenance;
}

/**
 * One Service's Bond ledger in one Asset.
 *
 * The two stored figures are summed from `Bond`'s own events and served only
 * where `Bond.ledgerOf` at the same block agrees on both, so `crossCheck.agrees`
 * is the thing to read before trusting either. `free` is staked less withdrawn,
 * which is the escrowed amount `TabBook` reads when it caps a Credit Limit.
 */
export interface ServiceBondRow {
  readonly asset: string;
  readonly staked: string;
  readonly withdrawn: string;
  readonly free: string;
  readonly computedAt?: { readonly blockNumber: number } | undefined;
  readonly crossCheck?:
    | {
        readonly read: string;
        readonly onChain: Readonly<Record<string, string>>;
        readonly agrees: boolean;
      }
    | undefined;
  readonly unavailable?: { readonly code: string; readonly message: string } | null | undefined;
}

export interface ServiceRow {
  readonly serviceId: string;
  readonly operator: string;
  readonly tier: {
    readonly value: number;
    readonly name: string;
    readonly creditWeight: string;
    readonly source: ValueSource;
  };
  readonly settlementWindowSeconds: { readonly value: number; readonly source: ValueSource };
  readonly acceptedAssets: readonly {
    readonly asset: string;
    /** Where a Settlement in this Asset is paid to. */
    readonly collection: string;
  }[];
  readonly prices: readonly { readonly asset: string; readonly tool: string; readonly baseUnits: string }[];
  readonly bond: readonly ServiceBondRow[];
  readonly pendingChanges: readonly PendingChangeRow[];
  readonly registeredAt: Provenance;
  /**
   * The operator's ERC-8004 identity, on the detail read only.
   *
   * The registry serves it on `GET /services/:id` and not on the page, because
   * a page of fifty Services would be fifty card fetches and a hundred chain
   * reads for a listing nobody reads a card off. A row from `services()` leaves
   * this absent; a row from `service()` carries it, `null` where the Identity
   * registry is not configured.
   */
  readonly identity?: IdentityRow | null | undefined;
}

export interface ServicesPage {
  readonly index: IndexHorizon;
  readonly services: readonly ServiceRow[];
  readonly nextCursor: string | null;
}

/** One Service, with the operator's identity folded onto the row. */
export interface ServiceDetail {
  readonly index: IndexHorizon;
  readonly service: ServiceRow;
}

/** Filters `GET /settlements` accepts. Every one is optional and exact. */
export interface SettlementQuery {
  readonly agent?: string | undefined;
  readonly serviceId?: string | undefined;
  readonly asset?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/**
 * What the registry's own `/healthz` says, reduced to what is safe to republish.
 *
 * The registry reports more than this - its whole indexer status object and its
 * build info - and `/api/health` deliberately republishes only the two fields a
 * public reader can act on. Passing the rest through would put the registry's
 * internals on an unauthenticated surface for no reader benefit.
 */
export interface RegistryHealth {
  readonly status: string;
  readonly lastBlock: number | null;
}

/** Settled volume in one Asset, split by whether the credited Agent is ours. */
export interface AdoptionVolumeRow {
  readonly asset: string;
  readonly externalBaseUnits: string;
  readonly internalBaseUnits: string;
  readonly totalBaseUnits: string;
}

/**
 * The adoption figures, as `/adoption` serves them.
 *
 * `allowlist.path` is deliberately **not** carried across. The registry reports the
 * absolute filesystem path it read the allowlist from, which is useful to an
 * operator reading that service directly and is a server path on a public page. The
 * count is republished, because "seven addresses are classified as ours" is the
 * part a reader needs to judge the split.
 */
export interface AdoptionMetrics {
  readonly index: IndexHorizon;
  readonly externalAgentCount: number;
  readonly internalAgentCount: number;
  readonly externalSettlementCount: number;
  readonly internalSettlementCount: number;
  readonly volumeByAsset: readonly AdoptionVolumeRow[];
  /** Lower bounds, not totals: `DeliveryRecorded` is not indexed. */
  readonly externalDeliveryLowerBound: number;
  readonly internalDeliveryLowerBound: number;
  /** How each figure above was arrived at, in the registry's own words. */
  readonly basis: Readonly<Record<string, string>>;
  readonly allowlistInternalCount: number;
}

export interface RegistryClient {
  settlements(query?: SettlementQuery): Promise<Result<SettlementsPage>>;
  /** Metered deliveries, newest first. The same filters and cursor as the settlement feed. */
  deliveries(query?: SettlementQuery): Promise<Result<DeliveriesPage>>;
  settlement(settlementId: string): Promise<Result<SettlementDetail>>;
  agents(limit?: number, cursor?: string): Promise<Result<AgentsPage>>;
  agent(address: string): Promise<Result<AgentDetail>>;
  services(limit?: number): Promise<Result<ServicesPage>>;
  /** One Service by its 32-byte key, with the operator's identity on the row. */
  service(serviceId: string): Promise<Result<ServiceDetail>>;
  /** Liveness of the read API itself, for `/api/health`. */
  health(): Promise<Result<RegistryHealth>>;
  /** Adoption figures, for `/analytics`. Absent where the allowlist could not be read. */
  adoption(): Promise<Result<AdoptionMetrics>>;
}

const upstream = (code: string, message: string, cause?: unknown): TabError => ({
  category: "UPSTREAM",
  code,
  message,
  retryable: true,
  ...(cause === undefined
    ? {}
    : { cause: { code: "Error", message: cause instanceof Error ? cause.message : String(cause) } }),
});

const notFound = (code: string, message: string): TabError => ({
  category: "NOT_FOUND",
  code,
  message,
  retryable: false,
});

/** The host's global `fetch`, or undefined where the runtime has none. */
function hostFetch(): RegistryFetch | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== "function") return undefined;
  return candidate as RegistryFetch;
}

function queryString(query: SettlementQuery): string {
  const parts: string[] = [];
  const push = (key: string, value: string | number | undefined): void => {
    if (value === undefined) return;
    parts.push(`${key}=${encodeURIComponent(String(value))}`);
  };
  push("agent", query.agent);
  push("serviceId", query.serviceId);
  push("asset", query.asset);
  push("limit", query.limit);
  push("cursor", query.cursor);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/**
 * Builds the reader.
 *
 * Construction cannot fail and returns a client rather than a `Result`: an
 * unusable base URL is reported by the call that needs it, which is the only
 * place a view can act on it. The same shape the SDK's two factories take.
 */
export function createRegistryClient(options: RegistryClientOptions): RegistryClient {
  const base = options.baseUrl.replace(/\/+$/, "");

  const read = async <T>(path: string, missing?: TabError): Promise<Result<T>> => {
    const send = options.fetchImpl ?? hostFetch();
    if (send === undefined) {
      return err(
        upstream("FETCH_UNAVAILABLE", "this host has no global fetch, so the registry cannot be read"),
      );
    }
    if (base.length === 0) {
      return err({
        category: "VALIDATION",
        code: "REGISTRY_BASE_URL_MISSING",
        message: "NEXT_PUBLIC_REGISTRY_API_URL is empty, so there is no registry to read",
        retryable: false,
      });
    }

    let response: RegistryResponse;
    try {
      response = await send(`${base}${path}`);
    } catch (cause) {
      return err(upstream("REGISTRY_UNREACHABLE", `the registry did not answer ${path}`, cause));
    }

    if (response.status === 404 && missing !== undefined) return err(missing);
    if (response.status >= 400) {
      return err(
        upstream("REGISTRY_REFUSED", `the registry answered ${response.status} for ${path}`),
      );
    }

    try {
      return ok((await response.json()) as T);
    } catch (cause) {
      return err(upstream("REGISTRY_UNPARSEABLE", `the registry body for ${path} is not JSON`, cause));
    }
  };

  return {
    settlements: (query = {}) => read<SettlementsPage>(`/settlements${queryString(query)}`),
    deliveries: (query = {}) => read<DeliveriesPage>(`/deliveries${queryString(query)}`),
    settlement: (settlementId) =>
      read<SettlementDetail>(
        `/settlements/${encodeURIComponent(settlementId)}`,
        notFound("SETTLEMENT_NOT_INDEXED", "no Settlement is indexed under that id"),
      ),
    agents: (limit, cursor) =>
      read<AgentsPage>(
        `/agents${queryString({ ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) })}`,
      ),
    agent: (address) => read<AgentDetail>(`/agents/${encodeURIComponent(address)}`),
    services: (limit) =>
      read<ServicesPage>(`/services${limit === undefined ? "" : `?limit=${limit}`}`),
    service: async (serviceId): Promise<Result<ServiceDetail>> => {
      const body = await read<{
        index: IndexHorizon;
        service: ServiceRow;
        identity?: IdentityRow | null | undefined;
      }>(
        `/services/${encodeURIComponent(serviceId)}`,
        notFound("SERVICE_NOT_REGISTERED", "no Service is registered under that id"),
      );
      if (!body.ok) return body;
      // The registry serves identity beside the row; the row is the unit every
      // view takes, so it is folded on here and nowhere else. An older registry
      // that serves no block at all leaves it absent, which the view model
      // states as "not served" rather than as "none registered".
      const { identity, ...detail } = body.value;
      return ok({
        index: detail.index,
        service: identity === undefined ? detail.service : { ...detail.service, identity },
      });
    },
    adoption: async (): Promise<Result<AdoptionMetrics>> => {
      const body = await read<
        Omit<AdoptionMetrics, "allowlistInternalCount"> & {
          allowlist?: { internalCount?: unknown; path?: unknown };
        }
      >(
        "/adoption",
        notFound(
          "ADOPTION_UNAVAILABLE",
          "the registry is not serving /adoption, which it declines to do when it could not read the internal-address allowlist",
        ),
      );
      if (!body.ok) return body;
      const count = body.value.allowlist?.internalCount;
      // Destructured so `allowlist` cannot travel any further. It carries the
      // server path the registry read, which has no place on a public page.
      const { allowlist: _discarded, ...metrics } = body.value;
      return ok({
        ...metrics,
        allowlistInternalCount: typeof count === "number" ? count : 0,
      });
    },
    health: async (): Promise<Result<RegistryHealth>> => {
      const body = await read<{ status?: unknown; indexer?: { lastBlock?: unknown } }>("/healthz");
      if (!body.ok) return body;
      // The registry answers 200 whenever the process is up, even mid-catch-up and
      // even with its database unreachable, and it says which of those it is in
      // `status`. That word is passed through rather than collapsed to a boolean,
      // because "up but degraded" is the answer an operator most needs to see.
      const status = typeof body.value.status === "string" ? body.value.status : "unknown";
      const lastBlock = body.value.indexer?.lastBlock;
      return ok({
        status,
        lastBlock: typeof lastBlock === "number" ? lastBlock : null,
      });
    },
  };
}
