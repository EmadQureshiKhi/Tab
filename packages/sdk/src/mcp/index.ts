/**
 * The MCP surface: four tools, their declared schemas, and the server that
 * serves them. (R25.1, R25.2, R25.3)
 *
 * `tab_discover` finds Services, `tab_call` uses one and is metered onto the
 * Agent's Open Tab, `tab_status` reports what the Agent owes and may still
 * spend, and `tab_settle` pays it down. Three of the four are keyless reads.
 * Only `tab_settle` signs, and it signs through the same payment-strategy seam
 * the rest of this package settles through.
 */

export * from "./json-schema.js";
export * from "./schemas.js";
export * from "./assets.js";
export * from "./json.js";
export * from "./registry-client.js";
export * from "./settings.js";
export * from "./toolset.js";
export * from "./server.js";
