/**
 * Who holds the one privileged role on this deployment.
 *
 * ## Why this is on the page rather than only in the threat model
 *
 * The tier badge on every card below is set by this role. A reader looking at
 * "Curated" and wondering who decided that should not have to go and find
 * another document, so the answer sits above the cards it explains.
 *
 * ## What the authority is, rather than what it was expected to be
 *
 * `ServiceRegistry` takes one address as its authority and never looks at what
 * sits there, so the only honest way to describe it is to ask. The route reads
 * the address for `THRESHOLD()` and `owners()`: a `CurationMultisig` answers
 * both and is drawn as the multisig it is, with the threshold and the owners it
 * actually holds; anything else is drawn as the account it is. Asserting it
 * from one deployment instead would be wrong on the next, since a deployment may
 * put a multisig in the role from its first block.
 *
 * What does not change either way is the part worth knowing: the authority is a
 * constructor argument with no setter, so the role cannot be reassigned on a
 * live registry, by this project or by anyone.
 *
 * The view is passed in rather than read here. Every other view in this folder
 * is pure and compiles without node types, and the route already reads the
 * chain for the rest of what it renders.
 */

import { Link } from "../ui/link";

/**
 * What the route's read of the authority came to.
 *
 * Declared here rather than imported, because this folder compiles as its own
 * project and does not reach into `src/`. It is the same shape
 * `src/dashboard/curation.ts` produces, and structural typing is what joins
 * them; a field added there without being added here will not compile at the
 * route, which is where the two meet.
 */
export interface CurationAuthorityRead {
  readonly address: string;
  readonly kind: "multisig" | "account" | "unreadable";
  readonly threshold?: number | undefined;
  readonly owners?: readonly string[] | undefined;
  readonly unreadable?: string | undefined;
}

export interface CurationAuthorityProps {
  /** What the registry's authority address turned out to be, or nothing where none is configured. */
  readonly authority: CurationAuthorityRead | undefined;
  readonly explorerBaseUrl?: string | undefined;
}

export function CurationAuthority({ authority, explorerBaseUrl }: CurationAuthorityProps) {
  if (authority === undefined) return null;

  const link = (value: string) =>
    explorerBaseUrl === undefined ? undefined : `${explorerBaseUrl}/address/${value}`;

  const address = (value: string) =>
    link(value) === undefined ? (
      value
    ) : (
      <Link href={link(value) as string} external mono size="xs">
        {value}
      </Link>
    );

  const owners = authority.owners ?? [];

  return (
    <aside className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/30 p-5">
      <p className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
        Who sets a tier
      </p>

      <dl className="flex flex-col">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border/50 py-2">
          <dt className="font-mono text-xs text-muted-foreground">
            {authority.kind === "multisig"
              ? `Curation authority, a ${authority.threshold}-of-${owners.length} multisig`
              : "Curation authority"}
          </dt>
          <dd className="min-w-0 font-mono text-xs break-all text-foreground">{address(authority.address)}</dd>
        </div>
        {owners.map((owner, index) => (
          <div
            key={owner}
            className={`flex flex-wrap items-baseline justify-between gap-3 py-2${index < owners.length - 1 ? " border-b border-border/50" : ""}`}
          >
            <dt className="font-mono text-xs text-muted-foreground">Owner {index + 1}</dt>
            <dd className="min-w-0 font-mono text-xs break-all text-foreground">{address(owner)}</dd>
          </div>
        ))}
      </dl>

      <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
        A tier decides Credit Limit weight and nothing else. The authority has no power over
        metering, over any tab, or over any Bond, and every change it makes is queued and held for 48
        hours in public before it can apply.
        {authority.kind === "multisig"
          ? ` ${authority.threshold} of these ${owners.length} owners must approve a tier change, and the owner set is fixed: the multisig takes it in its constructor and exposes no setter. It holds no value either, having no receive and no payable function anywhere in it.`
          : authority.kind === "unreadable"
            ? ` Whether that address is a multisig could not be read here: ${authority.unreadable}. The address above is what the registry checks either way.`
            : " That address answers none of a multisig's reads, so it is an ordinary account."}{" "}
        It can only change at a deployment: the authority is a constructor argument with no setter,
        so the role cannot be reassigned on a live registry.
      </p>
    </aside>
  );
}
