/**
 * The blocks these pages reach for beyond prose.
 *
 * Fumadocs' preset covers every element the documentation writes as Markdown.
 * These are the three shapes it does not have and this material keeps needing:
 * a set of routes to send a reader to, a figure with the sentence that makes it
 * mean something, and a boundary stated with its bound.
 *
 * All three are server components with no client runtime. A documentation site
 * that needed JavaScript to render a definition list would be the wrong trade.
 */

import type { ReactNode } from "react";

/** A card that sends a reader somewhere, with the reason they would go. */
export function Card({
  title,
  href,
  children,
  external = false,
}: {
  readonly title: string;
  readonly href: string;
  readonly children: ReactNode;
  readonly external?: boolean;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
      className="not-prose group flex flex-col gap-1.5 rounded-lg border border-fd-border bg-fd-card p-4 no-underline transition-colors hover:border-fd-primary/40"
    >
      <span className="text-sm font-semibold text-fd-foreground">{title}</span>
      <span className="text-sm leading-relaxed text-fd-muted-foreground">{children}</span>
    </a>
  );
}

/** Two or three cards abreast, one column on a narrow screen. */
export function Cards({ children }: { readonly children: ReactNode }) {
  return <div className="not-prose my-6 grid gap-3 sm:grid-cols-2">{children}</div>;
}

/**
 * A figure and what it means.
 *
 * A number without its sentence is the thing this documentation is most likely
 * to get wrong, so the sentence is a required prop rather than an optional one.
 */
export function Stat({
  value,
  label,
  children,
}: {
  readonly value: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="not-prose flex flex-col gap-1 rounded-lg border border-fd-border bg-fd-card p-4">
      <span className="font-mono text-2xl text-fd-foreground">{value}</span>
      <span className="font-mono text-[11px] tracking-wider text-fd-muted-foreground uppercase">
        {label}
      </span>
      <span className="mt-1 text-xs leading-relaxed text-fd-muted-foreground">{children}</span>
    </div>
  );
}

export function Stats({ children }: { readonly children: ReactNode }) {
  return <div className="not-prose my-6 grid gap-3 sm:grid-cols-3">{children}</div>;
}

/**
 * One step of a sequence, numbered by the caller.
 *
 * Numbered by hand rather than counted, because these steps are referred to by
 * number in the prose around them and a renumbering that happened silently would
 * break a sentence somewhere else on the page.
 */
export function Step({
  n,
  title,
  children,
}: {
  readonly n: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="not-prose flex gap-4 border-s-2 border-fd-border ps-5 pb-6 last:pb-0">
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] tracking-widest text-fd-primary tabular-nums">
          {n}
        </span>
        <span className="text-sm font-semibold text-fd-foreground">{title}</span>
        <span className="text-sm leading-relaxed text-fd-muted-foreground">{children}</span>
      </div>
    </div>
  );
}

export function Steps({ children }: { readonly children: ReactNode }) {
  return <div className="not-prose my-6 flex flex-col">{children}</div>;
}

/**
 * A boundary, with the bound that says how far it reaches.
 *
 * The bound is a required prop for the same reason the stat's sentence is: a
 * boundary named without one reads as either worse or better than it is, which
 * is the house rule this documentation is written to.
 */
export function Bounded({
  title,
  bound,
  children,
}: {
  readonly title: string;
  readonly bound: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="not-prose my-4 rounded-lg border border-fd-border bg-fd-card p-4">
      <p className="text-sm font-semibold text-fd-foreground">{title}</p>
      {/*
        A div and not a p. MDX renders a paragraph of children as its own `<p>`,
        and a `<p>` inside a `<p>` is invalid: the browser closes the outer one
        early, the DOM stops matching the tree React built, and the page throws a
        hydration error and rebuilds itself. Everything here that wraps MDX
        children is a block element for that reason.
      */}
      <div className="mt-1.5 text-sm leading-relaxed text-fd-muted-foreground">{children}</div>
      <div className="mt-3 border-t border-fd-border pt-3 text-sm leading-relaxed text-fd-foreground">
        <span className="font-mono text-[11px] tracking-wider text-fd-muted-foreground uppercase">
          The bound
        </span>
        <br />
        {bound}
      </div>
    </div>
  );
}
