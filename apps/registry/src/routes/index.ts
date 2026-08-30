/**
 * The read router: the three read surfaces of task 18.2, mounted as one.
 *
 * Nothing here decides anything. Each surface owns its own module and its own
 * reasoning — `settlements.ts` for the Verified Settlement feed and the replay-key
 * detail, `services.ts` for the directory and the timelock rule, `agents.ts` for
 * credit — and this file exists so `server.ts` mounts one thing instead of three,
 * and so a caller reading the routing has a single place to see the whole shape.
 *
 * ## The surface
 *
 * | Route | Answers |
 * | --- | --- |
 * | `GET /settlements` | cursor-paginated Verified Settlements, newest first (R24.4) |
 * | `GET /settlements/:replayKey` | one Settlement and its clearing lineage |
 * | `GET /services` | cursor-paginated Service directory (R24.3) |
 * | `GET /services/:serviceId` | one Service, with any pending change and its ETA (R11.8, R11.9) |
 * | `GET /agents` | cursor-paginated Agents by most recent Settlement |
 * | `GET /agents/:agent` | Credit Limit, Open Tab, headroom, delinquency (R24.1) |
 *
 * Every one is a read. Nothing on this router writes, and nothing takes a
 * signature: the rows restate public chain facts that any node hands to anyone who
 * asks, so there is nothing to authenticate for. Stated here as well as in each
 * module because an unauthenticated network surface should be a decision a reviewer
 * finds, not an omission they discover.
 *
 * Requirements: 24.1, 24.3, 24.4, 24.7, 11.8, 11.9
 */

import { Hono } from "hono";

import type { CreditChainReader } from "../chain-reads.js";
import type { RegistryReads } from "../queries.js";
import { createAgentRoutes } from "./agents.js";
import { createServiceRoutes } from "./services.js";
import { createSettlementRoutes } from "./settlements.js";

export { createAgentRoutes } from "./agents.js";
export { createServiceRoutes } from "./services.js";
export { createSettlementRoutes } from "./settlements.js";

/** Every read endpoint, on one router. */
export function createReadRoutes(reads: RegistryReads, chain?: CreditChainReader): Hono {
  const app = new Hono();
  app.route("/", createSettlementRoutes(reads));
  app.route("/", createServiceRoutes(reads, chain));
  app.route("/", createAgentRoutes(reads, chain));
  return app;
}
