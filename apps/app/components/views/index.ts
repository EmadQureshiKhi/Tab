/**
 * View components: the pieces a route assembles.
 *
 * These sit above `components/custom-ui` and below the routes. They know how a
 * page is laid out and nothing about where data came from, so every one of them
 * takes already-decoded props and none imports a client, a framework, or the
 * chain. That is what lets them be rendered in a plain Node test.
 *
 * Requirements: 24.4, 24.9
 */

export { ChainToggle, type ChainOptionView, type ChainToggleProps } from "./chain-toggle";
export { EmptyChain, type EmptyChainProps } from "./empty-chain";
export {
  SettlementTable,
  type SettlementRowView,
  type SettlementTableProps,
} from "./settlement-table";
