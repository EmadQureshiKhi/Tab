/**
 * Next.js route-handler wrapper over the post-paid plugin.
 *
 * A Next.js route handler is `(request: Request, context) => Response`, which is
 * the web standard with a second argument for the matched route parameters. So
 * this adapter is a function that returns a function: the handler is called with
 * both arguments untouched, its response is metered, and the response the plugin
 * says goes out is returned.
 *
 * ## No dependency on Next.js
 *
 * Nothing here imports `next`. The handler shape is standard, and the one
 * Next-specific facility the adapter can use — a hook that keeps work alive after
 * the response has been sent — is taken as an argument rather than imported, so
 * this file has no framework version to track and a consumer on another framework
 * installs nothing.
 *
 * Under `release: "before-metering"` the recording is still in flight when the
 * response is returned. On a serverless runtime that is a real hazard: the
 * invocation can be frozen the moment the response is written. Pass `after` from
 * `next/server` where the Next version has it, and the recording is kept alive:
 *
 * ```ts
 * import { after } from "next/server";
 * export const GET = withTabPostPaid(plugin, handler, { after });
 * ```
 *
 * With no `after` and `before-metering`, the recording is best-effort, which is
 * why `after-metering` is the default the plugin ships with.
 *
 * Requirements: 23.3, 12.1
 */

import type { MeteredRequest, PostPaidPlugin } from "../post-paid.js";

/** A Next.js App Router route handler. `Ctx` carries the matched route parameters. */
export type NextRouteHandler<Ctx> = (request: Request, context: Ctx) => Response | Promise<Response>;

export interface NextTabPostPaidOptions {
  /**
   * A hook that keeps work alive past the response, such as `after` from
   * `next/server`. Used under `release: "before-metering"` and ignored otherwise.
   */
  readonly after?: (task: () => Promise<unknown>) => void;
}

/**
 * Wraps one route handler.
 *
 * A handler that throws is re-raised unchanged, so Next's own error handling sees
 * what the handler threw and nothing is metered for a delivery that did not
 * happen. That re-raise is the adapter boundary where a returned value becomes the
 * exception the framework's contract expects.
 */
export function withTabPostPaid<Ctx>(
  plugin: PostPaidPlugin,
  handler: NextRouteHandler<Ctx>,
  options: NextTabPostPaidOptions = {},
): NextRouteHandler<Ctx> {
  return async (request, context) => {
    // A web-standard `Request` already satisfies `MeteredRequest`.
    const metered: MeteredRequest = request;

    const execution = await plugin.execute(metered, () => handler(request, context));

    if (execution.kind === "handler-failed") throw execution.thrown;

    if (execution.kind === "delivered" && plugin.release === "before-metering") {
      const keepAlive = options.after;
      if (keepAlive !== undefined) keepAlive(() => execution.metering);
    }

    return execution.response;
  };
}
