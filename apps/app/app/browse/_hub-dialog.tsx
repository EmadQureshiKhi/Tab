"use client";

/**
 * Everything about one fronted endpoint: what the Hub charges, what lands on
 * the tab, and the call that reaches it through the Service.
 *
 * ## Two tabs, not three
 *
 * Terms and Connect, in that order, for the same reason the listed dialog puts
 * them so: deciding comes before calling. There is no Try tab. The Service
 * fronts the Hub at one `run` path that takes the provider, the endpoint and an
 * input in its body, and this page has no input to send on a reader's behalf
 * that would not be a guess. The call is written out instead, filled in for
 * this endpoint, in both the `tab_call` form and the plain HTTP form.
 *
 * ## Who pays whom, said on the page
 *
 * The Hub is an x402 upstream: it is paid per request, up front. The Service
 * pays it with its own key and meters the Agent's Open Tab for the price plus
 * the Service's margin, so the Agent buys now and pays later without holding
 * the Hub's currency. The Terms tab says that in as many words, because it is
 * the whole reason the card exists.
 */

import { useState } from "react";

import { AssetAmount } from "../../components/custom-ui/asset-amount";
import { CopyButton } from "../../components/custom-ui/copy-button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Link } from "../../components/ui/link";
import { cn } from "../../components/ui/cn";
import { FOCUS_RING } from "../../components/ui/focus-ring";
import { hubRecipeFor, type HubEntry } from "../../src/dashboard/hub";

type Tab = "terms" | "connect";

export function HubRunDialog({
  entry,
  networkName,
  onClose,
}: {
  readonly entry: HubEntry;
  /** The chain's own name, so the Asset can be placed. */
  readonly networkName: string;
  readonly onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("terms");
  const recipe = hubRecipeFor(entry);

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="w-full max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span aria-hidden="true" className="size-6 shrink-0 rounded-full border border-border/60 bg-background" />
            <span className="font-mono text-base">{entry.name}</span>
            <span className="rounded bg-status-notice/15 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-status-notice uppercase">
              Fronted
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-1 border-b border-border/60" role="tablist" aria-label="About this endpoint">
          {(
            [
              ["terms", "Terms"],
              ["connect", "Connect"],
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
          {tab === "terms" ? <Terms entry={entry} networkName={networkName} /> : null}
          {tab === "connect" ? <Connect recipe={recipe} entry={entry} /> : null}
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

function Terms({ entry, networkName }: { readonly entry: HubEntry; readonly networkName: string }) {
  const tabPrice = entry.tabPriceBaseUnits === undefined ? undefined : BigInt(entry.tabPriceBaseUnits);
  const margin =
    entry.marginBps === undefined || entry.marginBps === 0
      ? "no published margin"
      : `${(entry.marginBps / 100).toFixed(entry.marginBps % 100 === 0 ? 0 : 2)}% margin`;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {entry.description ?? "The Hub publishes no description for this endpoint."}
      </p>

      <dl className="flex flex-col rounded-lg border border-border/60 bg-[var(--panel)] px-4">
        <Fact label="Provider">
          {entry.providerName}
          {entry.providerName === entry.provider ? "" : ` (${entry.provider})`}
        </Fact>
        <Fact label="Path">{entry.path}</Fact>
        <Fact label="Upstream price">
          {entry.upstreamUsd === undefined ? (
            <span className="text-muted-foreground">no figure in the manifest</span>
          ) : (
            `$${entry.upstreamUsd} per ${entry.priceType === "PER_CALL" ? "call" : entry.priceType.toLowerCase().replace(/^per_/, "")}, the Hub's word`
          )}
        </Fact>
        <Fact label="Tab price">
          {tabPrice === undefined ? (
            <span className="text-muted-foreground">the upstream&apos;s ask on the day, plus {margin}</span>
          ) : (
            <>
              <AssetAmount baseUnits={tabPrice} asset={entry.asset} /> per call, {margin}
            </>
          )}
        </Fact>
        <Fact label="Fronted by">{entry.serviceName}</Fact>
        <Fact label="Metered as">{entry.tool}</Fact>
        <Fact label="Tier">{entry.tier}</Fact>
        <Fact label="Asset">
          {entry.asset.symbol} on {networkName}
        </Fact>
        <Fact label="Paid upstream on">
          {entry.networks.length === 0 ? <span className="text-muted-foreground">unstated</span> : entry.networks.join(", ")}
        </Fact>
      </dl>

      <p className="text-xs leading-relaxed text-muted-foreground">
        The Hub is an x402 upstream and is paid per request, up front. {entry.serviceName} pays it
        with its own key and meters your Open Tab for the upstream price plus its margin, so you
        buy now and settle later without holding the Hub&apos;s currency. The upstream price is the
        Hub&apos;s manifest figure and the Tab price is this page&apos;s arithmetic from the
        published margin; neither is chain state, and the charge that lands is whatever the
        upstream asked for on the day.
      </p>

      <Link href="/services" size="xs" className="w-fit font-mono">
        See {entry.serviceName} in the directory
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

function Connect({ recipe, entry }: { readonly recipe: ReturnType<typeof hubRecipeFor>; readonly entry: HubEntry }) {
  return (
    <div className="flex flex-col gap-4">
      <Step n="01" title="Put the tools into your client">
        One command writes a single entry into your client&apos;s configuration. No private key is
        written anywhere, and the four Tab tools appear the next time the client starts.
      </Step>
      <Block label="the connect command" text={recipe.connect} />

      <Step n="02" title="Ask for this endpoint by name">
        Any client that speaks MCP. The prompt below is enough on its own.
      </Step>
      <Block label="the prompt" text={recipe.prompt} wrap />

      <Step n="03" title="Or call it directly">
        <span>
          The call, filled in. The Service fronts the Hub at <code className="font-mono">{entry.hubPath}</code>,
          which takes the provider, the endpoint path and your input in its body and meters the
          charge under <code className="font-mono">{entry.tool}</code>. Nothing is paid to send it.
        </span>
      </Step>
      <Block label="the call" text={recipe.call} wrap />

      <Step n="04" title="Or over plain HTTP">
        The same call against the Service&apos;s published endpoint. The request carries the Agent
        signature the SDK adds; it is shown here so the path and the body are not a guess.
      </Step>
      <Block label="the HTTP request" text={recipe.http} wrap />
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
