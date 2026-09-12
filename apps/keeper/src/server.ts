/**
 * The keeper's HTTP surface.
 *
 * - `GET /healthz`: the process is up, and whether it holds a key.
 * - `GET /overdue`: the current verdicts, recomputed on every request at one
 *   block. Nothing is sent, so this needs no secret.
 * - `POST /tick`: judge, simulate and mark. Guarded by `KEEPER_SHARED_SECRET`,
 *   because a mark spends this process's gas, and refused outright when no
 *   secret is configured. The body may name `tabIds` to restrict the marks;
 *   the verdicts are recomputed either way.
 *
 * Every failure is the same shape the rest of the workspace answers with:
 * `{ error: { category, code, message } }` under the category's HTTP status.
 */

import { Hono } from "hono";
import { httpStatusOf, type TabError } from "@tabai/shared";

import { runTick, readOverdue, type TickDeps } from "./tick.js";

export interface KeeperAppOptions {
  readonly deps: TickDeps;
  readonly sharedSecret: string | undefined;
  /** Whether `POST /tick` may send. False when no key is configured. */
  readonly canBroadcast: boolean;
  readonly chainId: number;
  readonly version?: string | undefined;
}

const AUTH_HEADER = "authorization";
const SECRET_HEADER = "x-keeper-secret";

/** Constant-time equality, so a secret cannot be guessed byte by byte from timings. */
function sameSecret(supplied: string, expected: string): boolean {
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    diff |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

/** The secret a request carries, as `Authorization: Bearer <secret>` or `X-Keeper-Secret`. */
export function suppliedSecret(headers: { get(name: string): string | null | undefined }): string | undefined {
  const bearer = headers.get(AUTH_HEADER);
  if (typeof bearer === "string" && /^bearer\s+/i.test(bearer)) return bearer.replace(/^bearer\s+/i, "").trim();
  const direct = headers.get(SECRET_HEADER);
  return typeof direct === "string" && direct.length > 0 ? direct : undefined;
}

const failure = (error: TabError) => ({ error: { category: error.category, code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });

export function createKeeperApp(options: KeeperAppOptions): Hono {
  const app = new Hono();

  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      chainId: options.chainId,
      canBroadcast: options.canBroadcast,
      tickProtected: options.sharedSecret !== undefined,
      ...(options.version === undefined ? {} : { version: options.version }),
    }),
  );

  app.get("/overdue", async (c) => {
    const judged = await readOverdue(options.deps);
    if (!judged.ok) return c.json(failure(judged.error), httpStatusOf(judged.error) as 500);
    return c.json(judged.value.json);
  });

  app.post("/tick", async (c) => {
    if (options.sharedSecret === undefined) {
      return c.json(
        failure({ category: "UNAVAILABLE", code: "TICK_UNPROTECTED", message: "KEEPER_SHARED_SECRET is unset, so POST /tick is refused; set it to enable remote ticks", retryable: false }),
        503,
      );
    }
    const supplied = suppliedSecret(c.req.raw.headers);
    if (supplied === undefined || !sameSecret(supplied, options.sharedSecret)) {
      return c.json(failure({ category: "AUTHORISATION", code: "TICK_SECRET_INVALID", message: "POST /tick needs the shared secret as a Bearer token or X-Keeper-Secret header", retryable: false }), 403);
    }
    let body: unknown = {};
    const raw = await c.req.text();
    if (raw.trim().length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        return c.json(failure({ category: "VALIDATION", code: "TICK_BODY_MALFORMED", message: "the body of POST /tick must be JSON", retryable: false }), 400);
      }
    }
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    let only: string[] | undefined;
    if (record["tabIds"] !== undefined) {
      if (!Array.isArray(record["tabIds"]) || !record["tabIds"].every((id) => typeof id === "string" && /^0x[0-9a-fA-F]{64}$/.test(id))) {
        return c.json(failure({ category: "VALIDATION", code: "TICK_TAB_IDS_MALFORMED", message: "tabIds must be an array of 32-byte 0x words", retryable: false }), 400);
      }
      only = record["tabIds"] as string[];
    }
    const broadcast = record["broadcast"] === undefined ? options.canBroadcast : record["broadcast"] === true && options.canBroadcast;
    const report = await runTick(options.deps, { broadcast, ...(only === undefined ? {} : { only }) });
    if (!report.ok) return c.json(failure(report.error), httpStatusOf(report.error) as 500);
    return c.json(report.value);
  });

  return app;
}
