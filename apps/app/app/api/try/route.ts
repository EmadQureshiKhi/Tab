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

import { Wallet, encodeBytes32String } from "ethers";
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

/** A Source Chain transaction to prove, and the chain it happened on. */
interface ProofTarget {
  readonly chainKey: number;
  readonly txHash: string;
}

/**
 * Finds a real Settlement for the Proof Service to prove.
 *
 * The Proof Service proves a transaction that happened, so this has to name one,
 * and it asks the chain rather than carrying a hash in the source. A pinned hash
 * would work the day it was written and get steadily more expensive to prove
 * every week after it: proof material perishes as a height ages from the
 * stride-10 attestation grid onto the stride-100 checkpoint grid, so the newest
 * Settlement is both the most honest example and the cheapest one.
 *
 * The registry records a Settlement by its replay key and its Source Chain
 * coordinates rather than by transaction hash, which is the right identity for a
 * log. One block read turns the coordinates back into the hash the Proof Service
 * asks for.
 */
async function newestSettlement(signal: AbortSignal): Promise<ProofTarget | undefined> {
  const registry = process.env["NEXT_PUBLIC_REGISTRY_API_URL"]?.replace(/\/+$/, "");
  const rpc = process.env["ETHEREUM_SEPOLIA_RPC_URLS"]?.split(",")[0]?.trim();
  if (registry === undefined || registry === "" || rpc === undefined || rpc === "") return undefined;

  try {
    const listed = await fetch(`${registry}/settlements?limit=1`, { signal });
    if (!listed.ok) return undefined;
    const rows = (await listed.json()) as {
      settlements?: readonly { chainKey?: number; sourceBlockHeight?: number; sourceTxIndex?: number }[];
    };
    const newest = rows.settlements?.[0];
    if (
      newest?.chainKey === undefined ||
      newest.sourceBlockHeight === undefined ||
      newest.sourceTxIndex === undefined
    ) {
      return undefined;
    }
    // Only Ethereum Sepolia has an endpoint configured here, and proving a
    // Mainnet height against a Sepolia node would quietly return the wrong
    // transaction rather than failing.
    if (newest.chainKey !== 1) return undefined;

    const block = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBlockByNumber",
        params: [`0x${newest.sourceBlockHeight.toString(16)}`, false],
      }),
      signal,
    });
    if (!block.ok) return undefined;
    const payload = (await block.json()) as { result?: { transactions?: readonly string[] } };
    const hash = payload.result?.transactions?.[newest.sourceTxIndex];
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return undefined;
    return { chainKey: newest.chainKey, txHash: hash };
  } catch {
    // No target means the caller says so plainly rather than proving something
    // invented.
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
  let body: { serviceId?: unknown; tool?: unknown; mode?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "The request body was not JSON." }, 400);
  }

  const serviceId = typeof body.serviceId === "string" ? body.serviceId : undefined;
  const tool = typeof body.tool === "string" ? body.tool : undefined;
  /*
    Which of the Service's two surfaces to call.

    `meter` records a Metered Delivery and answers with whatever the Service
    sells. `proof` asks the Proof Service for the material a Settlement actually
    needs: an encoded transaction, a Merkle inclusion proof and a Continuity
    Proof. Both write a charge to the same Open Tab and both wait on a Creditcoin
    block, so they cost the caller the same and take about the same time; what
    differs is whether the answer is the product or a stand-in for it.
  */
  const mode = body.mode === "proof" ? "proof" : "meter";
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
    /*
      The gateway meters `/meter/*` and prices by path, and authenticates the
      caller as the Service operator before anything reaches the chain.

      That signature is not optional on a gateway anyone can reach. Every metered
      call records a delivery and spends the operator's gas, so an unauthenticated
      one is a bill anybody can run up. This route therefore signs the claim when
      it holds the key, and when it does not it sends the request unsigned and
      passes the gateway's refusal straight back, which says what is missing
      rather than hiding it.
    */
    const proof = mode === "proof" ? await newestSettlement(stop) : undefined;
    if (mode === "proof" && proof === undefined) {
      return json(
        {
          error:
            "No Settlement was available to prove. The Proof Service proves a transaction that happened, and this deployment could not name one.",
        },
        503,
      );
    }

    const base = endpoint.replace(/\/$/, "");
    const target =
      proof === undefined
        ? `${base}/meter/${encodeURIComponent(tool)}`
        : `${base}/proof/${proof.chainKey}/${proof.txHash}`;
    const path = new URL(target).pathname;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "Tab-Agent": agent,
    };

    if (proof !== undefined) {
      /*
        The Proof Service authenticates the **Agent**, not the operator: the
        charge lands on that Agent's Open Tab, so the Agent's own Creditcoin key
        has to have asked for it. It rebuilds this digest field for field and
        requires the recovered signer to equal the `Tab-Agent` header, inside a
        five-minute window checked in both directions.
      */
      const agentKey = process.env["AGENT_CREDITCOIN_PRIVATE_KEY"]?.trim();
      if (agentKey !== undefined && agentKey !== "" && !agentKey.startsWith("0xREPLACE")) {
        const issuedAt = Date.now();
        const digest = [
          "tab-proof-request",
          "POST",
          path,
          agent.toLowerCase(),
          encodeBytes32String(tool).toLowerCase(),
          "1",
          String(proof.chainKey),
          proof.txHash.toLowerCase(),
          String(issuedAt),
        ].join("\n");
        headers["Tab-Agent-Signature"] = await new Wallet(agentKey).signMessage(digest);
        headers["Tab-Agent-Issued-At"] = String(issuedAt);
      }
    }

    const operatorKey = proof !== undefined ? undefined : process.env["GATEWAY_PRIVATE_KEY"]?.trim();
    if (operatorKey !== undefined && operatorKey !== "" && !operatorKey.startsWith("0xREPLACE")) {
      const issuedAt = Date.now();
      // The digest the gateway rebuilds and recovers against, field for field.
      // `tool` is the 32-byte key the price list is keyed by, not the label.
      const digest = [
        "tab-metering-request",
        "POST",
        path,
        agent.toLowerCase(),
        encodeBytes32String(tool).toLowerCase(),
        "1",
        String(issuedAt),
      ].join("\n");
      headers["Tab-Operator-Signature"] = await new Wallet(operatorKey).signMessage(digest);
      headers["Tab-Operator-Issued-At"] = String(issuedAt);
    }

    const response = await fetch(target, {
      method: "POST",
      headers,
      // The Proof Service reads the path and the headers and no body at all.
      ...(proof === undefined ? { body: JSON.stringify({ tool }) } : {}),
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
