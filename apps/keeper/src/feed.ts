/**
 * The candidate tabs, from the registry's delivery feed.
 *
 * A tab exists from its first delivery and nothing else creates one, so the
 * distinct `(agent, serviceId, asset)` triples the feed has ever seen are every
 * tab there is. The walk follows the registry's own cursor to the end, because
 * a tab nobody marked stays open indefinitely and any recent-page shortcut
 * would miss precisely the oldest and most overdue rows, which are the ones a
 * keeper exists for.
 *
 * A bound on the page count keeps a runaway feed from holding a tick forever,
 * and hitting it is a failure rather than a shorter list: a silently short list
 * of overdue tabs reads as "none overdue", the one wrong answer this process
 * must never give.
 */

import { err, ok, type Result, type TabError } from "@tabai/shared";

import { distinctCandidates, type TabCandidate } from "./overdue.js";

/** The little of a `fetch` response this walker reads. */
export interface FeedResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type FeedFetch = (url: string, init: { readonly method: string; readonly headers: Record<string, string> }) => Promise<FeedResponse>;

export interface FeedOptions {
  readonly registryUrl: string;
  readonly fetchImpl?: FeedFetch | undefined;
  /** Pages per walk before it gives up. */
  readonly maxPages: number;
  /** Rows per page. The registry caps this; 100 is its maximum. */
  readonly pageSize?: number | undefined;
}

export interface FeedWalk {
  readonly candidates: readonly TabCandidate[];
  /** How many rows were read before de-duplication. */
  readonly rows: number;
  readonly pages: number;
}

const upstream = (code: string, message: string, cause?: unknown): TabError => ({
  category: "UPSTREAM",
  code,
  message,
  retryable: true,
  ...(cause === undefined ? {} : { cause: { code: "Error", message: cause instanceof Error ? cause.message : String(cause) } }),
});

const hostFetch = (): FeedFetch | undefined => {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as FeedFetch) : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Walks `GET /deliveries` to its end and names the distinct tabs. */
export async function walkDeliveryFeed(options: FeedOptions): Promise<Result<FeedWalk>> {
  const send = options.fetchImpl ?? hostFetch();
  if (send === undefined) return err(upstream("FETCH_UNAVAILABLE", "this host has no global fetch, so the delivery feed cannot be read"));
  const base = options.registryUrl.replace(/\/+$/, "");
  const pageSize = options.pageSize ?? 100;

  const candidates: TabCandidate[] = [];
  let rows = 0;
  let cursor: string | undefined;
  for (let page = 0; page < options.maxPages; page += 1) {
    const url = `${base}/deliveries?limit=${pageSize}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    let response: FeedResponse;
    try {
      response = await send(url, { method: "GET", headers: { accept: "application/json" } });
    } catch (cause) {
      return err(upstream("FEED_UNREACHABLE", `the delivery feed could not be reached at ${url}`, cause));
    }
    if (response.status !== 200) return err(upstream("FEED_STATUS", `the delivery feed answered HTTP ${response.status} for ${url}`));
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      return err(upstream("FEED_MALFORMED", "the delivery feed did not answer with JSON", cause));
    }
    if (!isRecord(body) || !Array.isArray(body["deliveries"])) {
      return err(upstream("FEED_MALFORMED", "the delivery feed answered without a deliveries array"));
    }
    for (const row of body["deliveries"]) {
      if (!isRecord(row)) return err(upstream("FEED_MALFORMED", "the delivery feed returned a row that is not an object"));
      const agent = row["agent"];
      const serviceId = row["serviceId"];
      const asset = row["asset"];
      if (typeof agent !== "string" || typeof serviceId !== "string" || typeof asset !== "string") {
        // One malformed row invalidates the walk: a keeper that skipped it would
        // never mark that tab and never say why.
        return err(upstream("FEED_MALFORMED", "the delivery feed returned a row without agent, serviceId and asset"));
      }
      rows += 1;
      candidates.push({ agent, serviceId, asset });
    }
    const next = body["nextCursor"];
    if (next === null || next === undefined) {
      return ok({ candidates: distinctCandidates(candidates), rows, pages: page + 1 });
    }
    if (typeof next !== "string") return err(upstream("FEED_MALFORMED", "the delivery feed returned a cursor that is not a string"));
    cursor = next;
  }
  return err(
    upstream(
      "FEED_TOO_LONG",
      `the delivery feed ran past ${options.maxPages} pages, so the candidate list would be incomplete; raise KEEPER_MAX_FEED_PAGES`,
    ),
  );
}
