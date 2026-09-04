/**
 * The Dashboard's framework-free core.
 *
 * Everything a route needs that is not JSX lives here: the chain toggle model,
 * the registry reader, the view models the composites take, and the
 * `/api/settlements` handler. None of it imports React and none of it imports a
 * framework, so all of it is testable in a plain Node test and portable to
 * whichever host serves the pages.
 *
 * Requirements: 24.1, 24.3, 24.4, 24.6, 24.9
 */

export {
  CHAIN_OPTIONS,
  CHAIN_QUERY_PARAM,
  CHAIN_STORAGE_KEY,
  DEFAULT_CHAIN_KEY,
  chainOptionFor,
  parseChainKeyParam,
  readStoredChainKey,
  withChainParam,
  writeStoredChainKey,
  type ChainNetwork,
  type ChainOption,
  type ChainStorage,
} from "./chains.js";

export {
  createRegistryClient,
  type AgentAssetRow,
  type AgentDetail,
  type AgentSummaryRow,
  type AgentsPage,
  type BoundAddressRow,
  type ClearingLineageEntry,
  type IndexHorizon,
  type Provenance,
  type RegistryClient,
  type RegistryClientOptions,
  type RegistryFetch,
  type RegistryResponse,
  type PendingChangeRow,
  type ServedFigure,
  type ServiceBondRow,
  type ServiceRow,
  type ServicesPage,
  type SettlementDetail,
  type SettlementQuery,
  type SettlementRow,
  type SettlementsPage,
  type ValueSource,
} from "./client.js";

export {
  DEFAULT_EXPLORER_URL,
  assetUnitFor,
  blockscoutTxUrl,
  clearingStateOf,
  serviceNameOf,
  toBigInt,
  toCreditView,
  toSettlementView,
  toSettlementViews,
  type AssetUnitView,
  type ClearingStateView,
  type CreditView,
  type SettlementView,
} from "./views.js";

export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parseLimit,
  serveSettlements,
  toResponse,
  type RouteResult,
  type SettlementsRouteOptions,
  type SettlementsRouteQuery,
} from "./api-settlements.js";
