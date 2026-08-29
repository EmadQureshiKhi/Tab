/**
 * The Watcher's health surface (R20.12).
 *
 * Two endpoints with deliberately different jobs.
 *
 * `/healthz` is a description, not a verdict. It answers "where is this process and
 * what is it holding" and returns 200 whenever it can answer at all, because an
 * operator reading a stuck cursor needs the numbers more than they need a red light.
 * The one thing it will not do is invent a figure: a count the database refused to
 * give is reported as `null` alongside the error that produced it, never as zero. A
 * zero and an unknown are different facts and only one of them is safe to page on.
 *
 * `/readyz` is a verdict, and it is narrow on purpose. It fails only for the single
 * condition that makes the process unable to do its job at all: a monitored Source
 * Chain with no cursor, which means a cold start has not yet established where to
 * resume from and any observation sweep would begin from an arbitrary height. A
 * lagging cursor is not unready, it is behind, and the difference matters to whoever
 * wired this to a restart loop.
 *
 * Neither endpoint authenticates, so neither may disclose anything an unauthenticated
 * caller should not see. That rules out endpoint URLs, key material, and the database
 * URL, and it is why the shape below carries counts and heights and nothing else.
 *
 * Requirements: 20.12
 */

import type { ChainKey, Result, TabError } from "@tabai/shared";
import { err, ok } from "@tabai/shared";

import type { WatcherDb } from "./db/client.js";
import { countByClearingState, countByState, loadReadCursors } from "./db/observation-store.js";
import { SETTLEMENT_STATES, type SettlementState } from "./state.js";

/** Where one monitored Source Chain has been read to. */
export interface ChainHealth {
  readonly chainKey: ChainKey;
  /** Last block the observation sweep committed, as a decimal string. */
  readonly lastProcessedBlock: string;
  /** Whether the chain was attesting the last time discovery ran. */
  readonly attesting: boolean;
}

/**
 * A figure the snapshot could not obtain, carried as a reason rather than a zero.
 */
export interface UnavailableFigure {
  readonly code: string;
  readonly message: string;
}

/** Build provenance, so a report can be tied to the code that produced it. */
export interface BuildInfo {
  readonly name: string;
  readonly version: string;
  readonly commit: string | null;
  readonly nodeVersion: string;
}

/** Everything `/healthz` reports. */
export interface HealthSnapshot {
  readonly status: "ok" | "degraded";
  readonly observedAt: string;
  readonly uptimeSeconds: number;
  readonly chains: readonly ChainHealth[];
  /** Monitored chains that have no cursor row at all, so cannot be resumed. */
  readonly chainsWithoutCursor: readonly ChainKey[];
  /** Rows awaiting submission: OBSERVED, PROVISIONAL and READY together. */
  readonly pendingSubmissions: number | null;
  /** Clearings in `APPLIED`, which are the ones still exposed to reversal. */
  readonly activeProvisionalClearings: number | null;
  /** Rows held out of spending because a local re-derivation disagreed (R20.5). */
  readonly withheldProofs: number | null;
  /** Rows an operator must resolve by hand. */
  readonly haltedSettlements: number | null;
  readonly settlementsByState: Readonly<Partial<Record<SettlementState, number>>> | null;
  /** Populated only where a figure above is `null`. */
  readonly unavailable: readonly UnavailableFigure[];
  readonly build: BuildInfo;
}

/** Everything `/readyz` reports. */
export interface ReadinessSnapshot {
  readonly ready: boolean;
  readonly observedAt: string;
  readonly monitoredChains: readonly ChainKey[];
  readonly chainsWithoutCursor: readonly ChainKey[];
  /** Present when readiness could not be decided, which is itself not ready. */
  readonly reason: string | null;
}

/** States whose rows are still waiting for the submission sweep to act on them. */
const PENDING_STATES: readonly SettlementState[] = ["OBSERVED", "PROVISIONAL", "READY"];

/**
 * Read build provenance from the environment.
 *
 * The commit is optional because a development run has none, and reporting `null`
 * is more honest than reporting the string "unknown" as though it were a revision.
 */
export function readBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const commit = env.TAB_BUILD_COMMIT?.trim();
  return {
    name: "@tabai/watcher",
    version: env.TAB_BUILD_VERSION?.trim() ?? "0.0.0",
    commit: commit !== undefined && commit.length > 0 ? commit : null,
    nodeVersion: process.version,
  };
}

/** What the snapshot builders need, so tests can supply it without a database. */
export interface HealthDeps {
  readonly db: WatcherDb;
  /** Chains this deployment is configured to observe. */
  readonly monitoredChains: readonly ChainKey[];
  readonly now?: () => Date;
  readonly uptimeSeconds?: () => number;
  readonly env?: NodeJS.ProcessEnv;
}

function sumStates(
  counts: Readonly<Partial<Record<SettlementState, number>>>,
  states: readonly SettlementState[],
): number {
  let total = 0;
  for (const state of states) total += counts[state] ?? 0;
  return total;
}

/**
 * Build the `/healthz` body.
 *
 * Never fails. A database that refuses a count degrades the report rather than
 * ending it, because the cursor heights remain informative when the counts do not.
 */
export async function buildHealthSnapshot(deps: HealthDeps): Promise<HealthSnapshot> {
  const now = deps.now?.() ?? new Date();
  const uptimeSeconds = Math.round(deps.uptimeSeconds?.() ?? process.uptime());
  const unavailable: UnavailableFigure[] = [];

  const cursors = await loadReadCursors(deps.db);
  let chains: ChainHealth[] = [];
  let seen: readonly ChainKey[] = [];
  if (cursors.ok) {
    chains = cursors.value
      .filter((cursor) => deps.monitoredChains.includes(cursor.chainKey))
      .map((cursor) => ({
        chainKey: cursor.chainKey,
        lastProcessedBlock: cursor.lastProcessedBlock.toString(),
        attesting: cursor.attesting,
      }))
      .sort((left, right) => left.chainKey - right.chainKey);
    seen = chains.map((chain) => chain.chainKey);
  } else {
    unavailable.push({ code: cursors.error.code, message: cursors.error.message });
  }
  const chainsWithoutCursor = cursors.ok
    ? deps.monitoredChains.filter((chainKey) => !seen.includes(chainKey))
    : [];

  const byState = await countByState(deps.db);
  let settlementsByState: Readonly<Partial<Record<SettlementState, number>>> | null = null;
  if (byState.ok) settlementsByState = byState.value;
  else unavailable.push({ code: byState.error.code, message: byState.error.message });

  const byClearing = await countByClearingState(deps.db);
  let activeProvisionalClearings: number | null = null;
  if (byClearing.ok) activeProvisionalClearings = byClearing.value.APPLIED ?? 0;
  else unavailable.push({ code: byClearing.error.code, message: byClearing.error.message });

  // A missing cursor is a real fault the operator should see in `/healthz` too, even
  // though only `/readyz` refuses traffic for it.
  const degraded =
    unavailable.length > 0 || chainsWithoutCursor.length > 0 || (settlementsByState?.HALTED ?? 0) > 0;

  return {
    status: degraded ? "degraded" : "ok",
    observedAt: now.toISOString(),
    uptimeSeconds,
    chains,
    chainsWithoutCursor,
    pendingSubmissions: settlementsByState === null ? null : sumStates(settlementsByState, PENDING_STATES),
    activeProvisionalClearings,
    withheldProofs: settlementsByState === null ? null : (settlementsByState.WITHHELD ?? 0),
    haltedSettlements: settlementsByState === null ? null : (settlementsByState.HALTED ?? 0),
    settlementsByState,
    unavailable,
    build: readBuildInfo(deps.env),
  };
}

/**
 * Build the `/readyz` body.
 *
 * A cursor read that fails is reported as not ready. The endpoint's whole claim is
 * "every monitored chain has somewhere to resume from", and a failed read cannot
 * support that claim, so it must not be answered with a green light.
 */
export async function buildReadinessSnapshot(deps: HealthDeps): Promise<ReadinessSnapshot> {
  const now = deps.now?.() ?? new Date();
  const cursors = await loadReadCursors(deps.db);
  if (!cursors.ok) {
    return {
      ready: false,
      observedAt: now.toISOString(),
      monitoredChains: deps.monitoredChains,
      chainsWithoutCursor: [],
      reason: `${cursors.error.code}: ${cursors.error.message}`,
    };
  }
  const seen = cursors.value.map((cursor) => cursor.chainKey);
  const missing = deps.monitoredChains.filter((chainKey) => !seen.includes(chainKey));
  return {
    ready: missing.length === 0,
    observedAt: now.toISOString(),
    monitoredChains: deps.monitoredChains,
    chainsWithoutCursor: missing,
    reason: missing.length === 0 ? null : `no chain_cursor row for chainKey ${missing.join(", ")}`,
  };
}

/** One resolved HTTP answer: the status line and the body, already serialised. */
export interface HealthResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType: "application/json";
}

const NOT_FOUND: HealthResponse = {
  status: 404,
  body: JSON.stringify({ ok: false, code: "NOT_FOUND", message: "no such endpoint" }),
  contentType: "application/json",
};

const METHOD_NOT_ALLOWED: HealthResponse = {
  status: 405,
  body: JSON.stringify({ ok: false, code: "METHOD_NOT_ALLOWED", message: "GET only" }),
  contentType: "application/json",
};

/**
 * Route one request. Separated from the server so the routing is testable without
 * binding a port, and so the server file holds no logic worth testing.
 */
export async function routeHealthRequest(
  method: string | undefined,
  url: string | undefined,
  deps: HealthDeps,
): Promise<HealthResponse> {
  const path = (url ?? "/").split("?")[0];
  if (path !== "/healthz" && path !== "/readyz") return NOT_FOUND;
  if (method !== "GET" && method !== "HEAD") return METHOD_NOT_ALLOWED;

  if (path === "/healthz") {
    const snapshot = await buildHealthSnapshot(deps);
    return { status: 200, body: JSON.stringify(snapshot), contentType: "application/json" };
  }
  const snapshot = await buildReadinessSnapshot(deps);
  return {
    status: snapshot.ready ? 200 : 503,
    body: JSON.stringify(snapshot),
    contentType: "application/json",
  };
}

/** A bound health server, and the way to stop it. */
export interface HealthServer {
  readonly port: number;
  close: () => Promise<void>;
}

/**
 * Bind the health server.
 *
 * `node:http` rather than a framework, because two unauthenticated GET routes do
 * not earn a dependency, and because the Watcher is the process that must not gain
 * surface area: it is the only component holding a key that spends CTC.
 */
export async function startHealthServer(
  deps: HealthDeps,
  options: { readonly port?: number; readonly host?: string } = {},
): Promise<Result<HealthServer>> {
  const http = await import("node:http");
  const port = options.port ?? Number(deps.env?.WATCHER_HEALTH_PORT ?? process.env.WATCHER_HEALTH_PORT ?? 8081);
  const host = options.host ?? "0.0.0.0";

  const server = http.createServer((request, response) => {
    void routeHealthRequest(request.method, request.url, deps)
      .then((answer) => {
        response.writeHead(answer.status, {
          "content-type": answer.contentType,
          "cache-control": "no-store",
        });
        response.end(request.method === "HEAD" ? undefined : answer.body);
      })
      .catch((cause: unknown) => {
        // Unreachable by construction: every builder above returns rather than throws.
        // Kept because an unhandled rejection inside a request handler would otherwise
        // take the whole Watcher process down, and a health endpoint must never be the
        // thing that kills the process it reports on.
        const message = cause instanceof Error ? cause.message : String(cause);
        response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: false, code: "HEALTH_HANDLER_FAILED", message }));
      });
  });

  const bound = await new Promise<Result<number>>((resolve) => {
    server.once("error", (cause: NodeJS.ErrnoException) => {
      const error: TabError = {
        category: "UNAVAILABLE",
        code: cause.code === "EADDRINUSE" ? "HEALTH_PORT_IN_USE" : "HEALTH_LISTEN_FAILED",
        message: `health server could not bind ${host}:${port}: ${cause.message}`,
        retryable: false,
      };
      resolve(err(error));
    });
    server.listen(port, host, () => {
      const address = server.address();
      resolve(ok(typeof address === "object" && address !== null ? address.port : port));
    });
  });
  if (!bound.ok) return bound;

  return ok({
    port: bound.value,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  });
}
