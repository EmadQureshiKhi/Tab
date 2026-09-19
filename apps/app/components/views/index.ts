/**
 * View components: the pieces a route assembles.
 *
 * These sit above `components/custom-ui` and below the routes. They know how a
 * page is laid out and nothing about where data came from, so every one of them
 * takes already-decoded props and none imports a client, a framework, or the
 * chain. That is what lets them be rendered in a plain Node test.
 */

export { CurationAuthority, type CurationAuthorityProps } from "./curation-authority";
export { EmptyChain, type EmptyChainProps } from "./empty-chain";
export { IdentitySection, type IdentitySectionProps, type IdentitySectionView } from "./identity-section";
export { OverdueTabs, type OverdueTabRowView, type OverdueTabsProps } from "./overdue-tabs";
export {
  ServiceOperatorStrip,
  X402_STRIP_COPY,
  type ServiceOperatorStripProps,
} from "./service-operator-strip";
export {
  SettlementTable,
  type SettlementRowView,
  type SettlementTableProps,
} from "./settlement-table";
export { SplitBar, type SplitBarProps } from "./split-bar";
export { SplitChart, type SplitChartProps } from "./split-chart";
