/**
 * `IdentityCard` - one ERC-8004 agent whose owner or wallet is the address shown.
 *
 * ## Every fact says where it came from
 *
 * Three sources meet on this card and none of them is Tab's own contracts. The
 * agent id, the owner, the wallet and the block are the ERC-8004 Identity
 * registry's own events on Monad, folded by the index. The name, the description and the
 * services are whatever the registration file at the `agentURI` said, fetched
 * over HTTP at read time. The reputation summary is a live read of the
 * Reputation registry. A card that blended those would be asking a reader to
 * trust a self-published name as if it were a registry fact, so each block is
 * labelled with its source, and a block that could not be read says so in the
 * registry's words rather than going blank.
 *
 * ## Nothing here touches the Credit Limit
 *
 * An identity is context for a reader deciding whether an address is somebody's
 * registered agent. The Credit Limit is a pure function of applied Settlements
 * and never reads any of this, and the card does not suggest otherwise.
 *
 * This is a server component. It has no state and no clock.
 */

import { Badge } from "../ui/badge";
import { Link } from "../ui/link";
import { cn } from "../ui/cn";
import { formatInstantUtc } from "./format";

/** One service the registration file names. */
export interface IdentityCardService {
  readonly name: string;
  readonly endpoint: string | undefined;
}

/** The reputation summary, already reduced to text. */
export interface IdentityCardReputation {
  readonly count: string | undefined;
  readonly clientCount: string | undefined;
  readonly summary: string | undefined;
  readonly registry: string | undefined;
  readonly unavailable: string | undefined;
}

/** One agent, as the view model shapes it. Structural, so the composition layer supplies it. */
export interface IdentityCardAgent {
  readonly agentId: string;
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly owner: string;
  readonly agentWallet: string | undefined;
  readonly matchedBy: readonly ("owner" | "agentWallet")[];
  readonly agentURI: string | undefined;
  readonly agentURIShort: string | undefined;
  readonly agentURISource: string | undefined;
  readonly cardUnavailable: string | undefined;
  readonly cardFetchedAt: string | undefined;
  readonly services: readonly IdentityCardService[];
  readonly reputation: IdentityCardReputation;
  readonly registeredBlock: number | undefined;
}

export interface IdentityCardProps {
  readonly agent: IdentityCardAgent;
  /** The Identity registry contract, so the reader can see where the agent is minted. */
  readonly registry: string;
  /** The explorer link for that contract, built by the route from its context helpers. */
  readonly registryHref?: string | undefined;
  /** Leaves the reputation line out, for a page that gives reputation a section of its own. */
  readonly hideReputation?: boolean | undefined;
  readonly className?: string | undefined;
}

const LABEL = "font-mono text-[11px] tracking-wider text-muted-foreground uppercase";
const ROW = "flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4";
const VALUE = "min-w-0 font-mono text-xs break-all text-foreground";

/** Middle-truncated, with the full value in `title` so nothing is lost. */
function short(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

/** An ISO instant as `YYYY-MM-DD HH:MM UTC`, or the raw text where it will not parse. */
function readAt(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : formatInstantUtc(ms);
}

/** The reputation line: figures where they were read, the reason where they were not. */
function reputationText(reputation: IdentityCardReputation): string {
  if (reputation.unavailable !== undefined) return `not read: ${reputation.unavailable}`;
  const parts: string[] = [];
  if (reputation.summary !== undefined) parts.push(`mean ${reputation.summary}`);
  if (reputation.count !== undefined) {
    parts.push(`over ${reputation.count} ${reputation.count === "1" ? "entry" : "entries"}`);
  }
  if (reputation.clientCount !== undefined) {
    parts.push(`from ${reputation.clientCount} ${reputation.clientCount === "1" ? "client" : "clients"}`);
  }
  return parts.length === 0 ? "no summary was served" : parts.join(" ");
}

export function IdentityCard({ agent, registry, registryHref, hideReputation, className }: IdentityCardProps) {
  const headingId = `identity-${agent.agentId}`;
  const title = agent.name ?? `ERC-8004 agent #${agent.agentId}`;

  return (
    <article
      aria-labelledby={headingId}
      className={cn("flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/30 p-5", className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={LABEL}>ERC-8004 agent #{agent.agentId}</p>
          <h3 id={headingId} className="mt-1 font-host text-lg font-semibold break-words text-foreground">
            {title}
          </h3>
          {agent.name === undefined ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {agent.cardUnavailable === undefined
                ? "The registration file carries no name."
                : `Unnamed: the registration file could not be read (${agent.cardUnavailable}).`}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {agent.matchedBy.map((role) => (
            <Badge key={role} variant="outline" tone="neutral" title={`this address is the agent's ${role}`}>
              {role === "owner" ? "owner" : "agent wallet"}
            </Badge>
          ))}
        </div>
      </header>

      {agent.description === undefined ? null : (
        <p className="text-sm leading-relaxed text-muted-foreground">{agent.description}</p>
      )}

      <dl className="flex flex-col border-t border-border/60">
        <div className={ROW}>
          <dt className={LABEL}>Agent URI</dt>
          <dd className={VALUE}>
            {agent.agentURI === undefined ? (
              <span className="text-muted-foreground">none set on the registration</span>
            ) : (
              <>
                <span title={agent.agentURI}>{agent.agentURIShort ?? agent.agentURI}</span>
                {agent.agentURISource === undefined ? null : (
                  <span className="text-muted-foreground"> from {agent.agentURISource}</span>
                )}
              </>
            )}
          </dd>
        </div>
        <div className={cn(ROW, "border-t border-border/40")}>
          <dt className={LABEL}>Owner</dt>
          <dd className={VALUE} title={agent.owner}>
            {short(agent.owner)}
          </dd>
        </div>
        <div className={cn(ROW, "border-t border-border/40")}>
          <dt className={LABEL}>Agent wallet</dt>
          <dd className={VALUE} title={agent.agentWallet}>
            {agent.agentWallet === undefined ? (
              <span className="text-muted-foreground">none set</span>
            ) : (
              short(agent.agentWallet)
            )}
          </dd>
        </div>
        {hideReputation === true ? null : (
          <div className={cn(ROW, "border-t border-border/40")}>
            <dt className={LABEL}>Reputation</dt>
            <dd className={VALUE}>{reputationText(agent.reputation)}</dd>
          </div>
        )}
        <div className={cn(ROW, "border-t border-border/40")}>
          <dt className={LABEL}>Registered</dt>
          <dd className={VALUE}>
            {agent.registeredBlock === undefined ? (
              <span className="text-muted-foreground">before the index&apos;s start block, so the block is not known</span>
            ) : (
              `block ${agent.registeredBlock.toLocaleString("en-US")}`
            )}
          </dd>
        </div>
      </dl>

      {agent.services.length === 0 ? null : (
        <div className="border-t border-border/60 pt-3">
          <p className={LABEL}>Services, as the registration file lists them</p>
          <ul className="mt-2 flex flex-col gap-1">
            {agent.services.map((service) => (
              <li key={`${service.name}:${service.endpoint ?? ""}`} className="font-mono text-xs break-all text-foreground">
                {service.name}
                {service.endpoint === undefined ? null : (
                  <span className="text-muted-foreground"> {service.endpoint}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <footer className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border/60 pt-3">
        <span className="font-mono text-[11px] text-muted-foreground" title={agent.cardFetchedAt}>
          {agent.cardFetchedAt === undefined
            ? "Registration file not read"
            : `Registration file read ${readAt(agent.cardFetchedAt)}`}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          Identity registry{" "}
          {registryHref === undefined ? (
            <span title={registry}>{short(registry)}</span>
          ) : (
            <Link href={registryHref} external mono size="inherit" title={registry}>
              {short(registry)}
            </Link>
          )}
        </span>
      </footer>
    </article>
  );
}

export default IdentityCard;
