/**
 * The Proof Service: a Hono app that builds a proof, bills for it, and only then
 * hands it over.
 *
 * ## The ordering is the requirement, not an implementation detail
 *
 * R22.3 says the Metered Delivery is recorded on Creditcoin **before** the proof
 * material is returned, and R22.5 says an unattested height is refused with zero
 * Metered Delivery. Both are ordering rules, and both are enforced here by
 * `tabPostPaid` from `packages/sdk` running in its `after-metering` release mode:
 * the handler produces the material, the plugin records the delivery, and only then
 * does the response leave. Nothing waits on a payment, a Settlement, or a proof of
 * funds. What is held is one credit record.
 *
 * The refusal side falls out of the same arrangement. An unattested height comes
 * back from the deliverer as `HEIGHT_NOT_ATTESTED`, which is category `UNAVAILABLE`
 * and therefore a 503, and the plugin's billability rule is that a response at or
 * above 400 is not a delivery. So nothing is metered, and the Agent gets both
 * heights in the body rather than a bare "try later".
 *
 * ## Unmetered material is withheld, which the SDK's default would not do
 *
 * The SDK's disposition table delivers a response anyway when metering fails for a
 * reason that is the Service's own fault. That is right for a Service whose product
 * is an answer the Agent already has half of; it is wrong for one whose entire
 * product is the bytes in the body. So {@link ProofServiceOptions.withholdUnmetered}
 * defaults to true and replaces such a response with a 503 naming what failed. The
 * plugin still owns the ordering, the headers and the revert mapping; this file adds
 * one policy on top of it and does not re-implement any of it.
 *
 * ## Requests are authenticated as the Agent they charge
 *
 * A public endpoint that charges whoever a header names is a way to burn any
 * Agent's authorisation ceiling. Every metered request carries the Agent's own
 * signature over a digest binding the Agent, the tool, the unit count and the
 * Source Chain reference, checked by {@link verifyAgentRequest}.
 *
 * Requirements: 22.1, 22.3, 22.5, 12.1, 12.2, 12.3, 23.3
 */

import { Hono } from "hono";

import { httpStatusOf, type TabError } from "@tabai/shared";
import {
  attachHeaders,
  tabPostPaid,
  type MeteredRequest,
  type MeteringOutcome,
  type PostPaidPlugin,
} from "@tabai/sdk";

import {
  ISSUED_AT_HEADER,
  SIGNATURE_HEADER,
  verifyAgentRequest,
  type ProofRequestClaim,
} from "./authorisation.js";
import type { ProofDeliverer } from "./delivery.js";
import { toSdkTabBookClient, type ProofServiceTabBookClient } from "./tab-book.js";

/** The route every metered request lands on. */
export const PROOF_PATH_PREFIX = "/proof/";

/**
 * The priced unit this Service registered.
 *
 * Read off the applied price list rather than guessed: `TabBook.recordDelivery`
 * reverts `UnknownTool` for any other name, which is what a first live run with
 * "proof" met.
 */
export const PROOF_TOOL_NAME = "proof.generate";

/** The Asset this Service meters in, in the SDK's own shape. */
export interface ProofServiceAsset {
  readonly chainKey: bigint;
  readonly address: `0x${string}`;
  readonly decimals: number;
  readonly symbol: string;
}

export interface ProofServiceOptions {
  readonly serviceId: `0x${string}`;
  readonly asset: ProofServiceAsset;
  /** The 32-byte word the applied price list is keyed by. */
  readonly tool: `0x${string}`;
  /** Base units per proof, as the applied price list holds it. */
  readonly unitPrice: bigint;
  readonly tabBook: ProofServiceTabBookClient;
  readonly deliverer: ProofDeliverer;
  /**
   * Whether a response whose delivery was not metered is withheld. Defaults to
   * true, which is what R22.3 asks for.
   */
  readonly withholdUnmetered?: boolean;
  /** Verifying every request costs a signature recovery; a test may switch it off. */
  readonly requireSignature?: boolean;
  /** Injected so a test does not depend on the wall clock. */
  readonly now?: () => number;
  /** Called with every recorded charge, for a log line or a metric. */
  readonly onCharge?: (charge: { readonly agent: string; readonly amount: bigint }) => void;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const fail = (error: TabError): Response => json(httpStatusOf(error), { ok: false, error });

/** The reference carried in the path, so pricing and the signed digest see the same words. */
export interface PathReference {
  readonly chainKey: bigint;
  readonly sourceTxHash: string;
}

/**
 * Reads `/proof/<chainKey>/<sourceTxHash>` out of a path.
 *
 * Deliberately tolerant of nothing: a path that does not match is not a proof
 * request, and treating a near miss as one would price a route that cannot be
 * served.
 */
export function referenceFromPath(path: string): PathReference | undefined {
  if (!path.startsWith(PROOF_PATH_PREFIX)) return undefined;
  const parts = path.slice(PROOF_PATH_PREFIX.length).split("/");
  const [chainKeyRaw, hashRaw] = parts;
  if (parts.length !== 2 || chainKeyRaw === undefined || hashRaw === undefined) return undefined;
  if (!/^\d+$/.test(chainKeyRaw)) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hashRaw)) return undefined;
  return { chainKey: BigInt(chainKeyRaw), sourceTxHash: hashRaw.toLowerCase() };
}

/**
 * Builds the plugin this Service meters through.
 *
 * Exported separately from the app so a driver can reuse the exact configuration
 * the served routes use, rather than approximating it.
 */
export function createMeteringPlugin(options: ProofServiceOptions): PostPaidPlugin {
  return tabPostPaid({
    serviceId: options.serviceId,
    asset: options.asset,
    tabBook: toSdkTabBookClient(options.tabBook),
    // `after-metering`, the default, is the ordering R22.3 requires: the delivery
    // is recorded before the response is released.
    release: "after-metering",
    priceOf: (request) => {
      const path = new URL(request.url, "http://proof-service.invalid").pathname;
      if (referenceFromPath(path) === undefined) return undefined;
      return { tool: options.tool, units: 1, unitPrice: options.unitPrice };
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onCharge === undefined
      ? {}
      : {
          onCharge: (charge): void => {
            options.onCharge?.({ agent: charge.agent, amount: charge.amount });
          },
        }),
  });
}

/** Whether an outcome means the material was paid for. */
export function wasMetered(outcome: MeteringOutcome): boolean {
  return outcome.kind === "charged";
}

/**
 * Why a delivered response was not metered, or undefined when withholding it
 * would be wrong.
 *
 * `not-billable` is the R22.5 path and every other refusal path: the handler
 * already answered with a status at or above 400, so there is nothing to withhold
 * and nothing was charged. Every other unmetered outcome on a delivered response
 * means proof material would go out free.
 */
export function withholdingReason(outcome: MeteringOutcome): TabError | undefined {
  if (outcome.kind === "charged") return undefined;
  if (outcome.kind === "refused") return undefined;
  if (outcome.kind === "failed") {
    return {
      category: "UNAVAILABLE",
      code: "DELIVERY_NOT_METERED",
      message: `the proof material was built and the Metered Delivery could not be recorded on Creditcoin, so the material is withheld rather than given away: ${outcome.error.message}`,
      retryable: outcome.error.retryable,
      details: { meteringCode: outcome.error.code, metered: false },
    };
  }
  if (outcome.reason === "not-billable" || outcome.reason === "handler-failed") return undefined;
  return {
    category: "UNAVAILABLE",
    code: "DELIVERY_NOT_METERED",
    message: `the proof material was built and nothing was metered for it (${outcome.reason}: ${outcome.detail}), so the material is withheld rather than given away`,
    retryable: false,
    details: { reason: outcome.reason, metered: false },
  };
}

/**
 * Builds the app.
 *
 * `/healthz` is unauthenticated and metered by nothing, because it reports this
 * process's own liveness and charging for a liveness probe would be absurd. Every
 * other route is metered and signed.
 */
export function createApp(options: ProofServiceOptions): Hono {
  const app = new Hono();
  const plugin = createMeteringPlugin(options);
  const now = options.now ?? ((): number => Date.now());
  const requireSignature = options.requireSignature ?? true;
  const withhold = options.withholdUnmetered ?? true;

  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      serviceId: options.serviceId,
      tool: options.tool,
      unitPriceBaseUnits: options.unitPrice.toString(10),
      asset: `${options.asset.chainKey.toString(10)}:${options.asset.address}`,
    }),
  );

  app.post("/proof/*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname;
    const reference = referenceFromPath(path);
    if (reference === undefined) {
      return fail({
        category: "VALIDATION",
        code: "PROOF_PATH_MALFORMED",
        message:
          "a proof request is POST /proof/<chainKey>/<sourceTxHash>, where chainKey is 1 for Ethereum Sepolia or 3 for Ethereum Mainnet and the hash is a 0x-prefixed 32-byte word",
        retryable: false,
      });
    }

    const agent = c.req.header("Tab-Agent");
    if (agent === undefined || !/^0x[0-9a-fA-F]{40}$/.test(agent)) {
      return fail({
        category: "AUTHORISATION",
        code: "AGENT_HEADER_ABSENT",
        message: "a proof request must carry Tab-Agent, the Agent's 20-byte Creditcoin address",
        retryable: false,
      });
    }

    // Authentication runs before anything is built, so an unsigned request never
    // reaches the Proof Builder and never spends the operator's gas.
    if (requireSignature) {
      const signature = c.req.header(SIGNATURE_HEADER);
      const issuedAt = c.req.header(ISSUED_AT_HEADER);
      if (signature === undefined || issuedAt === undefined) {
        return fail({
          category: "AUTHORISATION",
          code: "PROOF_SIGNATURE_ABSENT",
          message: `a proof request must carry ${SIGNATURE_HEADER} and ${ISSUED_AT_HEADER} alongside Tab-Agent`,
          retryable: false,
        });
      }
      const claim: ProofRequestClaim = {
        method: c.req.method,
        path,
        agent,
        tool: options.tool,
        units: 1,
        chainKey: reference.chainKey.toString(10),
        sourceTxHash: reference.sourceTxHash,
        issuedAt: Number(issuedAt),
      };
      const verified = verifyAgentRequest(claim, signature, now());
      if (!verified.ok) return fail(verified.error);
    }

    const heightRaw = url.searchParams.get("height");
    if (heightRaw !== null && !/^\d+$/.test(heightRaw)) {
      return fail({
        category: "VALIDATION",
        code: "BLOCK_HEIGHT_MALFORMED",
        message: "the optional `height` query parameter must be a decimal block number",
        retryable: false,
      });
    }

    const metered: MeteredRequest = {
      method: c.req.method,
      url: c.req.url,
      headers: { get: (name: string): string | undefined => c.req.header(name) },
    };

    const execution = await plugin.execute(metered, async () => {
      const delivered = await options.deliverer.deliver({
        chainKey: reference.chainKey,
        sourceTxHash: reference.sourceTxHash,
        ...(heightRaw === null ? {} : { blockHeight: BigInt(heightRaw) }),
      });
      if (!delivered.ok) return fail(delivered.error);
      return json(200, { ok: true, proof: delivered.value });
    });

    if (execution.kind === "handler-failed") return fail(execution.error);
    if (execution.kind === "refused") return execution.response;

    const outcome = await execution.metering;
    if (withhold) {
      const reason = withholdingReason(outcome);
      if (reason !== undefined) return fail(reason);
    }
    return attachHeaders(execution.response, plugin.headersFor(outcome));
  });

  return app;
}
