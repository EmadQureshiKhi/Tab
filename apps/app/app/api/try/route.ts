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
 * ## Only what the repository publishes
 *
 * The endpoint is looked up in `service-endpoints.json` by the serviceId the
 * caller names. It is never taken from the request. A handler that fetched a URL
 * a browser supplied would be an open proxy sitting on this deployment's network,
 * and the fact that the URL would come from this site's own page is not a control
 * - a request is whatever the sender makes it.
 *
 * ## It reports refusals
 *
 * The Service's status and body are passed back as they arrived. A tool that
 * declines because the Agent has no Credit Limit is the most instructive answer
 * this endpoint can give, and swallowing it in favour of a generic failure would
 * hide the half of the system worth seeing.
 *
 * Requirements: 24.9
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

/**
 * Long enough for a metered call, short enough that a hung Service is not this
 * page's problem.
 *
 * A metered delivery is a Creditcoin write, so the Service does not answer until
 * a block has carried it. Twenty seconds was under one block time and timed out
 * on a call that was working.
 */
const TIMEOUT_MS = 75_000;

interface Published {
  readonly serviceId: string;
  readonly endpoint: string;
}

async function endpointFor(serviceId: string): Promise<string | undefined> {
  try {
    const path = join(process.cwd(), "..", "..", "service-endpoints.json");
    const parsed = JSON.parse(await readFile(path, "utf8")) as { services?: readonly Published[] };
    const match = parsed.services?.find(
      (entry) => entry.serviceId.toLowerCase() === serviceId.toLowerCase(),
    );
    return match?.endpoint;
  } catch {
    return undefined;
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: { serviceId?: unknown; tool?: unknown };
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

  const endpoint = await endpointFor(serviceId);
  if (endpoint === undefined) {
    return json(
      {
        error:
          "This project publishes no address for that Service, so there is nowhere to send the call.",
      },
      404,
    );
  }

  /*
    The Agent the call is billed to.

    Not taken from the request. A charge lands on somebody's Open Tab, and an
    endpoint that let a caller name whose tab would let anyone bill anyone. It is
    this deployment's demonstration Agent or nothing.
  */
  const agent = process.env["TRY_IT_AGENT"]?.trim();
  if (agent === undefined || !/^0x[0-9a-fA-F]{40}$/.test(agent)) {
    return json(
      {
        error:
          "This deployment names no Agent for a trial call, so there is no tab for the charge to land on. Set TRY_IT_AGENT to enable it.",
      },
      501,
    );
  }

  const stop = AbortSignal.timeout(TIMEOUT_MS);
  try {
    // The gateway meters `/meter/*` and prices by path. A metered request is
    // authenticated by the operator's signature, which this deployment does not
    // hold and should not: where the gateway requires one, the refusal it returns
    // is passed straight through, and saying so is more useful than hiding it.
    const target = `${endpoint.replace(/\/$/, "")}/meter/${encodeURIComponent(tool)}`;
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Tab-Agent": agent,
      },
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
