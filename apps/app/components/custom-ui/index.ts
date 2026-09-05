/**
 * The Dashboard composites.
 *
 * Six components, each about one fact the rail asserts:
 *
 * - `ProofCard` — one Verified Settlement and the replay-key coordinates that
 *   identify it
 * - `SettlementTimeline` — the clearing lineage, oldest first, every row labelled
 * - `ClearingBadge` — clearing state in three redundant channels, with a
 *   confirmation countdown that degrades honestly
 * - `CreditGauge` — Credit Limit, Open Tab, and headroom for one Asset
 * - `TierBadge` — curation tier, stated as gating credit weight rather than
 *   recognition
 * - `BondMeter` — the Bond ledger per Asset, with no pooled figure anywhere
 *
 * The shared rules they are built on are exported too, because routes need them
 * directly: the numeric rule in `format`, the clearing lifecycle in
 * `clearing-state`, the tier vocabulary in `tier`, and the Bond derivation in
 * `bond`. Structure, focus, and class composition come from `components/ui`,
 * which is where a route should import a primitive from; nothing is re-exported
 * from there here.
 *
 * Requirements: 15.7, 24.10, 11.8, 11.9
 */

export { AssetAmount, type AssetAmountProps } from "./asset-amount";
export { BondMeter, type BondMeterProps } from "./bond-meter";
export { ClearingBadge, type ClearingBadgeProps } from "./clearing-badge";
export { CreditGauge, type CreditGaugeProps } from "./credit-gauge";
export { ProofCard, type ProofCardProps, type VerifiedSettlementView } from "./proof-card";
export {
  SettlementTimeline,
  type SettlementTimelineEntry,
  type SettlementTimelineProps,
} from "./settlement-timeline";
export { TierBadge, type TierBadgeProps } from "./tier-badge";

export {
  bondSegments,
  derivedFreeBaseUnits,
  freeBaseUnits,
  isLedgerConsistent,
  type BondAssetLedger,
  type BondSegment,
} from "./bond";
export {
  CLEARING_STATES,
  CLEARING_STATE_DESCRIPTORS,
  clearingStateDescriptor,
  isClearingState,
  type ClearingState,
  type ClearingStateDescriptor,
  type ClearingTone,
} from "./clearing-state";
export {
  describeDeadline,
  formatAssetAmount,
  formatClockUtc,
  formatDurationShort,
  formatDurationSpoken,
  formatInstantUtc,
  shareOf,
  toAriaValue,
  toDateTimeAttribute,
  toDecimalUnits,
  type AssetUnit,
  type DeadlineDescription,
  type FormattedAmount,
} from "./format";
export {
  SERVICE_TIERS,
  TIER_DESCRIPTORS,
  isServiceTier,
  tierAccessibleName,
  tierDescriptor,
  type ServiceTier,
  type TierDescriptor,
  type TierSubject,
  type TierTone,
} from "./tier";
