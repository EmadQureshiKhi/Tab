/**
 * `@tabai/gateway` is the Service side of the rail: it meters delivered work into an
 * Agent's Open Tab on Monad, after the work is delivered and never before.
 *
 * ## What this package owns, and what it deliberately does not
 *
 * `packages/sdk` already ships the post-paid plugin, the `Tab-Charge-*` wire
 * format, and the revert-to-status mapping, and it ships them framework-free with
 * `TabBookClient` left as an interface. That interface is the seam, and this
 * package is the half that fills it: the chain code the SDK refuses to own.
 *
 * So there is no second metering core here and no second header formatter. What is
 * here is the part that cannot live in a published client library:
 *
 * - **{@link buildWitness}** rebuilds an Agent's `LimitWitness` from
 *   `HistoryExtended` logs and proves it against `TabBook.historyCommitment`
 *   before it is used. `recordDelivery` refuses any witness that does not fold, so
 *   this is the difference between a charge and a paid-for revert.
 * - **{@link createTabBookClient}** records the delivery, simulating first so a
 *   refusal is read for free rather than paid for as a revert.
 * - **{@link verifyMeteringRequest}** authenticates the caller as the Service
 *   operator, since the gateway holds the key that can charge any Agent up to its
 *   authorisation ceiling.
 *
 * `server.ts` mounts the SDK's post-paid plugin over these, and `main.ts` is the
 * process that serves it.
 *
 * Nothing exported throws. Every fallible call returns a `Result` (design 13.1).
 */

import { WORKSPACE_ID } from "@tabai/shared";

export const WORKSPACE_ID_GATEWAY = "@tabai/gateway" as const;

export const SHARED_WORKSPACE_ID = WORKSPACE_ID;

export * from "./config.js";
export * from "./witness.js";
export * from "./tab-book.js";
export * from "./authorisation.js";
export * from "./x402.js";
