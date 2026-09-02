/**
 * `pnpm --filter @tabai/gateway start`
 *
 * Stands the metering service up against the deployed contracts. The process is a
 * thin composition: configuration, a witness reader, a `TabBook` client, and the
 * Hono app. Every fallible step names the variable or the read that failed and
 * exits rather than serving a gateway that cannot bill.
 *
 * The operator key is required here and only here. A gateway that cannot sign
 * cannot record a delivery, so starting one without a key would serve requests
 * that all fail at the last step, which is worse than refusing to start.
 */

import { serve } from "@hono/node-server";
import { JsonRpcProvider, Wallet, encodeBytes32String } from "ethers";

import { loadGatewayConfig, requireOperatorKey } from "./config.js";
import { buildWitness, checkOperatorKey, createWitnessReader } from "./witness.js";
import { createTabBookClient } from "./tab-book.js";
import { createApp, type GatewayAsset } from "./server.js";

const BLOCK_TAG = "finalized";
const HISTORY_FROM_BLOCK = 5_407_360;

/**
 * Written as direct member reads off the process environment so
 * `scripts/env-check.mjs` can see them. `GATEWAY_SERVICE_ID` and `GATEWAY_PORT` are new with this service and are
 * owed a declaration in the tracked `.env.example`; the gate will name them until
 * they have one, which is the gate working rather than failing.
 */
const exit = (code: number): void => {
  process.exitCode = code;
};

async function main(): Promise<number> {
  const config = loadGatewayConfig();
  if (!config.ok) {
    console.error(`gateway: ${config.error.code}: ${config.error.message}`);
    return 2;
  }

  const key = requireOperatorKey(config.value);
  if (!key.ok) {
    console.error(`gateway: ${key.error.code}: ${key.error.message}`);
    return 2;
  }

  const serviceId = process.env.GATEWAY_SERVICE_ID;
  const assetAddress = process.env.SEPOLIA_USDC_ADDRESS;
  if (serviceId === undefined || !/^0x[0-9a-fA-F]{64}$/.test(serviceId)) {
    console.error("gateway: GATEWAY_SERVICE_ID must be the Service's 32-byte identifier");
    return 2;
  }
  if (assetAddress === undefined || !/^0x[0-9a-fA-F]{40}$/.test(assetAddress)) {
    console.error("gateway: SEPOLIA_USDC_ADDRESS must be the Asset contract address");
    return 2;
  }

  const provider = new JsonRpcProvider(config.value.rpcUrl, config.value.chainId, {
    batchMaxCount: config.value.batchMaxCount,
    staticNetwork: true,
  });
  const signer = new Wallet(key.value, provider);

  const reader = createWitnessReader(
    provider,
    {
      tabBook: config.value.tabBook,
      bond: config.value.bond,
      serviceRegistry: config.value.serviceRegistry,
    },
    BLOCK_TAG,
    HISTORY_FROM_BLOCK,
  );

  // Refuse to start rather than fail per request. `TabBook.recordDelivery` compares
  // `msg.sender` against the registry's operator for exact equality and the operator
  // cannot be reassigned, so a mismatched key makes every delivery revert. Checking it
  // once here turns a late, gas-costing `NotServiceOperator` into a startup error that
  // names both addresses. `meter.ts` already did this; the server did not.
  const operator = await checkOperatorKey(reader, serviceId, await signer.getAddress());
  if (!operator.ok) {
    console.error(`gateway: ${operator.error.code}: ${operator.error.message}`);
    return 2;
  }

  const tabBook = createTabBookClient({
    provider,
    tabBook: config.value.tabBook,
    blockTag: BLOCK_TAG,
    signer,
    // Rebuilt per call rather than cached: every Verified Settlement advances the
    // commitment, so a witness held across one would be refused on chain.
    witnessFor: async (agent, asset) => {
      const built = await buildWitness(reader, agent, asset);
      return built.ok ? { ok: true, value: built.value.witness } : built;
    },
  });

  const asset: GatewayAsset = {
    chainKey: 1n,
    address: assetAddress.toLowerCase() as `0x${string}`,
    decimals: 6,
    symbol: "USDC",
  };

  const priceBaseUnits = BigInt(process.env.PROOF_SERVICE_PRICE_BASE_UNITS ?? "10000");
  const tool = encodeBytes32String("proof.generate") as `0x${string}`;

  /*
    Metered requests must be signed by the operator, and are unless this says
    otherwise. The switch exists for a demonstration on a machine where the
    caller is the operator anyway - the Dashboard's "try it" posts from this
    project's own server to this project's own Service - and it defaults to
    requiring the signature so that forgetting to set it is the safe outcome.

    It is not a way to run a Service without authentication. Every metered call
    records a delivery on chain and spends the operator's gas, so a gateway
    reachable from the internet with this off is one anybody can bill.
  */
  const requireSignature = process.env.GATEWAY_REQUIRE_SIGNATURE !== "false";
  if (!requireSignature) {
    console.error(
      "gateway: GATEWAY_REQUIRE_SIGNATURE=false. Metered requests are accepted unsigned, and each one spends this operator's gas. Do not expose this port.",
    );
  }

  const app = createApp({
    serviceId: serviceId.toLowerCase() as `0x${string}`,
    asset,
    operator: await signer.getAddress(),
    tabBook,
    priceOf: () => ({ tool, unitPrice: priceBaseUnits }),
    requireSignature,
  });

  const port = Number(process.env.GATEWAY_PORT ?? "8788");
  serve({ fetch: app.fetch, port });
  console.error(`gateway: metering ${serviceId} on port ${port}, operator ${await signer.getAddress()}`);
  return 0;
}

exit(await main());
