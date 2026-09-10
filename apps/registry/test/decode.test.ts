/**
 * Decoding and row shaping, against logs encoded from the same interface the
 * indexer decodes with.
 *
 * What is under test is the one place a chain fact is shaped for storage: that
 * every field reaches its own column under the contract's own name, that no
 * integer is narrowed silently, and that a log outside the surface is skipped
 * rather than raised on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { id } from "ethers";
import { ERC8004_EVENT_TOPIC0 } from "@tabai/shared";
import { enumMemberName } from "../src/enum-names.js";
import { decodeAgentWallet } from "../src/erc8004.js";
import { EVENT_OWNER, EVENT_TOPIC0, REGISTRY_INTERFACE, decodeLog, type IndexedEventName, type RawLog } from "../src/events.js";
import { toTypedInsert } from "../src/rows.js";

const AGENT = "0x1111111111111111111111111111111111111111";
const COLLECTION = "0x2222222222222222222222222222222222222222";
const ASSET = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const SERVICE_ID = `0x${"11".repeat(32)}`;
const SETTLEMENT_ID = `0x${"22".repeat(32)}`;
const TAB_ID = `0x${"33".repeat(32)}`;
const TOOL = `0x${"44".repeat(32)}`;
const BLOCK_HASH = `0x${"ab".repeat(32)}`;
const TX_HASH = `0x${"cd".repeat(32)}`;
const TAB_BOOK = "0xba86c0d053ba88afdecbed8aba5b2ec3973fb230";
const UINT256_MAX = (1n << 256n) - 1n;

function encodeLog(
  name: IndexedEventName,
  values: readonly unknown[],
  overrides: Partial<RawLog> = {},
): RawLog {
  const fragment = REGISTRY_INTERFACE.getEvent(name);
  assert.notEqual(fragment, null);
  const encoded = REGISTRY_INTERFACE.encodeEventLog(fragment!, [...values]);
  return {
    blockNumber: 64_000_000,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    transactionIndex: 3,
    index: 7,
    address: TAB_BOOK,
    topics: encoded.topics,
    data: encoded.data,
    ...overrides,
  };
}

test("Settled reaches eight distinct columns", () => {
  const log = encodeLog("Settled", [
    SETTLEMENT_ID,
    AGENT,
    SERVICE_ID,
    ASSET,
    5_000_000n,
    4_000_000n,
    1_000_000n,
    COLLECTION,
  ]);
  const decoded = decodeLog(log);
  assert.notEqual(decoded, null);
  const insert = toTypedInsert(decoded!);
  assert.equal(insert.event, "Settled");
  assert.deepEqual(insert.values, {
    blockHash: BLOCK_HASH,
    logIndex: 7,
    settlementId: SETTLEMENT_ID,
    agent: AGENT,
    serviceId: SERVICE_ID,
    asset: ASSET,
    amount: "5000000",
    applied: "4000000",
    toPrepaid: "1000000",
    collection: COLLECTION,
  });
  // The amount paid is what fell off the tab plus what was banked, and a reader that
  // took `applied` for the payment would understate it by exactly `toPrepaid`.
  assert.equal(
    BigInt(insert.values.applied as string) + BigInt(insert.values.toPrepaid as string),
    BigInt(insert.values.amount as string),
  );
});

test("DeliveryRecorded keeps units and the charge apart", () => {
  const log = encodeLog("DeliveryRecorded", [AGENT, SERVICE_ID, ASSET, TOOL, 3n, 3_000n, 1_790_000_000n]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.event, "DeliveryRecorded");
  assert.deepEqual(insert.values, {
    blockHash: BLOCK_HASH,
    logIndex: 7,
    agent: AGENT,
    serviceId: SERVICE_ID,
    asset: ASSET,
    tool: TOOL,
    units: 3,
    amount: "3000",
    timestamp: 1_790_000_000,
  });
});

test("a uint256 at its ceiling survives as an exact decimal string", () => {
  const log = encodeLog("DeliveryRecorded", [AGENT, SERVICE_ID, ASSET, TOOL, 1n, UINT256_MAX, 1n]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.values.amount, UINT256_MAX.toString());
  assert.equal(BigInt(insert.values.amount as string), UINT256_MAX);
});

test("a uint64 beyond the safe-integer range stops the row instead of rounding", () => {
  const beyond = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const log = encodeLog("DeliveryRecorded", [AGENT, SERVICE_ID, ASSET, TOOL, 1n, 1n, beyond]);
  assert.throws(() => toTypedInsert(decodeLog(log)!), /beyond the safe-integer range/);
});

test("SettlementApplied keeps the applied amount and the prepaid excess apart", () => {
  const log = encodeLog("SettlementApplied", [
    SETTLEMENT_ID,
    AGENT,
    SERVICE_ID,
    ASSET,
    4_000_000n,
    1_000_000n,
    0n,
  ]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.values.settlementId, SETTLEMENT_ID);
  assert.equal(insert.values.applied, "4000000");
  assert.equal(insert.values.toPrepaid, "1000000");
  assert.equal(insert.values.openAfter, "0");
});

test("HistoryExtended flattens the committed record into its own columns", () => {
  const log = encodeLog("HistoryExtended", [
    AGENT,
    ASSET,
    `0x${"77".repeat(32)}`,
    2n,
    [SERVICE_ID, ASSET, 4_000_000n, 1_790_000_000n, 1_789_990_000n, true, true],
  ]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.event, "HistoryExtended");
  assert.deepEqual(insert.values, {
    blockHash: BLOCK_HASH,
    logIndex: 7,
    agent: AGENT,
    asset: ASSET,
    root: `0x${"77".repeat(32)}`,
    count: 2,
    recordServiceId: SERVICE_ID,
    recordAsset: ASSET,
    recordAmount: "4000000",
    recordSettledAt: 1_790_000_000,
    recordFirstDeliveryAt: 1_789_990_000,
    recordCurated: true,
    recordBonded: true,
  });
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
  const log = encodeLog("PrepaidConsumed", [AGENT, SERVICE_ID, ASSET, 202_000n, 0n, 8_000n]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.values.consumed, "202000");
  assert.equal(insert.values.prepaidAfter, "0");
  assert.equal(insert.values.openAdded, "8000");
  assert.equal(BigInt(insert.values.consumed as string) + BigInt(insert.values.openAdded as string), 210_000n);
});

test("a uint128 at its ceiling survives as an exact decimal string", () => {
  const ceiling = (1n << 128n) - 1n;
  const log = encodeLog("PrepaidConsumed", [AGENT, SERVICE_ID, ASSET, ceiling, 0n, 0n]);
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(BigInt(insert.values.consumed as string), ceiling);
});

test("a delinquency and its clearing are two rows under one tab identity", () => {
  const declared = toTypedInsert(
    decodeLog(encodeLog("TabDelinquent", [TAB_ID, AGENT, SERVICE_ID, ASSET, 3_000n, 1_790_021_600n]))!,
  );
  assert.equal(declared.event, "TabDelinquent");
  assert.equal(declared.values.tabId, TAB_ID);
  assert.equal(declared.values.unsettled, "3000");
  assert.equal(declared.values.windowEnd, 1_790_021_600);
  const cleared = toTypedInsert(decodeLog(encodeLog("TabDelinquencyCleared", [TAB_ID, AGENT, ASSET]))!);
  assert.equal(cleared.event, "TabDelinquencyCleared");
  assert.equal(cleared.values.tabId, TAB_ID);
});

test("the Bond escrow's two movements land in their own tables", () => {
  const party = `0x${"00".repeat(12)}${AGENT.slice(2)}`;
  const funded = toTypedInsert(decodeLog(encodeLog("BondFunded", [party, ASSET, 10_000_000n, AGENT]))!);
  assert.equal(funded.event, "BondFunded");
  assert.deepEqual(funded.values, {
    blockHash: BLOCK_HASH,
    logIndex: 7,
    party,
    asset: ASSET,
    amount: "10000000",
    depositor: AGENT,
  });
  const withdrawn = toTypedInsert(decodeLog(encodeLog("BondWithdrawn", [party, ASSET, 4_000_000n, AGENT]))!);
  assert.equal(withdrawn.event, "BondWithdrawn");
  assert.equal(withdrawn.values.amount, "4000000");
  assert.equal(withdrawn.values.recipient, AGENT);
});

test("a Service's payout address is recorded per Asset", () => {
  const insert = toTypedInsert(decodeLog(encodeLog("CollectionRegistered", [SERVICE_ID, ASSET, COLLECTION]))!);
  assert.equal(insert.event, "CollectionRegistered");
  assert.deepEqual(insert.values, {
    blockHash: BLOCK_HASH,
    logIndex: 7,
    serviceId: SERVICE_ID,
    asset: ASSET,
    collection: COLLECTION,
  });
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
  // `SettlementSurfaceWired` fires once at deployment and is not part of this
  // service's surface. It has to be a skip: the watched contracts emit more than
  // this indexer stores, and one of those logs must never stop a tick.
  const log: RawLog = {
    blockNumber: 64_000_000,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    index: 0,
    address: TAB_BOOK,
    topics: [id("SettlementSurfaceWired(address)")],
    data: "0x",
  };
  assert.equal(decodeLog(log), null);
});

test("a zero-topic log is skipped", () => {
  const log: RawLog = {
    blockNumber: 64_000_000,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    index: 0,
    address: TAB_BOOK,
    topics: [],
    data: "0x",
  };
  assert.equal(decodeLog(log), null);
});

test("hex fields are stored lowercase whatever casing arrived", () => {
  const mixed = encodeLog("AuthorisationSet", [
    AGENT.toUpperCase().replace("0X", "0x"),
    SERVICE_ID,
    ASSET.toUpperCase().replace("0X", "0x"),
    1_000_000n,
    1_790_000_000n,
  ]);
  const insert = toTypedInsert(decodeLog(mixed)!);
  assert.equal(insert.values.agent, AGENT);
  assert.equal(insert.values.asset, ASSET);
});

// ------------------------------------------------------------------ ERC-8004 identity

const IDENTITY_REGISTRY = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const ZERO = `0x${"00".repeat(20)}`;
const UINT256_AGENT_ID = (1n << 255n) + 7n;

test("Transfer stores from, to and the token id at its full width", () => {
  const log = encodeLog("Transfer", [ZERO, AGENT, UINT256_AGENT_ID], { address: IDENTITY_REGISTRY });
  const decoded = decodeLog(log);
  assert.notEqual(decoded, null);
  const insert = toTypedInsert(decoded!);
  assert.equal(insert.event, "Transfer");
  assert.deepEqual(insert.values, {
    blockHash: BLOCK_HASH,
    logIndex: 7,
    sender: ZERO,
    recipient: AGENT,
    agentId: UINT256_AGENT_ID.toString(),
  });
});

test("Registered keeps the agent URI exactly as emitted, casing and all", () => {
  const uri = "https://Example.com/Agents/7.json?Q=A";
  const insert = toTypedInsert(decodeLog(encodeLog("Registered", [7n, uri, AGENT], { address: IDENTITY_REGISTRY }))!);
  assert.equal(insert.event, "Registered");
  assert.deepEqual(insert.values, { blockHash: BLOCK_HASH, logIndex: 7, agentId: "7", agentUri: uri, owner: AGENT });
});

test("an empty Registered URI, from the URI-less register(), is stored as the empty string", () => {
  const insert = toTypedInsert(decodeLog(encodeLog("Registered", [0n, "", AGENT], { address: IDENTITY_REGISTRY }))!);
  assert.equal(insert.values.agentUri, "");
});

test("MetadataSet stores the indexed key as its hash, the plain key, and the packed wallet", () => {
  const log = encodeLog("MetadataSet", [7n, "agentWallet", "agentWallet", AGENT], { address: IDENTITY_REGISTRY });
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.event, "MetadataSet");
  assert.deepEqual(insert.values, {
    blockHash: BLOCK_HASH,
    logIndex: 7,
    agentId: "7",
    // An indexed string reaches the log only as keccak256 of its bytes.
    metadataKeyHash: id("agentWallet"),
    metadataKey: "agentWallet",
    // `abi.encodePacked(address)` is the twenty bytes, which the view reads back as an address.
    metadataValue: AGENT,
  });
});

test("a cleared agentWallet is an empty bytes value, which decodes to no wallet", () => {
  const log = encodeLog("MetadataSet", [7n, "agentWallet", "agentWallet", "0x"], { address: IDENTITY_REGISTRY });
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.values.metadataValue, "0x");
  assert.equal(decodeAgentWallet(insert.values.metadataValue as string), null);
  assert.equal(decodeAgentWallet(AGENT), AGENT);
  // Anything that is not exactly twenty bytes is not a wallet, whatever key it was written under.
  assert.equal(decodeAgentWallet(`0x${"ab".repeat(32)}`), null);
});

test("URIUpdated stores the new URI and who set it", () => {
  const log = encodeLog("URIUpdated", [7n, "ipfs://bafyexample", AGENT], { address: IDENTITY_REGISTRY });
  const insert = toTypedInsert(decodeLog(log)!);
  assert.equal(insert.event, "URIUpdated");
  assert.deepEqual(insert.values, {
    blockHash: BLOCK_HASH,
    logIndex: 7,
    agentId: "7",
    newUri: "ipfs://bafyexample",
    updatedBy: AGENT,
  });
});

test("the identity events file under the IdentityRegistry owner and carry the canonical topics", () => {
  for (const name of ["Transfer", "Registered", "MetadataSet", "URIUpdated"] as const) {
    assert.equal(EVENT_OWNER[name], "IdentityRegistry");
  }
  assert.equal(EVENT_TOPIC0.Transfer, id("Transfer(address,address,uint256)"));
  assert.equal(EVENT_TOPIC0.Registered, id("Registered(uint256,string,address)"));
  assert.equal(EVENT_TOPIC0.MetadataSet, id("MetadataSet(uint256,string,string,bytes)"));
  assert.equal(EVENT_TOPIC0.URIUpdated, id("URIUpdated(uint256,string,address)"));
  // And the same topics the shared package pins, so the two declarations cannot drift.
  assert.equal(EVENT_TOPIC0.Registered, ERC8004_EVENT_TOPIC0.Registered);
  assert.equal(EVENT_TOPIC0.MetadataSet, ERC8004_EVENT_TOPIC0.MetadataSet);
  assert.equal(EVENT_TOPIC0.URIUpdated, ERC8004_EVENT_TOPIC0.URIUpdated);
});
