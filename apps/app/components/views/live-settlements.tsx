"use client";

/**
 * `LiveSettlements` - the ticker, kept fresh within 30 seconds.
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
 * `hello` that establishes what the reader already has rather than resending
 * it, which is why connecting does not duplicate every visible row.
 *
 * ## Degrading honestly
 *
 * If both mechanisms fail the component says the feed is not updating rather than
 * showing a stale list as though it were live. A ticker that quietly stops is
 * worse than one that admits it, because the reader cannot tell the difference
 * between a quiet chain and a broken page.
 */

import { useEffect, useRef, useState } from "react";

import { assetUnitFor, registerAsset } from "../custom-ui/format";
import { SettlementTable, type SettlementRowView } from "./settlement-table";

/** How often the fallback poll re-reads the feed. Mirrors `CLIENT_POLL_MS`. */
const POLL_MS = 15_000;

/** How long without any successful read before the feed admits it is not updating. */
const STALE_AFTER_MS = 45_000;

/** An Asset the server knows and the client would otherwise not, such as the Testnet mock token. */
export interface KnownAssetView {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * Everything this island needs, and all of it serialisable.
 *
 * The two link builders are deliberately **not** props. A function cannot cross
 * the server-to-client boundary, so passing `hrefFor` down from the page would
 * typecheck and then fail at runtime the moment the island rendered. The base URL
 * is data, it serialises, and the links are built here.
 */
export interface LiveSettlementsProps {
  /** Rows from the server render. The component starts correct and never fetches on mount. */
  readonly initialRows: readonly SettlementRowView[];
  readonly caption: string;
  /** Monad explorer base, resolved on the server from the environment contract. */
  readonly explorerBaseUrl: string;
  /** Rows kept on screen. The feed is a head, not a backfill. */
  readonly limit?: number | undefined;
  /**
   * Assets to name that the client's own table does not carry, such as the
   * Testnet mock token from the deployment table. A live row in that token would
   * otherwise render as an address at zero decimals.
   */
  readonly knownAssets?: readonly KnownAssetView[] | undefined;
}

/** The wire row `/api/settlements` and the stream both carry: the registry's own shape. */
interface WireRow {
  readonly settlementId: string;
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: string;
  readonly applied: string;
  readonly toPrepaid: string;
  readonly monad: {
    readonly blockNumber: number;
    readonly txHash: string;
  };
}

export function LiveSettlements({
  initialRows,
  caption,
  explorerBaseUrl,
  limit = 10,
  knownAssets = [],
}: LiveSettlementsProps) {
  const hrefFor = (settlementId: string): string => `/explorer/${settlementId}`;
  const explorerHrefFor = (txHash: string): string =>
    `${explorerBaseUrl.replace(/\/+$/, "")}/tx/${txHash}`;

  // Registered during render rather than in an effect, so the first live row
  // decoded after mount already knows the token. It is idempotent.
  for (const asset of knownAssets) {
    registerAsset(asset.address, { symbol: asset.symbol, decimals: asset.decimals });
  }

  const [rows, setRows] = useState<readonly SettlementRowView[]>(initialRows);
  const [stale, setStale] = useState(false);
  const lastOk = useRef<number>(Date.now());
  // Held in a ref rather than in state: the merge reads it on every arrival, and a
  // stale closure over the row list would silently re-add rows already on screen.
  const known = useRef<Set<string>>(new Set(initialRows.map((row) => row.settlementId)));

  useEffect(() => {
    let cancelled = false;

    const markFresh = (): void => {
      lastOk.current = Date.now();
      setStale(false);
    };

    /**
     * Adds rows the reader has not seen, newest first, capped at `limit`.
     *
     * Deduplicated on the settlement id, which is the identity both mechanisms
     * carry, so the stream and the poll delivering the same settlement is a no-op
     * rather than a duplicated row. That happens routinely: both are running at
     * once.
     */
    const merge = (incoming: readonly SettlementRowView[]): void => {
      const fresh = incoming.filter((row) => !known.current.has(row.settlementId));
      if (fresh.length === 0) return;
      for (const row of fresh) known.current.add(row.settlementId);
      setRows((current) => [...fresh, ...current].slice(0, limit));
    };

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/settlements?limit=${limit}`, { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { settlements?: readonly WireRow[] };
        if (cancelled || body.settlements === undefined) return;
        markFresh();
        merge(body.settlements.map(toRowView).filter(isRowView));
      } catch {
        // A failed poll is not reported on its own. The staleness check below is
        // what tells the reader, and it fires only when nothing has worked for a
        // while, so one dropped request does not flash a warning.
      }
    };

    let source: EventSource | undefined;
    try {
      source = new EventSource("/api/stream");
      source.addEventListener("hello", markFresh);
      source.addEventListener("settlement", (event: MessageEvent<string>) => {
        if (cancelled) return;
        try {
          markFresh();
          const row = toRowView(JSON.parse(event.data) as WireRow);
          if (row !== undefined) merge([row]);
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
  }, [limit]);

  return (
    <>
      {/*
        `aria-live="polite"` so a settlement arriving while a reader is on the page
        is announced rather than appearing silently.
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

function isRowView(row: SettlementRowView | undefined): row is SettlementRowView {
  return row !== undefined;
}

/**
 * A `bytes32` Service id decoded as an ASCII name, or `undefined` where it is not
 * one. Mirrors `serviceNameOf` in the core, for the `rootDir` reason `format.ts`
 * gives: a live row arrives with the id only, and a name the server would have
 * shown for the same row should not vanish because this one came over the wire.
 */
function serviceNameOf(serviceId: string): string | undefined {
  const body = serviceId.startsWith("0x") ? serviceId.slice(2) : serviceId;
  if (body.length !== 64) return undefined;
  let text = "";
  for (let index = 0; index < body.length; index += 2) {
    const byte = Number.parseInt(body.slice(index, index + 2), 16);
    if (Number.isNaN(byte)) return undefined;
    if (byte === 0) break;
    if (byte < 0x20 || byte > 0x7e) return undefined;
    text += String.fromCharCode(byte);
  }
  return text.length === 0 ? undefined : text;
}

/** A decimal string to `bigint`, or `undefined` where it is not one. */
function toBigInt(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) return undefined;
  return BigInt(value.trim());
}

/**
 * The wire row as the table takes it. Amounts become `bigint` and never a float.
 *
 * A row whose figures will not convert is dropped rather than shown with zeroes,
 * for the same reason the server-side decoder drops one: a settlement a reader
 * cannot check against a block is worse than one they do not see.
 */
function toRowView(row: WireRow): SettlementRowView | undefined {
  const amount = toBigInt(row.amount);
  const applied = toBigInt(row.applied);
  const prepaid = toBigInt(row.toPrepaid);
  if (amount === undefined || applied === undefined || prepaid === undefined) return undefined;
  if (typeof row.settlementId !== "string" || typeof row.monad?.txHash !== "string") return undefined;
  const serviceName = serviceNameOf(row.serviceId);
  return {
    settlementId: row.settlementId.toLowerCase(),
    txHash: row.monad.txHash,
    blockNumber: Number(row.monad.blockNumber),
    agent: row.agent,
    serviceId: row.serviceId,
    ...(serviceName === undefined ? {} : { serviceName }),
    asset: assetUnitFor(row.asset),
    amountBaseUnits: amount,
    appliedBaseUnits: applied,
    prepaidBaseUnits: prepaid,
  };
}
