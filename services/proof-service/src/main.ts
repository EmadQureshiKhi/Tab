/**
 * `pnpm --filter @tabai/proof-service start`
 *
 * Stands the Proof Service up against the deployed contracts. The process is a thin
 * composition: configuration, the shared runtime, and the Hono app. Every fallible
 * step names the variable or the read that failed and exits rather than serving a
 * Service that cannot bill.
 *
 * The operator key is required here and only here. A Service that cannot sign
 * cannot record a delivery, and with `withholdUnmetered` on it would serve requests
 * that all withhold their material at the last step, which is worse than refusing
 * to start.
 *
 * The port comes from `--port` with a default rather than from the environment,
 * because a second declared variable for a number that only ever differs between
 * two processes on one machine is not worth a line in the tracked contract.
 */

import { serve } from "@hono/node-server";
import { Wallet } from "ethers";

import { checkOperatorKey } from "./witness.js";

import { loadProofServiceConfig, requireOperatorKey, DEFAULT_PROOF_SERVICE_PORT } from "./config.js";
import { createRuntime, assetFor, proofToolWord } from "./runtime.js";
import { createApp } from "./server.js";

const argv = process.argv;

function flag(name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  return argv[at + 1];
}

async function main(): Promise<number> {
  const config = loadProofServiceConfig();
  if (!config.ok) {
    console.error(`proof-service: ${config.error.code}: ${config.error.message}`);
    return 2;
  }

  const key = requireOperatorKey(config.value);
  if (!key.ok) {
    console.error(`proof-service: ${key.error.code}: ${key.error.message}`);
    return 2;
  }

  const chainKeyRaw = flag("--chain-key") ?? "1";
  if (!/^\d+$/.test(chainKeyRaw)) {
    console.error("proof-service: --chain-key must be 1 for Ethereum Sepolia or 3 for Ethereum Mainnet");
    return 2;
  }
  const asset = assetFor(config.value, BigInt(chainKeyRaw));
  if (!asset.ok) {
    console.error(`proof-service: ${asset.error.code}: ${asset.error.message}`);
    return 2;
  }

  const portRaw = flag("--port") ?? String(DEFAULT_PROOF_SERVICE_PORT);
  if (!/^\d+$/.test(portRaw)) {
    console.error("proof-service: --port must be a decimal port number");
    return 2;
  }

  const runtime = createRuntime({ config: config.value });
  const signer = new Wallet(key.value, runtime.provider);
  const signerAddress = await signer.getAddress();

  // Refuse to start rather than fail per request. `TabBook.recordDelivery` compares
  // `msg.sender` against the registry's operator for exact equality and the operator
  // cannot be reassigned, so a mismatched key makes every delivery revert after gas
  // has been spent. The served app cannot notice on its own: it simulates with the
  // operator as `from`, so the simulation passes and only the broadcast fails.
  const checked = await checkOperatorKey(runtime.witnessReader, config.value.serviceId, signerAddress);
  if (!checked.ok) {
    console.error(`proof-service: ${checked.error.code}: ${checked.error.message}`);
    return 2;
  }
  const operator = checked.value;

  // Rebuilt with the signer attached, because the read-only runtime above is what
  // every driver shares and a served app is the one composition that spends.
  const serving = createRuntime({ config: config.value, signer, simulateFrom: operator });

  const app = createApp({
    serviceId: config.value.serviceId as `0x${string}`,
    asset: asset.value,
    tool: proofToolWord(),
    unitPrice: config.value.unitPrice,
    tabBook: serving.tabBook,
    deliverer: serving.deliverer,
  });

  const port = Number(portRaw);
  serve({ fetch: app.fetch, port });
  console.error(
    `proof-service: selling ${config.value.serviceId} at ${config.value.unitPrice.toString(10)} base units per proof on port ${port}, operator ${operator}`,
  );
  return 0;
}

process.exitCode = await main();
