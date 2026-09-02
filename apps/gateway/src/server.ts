/**
 * The metering service: a Hono app that delivers work and then bills for it.
 *
 * ## The inversion, which is the whole product
 *
 * The handler runs, the response is produced, and only then is the delivered work
 * metered into the Agent's Open Tab. Nothing here waits on a payment, a Settlement,
 * a proof, or a signature before releasing a response. That is `tabPostPaid` from
 * `packages/sdk` doing the work, and this file is deliberately thin over it: the
 * plugin owns the ordering, the `Tab-Charge-*` headers, and the revert-to-status
 * mapping, and duplicating any of that here would give the wire format two
 * definitions that could drift.
 *
 * What this file adds is the two things the SDK cannot know: which chain to talk
 * to, and who is allowed to ask.
 *
 * ## 402 is a credit decision and never an invoice
 *
 * The only refusal that becomes a `402` is `LimitExceeded`, because the status is
 * derived from the error's category through the SDK's own table rather than chosen
 * here. A `403` means the Agent's spending authorisation is missing, lapsed, or
 * spent, and a `409` means its tab went past its Settlement Window. Every other
 * revert is the Service's fault, and the SDK's disposition table delivers the
 * response anyway rather than handing the cost to the caller.
 *
 * ## Requests are authenticated, because this endpoint can spend
 *
 * The gateway holds the Service operator key, so an unauthenticated metering route
 * would let any stranger charge any Agent up to its whole authorisation ceiling.
 * Every metered route requires an operator signature over a digest that binds the
 * Agent, the tool, and the unit count, checked by {@link verifyMeteringRequest}.
 *
 * Requirements: 12.1, 12.2, 12.3, 23.3, 21.5
 */

import { Hono } from "hono";

import { httpStatusOf, type TabError } from "@tabai/shared";
import { honoTabPostPaid, tabPostPaid, type PostPaidPlugin } from "@tabai/sdk";

import { meteringDigest, verifyMeteringRequest, type MeteringRequestClaim } from "./authorisation.js";
import { toSdkTabBookClient, type GatewayTabBookClient } from "./tab-book.js";

/** Header carrying the Service operator's signature over {@link meteringDigest}. */
export const SIGNATURE_HEADER = "Tab-Operator-Signature";

/** Header carrying the millisecond timestamp the signature was issued at. */
export const ISSUED_AT_HEADER = "Tab-Operator-Issued-At";

/** The Asset this gateway meters in, in the SDK's own shape. */
export interface GatewayAsset {
  readonly chainKey: bigint;
  readonly address: `0x${string}`;
  readonly decimals: number;
  readonly symbol: string;
}

export interface GatewayOptions {
  readonly serviceId: `0x${string}`;
  readonly asset: GatewayAsset;
  readonly operator: string;
  readonly tabBook: GatewayTabBookClient;
  /** Base units per unit of the named tool, as the applied price list holds it. */
  readonly priceOf: (path: string) => { readonly tool: `0x${string}`; readonly unitPrice: bigint } | undefined;
  /** The work this Service actually delivers. Defaults to a trivial echo. */
  readonly deliver?: (path: string) => Promise<Response> | Response;
  /** Injected so a test does not depend on the wall clock. */
  readonly now?: () => number;
  /** Verifying every request costs a signature recovery; a test may switch it off. */
  readonly requireSignature?: boolean;
}

const fail = (error: TabError): Response =>
  new Response(JSON.stringify({ ok: false, error }), {
    status: httpStatusOf(error),
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

/**
 * Builds the plugin this gateway meters through.
 *
 * Exported separately from the app so a driver can reuse the exact configuration
 * the served routes use, rather than approximating it.
 */
export function createMeteringPlugin(options: GatewayOptions): PostPaidPlugin {
  return tabPostPaid({
    serviceId: options.serviceId,
    asset: options.asset,
    tabBook: toSdkTabBookClient(options.tabBook),
    // `after-metering`, the default, is what lets a `LimitExceeded` reach the
    // request that caused it. What it holds a response for is one credit record,
    // never a payment.
    release: "after-metering",
    priceOf: (request) => {
      const path = new URL(request.url, "http://gateway.invalid").pathname;
      const priced = options.priceOf(path);
      if (priced === undefined) return undefined;
      return { tool: priced.tool, units: 1, unitPrice: priced.unitPrice };
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/**
 * Builds the app.
 *
 * `/healthz` is unauthenticated and metered by nothing, because it reports this
 * process's own liveness and charging for a liveness probe would be absurd. Every
 * other route is metered and signed.
 */
export function createApp(options: GatewayOptions): Hono {
  const app = new Hono();
  const plugin = createMeteringPlugin(options);
  const now = options.now ?? (() => Date.now());
  const requireSignature = options.requireSignature ?? true;

  app.get("/healthz", (c) => c.json({ status: "ok", serviceId: options.serviceId }));

  // Authentication runs before metering, so an unsigned request never reaches the
  // chain and never spends the operator's gas.
  app.use("/meter/*", async (c, next) => {
    if (!requireSignature) return next();

    const signature = c.req.header(SIGNATURE_HEADER);
    const issuedAt = c.req.header(ISSUED_AT_HEADER);
    const agent = c.req.header("Tab-Agent");
    if (signature === undefined || issuedAt === undefined || agent === undefined) {
      c.res = fail({
        category: "AUTHORISATION",
        code: "METERING_SIGNATURE_ABSENT",
        message: `a metered request must carry ${SIGNATURE_HEADER}, ${ISSUED_AT_HEADER}, and Tab-Agent`,
        retryable: false,
      });
      return undefined;
    }

    const path = new URL(c.req.url).pathname;
    const priced = options.priceOf(path);
    const claim: MeteringRequestClaim = {
      method: c.req.method,
      path,
      agent,
      tool: priced?.tool ?? `0x${"00".repeat(32)}`,
      units: 1,
      issuedAt: Number(issuedAt),
    };
    const verified = verifyMeteringRequest(claim, signature, options.operator, now());
    if (!verified.ok) {
      c.res = fail(verified.error);
      return undefined;
    }
    return next();
  });

  app.use("/meter/*", honoTabPostPaid(plugin));

  app.all("/meter/*", async (c) => {
    const path = new URL(c.req.url).pathname;
    if (options.deliver !== undefined) return options.deliver(path);
    // A stand-in for whatever this Service actually sells. It matters only that it
    // is produced before anything is metered, which the plugin guarantees.
    return c.json({ ok: true, delivered: path, at: now() });
  });

  return app;
}
