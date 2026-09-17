/**
 * The Dashboard composites.
 *
 * Eight components, each about one fact the rail asserts:
 *
 * - `SettlementCard` - one Settlement, its id, and the Monad transaction that
 *   both paid it and applied it
 * - `SettlementTimeline` - what a Settlement did, in the order the contracts
 *   did it, every row carrying its own amount
 * - `AssetAmount` - the numeric rule as a component: decimal units on screen,
 *   the exact base-unit integer in `title`
 * - `CreditGauge` - Credit Limit, Open Tab, and headroom for one Asset
 * - `TierBadge` - curation tier, stated as gating credit weight rather than
 *   recognition
 * - `BondMeter` - the escrowed Bond per Asset, with no pooled figure anywhere
 * - `IdentityCard` - one ERC-8004 agent, each block labelled with its source
 * - `LabelsStrip` - Nansen's labels, said to be an overlay and never a figure
 *
 * The shared rules they are built on are exported too, because routes need them
 * directly: the numeric rule in `format`, the tier vocabulary in `tier`, and the
 * Bond derivation in `bond`. Structure, focus, and class composition come from
 * `components/ui`, which is where a route should import a primitive from;
 * nothing is re-exported from there here.
 */

export { AssetAmount, type AssetAmountProps } from "./asset-amount";
export { BondMeter, type BondMeterProps } from "./bond-meter";
export { CopyButton } from "./copy-button";
export { CreditGauge, type CreditGaugeProps } from "./credit-gauge";
export {
  IdentityCard,
  type IdentityCardAgent,
  type IdentityCardProps,
  type IdentityCardReputation,
  type IdentityCardService,
} from "./identity-card";
export {
  LabelsStrip,
  type LabelsStripLabel,
  type LabelsStripProps,
  type LabelsStripView,
} from "./labels-strip";
export {
  SettlementCard,
  explorerTxHref,
  type SettlementCardProps,
  type SettlementView,
} from "./settlement-card";
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
  assetUnitFor,
  describeDeadline,
  formatAssetAmount,
  formatClockUtc,
  formatDurationShort,
  formatDurationSpoken,
  formatInstantUtc,
  registerAsset,
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
