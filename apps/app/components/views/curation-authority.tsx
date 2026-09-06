/**
 * Who holds the one privileged role on this deployment.
 *
 * ## Why this is on the page rather than only in the threat model
 *
 * The tier badge on every card below is set by this role. A reader looking at
 * "Curated" and wondering who decided that should not have to go and find
 * another document, so the answer sits above the cards it explains.
 *
 * ## Why the multisig is named as what it is
 *
 * It is deployed and it is real, and it holds nothing today. `ServiceRegistry`
 * takes its authority as a constructor argument and exposes no setter, so the
 * role can only move at a deployment. Saying the multisig holds it now would be
 * false and checkable in seconds; saying it takes the role at the next
 * deployment is true, and the immutability is the part actually worth knowing -
 * the role cannot be moved quietly, by this project or by anyone.
 *
 * Both addresses are passed in rather than read here. Every other view in this
 * folder is pure and compiles without node types, and the route already reads the
 * environment for the rest of what it renders.
 *
 * Requirements: 24.3, 11.8
 */

import { Link } from "../ui/link";

export interface CurationAuthorityProps {
  /** The address the registry checks today, or undefined where none is configured. */
  readonly authority: string | undefined;
  /** The multisig that takes the role at the next deployment, if one is deployed. */
  readonly multisig: string | undefined;
  readonly explorerBaseUrl?: string | undefined;
}

export function CurationAuthority({ authority, multisig, explorerBaseUrl }: CurationAuthorityProps) {
  if (authority === undefined) return null;

  const link = (value: string) =>
    explorerBaseUrl === undefined ? undefined : `${explorerBaseUrl}/address/${value}`;

  return (
    <aside className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/30 p-5">
      <p className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
        Who sets a tier
      </p>

      <dl className="flex flex-col">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border/50 py-2">
          <dt className="font-mono text-xs text-muted-foreground">Curation authority</dt>
          <dd className="min-w-0 font-mono text-xs break-all text-foreground">
            {link(authority) === undefined ? (
              authority
            ) : (
              <Link href={link(authority) as string} external mono size="xs">
                {authority}
              </Link>
            )}
          </dd>
        </div>
        {multisig === undefined ? null : (
          <div className="flex flex-wrap items-baseline justify-between gap-3 py-2">
            <dt className="font-mono text-xs text-muted-foreground">
              Multisig, from the next deployment
            </dt>
            <dd className="min-w-0 font-mono text-xs break-all text-foreground">
              {link(multisig) === undefined ? (
                multisig
              ) : (
                <Link href={link(multisig) as string} external mono size="xs">
                  {multisig}
                </Link>
              )}
            </dd>
          </div>
        )}
      </dl>

      <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
        A tier decides Credit Limit weight and nothing else. The authority has no power over
        metering, over any tab, or over any Bond, and every change it makes is queued and held for 48
        hours in public before it can apply.
        {multisig === undefined
          ? ""
          : " A 2-of-3 multisig is deployed and takes this role at the next deployment of the registry."}{" "}
        It can only change at a deployment: the authority is a constructor argument with no setter,
        so the role cannot be reassigned on a live registry.
      </p>
    </aside>
  );
}
