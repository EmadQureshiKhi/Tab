/**
 * `IdentitySection` - the ERC-8004 identity of an address, or a stated absence.
 *
 * ## Three answers, kept apart
 *
 * The registry can say one of three things about an address: it holds these
 * agents, it holds none, or nothing was looked up because the deployment has no
 * Identity registry. A section that rendered the last two the same way would
 * let "not configured" pass for "not registered", which is the wrong thing to
 * tell a reader deciding whether an address is somebody's agent. So each
 * absence is its own sentence, and the empty one carries the basis the index
 * searched under, so a reader can see what "none" was measured against.
 *
 * This is a server component. It has no state and no clock.
 */

import { IdentityCard, type IdentityCardAgent } from "../custom-ui/identity-card";

/** The identity view, as the view model shapes it. Structural, so the composition layer supplies it. */
export interface IdentitySectionView {
  readonly configured: boolean;
  readonly registry: string | undefined;
  readonly basis: string | undefined;
  readonly agents: readonly IdentityCardAgent[];
  readonly statement: string;
}

export interface IdentitySectionProps {
  readonly identity: IdentitySectionView;
  /** Builds the explorer link for an address, from the route's context. */
  readonly explorerAddressHrefFor?: ((address: string) => string) | undefined;
  /** Leaves each card's reputation line out, where the page shows reputation in its own section. */
  readonly hideReputation?: boolean | undefined;
  readonly className?: string | undefined;
}

export function IdentitySection({ identity, explorerAddressHrefFor, hideReputation, className }: IdentitySectionProps) {
  if (identity.agents.length === 0 || identity.registry === undefined) {
    return (
      <div className={className}>
        <div className="rounded-lg border border-border/60 bg-muted/30 px-5 py-5">
          <p className="text-sm text-foreground">{identity.statement}</p>
          {identity.basis === undefined ? null : (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              <span className="font-mono tracking-wider uppercase">Basis </span>
              {identity.basis}
            </p>
          )}
        </div>
      </div>
    );
  }

  const registry = identity.registry;
  return (
    <div className={className}>
      <div className={identity.agents.length > 1 ? "grid gap-4 lg:grid-cols-2" : "grid gap-4"}>
        {identity.agents.map((agent) => (
          <IdentityCard
            key={agent.agentId}
            agent={agent}
            registry={registry}
            registryHref={explorerAddressHrefFor?.(registry)}
            hideReputation={hideReputation}
          />
        ))}
      </div>
      {identity.basis === undefined ? null : (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          <span className="font-mono tracking-wider uppercase">Basis </span>
          {identity.basis}
        </p>
      )}
    </div>
  );
}

export default IdentitySection;
