#!/usr/bin/env node
/**
 * Writes the ERC-8004 feedback a Service owes for Settlements it received
 * before its gateway's reputation writer was switched on.
 *
 *   pnpm --filter @tabai/gateway build
 *   node --env-file=.env scripts/reputation-backfill.mjs              # dry run: simulates, sends nothing
 *   node --env-file=.env scripts/reputation-backfill.mjs --broadcast  # sends, from the operator key
 *
 * It is one tick of the gateway's own writer (`apps/gateway/src/reputation.ts`),
 * so it writes exactly what the gateway would: one entry per Settlement to the
 * Service not yet rated, oldest first, value 100 under the tags `tab` and
 * `settled`, each pointing at `<GATEWAY_PUBLIC_URL>/reputation/<settlementId>`.
 * What is already on chain is counted, not remembered, so running it twice, or
 * beside a gateway that is already writing, writes nothing twice.
 *
 * The feedback is a derived signal: anyone can check each entry against the
 * `Settled` event it names, and the Credit Limit never reads it.
 *
 * Reads `MONAD_RPC_URL`, `MONAD_CHAIN_ID`, `GATEWAY_PRIVATE_KEY` (the Service
 * operator, who is the feedback's client), `GATEWAY_SERVICE_ID`,
 * `NEXT_PUBLIC_REGISTRY_API_URL`, `GATEWAY_PUBLIC_URL` and, optionally,
 * `ERC8004_REPUTATION_REGISTRY_ADDRESS`.
 *
 * The public URL must be the gateway that serves the documents: the hash each
 * entry carries is of the document served there, so point it at the hosted
 * gateway for the network, not at a local one.
 */

import { JsonRpcProvider, Wallet } from "ethers";

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log("usage: node --env-file=.env scripts/reputation-backfill.mjs [--broadcast]");
  process.exit(0);
}
const broadcast = args.has("--broadcast");

let reputation;
try {
  reputation = await import("../apps/gateway/dist/reputation.js");
} catch {
  console.error("reputation-backfill: build the gateway first: pnpm --filter @tabai/gateway build");
  process.exit(2);
}
const { createFeedbackDocuments, createReputationWriter, loadReputationConfig } = reputation;

const env = process.env;
const need = (name) => {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    console.error(`reputation-backfill: ${name} is required`);
    process.exit(2);
  }
  return value;
};

const rpcUrl = need("MONAD_RPC_URL");
const chainId = Number(need("MONAD_CHAIN_ID"));
const operatorKey = need("GATEWAY_PRIVATE_KEY");
const serviceId = need("GATEWAY_SERVICE_ID");
const registryUrl = need("NEXT_PUBLIC_REGISTRY_API_URL");

const config = loadReputationConfig(
  {
    GATEWAY_REPUTATION_ENABLED: "true",
    GATEWAY_PUBLIC_URL: env.GATEWAY_PUBLIC_URL,
    ERC8004_REPUTATION_REGISTRY_ADDRESS: env.ERC8004_REPUTATION_REGISTRY_ADDRESS,
  },
  chainId,
);
if (!config.ok) {
  console.error(`reputation-backfill: ${config.error.message}`);
  process.exit(2);
}

const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true, batchMaxCount: 1 });
const signer = new Wallet(operatorKey, provider);
const documents = createFeedbackDocuments({ provider, chainId, serviceId, registryUrl });
const writer = createReputationWriter({
  provider,
  signer,
  documents,
  reputationRegistry: config.value.reputationRegistry,
  serviceId,
  registryUrl,
  publicUrl: config.value.publicUrl,
  dryRun: !broadcast,
  logger: { info: (message) => console.log(message), warn: (message) => console.error(message) },
});

console.log(`reputation-backfill: chain ${chainId}, Service ${serviceId}, operator ${signer.address}`);
console.log(`reputation-backfill: registry ${config.value.reputationRegistry}, documents at ${config.value.publicUrl}/reputation/:settlementId`);
console.log(broadcast ? "reputation-backfill: broadcasting" : "reputation-backfill: dry run; pass --broadcast to send");

const report = await writer.tick();
for (const skipped of report.skipped) {
  console.log(`skipped ${skipped.agent}${skipped.agentId === undefined ? "" : ` (agent ${skipped.agentId})`}: ${skipped.reason}`);
}
console.log(
  `reputation-backfill: ${report.written.length} ${broadcast ? "written" : "to write"}, ${report.skipped.length} skipped, ${report.failures.length} failed`,
);
process.exit(report.failures.length > 0 ? 1 : 0);
