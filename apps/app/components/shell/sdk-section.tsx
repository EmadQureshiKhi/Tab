"use client";

/**
 * The SDK, and what a Service operator actually writes.
 *
 * A claim about an integration surface is worth very little beside the code that
 * uses it, so the right half of this section is the code and the left half is the
 * four things about it a reader would want to know before reading any.
 *
 * The sample is real. `withPostPaid` is the plugin, `priceOf` returns an integer
 * count of Asset base units, and the handler runs before the charge is recorded,
 * which is the whole shape of post-paid billing in eight lines.
 */

import { Check } from "lucide-react";

import { Button } from "../ui/button";
import { Reveal } from "../motion/reveal";

const CLAIMS = [
  { bold: "Post-paid:", rest: "the work is delivered first and the charge lands after it" },
  { bold: "No key held:", rest: "nothing in the SDK can move an Agent's funds" },
  { bold: "Nothing throws:", rest: "every fallible call returns a Result a model can read" },
  { bold: "Open source:", rest: "MIT, and every figure it reports is checkable on chain" },
] as const;

const REPOSITORY_URL = "https://github.com/EmadQureshiKhi/Tab";

/** One line of the sample. `t` is the token class, `i` the indent in spaces. */
type Line = readonly (readonly [string, string])[];

const SAMPLE: readonly Line[] = [
  [["import ", "kw"], ["{ withPostPaid }", "pl"], [" from ", "kw"], ['"@tabai/sdk"', "str"]],
  [],
  [["export const ", "kw"], ["handler", "fn"], [" = ", "pl"], ["withPostPaid", "fn"], ["(", "pl"]],
  [["  serve", "fn"], [",", "pl"]],
  [["  {", "pl"]],
  [["    serviceId", "prop"], [": ", "pl"], ["SERVICE_ID", "fn"], [",", "pl"]],
  [["    asset", "prop"], [": ", "pl"], ["USDC_SEPOLIA", "fn"], [",", "pl"]],
  [["    priceOf", "prop"], [": ", "pl"], ["(tool) ", "pl"], ["=> ", "kw"], ["10_000n", "num"], [",", "pl"]],
  [["    ", "pl"], ["// base units, never a decimal", "com"]],
  [["  }", "pl"]],
  [[")", "pl"]],
];

const TOKEN: Record<string, string> = {
  kw: "text-slate-600 dark:text-slate-400",
  fn: "text-blue-600 dark:text-blue-400",
  str: "text-teal-600 dark:text-teal-400",
  num: "text-amber-600 dark:text-amber-400",
  prop: "text-slate-500 dark:text-slate-400",
  com: "text-slate-500 italic",
  pl: "text-slate-700 dark:text-slate-300",
};

export function SdkSection() {
  return (
    <Reveal as="section">
      <div className="rounded-lg border border-border/60 bg-muted/30 p-6 sm:p-8">
        {/*
          The claim and the code that backs it arrive from opposite edges and
          meet, which is the one place on this page where two halves are the same
          statement said twice.
        */}
        <div className="flex flex-col items-start gap-8 lg:flex-row lg:items-center lg:gap-16">
          <Reveal from="left" className="flex flex-1 flex-col gap-8">
            <h2 className="max-w-3xl font-host text-xl leading-tight font-bold text-foreground sm:text-2xl lg:text-3xl">
              One line to bill for it.{" "}
              <span className="font-normal text-muted-foreground">
                Leave a star if you read this far.
              </span>
            </h2>

            <ul className="flex flex-col gap-3">
              {CLAIMS.map((claim) => (
                <li key={claim.bold} className="flex items-center gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded bg-teal-500/10">
                    <Check
                      className="size-3 text-teal-700 dark:text-teal-400"
                      strokeWidth={2.5}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="text-base font-medium text-foreground">
                    <span className="font-bold">{claim.bold}</span> {claim.rest}
                  </span>
                </li>
              ))}
            </ul>

            <Button
              asChild
              variant="customTallPrimary"
              size="tall"
              className="w-full lg:w-auto lg:min-w-[220px]"
            >
              <a
                href={REPOSITORY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="no-underline"
              >
                STAR ON GITHUB
              </a>
            </Button>
          </Reveal>

          <Reveal from="right" delay={0.08} className="w-full flex-1">
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="overflow-x-auto p-3 font-mono text-xs leading-5">
                <pre className="flex min-w-max">
                  <span
                    aria-hidden="true"
                    className="min-w-[1.5rem] shrink-0 pr-3 text-right text-slate-400 opacity-40 select-none"
                  >
                    {SAMPLE.map((_, index) => (
                      <span key={index} className="block h-5">
                        {index + 1}
                      </span>
                    ))}
                  </span>
                  <code className="min-w-max flex-1">
                    {SAMPLE.map((line, index) => (
                      <span key={index} className="block h-5">
                        {line.map(([text, token], part) => (
                          <span key={part} className={TOKEN[token]}>
                            {text}
                          </span>
                        ))}
                      </span>
                    ))}
                  </code>
                </pre>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </Reveal>
  );
}
