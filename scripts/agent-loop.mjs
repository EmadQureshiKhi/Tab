#!/usr/bin/env node
/**
 * One Agent through the whole loop, against a live deployment.
 *
 * Authorise the demo Service, discover it, buy a metered call on credit, read
 * the tab, settle it, read it again. Every step is the SDK's own tool, driven
 * the way an MCP client would drive it, so what this prints is what an agent
 * sees. The two things the SDK has no tool for, `TabBook.authorise` and the
 * one-time Permit2 approval, are sent here with the same key.
 *
 *   node --env-file=.env scripts/agent-loop.mjs                    # dry run: settles nothing
 *   node --env-file=.env scripts/agent-loop.mjs --broadcast        # settles with the Agent's key
 *   node --env-file=.env scripts/agent-loop.mjs --broadcast --strategy monad-relayed
 *                                                                  # settles by Permit2 signature through the gateway relay
 *   node --env-file=.env scripts/agent-loop.mjs --calls 3          # more than one metered call
 *   node --env-file=.env scripts/agent-loop.mjs --hub /api/v2/chains
 *                                                                  # one API Hub endpoint, fronted on credit
 *
 * Needs `AGENT_PRIVATE_KEY` for the Agent, the gateway on `GATEWAY_URL`, the
 * registry on `NEXT_PUBLIC_REGISTRY_API_URL`, and the deployment's addresses.
 * Nothing here prints a key.
 */

import { Contract, JsonRpcProvider, Wallet, formatUnits } from "ethers";

import { METERING_HEADER, createTabMcpServer, meteringDigest, stderrLogger, toolKeyOf } from "@tabai/sdk";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 || index + 1 >= args.length ? fallback : args[index + 1];
};

const broadcast = flag("broadcast");
const strategyId = value("strategy", undefined);
const calls = Number.parseInt(value("calls", "1"), 10);
const hubPath = value("hub", undefined);

const env = process.env;
const need = (name) => {
  const found = env[name];
  if (found === undefined || found.trim().length === 0) {
    console.error(`agent-loop: ${name} is not set`);
    process.exit(2);
  }
  return found.trim();
};

const rpcUrl = need("MONAD_RPC_URL");
const chainId = BigInt(need("MONAD_CHAIN_ID"));
const tabBookAddress = need("TAB_BOOK_ADDRESS");
const permit2 = env.PERMIT2_ADDRESS ?? "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const serviceId = env.GATEWAY_SERVICE_ID ?? "0x7461622e64656d6f000000000000000000000000000000000000000000000000";
const assetAddress = (env.GATEWAY_ASSET_ADDRESS ?? env.MOCK_USDC_ADDRESS ?? env.USDC_ADDRESS ?? "").toLowerCase();
if (assetAddress.length === 0) {
  console.error("agent-loop: GATEWAY_ASSET_ADDRESS, MOCK_USDC_ADDRESS or USDC_ADDRESS must name the Asset");
  process.exit(2);
}
const assetRef = `${chainId}:${assetAddress}`;
const gatewayUrl = (env.GATEWAY_URL ?? "http://localhost:8788").replace(/\/+$/, "");

const provider = new JsonRpcProvider(rpcUrl, Number(chainId), { staticNetwork: true });
const agent = new Wallet(need("AGENT_PRIVATE_KEY"), provider);
// The SDK reads the Agent it serves from tab.config, which reads TRY_IT_AGENT.
env.TRY_IT_AGENT = agent.address;
env.GATEWAY_URL = gatewayUrl;

const ERC20 = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"];
const TAB_BOOK = [
  "function assetOpen(address agent, address asset) view returns (uint256)",
  "function authorise(bytes32 serviceId, address asset, uint128 maxCumulative, uint64 expiry)",
  "function authorisationOf(address agent, bytes32 serviceId, address asset) view returns (tuple(uint128 maxCumulative, uint128 spent, uint64 expiry, bool exists))",
];

const asset = new Contract(assetAddress, ERC20, agent);
const tabBook = new Contract(tabBookAddress, TAB_BOOK, agent);
const decimals = Number(await asset.decimals());
const symbol = assetAddress === (env.MOCK_USDC_ADDRESS ?? "").toLowerCase() ? "mUSDC" : await asset.symbol();
const money = (baseUnits) => `${formatUnits(BigInt(baseUnits), decimals)} ${symbol}`;

const step = (title) => console.log(`\n== ${title}`);
const show = (label, text) => console.log(`   ${label.padEnd(14)} ${text}`);
const json = (valueToPrint) => JSON.stringify(valueToPrint, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2).replace(/^/gm, "   ");

step("The Agent");
show("address", agent.address);
show("MON", `${formatUnits(await provider.getBalance(agent.address), 18)} MON`);
show("balance", money(await asset.balanceOf(agent.address)));
show("asset", assetRef);
show("service", serviceId);
show("gateway", gatewayUrl);

step("1. Authorise the Service (TabBook.authorise)");
const authorisation = await tabBook.authorisationOf(agent.address, serviceId, assetAddress);
const now = Math.floor(Date.now() / 1000);
const remaining = authorisation.exists ? BigInt(authorisation.maxCumulative) - BigInt(authorisation.spent) : 0n;
const ceiling = 10n * 10n ** BigInt(decimals);
if (authorisation.exists && Number(authorisation.expiry) > now + 3600 && remaining >= 10n ** BigInt(decimals)) {
  show("standing", `${money(remaining)} left under the ceiling, until ${new Date(Number(authorisation.expiry) * 1000).toISOString()}`);
} else {
  const expiry = BigInt(now + 30 * 24 * 3600);
  show("sending", `authorise(${serviceId.slice(0, 10)}…, ${assetAddress.slice(0, 10)}…, ${money(ceiling)}, ${new Date(Number(expiry) * 1000).toISOString()})`);
  const tx = await tabBook.authorise(serviceId, assetAddress, ceiling, expiry);
  const receipt = await tx.wait();
  show("landed", `${receipt.hash} in block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
}

const server = await createTabMcpServer({ cwd: process.cwd(), env, logger: stderrLogger });
const tools = server.toolset;

step("2. tab_discover");
const discovered = await tools.discover({});
if (discovered.error !== undefined) {
  console.log(json(discovered));
  process.exit(1);
}
for (const service of discovered.services) {
  show("service", `${service.name ?? service.serviceId}  ${service.tier}  accepts ${service.assets.map((entry) => entry.symbol ?? entry.address).join(", ")}`);
  for (const tool of service.tools) show("  tool", `${tool.toolName ?? tool.tool}  ${tool.priceBaseUnits} base units of ${tool.asset}`);
  for (const bond of service.bonds) show("  bond", `${bond.freeBaseUnits} base units free of ${bond.asset}`);
  if (service.hub) show("  hub", `${service.hub.provider} at /hub/${service.hub.prefix}, ${service.hub.endpoints?.length ?? 0} of ${service.hub.total ?? "?"} endpoints listed`);
}

step(`3. tab_call quote.generate, ${calls} time${calls === 1 ? "" : "s"}, on credit`);
for (let index = 0; index < calls; index += 1) {
  const called = await tools.call({ serviceId, tool: "quote.generate", arguments: { prompt: "a quote about credit" } });
  if (!called.ok) {
    console.log(json(called));
    if (called.error?.code !== "LIMIT_EXCEEDED") process.exit(1);
    break;
  }
  show("result", JSON.stringify(called.result));
  show("charge", `${money(called.charge.amountBaseUnits)} on the Open Tab, now ${money(called.tab.openTabBaseUnits)}, headroom ${money(called.tab.headroomBaseUnits)}`);
  if (called.x402) show("x402", `prepaid instead: ${called.x402.txHash}`);
}

if (hubPath !== undefined) {
  step(`3b. The API Hub, fronted on credit: ${hubPath}`);
  // A fronted route is metered like any other, so it is signed like any other:
  // the tool is the mount's own, `apihub.run`, not the endpoint being fronted.
  const hubTool = (env.GATEWAY_HUB_TOOLS ?? "apihub.run").split(",")[0].trim();
  const issuedAt = Date.now();
  const digest = meteringDigest({
    method: "POST",
    path: "/hub/apihub/run",
    agent: agent.address,
    tool: toolKeyOf(hubTool),
    units: 1,
    issuedAt,
  });
  const response = await fetch(`${gatewayUrl}/hub/apihub/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Tab-Agent": agent.address,
      [METERING_HEADER.agentSignature]: await agent.signMessage(digest),
      [METERING_HEADER.agentIssuedAt]: String(issuedAt),
    },
    body: JSON.stringify({ provider: "defillama", endpoint: hubPath, input: {} }),
  });
  const text = await response.text();
  show("status", String(response.status));
  for (const name of ["tab-charge-amount", "tab-open-tab", "tab-headroom", "tab-charge-tool"]) {
    const header = response.headers.get(name);
    if (header !== null) show(name, header);
  }
  show("body", text.length > 300 ? `${text.slice(0, 300)}…` : text);
}

step("4. tab_status");
const before = await tools.status({ agent: agent.address, asset: assetRef, historyLimit: 5 });
console.log(json(before));

// The live figure, off the chain itself. tab_status is as at the index horizon,
// and the delivery a moment ago sits in a block the index may not have read.
const open = BigInt(await tabBook.assetOpen(agent.address, assetAddress));
show("live open tab", `${money(open)} (TabBook.assetOpen, block ${await provider.getBlockNumber()})`);
if (open === 0n) {
  step("5. Nothing open, nothing to settle");
} else {
  step(`5. tab_settle ${money(open)}${strategyId === undefined ? "" : ` through ${strategyId}`}${broadcast ? "" : " (dry run)"}`);
  if (strategyId === "monad-relayed" && broadcast) {
    const allowance = await asset.allowance(agent.address, permit2);
    if (allowance < open) {
      show("approve", `Permit2 once on ${symbol}; the relay refuses without it`);
      const tx = await asset.approve(permit2, (1n << 256n) - 1n);
      const receipt = await tx.wait();
      show("landed", `${receipt.hash} in block ${receipt.blockNumber}`);
    } else {
      show("allowance", "Permit2 already approved");
    }
  }
  const settled = await tools.settle({
    serviceId,
    asset: assetRef,
    amountBaseUnits: open.toString(),
    dryRun: !broadcast,
    ...(strategyId === undefined ? {} : { strategyId }),
  });
  console.log(json(settled));
  if (!settled.ok) process.exit(1);

  if (settled.txHash !== null) {
    // Every figure tab_status reports is as at the index horizon, and the
    // Settlement sits in a block the index has not read yet, so wait for it.
    const receipt = await provider.getTransactionReceipt(settled.txHash);
    const landedAt = receipt?.blockNumber ?? 0;
    step(`6. tab_status after, once the index passes block ${landedAt}`);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const after = await tools.status({ agent: agent.address, asset: assetRef, historyLimit: 5 });
      if (after.error !== undefined || (after.indexedBlock ?? 0) >= landedAt) {
        console.log(json(after));
        break;
      }
      show("waiting", `index at block ${after.indexedBlock ?? "?"}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

step("Done");
show("balance", money(await asset.balanceOf(agent.address)));
show("MON", `${formatUnits(await provider.getBalance(agent.address), 18)} MON`);
await server.close?.();
process.exit(0);
