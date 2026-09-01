/**
 * The Ethereum USDC strategy: both Settlement surfaces, the batch form, and the
 * hint each one produces.
 *
 * The calldata is decoded rather than compared to a recorded blob, so a wrong
 * argument order fails here instead of on chain. The addresses are the deployed
 * ones a deployment once used, kept as realistic fixtures rather than in step with
 * `deployments.json`; no transaction is broadcast, because the signer is
 * a recorder.
 *
 * Requirements: 23.1, 23.7
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface } from "ethers";
import { eventTopic0 } from "@tabai/shared";
import { createEthereumUsdcStrategy } from "../dist/index.js";

const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TAB_SETTLEMENT = "0x10619F16E1ac73AAe41AA4C1619f1387687EED79";
const COLLECTION = "0x952AcC70E6f54Ce87Dca963193A5957BCb27729e";
const AGENT = "0xE5eaB26CaE0855BcCaBBb9A64faFce28C8432b37";
const PAYER = "0x621663045265405B65d2afD1c22bC7254f8E1dec";
const SERVICE_ID = "0x7461622e70726f6f662d73657276696365000000000000000000000000000000";
const TAB_ID = `0x${"11".repeat(32)}`;
const OTHER_TAB_ID = `0x${"22".repeat(32)}`;

/** The canonical ERC-20 `transfer` selector, pinned independently of this package. */
const TRANSFER_SELECTOR = "0xa9059cbb";
/** `keccak256("Transfer(address,address,uint256)")`, the same. */
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const erc20 = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const settlement = new Interface([
  "function settle((address asset, address serviceCollection, uint256 amount, bytes32 tabId) instruction)",
  "function settleBatch((address asset, address serviceCollection, uint256 amount, bytes32 tabId)[] instructions)",
]);

const sepoliaAsset = { chainKey: 1n, address: SEPOLIA_USDC, decimals: 6, symbol: "USDC" };
const mainnetAsset = { chainKey: 3n, address: MAINNET_USDC, decimals: 6, symbol: "USDC" };

function recordingSigner({ allowance = 0n } = {}) {
  const sent = [];
  return {
    sent,
    getAddress: async () => PAYER,
    sendTransaction: async (transaction) => {
      sent.push(transaction);
      return { hash: `0x${sent.length.toString(16).padStart(64, "0")}` };
    },
    provider: {
      call: async () => `0x${allowance.toString(16).padStart(64, "0")}`,
    },
  };
}

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const settleRequest = (overrides = {}) => ({
  agent: AGENT,
  serviceId: SERVICE_ID,
  asset: sepoliaAsset,
  amount: 10_000n,
  collectionAddress: COLLECTION,
  tabId: TAB_ID,
  mode: "settlement-contract",
  ...overrides,
});

test("the configured assets fix chainKeys, supports(), and the quote", async () => {
  const strategy = createEthereumUsdcStrategy({
    signer: recordingSigner(),
    assets: { "1:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": sepoliaAsset, mainnet: mainnetAsset },
    logger: silent,
    now: () => 1_700_000_000_000,
  });

  assert.equal(strategy.id, "ethereum-usdc");
  assert.deepEqual(strategy.chainKeys, [1n, 3n]);
  // Checksummed in the config, lower-case in the request: still one Asset.
  assert.equal(strategy.supports({ ...sepoliaAsset, address: SEPOLIA_USDC.toLowerCase() }), true);
  assert.equal(strategy.supports({ ...sepoliaAsset, chainKey: 9n }), false);

  const quote = await strategy.quote({
    agent: AGENT,
    serviceId: SERVICE_ID,
    asset: sepoliaAsset,
    amount: 10_000n,
  });
  assert.equal(quote.ok, true);
  assert.equal(quote.value.amount, 10_000n);
  assert.match(quote.value.feeNote, /base units/);

  const zero = await strategy.quote({ agent: AGENT, serviceId: SERVICE_ID, asset: sepoliaAsset, amount: 0n });
  assert.equal(zero.ok, false);
  assert.equal(zero.error.code, "AMOUNT_NOT_POSITIVE");

  const unknown = await strategy.quote({
    agent: AGENT,
    serviceId: SERVICE_ID,
    asset: { ...sepoliaAsset, address: `0x${"ab".repeat(20)}` },
    amount: 1n,
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "ASSET_NOT_CONFIGURED");
});

test("direct-transfer settles through the asset itself and hints at the Transfer log", async () => {
  const signer = recordingSigner();
  const strategy = createEthereumUsdcStrategy({
    signer,
    assets: { "3:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": mainnetAsset },
    logger: silent,
    now: () => 1_700_000_000_000,
  });

  const receipt = await strategy.settle(
    settleRequest({ asset: mainnetAsset, mode: "direct-transfer", amount: 2_500_000n }),
  );
  assert.equal(receipt.ok, true);

  // One transaction, to the token, and no allowance call: Tab deploys nothing here.
  assert.equal(signer.sent.length, 1);
  assert.equal(signer.sent[0].to, MAINNET_USDC);
  assert.equal(signer.sent[0].data.slice(0, 10), TRANSFER_SELECTOR);
  const [to, amount] = erc20.decodeFunctionData("transfer", signer.sent[0].data);
  assert.equal(to, COLLECTION);
  assert.equal(amount, 2_500_000n);

  assert.equal(receipt.value.chainKey, 3n);
  assert.equal(receipt.value.emitter, MAINNET_USDC);
  assert.equal(receipt.value.payerAddress, PAYER);
  assert.equal(receipt.value.submittedAt, 1_700_000_000_000);
  assert.equal(typeof receipt.value.amount, "bigint");

  const hint = strategy.watchHint(receipt.value);
  assert.equal(hint.expectedEventSignature, TRANSFER_TOPIC0);
  assert.equal(hint.expectedEmitter, MAINNET_USDC);
  assert.equal(hint.expectedPayerTopic, `0x${PAYER.slice(2).toLowerCase().padStart(64, "0")}`);
  assert.equal(hint.expectedCollectionTopic, `0x${COLLECTION.slice(2).toLowerCase().padStart(64, "0")}`);
  // A plain Transfer carries no tabId, so the hint claims none.
  assert.equal("expectedTabIdTopic" in hint, false);
});

test("settlement-contract tops the allowance up, then settles, and hints at the TabSettled log", async () => {
  const signer = recordingSigner({ allowance: 0n });
  const strategy = createEthereumUsdcStrategy({
    signer,
    settlementContract: TAB_SETTLEMENT,
    assets: { "1:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": sepoliaAsset },
    logger: silent,
  });

  const receipt = await strategy.settle(settleRequest());
  assert.equal(receipt.ok, true);
  assert.equal(signer.sent.length, 2);

  const [spender, approved] = erc20.decodeFunctionData("approve", signer.sent[0].data);
  assert.equal(signer.sent[0].to, SEPOLIA_USDC);
  assert.equal(spender, TAB_SETTLEMENT);
  assert.equal(approved, 10_000n);

  assert.equal(signer.sent[1].to, TAB_SETTLEMENT);
  const [instruction] = settlement.decodeFunctionData("settle", signer.sent[1].data);
  assert.equal(instruction[0], SEPOLIA_USDC);
  assert.equal(instruction[1], COLLECTION);
  assert.equal(instruction[2], 10_000n);
  assert.equal(instruction[3], TAB_ID);

  const hint = strategy.watchHint(receipt.value);
  assert.equal(hint.expectedEventSignature, eventTopic0("TabSettled"));
  assert.equal(hint.expectedEmitter, TAB_SETTLEMENT);
  assert.equal(hint.expectedPayerTopic, `0x${PAYER.slice(2).toLowerCase().padStart(64, "0")}`);
  assert.equal(hint.expectedCollectionTopic, `0x${COLLECTION.slice(2).toLowerCase().padStart(64, "0")}`);
  assert.equal(hint.expectedTabIdTopic, TAB_ID);
});

test("a sufficient allowance is left alone", async () => {
  const signer = recordingSigner({ allowance: 1_000_000n });
  const strategy = createEthereumUsdcStrategy({
    signer,
    settlementContract: TAB_SETTLEMENT,
    assets: { "1:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": sepoliaAsset },
    logger: silent,
  });

  assert.equal((await strategy.settle(settleRequest())).ok, true);
  assert.equal(signer.sent.length, 1);
  assert.equal(signer.sent[0].to, TAB_SETTLEMENT);
});

test("settlement-contract without a contract address is a VALIDATION result, not a throw", async () => {
  const signer = recordingSigner();
  const strategy = createEthereumUsdcStrategy({
    signer,
    assets: { "1:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": sepoliaAsset },
    logger: silent,
  });

  const outcome = await strategy.settle(settleRequest());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "SETTLEMENT_CONTRACT_REQUIRED");
  assert.equal(signer.sent.length, 0);
});

test("a batch is one transaction, one receipt per settlement, each hint distinguishable", async () => {
  const signer = recordingSigner({ allowance: 0n });
  const strategy = createEthereumUsdcStrategy({
    signer,
    settlementContract: TAB_SETTLEMENT,
    assets: { "1:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": sepoliaAsset },
    logger: silent,
  });

  const batch = await strategy.settleBatch([
    settleRequest({ amount: 10_000n }),
    settleRequest({ amount: 25_000n, tabId: OTHER_TAB_ID }),
  ]);
  assert.equal(batch.ok, true);
  assert.equal(batch.value.length, 2);

  // One allowance top-up for the total the Asset owes, then one settleBatch.
  assert.equal(signer.sent.length, 2);
  const [, approved] = erc20.decodeFunctionData("approve", signer.sent[0].data);
  assert.equal(approved, 35_000n);

  const [instructions] = settlement.decodeFunctionData("settleBatch", signer.sent[1].data);
  assert.equal(instructions.length, 2);
  assert.equal(instructions[0][2], 10_000n);
  assert.equal(instructions[1][3], OTHER_TAB_ID);

  // The transaction hash is shared, so it cannot be the identity; the tabId topic
  // is what tells the two logs of one transaction apart.
  assert.equal(batch.value[0].sourceTxHash, batch.value[1].sourceTxHash);
  assert.deepEqual([batch.value[0].batchIndex, batch.value[1].batchIndex], [0, 1]);
  assert.notEqual(
    strategy.watchHint(batch.value[0]).expectedTabIdTopic,
    strategy.watchHint(batch.value[1]).expectedTabIdTopic,
  );
});

test("a batch naming direct-transfer is refused, because a plain Transfer has no batch form", async () => {
  const signer = recordingSigner();
  const strategy = createEthereumUsdcStrategy({
    signer,
    settlementContract: TAB_SETTLEMENT,
    assets: {
      "1:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": sepoliaAsset,
      "3:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": mainnetAsset,
    },
    logger: silent,
  });

  const mixedMode = await strategy.settleBatch([
    settleRequest(),
    settleRequest({ asset: mainnetAsset, mode: "direct-transfer" }),
  ]);
  assert.equal(mixedMode.ok, false);
  assert.equal(mixedMode.error.code, "BATCH_MODE_UNSUPPORTED");

  const empty = await strategy.settleBatch([]);
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, "EMPTY_BATCH");
  assert.equal(signer.sent.length, 0);
});

test("a signer with no provider cannot read an allowance and says so", async () => {
  const strategy = createEthereumUsdcStrategy({
    signer: { getAddress: async () => PAYER, sendTransaction: async () => ({ hash: `0x${"0".repeat(64)}` }) },
    settlementContract: TAB_SETTLEMENT,
    assets: { "1:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": sepoliaAsset },
    logger: silent,
  });

  const outcome = await strategy.settle(settleRequest());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "PROVIDER_REQUIRED");

  const skipping = createEthereumUsdcStrategy({
    signer: { getAddress: async () => PAYER, sendTransaction: async () => ({ hash: `0x${"0".repeat(64)}` }) },
    settlementContract: TAB_SETTLEMENT,
    assets: { "1:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": sepoliaAsset },
    allowanceCheck: "skip",
    logger: silent,
  });
  assert.equal((await skipping.settle(settleRequest())).ok, true);
});

test("a failing signer becomes a retryable CHAIN result rather than a rejected promise", async () => {
  const strategy = createEthereumUsdcStrategy({
    signer: {
      getAddress: async () => PAYER,
      sendTransaction: async () => {
        throw new Error("insufficient funds for gas");
      },
      provider: { call: async () => `0x${"f".repeat(64)}` },
    },
    settlementContract: TAB_SETTLEMENT,
    assets: { "1:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": sepoliaAsset },
    logger: silent,
  });

  const outcome = await strategy.settle(settleRequest());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.category, "CHAIN");
  assert.equal(outcome.error.retryable, true);
  assert.match(outcome.error.cause.message, /insufficient funds/);
});
