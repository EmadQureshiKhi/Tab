/**
 * The Dashboard's reader for the registry API.
 *
 * ## Every route reads through here, and none of them holds a wallet
 *
 * R24.9 requires every read-only view to render with no connected wallet and no
 * injected provider. That is architectural rather than cosmetic: the figures a
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
 * Every call returns a `Result` (design section 13.1). A registry that is down,
 * a body that will not parse, and a 404 are three different answers a view must
 * render differently, so each comes back as a typed error rather than as an
 * exception that collapses them into one.
 *
 * `fetch` is described structurally for the same reason `packages/sdk` does it:
 * this package compiles against the ES2023 library with no DOM types, so the
 * host's global is reached through one documented cast behind a runtime check.
 *
 * Requirements: 24.1, 24.3, 24.4, 24.9
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

/** Where a row came from on Creditcoin. Carried on every row, so any of it is checkable. */
export interface Provenance {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly logIndex: number;
  readonly txHash: string;
  readonly txIndex: number;
  readonly blockTime: string | null;
}

/** One Verified Settlement, exactly as the read API serves it. */
export interface SettlementRow {
  readonly replayKey: string;
  /** Decimal text, because a chainKey is a `uint64` on the wire. */
  readonly chainKey: string;
  readonly sourceBlockHeight: string;
  readonly sourceTxIndex: string;
  readonly sourceLogIndex: string;
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: string;
  readonly payerAddress: string;
  readonly sourceTabId: string;
  readonly creditcoin: Provenance;
  /** Absent until a `SettlementApplied` for the same replay key is indexed. */
  readonly application?:
    | { readonly applied: string; readonly toPrepaid: string; readonly openAfter: string }
    | undefined;
}

export interface SettlementsPage {
  readonly index: IndexHorizon;
  readonly settlements: readonly SettlementRow[];
  readonly nextCursor: string | null;
}

/** One clearing state observed under a replay key, oldest first. */
export interface ClearingLineageEntry {
  readonly state: string;
  readonly creditcoin: Provenance;
  readonly amount?: string | undefined;
}

export interface SettlementDetail {
  readonly index: IndexHorizon;
  readonly settlement: SettlementRow;
  readonly clearing: {
    readonly state: string | null;
    readonly lineage: readonly ClearingLineageEntry[];
    readonly note: string;
  };
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

export interface BoundAddressRow {
  readonly agent: string;
  readonly chainKey: string;
  readonly ethAddress: string;
  readonly provingReplayKey: string;
  readonly creditcoin: Provenance;
}

export interface AgentDetail {
  readonly index: IndexHorizon;
  readonly agent: string;
  readonly assets: readonly AgentAssetRow[];
  readonly boundAddresses: readonly BoundAddressRow[];
}

export interface AgentSummaryRow {
  readonly agent: string;
  readonly settlementCount: number;
  readonly settledTotal: string;
  readonly assetCount: number;
  readonly creditcoin: Provenance;
}

export interface AgentsPage {
  readonly index: IndexHorizon;
  readonly agents: readonly AgentSummaryRow[];
  readonly nextCursor: string | null;
}

/** A value the registry serves, with the change that last wrote it. */
export interface ValueSource {
  readonly appliedBy: string;
  readonly creditcoin: Provenance;
}

/**
 * A change held inside the 48-hour timelock.
 *
 * Reported *beside* the applied value and never in place of it, which is R11.7:
 * the registry keeps serving the previous value for the whole hold, so a reader
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
 * The four figures are replayed from `Bond`'s own events and served only where
 * `Bond.ledgerOf` at the same block agrees on all four, so `crossCheck.agrees` is
 * the thing to read before trusting any of them.
 *
 * The `free` field was previously declared here as `freeBond`, which is not the
 * name on the wire. Nothing read it, so it never produced a wrong figure, but the
 * first view to use it would have got `undefined` and drawn an empty meter.
 */
export interface ServiceBondRow {
  readonly asset: string;
  readonly staked: string;
  readonly reserved: string;
  readonly slashed: string;
  readonly released: string;
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
    readonly chainKey: string;
    readonly tabCollection: string | null;
    readonly bondCollection: string | null;
  }[];
  readonly prices: readonly { readonly asset: string; readonly tool: string; readonly baseUnits: string }[];
  readonly bond: readonly ServiceBondRow[];
  readonly pendingChanges: readonly PendingChangeRow[];
  readonly registeredAt: Provenance;
}

export interface ServicesPage {
  readonly index: IndexHorizon;
  readonly services: readonly ServiceRow[];
  readonly nextCursor: string | null;
}

/** Filters `GET /settlements` accepts. Every one is optional and exact. */
export interface SettlementQuery {
  readonly chainKey?: string | number | undefined;
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
  settlement(replayKey: string): Promise<Result<SettlementDetail>>;
  agents(limit?: number, cursor?: string): Promise<Result<AgentsPage>>;
  agent(address: string): Promise<Result<AgentDetail>>;
  services(limit?: number): Promise<Result<ServicesPage>>;
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
  push("chainKey", query.chainKey);
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
    settlement: (replayKey) =>
      read<SettlementDetail>(
        `/settlements/${encodeURIComponent(replayKey)}`,
        notFound("SETTLEMENT_NOT_INDEXED", "no Verified Settlement is indexed under that replay key"),
      ),
    agents: (limit, cursor) =>
      read<AgentsPage>(
        `/agents${queryString({ ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) })}`,
      ),
    agent: (address) => read<AgentDetail>(`/agents/${encodeURIComponent(address)}`),
    services: (limit) =>
      read<ServicesPage>(`/services${limit === undefined ? "" : `?limit=${limit}`}`),
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
