#!/usr/bin/env node
/**
 * One metered call paid up front over x402, against a live deployment.
 *
 * This is the other half of `agent-loop.mjs`. That one buys on credit and
 * settles; this one takes the prepaid door instead: the Agent signs an EIP-3009
 * authorization for the charge, sends it as `PAYMENT-SIGNATURE`, and Monad's
 * facilitator moves the Asset to the Service's Collection address before the
 * work is delivered. Nothing lands on the Open Tab, because nothing is owed,
 * and the payment is not a Settlement: it enters no history and raises no
 * Credit Limit.
 *
 *   node --env-file=.env scripts/x402-prepaid.mjs
 *   node --env-file=.env scripts/x402-prepaid.mjs --tool quote.generate --amount 10000
 *
 * The Agent needs the Asset and nothing else: the facilitator submits the
 * transaction and pays its gas, so no MON is spent by anyone here.
 *
 * This builds the offer locally rather than reading it off a `402`, so it can
 * be run without first exhausting the Agent's credit. A real caller takes the
 * offer the Service sent, which carries the same fields; `tab_call` does that
 * on its own when `tab.config` names an `x402` signer.
 */

import { Contract, JsonRpcProvider, Wallet, formatUnits } from "ethers";

import {
  X402_HEADER,
  decodePaymentResponse,
  encodePaymentSignature,
  exactRequirementFor,
  paymentRequiredFor,
  signExactPayment,
} from "@tabai/sdk";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 || index + 1 >= args.length ? fallback : args[index + 1];
};

const env = process.env;
const need = (name) => {
  const found = env[name]?.trim();
  if (found === undefined || found.length === 0) {
    console.error(`x402-prepaid: ${name} is not set`);
    process.exit(2);
  }
  return found;
};

const chainId = BigInt(need("MONAD_CHAIN_ID"));
const rpcUrl = need("MONAD_RPC_URL");
const gatewayUrl = (env.GATEWAY_URL ?? "http://localhost:8788").replace(/\/+$/, "");
const assetAddress = (env.GATEWAY_ASSET_ADDRESS ?? env.MOCK_USDC_ADDRESS ?? env.USDC_ADDRESS ?? "").toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(assetAddress)) {
  console.error("x402-prepaid: GATEWAY_ASSET_ADDRESS, MOCK_USDC_ADDRESS or USDC_ADDRESS must name the Asset");
  process.exit(2);
}
const isMock = assetAddress === (env.MOCK_USDC_ADDRESS ?? "").toLowerCase();
const tool = value("tool", env.GATEWAY_TOOL ?? "quote.generate");
const amount = BigInt(value("amount", env.GATEWAY_PRICE_BASE_UNITS ?? "10000"));

const provider = new JsonRpcProvider(rpcUrl, Number(chainId), { staticNetwork: true });
const agent = new Wallet(need("AGENT_PRIVATE_KEY"), provider);

/*
  Where the payment lands, and under which EIP-712 domain it is signed. Both
  come off the chain rather than from a guess: `collectionOf` is what a
  Settlement would pay, and the token's own domain is what it verifies a
  transferWithAuthorization against.
*/
const registry = new Contract(
  need("SERVICE_REGISTRY_ADDRESS"),
  ["function collectionOf(bytes32 serviceId, address asset) view returns (address)"],
  provider,
);
const token = new Contract(
  assetAddress,
  [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function name() view returns (string)",
    "function version() view returns (string)",
  ],
  provider,
);

const serviceId = env.GATEWAY_SERVICE_ID ?? "0x7461622e64656d6f000000000000000000000000000000000000000000000000";
const payTo = (await registry.collectionOf(serviceId, assetAddress)).toLowerCase();
const decimals = Number(await token.decimals());
const domain = { name: await token.name(), version: await token.version() };
const symbol = isMock ? "mUSDC" : "USDC";
const money = (base) => `${formatUnits(base, decimals)} ${symbol}`;

const show = (label, text) => console.log(`   ${label.padEnd(14)} ${text}`);
console.log("\n== The prepaid call");
show("agent", agent.address);
show("balance", money(await token.balanceOf(agent.address)));
show("asset", `${assetAddress} (${symbol}, domain ${domain.name} v${domain.version})`);
show("pay to", `${payTo}, the Service's Collection address`);
show("charge", money(amount));

const url = `${gatewayUrl}/meter/${encodeURIComponent(tool)}`;
const requirement = exactRequirementFor({
  chainId,
  asset: { address: assetAddress, symbol },
  amount,
  payTo,
  extra: domain,
});
if (!requirement.ok) {
  console.error(`x402-prepaid: ${requirement.error.code}: ${requirement.error.message}`);
  process.exit(1);
}
const required = paymentRequiredFor({
  resource: { url, description: tool, mimeType: "application/json" },
  accepts: [requirement.value],
});

const signed = await signExactPayment({ signer: agent, required, accepted: requirement.value });
if (!signed.ok) {
  console.error(`x402-prepaid: ${signed.error.code}: ${signed.error.message}`);
  process.exit(1);
}
const header = encodePaymentSignature(signed.value.payload);
if (!header.ok) {
  console.error(`x402-prepaid: ${header.error.code}: ${header.error.message}`);
  process.exit(1);
}

console.log("\n== Signed, and sent with the request");
show("payer", signed.value.payer);
show("nonce", signed.value.authorization.nonce);
show("valid to", new Date(Number(signed.value.authorization.validBefore) * 1000).toISOString());

const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "Tab-Agent": agent.address,
    [X402_HEADER.paymentSignature]: header.value,
  },
  body: JSON.stringify({ prompt: "paid up front" }),
});
const body = await response.text();

console.log("\n== The Service answered");
show("status", String(response.status));
show("body", body.length > 300 ? `${body.slice(0, 300)}…` : body);

const settled = response.headers.get(X402_HEADER.paymentResponse);
if (settled !== null) {
  const decoded = decodePaymentResponse(settled);
  if (decoded.ok) {
    show("settled", `${decoded.value.success ? "yes" : "no"}, ${decoded.value.transaction ?? "no transaction"}`);
    if (decoded.value.transaction !== undefined) {
      show("explorer", `${(env.MONAD_EXPLORER_URL ?? "https://testnet.monadvision.com").replace(/\/+$/, "")}/tx/${decoded.value.transaction}`);
    }
  }
}
// The Open Tab is the point: a prepaid call must not raise it.
for (const name of ["tab-charge-amount", "tab-open-tab", "tab-headroom"]) {
  const header = response.headers.get(name);
  if (header !== null) show(name, header);
}
console.log("\n   Nothing landed on the Open Tab: the call was paid in full, once.");
show("balance", money(await token.balanceOf(agent.address)));
process.exit(response.ok ? 0 : 1);
