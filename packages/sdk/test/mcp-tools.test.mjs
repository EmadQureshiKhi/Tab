/**
 * Task 16.3, first half: every tool input and output validates against the
 * schema the tool declares.
 *
 * The schemas are not checked against a copy written for the test. They are
 * checked against the exact objects `tools/list` serves, imported from the same
 * module the server imports, so a schema that drifts from the payload fails here
 * rather than in a model's context window.
 *
 * The last test is the round trip through a real MCP client and a real MCP
 * server over the SDK's in-memory transport. That is the one assertion the
 * direct calls cannot make: that the declarations survive the protocol, that a
 * failing tool comes back as a result rather than as a thrown protocol error,
 * and that `structuredContent` is what a model would actually receive.
 *
 * Nothing here touches a chain, a key, or a network. Every read is answered by a
 * stub built from the registry read API's own row shapes.
 *
 * Requirements: 21.5, 25.1, 25.2, 25.3, 25.4
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  TAB_TOOLS,
  createTabMcpServer,
  createTabToolset,
  tabToolByName,
  validateJsonValue,
} from "../dist/mcp/index.js";

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const SERVICE_ID = "0x7461622e70726f6f662d73657276696365000000000000000000000000000000";
const TOOL_KEY = "0x70726f6f662e67656e6572617465000000000000000000000000000000000000";
const AGENT = "0x1f6f797edc2eecb02bd54009b805fb2e99f80542";
const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const COLLECTION = "0x952acc70e6f54ce87dca963193a5957bcb27729e";
const REPLAY_KEY = `0x${"ab".repeat(32)}`;

/** Every environment the tests read. Never the ambient one, so a machine cannot change a result. */
const ENV = { SEPOLIA_USDC_ADDRESS: SEPOLIA_USDC, MAINNET_USDC_ADDRESS: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" };

const settings = (overrides = {}) => ({
  agent: AGENT,
  registryUrl: "http://registry.test",
  rpcUrl: undefined,
  explorerUrl: "https://creditcoin-testnet.blockscout.com",
  services: [],
  strategyId: undefined,
  sources: {},
  ...overrides,
});

const provenance = { blockNumber: 5441000, blockHash: `0x${"11".repeat(32)}`, logIndex: 0, txHash: `0x${"22".repeat(32)}`, txIndex: 0, blockTime: null };

/**
 * The registry read API's own response shapes, field for field.
 *
 * Written out rather than abbreviated: the mapping in `toolset.ts` reads these
 * exact names, and a fixture that simplified them would pass while the real
 * service produced nulls.
 */
const SERVICES_BODY = {
  index: { stream: "tab", lastBlock: 5441800 },
  services: [
    {
      serviceId: SERVICE_ID,
      operator: "0x00000000000000000000000000000000000000a1",
      tier: { value: 0, name: "Permissionless", creditWeight: 1, source: { appliedBy: "registration", creditcoin: provenance } },
      settlementWindowSeconds: { value: 21600, source: { appliedBy: "registration", creditcoin: provenance } },
      acceptedAssets: [{ asset: SEPOLIA_USDC, chainKey: "1", tabCollection: COLLECTION, bondCollection: "0x00000000000000000000000000000000000000b2" }],
      collections: [],
      prices: [{ serviceId: SERVICE_ID, asset: SEPOLIA_USDC, tool: TOOL_KEY, baseUnits: "10000", creditcoin: provenance }],
      bond: [
        {
          serviceId: SERVICE_ID,
          party: "0x00000000000000000000000000000000000000a1",
          asset: SEPOLIA_USDC,
          staked: "1000000",
          reserved: "0",
          slashed: "0",
          released: "0",
          free: "1000000",
          depositCount: 1,
          lastBlock: 5441000,
          basis: "replayed",
          computedAt: { blockNumber: 5441800 },
          crossCheck: null,
          unavailable: null,
        },
      ],
      pendingChanges: [],
      registeredAt: provenance,
    },
  ],
  nextCursor: null,
};

const AGENT_BODY = {
  index: { stream: "tab", lastBlock: 5441800 },
  agent: AGENT,
  assets: [
    {
      asset: SEPOLIA_USDC,
      creditLimit: { value: "4750000", basis: "LimitLib", computedAt: { blockNumber: 5441800 }, witness: null, crossCheck: null, unavailable: null },
      headroom: { value: "4740000", basis: "limit less open", openTab: "10000", crossCheck: null, unavailable: null },
      openTab: {
        observed: "10000",
        basis: "sum of the last observed Open Tab per tab",
        liveRead: "TabBook.assetOpen(agent, asset)",
        tabs: [{ tabId: `0x${"33".repeat(32)}`, agent: AGENT, serviceId: SERVICE_ID, asset: SEPOLIA_USDC, openAfter: "10000", creditcoin: provenance }],
      },
      delinquency: { delinquent: false, openCount: 0, basis: "TabDelinquent", tabs: [] },
      settlements: {
        agent: AGENT,
        asset: SEPOLIA_USDC,
        settlementCount: 4,
        settledTotal: "40000",
        appliedTotal: "30000",
        prepaidTotal: "10000",
        firstBlock: 5400000,
        lastBlock: 5441000,
        lastBlockTime: null,
      },
    },
  ],
  boundAddresses: [{ agent: AGENT, chainKey: "1", ethAddress: "0xa302940db97345c5adaf8da23ff46ae63613d728", provingReplayKey: REPLAY_KEY, creditcoin: provenance }],
  declinedObservations: { note: "a decline is not a failed Settlement", observations: [] },
};

const SETTLEMENTS_BODY = {
  index: { stream: "tab", lastBlock: 5441800 },
  settlements: [
    {
      replayKey: REPLAY_KEY,
      chainKey: "1",
      sourceBlockHeight: "9123456",
      sourceTxIndex: "3",
      sourceLogIndex: "0",
      agent: AGENT,
      serviceId: SERVICE_ID,
      asset: SEPOLIA_USDC,
      amount: "10000",
      payerAddress: "0xa302940db97345c5adaf8da23ff46ae63613d728",
      sourceTabId: `0x${"00".repeat(32)}`,
      creditcoin: provenance,
      application: { applied: "10000", toPrepaid: "0", openAfter: "0" },
    },
  ],
  nextCursor: null,
};

const SETTLEMENT_BODY = {
  index: { stream: "tab", lastBlock: 5441800 },
  settlement: SETTLEMENTS_BODY.settlements[0],
  clearing: {
    state: "confirmed",
    lineage: [
      { state: "provisional", amount: "10000", sourceTxHash: `0x${"44".repeat(32)}`, deadline: "1757000000", observedDigest: null, attestedDigest: null, creditcoin: provenance },
      { state: "confirmed", amount: "10000", sourceTxHash: `0x${"44".repeat(32)}`, deadline: null, observedDigest: null, attestedDigest: null, creditcoin: provenance },
    ],
  },
};

/** A `fetch` that answers the registry read API and records what was asked. */
function stubRegistryFetch(overrides = {}) {
  const calls = [];
  const send = async (url) => {
    calls.push(url);
    const path = url.replace("http://registry.test", "");
    if (path.startsWith("/healthz")) return json(200, { status: "ok" });
    const services = overrides.services ?? SERVICES_BODY;
    if (path.startsWith("/services/")) return json(200, { index: services.index, service: services.services[0] });
    if (path.startsWith("/services")) return json(200, services);
    if (path.startsWith("/agents/")) return json(200, overrides.agent ?? AGENT_BODY);
    if (path.startsWith("/settlements/")) return json(200, overrides.settlement ?? SETTLEMENT_BODY);
    if (path.startsWith("/settlements")) return json(200, overrides.settlements ?? SETTLEMENTS_BODY);
    return json(404, { error: { category: "NOT_FOUND", code: "ROUTE_UNKNOWN", message: `no route for ${path}` } });
  };
  send.calls = calls;
  return send;
}

const json = (status, body) => ({ status, headers: {}, json: async () => body });

/** Asserts a payload against the schema its tool published, with a readable failure. */
function assertMatchesOutputSchema(toolName, payload) {
  const declaration = tabToolByName(toolName);
  assert.ok(declaration !== undefined, `${toolName} is declared`);
  const outcome = validateJsonValue(declaration.outputSchema, payload, `${toolName} output`);
  assert.ok(outcome.ok, `${toolName} output does not match its declared schema: ${outcome.ok ? "" : outcome.error.message}`);
}

// ---------------------------------------------------------------- declarations

test("every declared tool carries an input and an output schema this validator understands", () => {
  assert.equal(TAB_TOOLS.length, 4);
  assert.deepEqual(
    TAB_TOOLS.map((tool) => tool.name),
    ["tab_discover", "tab_call", "tab_status", "tab_settle"],
  );
  for (const tool of TAB_TOOLS) {
    // An empty object is not valid input for every tool, but validating it proves
    // the schema itself uses no keyword the validator silently ignores: an
    // unsupported keyword fails with SCHEMA_KEYWORD_UNSUPPORTED rather than a
    // field problem.
    for (const schema of [tool.inputSchema, tool.outputSchema]) {
      const outcome = validateJsonValue(schema, {}, `${tool.name} schema`);
      if (!outcome.ok) {
        assert.notEqual(
          outcome.error.code,
          "SCHEMA_KEYWORD_UNSUPPORTED",
          `${tool.name} declares a keyword nothing enforces: ${outcome.error.message}`,
        );
      }
    }
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.outputSchema.type, "object");
  }
});

test("tab_settle is the only tool not marked read-only, and it is marked destructive", () => {
  for (const tool of TAB_TOOLS) {
    const expectedReadOnly = tool.name !== "tab_call" && tool.name !== "tab_settle";
    assert.equal(tool.annotations.readOnlyHint, expectedReadOnly, `${tool.name} readOnlyHint`);
  }
  assert.equal(tabToolByName("tab_settle").annotations.destructiveHint, true);
});

// ---------------------------------------------------------------- tab_discover

test("tab_discover maps the registry read API onto its declared output schema", async () => {
  const toolset = createTabToolset({
    settings: settings(),
    registryFetch: stubRegistryFetch(),
    env: ENV,
    logger: silent,
  });

  const output = await toolset.discover({});
  assertMatchesOutputSchema("tab_discover", output);

  assert.equal(output.error, undefined);
  assert.equal(output.services.length, 1);
  const service = output.services[0];
  assert.equal(service.serviceId, SERVICE_ID);
  assert.equal(service.name, "tab.proof-service", "the serviceId decodes to its ascii name");
  assert.equal(service.endpoint, null, "the chain records no endpoint and none was configured");
  assert.equal(service.tier, "permissionless");
  assert.equal(service.settlementWindowSeconds, 21600);
  assert.deepEqual(service.tools, [
    { tool: TOOL_KEY, toolName: "proof.generate", asset: `1:${SEPOLIA_USDC}`, priceBaseUnits: "10000" },
  ]);
  assert.deepEqual(service.bonds, [
    { asset: `1:${SEPOLIA_USDC}`, stakedBaseUnits: "1000000", freeBaseUnits: "1000000" },
  ]);
  assert.equal(service.assets[0].collectionAddress, COLLECTION);
});

test("tab_discover reports a configured endpoint and name over the decoded ones", async () => {
  const toolset = createTabToolset({
    settings: settings({ services: [{ serviceId: SERVICE_ID, name: "Proof Service", endpoint: "http://service.test" }] }),
    registryFetch: stubRegistryFetch(),
    env: ENV,
    logger: silent,
  });
  const output = await toolset.discover({});
  assertMatchesOutputSchema("tab_discover", output);
  assert.equal(output.services[0].endpoint, "http://service.test");
  assert.equal(output.services[0].name, "Proof Service");
});

test("tab_discover refuses an out-of-range limit with the bound the schema published", async () => {
  const toolset = createTabToolset({ settings: settings(), registryFetch: stubRegistryFetch(), env: ENV, logger: silent });
  const output = await toolset.discover({ limit: 500 });
  assertMatchesOutputSchema("tab_discover", output);
  assert.deepEqual(output.services, []);
  assert.equal(output.error.code, "INPUT_INVALID");
  assert.match(output.error.message, /at most 100/);
});

test("tab_discover filters on tier and on Asset, and applies the declared default limit", async () => {
  const stub = stubRegistryFetch();
  const toolset = createTabToolset({ settings: settings(), registryFetch: stub, env: ENV, logger: silent });

  const curated = await toolset.discover({ tier: "curated" });
  assertMatchesOutputSchema("tab_discover", curated);
  assert.deepEqual(curated.services, [], "the fixture Service is permissionless");

  const wrongAsset = await toolset.discover({ asset: "3:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" });
  assertMatchesOutputSchema("tab_discover", wrongAsset);
  assert.deepEqual(wrongAsset.services, []);

  const rightAsset = await toolset.discover({ asset: `1:${SEPOLIA_USDC}` });
  assert.equal(rightAsset.services.length, 1);

  // An unfiltered call asks for exactly the declared default of 25.
  await toolset.discover({});
  assert.ok(stub.calls.some((url) => url.includes("/services?limit=25")), stub.calls.join(" "));
});

test("tab_discover reports an unreachable registry as UPSTREAM rather than as an empty directory", async () => {
  const toolset = createTabToolset({
    settings: settings(),
    registryFetch: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    logger: silent,
  });
  const output = await toolset.discover({});
  assertMatchesOutputSchema("tab_discover", output);
  assert.equal(output.error.category, "UPSTREAM");
  assert.equal(output.error.code, "REGISTRY_UNREACHABLE");
  assert.equal(output.error.retryable, true);
});

test("tab_discover says so when no registry read API is configured", async () => {
  const toolset = createTabToolset({ settings: settings({ registryUrl: undefined }), env: ENV, logger: silent });
  const output = await toolset.discover({});
  assertMatchesOutputSchema("tab_discover", output);
  assert.equal(output.error.code, "REGISTRY_UNCONFIGURED");
});

// ---------------------------------------------------------------- tab_status

test("tab_status maps the Agent read onto its declared output schema", async () => {
  const toolset = createTabToolset({ settings: settings(), registryFetch: stubRegistryFetch(), env: ENV, logger: silent });
  const output = await toolset.status({});
  assertMatchesOutputSchema("tab_status", output);

  assert.equal(output.agent, AGENT);
  assert.equal(output.perAsset.length, 1);
  assert.deepEqual(output.perAsset[0].creditLimitBaseUnits, "4750000");
  assert.deepEqual(output.perAsset[0].openTabBaseUnits, "10000");
  assert.deepEqual(output.perAsset[0].headroomBaseUnits, "4740000");
  assert.equal(output.perAsset[0].delinquent, false);
  assert.deepEqual(output.boundAddresses, [{ chainKey: 1, address: "0xa302940db97345c5adaf8da23ff46ae63613d728" }]);
  assert.equal(output.verifiedSettlements.length, 1);
  assert.equal(
    output.verifiedSettlements[0].explorerUrl,
    `https://creditcoin-testnet.blockscout.com/tx/${provenance.txHash}`,
  );
  assert.deepEqual(output.provisionalClearings, [
    {
      clearingId: REPLAY_KEY,
      asset: `1:${SEPOLIA_USDC}`,
      amountBaseUnits: "10000",
      state: "confirmed",
      deadlineIso: null,
      sourceTxHash: `0x${"44".repeat(32)}`,
    },
  ]);
});

test("tab_status reports a withheld Credit Limit as null and never as zero", async () => {
  const withheld = structuredClone(AGENT_BODY);
  withheld.assets[0].creditLimit = { value: null, basis: "", computedAt: null, witness: null, crossCheck: null, unavailable: { code: "CHAIN_READER_UNCONFIGURED", message: "withheld" } };
  withheld.assets[0].headroom = { value: null, basis: "", openTab: null, crossCheck: null, unavailable: { code: "CHAIN_READER_UNCONFIGURED", message: "withheld" } };

  const toolset = createTabToolset({
    settings: settings(),
    registryFetch: stubRegistryFetch({ agent: withheld }),
    env: ENV,
    logger: silent,
  });
  const output = await toolset.status({});
  assertMatchesOutputSchema("tab_status", output);
  assert.equal(output.perAsset[0].creditLimitBaseUnits, null);
  assert.equal(output.perAsset[0].headroomBaseUnits, null);
  assert.equal(output.perAsset[0].openTabBaseUnits, "10000", "the observed Open Tab still stands");
});

test("tab_status with historyLimit zero reads no settlement feed at all", async () => {
  const stub = stubRegistryFetch();
  const toolset = createTabToolset({ settings: settings(), registryFetch: stub, env: ENV, logger: silent });
  const output = await toolset.status({ historyLimit: 0 });
  assertMatchesOutputSchema("tab_status", output);
  assert.deepEqual(output.verifiedSettlements, []);
  assert.ok(!stub.calls.some((url) => url.includes("/settlements")), stub.calls.join(" "));
});

test("tab_status refuses a malformed agent and still returns a schema-valid payload", async () => {
  const toolset = createTabToolset({ settings: settings(), registryFetch: stubRegistryFetch(), env: ENV, logger: silent });
  const output = await toolset.status({ agent: "not-an-address" });
  assertMatchesOutputSchema("tab_status", output);
  assert.equal(output.error.code, "INPUT_INVALID");
  assert.deepEqual(output.perAsset, []);
});

test("tab_status says so when no Agent is configured and none was passed", async () => {
  const toolset = createTabToolset({ settings: settings({ agent: undefined }), registryFetch: stubRegistryFetch(), env: ENV, logger: silent });
  const output = await toolset.status({});
  assertMatchesOutputSchema("tab_status", output);
  assert.equal(output.error.code, "AGENT_UNCONFIGURED");
});

// ---------------------------------------------------------------- tab_call

/** A Service that answers with the charge headers a metered Service reports. */
function serviceFetch({ status = 200, amount = "10000", openTab = "10000", headroom = "4740000", body = { proof: "0xdeadbeef" } } = {}) {
  return async () => ({
    status,
    headers: {
      "tab-charge-amount": amount,
      "tab-charge-asset": `1:${SEPOLIA_USDC}`,
      "tab-charge-service": SERVICE_ID,
      "tab-charge-tool": TOOL_KEY,
      "tab-open-tab": openTab,
      "tab-headroom": headroom,
    },
    json: async () => body,
  });
}

test("tab_call meters a served call and reports the charge and the tab", async () => {
  const toolset = createTabToolset({
    settings: settings({ services: [{ serviceId: SERVICE_ID, endpoint: "http://service.test" }] }),
    fetchImpl: serviceFetch(),
    env: ENV,
    logger: silent,
  });
  const output = await toolset.call({ serviceId: SERVICE_ID, tool: "proof.generate", arguments: { input: "0x01" } });
  assertMatchesOutputSchema("tab_call", output);

  assert.equal(output.ok, true);
  assert.deepEqual(output.result, { proof: "0xdeadbeef" });
  assert.deepEqual(output.charge, { amountBaseUnits: "10000", asset: `1:${SEPOLIA_USDC}`, tool: TOOL_KEY });
  assert.equal(output.tab.openTabBaseUnits, "10000");
  assert.equal(output.tab.headroomBaseUnits, "4740000");
});

test("tab_call answers a 402 with LIMIT_EXCEEDED and both figures, and never throws", async () => {
  const toolset = createTabToolset({
    settings: settings({ services: [{ serviceId: SERVICE_ID, endpoint: "http://service.test" }] }),
    fetchImpl: serviceFetch({ status: 402, amount: "50000", openTab: "4750000", headroom: "0" }),
    env: ENV,
    logger: silent,
  });
  const output = await toolset.call({ serviceId: SERVICE_ID, tool: "proof.generate" });
  assertMatchesOutputSchema("tab_call", output);

  assert.equal(output.ok, false);
  assert.equal(output.error.category, "LIMIT");
  assert.equal(output.error.code, "LIMIT_EXCEEDED");
  assert.equal(output.error.requiredBaseUnits, "50000", "the model is told what the call needs");
  assert.equal(output.error.headroomBaseUnits, "0", "and what it has, so it can decide to settle");
  assert.equal(output.result, undefined);
});

test("tab_call passes a Tab-speaking Service's own refusal through, and maps a plain status otherwise", async () => {
  const withBody = createTabToolset({
    settings: settings({ services: [{ serviceId: SERVICE_ID, endpoint: "http://service.test" }] }),
    fetchImpl: async () => ({
      status: 403,
      headers: {},
      json: async () => ({
        ok: false,
        error: {
          category: "AUTHORISATION",
          code: "METERING_SIGNATURE_ABSENT",
          message: "a metered request must carry Tab-Operator-Signature, Tab-Operator-Issued-At, and Tab-Agent",
          retryable: false,
        },
      }),
    }),
    env: ENV,
    logger: silent,
  });
  const passed = await withBody.call({ serviceId: SERVICE_ID, tool: "proof.generate" });
  assertMatchesOutputSchema("tab_call", passed);
  assert.equal(passed.ok, false);
  assert.equal(passed.error.category, "AUTHORISATION");
  assert.equal(passed.error.code, "METERING_SIGNATURE_ABSENT", "a model can act on the Service's own code");

  const plain = createTabToolset({
    settings: settings({ services: [{ serviceId: SERVICE_ID, endpoint: "http://service.test" }] }),
    fetchImpl: async () => ({ status: 503, headers: {}, json: async () => "service unavailable" }),
    env: ENV,
    logger: silent,
  });
  const mapped = await plain.call({ serviceId: SERVICE_ID, tool: "proof.generate" });
  assertMatchesOutputSchema("tab_call", mapped);
  assert.equal(mapped.error.category, "UNAVAILABLE");
  assert.equal(mapped.error.code, "SERVICE_REFUSED");
  assert.equal(mapped.error.retryable, true);
});

test("tab_call refuses a Service with no configured endpoint by name", async () => {
  const toolset = createTabToolset({ settings: settings(), env: ENV, logger: silent });
  const output = await toolset.call({ serviceId: SERVICE_ID, tool: "proof.generate" });
  assertMatchesOutputSchema("tab_call", output);
  assert.equal(output.ok, false);
  assert.equal(output.error.code, "SERVICE_ENDPOINT_UNKNOWN");
  assert.equal(output.error.category, "NOT_FOUND");
});

test("tab_call sends the headers a Service's provider builds for that one call", async (t) => {
  const seen = [];
  const toolset = createTabToolset({
    settings: settings({
      services: [
        {
          serviceId: SERVICE_ID,
          endpoint: "http://service.test",
          // The reference metering gateway wants a claim over the method, the
          // path, the Agent and the tool, which no static header can carry. This
          // is the seam a Service's own access control goes through.
          headers: (request) => {
            seen.push(request);
            return { "x-tab-metering-signature": `signed:${request.tool}:${request.agent}` };
          },
        },
      ],
    }),
    fetchImpl: async (url, init) => {
      seen.push(init.headers);
      return (await serviceFetch()(url, init));
    },
    env: ENV,
    logger: silent,
  });

  const output = await toolset.call({ serviceId: SERVICE_ID, tool: "proof.generate" });
  assertMatchesOutputSchema("tab_call", output);
  assert.equal(output.ok, true);
  assert.equal(seen[0].tool, "proof.generate");
  assert.equal(seen[0].agent, AGENT);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[1]["x-tab-metering-signature"], `signed:proof.generate:${AGENT}`);
});

test("a header provider that throws becomes a failed call, not a dropped transport", async () => {
  const toolset = createTabToolset({
    settings: settings({
      services: [
        {
          serviceId: SERVICE_ID,
          endpoint: "http://service.test",
          headers: () => {
            throw new Error("the capability service is down");
          },
        },
      ],
    }),
    fetchImpl: serviceFetch(),
    env: ENV,
    logger: silent,
  });
  const output = await toolset.call({ serviceId: SERVICE_ID, tool: "proof.generate" });
  assertMatchesOutputSchema("tab_call", output);
  assert.equal(output.ok, false);
  assert.equal(output.error.code, "SERVICE_HEADERS_FAILED");
  assert.match(output.error.message, /header provider/);
});

test("tab_call refuses a tool name too long to be a 32-byte key", async () => {
  const toolset = createTabToolset({
    settings: settings({ services: [{ serviceId: SERVICE_ID, endpoint: "http://service.test" }] }),
    fetchImpl: serviceFetch(),
    env: ENV,
    logger: silent,
  });
  const output = await toolset.call({ serviceId: SERVICE_ID, tool: "x".repeat(64) });
  assertMatchesOutputSchema("tab_call", output);
  assert.equal(output.error.code, "TOOL_NAME_TOO_LONG");
});

test("tab_call refuses an undeclared argument rather than passing it through", async () => {
  const toolset = createTabToolset({
    settings: settings({ services: [{ serviceId: SERVICE_ID, endpoint: "http://service.test" }] }),
    fetchImpl: serviceFetch(),
    env: ENV,
    logger: silent,
  });
  const output = await toolset.call({ serviceId: SERVICE_ID, tool: "proof.generate", agent: AGENT });
  assertMatchesOutputSchema("tab_call", output);
  assert.equal(output.error.code, "INPUT_INVALID");
  assert.match(output.error.message, /not a declared property/);
});

// ---------------------------------------------------------------- tab_settle

/** A strategy registry holding one strategy that records what it was asked to settle. */
function stubStrategies() {
  const settled = [];
  const strategy = {
    id: "stub-usdc",
    chainKeys: [1n],
    supports: (asset) => asset.chainKey === 1n,
    quote: async (request) => ({ ok: true, value: { amount: request.amount, asset: request.asset, feeNote: "gas is not included" } }),
    settle: async (request) => {
      settled.push(request);
      return {
        ok: true,
        value: {
          strategyId: "stub-usdc",
          chainKey: request.asset.chainKey,
          sourceTxHash: `0x${"ee".repeat(32)}`,
          asset: request.asset,
          amount: request.amount,
          payerAddress: "0xa302940db97345c5adaf8da23ff46ae63613d728",
          submittedAt: 1_757_000_000_000,
          mode: request.mode,
          collectionAddress: request.collectionAddress,
          tabId: request.tabId,
          emitter: request.collectionAddress,
        },
      };
    },
    watchHint: () => {
      throw new Error("not used here");
    },
  };
  return {
    settled,
    registry: {
      register: () => ({ ok: true, value: { strategy, action: "registered" } }),
      unregister: () => false,
      list: () => [strategy],
      clear: () => {},
      resolve: (query) => {
        if (query.id !== undefined && query.id !== strategy.id) {
          return { ok: false, error: { category: "NOT_FOUND", code: "STRATEGY_NOT_FOUND", message: `no strategy \`${query.id}\``, retryable: false } };
        }
        if (query.asset !== undefined && !strategy.supports(query.asset)) {
          return { ok: false, error: { category: "NOT_FOUND", code: "STRATEGY_NOT_FOUND", message: "no strategy for that Asset", retryable: false } };
        }
        return { ok: true, value: strategy };
      },
    },
  };
}

test("tab_settle on a dry run builds the Settlement, resolves the Collection Address, and broadcasts nothing", async () => {
  const strategies = stubStrategies();
  const toolset = createTabToolset({
    settings: settings(),
    registryFetch: stubRegistryFetch(),
    strategies: strategies.registry,
    env: ENV,
    logger: silent,
  });

  const output = await toolset.settle({
    serviceId: SERVICE_ID,
    asset: `1:${SEPOLIA_USDC}`,
    amountBaseUnits: "10000",
    dryRun: true,
  });
  assertMatchesOutputSchema("tab_settle", output);

  assert.equal(output.ok, true);
  assert.equal(output.dryRun, true);
  assert.equal(output.sourceTxHash, null);
  assert.equal(output.collectionAddress, COLLECTION, "read from the Service's registered Tab Collection");
  assert.equal(output.chainKey, 1);
  assert.equal(output.provisionalClearingExpected, true, "1,000,000 of free Bond covers 10,000");
  assert.deepEqual(strategies.settled, [], "a dry run submits nothing");
});

test("tab_settle broadcasts through the strategy seam and reports the submission locator", async () => {
  const strategies = stubStrategies();
  const toolset = createTabToolset({
    settings: settings(),
    registryFetch: stubRegistryFetch(),
    strategies: strategies.registry,
    env: ENV,
    logger: silent,
  });

  const output = await toolset.settle({ serviceId: SERVICE_ID, asset: `1:${SEPOLIA_USDC}`, amountBaseUnits: "10000" });
  assertMatchesOutputSchema("tab_settle", output);

  assert.equal(output.ok, true);
  assert.equal(output.dryRun, false);
  assert.equal(output.sourceTxHash, `0x${"ee".repeat(32)}`);
  assert.equal(strategies.settled.length, 1);
  assert.equal(strategies.settled[0].amount, 10_000n, "an amount crosses the seam as a bigint, never a number");
  assert.equal(strategies.settled[0].mode, "settlement-contract", "auto takes the surface chainKey 1 declares");
  assert.equal(strategies.settled[0].collectionAddress, COLLECTION);
});

test("tab_settle predicts no Provisional Clearing when free Bond does not cover the amount", async () => {
  const thin = structuredClone(SERVICES_BODY);
  thin.services[0].bond[0].free = "500";
  const strategies = stubStrategies();
  const toolset = createTabToolset({
    settings: settings(),
    registryFetch: stubRegistryFetch({ services: thin }),
    strategies: strategies.registry,
    env: ENV,
    logger: silent,
  });
  const output = await toolset.settle({
    serviceId: SERVICE_ID,
    asset: `1:${SEPOLIA_USDC}`,
    amountBaseUnits: "10000",
    dryRun: true,
  });
  assertMatchesOutputSchema("tab_settle", output);
  assert.equal(output.ok, true);
  assert.equal(output.provisionalClearingExpected, false, "500 of free Bond does not cover 10,000");
});

test("tab_settle refuses an Asset no registered strategy supports", async () => {
  const strategies = stubStrategies();
  const toolset = createTabToolset({
    settings: settings(),
    registryFetch: stubRegistryFetch({
      services: {
        ...SERVICES_BODY,
        services: [
          {
            ...SERVICES_BODY.services[0],
            acceptedAssets: [{ asset: ENV.MAINNET_USDC_ADDRESS, chainKey: "3", tabCollection: COLLECTION, bondCollection: null }],
          },
        ],
      },
    }),
    strategies: strategies.registry,
    env: ENV,
    logger: silent,
  });

  const output = await toolset.settle({
    serviceId: SERVICE_ID,
    asset: `3:${ENV.MAINNET_USDC_ADDRESS}`,
    amountBaseUnits: "10000",
  });
  assertMatchesOutputSchema("tab_settle", output);
  assert.equal(output.ok, false);
  assert.equal(output.error.code, "STRATEGY_NOT_FOUND");
  assert.deepEqual(strategies.settled, []);
});

test("tab_settle refuses an amount that is not a decimal string of base units", async () => {
  const toolset = createTabToolset({ settings: settings(), registryFetch: stubRegistryFetch(), env: ENV, logger: silent });
  for (const amount of ["1.5", "-1", "0x10", "1e6"]) {
    const output = await toolset.settle({ serviceId: SERVICE_ID, asset: `1:${SEPOLIA_USDC}`, amountBaseUnits: amount });
    assertMatchesOutputSchema("tab_settle", output);
    assert.equal(output.error.code, "INPUT_INVALID", `\`${amount}\` must be refused`);
  }
});

test("tab_settle refuses a chain key this network does not attest", async () => {
  const toolset = createTabToolset({ settings: settings(), registryFetch: stubRegistryFetch(), env: ENV, logger: silent });
  const output = await toolset.settle({ serviceId: SERVICE_ID, asset: `7:${SEPOLIA_USDC}`, amountBaseUnits: "10000" });
  assertMatchesOutputSchema("tab_settle", output);
  assert.equal(output.error.code, "ASSET_CHAIN_UNSUPPORTED");
});

// ---------------------------------------------------------------- the protocol

test("a real MCP client sees the four declarations and gets schema-valid structured results", async () => {
  const server = await createTabMcpServer({
    settings: settings({ services: [{ serviceId: SERVICE_ID, endpoint: "http://service.test" }] }),
    registryFetch: stubRegistryFetch(),
    env: ENV,
    logger: silent,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);

  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["tab_call", "tab_discover", "tab_settle", "tab_status"],
    );
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name} publishes an object input schema`);
      assert.ok(tool.outputSchema !== undefined, `${tool.name} publishes an output schema`);
      assert.ok(typeof tool.description === "string" && tool.description.length > 40);
    }

    const discovered = await client.callTool({ name: "tab_discover", arguments: {} });
    assert.notEqual(discovered.isError, true);
    assertMatchesOutputSchema("tab_discover", discovered.structuredContent);
    assert.equal(discovered.structuredContent.services.length, 1);
    assert.ok(discovered.content.length > 0, "a client with no structured-output support still sees the payload");

    const status = await client.callTool({ name: "tab_status", arguments: { historyLimit: 5 } });
    assertMatchesOutputSchema("tab_status", status.structuredContent);

    // A failing tool comes back as a result carrying the failure, not as a thrown
    // protocol error. This is the property the whole zero-throw discipline exists
    // for: a model can read a refusal and act on it.
    const refused = await client.callTool({ name: "tab_discover", arguments: { limit: 0 } });
    assert.equal(refused.isError, true);
    assertMatchesOutputSchema("tab_discover", refused.structuredContent);
    assert.equal(refused.structuredContent.error.code, "INPUT_INVALID");

    const unknown = await client.callTool({ name: "tab_teleport", arguments: {} });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /TOOL_UNKNOWN|not a tool/);
  } finally {
    await client.close();
    await server.server.close();
  }
});
