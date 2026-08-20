/**
 * `@tabai/shared` is the single source of the replay-key packing, the chain
 * constants, and the contract interface constants, so the contracts, the
 * watcher, the SDK, and the dashboard cannot drift apart on any of them.
 *
 * The package has no internal dependency and no runtime dependency at all.
 */
export const WORKSPACE_ID = "@tabai/shared" as const;

export * from "./hex.js";
export * from "./keccak256.js";
export * from "./result.js";
export * from "./replay-key.js";
export * from "./chains.js";
export * from "./abi.js";
