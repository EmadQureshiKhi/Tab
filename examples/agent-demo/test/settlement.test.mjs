/**
 * Naming one Settlement out of a receipt.
 *
 * Two mistakes this guards against, both of which produce a key that names the
 * wrong log or no log at all, and neither of which is visible in the output:
 * taking the block-wide `logIndex` instead of the log's position within its own
 * receipt, and picking the first of several Settlements in one transaction.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { locateSettlement } from "../dist/settlement.js";
import { receiptOrdinalOf } from "../dist/chain.js";

const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const COLLECTION = "0x952AcC70E6f54Ce87Dca963193A5957BCb27729e";
const RELAY = "0x623B7059c9E67C690594085D280d50449Eb7D1d9";
const SENDER = "0xA302940db97345c5aDAF8dA23Ff46Ae63613d728";
const TRANSFER = `0x${"dd".repeat(32)}`;

const CAST = {
  collectionAddress: COLLECTION,
  asset: { chainKey: 1n, address: USDC, decimals: 6, symbol: "USDC" },
};

const topic = (address) => `0x000000000000000000000000${address.slice(2).toLowerCase()}`;

const transferLog = (index, { from = RELAY, to = COLLECTION, address = USDC } = {}) => ({
  index,
  address,
  topics: [TRANSFER, topic(from), topic(to)],
});

const receiptOf = (logs, { blockNumber = 11_648_905, txIndex = 112 } = {}) => ({
  hash: `0x${"ab".repeat(32)}`,
  blockNumber,
  index: txIndex,
  from: SENDER,
  logs,
});

test("the replay key packs the log's ordinal within its own receipt", () => {
  // The one Settlement log sits at block-wide index 74, and is the second log of
  // its receipt. The key must carry 1, not 74.
  const located = locateSettlement(CAST, receiptOf([transferLog(73, { to: SENDER }), transferLog(74)]));
  assert.equal(located.ok, true);
  assert.equal(located.value.ordinal, 1);
  assert.equal(
    located.value.replayKey,
    "0x00000000000000010000000000b1bf8900000000000000700000000000000001",
  );
});

test("the payer comes from topics[1] and the sender from the receipt", () => {
  const located = locateSettlement(CAST, receiptOf([transferLog(0)]));
  assert.equal(located.value.payerTopic.toLowerCase(), RELAY.toLowerCase());
  assert.equal(located.value.sender, SENDER);
  assert.notEqual(located.value.payerTopic.toLowerCase(), located.value.sender.toLowerCase());
});

test("a receipt with no Transfer to the Collection Address settled nothing", () => {
  const refused = locateSettlement(CAST, receiptOf([transferLog(0, { to: SENDER })]));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "DEMO_NO_SETTLEMENT_LOG");
});

test("a Transfer of some other Asset to the Collection Address is not this Settlement", () => {
  const other = `0x${"99".repeat(20)}`;
  const refused = locateSettlement(CAST, receiptOf([transferLog(0, { address: other })]));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "DEMO_NO_SETTLEMENT_LOG");
});

test("two Settlements in one transaction are refused rather than guessed between", () => {
  const refused = locateSettlement(CAST, receiptOf([transferLog(0), transferLog(1)]));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "DEMO_MANY_SETTLEMENT_LOGS");
  assert.match(refused.error.message, /carried 2 Settlements/);
});

test("an empty receipt is refused by name rather than throwing", () => {
  const refused = locateSettlement(CAST, receiptOf([]));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "DEMO_NO_SETTLEMENT_LOG");
});

test("the ordinal is a position in the receipt, and an absent log is an error", () => {
  assert.equal(receiptOrdinalOf([{ index: 12 }, { index: 40 }], 40), 1);
  assert.equal(receiptOrdinalOf([{ index: 12 }], 12), 0);
  assert.throws(() => receiptOrdinalOf([{ index: 12 }], 40), /not in the receipt/);
});
