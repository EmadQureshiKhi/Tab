/**
 * Submission: the one place the Watcher spends CTC (R9.5, R20.9, R20.10, D16).
 *
 * Three properties carry the money safety here and each has its own case below.
 *
 * **A replay key is written `SUBMITTED` before the transaction is broadcast**
 * (R20.9). The ordering is the whole guarantee: a crash after the write leaves a
 * row that reconciliation can settle from `claimedLog`, while a crash after a
 * broadcast that was never written leaves a Settlement the pipeline will submit
 * again. The case asserting it records the call order rather than the call counts,
 * because both orderings make the same calls.
 *
 * **A refused batch names the member that refused it.** `submitSettlementBatch` is
 * all-or-nothing and a revert names nobody, so a batch is simulated first and, on
 * refusal, every member is simulated alone. This is the whole reason Requirement 9
 * chose the sequential shape over the array overload.
 *
 * **An unrecognised refusal is skipped, never retried.** Guessing "retry" on an
 * unknown revert spends gas twice to learn nothing, and this network reverts
 * `Error(string)` from the precompile rather than returning false, so string
 * reverts are the expected shape rather than the exotic one.
 *
 * Run against the built output, so what is tested is what the pipeline imports.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SUBMIT_ATTEMPTS,
  SUBMISSION_REFUSALS,
  VERIFIER_INTERFACE,
  classifySubmissionFailure,
  encodeSubmission,
  gasLimitFor,
  outcomeForAction,
  reconcileSubmitted,
  revertDataOf,
  sourceTxTuple,
  submitBatch,
} from "../dist/submission.js";

const WATCHER = "0xb67c73fd513adf5d270d1102f04eb8327f218fe7";
const NOW = new Date("2026-09-06T12:00:00.000Z");
const MID = () => 0.5;

/** Material shaped exactly as `normaliseProofMaterial` produces it. */
const material = (height = 25_876_970n, overrides = {}) => ({
  source: "PROOF_BUILDER",
  chainKey: 3,
  blockHeight: height,
  txIndexFromSource: 7n,
  sourceTxHash: `0x${"aa".repeat(32)}`,
  encodedTransaction: "0x02f8",
  merkleProof: { root: `0x${"2d".repeat(32)}`, siblings: [{ hash: `0x${"11".repeat(32)}`, isLeft: true }] },
  continuityProof: { lowerEndpointDigest: `0x${"fe".repeat(32)}`, roots: [`0x${"2d".repeat(32)}`] },
  cached: false,
  ...overrides,
});

const member = (key, attempts = 0, height = 25_876_970n) => ({
  replayKey: `0x${key.repeat(32)}`,
  material: material(height),
  attempts,
});

/** Revert data for one of the verifier's own custom errors. */
const revert = (name, args) => ({ data: VERIFIER_INTERFACE.encodeErrorResult(name, args) });

/** Revert data for the builtin `Error(string)`, which is what the precompile raises. */
const stringRevert = (message) => ({ data: VERIFIER_INTERFACE.encodeErrorResult("Error(string)", [message]) });

/**
 * A verifier stand-in. `simulateWith` maps a member count and the first member's
 * replay key to a verdict, so a batch and its members can answer differently,
 * which is exactly the situation the fallback exists for.
 */
/** The block the first fake submission lands in, so a test can assert the read is pinned to it. */
const SUBMISSION_BLOCK = 5_438_001;

function verifierOf({ batchAccepts = true, perMember = {}, claimed = new Set(), receipts = [] } = {}) {
  const calls = [];
  let receiptIndex = 0;
  return {
    calls,
    address: "0xc5c83782f315b321cd8e18b4c2e05df4050c3854",
    async claimedLog(replayKey, at) {
      calls.push({ kind: "claimedLog", replayKey, at });
      return { ok: true, value: claimed.has(replayKey) };
    },
    async simulate(materials, from) {
      calls.push({ kind: "simulate", count: materials.length, from });
      if (materials.length > 1) {
        return batchAccepts
          ? { ok: true, value: { accepted: true, ingestedLogs: BigInt(materials.length), refusal: undefined } }
          : { ok: true, value: { accepted: false, ingestedLogs: undefined, refusal: batchRefusal } };
      }
      const key = materials[0].__key;
      const refusal = perMember[key];
      if (refusal === undefined) {
        return { ok: true, value: { accepted: true, ingestedLogs: 1n, refusal: undefined } };
      }
      return { ok: true, value: { accepted: false, ingestedLogs: undefined, refusal } };
    },
    async submit(materials) {
      calls.push({ kind: "submit", count: materials.length });
      const receipt = receipts[receiptIndex] ?? { status: 1 };
      receiptIndex += 1;
      if (receipt.error !== undefined) return { ok: false, error: receipt.error };
      return {
        ok: true,
        value: {
          txHash: receipt.txHash ?? `0x${String(receiptIndex).repeat(64)}`,
          blockNumber: 5_438_000 + receiptIndex,
          status: receipt.status,
          gasUsed: 500_000n,
          gasLimit: 3_000_000n,
          refusal: receipt.refusal,
          recorded: [],
        },
      };
    },
  };
}

const batchRefusal = {
  action: "SKIP",
  errorName: "NoRecognisedSettlement",
  args: [],
  raw: "0x00",
  recognised: true,
  detail: "the batch was refused",
};

/** Tags material with its member key, so the fake can tell members apart. */
function tag(members) {
  for (const entry of members) entry.material.__key = entry.replayKey;
  return members;
}

/** Records every row write and every `SUBMITTED` mark, in order. */
function sink() {
  const order = [];
  const records = [];
  return {
    order,
    records,
    async markSubmitted(keys) {
      order.push(`markSubmitted:${keys.length}`);
      return { ok: true, value: keys.length };
    },
    async recordOutcome(record) {
      order.push(`recordOutcome:${record.state}`);
      records.push(record);
      return { ok: true, value: 1 };
    },
  };
}

const depsOf = (client, extra = {}) => {
  const writes = sink();
  return {
    writes,
    deps: {
      client,
      from: WATCHER,
      submit: true,
      markSubmitted: writes.markSubmitted,
      recordOutcome: writes.recordOutcome,
      now: () => NOW,
      random: MID,
      ...extra,
    },
  };
};

// ------------------------------------------------------------- classification

test("design section 13.2's table is the code, and its verbs are the six actions", () => {
  assert.equal(SUBMISSION_REFUSALS.AlreadyClaimed, "RECONCILE");
  assert.equal(SUBMISSION_REFUSALS.UnboundPayer, "RETRY_AFTER_24H");
  assert.equal(SUBMISSION_REFUSALS.UnauthorizedSourceChain, "HALT");
  assert.equal(SUBMISSION_REFUSALS.SourceTransactionReverted, "SKIP");
  assert.equal(SUBMISSION_REFUSALS.ProofRejected, "RETRY_ALTERNATE_BUILDER");
  assert.equal(SUBMISSION_REFUSALS.BatchTooLarge, "HALT");
});

test("a custom error decodes to its name, its arguments, and its action", () => {
  const refusal = classifySubmissionFailure(revert("AlreadyClaimed", [`0x${"11".repeat(32)}`]));
  assert.equal(refusal.errorName, "AlreadyClaimed");
  assert.equal(refusal.action, "RECONCILE");
  assert.equal(refusal.recognised, true);
  assert.equal(refusal.args[0], `0x${"11".repeat(32)}`);
});

test("the precompile's string revert is the expected refusal shape, not an exotic one", () => {
  // `ProofRejected` is unreachable through bad material on this network: the
  // precompile reverts instead of returning false, so this is what a forged root
  // actually produces, and re-fetching from the other builder is the fix.
  const refusal = classifySubmissionFailure(stringRevert("Merkle proof validation failed"));
  assert.equal(refusal.errorName, "Error(string)");
  assert.equal(refusal.action, "RETRY_ALTERNATE_BUILDER");
  assert.equal(refusal.args[0], "Merkle proof validation failed");
});

test("an expired Continuity Proof is a re-fetch rather than a corrupt-material verdict", () => {
  const refusal = classifySubmissionFailure(
    stringRevert("Continuity proof does not match attestation or checkpoint"),
  );
  assert.equal(refusal.action, "RETRY_ALTERNATE_BUILDER");
});

test("an unrecognised string revert is skipped and flagged, never retried", () => {
  const refusal = classifySubmissionFailure(stringRevert("something nobody has seen"));
  assert.equal(refusal.action, "SKIP");
  assert.equal(refusal.recognised, false);
});

test("a custom error the table does not name is skipped rather than guessed at", () => {
  const refusal = classifySubmissionFailure(revert("ZeroAmount", []));
  assert.equal(refusal.errorName, "ZeroAmount");
  assert.equal(refusal.action, "SKIP");
  assert.equal(refusal.recognised, false);
});

test("revert data no ABI decodes is skipped, and the bytes are kept", () => {
  const refusal = classifySubmissionFailure({ data: "0xdeadbeef" });
  assert.equal(refusal.errorName, "UNDECODABLE");
  assert.equal(refusal.action, "SKIP");
  assert.equal(refusal.raw, "0xdeadbeef");
});

test("a failure with no revert data is transport, and transport alone is retried", () => {
  // It says nothing about the material, so the schedule applies rather than a verdict.
  const refusal = classifySubmissionFailure(new Error("socket hang up"));
  assert.equal(refusal.errorName, "TRANSPORT");
  assert.equal(refusal.action, "RETRY");
});

test("a funding or key failure is an operator problem and halts rather than spinning", () => {
  const refusal = classifySubmissionFailure(new Error("insufficient funds for gas * price + value"));
  assert.equal(refusal.errorName, "TRANSPORT");
  assert.equal(refusal.action, "HALT");
});

test("revert data is found whether ethers nests it or not", () => {
  assert.equal(revertDataOf({ data: "0x1234" }), "0x1234");
  assert.equal(revertDataOf({ info: { error: { data: "0x5678" } } }), "0x5678");
  assert.equal(revertDataOf({ data: "0x" }), undefined);
  assert.equal(revertDataOf(new Error("no data")), undefined);
  assert.equal(revertDataOf(null), undefined);
});

// ------------------------------------------------------------ row transitions

test("each action writes the row state it implies", () => {
  const at = (action, errorName = "X", attempts = 0) =>
    outcomeForAction(member("11", attempts), { action, errorName, args: [], raw: undefined, recognised: true, detail: "" }, NOW, undefined, MID);

  assert.equal(at("RETRY").state, "READY");
  assert.equal(at("RETRY_ALTERNATE_BUILDER").state, "WITHHELD");
  assert.equal(at("SKIP").state, "HALTED");
  assert.equal(at("HALT").state, "HALTED");
  assert.equal(at("RETRY_AFTER_24H").state, "READY");
  assert.equal(at("RECONCILE").state, "READY");
});

test("SKIP and HALT share the HALTED state and are told apart by the category", () => {
  // `state.ts` fixes seven states and none of them is "skipped", so the
  // distinction between "this can never succeed" and "somebody has to look at
  // this" lives in `last_error_category` where the explorer can read it.
  const refusal = { action: "SKIP", errorName: "AssetMismatch", args: [], raw: undefined, recognised: true, detail: "" };
  const skipped = outcomeForAction(member("11"), refusal, NOW, undefined, MID);
  assert.equal(skipped.state, "HALTED");
  assert.equal(skipped.lastErrorCategory, "SKIP:AssetMismatch");

  const halted = outcomeForAction(member("11"), { ...refusal, action: "HALT" }, NOW, undefined, MID);
  assert.equal(halted.state, "HALTED");
  assert.equal(halted.lastErrorCategory, "HALT:AssetMismatch");
});

test("a retried row carries its next attempt, and the schedule continues from the row's count", () => {
  const refusal = { action: "RETRY", errorName: "TRANSPORT", args: [], raw: undefined, recognised: false, detail: "" };
  const first = outcomeForAction(member("11", 0), refusal, NOW, undefined, MID);
  assert.equal(first.attempts, 1);
  assert.equal(first.nextAttemptAt.toISOString(), "2026-09-06T12:00:02.000Z");

  // A row resumed from the database continues its schedule rather than restarting it.
  const later = outcomeForAction(member("11", 3), refusal, NOW, undefined, MID);
  assert.equal(later.attempts, 4);
  assert.equal(later.nextAttemptAt.toISOString(), "2026-09-06T12:00:16.000Z");
});

test("a row that has exhausted its retries is halted rather than retried forever", () => {
  const refusal = { action: "RETRY", errorName: "TRANSPORT", args: [], raw: undefined, recognised: false, detail: "" };
  const record = outcomeForAction(member("11", MAX_SUBMIT_ATTEMPTS - 1), refusal, NOW, undefined, MID);
  assert.equal(record.state, "HALTED");
  assert.match(record.lastErrorCategory, /RETRIES_EXHAUSTED/);
});

test("an unbound payer waits a day once and is skipped the second time", () => {
  // The Agent may bind later, so one re-queue is worth it; a second means the
  // binding is not coming and the row would otherwise sit in the queue forever.
  const refusal = { action: "RETRY_AFTER_24H", errorName: "UnboundPayer", args: [], raw: undefined, recognised: true, detail: "" };
  const first = outcomeForAction(member("11", 0), refusal, NOW, undefined, MID);
  assert.equal(first.state, "READY");
  assert.equal(first.nextAttemptAt.toISOString(), "2026-09-07T12:00:00.000Z");

  const second = outcomeForAction(member("11", 1), refusal, NOW, undefined, MID);
  assert.equal(second.state, "HALTED");
  assert.equal(second.lastErrorCategory, "SKIP:UnboundPayer");
});

// -------------------------------------------------------------------- calldata

test("one member encodes the single entrypoint and several encode the batch", () => {
  const single = encodeSubmission([material()]);
  const batch = encodeSubmission([material(), material(25_876_971n)]);
  assert.equal(single.slice(0, 10), VERIFIER_INTERFACE.getFunction("submitSettlement").selector);
  assert.equal(batch.slice(0, 10), VERIFIER_INTERFACE.getFunction("submitSettlementBatch").selector);
  assert.notEqual(single.slice(0, 10), batch.slice(0, 10));
});

test("the tuple carries the Continuity Proof inside SourceTx, where it cannot be mispaired", () => {
  // R9.7's shape: there is no proof parameter beside the array, so the disproven
  // one-shared-proof batch is unexpressible rather than merely discouraged.
  const tuple = sourceTxTuple(material());
  assert.equal(tuple.length, 5);
  assert.equal(tuple[0], 3n);
  assert.equal(tuple[1], 25_876_970n);
  assert.deepEqual(tuple[4], [`0x${"fe".repeat(32)}`, [`0x${"2d".repeat(32)}`]]);
});

test("gas is doubled off a warm estimate, and falls back per member without one", () => {
  // Estimates on this chain come from a warm simulation and under-count cold
  // storage writes; task 12.2 measured 62,561 estimated against 101,535 needed.
  assert.equal(gasLimitFor(100_000n, 1), 300_000n);
  assert.equal(gasLimitFor(undefined, 1), 3_000_000n);
  assert.equal(gasLimitFor(undefined, 4), 12_000_000n);
});

// ---------------------------------------------------------------- the sweep

test("a read-only sweep simulates, reports what it would do, and writes nothing", async () => {
  const client = verifierOf();
  const { deps, writes } = depsOf(client, { submit: false });
  const members = tag([member("11"), member("22")]);

  const report = await submitBatch(deps, members);
  assert.equal(report.ok, true);
  assert.equal(report.value.members.every((entry) => entry.action === "WOULD_SUBMIT"), true);
  assert.deepEqual(writes.order, [], "nothing is written and nothing is broadcast");
  assert.equal(client.calls.some((call) => call.kind === "submit"), false);
});

test("SUBMITTED is written before the broadcast, which is the whole of R20.9", async () => {
  const client = verifierOf({ claimed: new Set([`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`]) });
  const { deps, writes } = depsOf(client);
  const members = tag([member("11"), member("22")]);

  const report = await submitBatch(deps, members);
  assert.equal(report.ok, true);

  // Both orderings make the same calls, so the assertion is on the order.
  const marked = writes.order.indexOf("markSubmitted:2");
  const submitted = client.calls.findIndex((call) => call.kind === "submit");
  assert.notEqual(marked, -1, "the keys were marked");
  assert.notEqual(submitted, -1, "the batch was broadcast");
  assert.ok(marked === 0, "the mark is the first write of the sweep");
  assert.equal(report.value.confirmed, 2);
});

test("a mined batch confirms each member from claimedLog rather than from the receipt", async () => {
  // The replay key is the identity the contract claimed, and a status-1 receipt
  // says only that the transaction did not revert.
  const client = verifierOf({ claimed: new Set([`0x${"11".repeat(32)}`]) });
  const { deps, writes } = depsOf(client);
  const report = await submitBatch(deps, tag([member("11"), member("22")]));

  assert.equal(report.ok, true);
  assert.equal(report.value.confirmed, 1);
  const states = writes.records.map((record) => record.state);
  assert.deepEqual(states, ["CONFIRMED", "READY"]);
  // The unclaimed member goes back to READY under the same key, which is safe
  // because at most one submission of a key can ever be claimed.
  assert.equal(writes.records[1].lastErrorCategory, "RETRY:NOT_CLAIMED_AFTER_MINING");
});

test("confirmation reads claimedLog at the block the submission landed in", async () => {
  // The client pins its reads to `finalized`, which lags `latest`. A claim written
  // seconds ago reads back false at the pinned tag, and the row would be sent round
  // again to be refused `LogAlreadyClaimed` at full cost. Measured on the live
  // deployment: a mined submission whose two keys both read false at the pinned tag
  // and true at `latest`.
  const client = verifierOf({ claimed: new Set([`0x${"11".repeat(32)}`]) });
  const { deps } = depsOf(client);
  const report = await submitBatch(deps, tag([member("11")]));

  assert.equal(report.ok, true);
  const reads = client.calls.filter((call) => call.kind === "claimedLog");
  assert.equal(reads.length, 1);
  assert.equal(
    reads[0].at,
    SUBMISSION_BLOCK,
    "the receipt's own block, not the pinned tag the client would otherwise use",
  );
});

test("a batch the chain refuses names the member that refused it", async () => {
  // This is the reason Requirement 9 chose sequential calls over the array
  // overload: the overload returns one boolean and can attribute nothing.
  const bad = `0x${"22".repeat(32)}`;
  const client = verifierOf({
    batchAccepts: false,
    perMember: {
      [bad]: { action: "SKIP", errorName: "UnknownCollectionAddress", args: [], raw: "0x1", recognised: true, detail: "unregistered recipient" },
    },
    claimed: new Set([`0x${"11".repeat(32)}`]),
  });
  const { deps, writes } = depsOf(client);

  const report = await submitBatch(deps, tag([member("11"), member("22")]));
  assert.equal(report.ok, true);

  const refused = report.value.members.find((entry) => entry.replayKey === bad);
  assert.equal(refused.state, "HALTED");
  assert.equal(refused.action, "SKIP");
  // The good member still goes, so one bad proof never blocks the others.
  assert.equal(report.value.confirmed, 1);
  assert.equal(writes.records.find((record) => record.replayKey === bad).lastErrorCategory, "SKIP:UnknownCollectionAddress");
});

test("a batch that passes simulation and reverts on chain falls back per member", async () => {
  // D16: all-or-nothing with individual fallback, so one bad proof cannot block a
  // batch indefinitely. The revert is discovered after the gas is spent, which is
  // why the simulation runs first and this path is the exception.
  const client = verifierOf({
    claimed: new Set([`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`]),
    receipts: [{ status: 0, txHash: `0x${"ee".repeat(32)}` }, { status: 1 }, { status: 1 }],
  });
  const { deps } = depsOf(client);

  const report = await submitBatch(deps, tag([member("11"), member("22")]));
  assert.equal(report.ok, true);
  const submits = client.calls.filter((call) => call.kind === "submit");
  assert.equal(submits.length, 3, "the batch, then each member alone");
  assert.deepEqual(submits.map((call) => call.count), [2, 1, 1]);
  assert.equal(report.value.confirmed, 2);
  assert.equal(report.value.txHashes.length, 3);
});

test("a HALT refusal is reported so the caller stops the chain's pipeline", async () => {
  const client = verifierOf({
    batchAccepts: false,
    perMember: {
      [`0x${"11".repeat(32)}`]: { action: "HALT", errorName: "UnauthorizedSourceChain", args: [], raw: "0x1", recognised: true, detail: "wrong chain" },
    },
  });
  const { deps } = depsOf(client);
  const report = await submitBatch(deps, tag([member("11")]));
  assert.equal(report.ok, true);
  assert.equal(report.value.halted, true);
});

test("AlreadyClaimed is reconciled from the chain rather than counted as a failure", async () => {
  const key = `0x${"11".repeat(32)}`;
  const client = verifierOf({
    batchAccepts: false,
    perMember: {
      [key]: { action: "RECONCILE", errorName: "AlreadyClaimed", args: [key], raw: "0x1", recognised: true, detail: "claimed" },
    },
    claimed: new Set([key]),
  });
  const { deps, writes } = depsOf(client);

  const report = await submitBatch(deps, tag([member("11")]));
  assert.equal(report.ok, true);
  assert.equal(report.value.confirmed, 1);
  assert.equal(writes.records[0].state, "CONFIRMED");
  assert.equal(writes.records[0].lastErrorCategory, undefined);
});

test("a broadcast whose receipt never arrives leaves the rows SUBMITTED for reconciliation", async () => {
  // The transaction may yet be mined, so returning the rows to READY here would
  // risk a second submission of a key the chain is about to claim.
  const client = verifierOf({
    receipts: [{ error: { category: "UPSTREAM", code: "SUBMISSION_RECEIPT_TIMEOUT", message: "not mined", retryable: true, details: { txHash: `0x${"cc".repeat(32)}` } } }],
  });
  const { deps, writes } = depsOf(client);
  const report = await submitBatch(deps, tag([member("11")]));

  assert.equal(report.ok, true);
  assert.equal(report.value.members[0].state, "SUBMITTED");
  assert.equal(writes.records.length, 0, "the row is left as marked, not rewritten");
});

test("a transaction that was never broadcast returns its rows to the schedule", async () => {
  const client = verifierOf({
    receipts: [{ error: { category: "UPSTREAM", code: "SUBMISSION_NOT_BROADCAST", message: "nonce too low", retryable: true } }],
  });
  const { deps, writes } = depsOf(client);
  const report = await submitBatch(deps, tag([member("11")]));

  assert.equal(report.ok, true);
  assert.equal(writes.records[0].state, "READY");
  assert.notEqual(writes.records[0].nextAttemptAt, undefined);
});

test("a broadcast refused for funding halts instead of retrying against an empty account", async () => {
  const client = verifierOf({
    receipts: [{ error: { category: "AUTHORISATION", code: "SUBMISSION_NOT_BROADCAST", message: "insufficient funds", retryable: false } }],
  });
  const { deps } = depsOf(client);
  const report = await submitBatch(deps, tag([member("11")]));
  assert.equal(report.value.halted, true);
});

test("every member refused leaves nothing to broadcast", async () => {
  const client = verifierOf({
    batchAccepts: false,
    perMember: {
      [`0x${"11".repeat(32)}`]: { action: "SKIP", errorName: "AssetMismatch", args: [], raw: "0x1", recognised: true, detail: "" },
    },
  });
  const { deps } = depsOf(client);
  const report = await submitBatch(deps, tag([member("11")]));
  assert.equal(report.ok, true);
  assert.equal(client.calls.some((call) => call.kind === "submit"), false);
});

// ------------------------------------------------------------ reconciliation

test("reconciliation confirms a claimed key and returns an unclaimed one to READY", async () => {
  const claimedKey = `0x${"11".repeat(32)}`;
  const unclaimedKey = `0x${"22".repeat(32)}`;
  const client = verifierOf({ claimed: new Set([claimedKey]) });
  const records = [];

  const report = await reconcileSubmitted(
    client,
    [
      { replayKey: claimedKey, attempts: 1, ccTxHash: `0x${"ab".repeat(32)}` },
      { replayKey: unclaimedKey, attempts: 1, ccTxHash: undefined },
    ],
    async (record) => {
      records.push(record);
      return { ok: true, value: 1 };
    },
  );

  assert.deepEqual(report.confirmed, [claimedKey]);
  assert.deepEqual(report.returnedToReady, [unclaimedKey]);
  assert.equal(records[0].state, "CONFIRMED");
  assert.equal(records[0].ccTxHash, `0x${"ab".repeat(32)}`);
  assert.equal(records[1].state, "READY");
  assert.equal(records[1].lastErrorCategory, "RECONCILED:NOT_CLAIMED");
});

test("a dry-run reconciliation reports the same verdict and writes nothing", async () => {
  const client = verifierOf({ claimed: new Set([`0x${"11".repeat(32)}`]) });
  let written = 0;
  const report = await reconcileSubmitted(
    client,
    [{ replayKey: `0x${"11".repeat(32)}`, attempts: 1, ccTxHash: undefined }],
    async () => {
      written += 1;
      return { ok: true, value: 1 };
    },
    true,
  );
  assert.deepEqual(report.confirmed, [`0x${"11".repeat(32)}`]);
  assert.equal(written, 0);
});

test("a row whose claim cannot be read is reported rather than guessed at", async () => {
  const client = {
    address: "0x0",
    async claimedLog() {
      return { ok: false, error: { category: "UPSTREAM", code: "VERIFIER_READ_FAILED", message: "no", retryable: true } };
    },
  };
  const report = await reconcileSubmitted(client, [{ replayKey: `0x${"11".repeat(32)}`, attempts: 1, ccTxHash: undefined }], async () => ({ ok: true, value: 1 }));
  assert.equal(report.unreadable.length, 1);
  assert.deepEqual(report.confirmed, []);
  assert.deepEqual(report.returnedToReady, []);
});
