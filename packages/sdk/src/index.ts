/**
 * `@tabai/sdk` is the published client surface. It may draw on `@tabai/shared`
 * and on nothing else inside the workspace.
 *
 * Six surfaces, and the shape of the product is visible in how they relate:
 *
 * - **`payments/`** - the strategy seam. The interface a Settlement goes through,
 *   the Monad strategy this package ships, and the three ways a consumer adds a
 *   strategy of their own without editing a file in here.
 * - **`http/`** - the wire contract and the Agent's side of it. `headers.ts` is the
 *   single definition of the `Tab-*` format, and `client-402.ts` is the post-paid
 *   402 client that reads it.
 * - **`server/`** - the Service's side. `tabPostPaid` accrues after a delivery and
 *   never withholds a response, with adapters for Hono, Express, and Next.js.
 * - **`proxy/`** - the Service's front door. `createTabProxy` forwards a request
 *   upstream under the metering plugin and runs hooks around it, and a
 *   hook can attach the Settlement that covers a proxied request.
 * - **`x402/`** - the prepaid protocol beside the credit one. A Tab `402` can
 *   offer an x402 payment for the one call it refused, an Agent with an x402
 *   signer can take it, and a Service can front an x402 upstream and meter the
 *   Agent for what it paid.
 * - **`signers/`** - where an Agent's key can live other than in its own
 *   environment. `createPrivyAgentSigner` is an ethers signer over a Privy
 *   server wallet whose policy bounds what it will sign, and it plugs into
 *   every surface above that takes a signer.
 *
 * **`http/headers.ts` is deliberately the only place the wire format exists.** The
 * client parses with it and the server formats with it, so the two halves cannot
 * drift apart without a test failing in one file, rather than mis-parsing silently
 * between two.
 *
 * Nothing exported from this package throws. Every fallible call returns a
 * `Result` from `@tabai/shared`. Two exceptions are named and deliberate. The
 * Hono and Next.js adapters re-raise a handler's own thrown value, because a
 * framework's contract for a failed handler is an exception and the adapter is the
 * boundary where a `Result` becomes whatever the host expects. And
 * `createX402UpstreamPricing` refuses a non-positive `unitBaseUnits` at
 * construction with a `RangeError`: a pricing object that cannot price is a
 * programming error to surface at startup, and the gateway validates the same
 * value from its configuration before it ever calls the factory.
 */

import { WORKSPACE_ID } from "@tabai/shared";

export const WORKSPACE_ID_SDK = "@tabai/sdk" as const;

export const SHARED_WORKSPACE_ID = WORKSPACE_ID;

// Every fallible call returns a `Result`, so a consumer needs its type and its
// constructors from the package it installed; `@tabai/shared` is inlined at pack
// time and has no name on npm to import them from.
export { ok, err, wrap, causeOf } from "@tabai/shared";
export type { Result, TabError, ErrorCategory, Address, Bytes32, Hex } from "@tabai/shared";

// Where this project hosts its read API and demo Service on each network, which
// the MCP server falls back to when nothing else is configured.
export { TAB_HOSTED } from "@tabai/shared";
export type { TabHosted, HostedService } from "@tabai/shared";

// Where an Agent names a metering delegate on each network, `undefined` where
// none is deployed, and the fragments to call it with.
export { METERING_DELEGATES, METERING_DELEGATES_ABI, meteringDelegatesFor } from "@tabai/shared";

export * from "./logger.js";
export * from "./errors.js";
export * from "./payments/index.js";
export * from "./http/index.js";
export * from "./server/index.js";
export * from "./proxy/index.js";
export * from "./x402/index.js";
export * from "./signers/index.js";
export * from "./mcp/index.js";
export * from "./cli/index.js";
