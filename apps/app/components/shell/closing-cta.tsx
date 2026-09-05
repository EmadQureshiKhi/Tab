"use client";

/**
 * The last thing on the page, and the only place that asks for anything.
 *
 * A reader who has come this far has read the claim, watched the rail run, seen
 * the settlements it produced and had their questions answered. What they need
 * now is one line to copy and two places to go, not another argument.
 */

import { Button } from "../ui/button";
import { Reveal } from "../motion/reveal";

export interface ClosingCtaProps {
  readonly docsUrl: string;
}

export function ClosingCta({ docsUrl }: ClosingCtaProps) {
  return (
    <Reveal as="section">
      <div className="relative overflow-hidden rounded-lg border border-border/60 bg-muted/30 px-6 py-14 text-center sm:px-10 sm:py-20">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
        >
          <div
            className="absolute -bottom-32 left-1/2 h-[420px] w-[min(900px,140%)] -translate-x-1/2 opacity-70 dark:opacity-50"
            style={{
              background:
                "radial-gradient(ellipse 55% 55% at 50% 60%, rgb(20 184 166 / 0.14), transparent 70%)",
            }}
          />
        </div>

        <div className="mx-auto flex max-w-2xl flex-col items-center gap-6">
          <h2 className="font-host text-2xl leading-tight font-semibold text-foreground sm:text-3xl lg:text-4xl">
            Let your agents pay for what they use.
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
            One command connects a client. Nothing is prepaid, nothing holds your keys, and every
            figure on this site is checkable against the chain it came from.
          </p>
          <div className="flex w-full flex-col gap-3 pt-2 sm:w-auto sm:flex-row">
            <Button
              asChild
              variant="customTallPrimary"
              size="tall"
              className="w-full sm:w-auto sm:min-w-[220px]"
            >
              <a href={docsUrl} target="_blank" rel="noreferrer" className="no-underline">
                READ THE DOCS
              </a>
            </Button>
            <Button
              asChild
              variant="customTallSecondary"
              size="tall"
              className="w-full sm:w-auto sm:min-w-[220px]"
            >
              <a href="/explorer" className="no-underline">
                OPEN THE EXPLORER
              </a>
            </Button>
          </div>
        </div>
      </div>
    </Reveal>
  );
}
