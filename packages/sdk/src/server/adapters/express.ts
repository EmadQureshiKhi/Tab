/**
 * Express middleware over the post-paid plugin.
 *
 * Express is the one framework of the three that does not hand a middleware a
 * response object to inspect. A handler writes into `res` and the bytes leave as
 * they are written, so "meter after the handler produced its response" has to be
 * arranged rather than expressed, and the two release orderings need genuinely
 * different plumbing:
 *
 * **`before-metering` intercepts nothing.** The middleware registers a `finish`
 * listener and calls `next()`. Express writes the response exactly as it would
 * without this SDK installed, and the delivery is recorded once the bytes are
 * gone. Nothing is buffered, nothing is delayed, and a streamed endpoint keeps
 * streaming. A refusal cannot reach this request, because the response left
 * before the charge was known.
 *
 * **`after-metering` holds the body, and only the body.** `res.write` and
 * `res.end` are intercepted, the chunks are collected, and the moment the handler
 * ends the response the delivery is recorded. Then either the collected bytes go
 * out with their charge headers, or — on the one refusal an Agent must clear —
 * the refusal goes out instead. The handler is never delayed: it writes, it ends,
 * it returns. What waits is the flush, and it waits on one credit record, never on
 * a payment.
 *
 * That interception is worth naming plainly: under `after-metering` this adapter
 * buffers the response body in memory until the handler ends the response, so it
 * is the wrong choice for a streamed or long-lived response. Use
 * `before-metering` for those, and the bytes are never touched.
 *
 * ## No dependency on Express
 *
 * The three parameter types are structural and describe only the fields the
 * middleware touches. Nothing here imports `express`, so a consumer on Hono
 * installs nothing extra and there is no Express version to keep in step.
 *
 * Requirements: 23.3, 12.1
 */

import type { Logger } from "../../logger.js";
import { defaultLogger } from "../../logger.js";
import { headerReaderOf } from "../../http/headers.js";
import type { MeteredRequest, MeteringOutcome, PostPaidPlugin } from "../post-paid.js";

/** The request fields the middleware reads. An Express `req` satisfies it. */
export interface ExpressLikeRequest {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  /** Express's pre-router URL. Preferred over `url`, which a router rewrites. */
  readonly originalUrl?: string | undefined;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>> | undefined;
}

/** The response fields the middleware touches. An Express `res` satisfies it. */
export interface ExpressLikeResponse {
  statusCode: number;
  readonly headersSent?: boolean;
  setHeader(name: string, value: string): unknown;
  removeHeader?(name: string): unknown;
  write(...args: unknown[]): boolean;
  end(...args: unknown[]): unknown;
  on(event: string, listener: () => void): unknown;
}

/** Express's continuation. An argument means the handler chain failed. */
export type ExpressLikeNext = (error?: unknown) => void;

export type ExpressLikeMiddleware = (
  request: ExpressLikeRequest,
  response: ExpressLikeResponse,
  next: ExpressLikeNext,
) => void;

export interface ExpressTabPostPaidOptions {
  /**
   * Receives the pending recording, so a host — or a test — can await it. Called
   * with the same promise the plugin is working on, once per metered response.
   */
  readonly onMetering?: (metering: Promise<MeteringOutcome>) => void;
  /** Base URL used to make a relative Express URL absolute. Defaults to `http://localhost`. */
  readonly baseUrl?: string;
  readonly logger?: Logger;
}

/**
 * Builds the middleware. Install it before the handlers it should meter.
 *
 * ```ts
 * app.use(expressTabPostPaid(tabPostPaid({ ... })));
 * ```
 */
export function expressTabPostPaid(
  plugin: PostPaidPlugin,
  options: ExpressTabPostPaidOptions = {},
): ExpressLikeMiddleware {
  const logger = options.logger ?? defaultLogger;
  const baseUrl = options.baseUrl ?? "http://localhost";

  return (request, response, next) => {
    const metered = meteredRequestFrom(request, baseUrl);

    if (plugin.release === "before-metering") {
      // Nothing is intercepted. The bytes leave, then the charge is recorded.
      response.on("finish", () => {
        const metering = plugin.meter(metered, { status: response.statusCode });
        options.onMetering?.(metering);
      });
      next();
      return;
    }

    const chunks: Uint8Array[] = [];
    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);
    let ended = false;

    response.write = (...args: unknown[]): boolean => {
      const chunk = chunkOf(args, logger);
      if (chunk !== undefined) chunks.push(chunk);
      callbackOf(args)?.();
      return true;
    };

    response.end = (...args: unknown[]): unknown => {
      if (ended) return response;
      ended = true;
      const chunk = chunkOf(args, logger);
      if (chunk !== undefined) chunks.push(chunk);
      const done = callbackOf(args);

      // Restore before anything asynchronous, so the flush below writes through
      // the real methods and a second `end` from the framework is a no-op.
      response.write = originalWrite;
      response.end = originalEnd;

      const metering = plugin.meter(metered, { status: response.statusCode });
      options.onMetering?.(metering);
      void flush({ plugin, response, chunks, metering, done, originalEnd, logger });
      return response;
    };

    next();
  };
}

/** Records the delivery, then sends either the handler's bytes or the refusal. */
async function flush(input: {
  readonly plugin: PostPaidPlugin;
  readonly response: ExpressLikeResponse;
  readonly chunks: readonly Uint8Array[];
  readonly metering: Promise<MeteringOutcome>;
  readonly done: (() => void) | undefined;
  readonly originalEnd: (...args: unknown[]) => unknown;
  readonly logger: Logger;
}): Promise<void> {
  const { plugin, response, chunks, originalEnd, logger } = input;
  const body = concat(chunks);

  let outcome: MeteringOutcome;
  try {
    outcome = await input.metering;
  } catch (thrown) {
    // The plugin does not reject. If it somehow did, the delivered response is
    // still the delivered response.
    logger.error("post-paid metering rejected, and the handler's response was sent unchanged", {
      message: String(thrown),
    });
    send(response, originalEnd, body, input.done);
    return;
  }

  if (response.headersSent === true) {
    // The handler flushed its own headers, so neither a status nor a header can
    // change now. The bytes go out as written and the charge is already recorded.
    logger.warn("post-paid could not attach charge headers because the handler had already sent them");
    send(response, originalEnd, body, input.done);
    return;
  }

  if (outcome.kind === "refused") {
    const refusal = plugin.refusalResponseFor(outcome);
    let payload: Uint8Array;
    try {
      payload = new Uint8Array(await refusal.arrayBuffer());
    } catch (thrown) {
      logger.error("post-paid could not read the refusal body, so the delivered response was sent", {
        message: String(thrown),
      });
      send(response, originalEnd, body, input.done);
      return;
    }
    response.statusCode = refusal.status;
    refusal.headers.forEach((value, name) => {
      response.setHeader(name, value);
    });
    send(response, originalEnd, payload, input.done);
    return;
  }

  for (const [name, value] of Object.entries(plugin.headersFor(outcome))) {
    response.setHeader(name, value);
  }
  send(response, originalEnd, body, input.done);
}

/** Writes the payload, restating `Content-Length` because the body may have changed. */
function send(
  response: ExpressLikeResponse,
  originalEnd: (...args: unknown[]) => unknown,
  body: Uint8Array,
  done: (() => void) | undefined,
): void {
  response.setHeader("Content-Length", String(body.byteLength));
  if (done === undefined) originalEnd(body);
  else originalEnd(body, done);
}

/**
 * Builds the framework-free request the plugin reads, without touching the body.
 *
 * The header lookup is `headerReaderOf` from the shared header contract, so the
 * case-insensitive matching and the repeated-value handling are the same code the
 * 402 client uses rather than a second copy of the same rules. Node lower-cases
 * every incoming header name and the plugin asks in canonical casing, which is
 * exactly the mismatch that reader exists to absorb.
 */
export function meteredRequestFrom(
  request: ExpressLikeRequest,
  baseUrl = "http://localhost",
): MeteredRequest {
  const path = request.originalUrl ?? request.url ?? "/";
  return {
    method: request.method ?? "GET",
    url: absolute(path, baseUrl),
    headers: headerReaderOf(request.headers ?? {}),
  };
}

/** Makes an Express path absolute, because a `MeteredRequest` carries a URL. */
function absolute(path: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
  }
}

/** The chunk a `write` or `end` call carried, as bytes. */
function chunkOf(args: readonly unknown[], logger: Logger): Uint8Array | undefined {
  const chunk = args[0];
  if (chunk === undefined || chunk === null || typeof chunk === "function") return undefined;
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk !== "string") return undefined;

  const declared = typeof args[1] === "string" ? args[1] : "utf8";
  try {
    return new Uint8Array(Buffer.from(chunk, declared as BufferEncoding));
  } catch {
    logger.debug("post-paid read a response chunk as utf8 because its encoding was not recognised", {
      declared,
    });
    return new Uint8Array(Buffer.from(chunk, "utf8"));
  }
}

/** The completion callback a `write` or `end` call carried, if any. */
function callbackOf(args: readonly unknown[]): (() => void) | undefined {
  const last = args[args.length - 1];
  return typeof last === "function" ? (last as () => void) : undefined;
}

/** Joins the collected chunks into one payload. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
