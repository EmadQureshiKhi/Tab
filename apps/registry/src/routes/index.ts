/**
 * The read router: the three read surfaces of task 18.2, mounted as one.
 *
 * Nothing here decides anything. Each surface owns its own module and its own
 * reasoning: `settlements.ts` for the Settlement feed and the settlement detail,
 * `services.ts` for the directory and the timelock rule, `agents.ts` for
 * credit, and this file exists so `server.ts` mounts one thing instead of three,
 * and so a caller reading the routing has a single place to see the whole shape.
 *
 * ## The surface
 *
 * | Route | Answers |
 * | --- | --- |
 * | `GET /settlements` | cursor-paginated Settlements, newest first |
 * | `GET /settlements/:settlementId` | one Settlement and the transaction that paid it |
 * | `GET /services` | cursor-paginated Service directory |
 * | `GET /services/:serviceId` | one Service, with any pending change and its ETA, and the operator's ERC-8004 identity |
 * | `GET /agents` | cursor-paginated Agents by most recent Settlement |
 * | `GET /agents/:agent` | Credit Limit, Open Tab, headroom, delinquency, ERC-8004 identity, Nansen labels |
 *
 * Every one is a read. Nothing on this router writes, and nothing takes a
 * signature: the rows restate public chain facts that any node hands to anyone who
 * asks, so there is nothing to authenticate for. Stated here as well as in each
 * module because an unauthenticated network surface should be a decision a reviewer
 * finds, not an omission they discover.
 */

import { Hono } from "hono";

import type { CreditChainReader } from "../chain-reads.js";
import type { IdentityDependencies } from "../identity-service.js";
import type { LabelSource } from "../nansen.js";
import type { RegistryReads } from "../queries.js";
import { createAgentRoutes } from "./agents.js";
import { createServiceRoutes } from "./services.js";
import { createSettlementRoutes } from "./settlements.js";

export { createAgentRoutes } from "./agents.js";
export { createServiceRoutes } from "./services.js";
export { createSettlementRoutes } from "./settlements.js";

export interface ReadRouteOptions {
  readonly chain?: CreditChainReader | undefined;
  readonly identity?: IdentityDependencies | undefined;
  readonly labels?: LabelSource | undefined;
}

/** Every read endpoint, on one router. */
export function createReadRoutes(reads: RegistryReads, options: ReadRouteOptions = {}): Hono {
  const app = new Hono();
  app.route("/", createSettlementRoutes(reads));
  app.route("/", createServiceRoutes(reads, { chain: options.chain, identity: options.identity }));
  app.route("/", createAgentRoutes(reads, options));
  return app;
}
