"use client";

/**
 * The catalogue, as a grid of cards with a run panel behind each one.
 *
 * ## The card
 *
 * Header with a mark, a name and a kind; a rule; the spec rows; a rule; the
 * Asset and chain as chips; a rule; the description; a rule; a network badge and
 * the action. Two columns from `md`, a list view for scanning, search and a
 * filter above. Every card has the same frame, so a reader compares tools by
 * reading across rather than by relearning each card.
 *
 * ## Two sources, never blurred
 *
 * A listed entry carries prices, an Asset, a tier and a Bond, all read from the
 * index. A fronted entry's price was read from the API Hub's manifest and the
 * Tab price is that plus the fronting Service's published margin, so the card
 * prints both figures with their sources and carries the word `fronted` where a
 * listed card carries `metered`. Fronted cards sort after every
 * on-chain-priced tool, so a reader scanning from the top is looking at the
 * chain.
 *
 * ## A client island for one reason
 *
 * Search, the view toggle and the open card. Everything drawn is server data, so
 * without JavaScript the filters are inert and every card is listed, which is the
 * honest degradation for a catalogue.
 */

import { useMemo, useState } from "react";
import { LayoutGrid, List, Search } from "lucide-react";

import { HubRunDialog } from "./_hub-dialog";
import { RunDialog } from "./_run-dialog";
import { AssetAmount } from "../../components/custom-ui/asset-amount";
import { cn } from "../../components/ui/cn";
import { FOCUS_RING } from "../../components/ui/focus-ring";
import { Reveal } from "../../components/motion/reveal";
import type { CatalogueEntry } from "../../src/dashboard/catalogue";
import { hubProviderLogo, type HubEntry, type HubNote } from "../../src/dashboard/hub";

export type WireEntry = Omit<CatalogueEntry, "priceBaseUnits" | "freeBondBaseUnits"> & {
  readonly priceBaseUnits: string;
  readonly freeBondBaseUnits?: string | undefined;
};

/** Whether the figures on a card are test money or real money. */
export type NetworkKind = "testnet" | "mainnet";

/** The kind a listed card carries. */
const METERED = "METERED";

/** The word a fronted card carries where a listed one carries `Metered`. */
const FRONTED = "FRONTED";

/**
 * The tint of the `Metered` chip. It names a kind of listing and carries no
 * meaning about money, which is why it may use a hue the settlement tokens do not.
 */
const METERED_TINT = "bg-teal-500/15 text-teal-700 dark:text-teal-400";

/** A card is a row the chain holds or an endpoint a Service fronts. */
type Card =
  | { readonly kind: "listed"; readonly key: string; readonly entry: WireEntry }
  | { readonly kind: "hub"; readonly key: string; readonly entry: HubEntry };

export function CatalogueView({
  entries,
  hub = [],
  hubNotes = [],
  indexedBlock,
  networkName,
  networkKind,
}: {
  readonly entries: readonly WireEntry[];
  /** Endpoints a published Service fronts from the API Hub. Already text throughout. */
  readonly hub?: readonly HubEntry[] | undefined;
  /** What the Hub reads had to say beside their cards: a manifest that did not answer, a count. */
  readonly hubNotes?: readonly HubNote[] | undefined;
  readonly indexedBlock: number | null;
  /** The chain's own name, for the badge on every listed card. */
  readonly networkName: string;
  readonly networkKind: NetworkKind;
}) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("ALL");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [open, setOpen] = useState<WireEntry | undefined>(undefined);
  const [openHub, setOpenHub] = useState<HubEntry | undefined>(undefined);

  /*
    Every kind present, metered first. A listed tool is `METERED` rather than
    an output kind: what it produces is the Service's business, and what the
    chain knows is that it is priced. A fronted endpoint is `FRONTED` for the
    same reason: what the page knows is who pays whom.
  */
  const categories = useMemo(() => {
    const kinds = ["ALL"];
    if (entries.length > 0) kinds.push(METERED);
    if (hub.length > 0) kinds.push(FRONTED);
    return kinds;
  }, [entries, hub]);

  const cards = useMemo<readonly Card[]>(() => {
    const needle = search.trim().toLowerCase();

    const listed: Card[] =
      category === "ALL" || category === METERED
        ? entries
            .filter(
              (entry) =>
                needle.length === 0 ||
                entry.tool.toLowerCase().includes(needle) ||
                entry.serviceName.toLowerCase().includes(needle) ||
                (entry.description ?? "").toLowerCase().includes(needle),
            )
            .map((entry) => ({ kind: "listed" as const, key: entry.key, entry }))
        : [];

    const fronted: Card[] =
      category === "ALL" || category === FRONTED
        ? hub
            .filter(
              (entry) =>
                needle.length === 0 ||
                entry.name.toLowerCase().includes(needle) ||
                entry.path.toLowerCase().includes(needle) ||
                entry.provider.toLowerCase().includes(needle) ||
                entry.providerName.toLowerCase().includes(needle) ||
                entry.serviceName.toLowerCase().includes(needle) ||
                (entry.description ?? "").toLowerCase().includes(needle),
            )
            .map((entry) => ({ kind: "hub" as const, key: entry.key, entry }))
        : [];

    return [...listed, ...fronted];
  }, [entries, hub, search, category]);

  const listedCount = cards.filter((card) => card.kind === "listed").length;
  const frontedCount = cards.length - listedCount;

  return (
    <div className="mx-auto w-full max-w-6xl">
      {/*
        The search takes a row of its own on a phone, so its placeholder is
        never squeezed to a few letters by the filter and the view toggle.
      */}
      <div className="mb-8 flex flex-wrap items-center gap-3 sm:flex-nowrap">
        <div className="relative w-full sm:w-auto sm:flex-1">
          <label className="sr-only" htmlFor="catalogue-search">
            Search tools by name, Service, provider or description
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            id="catalogue-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tools..."
            className={cn(
              "h-12 w-full rounded-[4px] border border-border/30 bg-card ps-11 pe-3",
              "font-mono text-sm text-foreground placeholder:text-muted-foreground/50",
              FOCUS_RING,
            )}
          />
        </div>

        <select
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          aria-label="Kind"
          className={cn(
            "h-12 min-w-[130px] flex-1 rounded-[4px] border border-border/30 bg-card px-3 sm:flex-none",
            "font-mono text-xs tracking-wider text-foreground uppercase",
            FOCUS_RING,
          )}
        >
          {categories.map((entry) => (
            <option key={entry} value={entry}>
              {entry === "ALL" ? "Any kind" : entry}
            </option>
          ))}
        </select>

        <div className="flex overflow-hidden rounded-[4px] border border-border/30 bg-card">
          {(
            [
              ["grid", LayoutGrid, "Grid view"],
              ["list", List, "List view"],
            ] as const
          ).map(([mode, Icon, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              aria-label={label}
              aria-pressed={view === mode}
              className={cn(
                "p-3 transition-colors",
                FOCUS_RING,
                view === mode
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>

      <div className="mb-5 flex flex-col gap-2">
        <p className="font-mono text-xs text-muted-foreground">
          {listedCount} priced {listedCount === 1 ? "tool" : "tools"} on chain
          {indexedBlock === null
            ? ", read at an unrecorded height"
            : `, read at ${networkName} block ${indexedBlock.toLocaleString("en-US")}`}
          {frontedCount > 0
            ? `. ${frontedCount} ${frontedCount === 1 ? "endpoint" : "endpoints"} fronted from the API Hub on credit, priced by the Hub${listedCount > 0 ? " and listed after them" : ""}.`
            : "."}
        </p>
        {/*
          What the Hub reads had to say, beside the cards they did or did not
          produce. A manifest that did not answer is a sentence here, so a page
          with no fronted cards says why rather than looking as though nothing
          is fronted.
        */}
        {hubNotes.length === 0 ? null : (
          <ul className="flex flex-col gap-1">
            {hubNotes.map((note) => (
              <li key={`${note.serviceName}:${note.provider}:${note.text}`} className="text-xs leading-relaxed text-muted-foreground">
                {note.text}
              </li>
            ))}
          </ul>
        )}
      </div>

      {cards.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-6 py-10 text-center text-sm text-muted-foreground">
          {entries.length === 0 && hub.length === 0
            ? `No Service on ${networkName} prices a tool yet. A Service that registers and prices one appears here as soon as the index reads it.`
            : "Nothing matches that. The filters are applied to what the chain holds, so an empty result is a real answer about the registry rather than a failed search."}
        </p>
      ) : (
        <div
          className={cn(
            "pb-16",
            view === "grid" ? "grid grid-cols-1 gap-4 md:grid-cols-2" : "flex flex-col gap-3",
          )}
        >
          {cards.map((card, index) => (
            <Reveal key={card.key} delay={Math.min(index, 8) * 0.03}>
              {card.kind === "listed" ? (
                <ListedCard
                  entry={card.entry}
                  dense={view === "list"}
                  networkName={networkName}
                  networkKind={networkKind}
                  onRun={() => setOpen(card.entry)}
                />
              ) : (
                <HubCard
                  entry={card.entry}
                  dense={view === "list"}
                  networkName={networkName}
                  networkKind={networkKind}
                  onRun={() => setOpenHub(card.entry)}
                />
              )}
            </Reveal>
          ))}
        </div>
      )}

      {open === undefined ? null : (
        <RunDialog entry={open} networkName={networkName} onClose={() => setOpen(undefined)} />
      )}
      {openHub === undefined ? null : (
        <HubRunDialog entry={openHub} networkName={networkName} onClose={() => setOpenHub(undefined)} />
      )}
    </div>
  );
}

function Rule() {
  return <div className="h-px bg-border/60" aria-hidden="true" />;
}

function Spec({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </span>
      <span className="min-w-0 truncate font-mono text-[13px] text-foreground">{children}</span>
    </div>
  );
}

function Chip({ children }: { readonly children: React.ReactNode }) {
  return (
    <span className="rounded bg-foreground/[0.06] px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

function ListedCard({
  entry,
  dense,
  networkName,
  networkKind,
  onRun,
}: {
  readonly entry: WireEntry;
  readonly dense: boolean;
  readonly networkName: string;
  readonly networkKind: NetworkKind;
  readonly onRun: () => void;
}) {
  const price = BigInt(entry.priceBaseUnits);
  const free = entry.freeBondBaseUnits === undefined ? undefined : BigInt(entry.freeBondBaseUnits);

  if (dense) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-[var(--panel)] p-4 transition-colors hover:border-border sm:flex-row sm:items-center">
        <img src="/logo.png" alt="" width={22} height={22} className="size-[22px] shrink-0 rounded-full" />
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{entry.tool}</span>
        <span className="font-mono text-xs text-muted-foreground">{entry.serviceName}</span>
        <span className="font-mono text-[13px] text-foreground">
          <AssetAmount baseUnits={price} asset={entry.asset} />
        </span>
        <button
          type="button"
          onClick={onRun}
          className={cn(
            "rounded bg-foreground/[0.06] px-4 py-2 font-mono text-xs tracking-wider text-foreground uppercase",
            "transition-colors hover:bg-foreground/[0.1]",
            FOCUS_RING,
          )}
        >
          Run
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border/60 bg-[var(--panel)] transition-colors duration-200 hover:border-border">
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <img src="/logo.png" alt="" width={28} height={28} className="size-7 shrink-0 rounded-full" />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{entry.tool}</h3>
        <span
          className={cn(
            "shrink-0 rounded px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider uppercase",
            METERED_TINT,
          )}
        >
          Metered
        </span>
      </div>

      <Rule />
      <div className="flex flex-col gap-2.5 px-5 py-4">
        <Spec label="Price">
          <AssetAmount baseUnits={price} asset={entry.asset} />
          <span className="ms-1 text-[11px] text-muted-foreground">/ call</span>
        </Spec>
        <Spec label="Service">{entry.serviceName}</Spec>
        <Spec label="Tier">{entry.tier}</Spec>
        <Spec label="Free Bond">
          {free === undefined ? (
            <span className="text-muted-foreground">not cross-checked</span>
          ) : (
            <AssetAmount baseUnits={free} asset={entry.asset} />
          )}
        </Spec>
      </div>

      <Rule />
      <div className="px-5 py-3.5">
        <p className="mb-2 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
          Settles in
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Chip>{entry.asset.symbol}</Chip>
          <Chip>{networkName}</Chip>
          <Chip>{`window ${Math.round(entry.settlementWindowSeconds / 3600)}h`}</Chip>
        </div>
      </div>

      <Rule />
      <div className="flex-1 px-5 py-3.5">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {entry.description ?? "This project publishes no description for this tool."}
        </p>
      </div>

      <Rule />
      <div className="flex items-center">
        <div className="px-5 py-1">
          {/*
            Said on every listed card rather than once on the page, because a
            card is the thing a reader screenshots. Testnet is drawn in amber so
            it cannot be mistaken for a real price; Mainnet is drawn plainly.
          */}
          <span
            className={cn(
              "rounded px-2 py-0.5 font-mono text-[9px] font-medium tracking-wider uppercase",
              networkKind === "testnet"
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                : "bg-teal-500/15 text-teal-700 dark:text-teal-400",
            )}
          >
            {networkKind === "testnet" ? "Testnet" : "Mainnet"}
          </span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onRun}
          className={cn(
            "flex-1 border-s border-border/60 bg-foreground/[0.04] py-3.5 text-center",
            "font-mono text-sm font-medium tracking-wider text-foreground uppercase",
            "transition-colors hover:bg-foreground/[0.08]",
            FOCUS_RING,
          )}
        >
          Run
        </button>
      </div>
    </div>
  );
}

/** The Hub's USD figure, as the Hub prints it: a dollar sign and the decimal text, never a float. */
function usd(text: string): string {
  return `$${text}`;
}

/**
 * A fronted endpoint, in the same frame and marked as a third source.
 *
 * Two prices, both labelled. `Upstream` is the Hub's own USD figure for the
 * call, which is what the fronting Service pays. `Tab price` is that plus the
 * Service's published margin, in the Asset the Service meters in, which is what
 * lands on the Open Tab. A per-result or per-unit endpoint has no fixed Tab
 * price and says so where the figure would go, because the metered amount is
 * whatever the upstream asks on the day.
 */
function HubCard({
  entry,
  dense,
  networkName,
  networkKind,
  onRun,
}: {
  readonly entry: HubEntry;
  readonly dense: boolean;
  readonly networkName: string;
  readonly networkKind: NetworkKind;
  readonly onRun: () => void;
}) {
  const tabPrice = entry.tabPriceBaseUnits === undefined ? undefined : BigInt(entry.tabPriceBaseUnits);
  const margin =
    entry.marginBps === undefined || entry.marginBps === 0
      ? "no published margin"
      : `${(entry.marginBps / 100).toFixed(entry.marginBps % 100 === 0 ? 0 : 2)}% margin`;
  const frontedTint = "bg-status-notice/15 text-status-notice";

  if (dense) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-[var(--panel)] p-4 transition-colors hover:border-border sm:flex-row sm:items-center">
        <img src={hubProviderLogo(entry.provider)} alt="" width={22} height={22} className="size-[22px] shrink-0 rounded-full bg-white/90 object-contain p-0.5" />
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{entry.name}</span>
        <span className={cn("rounded px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase", frontedTint)}>
          Fronted
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {entry.providerName} via {entry.serviceName}
        </span>
        <span className="font-mono text-[13px] text-foreground">
          {tabPrice === undefined ? (
            <span className="text-muted-foreground">{entry.priceType.toLowerCase().replace(/_/g, " ")}</span>
          ) : (
            <AssetAmount baseUnits={tabPrice} asset={entry.asset} />
          )}
        </span>
        <button
          type="button"
          onClick={onRun}
          className={cn(
            "rounded bg-foreground/[0.06] px-4 py-2 font-mono text-xs tracking-wider text-foreground uppercase",
            "transition-colors hover:bg-foreground/[0.1]",
            FOCUS_RING,
          )}
        >
          Run
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border/60 bg-[var(--panel)] transition-colors duration-200 hover:border-border">
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <Mark src={hubProviderLogo(entry.provider)} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={entry.path}>
          {entry.name}
        </h3>
        <span
          className={cn(
            "shrink-0 rounded px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider uppercase",
            frontedTint,
          )}
        >
          Fronted
        </span>
      </div>

      <Rule />
      <div className="flex flex-col gap-2.5 px-5 py-4">
        <Spec label="Upstream">
          {entry.upstreamUsd === undefined ? (
            <span className="text-muted-foreground">no figure in the manifest</span>
          ) : (
            <>
              {usd(entry.upstreamUsd)}
              <span className="ms-1 text-[11px] text-muted-foreground">
                / {entry.priceType === "PER_CALL" ? "call" : entry.priceType.toLowerCase().replace(/^per_/, "")}, the Hub&apos;s price
              </span>
            </>
          )}
        </Spec>
        <Spec label="Tab price">
          {tabPrice === undefined ? (
            <span className="text-muted-foreground">the upstream&apos;s ask on the day, plus {margin}</span>
          ) : (
            <>
              <AssetAmount baseUnits={tabPrice} asset={entry.asset} />
              <span className="ms-1 text-[11px] text-muted-foreground">/ call, {margin}</span>
            </>
          )}
        </Spec>
        <Spec label="Provider">{entry.providerName}</Spec>
        <Spec label="Path">{entry.path}</Spec>
      </div>

      <Rule />
      <div className="px-5 py-3.5">
        <p className="mb-2 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
          On credit through {entry.serviceName}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Chip>{entry.hubPath}</Chip>
          <Chip>{entry.asset.symbol}</Chip>
          <Chip>{networkName}</Chip>
          <Chip>x402 upstream</Chip>
        </div>
      </div>

      <Rule />
      <div className="flex-1 px-5 py-3.5">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {entry.description ?? "The Hub publishes no description for this endpoint."}
        </p>
      </div>

      <Rule />
      <div className="flex items-center">
        <div className="px-5 py-1">
          <span
            className={cn(
              "rounded px-2 py-0.5 font-mono text-[9px] font-medium tracking-wider uppercase",
              networkKind === "testnet"
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                : "bg-teal-500/15 text-teal-700 dark:text-teal-400",
            )}
          >
            {networkKind === "testnet" ? "Testnet" : "Mainnet"}
          </span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onRun}
          className={cn(
            "flex-1 border-s border-border/60 bg-foreground/[0.04] py-3.5 text-center",
            "font-mono text-sm font-medium tracking-wider text-foreground uppercase",
            "transition-colors hover:bg-foreground/[0.08]",
            FOCUS_RING,
          )}
        >
          Run
        </button>
      </div>
    </div>
  );
}

/** A provider's mark, on a light disc so a dark logo still reads in dark mode. */
function Mark({ src }: { readonly src: string }) {
  return (
    <img
      src={src}
      alt=""
      width={28}
      height={28}
      className="size-7 shrink-0 rounded-full bg-white/90 object-contain p-1"
    />
  );
}
