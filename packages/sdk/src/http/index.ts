/**
 * The HTTP surface of the SDK: the header contract, and the post-paid 402 client
 * that reads it.
 *
 * `headers.ts` is the shared half. It is the only definition of the `Tab-*` wire
 * format, and both directions go through it — the client here parses with it, and
 * the server-side post-paid plugin formats with it — so the two halves cannot
 * drift apart without a test failing.
 *
 * Requirements: 23.2, 21.5
 */

export * from "./headers.js";
export * from "./client-402.js";
