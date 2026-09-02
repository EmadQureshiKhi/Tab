/**
 * `pnpm --filter @tabai/proof-service settle`
 *
 * Settles one of the Proof Service's own Open Tabs, through the same Settlement,
 * verification and clearing path every other Agent uses (R22.4).
 *
 * **Read-only by default.** Without `--broadcast` this reads the Open Tab, checks
 * the recipient against `ServiceRegistry.collectionFor`, quotes the payment through
 * the SDK strategy, and prints the plan. Nothing is submitted and no key is loaded.
 *
 * **Nothing here writes to Creditcoin, with or without the flag.** The Settlement
 * is a USDC payment on a Source Chain; the Watcher observes the log, proves it, and
 * `SettlementVerifier` and `TabBook` do the crediting. The operator holds a key that
 * could shortcut all of that and deliberately does not use it here, because a rail
 * whose operator can clear its own tabs by hand is not a rail.
 *
 * Flags:
 *   --broadcast          submit the Settlement; without it nothing is spent
 *   --service 0x…        the Service the tab is owed to, 32 bytes; defaults to this one
 *   --chain-key N        1 for Ethereum Sepolia, 3 for Ethereum Mainnet, default 1
 *   --collection 0x…     the Collection Address to pay; defaults to the configured one
 *   --amount N           base units to pay; defaults to the whole Open Tab
 *   --rpc-url URL        the Source Chain endpoint; defaults to the first configured one
 *
 * Exit codes: 0 the plan was made or the Settlement was submitted, 1 it was
 * refused, 2 the run could not start.
 */

import { JsonRpcProvider, Wallet } from "ethers";

import { createEthereumUsdcStrategy, assetKey } from "@tabai/sdk";

import { loadProofServiceConfig, requireOperatorKey, requireCollectionAddress } from "../config.js";
import { createRuntime, assetFor, BLOCK_TAG } from "../runtime.js";
import { createSettlementReader, createProofServiceSettler } from "../settlement.js";

const argv = process.argv;

function flag(name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  return argv[at + 1];
}

const has = (name: string): boolean => argv.includes(name);

async function main(): Promise<number> {
  const config = loadProofServiceConfig();
  if (!config.ok) {
    console.error(`settle: ${config.error.code}: ${config.error.message}`);
    return 2;
  }

  const broadcast = has("--broadcast");

  const chainKeyRaw = flag("--chain-key") ?? "1";
  if (!/^\d+$/.test(chainKeyRaw)) {
    console.error("settle: --chain-key must be a decimal chainKey; 1 is Sepolia and 3 is Mainnet");
    return 2;
  }
  const chainKey = BigInt(chainKeyRaw);

  const asset = assetFor(config.value, chainKey);
  if (!asset.ok) {
    console.error(`settle: ${asset.error.code}: ${asset.error.message}`);
    return 2;
  }

  const serviceId = (flag("--service") ?? config.value.serviceId).toLowerCase();
  if (!/^0x[0-9a-fA-F]{64}$/.test(serviceId)) {
    console.error("settle: --service must be the Service's 32-byte registry key");
    return 2;
  }

  const collectionFlag = flag("--collection");
  let collectionAddress: string;
  if (collectionFlag === undefined) {
    const configured = requireCollectionAddress(config.value);
    if (!configured.ok) {
      console.error(`settle: ${configured.error.code}: ${configured.error.message}`);
      return 2;
    }
    collectionAddress = configured.value;
  } else {
    collectionAddress = collectionFlag.toLowerCase();
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(collectionAddress)) {
    console.error("settle: --collection must be a 20-byte 0x address");
    return 2;
  }

  const amountRaw = flag("--amount");
  if (amountRaw !== undefined && !/^\d+$/.test(amountRaw)) {
    console.error("settle: --amount must be a decimal count of Asset base units");
    return 2;
  }

  // The Source Chain endpoint. Needed for a broadcast, and for the allowance read
  // the settlement-contract surface makes before it pays.
  const source = config.value.sourceChains[chainKey.toString(10)];
  const rpcUrl = flag("--rpc-url") ?? source?.rpcUrls[0];

  // The key is loaded only for a broadcast, and it is the Source Chain payer key.
  let payer: Wallet | undefined;
  if (broadcast) {
    const key = requireOperatorKey(config.value);
    if (!key.ok) {
      console.error(`settle: ${key.error.code}: ${key.error.message}`);
      return 2;
    }
    if (rpcUrl === undefined) {
      console.error(
        `settle: no Source Chain endpoint is configured for chainKey ${chainKey.toString(10)}; set ETHEREUM_SEPOLIA_RPC_URLS or ETHEREUM_MAINNET_RPC_URLS, or pass --rpc-url`,
      );
      return 2;
    }
    payer = new Wallet(key.value, new JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 }));
  }

  const agentFlag = flag("--agent")?.toLowerCase();
  const agent = payer === undefined ? agentFlag : await payer.getAddress();
  if (agent === undefined || !/^0x[0-9a-fA-F]{40}$/.test(agent)) {
    console.error(
      "settle: a keyless run cannot derive the Proof Service's own address, so pass --agent 0x… with the operator's public address",
    );
    return 2;
  }

  const runtime = createRuntime({ config: config.value });
  const reader = createSettlementReader(
    runtime.provider,
    { tabBook: config.value.tabBook, serviceRegistry: config.value.serviceRegistry },
    BLOCK_TAG,
  );

  // The same strategy `packages/sdk` ships for every other Agent. A keyless run
  // still needs one to quote, so it gets a signer that can read its own address and
  // would refuse to send: `settle` is gated on `--broadcast` above it either way.
  const strategy = createEthereumUsdcStrategy({
    signer:
      payer ??
      {
        getAddress: async (): Promise<string> => agent,
        sendTransaction: async (): Promise<{ hash: string }> => {
          throw new Error("this run holds no key, so nothing can be submitted");
        },
      },
    ...(source?.settlementContract === undefined
      ? {}
      : { settlementContract: source.settlementContract as `0x${string}` }),
    assets: { [assetKey(asset.value)]: asset.value },
    // A keyless run has no provider to read an allowance with, and a broadcast run
    // reads it through the payer's own connection.
    allowanceCheck: payer === undefined ? "skip" : "read",
  });

  const settler = createProofServiceSettler({ agent, reader, strategy });

  const plan = await settler.plan({
    serviceId,
    asset: asset.value,
    collectionAddress,
    ...(amountRaw === undefined ? {} : { amount: BigInt(amountRaw) }),
  });
  if (!plan.ok) {
    console.error(`settle: ${plan.error.code}: ${plan.error.message}`);
    if (plan.error.details !== undefined) {
      console.error(`settle: details ${JSON.stringify(plan.error.details)}`);
    }
    return 1;
  }

  console.error(
    `settle: tab ${plan.value.tabId} holds ${plan.value.openTab.toString(10)} ${asset.value.symbol} base units open${plan.value.delinquent ? " and is delinquent" : ""}`,
  );
  console.error(
    `settle: would pay ${plan.value.amount.toString(10)} to ${plan.value.collectionAddress} on chainKey ${chainKey.toString(10)} by ${plan.value.mode}`,
  );
  console.error(`settle: ${plan.value.feeNote}`);

  if (!broadcast) {
    console.error("settle: read-only run, so nothing was submitted; re-run with --broadcast to pay");
    return 0;
  }

  const submitted = await settler.settle(plan.value, { broadcast: true });
  if (!submitted.ok) {
    console.error(`settle: ${submitted.error.code}: ${submitted.error.message}`);
    return 1;
  }

  console.error(
    `settle: submitted ${submitted.value.receipt.sourceTxHash} on chainKey ${submitted.value.receipt.chainKey.toString(10)}, emitter ${submitted.value.receipt.emitter}`,
  );
  console.error(
    "settle: the Watcher takes it from here; this Service records no clearing of its own, which is the requirement",
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        sourceTxHash: submitted.value.receipt.sourceTxHash,
        chainKey: submitted.value.receipt.chainKey.toString(10),
        expectedEmitter: submitted.value.hint.expectedEmitter,
        expectedEventSignature: submitted.value.hint.expectedEventSignature,
        expectedPayerTopic: submitted.value.hint.expectedPayerTopic,
        expectedCollectionTopic: submitted.value.hint.expectedCollectionTopic,
        amount: submitted.value.hint.amount.toString(10),
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

process.exitCode = await main();
