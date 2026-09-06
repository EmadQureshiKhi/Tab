"use client";

/**
 * `LiveSettlements` - the ticker, kept fresh within 30 seconds (R24.6).
 *
 * ## Two mechanisms, because one of them is somebody else's network
 *
 * The stream is the fast path and the poll is the guarantee. Server sent events
 * usually deliver a settlement within a few seconds, but a corporate proxy or a
 * CDN that buffers long-lived responses can hold or drop them entirely, and there
 * is no reliable way for a page to detect that from the inside: a buffered stream
 * looks exactly like a quiet one.
 *
 * So the poll always runs. It is not started when the stream fails, because a
 * silently buffered stream never reports failing. Running both unconditionally
 * costs one request every fifteen seconds and makes the freshness claim true on
 * networks this page cannot see.
 *
 * ## The server already rendered the rows
 *
 * The initial rows come from the server render, so this component mounts with the
 * feed already correct and does not fetch on mount. The stream's first frame is a
 * `hello` that establishes what the reader already has rather than replaying it,
 * which is why connecting does not duplicate every visible row.
 *
 * ## Degrading honestly
 *
 * If both mechanisms fail the component says the feed is not updating rather than
 * showing a stale list as though it were live. A ticker that quietly stops is
 * worse than one that admits it, because the reader cannot tell the difference
 * between a quiet chain and a broken page.
 *
 * Requirements: 24.6, 24.9
 */

import { useEffect, useRef, useState } from "react";

import { assetUnitFor } from "../custom-ui/format";
import { SettlementTable, type SettlementRowView } from "./settlement-table";

/** How often the fallback poll re-reads the feed. Mirrors `CLIENT_POLL_MS`. */
const POLL_MS = 15_000;

/** How long without any successful read before the feed admits it is not updating. */
const STALE_AFTER_MS = 45_000;

/**
 * Everything this island needs, and all of it serialisable.
 *
 * The two link builders are deliberately **not** props. A function cannot cross
 * the server-to-client boundary, so passing `hrefFor` down from the page would
 * typecheck and then fail at runtime the moment the island rendered. The base URL
 * and the chain key are data, they serialise, and the links are built here.
 */
export interface LiveSettlementsProps {
  /** Rows from the server render. The component starts correct and never fetches on mount. */
  readonly initialRows: readonly SettlementRowView[];
  readonly caption: string;
  readonly chainKey: number;
  /** Blockscout base, resolved on the server from the environment contract. */
  readonly explorerBaseUrl: string;
  /** Rows kept on screen. The feed is a head, not a backfill. */
  readonly limit?: number | undefined;
}

/** The wire shape `/api/settlements` and the stream both carry. */
interface WireRow {
  readonly replayKey: string;
  readonly chainKey: string;
  readonly sourceBlockHeight: string;
  readonly sourceTxIndex: string;
  readonly sourceLogIndex: string;
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: string;
}

export function LiveSettlements({
  initialRows,
  caption,
  chainKey,
  explorerBaseUrl,
  limit = 10,
}: LiveSettlementsProps) {
  const hrefFor = (replayKey: string): string => `/explorer/${replayKey}?chainKey=${chainKey}`;
  const explorerHrefFor = (txHash: string): string =>
    `${explorerBaseUrl.replace(/\/+$/, "")}/tx/${txHash}`;

  const [rows, setRows] = useState<readonly SettlementRowView[]>(initialRows);
  const [stale, setStale] = useState(false);
  const lastOk = useRef<number>(Date.now());
  // Held in a ref rather than in state: the merge reads it on every arrival, and a
  // stale closure over the row list would silently re-add rows already on screen.
  const known = useRef<Set<string>>(new Set(initialRows.map((row) => row.replayKey)));

  useEffect(() => {
    let cancelled = false;

    const markFresh = (): void => {
      lastOk.current = Date.now();
      setStale(false);
    };

    /**
     * Adds rows the reader has not seen, newest first, capped at `limit`.
     *
     * Deduplicated on the replay key, which is the identity both mechanisms carry,
     * so the stream and the poll delivering the same settlement is a no-op rather
     * than a duplicated row. That happens routinely: both are running at once.
     */
    const merge = (incoming: readonly SettlementRowView[]): void => {
      const fresh = incoming.filter((row) => !known.current.has(row.replayKey));
      if (fresh.length === 0) return;
      for (const row of fresh) known.current.add(row.replayKey);
      setRows((current) => [...fresh, ...current].slice(0, limit));
    };

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/settlements?chainKey=${chainKey}&limit=${limit}`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const body = (await response.json()) as { settlements?: readonly WireRow[] };
        if (cancelled || body.settlements === undefined) return;
        markFresh();
        merge(body.settlements.map(toRowView));
      } catch {
        // A failed poll is not reported on its own. The staleness check below is
        // what tells the reader, and it fires only when nothing has worked for a
        // while, so one dropped request does not flash a warning.
      }
    };

    let source: EventSource | undefined;
    try {
      source = new EventSource(`/api/stream?chainKey=${chainKey}`);
      source.addEventListener("hello", markFresh);
      source.addEventListener("settlement", (event: MessageEvent<string>) => {
        if (cancelled) return;
        try {
          markFresh();
          merge([toRowView(JSON.parse(event.data) as WireRow)]);
        } catch {
          // A frame this build cannot read is skipped. The poll carries the same
          // rows, so nothing is lost by ignoring it.
        }
      });
      // No reconnect logic: `EventSource` reconnects on its own, and the poll
      // covers the gap while it does.
    } catch {
      source = undefined;
    }

    const pollTimer = setInterval(() => void poll(), POLL_MS);
    const staleTimer = setInterval(() => {
      if (Date.now() - lastOk.current > STALE_AFTER_MS) setStale(true);
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      clearInterval(staleTimer);
      source?.close();
    };
  }, [chainKey, limit]);

  return (
    <>
      {/*
        `aria-live="polite"` so a settlement arriving while a reader is on the page
        is announced rather than appearing silently (R24.6).
      */}
      <div aria-live="polite">
        <SettlementTable
          caption={caption}
          rows={rows}
          hrefFor={hrefFor}
          explorerHrefFor={explorerHrefFor}
        />
      </div>
      {stale ? (
        <p role="status" className="font-mono text-xs text-muted-foreground">
          This feed has not updated for more than {Math.round(STALE_AFTER_MS / 1000)} seconds. The
          rows above may be behind the chain. Reload to read the feed again.
        </p>
      ) : null}
    </>
  );
}

/** The wire row as the table takes it. Amounts become `bigint` and never a float. */
function toRowView(row: WireRow): SettlementRowView {
  return {
    replayKey: row.replayKey,
    chainKey: Number(row.chainKey),
    blockHeight: BigInt(row.sourceBlockHeight),
    txIndex: BigInt(row.sourceTxIndex),
    logIndex: BigInt(row.sourceLogIndex),
    agent: row.agent,
    serviceId: row.serviceId,
    asset: assetUnitFor(row.asset),
    amountBaseUnits: BigInt(row.amount),
    // A row arriving live has no clearing lineage attached, and design section 6.1
    // draws `None -> Confirmed` for a Settlement that never had a provisional
    // stage, so that is what a fresh Verified Settlement is.
    clearing: "confirmed",
  };
}
