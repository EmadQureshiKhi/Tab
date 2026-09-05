"use client";

/**
 * One Service, as a card rather than a list of terms.
 *
 * The old shape was a definition list of eight rows, which put the operator
 * address, the Settlement Window, the Assets and the prices at the same visual
 * weight and made a reader scan all eight to find any one. The four figures that
 * decide whether to use a Service are tiles now, the identity sits in the header
 * with the tier, and the Bond keeps its own panel because it is the only thing
 * here that is money at risk.
 *
 * The queued change is drawn as a notice rather than as another row. It is the one
 * fact on the card that is about the future, and a reader who misses it will be
 * surprised in 48 hours.
 */

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";

import { Badge } from "../ui/badge";
import { BondMeter } from "../custom-ui/bond-meter";
import type { BondAssetLedger } from "../custom-ui/bond";
import { TierBadge } from "../custom-ui/tier-badge";
import { cn } from "../ui/cn";

export interface ServiceFact {
  readonly label: string;
  readonly value: string;
  /** Shown under the value in a quieter voice. Omit where there is nothing to add. */
  readonly note?: string;
}

export interface ServicePendingChange {
  readonly changeId: string;
  readonly kindName: string;
  readonly summary: string;
  readonly etaIso: string | null;
}

export interface ServiceCardProps {
  readonly name: string;
  readonly serviceId: string;
  readonly operator: string;
  readonly tier: "curated" | "permissionless";
  readonly creditWeight: string;
  readonly facts: readonly ServiceFact[];
  readonly ledgers: readonly BondAssetLedger[];
  readonly pendingChanges: readonly ServicePendingChange[];
}

/** "in 2 days", "in 14 hours", or the instant itself once it has passed. */
function untilCopy(etaIso: string | null, nowMs: number | null): string {
  if (etaIso === null) return "at an unrecorded time";
  const eta = Date.parse(etaIso);
  if (Number.isNaN(eta)) return "at an unrecorded time";
  if (nowMs === null) return `from ${etaIso}`;
  const remaining = eta - nowMs;
  if (remaining <= 0) return "now, and may be applied by its authority";
  const hours = Math.floor(remaining / 3_600_000);
  if (hours >= 48) return `in ${Math.floor(hours / 24)} days`;
  if (hours >= 2) return `in ${hours} hours`;
  return `in ${Math.max(1, Math.floor(remaining / 60_000))} minutes`;
}

export function ServiceCard({
  name,
  serviceId,
  operator,
  tier,
  creditWeight,
  facts,
  ledgers,
  pendingChanges,
}: ServiceCardProps) {
  // The server has no clock, so the first frame states the instant and the
  // countdown appears on mount. That also keeps the two renders identical.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <article className="relative overflow-hidden rounded-lg border border-border/60 bg-muted/30">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 p-5 sm:p-6">
        <div className="min-w-0">
          <h2 className="font-host text-lg font-semibold text-foreground sm:text-xl">{name}</h2>
          <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground">{serviceId}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <TierBadge tier={tier} />
          <span className="font-mono text-[11px] text-muted-foreground">
            credit weight {creditWeight}
          </span>
        </div>
      </header>

      <div className="grid gap-px bg-border/60 sm:grid-cols-2 lg:grid-cols-4">
        {facts.map((fact) => (
          // The card under this already carries `bg-muted/30`, so a cell with
          // the same class applies the fill twice and the four figures read as a
          // pale band. `--panel` is that fill resolved to one opaque colour.
          <div key={fact.label} className="bg-[var(--panel)] p-5 sm:p-6">
            <p className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
              {fact.label}
            </p>
            <p className="mt-2 font-mono text-sm break-words text-foreground">{fact.value}</p>
            {fact.note === undefined ? null : (
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{fact.note}</p>
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-border/60 p-5 sm:p-6">
        <p className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
          Operator
        </p>
        <p className="mt-2 font-mono text-xs break-all text-foreground">{operator}</p>
      </div>

      <div className="border-t border-border/60 p-5 sm:p-6">
        {ledgers.length === 0 ? (
          <p className="font-mono text-xs leading-relaxed text-muted-foreground">
            No Bond has been created for this Service. Until stake exists its bond cap is zero, and
            a zero bond cap holds every Credit Limit at zero.
          </p>
        ) : (
          <BondMeter ledgers={ledgers} caption="Bond, by proven deposit" />
        )}
      </div>

      {pendingChanges.length === 0 ? null : (
        <div className="border-t border-border/60 bg-background/50 p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <Clock className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <h3 className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
              Queued, and not yet applied
            </h3>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            The registry keeps serving the values above for the whole 48-hour hold, so these are
            what will change, not what has changed.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {pendingChanges.map((change) => (
              <li key={change.changeId} className="flex flex-wrap items-center gap-3">
                <Badge variant="outline" tone="neutral">
                  {change.kindName}
                </Badge>
                <span className="font-mono text-xs text-foreground">{change.summary}</span>
                <span
                  className={cn("font-mono text-xs text-muted-foreground")}
                  title={change.etaIso ?? undefined}
                >
                  takes effect {untilCopy(change.etaIso, nowMs)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}
