/**
 * Where the MCP server's settings come from when a fresh install names nothing.
 *
 * The project's hosted read API and demo Service fill in last, per network, so
 * `tab_discover` and `tab_call` work before anything is configured. Anything
 * configured wins, and TAB_HOSTED_DEFAULTS=off (or `hostedDefaults: false`)
 * switches them off entirely.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TAB_HOSTED, assetFacts, resolveTabMcpSettings } from "../dist/index.js";

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
// The filesystem root holds no tab.config, so only the arguments and the env below count.
const base = { cwd: "/", logger: silent, config: false };

test("with nothing configured, Testnet reads the hosted registry and knows the hosted demo Service", async () => {
  const settings = await resolveTabMcpSettings({ ...base, env: {} });
  assert.equal(settings.chainId, 10143);
  assert.equal(settings.registryUrl, TAB_HOSTED[10143].registryUrl);
  assert.deepEqual(
    settings.services.map((entry) => entry.endpoint),
    [TAB_HOSTED[10143].demoService.endpoint],
  );
  assert.equal(settings.explorerUrl, "https://testnet.monadvision.com");
  assert.match(settings.sources.registryUrl, /default/);
});

test("naming Mainnet gives Mainnet's registry, demo Service and explorer", async () => {
  const settings = await resolveTabMcpSettings({ ...base, env: { MONAD_CHAIN_ID: "143" } });
  assert.equal(settings.chainId, 143);
  assert.equal(settings.registryUrl, TAB_HOSTED[143].registryUrl);
  assert.equal(settings.services[0].endpoint, TAB_HOSTED[143].demoService.endpoint);
  assert.equal(settings.explorerUrl, "https://monadvision.com");
});

test("a configured registry and Service win over the hosted ones", async () => {
  const settings = await resolveTabMcpSettings({
    ...base,
    env: { NEXT_PUBLIC_REGISTRY_API_URL: "http://registry.local" },
    services: [{ serviceId: TAB_HOSTED[10143].demoService.serviceId, endpoint: "http://gateway.local" }],
  });
  assert.equal(settings.registryUrl, "http://registry.local");
  assert.deepEqual(
    settings.services.map((entry) => entry.endpoint),
    ["http://gateway.local"],
  );
});

test("TAB_HOSTED_DEFAULTS=off and hostedDefaults: false both leave everything unset", async () => {
  for (const settings of [
    await resolveTabMcpSettings({ ...base, env: { TAB_HOSTED_DEFAULTS: "off" } }),
    await resolveTabMcpSettings({ ...base, env: {}, hostedDefaults: false }),
  ]) {
    assert.equal(settings.registryUrl, undefined);
    assert.equal(settings.services.length, 0);
  }
});

test("the hosted Testnet test token is named mUSDC with nothing exported", () => {
  const facts = assetFacts(10143, TAB_HOSTED[10143].testAsset, {});
  assert.equal(facts.symbol, "mUSDC");
  assert.equal(facts.decimals, 6);
});
