#!/usr/bin/env node
/**
 * One Nansen call paid per request over x402, with no API credits involved.
 *
 * Nansen's API has two doors. The one most of it uses is an API key with a
 * credit balance, and `/profiler/address/labels` is behind that door only: it
 * answers `401 … This endpoint does not support paid access`. Several other
 * endpoints answer `402` with an x402 offer instead, and one of the options
 * they accept is USDC on Monad Mainnet at $0.01 a call. That door needs no
 * account, no key and no credits, which is the whole point of x402.
 *
 * This is the upstream half of what the gateway's `/hub/nansen` mount does for
 * an Agent: there, the Service pays this bill and meters the Agent's Open Tab
 * for it plus a margin, so the Agent buys Nansen data on credit and settles
 * later. Here the Service pays it directly, which is what proves the upstream
 * works independently of Tab's own metering.
 *
 *   node --env-file=.env scripts/nansen-x402.mjs
 *   node --env-file=.env scripts/nansen-x402.mjs --address 0x… --days 30
 *   node --env-file=.env scripts/nansen-x402.mjs --endpoint /smart-money/holdings
 *
 * The payer is `GATEWAY_X402_PRIVATE_KEY`, or the deployer when that is unset,
 * and it needs USDC on Monad Mainnet and nothing else: the facilitator submits
 * the transfer and pays its gas.
 */

import { Contract, JsonRpcProvider, Wallet, formatUnits } from "ethers";

import { createX402Client } from "@tabai/sdk";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 || index + 1 >= args.length ? fallback : args[index + 1];
};

/** Monad Mainnet, which is where Nansen's offer can be paid in USDC. */
const MAINNET = { chainId: 143n, rpcUrl: "https://rpc.monad.xyz", usdc: "0x754704bc059f8c67012fed69bc8a327a5aafb603" };
const NANSEN = "https://api.nansen.ai/api/v1";

const env = process.env;
const key = (env.GATEWAY_X402_PRIVATE_KEY?.trim() || env.DEPLOYER_PRIVATE_KEY?.trim()) ?? "";
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("nansen-x402: set GATEWAY_X402_PRIVATE_KEY, or DEPLOYER_PRIVATE_KEY, to the key that pays Nansen");
  process.exit(2);
}

const provider = new JsonRpcProvider(MAINNET.rpcUrl, Number(MAINNET.chainId), { staticNetwork: true });
const payer = new Wallet(key, provider);
const usdc = new Contract(MAINNET.usdc, ["function balanceOf(address) view returns (uint256)"], provider);

const endpoint = value("endpoint", "/profiler/address/transactions");
/*
  Whose history to ask for. Nansen's `monad` is Monad Mainnet, so the default
  is this project's own Mainnet Agent or deployer; pass `--address` to ask
  about any other Mainnet address.
*/
const address = value("address", env.AGENT_ADDRESS ?? env.DEPLOYER_ADDRESS ?? payer.address).toLowerCase();
const days = Number.parseInt(value("days", "30"), 10);
const chain = value("chain", "monad");

const iso = (at) => new Date(at).toISOString().slice(0, 10);
const now = Date.now();
// Every paid profiler endpoint requires an explicit window; the API refuses
// `422 Required field 'body -> date' is missing` without one.
const body = {
  address,
  chain,
  date: { from: iso(now - days * 86_400_000), to: iso(now) },
  pagination: { page: 1, per_page: 5 },
};

const show = (label, text) => console.log(`   ${label.padEnd(12)} ${text}`);
console.log("\n== Paying Nansen per call, over x402");
show("payer", payer.address);
show("balance", `${formatUnits(await usdc.balanceOf(payer.address), 6)} USDC on Monad Mainnet`);
show("endpoint", `${NANSEN}${endpoint}`);
show("about", `${address}, ${body.date.from} to ${body.date.to}`);

const before = await usdc.balanceOf(payer.address);
const client = createX402Client({
  signer: payer,
  chainId: MAINNET.chainId,
  asset: MAINNET.usdc,
  // A ceiling, so a repriced upstream cannot quietly spend more than intended.
  maxAmount: BigInt(value("max-base-units", "50000")),
});

const result = await client.fetch(`${NANSEN}${endpoint}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

if (!result.ok) {
  console.error(`\n   refused    ${result.error.code}: ${result.error.message}`);
  process.exit(1);
}

const text = await result.value.response.text();
console.log("\n== Nansen answered");
show("status", String(result.value.response.status));
if (result.value.payment !== undefined) {
  const paid = result.value.payment;
  show("paid", `${paid.amount} base units of ${paid.asset} to ${paid.payTo}`);
  if (paid.txHash !== "") show("settled", `https://monadvision.com/tx/${paid.txHash}`);
  show("network", paid.network);
} else {
  show("paid", "nothing: this endpoint answered without asking");
}

let rows;
try {
  rows = JSON.parse(text).data;
} catch {
  rows = undefined;
}
show("rows", Array.isArray(rows) ? String(rows.length) : "the body was not the documented shape");
console.log(`   body         ${text.slice(0, 220)}${text.length > 220 ? "…" : ""}`);

const after = await usdc.balanceOf(payer.address);
console.log(`\n   ${formatUnits(before - after, 6)} USDC spent, ${formatUnits(after, 6)} left. No API credits were used.`);
process.exit(result.value.response.ok ? 0 : 1);
