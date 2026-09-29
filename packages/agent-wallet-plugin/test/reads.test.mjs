import assert from "node:assert/strict";
import { test } from "node:test";

import { createHost } from "../dist/host-context.js";
import { parseCallArguments, runCall, runDiscover, runStatus } from "../dist/tab/reads.js";
import { AGENT, ENV, fakeContext, fakeIo, OTHER_ASSET, SERVICE_ID, SERVICES_BODY, SETTINGS, stubRegistryFetch, USDC } from "./fixtures.mjs";

// The project's hosted read API and demo Service are the SDK's last-resort defaults.
// Tests switch them off so that nothing here can reach a real host by accident.
const HERMETIC = { ...ENV, TAB_HOSTED_DEFAULTS: "off" };
// No tab.config sits at the filesystem root, so the SDK's config walk finds nothing and every read stays hermetic.
const cwd = "/";

test("discover lists the Services the registry serves, and filters by Asset on the configured chain", async () => {
  const registryFetch = stubRegistryFetch();
  const listed = await runDiscover({ settings: SETTINGS, env: HERMETIC, cwd, registryFetch }, {});
  assert.ok(listed.ok, listed.ok ? "" : listed.error.message);
  assert.equal(listed.value.services.length, 1);
  assert.equal(listed.value.services[0].serviceId, SERVICE_ID);
  assert.equal(listed.value.services[0].tools[0].priceBaseUnits, "10000");

  const byAsset = await runDiscover({ settings: SETTINGS, env: HERMETIC, cwd, registryFetch }, { asset: USDC });
  assert.ok(byAsset.ok);
  assert.equal(byAsset.value.services.length, 1);

  const none = await runDiscover({ settings: SETTINGS, env: HERMETIC, cwd, registryFetch }, { tier: "curated" });
  assert.ok(none.ok);
  assert.equal(none.value.services.length, 0);
});

test("discover names the Testnet test token from the settings, with nothing exported", async () => {
  // A deployment of one's own ships its own test token. With no MOCK_USDC_ADDRESS in the
  // environment, the settings are what tell the SDK where that token is.
  const ownToken = JSON.parse(JSON.stringify(SERVICES_BODY).replaceAll(USDC, OTHER_ASSET));
  const registryFetch = stubRegistryFetch({ services: ownToken });
  const named = await runDiscover({ settings: { ...SETTINGS, mockUsdc: OTHER_ASSET }, env: {}, cwd, registryFetch }, {});
  assert.ok(named.ok, named.ok ? "" : named.error.message);
  const asset = named.value.services[0].assets[0];
  assert.equal(asset.symbol, "mUSDC");
  assert.equal(asset.decimals, 6);

  const unnamed = await runDiscover({ settings: { ...SETTINGS, mockUsdc: undefined }, env: {}, cwd, registryFetch }, {});
  assert.ok(unnamed.ok);
  assert.equal(unnamed.value.services[0].assets[0].symbol, null);
});

test("discover needs no wallet and no registry when the limit is malformed", async () => {
  const registryFetch = stubRegistryFetch();
  const result = await runDiscover({ settings: SETTINGS, env: HERMETIC, cwd, registryFetch }, { limit: "ten" });
  assert.equal(result.error.code, "FLAG_NOT_INTEGER");
  assert.equal(registryFetch.calls.length, 0);
});

test("discover with no registry configured reports the variable rather than a connection error", async () => {
  const result = await runDiscover({ settings: { ...SETTINGS, registryUrl: undefined }, env: HERMETIC, cwd }, {});
  assert.equal(result.error.code, "REGISTRY_UNCONFIGURED");
});

test("with nothing configured, discover reads the project's hosted registry for the network", async () => {
  const registryFetch = stubRegistryFetch();
  const result = await runDiscover({ settings: { ...SETTINGS, registryUrl: undefined }, env: ENV, cwd, registryFetch }, {});
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.ok(registryFetch.calls.length > 0);
  assert.ok(registryFetch.calls.every((url) => url.startsWith("https://registry-testnet-production.up.railway.app/")));
});

test("status reads the wallet's address as the Agent and reports per Asset", async () => {
  const context = fakeContext();
  const host = createHost({ ctx: context.ctx, io: fakeIo({}), commandId: "tab:status" });
  const registryFetch = stubRegistryFetch();
  const result = await runStatus({ settings: SETTINGS, env: HERMETIC, cwd, registryFetch, host }, {});
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.equal(result.value.agent, AGENT);
  assert.equal(result.value.perAsset[0].asset, `10143:${USDC}`);
  assert.equal(result.value.perAsset[0].openTabBaseUnits, "10000");
  assert.equal(result.value.perAsset[0].headroomBaseUnits, "4740000");
  assert.equal(result.value.settlements.length, 1);
  assert.ok(registryFetch.calls.some((url) => url.includes(`/agents/${AGENT}`)));
});

test("status without a wallet is WALLET_MISSING before any read", async () => {
  const context = fakeContext({ wallets: [] });
  const host = createHost({ ctx: context.ctx, io: fakeIo({}), commandId: "tab:status" });
  const registryFetch = stubRegistryFetch();
  const result = await runStatus({ settings: SETTINGS, env: HERMETIC, cwd, registryFetch, host }, {});
  assert.equal(result.error.code, "WALLET_MISSING");
  assert.equal(registryFetch.calls.length, 0);
});

test("call arguments must be a JSON object literal", () => {
  assert.deepEqual(parseCallArguments(undefined), { ok: true, value: undefined });
  assert.deepEqual(parseCallArguments('{"prompt":"hi"}'), { ok: true, value: { prompt: "hi" } });
  assert.equal(parseCallArguments("[1]").error.code, "ARGS_NOT_OBJECT");
  assert.equal(parseCallArguments("{oops").error.code, "ARGS_NOT_JSON");
});

test("call with no endpoint for the Service says where an endpoint comes from", async () => {
  const context = fakeContext();
  const host = createHost({ ctx: context.ctx, io: fakeIo({}), commandId: "tab:call" });
  const result = await runCall({ settings: SETTINGS, env: HERMETIC, cwd, registryFetch: stubRegistryFetch(), host }, { service: SERVICE_ID, tool: "quote.generate" });
  assert.equal(result.error.code, "SERVICE_ENDPOINT_UNKNOWN");
  assert.match(result.error.message, /tab\.config/);
});

test("call posts the tool arguments to the configured endpoint and reports the charge", async () => {
  const context = fakeContext();
  const host = createHost({ ctx: context.ctx, io: fakeIo({}), commandId: "tab:call" });
  const posted = [];
  const fetchImpl = async (url, init) => {
    posted.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "application/json",
        "tab-charge-amount": "10000",
        "tab-charge-asset": `10143:${USDC}`,
        "tab-charge-service": SERVICE_ID,
        "tab-charge-tool": `0x${"33".repeat(32)}`,
        "tab-open-tab": "20000",
        "tab-headroom": "4730000",
      }),
      json: async () => ({ quote: "hello" }),
      text: async () => JSON.stringify({ quote: "hello" }),
    };
  };
  // The endpoint directory is supplied through the SDK's config seam so the test needs no tab.config on disk.
  const { resolveTabMcpSettings } = await import("@tabai/sdk");
  const settings = await resolveTabMcpSettings({ agent: AGENT, chainId: 10143, registryUrl: "http://registry.test", env: HERMETIC, config: { services: [{ serviceId: SERVICE_ID, name: "demo", endpoint: "http://service.test" }] } });
  const { createTabToolset } = await import("@tabai/sdk");
  const toolset = createTabToolset({ settings, env: HERMETIC, fetchImpl, registryFetch: stubRegistryFetch() });
  const output = await toolset.call({ serviceId: SERVICE_ID, tool: "quote.generate", arguments: { prompt: "hi" } });
  assert.equal(output.ok, true, JSON.stringify(output));
  assert.equal(posted[0].url, "http://service.test/meter/quote.generate");
  assert.equal(JSON.parse(posted[0].init.body).prompt, "hi");
  assert.equal(output.charge.amountBaseUnits, "10000");
});
