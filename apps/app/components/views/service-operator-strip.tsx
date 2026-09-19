/**
 * `ServiceOperatorStrip` - who runs a Service, and whether it takes x402.
 *
 * ## Beside the card, in one line each
 *
 * The directory card names the operator by address. This strip sits under it
 * and adds the two facts the address alone does not carry: the operator's
 * ERC-8004 identity, as the registry reports it, and whether the Service
 * offers x402 on a credit refusal, as the published directory declares it. Both
 * are one line, because a directory row is for scanning.
 *
 * ## An absence is written out
 *
 * "no ERC-8004 identity" and "identity not configured" are different answers
 * and both are printed, never left blank. A reader comparing operators should
 * not have to guess whether a missing name means the registry looked and found
 * nothing or never looked.
 *
 * This is a server component. It has no state and no clock.
 */

import { Badge } from "../ui/badge";
import { cn } from "../ui/cn";

export interface ServiceOperatorStripProps {
  /** The one-line identity, from `toIdentitySummary`. */
  readonly identity: { readonly text: string; readonly named: boolean };
  /** Why the identity could not be read, where the detail read failed. */
  readonly identityUnavailable?: string | undefined;
  /** True where the published directory says the Service offers x402 beside credit. */
  readonly x402: boolean;
  readonly className?: string | undefined;
}

/** The copy beside the x402 badge. Exported so the page and the test share one wording. */
export const X402_STRIP_COPY = "also payable per call with x402 when credit runs out";

export function ServiceOperatorStrip({ identity, identityUnavailable, x402, className }: ServiceOperatorStripProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-lg border border-border/60 bg-muted/30 px-5 py-3",
        className,
      )}
    >
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-mono text-xs">
        <span className="text-[11px] tracking-wider text-muted-foreground uppercase">Operator identity</span>
        {identityUnavailable === undefined ? (
          <span className={identity.named ? "text-foreground" : "text-muted-foreground"}>{identity.text}</span>
        ) : (
          <span className="text-muted-foreground">not read: {identityUnavailable}</span>
        )}
      </p>
      {x402 ? (
        <p className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" tone="notice" title="x402, the prepaid protocol, offered on a credit refusal">
            x402
          </Badge>
          <span className="text-xs text-muted-foreground">{X402_STRIP_COPY}</span>
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">credit only; no x402 offer is published</p>
      )}
    </div>
  );
}

export default ServiceOperatorStrip;
