/**
 * An Agent's Credit Limit growing from real repayment, on Monad Testnet.
 *
 * A new Agent starts at the baseline, and one Service alone never lifts it: growth
 * above the baseline needs settled history with at least three Curated, bonded
 * Services. This script shows that rule working with three such Services on the
 * live deployment, `tab.demo`, `tab.demo.b` and `tab.demo.c`, and a fresh Agent.
 *
 *   node --env-file=.env scripts/credit-growth.mjs prepare [--broadcast]
 *   node --env-file=.env scripts/credit-growth.mjs grow [--broadcast] [--settle <baseUnits>]
 *   node --env-file=.env scripts/credit-growth.mjs status
 *
 * `prepare` mints the test token to the Agent and authorises the three Services.
 * `grow` has each Service meter one call to the Agent, the operator signing
 * `recordDelivery` through the gateway's `meter` tool, and then has the Agent
 * settle with each Service. A Settlement enters the history with the Tier its
 * Service holds at that moment, so `grow` refuses to run until all three are
 * Curated. `status` prints the Credit Limit the registry recomputed and
 * cross-checked against `TabBook.creditLimit`.
 *
 * Each Settlement defaults to 20 mUSDC: the one call it follows is applied to the
 * tab and the rest is banked as prepaid credit with that Service, which the Agent
 * spends on later calls. A Settlement counts at a quarter of its amount on the day
 * it lands and at its full amount after thirty days, no Service may carry more than
 * a quarter of the limit, and the limit never exceeds 95% of the counterparties'
 * free Bond, so three Services lift a 5 mUSDC baseline to at most 20 mUSDC.
 *
 * Nothing is sent without `--broadcast`. Testnet only: the test token is minted
 * freely, and the three Services are the project's own.
 */

import { spawnSync } from "node:child_process";
import { Contract, JsonRpcProvider, Wallet, encodeBytes32String, formatUnits } from "ethers";

const args = process.argv.slice(2);
const phase = args[0];
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 || index + 1 >= args.length ? fallback : args[index + 1];
};
const broadcast = flag("broadcast");

const env = process.env;
const need = (name) => {
  const found = env[name];
  if (found === undefined || found.trim().length === 0) {
    console.error(`credit-growth: ${name} is not set`);
    process.exit(2);
  }
  return found.trim();
};

if (!["prepare", "grow", "status"].includes(phase)) {
  console.error("credit-growth: say prepare, grow or status");
  process.exit(2);
}
if (need("MONAD_CHAIN_ID") !== "10143") {
  console.error("credit-growth: this runs on Monad Testnet (MONAD_CHAIN_ID=10143) only");
  process.exit(2);
}

const provider = new JsonRpcProvider(need("MONAD_RPC_URL"), 10143, { staticNetwork: true });
const agent = new Wallet(need("GROWTH_AGENT_PRIVATE_KEY"), provider);
const fromBlock = need("GROWTH_FROM_BLOCK");
const registryUrl = (env.NEXT_PUBLIC_REGISTRY_API_URL_TESTNET ?? "https://registry-testnet-production.up.railway.app").replace(/\/+$/, "");
const assetAddress = need("MOCK_USDC_ADDRESS").toLowerCase();
const settleEach = BigInt(value("settle", "20000000"));

const SERVICES = [
  { name: "tab.demo", key: "GATEWAY_PRIVATE_KEY" },
  { name: "tab.demo.b", key: "SERVICE_B_OPERATOR_PRIVATE_KEY" },
  { name: "tab.demo.c", key: "SERVICE_C_OPERATOR_PRIVATE_KEY" },
].map((service) => ({ ...service, id: encodeBytes32String(service.name) }));

const token = new Contract(
  assetAddress,
  ["function balanceOf(address) view returns (uint256)", "function mint(address,uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"],
  agent,
);
const tabBook = new Contract(
  need("TAB_BOOK_ADDRESS"),
  ["function authorise(bytes32,address,uint128,uint64)", "function authorisationOf(address,bytes32,address) view returns (tuple(uint128 maxCumulative, uint128 spent, uint64 expiry, bool exists))"],
  agent,
);
const registry = new Contract(need("SERVICE_REGISTRY_ADDRESS"), ["function tierOf(bytes32) view returns (uint8)"], provider);
const settlement = new Contract(need("TAB_SETTLEMENT_ADDRESS"), ["function settle(bytes32,address,uint128) returns (bytes32,uint128,uint128)"], agent);

const money = (baseUnits) => `${formatUnits(BigInt(baseUnits), 6)} mUSDC`;
const step = (title) => console.log(`\n== ${title}`);
const show = (label, text) => console.log(`   ${label.padEnd(14)} ${text}`);
const send = async (label, promise) => {
  const receipt = await (await promise).wait();
  show(label, `${receipt.hash} in block ${receipt.blockNumber}`);
  return receipt;
};

/** The limit the registry recomputed from the history, and whether the chain agreed. */
async function creditLimit() {
  const response = await fetch(`${registryUrl}/agents/${agent.address.toLowerCase()}`);
  if (!response.ok) return { text: `the registry answered ${response.status}` };
  const body = await response.json();
  const entry = (body.assets ?? []).find((item) => item.asset?.toLowerCase() === assetAddress);
  if (entry === undefined) return { text: "no history in mUSDC yet", block: body.index?.lastBlock };
  const limit = entry.creditLimit;
  return { value: BigInt(limit.value), text: `${money(limit.value)}${limit.confirmed === false ? " (not confirmed on chain)" : ""}`, block: body.index?.lastBlock };
}

async function waitForIndex(block) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const body = await (await fetch(`${registryUrl}/agents/${agent.address.toLowerCase()}`)).json();
    if ((body.index?.lastBlock ?? 0) >= block) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

step("The Agent");
show("address", agent.address);
show("MON", `${formatUnits(await provider.getBalance(agent.address), 18)} MON`);
show("balance", money(await token.balanceOf(agent.address)));
show("history from", `block ${fromBlock}`);
for (const service of SERVICES) {
  const tier = Number(await registry.tierOf(service.id));
  show(service.name, tier === 1 ? "Curated" : "Permissionless");
  service.curated = tier === 1;
}
const before = await creditLimit();
show("credit limit", before.text);

if (phase === "status") process.exit(0);

if (phase === "prepare") {
  step("Mint the test token and authorise the three Services");
  const wanted = settleEach * BigInt(SERVICES.length) + 5_000_000n;
  const balance = await token.balanceOf(agent.address);
  if (balance < wanted) {
    show("mint", money(wanted - balance));
    if (broadcast) await send("minted", token.mint(agent.address, wanted - balance));
  }
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
  for (const service of SERVICES) {
    const standing = await tabBook.authorisationOf(agent.address, service.id, assetAddress);
    if (standing.exists && Number(standing.expiry) > Date.now() / 1000 + 7 * 24 * 3600) {
      show(service.name, `already authorised up to ${money(standing.maxCumulative)}`);
      continue;
    }
    show(service.name, `authorise up to ${money(100_000_000n)} for 30 days`);
    if (broadcast) await send("authorised", tabBook.authorise(service.id, assetAddress, 100_000_000n, expiry));
  }
  if (!broadcast) console.log("\nDry run. Nothing was sent. Add --broadcast to mint and authorise.");
  process.exit(0);
}

// grow
if (!SERVICES.every((service) => service.curated)) {
  console.error("\ncredit-growth: all three Services must be Curated first, because a Settlement records the Tier its Service holds when it lands");
  process.exit(1);
}

step(`One metered call to each Service, then a Settlement of ${money(settleEach)} with each`);
let lastBlock = 0;
for (const service of SERVICES) {
  show(service.name, "recordDelivery, signed by its operator");
  const metered = spawnSync(
    process.execPath,
    ["apps/gateway/dist/bin/meter.js", "--agent", agent.address, "--service", service.id, "--asset", assetAddress, "--units", "1", ...(broadcast ? ["--broadcast"] : [])],
    { env: { ...env, GATEWAY_PRIVATE_KEY: need(service.key), GATEWAY_SERVICE_ID: service.id, REGISTRY_START_BLOCK: fromBlock }, encoding: "utf8" },
  );
  const lines = `${metered.stdout}\n${metered.stderr}`.split("\n").filter((line) => /charge|tab|recorded|refused|error|delivery/i.test(line));
  for (const line of lines.slice(0, 4)) show("", line.trim());
  if (metered.status !== 0) {
    console.error(`credit-growth: metering ${service.name} did not succeed`);
    process.exit(1);
  }
  if (!broadcast) continue;
  // The delivery must land in an earlier second than the Settlement for it to count.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  if ((await token.allowance(agent.address, await settlement.getAddress())) < settleEach) {
    await send("approved", token.approve(await settlement.getAddress(), settleEach * BigInt(SERVICES.length)));
  }
  const receipt = await send("settled", settlement.settle(service.id, assetAddress, settleEach));
  lastBlock = receipt.blockNumber;
}

if (!broadcast) {
  console.log("\nDry run. Nothing was sent. Add --broadcast to meter and settle.");
  process.exit(0);
}

step("The Credit Limit, once the registry has read the Settlements");
await waitForIndex(lastBlock);
const after = await creditLimit();
show("before", before.text);
show("after", after.text);
