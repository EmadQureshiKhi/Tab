/**
 * Decoding one log into one row.
 *
 * The signature tests establish that the declarations match the contracts. These
 * establish that a log carrying those fields lands in the right columns, with the
 * right widths, and with nothing reinterpreted on the way:
 *
 * - the eleven fields of `SettlementRecorded` reach eleven distinct columns, with
 *   the payer kept apart from the Agent and the per-transaction log ordinal kept
 *   apart from the block-wide one;
 * - a `uint256` at its ceiling survives as an exact decimal string, because a
 *   settled amount through a float is a wrong number;
 * - a `uint64` too large for a JavaScript number stops the row instead of rounding;
 * - a log from a watched contract whose signature is not indexed is skipped rather
 *   than raised on;
 * - the five clearing states stay five, and the words match the Dashboard's table.
 *
 * Requirements: 12.6, 24.4
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { id } from "ethers";

import { CLEARING_STATES, CLEARING_STATE_EVENT, latestClearingState } from "../src/clearing.js";
import { enumMemberName } from "../src/enum-names.js";
import { REGISTRY_INTERFACE, decodeLog, type IndexedEventName, type RawLog } from "../src/events.js";
import { toTypedInsert } from "../src/rows.js";

const AGENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const ASSET = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SERVICE_ID = `0x${"11".repeat(32)}`;
const REPLAY_KEY = `0x${"22".repeat(32)}`;
const TAB_ID = `0x${"33".repeat(32)}`;
const SOURCE_TX = `0x${"44".repeat(32)}`;
const BLOCK_HASH = `0x${"ab".repeat(32)}`;
const TX_HASH = `0x${"cd".repeat(32)}`;

const UINT256_MAX = (1n << 256n) - 1n;

/** Builds a log exactly as the chain would deliver it, by encoding the event. */
function encodeLog(
  name: IndexedEventName,
  values: readonly unknown[],
  overrides: Partial<RawLog> = {},
): RawLog {
  const fragment = REGISTRY_INTERFACE.getEvent(name);
  assert.notEqual(fragment, null);
  const encoded = REGISTRY_INTERFACE.encodeEventLog(fragment!, [...values]);
  return {
    blockNumber: 5_407_400,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    transactionIndex: 3,
    index: 7,
    address: "0xc5c83782f315b321cd8e18b4c2e05df4050c3854",
    topics: encoded.topics,
    data: encoded.data,
    ...overrides,
  };
}

test("SettlementRecorded reaches eleven distinct columns", () => {
  const log = encodeLog("SettlementRecorded", [
    REPLAY_KEY,
    3n, // chainKey
    21_044_901n, // blockHeight, on the Source Chain
    12n, // txIndex, within that block
    2n, // logIndex, within that transaction's own receipt logs
    AGENT,
    SERVICE_ID,
    ASSET,
    5_000_000n,
    PAYER,
    TAB_ID,
  ]);

  const decoded = decodeLog(log);
  assert.notEqual(decoded, null);
  const insert = toTypedInsert(decoded!);
  assert.equal(insert.event, "SettlementRecorded");

  assert.deepEqual(insert.values, {
    // The envelope: where this log sits on Creditcoin.
    blockHash: BLOCK_HASH,
    logIndex: 7,
    // The Settlement's own coordinates, on the Source Chain.
    replayKey: REPLAY_KEY,
    chainKey: 3,
    sourceBlockHeight: 21_044_901,
    sourceTxIndex: 12,
    sourceLogIndex: 2,
    agent: AGENT,
    serviceId: SERVICE_ID,
    asset: ASSET,
    amount: "5000000",
    payerAddress: PAYER,
    sourceTabId: TAB_ID,
  });

  // The two ordinals are different facts and must not be conflated: 7 is the
  // block-wide ordinal on Creditcoin, 2 is the ordinal within the proved
  // transaction's own receipt logs on the Source Chain.
  assert.notEqual(insert.values.logIndex, insert.values.sourceLogIndex);
  // The payer is the Source Chain address from topics[1]; the Agent is who it is
  // bound to. Keeping both is what lets a reader check the binding.
  assert.notEqual(insert.values.agent, insert.values.payerAddress);
});

test("a uint256 at its ceiling survives as an exact decimal string", () => {
  const log = encodeLog("SettlementRecorded", [
    REPLAY_KEY,
    3n,
    1n,
    0n,
    0n,
    AGENT,
    SERVICE_ID,
    ASSET,
    UINT256_MAX,
    PAYER,
    TAB_ID,
  ]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.values.amount, UINT256_MAX.toString());
  assert.equal(BigInt(insert.values.amount as string), UINT256_MAX);
});

test("a uint64 beyond the safe-integer range stops the row instead of rounding", () => {
  const beyond = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const log = encodeLog("SettlementRecorded", [
    REPLAY_KEY,
    3n,
    beyond,
    0n,
    0n,
    AGENT,
    SERVICE_ID,
    ASSET,
    1n,
    PAYER,
    TAB_ID,
  ]);
  assert.throws(() => toTypedInsert(decodeLog(log)!), /beyond the safe-integer range/);
});

test("SettlementApplied keeps the applied amount and the prepaid excess apart", () => {
  const log = encodeLog("SettlementApplied", [
    REPLAY_KEY,
    AGENT,
    SERVICE_ID,
    ASSET,
    4_000_000n,
    1_000_000n,
    0n,
  ]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.values.applied, "4000000");
  assert.equal(insert.values.toPrepaid, "1000000");
  assert.equal(insert.values.openAfter, "0");
});

test("a prepaid draw keeps the balance left apart from the amount borrowed", () => {
  // The delivery cost 10_000, the tab held 202_000, so nothing was borrowed and the
  // balance fell to 192_000. All three are the same uint128 width and must not be
  // conflated: `consumed` is what left the balance, `prepaidAfter` is what remains,
  // and `openAdded` is what the Open Tab took instead.
  const log = encodeLog("PrepaidConsumed", [AGENT, SERVICE_ID, ASSET, 10_000n, 192_000n, 0n]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.event, "PrepaidConsumed");
  assert.deepEqual(insert.values, {
    blockHash: BLOCK_HASH,
    logIndex: 7,
    agent: AGENT,
    serviceId: SERVICE_ID,
    asset: ASSET,
    consumed: "10000",
    prepaidAfter: "192000",
    openAdded: "0",
  });
});

test("a draw that exhausts the balance records the borrowed remainder", () => {
  // 210_000 charged against a 202_000 balance: the balance is emptied and the
  // remaining 8_000 is borrowed. A reader that took `consumed` for the charge would
  // understate the delivery by exactly `openAdded`.
  const log = encodeLog("PrepaidConsumed", [AGENT, SERVICE_ID, ASSET, 202_000n, 0n, 8_000n]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.values.consumed, "202000");
  assert.equal(insert.values.prepaidAfter, "0");
  assert.equal(insert.values.openAdded, "8000");
  // Zero left is a fact, not a missing value, and it is the moment the tab stopped
  // being self-funding.
  assert.equal(BigInt(insert.values.consumed as string) + BigInt(insert.values.openAdded as string), 210_000n);
});

test("a uint128 at its ceiling survives as an exact decimal string", () => {
  const ceiling = (1n << 128n) - 1n;
  const log = encodeLog("PrepaidConsumed", [AGENT, SERVICE_ID, ASSET, ceiling, 0n, 0n]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(BigInt(insert.values.consumed as string), ceiling);
});

test("a declined clearing records the shortfall and claims no clearing identity", () => {
  const log = encodeLog("ProvisionalClearingDeclined", [
    AGENT,
    SERVICE_ID,
    ASSET,
    9_000_000n,
    SOURCE_TX,
    2_500_000n,
  ]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.event, "ProvisionalClearingDeclined");
  assert.equal(insert.values.amount, "9000000");
  assert.equal(insert.values.freeBond, "2500000");
  // A decline creates no clearing, so there is no identity to store. Inventing one
  // would let a reader believe a clearing exists that the contract never made.
  assert.equal("clearingId" in insert.values, false);
});

test("a superseded settlement keeps both digests, including the zero one", () => {
  const log = encodeLog("SettlementSuperseded", [
    REPLAY_KEY,
    AGENT,
    SERVICE_ID,
    ASSET,
    7n,
    `0x${"ee".repeat(32)}`,
    `0x${"00".repeat(32)}`,
  ]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.values.observedDigest, `0x${"ee".repeat(32)}`);
  // Zero means the block has left the attested chain entirely, which is a fact, not
  // a missing value.
  assert.equal(insert.values.attestedDigest, `0x${"00".repeat(32)}`);
});

test("a timelocked change keeps its payload whole and names its kind", () => {
  const payload = "0xdeadbeef";
  const log = encodeLog("RegistryChangeQueued", [
    `0x${"55".repeat(32)}`,
    SERVICE_ID,
    1, // ChangeKind.Price
    payload,
    1_760_000_000n,
  ]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.values.changeKind, 1);
  assert.equal(insert.values.changeKindName, "Price");
  // Stored raw: decoding needs the kind, and a wrong guess would rewrite a price in
  // the read layer while the chain says something else.
  assert.equal(insert.values.payload, payload);
  assert.equal(insert.values.eta, 1_760_000_000);
});

test("an enumeration member this build does not know is stored, not dropped", () => {
  assert.equal(enumMemberName("ChangeKind", 0), "Tier");
  assert.equal(enumMemberName("ChangeKind", 4), "SettlementWindow");
  assert.equal(enumMemberName("ChangeKind", 9), "unknown(9)");
  const log = encodeLog("RegistryChangeApplied", [`0x${"55".repeat(32)}`, SERVICE_ID, 9, "0x"]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.values.changeKind, 9);
  assert.equal(insert.values.changeKindName, "unknown(9)");
});

test("a watched contract's unindexed event is skipped, not raised on", () => {
  // `DeliveryRecorded` is emitted by TabBook on every metered delivery and is not
  // part of this service's surface. It has to be a skip: the four watched contracts
  // emit more than this indexer stores, and one of those logs must never stop a tick.
  const log: RawLog = {
    blockNumber: 5_407_400,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    index: 0,
    address: "0x7974db23b02ba3c109994cc9337c1dbd900ac5ba",
    topics: [id("DeliveryRecorded(address,bytes32,address,bytes32,uint32,uint256,uint64)")],
    data: "0x",
  };
  assert.equal(decodeLog(log), null);
});

test("a zero-topic log is skipped", () => {
  const log: RawLog = {
    blockNumber: 5_407_400,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    index: 0,
    address: "0x7974db23b02ba3c109994cc9337c1dbd900ac5ba",
    topics: [],
    data: "0x",
  };
  assert.equal(decodeLog(log), null);
});

test("hex fields are stored lowercase whatever casing arrived", () => {
  const mixed = encodeLog("AddressBound", [AGENT.toUpperCase().replace("0X", "0x"), 3n, PAYER, REPLAY_KEY]);
  const insert = toTypedInsert(decodeLog(mixed)!);
  assert.equal(insert.values.agent, AGENT);
  assert.equal(insert.values.ethAddress, PAYER);
  assert.equal(insert.values.chainKey, 3);
});

// ------------------------------------------------------- clearing vocabulary

test("the clearing vocabulary matches the Dashboard's table exactly", () => {
  const dashboard = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "components", "custom-ui", "clearing-state.ts"),
    "utf8",
  );
  const declared = /export const CLEARING_STATES = \[([^\]]*)\]/.exec(dashboard);
  assert.notEqual(declared, null, "the Dashboard no longer declares CLEARING_STATES");
  const states = [...(declared?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((match) => match[1]);

  // One vocabulary, two workspaces. The contract-side name of the first state is
  // `Applied` and both of these say `Provisional`; that mapping is documented in the
  // Dashboard's table and this service agrees with it rather than inventing another.
  assert.deepEqual([...CLEARING_STATES], states);
  assert.equal(CLEARING_STATES.length, 5);
});

test("each clearing state names the event that produces it", () => {
  assert.deepEqual(CLEARING_STATE_EVENT, {
    provisional: "ProvisionalClearingApplied",
    confirmed: "ProvisionalClearingConfirmed",
    reversed: "ProvisionalClearingReversed",
    declined: "ProvisionalClearingDeclined",
    superseded: "SettlementSuperseded",
  });
});

test("a clearing's latest state follows the lifecycle, not the row order", () => {
  const provisional = { state: "provisional", blockNumber: 10, logIndex: 0 } as const;
  const confirmed = { state: "confirmed", blockNumber: 12, logIndex: 1 } as const;
  const superseded = { state: "superseded", blockNumber: 40, logIndex: 0 } as const;

  assert.equal(latestClearingState([]), null);
  assert.equal(latestClearingState([provisional])?.state, "provisional");
  // Order of presentation must not change the answer.
  assert.equal(latestClearingState([confirmed, provisional])?.state, "confirmed");
  assert.equal(latestClearingState([provisional, confirmed])?.state, "confirmed");
  // A reorganisation outranks the confirmation it took away.
  assert.equal(latestClearingState([confirmed, superseded])?.state, "superseded");
  assert.equal(latestClearingState([superseded, confirmed])?.state, "superseded");
});
