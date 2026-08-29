/**
 * `@tabai/watcher` — the process that observes Source Chain Settlements, verifies
 * proofs before paying for them, and submits them to Creditcoin.
 *
 * It is the only component that spends CTC, so its guiding rule is: never pay gas
 * for a proof it has not itself verified.
 *
 * What is implemented here so far:
 *
 * - `config.ts` — everything read from the environment, validated without throwing
 * - `rpc.ts` — provider construction with batching off and one pinned block tag
 * - `chain-info.ts` — the ChainInfo Precompile reader, against the confirmed ABI
 * - `discovery.ts` — which chains are monitored, and why the others are not
 * - `state.ts` — the seven settlement states and the legal transitions
 * - `observation.ts` — which logs are watched, how they decode, and gap catch-up
 * - `clearing.ts` — Provisional Clearing and the reorganisation check
 * - `health.ts` - the unauthenticated `/healthz` and `/readyz` endpoints
 * - `db/` — the Drizzle schema, the migration runner, and persistence
 */

export const WORKSPACE_ID_WATCHER = "@tabai/watcher" as const;

export * from "./config.js";
export * from "./rpc.js";
export * from "./chain-info.js";
export * from "./discovery.js";
export * from "./state.js";
export * from "./errors.js";
export * from "./observation.js";
export * from "./clearing.js";
export * from "./health.js";
export * from "./db/schema.js";
export * from "./db/client.js";
export * from "./db/discovery-store.js";
export * from "./db/observation-store.js";
