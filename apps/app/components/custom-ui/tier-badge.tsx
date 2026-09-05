/**
 * `TierBadge` — the curation tier of a Service, or of an Asset.
 *
 * The Dashboard states the tier of every Service on every view that presents
 * that Service, and states for every Asset whether it belongs to the Curated
 * Tier. One badge serves both, because the fact being stated is the same fact.
 *
 * Three channels again, for the same reason as the clearing badge: the tier word
 * is always written, the icon differs in silhouette between the two tiers — a
 * shield against a globe — and the colour is a checked design token.
 *
 * The wording is the part worth guarding. A tier gates credit **weight**, not
 * recognition: a Permissionless Service is registered, metered, and paid in full,
 * and what its Verified Settlements do not do is add weight to an Agent's Credit
 * Limit. The accessible name says that in full, so a reader who cannot see the
 * colour is not left guessing whether Permissionless means second class.
 *
 * This is a server component. It has no state and no clock.
 *
 * Requirements: 11.8, 11.9, 24.10
 */

import { Badge } from "../ui/badge";
import { cn } from "../ui/cn";
import { GlobeIcon, ShieldCheckIcon } from "./icons";
import { tierAccessibleName, tierDescriptor, type ServiceTier, type TierSubject } from "./tier";

export interface TierBadgeProps {
  readonly tier: ServiceTier;
  /** What the tier is being stated about. Defaults to `Service`. */
  readonly subject?: TierSubject | undefined;
  /**
   * `solid` fills with the tier token, `outline` keeps the surface behind it, and
   * `muted` sits on the raised surface. All three are measured pairs.
   */
  readonly variant?: "solid" | "outline" | "muted" | undefined;
  readonly className?: string | undefined;
}

export function TierBadge({
  tier,
  subject = "Service",
  variant = "solid",
  className,
}: TierBadgeProps) {
  const descriptor = tierDescriptor(tier);
  const Icon = tier === "curated" ? ShieldCheckIcon : GlobeIcon;
  const accessibleName = tierAccessibleName(tier, subject);

  return (
    <Badge
      variant={variant}
      tone={descriptor.tone}
      role="img"
      aria-label={accessibleName}
      title={accessibleName}
      className={cn("gap-1.5 tracking-wide uppercase", className)}
    >
      <Icon />
      <span>{descriptor.label}</span>
    </Badge>
  );
}

export default TierBadge;
