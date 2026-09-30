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

import { Wallet, verifyMessage } from "ethers";

import { METERING_HEADER, TAB_HOSTED, assetFacts, meteringDigest, resolveTabMcpSettings, toolKeyOf } from "../dist/index.js";

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

const AGENT = new Wallet(`0x${"55".repeat(32)}`);

/** What the hosted demo entry adds to one metered call by `agent`. */
const demoHeaders = (settings, agent) => {
  const demo = settings.services.find((entry) => entry.serviceId === TAB_HOSTED[10143].demoService.serviceId);
  return demo.headers({
    method: "POST",
    url: `${demo.endpoint}/meter/quote.generate`,
    tool: "quote.generate",
    agent,
    serviceId: demo.serviceId,
  });
};

test("AGENT_ADDRESS names the Agent when nothing else does, and a configured Agent wins", async () => {
  const fromEnv = await resolveTabMcpSettings({ ...base, env: { AGENT_ADDRESS: AGENT.address } });
  assert.equal(fromEnv.agent, AGENT.address.toLowerCase());
  assert.equal(fromEnv.sources.agent, "env AGENT_ADDRESS");
  const configured = await resolveTabMcpSettings({
    ...base,
    agent: "0x00000000000000000000000000000000000000aa",
    env: { AGENT_ADDRESS: AGENT.address },
  });
  assert.equal(configured.agent, "0x00000000000000000000000000000000000000aa");
});

test("the hosted demo Service signs a metered call with the Agent's own key, and only for that Agent", async () => {
  const settings = await resolveTabMcpSettings({
    ...base,
    env: { AGENT_ADDRESS: AGENT.address, AGENT_PRIVATE_KEY: AGENT.privateKey },
  });
  const headers = await demoHeaders(settings, AGENT.address);
  const issuedAt = Number(headers[METERING_HEADER.agentIssuedAt]);
  const digest = meteringDigest({
    method: "POST",
    path: "/meter/quote.generate",
    agent: AGENT.address,
    tool: toolKeyOf("quote.generate"),
    units: 1,
    issuedAt,
  });
  assert.equal(verifyMessage(digest, headers[METERING_HEADER.agentSignature]), AGENT.address);
  // A key that is not the Agent's signs nothing, so the Service decides.
  assert.deepEqual(await demoHeaders(settings, "0x00000000000000000000000000000000000000aa"), {});
});

test("without a key the hosted demo Service adds no signature", async () => {
  const settings = await resolveTabMcpSettings({ ...base, env: { AGENT_ADDRESS: AGENT.address } });
  assert.deepEqual(await demoHeaders(settings, AGENT.address), {});
});

test("a fresh install knows where to settle on each network, and it is the deployment's own TabSettlement", async () => {
  const { readFileSync } = await import("node:fs");
  const record = JSON.parse(readFileSync(new URL("../../../deployments.json", import.meta.url), "utf8"));
  for (const chain of ["143", "10143"]) {
    const settings = await resolveTabMcpSettings({ ...base, env: { MONAD_CHAIN_ID: chain } });
    assert.equal(
      settings.hostedSettlement.tabSettlement.toLowerCase(),
      record.networks[chain].contracts.TabSettlement.address.toLowerCase(),
      `chain ${chain}`,
    );
  }
  const mainnet = await resolveTabMcpSettings({ ...base, env: { MONAD_CHAIN_ID: "143" } });
  assert.deepEqual(Object.values(mainnet.hostedSettlement.assets).map((asset) => asset.symbol).sort(), ["AUSD", "USDC"]);
  assert.equal(mainnet.hostedSettlement.rpcUrl, "https://rpc.monad.xyz");
  const testnet = await resolveTabMcpSettings({ ...base, env: {} });
  assert.deepEqual(Object.values(testnet.hostedSettlement.assets).map((asset) => asset.symbol).sort(), ["USDC", "mUSDC"]);
  const off = await resolveTabMcpSettings({ ...base, env: { TAB_HOSTED_DEFAULTS: "off" } });
  assert.equal(off.hostedSettlement, undefined, "no hosted defaults, so nowhere is assumed");
});
