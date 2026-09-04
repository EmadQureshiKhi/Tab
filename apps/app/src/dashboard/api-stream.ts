/**
 * `/api/stream`: Verified Settlements pushed as they are indexed.
 *
 * ## The requirement is freshness, not the transport
 *
 * R24.6 asks that a `SettlementRecorded` reach a reader within 30 seconds. Server
 * sent events are how that is done when the network allows it, and a 15-second
 * poll on the client is how it is still done when the network does not. Corporate
 * proxies and some CDNs buffer or drop long-lived responses, and a page whose
 * freshness claim silently depended on that not happening would be making a claim
 * about somebody else's network.
 *
 * So the client runs both, and the fallback is not a degraded mode bolted on: the
 * poll is what actually satisfies the requirement in the worst case, and the
 * stream is the optimisation that usually beats it.
 *
 * ## Why the server polls the index rather than listening to the chain
 *
 * The Dashboard has no subscription to Creditcoin and should not open one. The
 * registry is already following the chain, writing rows as it goes, and its cursor
 * is a total order over `(block, logIndex)`. Watching that order advance is
 * therefore the same information one step later, without a second consumer of the
 * node's websocket and without this process holding chain state of its own.
 *
 * ## Nothing here is a subscription to a client
 *
 * Each connection polls on its own interval and pushes what it has not sent yet,
 * so there is no shared broker, no fan-out registry, and nothing to leak when a
 * reader closes the tab. The cost is one registry read per connection per tick,
 * which is the right trade for a Dashboard and would be the wrong one for a
 * high-fanout service.
 *
 * Requirements: 24.6, 24.9
 */

import type { Result } from "@tabai/shared";

import type { RegistryClient, SettlementRow, SettlementsPage } from "./client.js";
import { parseChainKeyParam, CHAIN_QUERY_PARAM } from "./chains.js";
import type { SettlementsRouteQuery } from "./api-settlements.js";

/**
 * How often the server checks the index for new rows.
 *
 * Half the 15-second client fallback, so a reader on the stream sees a row
 * sooner than a reader who fell back to polling, and comfortably inside the
 * 30-second freshness requirement even if a tick is missed entirely.
 */
export const STREAM_POLL_MS = 5_000;

/** How often a client that has fallen back to polling re-reads the feed (R24.6). */
export const CLIENT_POLL_MS = 15_000;

/**
 * How often a comment is sent when nothing has happened.
 *
 * An idle SSE connection is indistinguishable from a dead one to every proxy in
 * the path, and the usual outcome is a silent close after some unknowable idle
 * timeout. A comment line is ignored by `EventSource` and keeps the connection
 * observably alive.
 */
export const HEARTBEAT_MS = 20_000;

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  // Named for the proxies that buffer by default. Without it a stream can be held
  // until the response ends, which for a stream is never.
  "x-accel-buffering": "no",
  connection: "keep-alive",
} as const;

/** One SSE frame, already terminated. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** An SSE comment, which `EventSource` ignores. Used as the heartbeat. */
export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

/**
 * Rows this reader has not been sent yet, newest-first input, oldest-first output.
 *
 * The registry serves newest first, which is right for a table and wrong for a
 * stream: a reader appending frames in arrival order would end up with the feed
 * upside down. So the new rows are reversed here, at the one point that knows
 * both what arrived and what came before.
 */
export function unsentRows(
  page: readonly SettlementRow[],
  seen: ReadonlySet<string>,
): readonly SettlementRow[] {
  const fresh = page.filter((row) => !seen.has(row.replayKey));
  return [...fresh].reverse();
}

/** What one tick of the stream produced. */
export interface StreamTick {
  readonly frames: readonly string[];
  readonly seen: ReadonlySet<string>;
}

/**
 * One tick: read the head of the feed, and frame whatever is new.
 *
 * Pure apart from the injected read, so the interesting behaviour - what counts as
 * new, what order frames go out in, and what happens when the registry is down -
 * is tested without a server, a client, or a clock.
 *
 * A failed read emits an `error` frame rather than closing the stream. The reader
 * has a working fallback poll, and dropping the connection would make a transient
 * registry blip look like a dead feed.
 */
export async function streamTick(
  read: () => Promise<Result<SettlementsPage>>,
  seen: ReadonlySet<string>,
  options: { readonly first: boolean },
): Promise<StreamTick> {
  const page = await read();
  if (!page.ok) {
    return { frames: [sseFrame("error", { error: page.error })], seen };
  }

  const next = new Set(seen);
  for (const row of page.value.settlements) next.add(row.replayKey);

  // The first tick establishes what the reader already has without replaying the
  // backlog as if it were live: the page is server-rendered with these rows
  // already on it, so pushing them again would duplicate every row on connect.
  if (options.first) {
    return {
      frames: [sseFrame("hello", { index: page.value.index, known: page.value.settlements.length })],
      seen: next,
    };
  }

  const frames = unsentRows(page.value.settlements, seen).map((row) => sseFrame("settlement", row));
  return { frames, seen: next };
}

/** The read one connection repeats, bound to the chain it was opened for. */
export function streamReader(
  registry: RegistryClient,
  query: SettlementsRouteQuery,
): () => Promise<Result<SettlementsPage>> {
  const chainKey = parseChainKeyParam(query.get(CHAIN_QUERY_PARAM));
  // A small page: this is the head of a feed, not a backfill, and a reader who has
  // been away long enough to miss more than this is better served by reloading.
  return () => registry.settlements({ chainKey, limit: 25 });
}
