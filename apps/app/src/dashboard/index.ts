/**
 * The Dashboard's framework-free core.
 *
 * Everything a route needs that is not JSX lives here: the chain toggle model,
 * the registry reader, the view models the composites take, and the
 * `/api/settlements` handler. None of it imports React and none of it imports a
 * framework, so all of it is testable in a plain Node test and portable to
 * whichever host serves the pages.
 */

export {
  DEFAULT_CHAIN_ID,
  explorerAddressUrl,
  explorerTxUrl,
  networkOptionFor,
  parseChainId,
  type ChainNetwork,
  type NetworkOption,
} from "./network.js";

export {
  createRegistryClient,
  type AgentAssetRow,
  type AgentDetail,
  type AgentSummaryRow,
  type AgentsPage,
  type DeliveriesPage,
  type DeliveryRow,
  type IdentityAgentRow,
  type IdentityRow,
  type IndexHorizon,
  type LabelRow,
  type LabelsRow,
  type Provenance,
  type RegistryClient,
  type RegistryClientOptions,
  type RegistryFetch,
  type RegistryResponse,
  type ReputationRow,
  type PendingChangeRow,
  type ServedFigure,
  type ServiceBondRow,
  type ServiceDetail,
  type ServiceRow,
  type ServicesPage,
  type SettlementDetail,
  type SettlementQuery,
  type SettlementRow,
  type SettlementsPage,
  type UnavailableReason,
  type ValueSource,
} from "./client.js";

export {
  DEFAULT_EXPLORER_URL,
  IDENTITY_NOT_SERVED_STATEMENT,
  IDENTITY_UNCONFIGURED_STATEMENT,
  LABELS_OFFCHAIN_STATEMENT,
  LABELS_UNCONFIGURED_STATEMENT,
  NO_IDENTITY_STATEMENT,
  assetUnitFor,
  fixedPointText,
  nameOrWord,
  registerAsset,
  serviceNameOf,
  shortenUri,
  toBigInt,
  toCreditView,
  toIdentitySummary,
  toIdentityView,
  toLabelsView,
  toSettlementView,
  toSettlementViews,
  type AssetUnitView,
  type CreditView,
  type IdentityAgentView,
  type IdentityServiceView,
  type IdentitySummary,
  type IdentityView,
  type LabelView,
  type LabelsView,
  type ReputationView,
  type SettlementView,
} from "./views.js";

export {
  offersX402,
  parsePublishedDirectory,
  recipeFor,
  toCatalogue,
  type CatalogueEntry,
  type PublishedHub,
  type PublishedService,
  type PublishedX402,
  type RunRecipe,
} from "./catalogue.js";

export {
  hubRecipeFor,
  toHubEntries,
  withMargin,
  type HubEndpointInput,
  type HubEntry,
  type HubManifestOutcome,
  type HubNote,
  type HubRecipe,
} from "./hub.js";

export { publishedDirectoryPath, readPublishedDirectory } from "./published.js";

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
