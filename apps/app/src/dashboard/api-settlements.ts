/**
 * `/api/settlements`: the cursor-paginated feed the ticker and the explorer read.
 *
 * ## Why this exists when the registry already serves settlements
 *
 * Two reasons, and neither is proxying for its own sake. The browser must not be
 * pointed at the registry directly, because that would put the read API's origin
 * in every viewer's network tab and make the Dashboard's data source a
 * deployment detail a reader depends on. And the feed is the one place the chain
 * filter has to be *applied* rather than merely offered, so that a view can never
 * accidentally render Sepolia rows under a Mainnet heading.
 *
 * ## Framework-free by construction
 *
 * The handler is a pure function from a URL to a {@link RouteResult}: a status, a
 * set of headers, and a body. It builds no `Response` and imports nothing from a
 * framework, so the same function serves a Next.js route handler, a Hono route,
 * or a test, and `toResponse` is the one adapter that reaches for the host's
 * global. That is the shape `packages/sdk` already uses for its post-paid
 * plugin, for the same reason: the interesting logic should be testable without
 * standing up a server.
 *
 * ## The cursor is the registry's own
 *
 * Pagination is not re-implemented here. The registry's cursor is opaque, keyed
 * on `(block_number, log_index)`, and stable against rows written during a walk;
 * this route passes it through untouched in both directions. Re-deriving it
 * would be a second pagination scheme to keep in step with the first.
 *
 * Requirements: 24.4, 24.6, 24.9
 */

import { httpStatusOf, type Result, type TabError } from "@tabai/shared";

import type { RegistryClient, SettlementsPage } from "./client.js";
import { CHAIN_QUERY_PARAM, parseChainKeyParam } from "./chains.js";

/** What a route handler answers with, before any framework sees it. */
export interface RouteResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** Rows per page when the caller does not say. Matches the registry's own default. */
export const DEFAULT_PAGE_SIZE = 25;

/** Ceiling on rows per page, so an unauthenticated caller cannot ask for the world. */
export const MAX_PAGE_SIZE = 100;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  // The feed is a live view of an append-only index, so a cached page is a stale
  // page. `no-store` rather than a short max-age, because the ticker's whole job
  // is freshness (R24.6).
  "cache-control": "no-store",
} as const;

const validation = (code: string, message: string, field: string): TabError => ({
  category: "VALIDATION",
  code,
  message,
  retryable: false,
  details: { field },
});

/**
 * Reads `limit`, refusing anything outside the bound rather than clamping.
 *
 * A silently shortened page is indistinguishable from the end of a feed, which
 * is the same reasoning the registry's own `parsePageSize` records.
 */
export function parseLimit(raw: string | null): Result<number> {
  if (raw === null || raw.trim().length === 0) return { ok: true, value: DEFAULT_PAGE_SIZE };
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: validation("LIMIT_MALFORMED", "limit must be a whole number", "limit") };
  }
  const value = Number.parseInt(trimmed, 10);
  if (value < 1 || value > MAX_PAGE_SIZE) {
    return {
      ok: false,
      error: validation(
        "LIMIT_OUT_OF_RANGE",
        `limit must be between 1 and ${MAX_PAGE_SIZE}`,
        "limit",
      ),
    };
  }
  return { ok: true, value };
}

/** The query parameters this route reads, however the host spells a URL. */
export interface SettlementsRouteQuery {
  get(name: string): string | null;
}

export interface SettlementsRouteOptions {
  readonly registry: RegistryClient;
}

/**
 * Serves one page of Verified Settlements for one chain.
 *
 * The chain is always resolved, never optional: an absent or unreadable
 * `chainKey` becomes the default rather than an unfiltered feed, because a feed
 * mixing two chains is the one answer no view on this Dashboard wants. The
 * resolved chain is echoed in the body so a client can prove which chain it was
 * served, rather than assuming its request was honoured.
 */
export async function serveSettlements(
  options: SettlementsRouteOptions,
  query: SettlementsRouteQuery,
): Promise<RouteResult> {
  const chainKey = parseChainKeyParam(query.get(CHAIN_QUERY_PARAM));

  const limit = parseLimit(query.get("limit"));
  if (!limit.ok) {
    return { status: httpStatusOf(limit.error), headers: JSON_HEADERS, body: { error: limit.error } };
  }

  const cursor = query.get("cursor");
  const page: Result<SettlementsPage> = await options.registry.settlements({
    chainKey,
    limit: limit.value,
    ...(cursor === null || cursor.length === 0 ? {} : { cursor }),
  });

  if (!page.ok) {
    return { status: httpStatusOf(page.error), headers: JSON_HEADERS, body: { error: page.error } };
  }

  return {
    status: 200,
    headers: JSON_HEADERS,
    body: {
      // Echoed so a caller can check what it was actually served. An empty page
      // on chainKey 3 is a true statement about Mainnet, not a failed filter.
      chainKey,
      index: page.value.index,
      settlements: page.value.settlements,
      nextCursor: page.value.nextCursor,
    },
  };
}

/** The little of a web `Response` this module constructs. */
interface ResponseLike {
  new (body: string, init: { status: number; headers: Record<string, string> }): unknown;
}

/**
 * Turns a {@link RouteResult} into the host's `Response`.
 *
 * The single cast in this module, and the reason it is needed: this package
 * compiles against the ES2023 library alone, so the global `Response` has no
 * type here. A host without one is a programming error rather than a runtime
 * condition to handle, so this throws, and it is the only thing in the module
 * that can.
 */
export function toResponse(result: RouteResult): unknown {
  const ctor = (globalThis as { Response?: unknown }).Response;
  if (typeof ctor !== "function") {
    throw new Error("this host has no global Response, so a route handler cannot answer");
  }
  return new (ctor as unknown as ResponseLike)(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...result.headers },
  });
}
