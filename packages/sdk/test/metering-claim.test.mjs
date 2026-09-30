/**
 * The metering claim the Agent signs: the same digest the gateway recovers,
 * bound to the Agent that pays, and produced only when a call is made.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet, encodeBytes32String, verifyMessage } from "ethers";

import { METERING_HEADER, agentSignedMetering, delegateSignedMetering, meteringDigest, toolKeyOf } from "../dist/http/index.js";
import { METERING_DELEGATES, METERING_DELEGATES_ABI, meteringDelegatesFor } from "../dist/index.js";
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

const DELEGATE_KEY = new Wallet(`0x${"77".repeat(32)}`);

test("a delegate signs the same digest, naming the Agent, and says which key it is", async () => {
  const provider = delegateSignedMetering(() => ({ agent: AGENT.toUpperCase().replace("0X", "0x"), signer: DELEGATE_KEY }), { now: () => NOW });
  const headers = await provider({ method: "POST", url: "http://svc.test/meter/quote.generate", tool: "quote.generate", agent: AGENT, serviceId: SERVICE_ID });
  assert.equal(headers[METERING_HEADER.delegate], DELEGATE_KEY.address.toLowerCase());
  assert.equal(headers[METERING_HEADER.delegateIssuedAt], String(NOW));
  // The digest names the Agent, not the delegate: the charge lands where it always would.
  const expected = meteringDigest({ method: "POST", path: "/meter/quote.generate", agent: AGENT, tool: toolKeyOf("quote.generate"), units: 1, issuedAt: NOW });
  assert.equal(verifyMessage(expected, headers[METERING_HEADER.delegateSignature]), DELEGATE_KEY.address);
  assert.equal(headers[METERING_HEADER.agentSignature], undefined, "no Agent signature is claimed");
});

test("a delegate signs nothing for another Agent, and nothing when there is no key", async () => {
  const request = { method: "POST", url: "http://svc.test/meter/q", tool: "q", agent: AGENT, serviceId: SERVICE_ID };
  const forSomeoneElse = delegateSignedMetering(() => ({ agent: `0x${"12".repeat(20)}`, signer: DELEGATE_KEY }));
  assert.deepEqual(await forSomeoneElse(request), {});
  assert.deepEqual(await delegateSignedMetering(() => undefined)(request), {});
});

test("the delegate headers are distinct from the Agent's and the operator's", () => {
  const names = Object.values(METERING_HEADER).map((name) => name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  assert.equal(METERING_HEADER.delegate, "Tab-Delegate");
  assert.equal(METERING_HEADER.delegateSignature, "Tab-Delegate-Signature");
  assert.equal(METERING_HEADER.delegateIssuedAt, "Tab-Delegate-Issued-At");
});

test("the SDK carries the MeteringDelegates fragments and each network's address, undefined until deployed", () => {
  assert.ok(METERING_DELEGATES_ABI.some((fragment) => fragment.startsWith("function isDelegate(")));
  for (const chainId of [143, 10143]) assert.equal(meteringDelegatesFor(chainId), METERING_DELEGATES[chainId]);
});
