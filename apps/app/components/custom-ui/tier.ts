/**
 * Curation tiers, as the Dashboard presents them.
 *
 * There are two tiers and they gate credit **weight**, not recognition. A
 * Permissionless Service is registered, metered, and paid exactly like any
 * other; what its Verified Settlements do not do is contribute weight to an
 * Agent's Credit Limit. Copy that implies a Permissionless Service is untrusted,
 * unpaid, or unlisted is wrong, so the wording below is the wording every view
 * uses.
 *
 * The same two descriptors serve a Service and an Asset, because the Dashboard
 * has to state the tier of each: the tier of every Service on every view that
 * presents it, and for every Asset whether it belongs to the Curated Tier.
 *
 * Colour is named as a `tone`, the vocabulary the badge primitive speaks, so
 * this table never writes a colour class. Both tier tokens are aliases —
 * `tier-curated` of the accent and `tier-permissionless` of the muted ink — so
 * the palette publishes no colour of its own for a tier, and the contrast gate
 * has already checked both against each surface and as a badge fill. The tier is
 * always spelled out in words as well, so it never rests on colour alone.
 *
 * Requirements: 11.8, 11.9, 24.10
 */

export const SERVICE_TIERS = ["permissionless", "curated"] as const;

export type ServiceTier = (typeof SERVICE_TIERS)[number];

/** What a tier is being stated about. */
export type TierSubject = "Service" | "Asset";

/** The badge tone each tier resolves to. These are the primitive's own names. */
export type TierTone = "curated" | "permissionless";

export interface TierDescriptor {
  readonly tier: ServiceTier;
  /** The word in the badge: `Curated`. */
  readonly label: string;
  /** The full name, for prose and accessible names: `Curated Tier`. */
  readonly fullLabel: string;
  readonly token: string;
  /** The tone the badge primitive draws this tier in. */
  readonly tone: TierTone;
  /** Whether Verified Settlements in this tier carry Credit Limit weight. */
  readonly carriesCreditWeight: boolean;
  /** One sentence stating what the tier does and does not gate. */
  readonly meaning: string;
}

const DESCRIPTORS: Readonly<Record<ServiceTier, TierDescriptor>> = {
  curated: {
    tier: "curated",
    label: "Curated",
    fullLabel: "Curated Tier",
    token: "tier-curated",
    tone: "curated",
    carriesCreditWeight: true,
    meaning:
      "Verified Settlements with this counterparty carry weight in Credit Limit computation, provided the Bond is posted in the settled Asset.",
  },
  permissionless: {
    tier: "permissionless",
    label: "Permissionless",
    fullLabel: "Permissionless Tier",
    token: "tier-permissionless",
    tone: "permissionless",
    carriesCreditWeight: false,
    meaning:
      "Metering and settlement work normally and the Service is paid in full. The tier gates credit weight only: Verified Settlements here carry a Credit Limit weight of zero.",
  },
};

/** The descriptor for a tier. Total over {@link ServiceTier}, so it cannot fail. */
export function tierDescriptor(tier: ServiceTier): TierDescriptor {
  return DESCRIPTORS[tier];
}

/** Both descriptors, Permissionless first, as the registry assigns them. */
export const TIER_DESCRIPTORS: readonly TierDescriptor[] = SERVICE_TIERS.map(
  (tier) => DESCRIPTORS[tier],
);

/** Runtime narrowing for a value that arrived from a read API. */
export function isServiceTier(value: unknown): value is ServiceTier {
  return typeof value === "string" && (SERVICE_TIERS as readonly string[]).includes(value);
}

/** The accessible name for a tier badge: state the subject, the tier, then what it gates. */
export function tierAccessibleName(tier: ServiceTier, subject: TierSubject): string {
  const descriptor = DESCRIPTORS[tier];
  return `${subject} curation tier: ${descriptor.fullLabel}. ${descriptor.meaning}`;
}
