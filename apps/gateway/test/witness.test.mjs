/**
 * The witness builder, which is the piece `recordDelivery` refuses without.
 *
 * The fold is asserted against a root **the chain produced**, not one this code
 * produced. `0x1df3cbeb…9657c5` is what `TabBook.historyCommitment` reports for the
 * Agent bound by the first Verified Settlement, and the record below is the one
 * carried by that Settlement's `HistoryExtended` log, read back off Creditcoin. A
 * fold that drifts by one field stops matching it, which is the only check that
 * actually protects a caller from a paid-for revert.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWitness,
  commitmentOf,
  counterpartiesOf,
  foldRoot,
  recordFromLog,
  HISTORY_INTERFACE,
  ZERO_ROOT,
  checkOperatorKey,
} from "../dist/witness.js";

/** The record the chain folded, exactly as `HistoryExtended` carried it. */
const LIVE_RECORD = {
  serviceId: "0x7461622e70726f6f662d73657276696365000000000000000000000000000000",
  asset: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  amount: 101000n,
  settledAt: 1788680685n,
  firstDeliveryAt: 0n,
  chainKey: 1n,
  curated: false,
  bonded: false,
};

/** What `TabBook.historyCommitment` answers for that Agent and Asset. */
const LIVE_ROOT = "0x1df3cbeb826de17d7890c34ce476ddedf1d5c93b7c954e77eba14a603d9657c5";

const AGENT = "0x1f6f797edc2eecb02bd54009b805fb2e99f80542";

test("the fold reproduces the root the chain committed", () => {
  assert.equal(foldRoot(ZERO_ROOT, LIVE_RECORD), LIVE_ROOT);
  const commitment = commitmentOf([LIVE_RECORD]);
  assert.equal(commitment.root, LIVE_ROOT);
  assert.equal(commitment.count, 1);
});

test("an empty history commits to the zero root, which is not a missing answer", () => {
  // Zero and "unknown" are different claims. A fresh Agent genuinely has this root.
  assert.deepEqual(commitmentOf([]), { root: ZERO_ROOT, count: 0 });
});

test("changing any single field changes the root", () => {
  const fields = [
    ["amount", { ...LIVE_RECORD, amount: 101001n }],
    ["settledAt", { ...LIVE_RECORD, settledAt: 1788680686n }],
    ["firstDeliveryAt", { ...LIVE_RECORD, firstDeliveryAt: 1n }],
    ["chainKey", { ...LIVE_RECORD, chainKey: 3n }],
    ["curated", { ...LIVE_RECORD, curated: true }],
    ["bonded", { ...LIVE_RECORD, bonded: true }],
  ];
  for (const [name, mutated] of fields) {
    assert.notEqual(foldRoot(ZERO_ROOT, mutated), LIVE_ROOT, `${name} is not bound by the commitment`);
  }
});

test("a HistoryExtended log decodes to the record the chain folded", () => {
  const encoded = HISTORY_INTERFACE.encodeEventLog(HISTORY_INTERFACE.getEvent("HistoryExtended"), [
    AGENT,
    LIVE_RECORD.asset,
    LIVE_ROOT,
    1,
    [
      LIVE_RECORD.serviceId,
      LIVE_RECORD.asset,
      LIVE_RECORD.amount,
      LIVE_RECORD.settledAt,
      LIVE_RECORD.firstDeliveryAt,
      LIVE_RECORD.chainKey,
      LIVE_RECORD.curated,
      LIVE_RECORD.bonded,
    ],
  ]);
  const decoded = recordFromLog({ topics: encoded.topics, data: encoded.data, blockNumber: 1, logIndex: 0 });
  assert.equal(decoded.ok, true);
  assert.equal(decoded.value.count, 1);
  assert.deepEqual(decoded.value.record, LIVE_RECORD);
  assert.equal(foldRoot(ZERO_ROOT, decoded.value.record), LIVE_ROOT);
});

test("a log that is not a HistoryExtended is refused rather than misread", () => {
  const decoded = recordFromLog({ topics: [`0x${"11".repeat(32)}`], data: "0x", blockNumber: 1, logIndex: 0 });
  assert.equal(decoded.ok, false);
  assert.match(decoded.error.code, /HISTORY_LOG_(UNRECOGNISED|UNDECODABLE)/);
});

test("counterparties are distinct, scoped to the Asset, and in first-appearance order", () => {
  const other = "0x" + "ab".repeat(32);
  const otherAsset = "0x" + "cd".repeat(20);
  const history = [
    LIVE_RECORD,
    { ...LIVE_RECORD, serviceId: other },
    LIVE_RECORD,
    { ...LIVE_RECORD, asset: otherAsset, serviceId: "0x" + "ef".repeat(32) },
  ];
  const found = counterpartiesOf(history, LIVE_RECORD.asset);
  assert.deepEqual(found, [LIVE_RECORD.serviceId, other]);
});

/** A reader whose answers a test dictates, so every branch is reachable offline. */
function fakeReader({ logs = [], commitment, staked = 5_000_000n }) {
  return {
    historyLogs: async () => ({ ok: true, value: logs }),
    commitment: async () => ({ ok: true, value: commitment }),
    staked: async () => ({ ok: true, value: staked }),
  };
}

function liveLog(count = 1) {
  const encoded = HISTORY_INTERFACE.encodeEventLog(HISTORY_INTERFACE.getEvent("HistoryExtended"), [
    AGENT,
    LIVE_RECORD.asset,
    LIVE_ROOT,
    count,
    [
      LIVE_RECORD.serviceId,
      LIVE_RECORD.asset,
      LIVE_RECORD.amount,
      LIVE_RECORD.settledAt,
      LIVE_RECORD.firstDeliveryAt,
      LIVE_RECORD.chainKey,
      LIVE_RECORD.curated,
      LIVE_RECORD.bonded,
    ],
  ]);
  return { topics: encoded.topics, data: encoded.data, blockNumber: 100, logIndex: 0 };
}

test("a witness that folds to the chain's commitment is returned with its evidence", async () => {
  const built = await buildWitness(
    fakeReader({ logs: [liveLog()], commitment: { root: LIVE_ROOT, count: 1 } }),
    AGENT,
    LIVE_RECORD.asset,
  );
  assert.equal(built.ok, true);
  assert.equal(built.value.rebuilt.root, LIVE_ROOT);
  assert.equal(built.value.onChain.root, LIVE_ROOT);
  assert.equal(built.value.witness.history.length, 1);
  assert.deepEqual(built.value.witness.bonds, [
    { serviceId: LIVE_RECORD.serviceId, asset: LIVE_RECORD.asset, amount: 5_000_000n },
  ]);
});

test("a witness that does not fold is refused here rather than by a paid-for revert", async () => {
  const built = await buildWitness(
    // The chain reports a root over two records while only one log came back, which
    // is exactly what a missed log looks like.
    fakeReader({ logs: [liveLog()], commitment: { root: `0x${"22".repeat(32)}`, count: 2 } }),
    AGENT,
    LIVE_RECORD.asset,
  );
  assert.equal(built.ok, false);
  assert.equal(built.error.code, "WITNESS_COMMITMENT_MISMATCH");
  assert.equal(built.error.details.rebuiltCount, 1);
  assert.equal(built.error.details.onChainCount, 2);
});

test("logs are ordered by the count the contract assigned, not by arrival", async () => {
  // Two records, delivered in reverse. Only the contract's own ordering folds to a
  // root it would accept, so a builder that trusted arrival order would break here.
  const second = { ...LIVE_RECORD, amount: 5n, settledAt: 1788680999n };
  const expected = commitmentOf([LIVE_RECORD, second]);

  const encodeAt = (record, count) => {
    const encoded = HISTORY_INTERFACE.encodeEventLog(HISTORY_INTERFACE.getEvent("HistoryExtended"), [
      AGENT,
      record.asset,
      expected.root,
      count,
      [
        record.serviceId,
        record.asset,
        record.amount,
        record.settledAt,
        record.firstDeliveryAt,
        record.chainKey,
        record.curated,
        record.bonded,
      ],
    ]);
    return { topics: encoded.topics, data: encoded.data, blockNumber: count, logIndex: 0 };
  };

  const built = await buildWitness(
    fakeReader({ logs: [encodeAt(second, 2), encodeAt(LIVE_RECORD, 1)], commitment: expected }),
    AGENT,
    LIVE_RECORD.asset,
  );
  assert.equal(built.ok, true);
  assert.equal(built.value.witness.history[0].amount, LIVE_RECORD.amount);
  assert.equal(built.value.witness.history[1].amount, 5n);
});

test("a failing chain read is reported, never treated as an empty history", async () => {
  const built = await buildWitness(
    {
      historyLogs: async () => ({ ok: false, error: { category: "UPSTREAM", code: "CHAIN_READ_FAILED", message: "no", retryable: true } }),
      commitment: async () => ({ ok: true, value: { root: ZERO_ROOT, count: 0 } }),
      staked: async () => ({ ok: true, value: 0n }),
    },
    AGENT,
    LIVE_RECORD.asset,
  );
  assert.equal(built.ok, false);
  assert.equal(built.error.code, "CHAIN_READ_FAILED");
});

// ---------------------------------------------------------------- operator check

/**
 * The operator preflight.
 *
 * `_requireOperator` compares `msg.sender` against the registry's operator for exact
 * equality, and `ServiceRegistry` has no operator setter and no `Operator` change
 * kind, so the operator is fixed at registration. A Service's software either holds
 * that key or it can record nothing.
 *
 * The reason this is a startup check rather than a comment is that neither of the two
 * cheap ways of noticing works. A keyless simulation passes, because `eth_call` is
 * made with the operator address as `from`. And the broadcast fails only after gas has
 * been spent, with a revert that reads like a contract problem rather than a
 * configuration one.
 */
const SERVICE_ID = `0x${"7461622e70726f6f662d73657276696365".padEnd(64, "0")}`;
const OPERATOR = "0xe5eab26cae0855bccabbb9a64fafce28c8432b37";

const operatorReader = (answer) => ({
  async historyLogs() { throw new Error("unused"); },
  async commitment() { throw new Error("unused"); },
  async staked() { throw new Error("unused"); },
  async operatorOf() { return answer; },
});

test("the operator check passes when the key signs as the registered operator", async () => {
  const result = await checkOperatorKey(operatorReader({ ok: true, value: OPERATOR }), SERVICE_ID, OPERATOR);
  assert.equal(result.ok, true);
  assert.equal(result.value, OPERATOR);
});

test("the operator check is case-insensitive on the configured address", async () => {
  const checksummed = "0xE5eaB26CaE0855BcCaBBb9A64faFce28C8432b37";
  const result = await checkOperatorKey(operatorReader({ ok: true, value: OPERATOR }), SERVICE_ID, checksummed);
  assert.equal(result.ok, true, "a checksummed address is the same address");
});

test("the operator check names both addresses when the key is wrong", async () => {
  const wrong = "0x6db158320312778e3c4429472a4b7132d597ac38";
  const result = await checkOperatorKey(operatorReader({ ok: true, value: OPERATOR }), SERVICE_ID, wrong);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NOT_SERVICE_OPERATOR");
  assert.equal(result.error.category, "AUTHORISATION");
  assert.equal(result.error.retryable, false, "no amount of retrying makes a key the operator");
  assert.match(result.error.message, /0x6db158320312778e3c4429472a4b7132d597ac38/, "the configured signer is named");
  assert.match(result.error.message, /0xe5eab26cae0855bccabbb9a64fafce28c8432b37/, "the real operator is named");
  assert.equal(result.error.details.configured, wrong);
  assert.equal(result.error.details.operator, OPERATOR);
});

test("an unreadable registry is reported rather than treated as a pass", async () => {
  const failure = { ok: false, error: { category: "UPSTREAM", code: "SERVICE_OF_FAILED", message: "rpc down", retryable: true } };
  const result = await checkOperatorKey(operatorReader(failure), SERVICE_ID, OPERATOR);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SERVICE_OF_FAILED", "not knowing is not the same as agreeing");
});
