/**
 * The re-expressed witness builder, checked against the chain's own answer.
 *
 * The fold is asserted against a root **the chain produced**, not one this code
 * produced. `0x1df3cbeb…9657c5` is what `TabBook.historyCommitment` reports for the
 * Agent bound by the first Verified Settlement, and the record below is the one
 * carried by that Settlement's `HistoryExtended` log. That is what makes this a
 * re-expression rather than a second implementation: the copy and the original both
 * reproduce the contract's own commitment, so a drift in either is a failing test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWitness,
  commitmentOf,
  counterpartiesOf,
  foldRoot,
  growWindow,
  isNarrowable,
  recordFromLog,
  shrinkWindow,
  HISTORY_CHUNK_MAX,
  HISTORY_CHUNK_MIN,
  HISTORY_INTERFACE,
  MAX_COUNTERPARTIES,
  MAX_HISTORY,
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

const logFor = (record, count) => {
  const encoded = HISTORY_INTERFACE.encodeEventLog(HISTORY_INTERFACE.getEvent("HistoryExtended"), [
    AGENT,
    record.asset,
    ZERO_ROOT,
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

const readerFor = (logs, commitment, staked = 5_000_000n) => ({
  historyLogs: async () => ({ ok: true, value: logs }),
  commitment: async () => ({ ok: true, value: commitment }),
  staked: async () => ({ ok: true, value: staked }),
});

test("the re-expressed fold reproduces the root the chain committed", () => {
  assert.equal(foldRoot(ZERO_ROOT, LIVE_RECORD), LIVE_ROOT);
  assert.deepEqual(commitmentOf([LIVE_RECORD]), { root: LIVE_ROOT, count: 1 });
});

test("an empty history commits to the zero root, which is not a missing answer", () => {
  assert.deepEqual(commitmentOf([]), { root: ZERO_ROOT, count: 0 });
});

test("every field of the record is bound by the commitment", () => {
  const mutations = [
    ["amount", { ...LIVE_RECORD, amount: 101001n }],
    ["settledAt", { ...LIVE_RECORD, settledAt: 1788680686n }],
    ["firstDeliveryAt", { ...LIVE_RECORD, firstDeliveryAt: 1n }],
    ["chainKey", { ...LIVE_RECORD, chainKey: 3n }],
    ["curated", { ...LIVE_RECORD, curated: true }],
    ["bonded", { ...LIVE_RECORD, bonded: true }],
  ];
  for (const [name, mutated] of mutations) {
    assert.notEqual(foldRoot(ZERO_ROOT, mutated), LIVE_ROOT, `${name} is not bound by the commitment`);
  }
});

test("a HistoryExtended log decodes to the record the chain folded", () => {
  const decoded = recordFromLog(logFor(LIVE_RECORD, 1));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.value.count, 1);
  assert.deepEqual(decoded.value.record, LIVE_RECORD);
});

test("a log that is not a HistoryExtended is refused rather than misread", () => {
  const decoded = recordFromLog({ topics: [`0x${"11".repeat(32)}`], data: "0x", blockNumber: 1, logIndex: 0 });
  assert.equal(decoded.ok, false);
  assert.match(decoded.error.code, /HISTORY_LOG_(UNRECOGNISED|UNDECODABLE)/);
});

test("counterparties are distinct, scoped to the Asset, and in first-appearance order", () => {
  const otherService = `0x${"ab".repeat(32)}`;
  const otherAsset = `0x${"cd".repeat(20)}`;
  const history = [
    LIVE_RECORD,
    { ...LIVE_RECORD, serviceId: otherService },
    LIVE_RECORD,
    { ...LIVE_RECORD, asset: otherAsset },
  ];
  assert.deepEqual(counterpartiesOf(history, LIVE_RECORD.asset), [LIVE_RECORD.serviceId, otherService]);
});

test("a rebuilt witness that folds to the on-chain commitment is accepted", async () => {
  const built = await buildWitness(readerFor([logFor(LIVE_RECORD, 1)], { root: LIVE_ROOT, count: 1 }), AGENT, LIVE_RECORD.asset);
  assert.equal(built.ok, true);
  assert.equal(built.value.rebuilt.root, LIVE_ROOT);
  assert.deepEqual(built.value.witness.bonds, [
    { serviceId: LIVE_RECORD.serviceId, asset: LIVE_RECORD.asset, amount: 5_000_000n },
  ]);
});

test("a witness that does not fold to the commitment is refused locally", async () => {
  const built = await buildWitness(
    readerFor([logFor(LIVE_RECORD, 1)], { root: `0x${"ff".repeat(32)}`, count: 1 }),
    AGENT,
    LIVE_RECORD.asset,
  );
  assert.equal(built.ok, false);
  assert.equal(built.error.code, "WITNESS_COMMITMENT_MISMATCH");
});

test("a repeated record is reported as a chunk read twice", async () => {
  const built = await buildWitness(
    readerFor([logFor(LIVE_RECORD, 1), logFor(LIVE_RECORD, 1)], { root: LIVE_ROOT, count: 2 }),
    AGENT,
    LIVE_RECORD.asset,
  );
  assert.equal(built.ok, false);
  assert.equal(built.error.code, "HISTORY_RECORD_DUPLICATED");
});

test("a gap in the record run names the record that is missing", async () => {
  const built = await buildWitness(
    readerFor([logFor(LIVE_RECORD, 1), logFor(LIVE_RECORD, 3)], { root: LIVE_ROOT, count: 2 }),
    AGENT,
    LIVE_RECORD.asset,
  );
  assert.equal(built.ok, false);
  assert.equal(built.error.code, "HISTORY_RECORD_MISSING");
  assert.match(built.error.message, /record 2 was not returned/);
});

test("logs out of order are sorted by the count the contract assigned", async () => {
  const second = { ...LIVE_RECORD, amount: 202000n };
  const commitment = commitmentOf([LIVE_RECORD, second]);
  const built = await buildWitness(
    readerFor([logFor(second, 2), logFor(LIVE_RECORD, 1)], commitment),
    AGENT,
    LIVE_RECORD.asset,
  );
  assert.equal(built.ok, true);
  assert.equal(built.value.witness.history[0].amount, 101000n);
});

test("a history past LimitLib's ceiling is refused before it is folded on chain", async () => {
  const logs = Array.from({ length: MAX_HISTORY + 1 }, (_, index) => logFor(LIVE_RECORD, index + 1));
  const built = await buildWitness(readerFor(logs, { root: ZERO_ROOT, count: logs.length }), AGENT, LIVE_RECORD.asset);
  assert.equal(built.ok, false);
  assert.equal(built.error.code, "HISTORY_TOO_LONG");
});

test("too many counterparties is refused with the ceiling named", async () => {
  const history = Array.from({ length: MAX_COUNTERPARTIES + 1 }, (_, index) => ({
    ...LIVE_RECORD,
    serviceId: `0x${index.toString(16).padStart(64, "0")}`,
  }));
  const logs = history.map((record, index) => logFor(record, index + 1));
  const built = await buildWitness(readerFor(logs, commitmentOf(history)), AGENT, LIVE_RECORD.asset);
  assert.equal(built.ok, false);
  assert.equal(built.error.code, "TOO_MANY_COUNTERPARTIES");
});

test("a failed history read is passed through rather than swallowed", async () => {
  const failing = {
    historyLogs: async () => ({ ok: false, error: { category: "UPSTREAM", code: "CHAIN_READ_FAILED", message: "no", retryable: true } }),
    commitment: async () => ({ ok: true, value: { root: ZERO_ROOT, count: 0 } }),
    staked: async () => ({ ok: true, value: 0n }),
  };
  const built = await buildWitness(failing, AGENT, LIVE_RECORD.asset);
  assert.equal(built.ok, false);
  assert.equal(built.error.code, "CHAIN_READ_FAILED");
});

test("the measured query timeout is narrowable and an unrelated fault is not", () => {
  assert.equal(isNarrowable(new Error("query timeout of 10 seconds exceeded")), true);
  assert.equal(isNarrowable(new Error("query returned more than 10000 results")), true);
  assert.equal(isNarrowable(new Error("execution reverted")), false);
});

test("the window halves to a floor and doubles to a ceiling", () => {
  assert.equal(shrinkWindow(HISTORY_CHUNK_MAX, HISTORY_CHUNK_MIN), 1000);
  assert.equal(shrinkWindow(1, HISTORY_CHUNK_MIN), HISTORY_CHUNK_MIN);
  assert.equal(growWindow(1000, HISTORY_CHUNK_MAX), HISTORY_CHUNK_MAX);
  assert.equal(growWindow(HISTORY_CHUNK_MAX, HISTORY_CHUNK_MAX), HISTORY_CHUNK_MAX);
});

// ---------------------------------------------------------------- operator check

/**
 * The operator preflight.
 *
 * One Service has one operator, fixed at registration: `ServiceRegistry` has no
 * operator setter and no `Operator` change kind, and `_requireOperator` compares
 * `msg.sender` against it for exact equality. This Service and the gateway are two
 * processes of the same Service, so a distinct key per process looks like hygiene and
 * records nothing.
 *
 * It has to be a startup check because neither cheap alternative works. A keyless
 * simulation passes, since `eth_call` is made with the operator address as `from`. The
 * broadcast fails only after gas is spent, with a revert that reads like a contract
 * problem rather than a configuration one.
 */
const OPERATOR_SERVICE_ID = `0x${"7461622e70726f6f662d73657276696365".padEnd(64, "0")}`;
const REGISTERED_OPERATOR = "0xe5eab26cae0855bccabbb9a64fafce28c8432b37";

const operatorReader = (answer) => ({
  async historyLogs() { throw new Error("unused"); },
  async commitment() { throw new Error("unused"); },
  async staked() { throw new Error("unused"); },
  async operatorOf() { return answer; },
});

test("the operator check passes when the key signs as the registered operator", async () => {
  const result = await checkOperatorKey(
    operatorReader({ ok: true, value: REGISTERED_OPERATOR }),
    OPERATOR_SERVICE_ID,
    REGISTERED_OPERATOR,
  );
  assert.equal(result.ok, true);
  assert.equal(result.value, REGISTERED_OPERATOR);
});

test("a checksummed configured address is the same address", async () => {
  const result = await checkOperatorKey(
    operatorReader({ ok: true, value: REGISTERED_OPERATOR }),
    OPERATOR_SERVICE_ID,
    "0xE5eaB26CaE0855BcCaBBb9A64faFce28C8432b37",
  );
  assert.equal(result.ok, true);
});

test("a key that is not the operator is refused, with both addresses named", async () => {
  const wrong = "0xf4047fe4699c9430359e543f59bebb78e8ea2395";
  const result = await checkOperatorKey(
    operatorReader({ ok: true, value: REGISTERED_OPERATOR }),
    OPERATOR_SERVICE_ID,
    wrong,
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NOT_SERVICE_OPERATOR");
  assert.equal(result.error.category, "AUTHORISATION");
  assert.equal(result.error.retryable, false, "retrying never makes a key the operator");
  assert.match(result.error.message, /0xf4047fe4699c9430359e543f59bebb78e8ea2395/);
  assert.match(result.error.message, /0xe5eab26cae0855bccabbb9a64fafce28c8432b37/);
  assert.equal(result.error.details.configured, wrong);
  assert.equal(result.error.details.operator, REGISTERED_OPERATOR);
});

test("an unreadable registry is reported rather than treated as a pass", async () => {
  const result = await checkOperatorKey(
    operatorReader({ ok: false, error: { category: "UPSTREAM", code: "SERVICE_OF_FAILED", message: "rpc down", retryable: true } }),
    OPERATOR_SERVICE_ID,
    REGISTERED_OPERATOR,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SERVICE_OF_FAILED", "not knowing is not agreeing");
});
