/**
 * The proxy layer: hooks around a forwarded, metered request (R23.4), and the
 * Attestcoin proof hook that attaches the Verified Settlement covering it
 * (R23.5).
 *
 * `hooks.ts` is the seam, `proxy.ts` the handler, `verifier.ts` the one chain
 * read the proof hook makes, and `attestcoin-proof-hook.ts` the hook itself.
 */

export * from "./hooks.js";
export * from "./proxy.js";
export * from "./verifier.js";
export * from "./attestcoin-proof-hook.js";
