/**
 * `@tabai/proof-service` is the product Tab sells over its own rail.
 *
 * The gateway proved that a Service can meter an Agent on credit. What it metered
 * was a placeholder. This package is the Service that actually delivers something:
 * the Merkle Proof, the Continuity Proof, and the encoded transaction a
 * `SettlementVerifier.verifyAndEmit` call cannot be made without. An Agent buys one
 * proof, on credit, with no prepayment and no wallet pop-up, and settles later.
 *
 * ## Both halves of the rail, in one process
 *
 * - **As a Service** it meters delivered proof material into the Agent's Open Tab
 *   before the material leaves ({@link createApp}, R22.3), and refuses a height the
 *   chain has not attested with both figures named and nothing charged
 *   ({@link checkHeightAttested}, R22.5).
 * - **As an Agent** it settles its own Open Tabs through the SDK payment strategy,
 *   the Watcher, and `TabBook` clearing ({@link createProofServiceSettler}, R22.4).
 *   There is no operator-only path, which is the point: the operator eats its own
 *   cooking.
 *
 * ## What is re-expressed here, and why
 *
 * The dependency graph is one-way and linted: `services/*` may depend on
 * `packages/*` and on nothing else. The `LimitWitness` builder in
 * `apps/gateway/src/witness.ts`, its `TabBook` client, and the proof sourcing in
 * `apps/watcher/src/proof.ts` are therefore re-expressed in this package rather
 * than imported. Each copy says so at the top of the file. The right home for all
 * three is `packages/sdk`, and promoting them would retire every copy at once;
 * doing that is a change to another package and out of this task's scope.
 *
 * Nothing exported throws. Every fallible call returns a `Result` (design 13.1).
 */

import { WORKSPACE_ID } from "@tabai/shared";

export const WORKSPACE_ID_PROOF_SERVICE = "@tabai/proof-service" as const;

export const SHARED_WORKSPACE_ID = WORKSPACE_ID;

export * from "./config.js";
export * from "./witness.js";
export * from "./tab-book.js";
export * from "./attestation.js";
export * from "./proof.js";
export * from "./delivery.js";
export * from "./authorisation.js";
export * from "./server.js";
export * from "./settlement.js";
export * from "./runtime.js";
