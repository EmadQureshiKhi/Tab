/**
 * `POST /api/try` - calls a published Service and returns what it said.
 *
 * ## Why the call is made here and not in the browser
 *
 * A Service is not obliged to allow this site's origin, and it should not have to
 * be: an MCP endpoint exists to be called by agents, not by web pages. A browser
 * call would fail on CORS before it reached the Service, and the page would then
 * be reporting a fact about a preflight rather than about the Service. Making it
 * from the server means the answer on the page is the Service's answer.
 *
 * ## Only what the repository publishes, on the selected network
 *
 * The endpoint is looked up in `service-endpoints.json` by the serviceId the
 * caller names and the network the visitor selected. It is never taken from the
 * request. A handler that fetched a URL a browser supplied would be an open proxy
 * sitting on this deployment's network, and the fact that the URL would come from
 * this site's own page is not a control - a request is whatever the sender makes
 * it. The page also sends the chain it was drawn for, and a call from a page left
 * open across a network switch is refused rather than sent to the other network.
 *
 * ## Mainnet calls are rationed
 *
 * Every trial call spends the operator's gas and puts a charge on the demo
 * Agent's tab. On Mainnet both are real money, so calls there are limited per
 * client address and per day; see `src/dashboard/trial-limit.ts`.
 *
 * ## It reports refusals
 *
 * The Service's status and body are passed back as they arrived. A tool that
 * declines because the Agent has no Credit Limit is the most instructive answer
 * this endpoint can give, and swallowing it in favour of a generic failure would
 * hide the half of the system worth seeing.
 */

import { Wallet } from "ethers";

import { METERING_HEADER, meteringDigest, toolKeyOf } from "@tabai/sdk";
import { MONAD_MAINNET, MONAD_TESTNET, type MonadChainId } from "@tabai/shared";

import {
  MAINNET_TRIAL_DEFAULTS,
  TESTNET_TRIAL_LIMITS,
  clientAddressOf,
  createTrialLimiter,
  limitFromEnv,
  type TrialLimiter,
} from "../../../src/dashboard/trial-limit";
import { requestChainId, tryItAgent } from "../../_lib/context";
import { publishedDirectory } from "../../_lib/published";

export const dynamic = "force-dynamic";

/**
 * Long enough for a metered call, short enough that a hung Service is not this
 * page's problem.
 *
 * A metered delivery is one Monad write, and the Service does not answer until
 * the block has carried it. A Monad block is about a second, so thirty seconds
 * is many blocks of headroom and still short enough that a Service that has
 * stopped answering is reported as such rather than left spinning.
 */
const TIMEOUT_MS = 30_000;

/*
  One limiter per network, held in this module.

  In memory, deliberately and with a known cost: on a serverless host every
  warm instance keeps its own windows and a cold start begins empty, so the
  effective ceiling is the configured one times the number of live instances.
  That is still a ceiling, which is what stands between the button and an
  unbounded bill; a shared store would make it exact and is the next step if
  the demo is ever abused in earnest. `TRY_IT_MAINNET_PER_DAY=0` switches
  Mainnet trial calls off outright.
*/
const LIMITERS: Readonly<Record<MonadChainId, TrialLimiter>> = {
  [MONAD_TESTNET.chainId]: createTrialLimiter(TESTNET_TRIAL_LIMITS),
  [MONAD_MAINNET.chainId]: createTrialLimiter({
    perAddressPerMinute: limitFromEnv(
      process.env["TRY_IT_MAINNET_PER_IP_PER_MINUTE"],
      MAINNET_TRIAL_DEFAULTS.perAddressPerMinute,
    ),
    perDay: limitFromEnv(process.env["TRY_IT_MAINNET_PER_DAY"], MAINNET_TRIAL_DEFAULTS.perDay ?? 0),
  }),
};

function endpointFor(serviceId: string, chainId: MonadChainId): string | undefined {
  return publishedDirectory(chainId).find((entry) => entry.serviceId.toLowerCase() === serviceId.toLowerCase())
    ?.endpoint;
}

/**
 * A response this route produced itself, marked as such.
 *
 * The page shows the Service's answer as the Service's own, so a refusal that
 * never left this deployment must not wear that label. The header is the mark
 * the page reads; the Service's own responses are passed through without it.
 */
const ORIGIN_HEADER = "Tab-Try-Origin";

function json(body: unknown, status: number, extra: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", [ORIGIN_HEADER]: "dashboard", ...extra },
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: { serviceId?: unknown; tool?: unknown; chainId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "The request body was not JSON." }, 400);
  }

  const serviceId = typeof body.serviceId === "string" ? body.serviceId : undefined;
  const tool = typeof body.tool === "string" ? body.tool : undefined;
  if (serviceId === undefined || tool === undefined) {
    return json({ error: "Name a serviceId and a tool." }, 400);
  }

  const chainId = requestChainId(request);
  if (body.chainId !== undefined && body.chainId !== chainId) {
    return json(
      {
        error:
          "This page was drawn for a different network than the one now selected, so the call was not sent. Reload the page and try again.",
        pageChainId: body.chainId,
        selectedChainId: chainId,
      },
      409,
    );
  }

  const endpoint = endpointFor(serviceId, chainId);
  if (endpoint === undefined) {
    return json(
      {
        error:
          "This project publishes no address for that Service on this network, so there is nowhere to send the call.",
      },
      404,
    );
  }

  /*
    The Agent the call is billed to.

    Not taken from the request. A charge lands on somebody's Open Tab, and an
    endpoint that let a caller name whose tab would let anyone bill anyone. It is
    this deployment's demonstration Agent on the selected network or nothing.
  */
  const agent = tryItAgent(chainId);
  if (agent === undefined || !/^0x[0-9a-fA-F]{40}$/.test(agent)) {
    return json(
      {
        error:
          chainId === MONAD_TESTNET.chainId
            ? "This deployment names no Agent for a trial call on Testnet, so there is no tab for the charge to land on. Set TRY_IT_AGENT_TESTNET to enable it."
            : "This deployment names no Agent for a trial call on Mainnet, so there is no tab for the charge to land on. Set TRY_IT_AGENT_MAINNET to enable it.",
      },
      501,
    );
  }

  // Counted only once the call is otherwise ready to go, so a malformed request
  // or an unpublished Service costs a caller none of their allowance.
  const allowed = LIMITERS[chainId].take(clientAddressOf(request.headers));
  if (!allowed.ok) {
    if (allowed.scope === "off") {
      return json({ error: "Trial calls on this network are switched off on this deployment." }, 429);
    }
    return json(
      {
        error:
          allowed.scope === "address"
            ? `Too many trial calls from this address. Try again in ${allowed.retryAfterSeconds} seconds.`
            : "This site has made all the trial calls it allows on this network today. Try again tomorrow, or call the Service from your own Agent.",
        retryAfterSeconds: allowed.retryAfterSeconds,
      },
      429,
      { "retry-after": String(allowed.retryAfterSeconds) },
    );
  }

  const stop = AbortSignal.timeout(TIMEOUT_MS);
  try {
    /*
      The gateway meters `/meter/*` and prices by path, and authenticates the
      caller as the Service operator before anything reaches the chain.

      That signature is not optional on a gateway anyone can reach. Every metered
      call records a delivery and spends the operator's gas, so an unauthenticated
      one is a bill anybody can run up. This route therefore signs the claim when
      it holds the key, and when it does not it sends the request unsigned and
      passes the gateway's refusal straight back, which says what is missing
      rather than hiding it. One operator key serves both networks, because the
      demo Service has the same operator on each, and each network's gateway
      recovers the signer and checks it against its own `ServiceRegistry`.
    */
    const target = `${endpoint.replace(/\/$/, "")}/meter/${encodeURIComponent(tool)}`;
    const path = new URL(target).pathname;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "Tab-Agent": agent,
    };

    const operatorKey = process.env["GATEWAY_PRIVATE_KEY"]?.trim();
    if (operatorKey !== undefined && operatorKey !== "" && !operatorKey.startsWith("0xREPLACE")) {
      const issuedAt = Date.now();
      // The digest the gateway rebuilds and recovers against, from the SDK so
      // the two sides cannot drift. `tool` is the 32-byte key the price list
      // is keyed by, not the label.
      const digest = meteringDigest({ method: "POST", path, agent, tool: toolKeyOf(tool), units: 1, issuedAt });
      headers[METERING_HEADER.operatorSignature] = await new Wallet(operatorKey).signMessage(digest);
      headers[METERING_HEADER.operatorIssuedAt] = String(issuedAt);
    }

    const response = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool }),
      signal: stop,
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "text/plain" },
    });
  } catch (cause) {
    const reason =
      cause instanceof Error && cause.name === "TimeoutError"
        ? `The Service did not answer within ${Math.round(TIMEOUT_MS / 1000)} seconds.`
        : `The Service could not be reached: ${cause instanceof Error ? cause.message : "no reason given"}.`;
    return json({ error: reason, endpoint }, 502);
  }
}
