/**
 * The server-side surface: the post-paid plugin, the metering seam, and the three
 * framework adapters.
 *
 * `tabPostPaid` is the whole product claim in one function. A Service installs it,
 * keeps writing handlers the way it already does, and its Open Tab accrues behind
 * each delivered response. No caller prepays, no response waits on a payment, and
 * the one status this surface adds is a `402` on `LimitExceeded` — a credit
 * decision, not a prepayment demand (R23.3, R12.1).
 *
 * The adapters are thin by design and carry no dependency on the framework they
 * adapt: every framework type in here is structural, so a Service on Hono installs
 * nothing for Express and nothing for Next.js.
 *
 * The wire format is not defined here. `src/http/headers.ts` owns it, this surface
 * is its emitting half, and the 402 client of R23.2 is its reading half — so a
 * disagreement about a header is a test failure in one file rather than a silent
 * mis-parse between two.
 *
 * Nothing exported here throws, with one named exception: the Hono and Next.js
 * adapters re-raise a handler's own thrown value, because a framework's contract
 * for a failed handler is an exception and the adapter is the boundary where a
 * `Result` becomes whatever the host expects.
 */

export * from "./metering.js";
export * from "./post-paid.js";
export * from "./adapters/hono.js";
export * from "./adapters/express.js";
export * from "./adapters/next.js";
