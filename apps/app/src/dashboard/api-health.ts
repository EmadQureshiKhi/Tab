/**
 * `/api/health`: build info, and whether the two upstreams answer.
 *
 * ## What this endpoint is, and what it deliberately is not
 *
 * It is a description, not a verdict. It answers "can this Dashboard reach the
 * things it reads from", and it returns 200 whenever it can answer at all, because
 * an operator looking at a broken upstream needs to see which one broke more than
 * they need a red status line. There is no readiness half here: the Dashboard
 * serves static content and read-only routes, and a route that renders a stated
 * "the registry could not be read" is still serving its purpose.
 *
 * ## A figure it could not obtain is never reported as a figure
 *
 * This is the rule `apps/watcher/src/health.ts` sets and the reason is the same
 * here. An unreachable upstream reported as a zero, an empty object or a default
 * reads exactly like a healthy upstream with nothing to say, and it will be
 * believed. So each upstream is `reachable: true` with its detail, or
 * `reachable: false` with the error that produced that answer, and never a
 * confident-looking blank.
 *
 * ## Unauthenticated, on purpose
 *
 * Everything below is public: a chain id, a block height, whether a public read API
 * answers, and the commit this build came from. There is nothing here to
 * authenticate for, and the endpoint says so rather than leaving a reviewer to
 * discover an omission. It carries no endpoint URL, because naming the registry's
 * origin or the RPC endpoint in a public body turns a deployment detail into
 * something every reader depends on.
 *
 * Requirements: 24.8, 24.9
 */

import type { Result } from "@tabai/shared";

import type { ChainReader } from "./chain.js";
import type { RouteResult } from "./api-settlements.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  // Reachability is a statement about this instant, so a cached answer is a wrong
  // answer rather than a slightly old one.
  "cache-control": "no-store",
} as const;

/** Build provenance, so a report can be tied to the code that produced it. */
export interface BuildInfo {
  readonly name: string;
  readonly version: string;
  /** `null` rather than "unknown": a development build has no commit, and saying so is honest. */
  readonly commit: string | null;
}

/** One upstream, and whether it answered. */
export interface UpstreamHealth {
  readonly name: string;
  readonly reachable: boolean;
  /** What it said when it answered. Absent when it did not. */
  readonly detail?: Readonly<Record<string, string | number>> | undefined;
  /** Why it did not answer. Absent when it did. */
  readonly unavailable?: { readonly code: string; readonly message: string } | undefined;
}

export interface HealthBody {
  readonly status: "ok" | "degraded";
  readonly checkedAt: string;
  readonly upstreams: readonly UpstreamHealth[];
  readonly build: BuildInfo;
}

/** What the registry's own `/healthz` says, reduced to what is safe to republish. */
export interface RegistryProbe {
  probe(): Promise<Result<{ readonly status: string; readonly lastBlock: number | null }>>;
}

export interface HealthOptions {
  readonly chain: ChainReader;
  readonly registry: RegistryProbe;
  readonly now?: () => Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Reads build provenance from the environment.
 *
 * Both variables are optional, and a missing commit is `null` rather than the
 * string "unknown", which would read like a revision and is not one.
 */
export function readBuildInfo(env: Readonly<Record<string, string | undefined>>): BuildInfo {
  const commit = env["TAB_BUILD_COMMIT"]?.trim();
  return {
    name: "@tabai/app",
    version: env["TAB_BUILD_VERSION"]?.trim() ?? "0.0.0",
    commit: commit !== undefined && commit.length > 0 ? commit : null,
  };
}

/**
 * Serves the health body.
 *
 * Never fails, and both upstreams are always probed: stopping at the first failure
 * would report the second as unknown when it might be the one still working, and
 * "which of the two is down" is the entire question this endpoint answers.
 */
export async function serveHealth(options: HealthOptions): Promise<RouteResult> {
  const now = options.now?.() ?? new Date();
  const env = options.env ?? (process.env as Readonly<Record<string, string | undefined>>);

  const [chainId, head, registry] = await Promise.all([
    options.chain.chainId(),
    options.chain.latestBlock(),
    options.registry.probe(),
  ]);

  const upstreams: UpstreamHealth[] = [];

  if (!chainId.ok) {
    upstreams.push({
      name: "creditcoin-rpc",
      reachable: false,
      unavailable: { code: chainId.error.code, message: chainId.error.message },
    });
  } else {
    upstreams.push({
      name: "creditcoin-rpc",
      reachable: true,
      detail: {
        chainId: chainId.value,
        // A reachable endpoint whose head could not be read is still reachable, so
        // the height is omitted rather than faked and the row stays truthful.
        ...(head.ok ? { latestBlock: head.value.number } : {}),
      },
    });
  }

  if (!registry.ok) {
    upstreams.push({
      name: "registry-read-api",
      reachable: false,
      unavailable: { code: registry.error.code, message: registry.error.message },
    });
  } else {
    upstreams.push({
      name: "registry-read-api",
      reachable: true,
      detail: {
        status: registry.value.status,
        ...(registry.value.lastBlock === null ? {} : { lastBlock: registry.value.lastBlock }),
      },
    });
  }

  const degraded = upstreams.some((upstream) => !upstream.reachable);

  return {
    status: 200,
    headers: JSON_HEADERS,
    body: {
      status: degraded ? "degraded" : "ok",
      checkedAt: now.toISOString(),
      upstreams,
      build: readBuildInfo(env),
    } satisfies HealthBody,
  };
}
