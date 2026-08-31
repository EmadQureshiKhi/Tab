/**
 * `@tabai/sdk` is the published client surface. It may draw on `@tabai/shared`
 * and on nothing else inside the workspace.
 *
 * Three surfaces, and the shape of the product is visible in how they relate:
 *
 * - **`payments/`** — the strategy seam. The interface a Settlement goes through,
 *   the Ethereum USDC strategy this package ships, and the three ways a consumer
 *   adds a strategy of their own without editing a file in here (R23.1, R23.6).
 * - **`http/`** — the wire contract and the Agent's side of it. `headers.ts` is the
 *   single definition of the `Tab-*` format, and `client-402.ts` is the post-paid
 *   402 client that reads it (R23.2).
 * - **`server/`** — the Service's side. `tabPostPaid` accrues after a delivery and
 *   never withholds a response, with adapters for Hono, Express, and Next.js
 *   (R23.3).
 * - **`proxy/`** - the Service's front door. `createTabProxy` forwards a request
 *   upstream under the metering plugin and runs hooks around it (R23.4), and
 *   `createAttestcoinProofHook` attaches the Verified Settlement that covers a
 *   proxied request (R23.5).
 *
 * **`http/headers.ts` is deliberately the only place the wire format exists.** The
 * client parses with it and the server formats with it, so the two halves cannot
 * drift apart without a test failing in one file — rather than mis-parsing silently
 * between two.
 *
 * Nothing exported from this package throws. Every fallible call returns a
 * `Result` from `@tabai/shared` (R21.5). The one exception is named and deliberate:
 * the Hono and Next.js adapters re-raise a handler's own thrown value, because a
 * framework's contract for a failed handler is an exception and the adapter is the
 * boundary where a `Result` becomes whatever the host expects.
 */

import { WORKSPACE_ID } from "@tabai/shared";

export const WORKSPACE_ID_SDK = "@tabai/sdk" as const;

export const SHARED_WORKSPACE_ID = WORKSPACE_ID;

export * from "./logger.js";
export * from "./errors.js";
export * from "./payments/index.js";
export * from "./http/index.js";
export * from "./server/index.js";
export * from "./proxy/index.js";
export * from "./mcp/index.js";
export * from "./cli/index.js";
