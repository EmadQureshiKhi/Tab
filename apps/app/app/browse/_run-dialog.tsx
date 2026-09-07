"use client";

/**
 * Everything about one tool: what it costs, what backs it, how to wire it up,
 * and a call you can make from this page.
 *
 * ## Three tabs, in the order a reader needs them
 *
 * Terms first, because deciding whether to call something comes before calling
 * it. Connect second, which is the init instructions filled in for this tool
 * rather than shown as a template - a template is a thing to adapt and a filled
 * command is a thing to paste. Try last, because it is the only one that leaves
 * the page.
 *
 * ## Why Try can exist at all
 *
 * Post-paid is the whole argument, and this is where it stops being a claim. The
 * call needs no wallet, no balance and no approval: the Service delivers first
 * and writes the charge to an Open Tab afterwards. So the button is not a
 * simulation and does not pretend to be one - it posts to the Service's published
 * endpoint and shows exactly what came back, including a refusal.
 *
 * It is honest about what it is not, too. The response is the Service's, and this
 * page has read no chain to produce it. The charge that follows appears in the
 * explorer, which is where it can be checked, and that is where the panel points.
 *
 * Requirements: 24.3, 24.6, 24.9, 24.10
 */

import { useState } from "react";

import { chainLabel, type WireEntry } from "./_catalogue";
import { AssetAmount } from "../../components/custom-ui/asset-amount";
import { CopyButton } from "../../components/custom-ui/copy-button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Link } from "../../components/ui/link";
import { cn } from "../../components/ui/cn";
import { FOCUS_RING } from "../../components/ui/focus-ring";
import { recipeFor } from "../../src/dashboard/catalogue";

type Tab = "terms" | "connect" | "try";

/** Seconds as the sentence a reader reads, rather than a number they convert. */
function windowText(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

export function RunDialog({
  entry,
  onClose,
}: {
  readonly entry: WireEntry;
  readonly onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("terms");
  const price = BigInt(entry.priceBaseUnits);
  const free = entry.freeBondBaseUnits === undefined ? undefined : BigInt(entry.freeBondBaseUnits);
  const recipe = recipeFor({ ...entry, priceBaseUnits: price, freeBondBaseUnits: free });

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="w-full max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <img src="/logo.png" alt="" width={24} height={24} className="size-6 rounded-full" />
            <span className="font-mono text-base">{entry.tool}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-1 border-b border-border/60" role="tablist" aria-label="About this tool">
          {(
            [
              ["terms", "Terms"],
              ["connect", "Connect"],
              ["try", "Try it"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                "-mb-px border-b-2 px-4 py-2.5 font-mono text-xs tracking-wider uppercase transition-colors",
                FOCUS_RING,
                tab === key
                  ? "border-b-teal-600 text-foreground dark:border-b-teal-400"
                  : "border-b-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="max-h-[60vh] overflow-y-auto pt-4">
          {tab === "terms" ? <Terms entry={entry} price={price} free={free} /> : null}
          {tab === "connect" ? <Connect recipe={recipe} entry={entry} /> : null}
          {tab === "try" ? <TryIt entry={entry} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/50 py-2.5 last:border-b-0">
      <dt className="font-mono text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-end font-mono text-xs break-all text-foreground">{children}</dd>
    </div>
  );
}

function Terms({
  entry,
  price,
  free,
}: {
  readonly entry: WireEntry;
  readonly price: bigint;
  readonly free: bigint | undefined;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {entry.description ?? "This project publishes no description for this tool."}
      </p>

      <dl className="flex flex-col rounded-lg border border-border/60 bg-[var(--panel)] px-4">
        <Fact label="Price">
          <AssetAmount baseUnits={price} asset={entry.asset} /> per call
        </Fact>
        <Fact label="Service">{entry.serviceName}</Fact>
        <Fact label="Tier">
          {entry.tier}, credit weight {entry.creditWeight}
        </Fact>
        <Fact label="Asset">
          {entry.asset.symbol} on {chainLabel(entry.chainKey)}
        </Fact>
        <Fact label="Settlement Window">{windowText(entry.settlementWindowSeconds)}</Fact>
        <Fact label="Free Bond">
          {free === undefined ? (
            <span className="text-muted-foreground">not cross-checked</span>
          ) : (
            <AssetAmount baseUnits={free} asset={entry.asset} />
          )}
        </Fact>
        <Fact label="Operator">{entry.operator}</Fact>
      </dl>

      <p className="text-xs leading-relaxed text-muted-foreground">
        The Settlement Window is how long a tab may stay open before it is delinquent. Free Bond is
        what the Service can put behind a Provisional Clearing in this Asset, so a clearing larger
        than that figure cannot be applied.
      </p>

      <Link href="/services" size="xs" className="w-fit font-mono">
        See this Service in the directory
      </Link>
    </div>
  );
}

function Block({
  label,
  text,
  wrap = false,
}: {
  readonly label: string;
  readonly text: string;
  readonly wrap?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md border border-border/60 bg-background/60 p-3">
      <pre
        className={cn(
          "min-w-0 flex-1 font-mono text-xs leading-relaxed text-foreground",
          wrap ? "break-words whitespace-pre-wrap" : "overflow-x-auto",
        )}
      >
        {text}
      </pre>
      <CopyButton text={text} label={label} />
    </div>
  );
}

function Connect({
  recipe,
  entry,
}: {
  readonly recipe: ReturnType<typeof recipeFor>;
  readonly entry: WireEntry;
}) {
  const endpoint = entry.published?.endpoint;
  return (
    <div className="flex flex-col gap-4">
      <Step n="01" title="Put the tools into your client">
        One command writes a single entry into your client&apos;s configuration. No private key is
        written anywhere, and the four Tab tools appear the next time the client starts.
      </Step>
      <Block label="the connect command" text={recipe.connect} />

      <Step n="02" title="Ask for this tool by name">
        Any client that speaks MCP. The prompt below is enough on its own.
      </Step>
      <Block label="the prompt" text={recipe.prompt} wrap />

      <Step n="03" title="Or call it directly">
        <span>
          The arguments this tool takes, filled in. Nothing is paid to send it: the result comes
          back first and the charge lands on an Open Tab afterwards.
        </span>
      </Step>
      <Block label="the call" text={recipe.call} wrap />

      <div className="rounded-md border border-border/60 bg-background/60 p-3">
        <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
          Endpoint, published by this project
        </p>
        {endpoint === undefined ? (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            This project publishes no address for this Service. Every figure here is still the
            chain&apos;s; only the address is missing, because `ServiceRegistry` stores what a
            Service charges and never where it runs.
          </p>
        ) : (
          <div className="mt-2 flex items-start justify-between gap-2">
            <code className="font-mono text-xs break-all text-foreground">{endpoint}</code>
            <CopyButton text={endpoint} label="the endpoint" />
          </div>
        )}
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  readonly n: string;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[11px] tracking-widest text-teal-700 tabular-nums dark:text-teal-400">
          {n}
        </span>
        <span className="font-host text-sm font-semibold text-foreground">{title}</span>
      </div>
      <p className="ps-8 text-xs leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

type Attempt =
  | { readonly kind: "idle" }
  | { readonly kind: "calling" }
  | { readonly kind: "answered"; readonly status: number; readonly body: string }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The call itself.
 *
 * It posts to the published endpoint through this site's own route handler,
 * because a Service is not obliged to allow a browser origin and a call that
 * fails on CORS would report nothing about the Service. Whatever comes back is
 * shown as it arrived, including a refusal: a page that only rendered successes
 * would be hiding the interesting half.
 */
function TryIt({ entry }: { readonly entry: WireEntry }) {
  const [attempt, setAttempt] = useState<Attempt>({ kind: "idle" });
  const endpoint = entry.published?.endpoint;

  const call = async (): Promise<void> => {
    setAttempt({ kind: "calling" });
    try {
      const response = await fetch("/api/try", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serviceId: entry.serviceId, tool: entry.tool }),
      });
      const body = await response.text();
      setAttempt({ kind: "answered", status: response.status, body });
    } catch (cause) {
      setAttempt({
        kind: "failed",
        message: cause instanceof Error ? cause.message : "The request did not complete.",
      });
    }
  };

  if (endpoint === undefined) {
    return (
      <p className="rounded-lg border border-dashed border-border/60 bg-background/60 px-4 py-6 text-sm leading-relaxed text-muted-foreground">
        This project publishes no address for this Service, so there is nowhere for this page to
        send a call. Its prices and terms are still the chain&apos;s.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        This calls the Service for real. It needs no wallet, no balance and no approval, because
        nothing is paid to make the call: the Service answers first, and the charge is written to an
        Open Tab on Creditcoin afterwards. That is the whole of post-paid, and it is the one claim on
        this site you can test by pressing a button.
      </p>

      <button
        type="button"
        onClick={() => void call()}
        disabled={attempt.kind === "calling"}
        className={cn(
          "w-fit rounded-[2px] bg-foreground px-6 py-3.5 font-mono text-sm tracking-wider text-background uppercase",
          "transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-60",
          FOCUS_RING,
        )}
      >
        {attempt.kind === "calling" ? "Calling the Service" : `Call ${entry.tool}`}
      </button>

      {/*
        Said before the press, not after it. A metered delivery is a Creditcoin
        write, so the Service does not answer until a block has carried it: about
        forty-five seconds. A button that looks stuck for that long without having
        said why is a button people press twice.
      */}
      {attempt.kind === "calling" ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Recording the delivery on Creditcoin. The Service answers once a block has carried it,
          which takes about a minute. Nothing has been paid; this is the charge being written.
        </p>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          It takes about a minute. The delivery is recorded on Creditcoin before the Service
          answers, so the wait is a block, not a queue.
        </p>
      )}

      {attempt.kind === "answered" ? (
        <div className="flex flex-col gap-2">
          <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
            The Service answered, status {attempt.status}
          </p>
          <pre className="max-h-64 overflow-auto rounded-md border border-border/60 bg-background/60 p-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-foreground">
            {attempt.body.slice(0, 4000)}
          </pre>
          <p className="text-xs leading-relaxed text-muted-foreground">
            That is the Service&apos;s own response, passed through unchanged. This page has read no
            chain to produce it. If the call was metered, the charge appears against the Agent it was
            made for, and the Settlement that pays it down appears in{" "}
            <Link href="/explorer" size="inherit">
              the explorer
            </Link>
            .
          </p>
        </div>
      ) : null}

      {attempt.kind === "failed" ? (
        <p className="rounded-md border border-clearing-declined/30 bg-clearing-declined/5 px-3 py-2 text-xs leading-relaxed text-clearing-declined">
          {attempt.message}
        </p>
      ) : null}
    </div>
  );
}
