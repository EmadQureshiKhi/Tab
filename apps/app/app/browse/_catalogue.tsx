"use client";

/**
 * The catalogue, as a grid of cards with a run panel behind each one.
 *
 * ## The shape is the reference's
 *
 * Header with a mark, a name and a category; a rule; the spec rows; a rule; the
 * tools or capabilities as chips; a rule; the description; a rule; a network
 * badge and the action. Two columns from `md`, a list view for scanning, search
 * and a filter above. Section 12.0 makes that mapping the specification, and this
 * is the page it applies to most directly.
 *
 * ## What is on chain and what is not is never blurred
 *
 * A real entry carries prices, an Asset, a tier and a Bond, all read from the
 * index. A showcase entry carries none of those and says so, in the same place
 * the real one puts its price. That is not decoration: the argument this product
 * makes is that a figure you can check differs in kind from a figure somebody
 * typed, so an invented price sitting in the same column as a read one would be
 * the exact thing it exists to refuse.
 *
 * ## A client island for one reason
 *
 * Search, the view toggle and the open card. Everything drawn is server data, so
 * without JavaScript the filters are inert and every card is listed, which is the
 * honest degradation for a catalogue (R24.9).
 *
 * Requirements: 24.3, 24.9, 24.10
 */

import { useMemo, useState } from "react";
import { LayoutGrid, List, Search } from "lucide-react";

import { RunDialog } from "./_run-dialog";
import { AssetAmount } from "../../components/custom-ui/asset-amount";
import { cn } from "../../components/ui/cn";
import { FOCUS_RING } from "../../components/ui/focus-ring";
import { Reveal } from "../../components/motion/reveal";
import { CATEGORY_TINT, providerLogo, type ShowcaseEntry } from "../../src/dashboard/showcase";
import type { CatalogueEntry } from "../../src/dashboard/catalogue";

export type WireEntry = Omit<CatalogueEntry, "priceBaseUnits" | "freeBondBaseUnits"> & {
  readonly priceBaseUnits: string;
  readonly freeBondBaseUnits?: string | undefined;
};

/** Tab's own chain keys, which are not EVM chain ids and are easy to confuse. */
const CHAIN_NAME: Record<string, string> = { "1": "Sepolia", "3": "Ethereum" };

export function chainLabel(chainKey: string | undefined): string {
  if (chainKey === undefined) return "an unlisted chain";
  return CHAIN_NAME[chainKey] ?? `chainKey ${chainKey}`;
}

/** A card is either a row the chain holds, or one of the examples beside it. */
type Card =
  | { readonly kind: "listed"; readonly key: string; readonly entry: WireEntry }
  | { readonly kind: "showcase"; readonly key: string; readonly entry: ShowcaseEntry };

export function CatalogueView({
  entries,
  showcase,
  indexedBlock,
}: {
  readonly entries: readonly WireEntry[];
  readonly showcase: readonly ShowcaseEntry[];
  readonly indexedBlock: number | null;
}) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("ALL");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [open, setOpen] = useState<WireEntry | undefined>(undefined);

  /*
    Every category present, with the metered ones first. A listed tool is
    `METERED` rather than an output kind: what it produces is the Service's
    business, and what the chain knows is that it is priced.
  */
  const categories = useMemo(() => {
    const seen = new Set<string>();
    if (entries.length > 0) seen.add("METERED");
    for (const entry of showcase) seen.add(entry.category);
    return ["ALL", ...[...seen].sort()];
  }, [entries, showcase]);

  const cards = useMemo<readonly Card[]>(() => {
    const needle = search.trim().toLowerCase();

    const listed: Card[] =
      category === "ALL" || category === "METERED"
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

    const examples: Card[] =
      category === "METERED"
        ? []
        : showcase
            .filter((entry) => category === "ALL" || entry.category === category)
            .filter(
              (entry) =>
                needle.length === 0 ||
                entry.tool.toLowerCase().includes(needle) ||
                entry.description.toLowerCase().includes(needle) ||
                entry.capabilities.some((capability) => capability.toLowerCase().includes(needle)),
            )
            .map((entry) => ({ kind: "showcase" as const, key: entry.key, entry }));

    return [...listed, ...examples];
  }, [entries, showcase, search, category]);

  const listedCount = cards.filter((card) => card.kind === "listed").length;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="mb-8 flex items-center gap-3">
        <div className="relative flex-1">
          <label className="sr-only" htmlFor="catalogue-search">
            Search tools by name, Service, description or capability
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
          aria-label="Output"
          className={cn(
            "h-12 min-w-[130px] rounded-[4px] border border-border/30 bg-card px-3",
            "font-mono text-xs tracking-wider text-foreground uppercase",
            FOCUS_RING,
          )}
        >
          {categories.map((entry) => (
            <option key={entry} value={entry}>
              {entry === "ALL" ? "Any output" : entry}
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

      <p className="mb-5 font-mono text-xs text-muted-foreground">
        {listedCount} priced {listedCount === 1 ? "tool" : "tools"} on chain
        {indexedBlock === null
          ? ", read at an unrecorded height"
          : `, read at Creditcoin block ${indexedBlock.toLocaleString("en-US")}`}
        {cards.length > listedCount ? `. The ${cards.length - listedCount} below them are examples.` : ""}
      </p>

      {cards.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-6 py-10 text-center text-sm text-muted-foreground">
          Nothing matches that. The filters are applied to what the chain holds, so an empty result
          is a real answer about the registry rather than a failed search.
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
                <ListedCard entry={card.entry} dense={view === "list"} onRun={() => setOpen(card.entry)} />
              ) : (
                <ShowcaseCard entry={card.entry} dense={view === "list"} />
              )}
            </Reveal>
          ))}
        </div>
      )}

      {open === undefined ? null : <RunDialog entry={open} onClose={() => setOpen(undefined)} />}
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
  onRun,
}: {
  readonly entry: WireEntry;
  readonly dense: boolean;
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
            CATEGORY_TINT["METERED"],
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
          <Chip>{chainLabel(entry.chainKey)}</Chip>
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
          <span className="rounded bg-amber-500/15 px-2 py-0.5 font-mono text-[9px] font-medium tracking-wider text-amber-700 uppercase dark:text-amber-400">
            Testnet
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

/**
 * An example, in the same frame and unmistakably not on the chain.
 *
 * The reference's own rows: price and unit, max resolution, max duration,
 * capabilities, description. The one thing added is the word `example` beside the
 * price, because that is where a reader looks to decide whether a figure is real,
 * and a dollar figure somebody typed sitting silently where an Asset amount goes
 * would be the exact confusion this product exists to remove.
 */
function ShowcaseCard({ entry, dense }: { readonly entry: ShowcaseEntry; readonly dense: boolean }) {
  const logo = providerLogo(entry.tool);
  const tint = CATEGORY_TINT[entry.category] ?? "bg-foreground/[0.06] text-muted-foreground";

  if (dense) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-[var(--panel)] p-4">
        <Mark src={logo} />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{entry.tool}</span>
        <span className={cn("rounded px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase", tint)}>
          {entry.category}
        </span>
        <span className="font-mono text-[13px] text-muted-foreground">
          {entry.price} <span className="text-[11px]">/ {entry.priceUnit}</span>
        </span>
        <span className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
          Example
        </span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border/60 bg-[var(--panel)] transition-colors duration-200 hover:border-border">
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <Mark src={logo} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{entry.tool}</h3>
        <span
          className={cn(
            "shrink-0 rounded px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider uppercase",
            tint,
          )}
        >
          {entry.category}
        </span>
      </div>

      <Rule />
      <div className="flex flex-col gap-2.5 px-5 py-4">
        <Spec label="Price">
          {entry.price} <span className="text-[11px] text-muted-foreground">/ {entry.priceUnit}</span>
        </Spec>
        <Spec label="Max res">{entry.maxRes}</Spec>
        <Spec label="Max dur">{entry.maxDur}</Spec>
      </div>

      <Rule />
      <div className="px-5 py-3.5">
        <p className="mb-2 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
          Capabilities
        </p>
        <div className="flex flex-wrap gap-1.5">
          {entry.capabilities.map((capability) => (
            <Chip key={capability}>{capability}</Chip>
          ))}
        </div>
      </div>

      <Rule />
      <div className="flex-1 px-5 py-3.5">
        <p className="text-xs leading-relaxed text-muted-foreground">{entry.description}</p>
      </div>

      <Rule />
      <div className="flex items-center">
        <div className="px-5 py-1">
          <span className="rounded bg-foreground/[0.06] px-2 py-0.5 font-mono text-[9px] font-medium tracking-wider text-muted-foreground uppercase">
            Example
          </span>
        </div>
        <div className="flex-1" />
        <span className="flex-1 border-s border-border/60 py-3.5 text-center font-mono text-sm tracking-wider text-muted-foreground uppercase">
          Not registered
        </span>
      </div>
    </div>
  );
}

function Mark({ src }: { readonly src: string | undefined }) {
  if (src === undefined) {
    return (
      <span
        aria-hidden="true"
        className="size-7 shrink-0 rounded-full border border-border/60 bg-background"
      />
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={28}
      height={28}
      className="size-7 shrink-0 rounded-full bg-white/90 p-1"
    />
  );
}
