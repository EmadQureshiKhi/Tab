/**
 * The CLI: the executable entry point of this package. (R25.5, R25.6)
 *
 * `connect` writes one `mcpServers` stanza into an MCP client's config, never a
 * key. `doctor` checks the installation with reads alone. `status` and `settle`
 * are the two tools reachable without a model, and `settle` is a dry run unless
 * it is told otherwise.
 */

export * from "./client-config.js";
export * from "./connect.js";
export * from "./doctor.js";
export * from "./main.js";
