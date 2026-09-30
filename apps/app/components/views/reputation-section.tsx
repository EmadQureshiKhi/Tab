/**
 * `ReputationSection` - what the ERC-8004 Reputation registry holds about an
 * Agent, from Tab Services and from everyone.
 *
 * ## Two figures, kept apart
 *
 * A Tab Service writes one entry after each Settlement it receives, so the Tab
 * figure is a count of Settlements restated where any ERC-8004 reader can find
 * it. Anyone else may write feedback too, under any tags, and that is the
 * second figure. Blending them would let a stranger's rating pass for a
 * Service's record of being paid, so each has its own row and its own words.
 *
 * ## Absence is a sentence
 *
 * Feedback is written against an agentId, so an address with no ERC-8004
 * identity has nothing to read, and a deployment with no Identity registry
 * could not look. Each says so. An agent with no entries says "No feedback
 * yet" rather than a zero dressed as a score.
 *
 * ## Nothing here touches the Credit Limit
 *
 * The section says so in one sentence on every render where there is a figure.
 *
 * This is a server component. It has no state and no clock.
 */

import { Link } from "../ui/link";
import { cn } from "../ui/cn";

/** One figure, already reduced to text. Structural, so the composition layer supplies it. */
export interface ReputationSectionFigure {
  readonly text: string;
  readonly hasFeedback: boolean;
}

export interface ReputationSectionAgent {
  readonly agentId: string;
  readonly fromTab: ReputationSectionFigure;
  readonly fromAll: ReputationSectionFigure;
  readonly registry: string | undefined;
}

export interface ReputationSectionView {
  readonly agents: readonly ReputationSectionAgent[];
  readonly statement: string;
  readonly basis: string | undefined;
}

export interface ReputationSectionProps {
  readonly reputation: ReputationSectionView;
  /** What the Tab figure is and is not. Supplied so the page and the test share the wording. */
  readonly derivedStatement: string;
  /** Builds the explorer link for an address, from the route's context. */
  readonly explorerAddressHrefFor?: ((address: string) => string) | undefined;
  readonly className?: string | undefined;
}

const LABEL = "font-mono text-[11px] tracking-wider text-muted-foreground uppercase";
const ROW = "flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4";
const VALUE = "min-w-0 font-mono text-xs break-words sm:text-right";

/** Middle-truncated, with the full value in `title` so nothing is lost. */
function short(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function Figure({ figure }: { readonly figure: ReputationSectionFigure }) {
  return <dd className={cn(VALUE, figure.hasFeedback ? "text-foreground" : "text-muted-foreground")}>{figure.text}</dd>;
}

export function ReputationSection({ reputation, derivedStatement, explorerAddressHrefFor, className }: ReputationSectionProps) {
  if (reputation.agents.length === 0) {
    return (
      <div className={className}>
        <div className="rounded-lg border border-border/60 bg-muted/30 px-5 py-5">
          <p className="text-sm text-foreground">{reputation.statement}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className={reputation.agents.length > 1 ? "grid gap-4 lg:grid-cols-2" : "grid gap-4"}>
        {reputation.agents.map((agent) => {
          const href = agent.registry === undefined ? undefined : explorerAddressHrefFor?.(agent.registry);
          return (
            <article
              key={agent.agentId}
              aria-label={`Reputation of ERC-8004 agent #${agent.agentId}`}
              className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/30 p-5"
            >
              <p className={LABEL}>ERC-8004 agent #{agent.agentId}</p>
              <dl className="flex flex-col border-t border-border/60">
                <div className={ROW}>
                  <dt className={LABEL}>From Tab Services</dt>
                  <Figure figure={agent.fromTab} />
                </div>
                <div className={cn(ROW, "border-t border-border/40")}>
                  <dt className={LABEL}>From all clients</dt>
                  <Figure figure={agent.fromAll} />
                </div>
              </dl>
              {agent.registry === undefined ? null : (
                <footer className="flex justify-end border-t border-border/60 pt-3">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    Reputation registry{" "}
                    {href === undefined ? (
                      <span title={agent.registry}>{short(agent.registry)}</span>
                    ) : (
                      <Link href={href} external mono size="inherit" title={agent.registry}>
                        {short(agent.registry)}
                      </Link>
                    )}
                  </span>
                </footer>
              )}
            </article>
          );
        })}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{derivedStatement}</p>
      {reputation.basis === undefined ? null : (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          <span className="font-mono tracking-wider uppercase">Basis </span>
          {reputation.basis}
        </p>
      )}
    </div>
  );
}

export default ReputationSection;
