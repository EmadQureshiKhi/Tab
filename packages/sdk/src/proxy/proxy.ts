/**
 * The proxy layer: one handler that forwards a request upstream, meters the
 * delivery through the post-paid plugin, and runs hooks around both (R23.4).
 *
 * ## Order of operations, which is the whole contract
 *
 * ```text
 * before hooks, in registration order
 *   -> metering.execute( forward to upstream )
 * after hooks, in reverse order
 * ```
 *
 * The forward runs *inside* the metering plugin's `execute`, so the plugin sees
 * the upstream's response exactly as it sees a local handler's: it records the
 * delivery once the response exists, attaches the charge block, and replaces
 * the response with a 402 on `LimitExceeded` alone. Nothing about the plugin's
 * ordering guarantee changes because the handler is a network hop, and the
 * "never withhold pending payment" rule (R23.3) is inherited rather than
 * re-implemented here.
 *
 * ## Streaming
 *
 * The upstream response body is passed through as the stream it arrived as.
 * Nothing here reads it, and the charge headers are attached by rebuilding the
 * response around the same stream. A hook that needs the body must `clone()` the
 * response and read the copy, and a hook that does so pays the buffering it
 * asked for and nobody else does. The request body is likewise forwarded as a
 * stream where the host `fetch` supports one.
 *
 * ## What is not forwarded
 *
 * Hop-by-hop request headers, `host`, and `content-length` are dropped before
 * forwarding, because they describe the connection the proxy is on rather than
 * the request. On the way back, `content-encoding`, `content-length`, and
 * `transfer-encoding` are dropped, because the host `fetch` already decoded the
 * body and the outbound server re-frames it; forwarding those headers would tell
 * the caller to decode a body that is already plain.
 *
 * ## Failures are responses, never throws
 *
 * An unreachable upstream is a 502 carrying a `TabError` body. It is not a
 * delivery, so the plugin's default `billable` predicate does not meter it. A
 * critical hook's `err` is a response at its category's status. The handler
 * this factory returns never rejects.
 *
 * Requirements: 23.4, 23.3
 */

import { causeOf, httpStatusOf, ok, wrap, type Result, type TabError } from "@tabai/shared";

import { tabError } from "../errors.js";
import { defaultLogger, type Logger } from "../logger.js";
import {
  jsonResponse,
  type MeteredCharge,
  type MeteringOutcome,
  type PostPaidPlugin,
} from "../server/post-paid.js";
import type { ProxyHook, ProxyHookContext, ProxyPhase } from "./hooks.js";
import type { VerifiedSettlementView } from "./verifier.js";

/** Request headers that describe the hop rather than the request, per RFC 9110. */
export const HOP_BY_HOP_HEADERS: readonly string[] = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** Response headers the host `fetch` has already acted on and the outbound server re-frames. */
export const REFRAMED_RESPONSE_HEADERS: readonly string[] = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
];

/** The forward this proxy hands to its `fetch`. Structural, like `client-402.ts`. */
export interface ProxyForwardInit {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The request body stream, or undefined for a bodiless method. */
  readonly body?: unknown;
  /** Required by the host `fetch` to send a streamed request body. */
  readonly duplex?: "half";
  readonly signal?: AbortSignal;
}

/** The `fetch` the proxy forwards with. The host's global `fetch` is the default. */
export type ProxyFetch = (url: string, init: ProxyForwardInit) => Promise<Response>;

/** One hook phase that returned an error or threw, in the order it happened. */
export interface HookFailure {
  readonly hook: string;
  readonly phase: ProxyPhase;
  readonly critical: boolean;
  readonly error: TabError;
}

export interface ProxyResult {
  /** The response that goes out. */
  readonly response: Response;
  /**
   * `delivered`: the upstream's response, metered or not. `refused`: the metering
   * plugin replaced it, which is `LimitExceeded` and the two Agent-side refusals
   * only. `failed`: a critical hook or the forward itself failed.
   */
  readonly kind: "delivered" | "refused" | "failed";
  /**
   * Resolves once the delivery is recorded. Already resolved under the plugin's
   * default `after-metering`; still pending under `before-metering`, where a
   * host with a request lifetime hook passes it there.
   */
  readonly metering: Promise<MeteringOutcome> | undefined;
  /** The recorded charge, when the outcome was known before the hooks ran. */
  readonly charge: MeteredCharge | undefined;
  /** The Verified Settlement a hook attached (R23.5). */
  readonly settlement: VerifiedSettlementView | undefined;
  /** Every hook failure, critical or not. */
  readonly hookFailures: readonly HookFailure[];
  /** The error that produced a `failed` result. */
  readonly failure: TabError | undefined;
  /** The shared scratch the hooks used, for a Service that wants to log it. */
  readonly state: ReadonlyMap<string, unknown>;
}

export interface TabProxyOptions {
  /** Absolute base URL of the service being fronted. The request path and query are appended. */
  readonly upstream: string;
  readonly hooks?: readonly ProxyHook[];
  /** The post-paid plugin of `server/post-paid.ts`. Metering runs on every request. */
  readonly metering: PostPaidPlugin;
  readonly fetchImpl?: ProxyFetch;
  readonly logger?: Logger;
  /** Aborts the forward after this long. No timeout when omitted. */
  readonly timeoutMs?: number;
  /** Request headers dropped before forwarding, on top of the hop-by-hop set and `host`. */
  readonly dropRequestHeaders?: readonly string[];
  /** Called with every result, so a Service logs which Settlement covered which request. */
  readonly onResult?: (result: ProxyResult) => void;
}

/** A handler any web-standard host can mount, with the richer entry point beside it. */
export interface TabProxy {
  (request: Request): Promise<Response>;
  /** The same run, returning everything the handler discards. */
  proxy(request: Request): Promise<ProxyResult>;
  readonly hooks: readonly ProxyHook[];
  readonly upstream: string;
}

/**
 * Builds the proxy.
 *
 * Construction is total, as everywhere in this package. An unusable `upstream`
 * is reported by the first request as a 500 carrying a `VALIDATION` error, which
 * is the first point at which anybody is listening.
 */
export function createTabProxy(options: TabProxyOptions): TabProxy {
  const logger = options.logger ?? defaultLogger;
  const hooks = [...(options.hooks ?? [])];
  const dropped = new Set([
    ...HOP_BY_HOP_HEADERS,
    "host",
    "content-length",
    ...(options.dropRequestHeaders ?? []).map((name) => name.toLowerCase()),
  ]);

  /**
   * The forward. A failure becomes a response and is also recorded on `holder`,
   * so the result can name the error without reading it back off the response.
   */
  const forward = async (request: Request, holder: { failure?: TabError }): Promise<Response> => {
    const failed = (error: TabError): Response => {
      holder.failure = error;
      return errorResponse(error);
    };
    const target = resolveUpstream(options.upstream, request.url);
    if (!target.ok) return failed(target.error);

    const send = options.fetchImpl ?? hostFetch();
    if (send === undefined) {
      return failed(
        tabError("UPSTREAM", "FETCH_UNAVAILABLE", "this host has no global fetch; supply fetchImpl, or run on Node 20.10 or later"),
      );
    }

    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      if (!dropped.has(name.toLowerCase())) headers[name] = value;
    });

    const bodiless = request.method === "GET" || request.method === "HEAD";
    const body = bodiless ? undefined : request.body;
    const signal = forwardSignal(request, options.timeoutMs);
    const init: ProxyForwardInit = {
      method: request.method,
      headers,
      ...(body === undefined || body === null ? {} : { body, duplex: "half" as const }),
      ...(signal === undefined ? {} : { signal }),
    };

    const sent = await wrap(
      async () => send(target.value, init),
      (error) =>
        tabError("UPSTREAM", "PROXY_UPSTREAM_UNREACHABLE", `the upstream at ${target.value} did not answer`, {
          retryable: true,
          details: { upstream: target.value, method: request.method },
          cause: causeOf(error),
        }),
    );
    if (!sent.ok) return failed(sent.error);
    if (!looksLikeResponse(sent.value)) {
      return failed(
        tabError("UPSTREAM", "PROXY_UPSTREAM_INVALID", `the fetch given to this proxy returned something that is not a response for ${target.value}`),
      );
    }
    return reframe(sent.value);
  };

  const proxy = async (request: Request): Promise<ProxyResult> => {
    const state = new Map<string, unknown>();
    const failures: HookFailure[] = [];
    const base = { request, state, logger } as const;
    let settlement: VerifiedSettlementView | undefined;

    // ---- before, in registration order
    for (const hook of hooks) {
      if (hook.before === undefined) continue;
      const context: ProxyHookContext = { ...base, phase: "before" };
      const outcome = await runPhase(hook, "before", context, logger);
      if (outcome !== undefined) {
        failures.push(outcome);
        if (outcome.critical) {
          return finish({
            response: errorResponse(outcome.error),
            kind: "failed",
            metering: undefined,
            charge: undefined,
            settlement: context.settlement,
            hookFailures: failures,
            failure: outcome.error,
            state,
          });
        }
      }
      settlement = context.settlement ?? settlement;
    }

    // ---- the forward, under metering
    const holder: { failure?: TabError } = {};
    const execution = await options.metering.execute(request, () => forward(request, holder));

    let response: Response;
    let kind: ProxyResult["kind"];
    let forwardThrew: TabError | undefined;
    let metering: Promise<MeteringOutcome> | undefined;
    let outcome: MeteringOutcome | undefined;
    if (execution.kind === "handler-failed") {
      // `forward` never throws, so this is a plugin invariant rather than a path,
      // and it is answered the same way a throwing hook is: as an INTERNAL error.
      forwardThrew = tabError("INTERNAL", "PROXY_FORWARD_THREW", "the forward threw where it should have returned a response", {
        cause: causeOf(execution.thrown),
      });
      response = errorResponse(forwardThrew);
      kind = "failed";
    } else if (execution.kind === "refused") {
      response = execution.response;
      kind = "refused";
      outcome = execution.outcome;
      metering = Promise.resolve(execution.outcome);
    } else {
      response = execution.response;
      kind = holder.failure === undefined ? "delivered" : "failed";
      metering = execution.metering;
      if (options.metering.release === "after-metering") outcome = await execution.metering;
    }
    const charge = outcome?.kind === "charged" ? outcome.charge : undefined;

    // ---- after, in reverse order
    for (const hook of [...hooks].reverse()) {
      if (hook.after === undefined) continue;
      const context: ProxyHookContext = {
        ...base,
        phase: "after",
        response,
        ...(charge === undefined ? {} : { charge }),
        ...(outcome === undefined ? {} : { metering: outcome }),
        ...(settlement === undefined ? {} : { settlement }),
      };
      const failed = await runPhase(hook, "after", context, logger);
      settlement = context.settlement ?? settlement;
      if (failed !== undefined) {
        failures.push(failed);
        if (failed.critical) {
          discard(response, logger);
          return finish({
            response: errorResponse(failed.error),
            kind: "failed",
            metering,
            charge,
            settlement,
            hookFailures: failures,
            failure: failed.error,
            state,
          });
        }
      }
    }

    return finish({
      response,
      kind,
      metering,
      charge,
      settlement,
      hookFailures: failures,
      failure: kind === "failed" ? (holder.failure ?? forwardThrew) : undefined,
      state,
    });
  };

  const finish = (result: ProxyResult): ProxyResult => {
    if (options.onResult !== undefined) {
      try {
        options.onResult(result);
      } catch (error) {
        logger.warn("onResult threw and was ignored", causeOf(error));
      }
    }
    return result;
  };

  const handler = async (request: Request): Promise<Response> => (await proxy(request)).response;
  return Object.assign(handler, { proxy, hooks, upstream: options.upstream });
}

/**
 * Runs one phase of one hook without letting it throw or reject into the proxy.
 * Returns the failure, or undefined when the phase succeeded.
 */
async function runPhase(
  hook: ProxyHook,
  phase: ProxyPhase,
  context: ProxyHookContext,
  logger: Logger,
): Promise<HookFailure | undefined> {
  const run = phase === "before" ? hook.before : hook.after;
  if (run === undefined) return undefined;
  let result: Result<void>;
  try {
    result = await run.call(hook, context);
  } catch (error) {
    result = { ok: false, error: tabError("INTERNAL", "HOOK_THREW", `hook ${hook.name} threw in its ${phase} phase`, { cause: causeOf(error) }) };
  }
  if (result.ok) return undefined;
  const critical = hook.critical === true;
  logger[critical ? "error" : "warn"](
    critical ? `hook ${hook.name} failed its ${phase} phase and the request fails with it` : `hook ${hook.name} failed its ${phase} phase and was skipped`,
    { hook: hook.name, phase, code: result.error.code, message: result.error.message },
  );
  return { hook: hook.name, phase, critical, error: result.error };
}

/** The request path and query, resolved against the upstream base. */
export function resolveUpstream(upstream: string, requestUrl: string): Result<string> {
  const base = safeUrl(upstream.endsWith("/") ? upstream : `${upstream}/`);
  if (base === undefined || (base.protocol !== "http:" && base.protocol !== "https:")) {
    return {
      ok: false,
      error: tabError("VALIDATION", "UPSTREAM_INVALID", `upstream \`${upstream}\` is not an absolute http or https URL`),
    };
  }
  const incoming = safeUrl(requestUrl, base);
  if (incoming === undefined) {
    return {
      ok: false,
      error: tabError("VALIDATION", "REQUEST_URL_INVALID", `the request URL \`${requestUrl}\` does not parse`),
    };
  }
  const relative = `${incoming.pathname.replace(/^\/+/, "")}${incoming.search}`;
  return ok(new URL(relative, base).toString());
}

function safeUrl(value: string, base?: URL): URL | undefined {
  try {
    return base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    return undefined;
  }
}

/** A signal that fires on the caller's abort or on the timeout, whichever comes first. */
function forwardSignal(request: Request, timeoutMs: number | undefined): AbortSignal | undefined {
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const caller = request.signal;
  if (timeout === undefined) return caller;
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  return typeof any === "function" ? any([caller, timeout]) : timeout;
}

/**
 * Rebuilds the upstream response around its own body stream, minus the headers
 * the host `fetch` has already consumed. No byte of the body is read here.
 */
function reframe(upstream: Response): Response {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!REFRAMED_RESPONSE_HEADERS.includes(name.toLowerCase())) headers.append(name, value);
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** A `TabError` as the response it becomes: its category's status, the error as JSON. */
export function errorResponse(error: TabError): Response {
  return jsonResponse(httpStatusOf(error), {}, { ok: false, error });
}

function looksLikeResponse(value: unknown): value is Response {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { status?: unknown; headers?: unknown };
  return typeof candidate.status === "number" && typeof candidate.headers === "object" && candidate.headers !== null;
}

/** Releases a response that is not going out, so its connection does not wait for the collector. */
function discard(response: Response, logger: Logger): void {
  const body = response.body;
  if (body === null || response.bodyUsed) return;
  try {
    body.cancel().catch((error: unknown) => {
      logger.debug("discarded response body could not be cancelled", causeOf(error));
    });
  } catch (error) {
    logger.debug("discarded response body could not be cancelled", causeOf(error));
  }
}

/** The host's global `fetch`, behind a runtime check so its absence is an error and not a TypeError. */
function hostFetch(): ProxyFetch | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as ProxyFetch) : undefined;
}
