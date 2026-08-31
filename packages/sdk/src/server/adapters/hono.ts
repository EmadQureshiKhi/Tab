/**
 * Hono middleware over the post-paid plugin.
 *
 * Hono already speaks the web standard, so this adapter is almost nothing: it
 * awaits `next()`, hands `c.res` to the plugin, and puts back whatever the plugin
 * says goes out. The whole of the ordering guarantee is the `await next()` on the
 * first line of the handler closure — the handler chain runs to completion, and
 * only the response it produced is metered.
 *
 * ## No dependency on Hono
 *
 * The context and next types below are structural, so this file compiles with no
 * `hono` import, no `hono` dependency, and no `hono` version to keep in step. A
 * consumer using Express should not be made to install Hono to use this SDK, and
 * the two fields the middleware touches — `c.req.raw` and `c.res` — are stable
 * across Hono 3 and 4.
 *
 * `c.executionCtx` is read through a `try`, because on a Hono context with no
 * execution context the getter throws rather than returning undefined. Where it
 * exists — a Worker, a runtime with a request lifetime — a `before-metering`
 * recording is handed to `waitUntil` so the runtime does not tear down while the
 * charge is still in flight.
 *
 * Requirements: 23.3, 12.1
 */

import type { MeteredRequest, PostPaidPlugin } from "../post-paid.js";

/** The two fields of a Hono context this middleware touches, and nothing else. */
export interface HonoLikeContext {
  readonly req: { readonly raw: Request };
  res: Response;
  /** Present on a runtime with a request lifetime. Reading it may throw. */
  readonly executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}

/** Hono's downstream continuation. */
export type HonoLikeNext = () => Promise<void>;

/** What Hono expects a middleware to be. */
export type HonoLikeMiddleware = (context: HonoLikeContext, next: HonoLikeNext) => Promise<void>;

/**
 * Builds the middleware.
 *
 * On `handler-failed` the thrown value is re-raised unchanged so Hono's own
 * `onError` sees exactly what the handler threw. That re-raise is the one place
 * this file throws, and it is the adapter boundary the zero-throw rule names: the
 * plugin returned a value, and the framework's contract for a failed handler is
 * an exception.
 */
export function honoTabPostPaid(plugin: PostPaidPlugin): HonoLikeMiddleware {
  return async (context, next) => {
    // A web-standard `Request` already satisfies `MeteredRequest`, so nothing is
    // rebuilt and no header is copied.
    const request: MeteredRequest = context.req.raw;

    const execution = await plugin.execute(request, async () => {
      await next();
      return context.res;
    });

    if (execution.kind === "handler-failed") throw execution.thrown;

    context.res = execution.response;

    if (execution.kind === "delivered" && plugin.release === "before-metering") {
      waitUntil(context, execution.metering);
    }
  };
}

/** Hands the pending recording to the runtime's request lifetime, where there is one. */
function waitUntil(context: HonoLikeContext, metering: Promise<unknown>): void {
  try {
    context.executionCtx?.waitUntil(metering);
  } catch {
    // No execution context. The recording still runs; nothing is waiting on it.
  }
}
