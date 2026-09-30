/**
 * The metering service: a Hono app that delivers work and then bills for it.
 *
 * ## The inversion, which is the whole product
 *
 * The handler runs, the response is produced, and only then is the delivered work
 * metered into the Agent's Open Tab. Nothing here waits on a payment, a Settlement,
 * or a signature before releasing a response. That is `tabPostPaid` from
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
 * ## x402 beside the credit decision
 *
 * With `x402` configured, the `402` also carries a `PAYMENT-REQUIRED` header:
 * the same charge as an x402 `exact` requirement, paid to the Service's
 * Collection address. A metered request that arrives with `PAYMENT-SIGNATURE`
 * is a prepaid call, and takes a different path through the same route: the
 * facilitator verifies the signature, the work is delivered, the facilitator
 * settles, and the response carries `PAYMENT-RESPONSE`. Nothing lands on the
 * Open Tab, because nothing is owed. The decision between the two paths is the
 * presence of that one request header and nothing else: without it, a request
 * is served on credit.
 *
 * `/hub/<prefix>/*` is the reverse. It fronts an x402 upstream: the gateway pays
 * the upstream with the operator's key and meters the Agent for the upstream's
 * price plus a margin. Before the operator signs, the delivery is simulated
 * against `TabBook` so an Agent with no headroom is refused without the
 * upstream being paid for nothing.
 *
 * ## Requests are authenticated, because this endpoint can spend
 *
 * The gateway holds the Service operator key, so an unauthenticated metering route
 * would let any stranger charge any Agent up to its whole authorisation ceiling.
 * Every metered route requires a signature over a digest that binds the Agent, the
 * tool, and the unit count, given by the operator, by the Agent being metered, or
 * by a delegate that Agent registered in `MeteringDelegates`, and checked by
 * {@link verifyMeteringRequest}; see `authorisation.ts` and `delegates.ts`.
 * The hub routes require the same signature, because each one also spends the
 * operator's x402 funds.
 */

import { Hono } from "hono";
import { encodeBytes32String } from "ethers";

import { httpStatusOf, type TabError } from "@tabai/shared";
import {
  createX402FrontedProxy,
  createX402UpstreamPricing,
  exactRequirementFor,
  handlePrepaidRequest,
  honoTabPostPaid,
  jsonResponse,
  paymentRequiredFor,
  paymentRequiredHeaders,
  paymentRequiredResponse,
  readPaymentSignature,
  tabPostPaid,
  type LimitExceededContext,
  type PostPaidPlugin,
  type X402FacilitatorClient,
  type X402Fetch,
  type X402PreflightQuote,
  type X402Signer,
} from "@tabai/sdk";

import { METERING_HEADER, meteringDigest, verifyMeteringRequest, type MeteringRequestClaim } from "./authorisation.js";
import type { MeteringDelegateReader } from "./delegates.js";
import { toSdkTabBookClient, type GatewayTabBookClient } from "./tab-book.js";
import type { SettlementRelay } from "./relay.js";

/** The x402 header a prepaid caller carries its payment in. */
const X402_PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";

/** Header carrying the Service operator's signature over {@link meteringDigest}. */
export const SIGNATURE_HEADER = "Tab-Operator-Signature";

/** Header carrying the millisecond timestamp the signature was issued at. */
export const ISSUED_AT_HEADER = "Tab-Operator-Issued-At";

/** The Asset this gateway meters in, in the SDK's own shape. */
export interface GatewayAsset {
  readonly chainId: bigint;
  readonly address: `0x${string}`;
  readonly decimals: number;
  readonly symbol: string;
}

/** The prepaid fallback. Present when x402 is enabled and a Collection address is known. */
export interface GatewayX402Options {
  readonly facilitator: X402FacilitatorClient;
  /** Where a prepaid call's funds go: the Service's Collection address for the Asset. */
  readonly payTo: `0x${string}`;
  /** How long an offered authorization stays valid. Defaults to 300 seconds. */
  readonly maxTimeoutSeconds?: number;
  /** The requirement's `extra`: the token's EIP-712 domain. Defaults to the one the SDK knows for the symbol. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** One x402 upstream fronted at `/hub/<prefix>/*`. */
export interface GatewayHubUpstream {
  readonly prefix: string;
  readonly url: string;
  /** The tool name the fronted calls are metered under. Packed to its 32-byte key here. */
  readonly tool: string;
  readonly marginBps?: bigint;
  readonly marginBaseUnits?: bigint;
  readonly maxUpstreamBaseUnits?: bigint;
  /** What one unit of the fronted tool costs in the applied price list. Defaults to one base unit. */
  readonly unitBaseUnits?: bigint;
  /** Where the upstream is paid, when not on the Service's own chain and Asset. */
  readonly payOn?: { readonly chainId: bigint; readonly asset: `0x${string}` };
}

export interface GatewayHubOptions {
  readonly upstreams: readonly GatewayHubUpstream[];
  /** What pays the upstreams: the operator's key, or a dedicated one. */
  readonly signer: X402Signer;
  /** The `fetch` the upstreams are called with. Defaults to the host's. */
  readonly fetchImpl?: X402Fetch<Response>;
  /** Seconds since the epoch, for the authorizations' `validBefore`. Defaults to the wall clock. */
  readonly nowSeconds?: () => number;
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
  readonly x402?: GatewayX402Options;
  readonly hub?: GatewayHubOptions;
  /**
   * The settlement relay, when this gateway pays gas for its Agents' Settlements.
   * Absent, `POST /relay/settle` answers 404 and an Agent settles with its own gas.
   */
  readonly relay?: SettlementRelay;
  /**
   * The `MeteringDelegates` reader, when this gateway accepts a delegate's
   * signature. Absent, a request signed only by a delegate is refused with
   * `METERING_DELEGATE_UNSUPPORTED` and the operator and Agent paths are
   * unchanged.
   */
  readonly meteringDelegates?: MeteringDelegateReader;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Every header a metering signature travels in, which never goes past this gateway. */
const METERING_SIGNATURE_HEADERS = [
  SIGNATURE_HEADER,
  ISSUED_AT_HEADER,
  METERING_HEADER.agentSignature,
  METERING_HEADER.agentIssuedAt,
  METERING_HEADER.delegate,
  METERING_HEADER.delegateSignature,
  METERING_HEADER.delegateIssuedAt,
];

const fail = (error: TabError): Response =>
  new Response(JSON.stringify({ ok: false, error }), {
    status: httpStatusOf(error),
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

/** The requirement one call's charge becomes, when x402 is on. */
function requirementFor(options: GatewayOptions, amount: bigint) {
  const x402 = options.x402;
  if (x402 === undefined) return undefined;
  return exactRequirementFor({
    chainId: options.asset.chainId,
    asset: options.asset,
    amount,
    payTo: x402.payTo,
    ...(x402.maxTimeoutSeconds === undefined ? {} : { maxTimeoutSeconds: x402.maxTimeoutSeconds }),
    ...(x402.extra === undefined ? {} : { extra: x402.extra }),
  });
}

const resourceFor = (url: string) => ({
  url,
  description: "A metered call on a Tab Service. Served on credit; this is the prepaid alternative.",
  mimeType: "application/json",
});

/**
 * The `402` on `LimitExceeded`, with the x402 offer beside the charge block.
 *
 * Every `Tab-Charge-*` header and the body the SDK built stay exactly as they
 * are; the one addition is `PAYMENT-REQUIRED`. A requirement that will not
 * build costs the refusal its offer and nothing else.
 */
function limitExceededWithOffer(options: GatewayOptions): ((context: LimitExceededContext) => Response) | undefined {
  if (options.x402 === undefined) return undefined;
  return (context) => jsonResponse(context.status, { ...context.headers, ...offerHeaders(options, context.requiredBaseUnits, context.request.url, context.error) }, context.body);
}

/** The `PAYMENT-REQUIRED` header for one charge, or nothing when no offer can be built. */
function offerHeaders(options: GatewayOptions, amount: bigint, url: string, error: TabError): Readonly<Record<string, string>> {
  const requirement = requirementFor(options, amount);
  if (requirement === undefined || !requirement.ok) return {};
  const headers = paymentRequiredHeaders(paymentRequiredFor({ resource: resourceFor(url), accepts: [requirement.value], error: error.message }));
  return headers.ok ? headers.value : {};
}

/**
 * Builds the plugin this gateway meters through.
 *
 * Exported separately from the app so a driver can reuse the exact configuration
 * the served routes use, rather than approximating it.
 */
export function createMeteringPlugin(options: GatewayOptions): PostPaidPlugin {
  const onLimitExceeded = limitExceededWithOffer(options);
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
    ...(onLimitExceeded === undefined ? {} : { onLimitExceeded }),
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
  const postPaid = honoTabPostPaid(plugin);
  const now = options.now ?? (() => Date.now());
  const requireSignature = options.requireSignature ?? true;
  const hubUpstreams = options.hub?.upstreams ?? [];
  const signedBy = options.meteringDelegates === undefined ? "signed by the operator or the Agent" : "signed by the operator, the Agent, or a delegate the Agent registered";

  /*
    What this is, for whoever opened the origin in a browser. The origin is the
    Service endpoint a `tab.config` names, so it is a URL people click, and an
    API that answers a click with "Cannot GET /" cannot be told from a broken
    one. Metered routes are not listed as an invitation: each one needs the
    operator's signature and records a delivery on chain.
  */
  app.get("/", (c) =>
    c.json({
      service: "tab-gateway",
      description:
        "Metering surface for a Tab Service on Monad. A metered call is delivered first and charged to an Open Tab afterwards.",
      serviceId: options.serviceId,
      operator: options.operator,
      x402: options.x402 === undefined ? "off" : "a 402 on LimitExceeded also offers an x402 payment; PAYMENT-SIGNATURE prepays one call",
      routes: [
        "/healthz",
        `/meter/:tool (${signedBy})`,
        ...hubUpstreams.map(
          (upstream) =>
            `/hub/${upstream.prefix}/* (${signedBy}, fronts ${upstream.url}${upstream.payOn === undefined ? "" : `, paid on chain ${upstream.payOn.chainId.toString(10)}`})`,
        ),
        ...(options.relay === undefined ? [] : ["/relay/settle (an Agent's Permit2 signature; this gateway pays the gas)"]),
      ],
    }),
  );

  app.get("/healthz", (c) => c.json({ status: "ok", serviceId: options.serviceId }));

  /*
    The settlement relay. No operator signature: the permit in the body is the
    Agent's own signature over everything the contract will act on, and a body
    that is not one is refused before a single chain read. See `relay.ts`.
  */
  if (options.relay !== undefined) {
    const relay = options.relay;
    app.post("/relay/settle", async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return fail({ category: "VALIDATION", code: "RELAY_BODY_INVALID", message: "the relay body must be JSON", retryable: false });
      }
      const relayed = await relay.relay(body);
      if (!relayed.ok) return fail(relayed.error);
      return c.json(relayed.value);
    });
  }

  /**
   * Authentication runs before metering, so an unsigned request never reaches
   * the chain and never spends the operator's gas or funds.
   *
   * Three parties may sign. The operator's signature is the Service's own front
   * vouching for a caller it authenticated; the Agent's is the Agent vouching
   * for itself, recovered against the address in `Tab-Agent`, which is what
   * lets a gateway on the open internet take calls from any Agent without
   * letting anyone charge an Agent that did not ask. A delegate's is a session
   * key the Agent named in `MeteringDelegates`: recovered against
   * `Tab-Delegate`, and then checked on chain as a key that Agent registered
   * and has not let lapse or revoked. The signature is checked before the
   * chain is read, so a forged one costs no RPC call. When more than one is
   * present the operator's is checked, then the Agent's, then the delegate's,
   * strongest claim first; a request that carries none is refused naming all.
   *
   * A prepaid call is the exception, and it authenticates itself. A request
   * carrying `PAYMENT-SIGNATURE` for a priced route is taken through the
   * facilitator: the caller signs a payment to this Service's own Collection
   * address for this exact charge, nothing lands on anyone's Open Tab, and no
   * gas of the operator's is spent. Requiring a metering signature there would
   * make the x402 offer unusable by the only callers it is for, the ones with
   * no account and no credit. A payment that does not verify delivers nothing,
   * and the header on an unpriced route buys no exemption, because there is
   * nothing to pay for and nothing to be prepaid.
   */
  const authenticate = (toolFor: (path: string) => `0x${string}`) => async (c: { req: { header(name: string): string | undefined; url: string; method: string }; res: Response }, next: () => Promise<void>) => {
    if (!requireSignature) return next();

    if (options.x402 !== undefined && c.req.header(X402_PAYMENT_SIGNATURE_HEADER) !== undefined) {
      const priced = options.priceOf(new URL(c.req.url).pathname);
      if (priced !== undefined) return next();
    }

    const agent = c.req.header("Tab-Agent");
    const operatorSignature = c.req.header(SIGNATURE_HEADER);
    const operatorIssuedAt = c.req.header(ISSUED_AT_HEADER);
    const agentSignature = c.req.header(METERING_HEADER.agentSignature);
    const agentIssuedAt = c.req.header(METERING_HEADER.agentIssuedAt);
    const delegate = c.req.header(METERING_HEADER.delegate);
    const delegateSignature = c.req.header(METERING_HEADER.delegateSignature);
    const delegateIssuedAt = c.req.header(METERING_HEADER.delegateIssuedAt);

    const byOperator = operatorSignature !== undefined && operatorIssuedAt !== undefined;
    const byAgent = agentSignature !== undefined && agentIssuedAt !== undefined;
    const byDelegate = delegate !== undefined && delegateSignature !== undefined && delegateIssuedAt !== undefined;
    if (agent === undefined || (!byOperator && !byAgent && !byDelegate)) {
      c.res = fail({
        category: "AUTHORISATION",
        code: "METERING_SIGNATURE_ABSENT",
        message: `a metered request must carry Tab-Agent and either ${SIGNATURE_HEADER} with ${ISSUED_AT_HEADER}, ${METERING_HEADER.agentSignature} with ${METERING_HEADER.agentIssuedAt}, or ${METERING_HEADER.delegate} with ${METERING_HEADER.delegateSignature} and ${METERING_HEADER.delegateIssuedAt}`,
        retryable: false,
      });
      return undefined;
    }

    // Only a delegate signed. Refused before any recovery when this gateway
    // reads no MeteringDelegates, so the answer names the missing piece.
    const delegates = options.meteringDelegates;
    if (!byOperator && !byAgent && delegates === undefined) {
      c.res = fail({
        category: "AUTHORISATION",
        code: "METERING_DELEGATE_UNSUPPORTED",
        message: `this gateway reads no MeteringDelegates contract, so a request signed only by a delegate cannot be accepted; sign with ${METERING_HEADER.agentSignature} as the Agent, or ask the Service to set METERING_DELEGATES_ADDRESS`,
        retryable: false,
      });
      return undefined;
    }

    const path = new URL(c.req.url).pathname;
    const claim: MeteringRequestClaim = {
      method: c.req.method,
      path,
      agent,
      tool: toolFor(path),
      units: 1,
      issuedAt: Number(byOperator ? operatorIssuedAt : byAgent ? agentIssuedAt : delegateIssuedAt),
    };
    const verified = byOperator
      ? verifyMeteringRequest(claim, operatorSignature, options.operator, now())
      : byAgent
        ? verifyMeteringRequest(claim, agentSignature as string, agent, now(), undefined, "agent")
        : verifyMeteringRequest(claim, delegateSignature as string, delegate as string, now(), undefined, "delegate");
    if (!verified.ok) {
      c.res = fail(verified.error);
      return undefined;
    }

    if (!byOperator && !byAgent && delegates !== undefined) {
      if (!ADDRESS.test(agent)) {
        c.res = fail({
          category: "VALIDATION",
          code: "AGENT_MALFORMED",
          message: "Tab-Agent must be the Agent's 20-byte 0x address",
          retryable: false,
        });
        return undefined;
      }
      const signer = verified.value.signer;
      const registered = await delegates.isDelegate(agent, signer);
      if (!registered.ok) {
        c.res = fail(registered.error);
        return undefined;
      }
      if (!registered.value) {
        c.res = fail({
          category: "AUTHORISATION",
          code: "METERING_DELEGATE_NOT_REGISTERED",
          message: `${signer} is not a metering delegate of ${agent.toLowerCase()} in MeteringDelegates at ${delegates.address}: never set, lapsed, or revoked; the Agent names one with MeteringDelegates.setDelegate`,
          retryable: false,
          details: { agent: agent.toLowerCase(), delegate: signer, meteringDelegates: delegates.address },
        });
        return undefined;
      }
    }
    return next();
  };

  app.use("/meter/*", authenticate((path) => options.priceOf(path)?.tool ?? `0x${"00".repeat(32)}`));

  /**
   * Prepaid or post-paid: the one decision, made on one header.
   *
   * A request carrying `PAYMENT-SIGNATURE` is taken through the facilitator and
   * never reaches the metering plugin. Everything else is the credit path.
   */
  app.use("/meter/*", async (c, next) => {
    const x402 = options.x402;
    if (x402 !== undefined) {
      const payment = readPaymentSignature(c.req.raw.headers);
      if (!payment.ok) {
        // Malformed payment data is a 400 by the HTTP transport specification.
        c.res = fail(payment.error);
        return;
      }
      if (payment.value !== undefined) {
        const path = new URL(c.req.url).pathname;
        const priced = options.priceOf(path);
        const requirement = priced === undefined ? undefined : requirementFor(options, priced.unitPrice);
        if (requirement !== undefined && !requirement.ok) {
          c.res = fail(requirement.error);
          return;
        }
        if (requirement === undefined) {
          // Not a priced route: there is nothing to pay for, so the signature
          // is ignored and the request is served as the unmetered call it is.
          return postPaid(c, next);
        }
        const outcome = await handlePrepaidRequest({
          facilitator: x402.facilitator,
          payload: payment.value,
          requirements: requirement.value,
          resource: resourceFor(c.req.url),
          deliver: async () => {
            await next();
            return c.res;
          },
        });
        if (outcome.kind === "handler-failed") throw outcome.thrown;
        c.res = outcome.response;
        return;
      }
    }
    return postPaid(c, next);
  });

  app.all("/meter/*", async (c) => {
    const path = new URL(c.req.url).pathname;
    if (options.deliver !== undefined) return options.deliver(path);
    // A stand-in for whatever this Service actually sells. It matters only that it
    // is produced before anything is metered, which the plugin guarantees.
    return c.json({ ok: true, delivered: path, at: now() });
  });

  // ---- the fronted upstreams

  const hub = options.hub;
  if (hub !== undefined) {
    for (const upstream of hub.upstreams) {
      const tool = encodeBytes32String(upstream.tool).toLowerCase() as `0x${string}`;
      const pricing = createX402UpstreamPricing({
        tool,
        margin: {
          ...(upstream.marginBps === undefined ? {} : { bps: upstream.marginBps }),
          ...(upstream.marginBaseUnits === undefined ? {} : { flatBaseUnits: upstream.marginBaseUnits }),
        },
        ...(upstream.unitBaseUnits === undefined ? {} : { unitBaseUnits: upstream.unitBaseUnits }),
      });
      const metering = tabPostPaid({
        serviceId: options.serviceId,
        asset: options.asset,
        tabBook: toSdkTabBookClient(options.tabBook),
        release: "after-metering",
        priceOf: pricing.priceOf,
        ...(options.now === undefined ? {} : { now: options.now }),
        onLimitExceeded: (context) =>
          jsonResponse(context.status, { ...context.headers, ...offerHeaders(options, context.requiredBaseUnits, context.request.url, context.error) }, context.body),
      });

      /**
       * The delivery, simulated before the operator signs, and **every** refusal
       * stops the payment.
       *
       * This is where a fronted call differs from a metered one. On a metered
       * route the work is already done when billing fails, and the Service eats
       * the cost of its own broken price list rather than handing it to a caller
       * who did nothing wrong. Here nothing has been done yet and the next step
       * spends the Service's own money on an upstream, so a Service that cannot
       * bill for a call must not buy it. An unpriced fronted tool, a stale
       * witness, an unreachable chain: each is the Service's to fix, and each
       * costs it nothing while it does.
       */
      const preflight = async (quote: X402PreflightQuote) => {
        if (quote.agent === undefined) {
          // Nobody to meter means nobody to pay for. Refused before the
          // operator signs, whatever the signature setting says.
          return {
            ok: false as const,
            error: {
              category: "AUTHORISATION" as const,
              code: "AGENT_UNIDENTIFIED",
              message: "a fronted call must carry Tab-Agent, the Agent whose Open Tab it is metered to",
              retryable: false,
            },
          };
        }
        // The same shape the metering plugin will use, so the simulation is of
        // the delivery that will actually be recorded: the amount in the unit
        // count, at the unit price the applied list holds.
        const units = (quote.amount + pricing.unitBaseUnits - 1n) / pricing.unitBaseUnits;
        const simulated = await options.tabBook.simulateDelivery({
          agent: quote.agent,
          serviceId: options.serviceId,
          asset: options.asset.address,
          tool,
          units: Number(units),
          expectedUnitPrice: pricing.unitBaseUnits,
        });
        if (simulated.ok) return { ok: true as const, value: undefined };
        return simulated;
      };

      const proxy = createX402FrontedProxy({
        upstream: upstream.url,
        stripPrefix: `/hub/${upstream.prefix}`,
        signer: hub.signer,
        asset: options.asset,
        pricing,
        metering,
        preflight,
        onRefused: (error, quote, request) => {
          const requirement = requirementFor(options, quote.amount);
          if (requirement === undefined || !requirement.ok) return undefined;
          return paymentRequiredResponse(paymentRequiredFor({ resource: resourceFor(request.url), accepts: [requirement.value], error: error.message }), error);
        },
        // Tab's own headers stay on this side of the hop: the upstream is paid
        // by the operator and has no business seeing the Agent or the signature.
        dropRequestHeaders: ["Tab-Agent", "Tab-Authorisation", ...METERING_SIGNATURE_HEADERS],
        ...(upstream.maxUpstreamBaseUnits === undefined ? {} : { maxUpstreamAmount: upstream.maxUpstreamBaseUnits }),
        ...(upstream.payOn === undefined ? {} : { upstreamPayment: { chainId: upstream.payOn.chainId, asset: upstream.payOn.asset } }),
        ...(hub.fetchImpl === undefined ? {} : { fetchImpl: hub.fetchImpl }),
        ...(hub.nowSeconds === undefined ? {} : { nowSeconds: hub.nowSeconds }),
      });

      app.use(`/hub/${upstream.prefix}/*`, authenticate(() => tool));
      /*
        A fronted call the Service paid for and metered to nobody is the Service
        giving its own money away, so the outcome is read rather than discarded
        and anything but a charge is logged with the reason the plugin gave.
      */
      app.all(`/hub/${upstream.prefix}/*`, async (c) => {
        const result = await proxy.proxy(c.req.raw);
        const outcome = result.metering === undefined ? undefined : await result.metering;
        if (result.response.ok && outcome?.kind !== "charged") {
          const why =
            outcome === undefined
              ? "the plugin reported no outcome"
              : outcome.kind === "not-metered"
                ? `${outcome.reason}: ${outcome.detail}`
                : outcome.kind === "failed"
                  ? `${outcome.error.code}: ${outcome.error.message}`
                  : outcome.kind;
          console.error(`gateway: a fronted /hub/${upstream.prefix} call was delivered and metered to nobody - ${why}`);
        }
        return result.response;
      });
    }
  }

  return app;
}
