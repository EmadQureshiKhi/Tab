/**
 * The metering claim the Agent signs: the same digest the gateway recovers,
 * bound to the Agent that pays, and produced only when a call is made.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet, encodeBytes32String, verifyMessage } from "ethers";

import { METERING_HEADER, agentSignedMetering, meteringDigest, toolKeyOf } from "../dist/http/index.js";
import { createTabToolset } from "../dist/mcp/index.js";

const AGENT_KEY = new Wallet(`0x${"55".repeat(32)}`);
const AGENT = AGENT_KEY.address.toLowerCase();
const SERVICE_ID = "0x7461622e64656d6f2d7365727669636500000000000000000000000000000000";
const NOW = 1_788_700_000_000;
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test("the digest is the ordered, newline-joined claim, and the tool is its 32-byte key", () => {
  const digest = meteringDigest({ method: "post", path: "/meter/quote.generate", agent: AGENT.toUpperCase(), tool: toolKeyOf("quote.generate"), units: 1, issuedAt: NOW });
  assert.equal(
    digest,
    ["tab-metering-request", "POST", "/meter/quote.generate", AGENT, encodeBytes32String("quote.generate").toLowerCase(), "1", String(NOW)].join("\n"),
  );
  assert.equal(toolKeyOf(`0x${"AB".repeat(32)}`), `0x${"ab".repeat(32)}`, "a key already packed is kept, lower-cased");
});

test("the provider signs the claim as the Agent, over the request's path and tool", async () => {
  const provider = agentSignedMetering(() => AGENT_KEY, { now: () => NOW });
  const headers = await provider({ method: "POST", url: "http://svc.test/meter/quote.generate?x=1", tool: "quote.generate", agent: AGENT, serviceId: SERVICE_ID });
  assert.equal(headers[METERING_HEADER.agentIssuedAt], String(NOW));
  const expected = meteringDigest({ method: "POST", path: "/meter/quote.generate", agent: AGENT, tool: toolKeyOf("quote.generate"), units: 1, issuedAt: NOW });
  assert.equal(verifyMessage(expected, headers[METERING_HEADER.agentSignature]).toLowerCase(), AGENT);
});

test("a factory that returns nothing, or a key that is not the Agent, signs nothing and leaves the Service to decide", async () => {
  const request = { method: "POST", url: "http://svc.test/meter/q", tool: "q", agent: AGENT, serviceId: SERVICE_ID };
  const unsigned = agentSignedMetering(() => undefined);
  assert.deepEqual(await unsigned(request), {});

  // The Agent can come from somewhere other than this config, such as the
  // wallet the Agent Wallet plugin reads. A signature by anyone else could
  // only be rejected, so none is sent and the Service answers as it would to
  // any unsigned call.
  const someoneElse = agentSignedMetering(() => new Wallet(`0x${"66".repeat(32)}`));
  assert.deepEqual(await someoneElse(request), {});
});

test("tab_call carries the Agent's signature when the Service entry names the provider, and reads stay keyless", async () => {
  let built = 0;
  const seen = [];
  const toolset = createTabToolset({
    settings: {
      chainId: 10143,
      rpcUrl: undefined,
      explorerUrl: "https://testnet.monadvision.com",
      registryUrl: "http://registry.test",
      agent: AGENT,
      sources: {},
      services: [
        {
          serviceId: SERVICE_ID,
          endpoint: "http://service.test",
          headers: agentSignedMetering(() => {
            built += 1;
            return AGENT_KEY;
          }, { now: () => NOW }),
        },
      ],
      strategyId: undefined,
    },
    registryFetch: async () => new Response(JSON.stringify({ index: { lastBlock: 1 }, services: [], agents: [], settlements: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), headers: init.headers });
      return {
        status: 200,
        headers: {
          get: (name) =>
            ({
              "tab-charge-amount": "10000",
              "tab-charge-asset": "10143:0x480209747417f5c830fda188a9b9acfa70bc4083",
              "tab-charge-service": SERVICE_ID,
              "tab-charge-tool": toolKeyOf("quote.generate"),
              "tab-open-tab": "10000",
              "tab-headroom": "4990000",
            })[name.toLowerCase()] ?? null,
        },
        json: async () => ({ ok: true }),
      };
    },
    env: { MOCK_USDC_ADDRESS: "0x480209747417f5c830fda188a9b9acfa70bc4083" },
    logger: silent,
  });

  await toolset.discover({});
  assert.equal(built, 0, "discovery built no key");

  const output = await toolset.call({ serviceId: SERVICE_ID, tool: "quote.generate" });
  assert.equal(output.ok, true, JSON.stringify(output));
  assert.equal(built, 1, "the key was built for the call");
  assert.equal(seen[0].url, "http://service.test/meter/quote.generate");
  const digest = meteringDigest({ method: "POST", path: "/meter/quote.generate", agent: AGENT, tool: toolKeyOf("quote.generate"), units: 1, issuedAt: NOW });
  assert.equal(verifyMessage(digest, seen[0].headers[METERING_HEADER.agentSignature]).toLowerCase(), AGENT);
});
