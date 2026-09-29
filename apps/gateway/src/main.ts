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

import { createX402Facilitator } from "@tabai/sdk";

import { resolveAssetLabel } from "./asset.js";
import { loadGatewayConfig, requireOperatorKey } from "./config.js";
import { createHistorySource, headReadFailed } from "./history.js";
import { buildWitness, checkOperatorKey, createWitnessReader } from "./witness.js";
import { createTabBookClient } from "./tab-book.js";
import { createSettlementRelay } from "./relay.js";
import { createApp, type GatewayAsset, type GatewayHubOptions, type GatewayX402Options } from "./server.js";
import { loadX402Config, readCollectionAddress, readEip712Domain } from "./x402.js";

/**
 * Every read is pinned to `latest`. Monad finalises a block within a second, and
 * the witness has to describe the same history the broadcast will be checked
 * against, so reading further behind the head would only widen the window in
 * which a Settlement lands between the two.
 */
const BLOCK_TAG = "latest";

const exit = (code: number): void => {
  process.exitCode = code;
};

/**
 * The variables below are read as direct member reads off the process
 * environment so `scripts/env-check.mjs` can see them, and every name is
 * declared in the tracked `.env.example`.
 */
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
  const assetAddress = process.env.GATEWAY_ASSET_ADDRESS ?? process.env.MOCK_USDC_ADDRESS;
  if (serviceId === undefined || !/^0x[0-9a-fA-F]{64}$/.test(serviceId)) {
    console.error("gateway: GATEWAY_SERVICE_ID must be the Service's 32-byte identifier");
    return 2;
  }
  if (assetAddress === undefined || !/^0x[0-9a-fA-F]{40}$/.test(assetAddress)) {
    console.error("gateway: GATEWAY_ASSET_ADDRESS (or MOCK_USDC_ADDRESS on Testnet) must be the Asset contract address");
    return 2;
  }
  const historyFromBlock = Number(process.env.REGISTRY_START_BLOCK ?? "0");
  if (!Number.isInteger(historyFromBlock) || historyFromBlock < 0) {
    console.error("gateway: REGISTRY_START_BLOCK must be the block the contracts were deployed in");
    return 2;
  }

  const provider = new JsonRpcProvider(config.value.rpcUrl, config.value.chainId, {
    batchMaxCount: config.value.batchMaxCount,
    staticNetwork: true,
  });
  const signer = new Wallet(key.value, provider);

  const chainReader = createWitnessReader(
    provider,
    {
      tabBook: config.value.tabBook,
      bond: config.value.bond,
      serviceRegistry: config.value.serviceRegistry,
    },
    BLOCK_TAG,
    historyFromBlock,
  );

  /*
    The history is held between calls and read from the registry on first
    sight, so a witness costs one commitment read on the common path instead
    of a log scan from the deployment block. Nothing read this way is trusted:
    `buildWitness` proves it against `TabBook.historyCommitment` either way.
  */
  const registryUrl = process.env.NEXT_PUBLIC_REGISTRY_API_URL?.trim();
  const reader = createHistorySource({
    chain: chainReader,
    fromBlock: historyFromBlock,
    head: async () => {
      try {
        return { ok: true, value: await provider.getBlockNumber() };
      } catch (error) {
        return { ok: false, error: headReadFailed(error) };
      }
    },
    registryUrl: registryUrl === undefined || registryUrl.length === 0 ? undefined : registryUrl,
    logger: { warn: (message) => console.error(`gateway: ${message}`) },
  });
  if (registryUrl === undefined || registryUrl.length === 0) {
    console.error("gateway: NEXT_PUBLIC_REGISTRY_API_URL is not set, so an Agent's first witness is a log scan from the deployment block");
  }

  // Refuse to start rather than fail per request. `TabBook.recordDelivery` compares
  // `msg.sender` against the registry's operator for exact equality and the operator
  // cannot be reassigned, so a mismatched key makes every delivery revert. Checking it
  // once here turns a late, gas-costing `NotServiceOperator` into a startup error that
  // names both addresses. `bin/meter.ts` makes the same check.
  const operator = await checkOperatorKey(reader, serviceId, await signer.getAddress());
  if (!operator.ok) {
    console.error(`gateway: ${operator.error.code}: ${operator.error.message}`);
    return 2;
  }

  /*
    How long the Service holds a response waiting for its charge to be
    recorded. It must stay under what a caller will wait, or the caller is
    billed for work it never receives; see `RECEIPT_WAIT_MS`.
  */
  const receiptWaitRaw = process.env.GATEWAY_RECEIPT_WAIT_MS?.trim();
  const receiptWaitMs = receiptWaitRaw === undefined || receiptWaitRaw.length === 0 ? undefined : Number(receiptWaitRaw);
  if (receiptWaitMs !== undefined && (!Number.isInteger(receiptWaitMs) || receiptWaitMs < 1_000)) {
    console.error("gateway: GATEWAY_RECEIPT_WAIT_MS must be a whole number of milliseconds, at least 1000");
    return 2;
  }

  const tabBook = createTabBookClient({
    provider,
    tabBook: config.value.tabBook,
    blockTag: BLOCK_TAG,
    signer,
    ...(receiptWaitMs === undefined ? {} : { receiptWaitMs }),
    // Rebuilt per call rather than cached: every Settlement advances the
    // commitment, so a witness held across one would be refused on chain.
    witnessFor: async (agent, asset) => {
      // This Service is a counterparty of every Agent it meters, because the
      // authorisation `recordDelivery` requires makes it one. Naming it here is
      // what lets an Agent with no history buy on the Service's own Bond.
      const built = await buildWitness(reader, agent, asset, { authorised: [serviceId.toLowerCase()] });
      return built.ok ? { ok: true, value: built.value.witness } : built;
    },
  });

  // The symbol every charge and offer is quoted under; see `asset.ts`.
  const label = await resolveAssetLabel(provider, assetAddress, config.value.chainId, process.env.MOCK_USDC_ADDRESS);
  if (!label.ok) {
    console.error(`gateway: ${label.error.code}: ${label.error.message}`);
    return 2;
  }
  const asset: GatewayAsset = {
    chainId: BigInt(config.value.chainId),
    address: assetAddress.toLowerCase() as `0x${string}`,
    decimals: label.value.decimals,
    symbol: label.value.symbol,
  };

  const priceBaseUnits = BigInt(process.env.GATEWAY_PRICE_BASE_UNITS ?? "10000");
  const tool = encodeBytes32String(process.env.GATEWAY_TOOL ?? "quote.generate") as `0x${string}`;

  /*
    Metered requests must be signed, by the operator or by the Agent being
    metered, and are unless this says otherwise. The switch exists for a
    demonstration on a machine where the caller is the operator anyway - the
    Dashboard's "try it" posts from this project's own server to this project's
    own Service - and it defaults to requiring a signature so that forgetting to
    set it is the safe outcome.

    It is not a way to run a Service without authentication. Every metered call
    records a delivery on chain and spends the operator's gas, so a gateway
    reachable from the internet with this off is one anybody can bill.
  */
  const requireSignature = process.env.GATEWAY_REQUIRE_SIGNATURE !== "false";
  if (!requireSignature) {
    console.error(
      "gateway: GATEWAY_REQUIRE_SIGNATURE=false. Metered requests are accepted unsigned, and each one spends this operator's gas. Do not expose this port; an Agent signs its own calls with agentSignedMetering, so there is no reason to.",
    );
  }

  /*
    x402, beside the credit decision. The offer on a 402 names the Service's
    Collection address for the Asset as `payTo`, read from ServiceRegistry so
    a prepaid call lands where a Settlement would. GATEWAY_COLLECTION_ADDRESS
    stands in when the read fails, and with neither the 402 carries no offer
    and a PAYMENT-SIGNATURE is refused as it would be on a gateway that never
    heard of x402.
  */
  const x402Config = loadX402Config();
  if (!x402Config.ok) {
    console.error(`gateway: ${x402Config.error.code}: ${x402Config.error.message}`);
    return 2;
  }
  let x402: GatewayX402Options | undefined;
  if (x402Config.value.enabled) {
    const collection = await readCollectionAddress(provider, config.value.serviceRegistry, serviceId, asset.address);
    const payTo = collection.ok ? collection.value : undefined;
    if (!collection.ok) {
      console.error(`gateway: ${collection.error.code}: ${collection.error.message}; falling back to GATEWAY_COLLECTION_ADDRESS`);
    }
    const resolved = payTo ?? x402Config.value.collectionFallback;
    if (resolved === undefined) {
      console.error("gateway: no Collection address for the Asset, so no x402 offer is made; register the Asset on ServiceRegistry or set GATEWAY_COLLECTION_ADDRESS");
    } else {
      // The token's own EIP-712 domain goes on the offer, so the authorization
      // an Agent signs is the one the token verifies, whatever the rail calls it.
      const domain = await readEip712Domain(provider, asset.address);
      if (domain === undefined) {
        console.error(`gateway: ${asset.address} answers neither eip712Domain() nor name()/version(); the offer carries the domain known for ${asset.symbol}, if any`);
      }
      x402 = {
        facilitator: createX402Facilitator({ url: x402Config.value.facilitatorUrl }),
        payTo: resolved,
        ...(domain === undefined ? {} : { extra: { name: domain.name, version: domain.version } }),
      };
      console.error(`gateway: x402 offers pay to ${resolved} through ${x402Config.value.facilitatorUrl}${domain === undefined ? "" : ` under domain ${domain.name} v${domain.version}`}`);
    }
  }

  /*
    The fronted upstreams. The gateway pays each one with its own key and
    meters the Agent, so the key that pays is the operator's unless a
    dedicated GATEWAY_X402_PRIVATE_KEY is given.
  */
  let hub: GatewayHubOptions | undefined;
  if (x402Config.value.hubUpstreams.length > 0) {
    const payer = x402Config.value.x402Key === undefined ? signer : new Wallet(x402Config.value.x402Key, provider);
    hub = {
      upstreams: x402Config.value.hubUpstreams.map((upstream) => ({
        prefix: upstream.prefix,
        url: upstream.url,
        tool: upstream.tool,
        marginBps: upstream.marginBps,
        marginBaseUnits: upstream.marginBaseUnits,
        ...(upstream.maxUpstreamBaseUnits === undefined ? {} : { maxUpstreamBaseUnits: upstream.maxUpstreamBaseUnits }),
        unitBaseUnits: upstream.unitBaseUnits,
        ...(upstream.payOn === undefined ? {} : { payOn: upstream.payOn }),
      })),
      signer: payer,
    };
    for (const upstream of x402Config.value.hubUpstreams) {
      const where = upstream.payOn === undefined ? "" : ` in ${upstream.payOn.asset} on chain ${upstream.payOn.chainId.toString(10)}`;
      console.error(`gateway: /hub/${upstream.prefix}/* fronts ${upstream.url} as ${upstream.tool}, paid by ${await payer.getAddress()}${where}`);
    }
  }

  /*
    The settlement relay is on whenever the deployment names its TabSettlement.
    The gateway then pays gas for any Agent's signed Settlement with this
    Service; see `relay.ts` for why that costs the Service nothing it did not
    want. `GATEWAY_RELAY_ENABLED=false` switches it off.
  */
  const tabSettlementAddress = process.env.TAB_SETTLEMENT_ADDRESS?.trim();
  const relayEnabled = process.env.GATEWAY_RELAY_ENABLED !== "false";
  const relay =
    relayEnabled && tabSettlementAddress !== undefined && /^0x[0-9a-fA-F]{40}$/.test(tabSettlementAddress) && !/^0x0{40}$/i.test(tabSettlementAddress)
      ? createSettlementRelay({
          provider,
          signer,
          tabSettlement: tabSettlementAddress.toLowerCase() as `0x${string}`,
          chainId: BigInt(config.value.chainId),
        })
      : undefined;
  if (relay === undefined) console.error("gateway: the settlement relay is off (set TAB_SETTLEMENT_ADDRESS, and GATEWAY_RELAY_ENABLED unless false)");

  const app = createApp({
    serviceId: serviceId.toLowerCase() as `0x${string}`,
    asset,
    operator: await signer.getAddress(),
    tabBook,
    priceOf: () => ({ tool, unitPrice: priceBaseUnits }),
    requireSignature,
    ...(x402 === undefined ? {} : { x402 }),
    ...(hub === undefined ? {} : { hub }),
    ...(relay === undefined ? {} : { relay }),
  });

  const port = Number(process.env.GATEWAY_PORT ?? "8788");
  serve({ fetch: app.fetch, port });
  console.error(`gateway: metering ${serviceId} on port ${port}, operator ${await signer.getAddress()}`);
  return 0;
}

exit(await main());
