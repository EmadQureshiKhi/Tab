/**
 * `@tabai/sdk/settle`: settling a tab, and deciding when to, with nothing else.
 *
 * The package root also carries the `tab.config` walk, which reads the
 * filesystem; a host that bundles its server code (the Dashboard does) must not
 * pull that in, and hiding it from the bundler also hides it from the host's
 * file tracing. This entry exports only the direct Monad strategy, which needs
 * a signer and nothing else, and the auto-settle policy, which needs nothing.
 */

export { createMonadStrategy, MONAD_STRATEGY_ID, type MonadStrategyConfig } from "./monad.js";
export type { AssetRef, PaymentStrategy, SettleRequest, SettlementReceipt } from "./strategy.js";
export {
  decideAutoSettle,
  parseAutoSettleAt,
  type AutoSettleDecision,
  type AutoSettlePolicy,
  type AutoSettleReason,
  type AutoSettleState,
} from "./auto-settle.js";
