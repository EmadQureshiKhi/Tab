/**
 * The Hono surface: the two probes a container host needs, and the read API.
 *
 * The probes came with the indexer in task 18.1. The reads are task 18.2 and mount
 * here, on the same app and the same port, because they answer from the same
 * database the indexer writes and a second listener would only add a second thing
 * to configure and monitor. `routes/index.ts` carries the route table.
 *
 * Everything on this app is unauthenticated by design and all of it is safe that
 * way: every field either restates a public chain fact that any node hands to
 * anyone who asks, or reports this process's own liveness, and nothing anywhere is
 * writable. There is therefore nothing here to authenticate *for* — worth stating
 * explicitly, because an unauthenticated network surface should always be a
 * decision rather than an omission. What it does mean is that the deployment is
 * responsible for rate limiting at its edge, since this app implements none; page
 * sizes are capped but request volume is not.
 *
 * Requirements: 12.6, 24.1, 24.3, 24.4, 24.7, 11.8, 11.9
 */

import { Hono } from "hono";

import type { RegistryReads } from "./queries.js";
import type { CreditChainReader } from "./chain-reads.js";
import type { Classifier } from "./adoption.js";
import { createAdoptionRoutes } from "./routes/adoption.js";
import { createReadRoutes } from "./routes/index.js";
import type { IndexerStatus } from "./service.js";

export interface ServerDependencies {
  /** The indexer's own view of itself. */
  status: () => IndexerStatus;
  /** True when the database answers. */
  databaseReachable: () => Promise<boolean>;
  /**
   * The read side's own database handle.
   *
   * Injected rather than opened here, so the tests drive the real queries against a
   * real server through the same code path the process uses. Its pool is separate
   * from the indexer's on purpose: the indexer is a single writer whose transactions
   * must not queue behind a slow read.
   */
  readonly reads: RegistryReads;
  /**
   * Creditcoin reads, for the Credit Limit and Bond cross-checks.
   *
   * Optional because a figure is withheld rather than approximated when it cannot
   * be checked: a process with no endpoint serves the reasoned absence, and every
   * other read on this service still answers. The tests exercise both shapes.
   */
  readonly chain?: CreditChainReader;
  readonly buildInfo?: { readonly version: string; readonly commit: string };
  /**
   * The adoption classifier, when the allowlist could be read.
   *
   * Optional so a deployment that cannot read `team-addresses.json` serves everything
   * else rather than failing to start. `/adoption` is then absent, which is the right
   * failure: mounting it under an empty allowlist would report every address as
   * external and publish a flattering number with no basis.
   */
  readonly adoption?: { readonly classifier: Classifier; readonly allowlistPath: string };
}

export function createApp(deps: ServerDependencies): Hono {
  const app = new Hono();

  /**
   * Liveness. 200 whenever the process is up, even mid-catch-up and even while the
   * database is unreachable — a host that restarts a healthy process for a
   * transient database fault turns one fault into two.
   */
  app.get("/healthz", (c) => {
    const status = deps.status();
    return c.json({
      status: status.consecutiveFailures === 0 ? "ok" : "degraded",
      indexer: status,
      buildInfo: deps.buildInfo ?? null,
    });
  });

  /**
   * Readiness. 503 until the database answers and at least one tick has completed,
   * so a replica mid-cold-start is never routed to and no caller sees an empty
   * result set that looks like an answer.
   */
  app.get("/readyz", async (c) => {
    const status = deps.status();
    const reachable = await deps.databaseReachable();
    const ready = reachable && status.primed;
    return c.json(
      {
        ready,
        databaseReachable: reachable,
        primed: status.primed,
        lastBlock: status.lastBlock,
        head: status.head,
        caughtUp: status.caughtUp,
      },
      ready ? 200 : 503,
    );
  });

  // The read API. Mounted at the root beside the probes rather than under a version
  // prefix: this service is deployed and consumed as one unit by the Dashboard, and
  // a prefix that nothing ever varies is a path segment every caller has to repeat
  // for no benefit.
  app.route("/", createReadRoutes(deps.reads, deps.chain));
  if (deps.adoption !== undefined) {
    app.route("/", createAdoptionRoutes(deps.reads, deps.adoption.classifier, deps.adoption.allowlistPath));
  }

  return app;
}
