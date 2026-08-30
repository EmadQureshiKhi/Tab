/**
 * `@tabai/registry` — the indexed read layer over Tab's Creditcoin events.
 *
 * What this workspace is for: making on-chain facts queryable without reinterpreting
 * them. Every row it stores is reachable back to a block hash, a transaction hash,
 * and a log ordinal, so a caller can check any answer against the chain instead of
 * believing this service. Nothing here signs anything, holds a key, or writes to
 * chain.
 *
 * Task 18.1 delivers the schema and the indexer. The read endpoints are task 18.2
 * and mount onto the same Hono app.
 *
 * Requirements: 12.6, 24.4
 */

export const WORKSPACE_ID_REGISTRY = "@tabai/registry" as const;

export * from "./clearing.js";
export * from "./config.js";
export * from "./chain.js";
export * from "./enum-names.js";
export * from "./events.js";
export * from "./indexer.js";
export * from "./postgres-sink.js";
export * from "./rows.js";
export * from "./schema.js";
export * from "./server.js";
export * from "./service.js";
export * from "./sink.js";
