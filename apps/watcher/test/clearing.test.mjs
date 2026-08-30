/**
 * Provisional Clearing and the reorganisation check.
 *
 * Both write paths spend CTC and both are gated on `TabBook.watcher`, so the cases
 * that matter most here are the ones where nothing should be sent: a Bond deposit, a
 * spent identity, a block that is not attested yet, and a healthy Settlement whose
 * digest the precompile does not recognise. The last of those is a measured trap
 * rather than a hypothetical — a Source Chain block hash answers `exists: false`
 * against `get_attestation_height_for_digest` on both chains, and a Watcher that read
 * that as a reorganisation would slash an honest Service's Bond on every settlement.
 *
 * `TabBook` itself is stood in for. Its behaviour is pinned by the Solidity tests;
 * what is pinned here is which calls the Watcher makes and which it declines to make.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTabBookClient,
  ZERO_DIGEST,
  checkForReorg,
  clearingEligibility,
  indexTargets,
  replayKeyFields,
  sweepClearings,
  sweepReversals,
} from "../dist/index.js";

const USDC_MAINNET = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TAB_COLLECTION = "0x952acc70e6f54ce87dca963193a5957bcb27729e";
const BOND_COLLECTION = "0x9d6ad64ae2d000873ffdfc757808f24cf9cf67fc";
const SERVICE_ID = `0x${"7461622e70726f6f662d73657276696365".padEnd(64, "0")}`;
/**
 * The Settlement's payer, an Ethereum address read from `topics[1]`, and the
 * Creditcoin Agent that bound it. Deliberately different words: a clearing pledges
 * the Service's Bond against the *Agent*, and passing the payer through was the
 * defect `agent-registry.ts` closes.
 */
const PAYER = "0xa302940db97345c5adaf8da23ff46ae63613d728";
const AGENT = "0x1f6f797edc2eecb02bd54009b805fb2e99f80542";
const UNBOUND_PAYER = "0xdead00000000000000000000000000000000beef";
const WATCHER = "0xb67c73fd513adf5d270d1102f04eb8327f218fe7";
const OBSERVED_DIGEST = `0x${"7b".repeat(32)}`;
const REPLACEMENT_DIGEST = `0x${"9c".repeat(32)}`;
/** chainKey 3, block 25921131, transaction 42, log 7 — packed by `@tabai/shared`. */
const REPLAY_KEY = "0x000000000000000300000000018b866b000000000000002a0000000000000007";

const target = (overrides = {}) => ({
  chainKey: 3,
  emitter: USDC_MAINNET,
  emitterKind: "ASSET",
  eventName: "Transfer",
  topic0: `0x${"dd".repeat(32)}`,
  collection: TAB_COLLECTION,
  collectionTopic: `0x${"00".repeat(12)}${TAB_COLLECTION.slice(2)}`,
  collectionKind: "TAB",
  asset: USDC_MAINNET,
  serviceId: SERVICE_ID,
  ...overrides,
});

const settlement = (overrides = {}) => ({
  replayKey: REPLAY_KEY,
  chainKey: 3,
  blockHeight: 25921131n,
  logIndex: 7n,
  sourceTxHash: `0x${"aa".repeat(32)}`,
  asset: USDC_MAINNET,
  payer: PAYER,
  collection: TAB_COLLECTION,
  serviceId: SERVICE_ID,
  amount: 2_500_000n,
  state: "OBSERVED",
  clearingState: undefined,
  attestedDigest: undefined,
  emitter: USDC_MAINNET,
  observedAt: new Date("2026-08-30T12:00:00Z"),
  ...overrides,
});

/**
 * An `AgentRegistry` stand-in. `bound` maps a lowercase payer to its Agent; a payer
 * absent from it resolves to nobody, which is what the live registry answers for an
 * address no Agent has proven.
 */
function agentsOf({ bound = { [PAYER]: AGENT }, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async agentOf(chainKey, payer) {
      calls.push({ chainKey, payer });
      if (fail) {
        return {
          ok: false,
          error: { category: "UPSTREAM", code: "AGENT_REGISTRY_READ_FAILED", message: "no", retryable: true },
        };
      }
      const agent = bound[payer.toLowerCase()];
      return { ok: true, value: { agent, payer: payer.toLowerCase(), chainKey } };
    },
  };
}

/** A `TabBook` stand-in that records every call it is asked to make. */
function tabBookOf({ existing = "NONE", after = "APPLIED", digestAtApply = ZERO_DIGEST } = {}) {
  const calls = { clearingOf: [], applied: [], reorgs: [] };
  return {
    calls,
    async clearingOf(replayKey) {
      calls.clearingOf.push(replayKey);
      return {
        ok: true,
        value: {
          state: existing,
          amount: 2_500_000n,
          reduced: 2_500_000n,
          deadline: 0n,
          attestedDigestAtApply: digestAtApply,
        },
      };
    },
    async applyProvisionalClearing(args) {
      calls.applied.push(args);
      return { ok: true, value: { txHash: `0x${"cc".repeat(32)}`, clearingState: after } };
    },
    async reportReorg(replayKey, observedDigest, attestedDigest) {
      calls.reorgs.push({ replayKey, observedDigest, attestedDigest });
      return { ok: true, value: `0x${"dd".repeat(32)}` };
    },
  };
}

const sourceOf = (digest) => ({
  async blockDigestAt() {
    return { ok: true, value: digest };
  },
});

const attestationOf = ({ isAttested = true, resolves = false } = {}) => ({
  async bounds() {
    return {
      ok: true,
      value: { parentHeight: 25921130n, childHeight: 25921140n, childHash: `0x${"ee".repeat(32)}`, isAttested },
    };
  },
  async heightForDigest() {
    return { ok: true, value: { height: resolves ? 25921131n : 0n, exists: resolves } };
  },
});

function recorder() {
  const records = [];
  return { records, persist: async (record) => (records.push(record), { ok: true, value: 1 }) };
}

// ---------------------------------------------------------------- eligibility

test("an observed Settlement to a Tab collection is eligible", () => {
  const verdict = clearingEligibility(settlement(), indexTargets([target()]));
  assert.equal(verdict.eligible, true);
  assert.equal(verdict.reason, undefined);
});

test("a Bond deposit is observed but never cleared, because it pays no tab down", () => {
  const verdict = clearingEligibility(
    settlement({ collection: BOND_COLLECTION }),
    indexTargets([target({ collection: BOND_COLLECTION, collectionKind: "BOND" })]),
  );
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "BOND_COLLECTION");
});

test("a zero-value Settlement is not offered a clearing, because the contract refuses zero", () => {
  const verdict = clearingEligibility(settlement({ amount: 0n }), indexTargets([target()]));
  assert.equal(verdict.reason, "ZERO_AMOUNT");
});

test("an identity that already carries a clearing is spent, declined included", () => {
  for (const state of ["APPLIED", "DECLINED", "CONFIRMED", "REVERSED", "SUPERSEDED"]) {
    const verdict = clearingEligibility(settlement({ clearingState: state }), indexTargets([target()]));
    assert.equal(verdict.reason, "CLEARING_EXISTS", state);
  }
});

test("a row whose Collection Address resolves to no target names its Service to nobody", () => {
  const verdict = clearingEligibility(settlement(), indexTargets([]));
  assert.equal(verdict.reason, "UNKNOWN_TARGET");
});

test("a row past OBSERVED is not re-offered a clearing", () => {
  const verdict = clearingEligibility(settlement({ state: "READY" }), indexTargets([target()]));
  assert.equal(verdict.reason, "NOT_OBSERVED");
});

// ---------------------------------------------------------------- applying

test("a read-only sweep reports the digest it would use and sends nothing", async () => {
  const client = tabBookOf();
  const { records, persist } = recorder();
  const report = await sweepClearings(
    { client, source: sourceOf(OBSERVED_DIGEST), agents: agentsOf(), targets: [target()], persist, submit: false },
    [settlement()],
  );
  assert.equal(report.ok, true);
  assert.equal(client.calls.applied.length, 0);
  assert.equal(records.length, 0);
  assert.equal(report.value.attempts[0].digest, OBSERVED_DIGEST);
  assert.equal(report.value.applied, 0);
});

test("a submitting sweep refuses to spend gas when the signer is not the wired Watcher", async () => {
  const client = tabBookOf();
  const { persist } = recorder();
  const report = await sweepClearings(
    {
      client,
      source: sourceOf(OBSERVED_DIGEST),
      agents: agentsOf(),
      targets: [target()],
      persist,
      submit: true,
      signerAddress: "0x1111111111111111111111111111111111111111",
      watcherAddress: WATCHER,
    },
    [settlement()],
  );
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "WATCHER_ADDRESS_MISMATCH");
  assert.equal(client.calls.clearingOf.length, 0);
  assert.equal(client.calls.applied.length, 0);
});

test("an applied clearing carries the digest read at apply time, and the row becomes PROVISIONAL", async () => {
  const client = tabBookOf({ after: "APPLIED" });
  const { records, persist } = recorder();
  const report = await sweepClearings(
    {
      client,
      source: sourceOf(OBSERVED_DIGEST),
      agents: agentsOf(),
      targets: [target()],
      persist,
      submit: true,
      signerAddress: WATCHER,
      watcherAddress: WATCHER,
    },
    [settlement()],
  );
  assert.equal(report.ok, true);
  assert.equal(report.value.applied, 1);
  const [args] = client.calls.applied;
  assert.equal(args.attestedDigestAtApply, OBSERVED_DIGEST);
  // The pledge names the Creditcoin Agent the registry resolved, never the
  // Ethereum payer the log carried. Both assertions are load-bearing: the first
  // fixes what it must be, the second that the two are not the same word.
  assert.equal(args.agent, AGENT);
  assert.notEqual(args.agent, PAYER);
  assert.equal(args.amount, 2_500_000n);
  assert.equal(args.chainKey, 3n);
  assert.equal(args.replayKey, REPLAY_KEY);
  assert.deepEqual(records, [
    {
      replayKey: REPLAY_KEY,
      clearingState: "APPLIED",
      state: "PROVISIONAL",
      attestedDigest: OBSERVED_DIGEST,
    },
  ]);
});

test("an unbound payer is observed and never pledged against, because there is no Agent to credit", async () => {
  const client = tabBookOf();
  const agents = agentsOf({ bound: {} });
  const { records, persist } = recorder();
  const report = await sweepClearings(
    {
      client,
      source: sourceOf(OBSERVED_DIGEST),
      agents,
      targets: [target()],
      persist,
      submit: true,
      signerAddress: WATCHER,
      watcherAddress: WATCHER,
    },
    [settlement({ payer: UNBOUND_PAYER })],
  );
  assert.equal(report.ok, true);
  assert.equal(report.value.applied, 0);
  assert.equal(report.value.skipped, 1);
  assert.equal(report.value.attempts[0].skipped, "UNBOUND_PAYER");
  // Nothing was pledged, nothing was written, and the Source Chain was never asked
  // for a digest, because the row was refused before that cost was paid.
  assert.equal(client.calls.applied.length, 0);
  assert.equal(records.length, 0);
  assert.equal(agents.calls.length, 1);
});

test("an unreadable registry is an unresolved payer, not an unbound one, and pledges nothing", async () => {
  const client = tabBookOf();
  const { records, persist } = recorder();
  const report = await sweepClearings(
    {
      client,
      source: sourceOf(OBSERVED_DIGEST),
      agents: agentsOf({ fail: true }),
      targets: [target()],
      persist,
      submit: true,
      signerAddress: WATCHER,
      watcherAddress: WATCHER,
    },
    [settlement()],
  );
  assert.equal(report.ok, true);
  assert.equal(report.value.applied, 0);
  assert.equal(report.value.attempts[0].skipped, "AGENT_UNRESOLVED");
  // The distinction matters: "no Agent has bound this payer" is settled and
  // terminal for the pass, while "the registry did not answer" is transient and the
  // row is offered again next pass. Neither pledges a Bond.
  assert.notEqual(report.value.attempts[0].error, undefined);
  assert.equal(client.calls.applied.length, 0);
  assert.equal(records.length, 0);
});

test("a declined clearing leaves the row OBSERVED and records the decline so it is not retried", async () => {
  const client = tabBookOf({ after: "DECLINED" });
  const { records, persist } = recorder();
  const report = await sweepClearings(
    {
      client,
      source: sourceOf(OBSERVED_DIGEST),
      agents: agentsOf(),
      targets: [target()],
      persist,
      submit: true,
      signerAddress: WATCHER,
      watcherAddress: WATCHER,
    },
    [settlement()],
  );
  assert.equal(report.ok, true);
  assert.equal(report.value.declined, 1);
  assert.equal(records[0].clearingState, "DECLINED");
  assert.equal(records[0].state, "OBSERVED");
});

test("a clearing already on chain is discovered rather than attempted twice", async () => {
  const client = tabBookOf({ existing: "APPLIED", digestAtApply: OBSERVED_DIGEST });
  const { records, persist } = recorder();
  const report = await sweepClearings(
    {
      client,
      source: sourceOf(OBSERVED_DIGEST),
      agents: agentsOf(),
      targets: [target()],
      persist,
      submit: true,
      signerAddress: WATCHER,
      watcherAddress: WATCHER,
    },
    [settlement()],
  );
  assert.equal(report.ok, true);
  assert.equal(report.value.discovered, 1);
  assert.equal(client.calls.applied.length, 0);
  assert.deepEqual(records, [
    {
      replayKey: REPLAY_KEY,
      clearingState: "APPLIED",
      state: "PROVISIONAL",
      attestedDigest: OBSERVED_DIGEST,
    },
  ]);
});

test("no digest means no clearing: the pledge is not made against a block nobody can name", async () => {
  const client = tabBookOf();
  const { records, persist } = recorder();
  const report = await sweepClearings(
    {
      client,
      source: sourceOf(undefined),
      agents: agentsOf(),
      targets: [target()],
      persist,
      submit: true,
      signerAddress: WATCHER,
      watcherAddress: WATCHER,
    },
    [settlement()],
  );
  assert.equal(report.ok, true);
  assert.equal(report.value.attempts[0].skipped, "DIGEST_UNAVAILABLE");
  assert.equal(client.calls.applied.length, 0);
  assert.equal(records.length, 0);
});

// ---------------------------------------------------------------- reorg check

const confirmed = (overrides = {}) =>
  settlement({ state: "CONFIRMED", clearingState: "CONFIRMED", attestedDigest: OBSERVED_DIGEST, ...overrides });

test("an unchanged digest is canonical, and the precompile not recognising it changes nothing", async () => {
  const client = tabBookOf();
  const { records, persist } = recorder();
  const finding = await checkForReorg(
    {
      // `resolves: false` is what the live precompile answers for a Source Chain
      // block hash, measured on both chains at an attested height.
      attestation: attestationOf({ isAttested: true, resolves: false }),
      source: sourceOf(OBSERVED_DIGEST),
      client,
      persist,
      submit: true,
    },
    confirmed(),
  );
  assert.equal(finding.verdict, "CANONICAL");
  assert.equal(finding.digestResolvesOnChainInfo, false);
  assert.equal(client.calls.reorgs.length, 0, "a healthy Settlement must never be reported");
  assert.equal(records.length, 0);
});

test("a replaced digest is a reorganisation, reported with the digest the chain now carries", async () => {
  const client = tabBookOf();
  const { records, persist } = recorder();
  const finding = await checkForReorg(
    {
      attestation: attestationOf(),
      source: sourceOf(REPLACEMENT_DIGEST),
      client,
      persist,
      submit: true,
    },
    confirmed(),
  );
  assert.equal(finding.verdict, "REORGED");
  assert.equal(finding.attestedDigest, REPLACEMENT_DIGEST);
  assert.deepEqual(client.calls.reorgs, [
    { replayKey: REPLAY_KEY, observedDigest: OBSERVED_DIGEST, attestedDigest: REPLACEMENT_DIGEST },
  ]);
  assert.equal(records[0].clearingState, "SUPERSEDED");
  assert.equal(records[0].attestedDigest, OBSERVED_DIGEST);
});

test("a height that no longer carries a block is reported against the zero digest", async () => {
  const client = tabBookOf();
  const { persist } = recorder();
  const finding = await checkForReorg(
    { attestation: attestationOf(), source: sourceOf(undefined), client, persist, submit: true },
    confirmed(),
  );
  assert.equal(finding.verdict, "REORGED");
  assert.equal(finding.attestedDigest, ZERO_DIGEST);
  assert.equal(client.calls.reorgs[0].attestedDigest, ZERO_DIGEST);
  assert.notEqual(client.calls.reorgs[0].observedDigest, ZERO_DIGEST);
});

test("a block above the attested frontier is unsettled, not reorganised", async () => {
  const client = tabBookOf();
  const { persist } = recorder();
  const finding = await checkForReorg(
    {
      attestation: attestationOf({ isAttested: false }),
      source: sourceOf(REPLACEMENT_DIGEST),
      client,
      persist,
      submit: true,
    },
    confirmed(),
  );
  assert.equal(finding.verdict, "NOT_YET_ATTESTED");
  assert.equal(client.calls.reorgs.length, 0);
});

test("an unreadable bounds read reaches no conclusion and reports nothing", async () => {
  const client = tabBookOf();
  const { persist } = recorder();
  const finding = await checkForReorg(
    {
      attestation: {
        async bounds() {
          return {
            ok: false,
            error: { category: "UPSTREAM", code: "CHAININFO_READ_FAILED", message: "timeout", retryable: true },
          };
        },
        async heightForDigest() {
          throw new Error("must not be reached");
        },
      },
      source: sourceOf(REPLACEMENT_DIGEST),
      client,
      persist,
      submit: true,
    },
    confirmed(),
  );
  assert.equal(finding.verdict, "UNVERIFIABLE");
  assert.equal(client.calls.reorgs.length, 0);
});

test("a row with no digest from apply time cannot report, because the contract would refuse it", async () => {
  const client = tabBookOf();
  const { persist } = recorder();
  const finding = await checkForReorg(
    { attestation: attestationOf(), source: sourceOf(REPLACEMENT_DIGEST), client, persist, submit: true },
    confirmed({ attestedDigest: undefined }),
  );
  assert.equal(finding.verdict, "UNVERIFIABLE");
  assert.equal(client.calls.reorgs.length, 0);
});

test("a read-only check concludes without sending anything", async () => {
  const client = tabBookOf();
  const { records, persist } = recorder();
  const finding = await checkForReorg(
    { attestation: attestationOf(), source: sourceOf(REPLACEMENT_DIGEST), client, persist, submit: false },
    confirmed(),
  );
  assert.equal(finding.verdict, "REORGED");
  assert.equal(finding.reportedTxHash, undefined);
  assert.equal(client.calls.reorgs.length, 0);
  assert.equal(records.length, 0);
});

test("the replay key a clearing is keyed on unpacks to the Settlement it names", () => {
  const fields = replayKeyFields(REPLAY_KEY);
  assert.equal(fields.chainKey, 3n);
  assert.equal(fields.blockHeight, 25921131n);
  assert.equal(fields.txIndex, 42n);
  assert.equal(fields.logIndex, 7n);
});

// ---------------------------------------------------------------- confirming a write

/**
 * A write is confirmed at the block it landed in, never at the pinned tag.
 *
 * Creditcoin's `finalized` view lags `latest` by a couple of blocks, so a read-back
 * pinned to `finalized` straight after a mined transaction can miss the write it is
 * checking. That is measured rather than theoretical: an `applyProvisionalClearing`
 * that had genuinely applied, with the Bond reserved and `clearingOf` reading
 * `Applied` at both tags moments later, was read back as `None` and recorded as a
 * decline. A decline is terminal in this pipeline, so the Settlement would never have
 * been retried while the Service's stake stayed pledged against it.
 *
 * The provider below answers `None` at the pinned tag and `Applied` at the block the
 * receipt names, which is exactly the shape of that failure. A client that reads at
 * the pinned tag reports `DECLINED`; the shipped one reports `APPLIED`.
 */
test("a clearing is confirmed at the block it landed in, not at the pinned tag", async () => {
  const APPLIED_AT_BLOCK = 900;
  const clearingWord = (state) =>
    "0x" +
    "".padStart(64, "0") + // agent
    "".padStart(64, "0") + // serviceId
    "".padStart(64, "0") + // asset
    (2000).toString(16).padStart(64, "0") + // amount
    (2000).toString(16).padStart(64, "0") + // reduced
    (1).toString(16).padStart(64, "0") + // chainKey
    "".padStart(64, "0") + // appliedAt
    "".padStart(64, "0") + // deadline
    "".padStart(64, "0") + // sourceTxHash
    "".padStart(64, "0") + // attestedDigestAtApply
    state.toString(16).padStart(64, "0"); // state

  const seen = [];
  const provider = {
    async call({ blockTag }) {
      seen.push(blockTag);
      // `1` is Applied and `0` is None. The pinned tag has not caught up yet.
      return clearingWord(blockTag === APPLIED_AT_BLOCK ? 1 : 0);
    },
  };
  const signer = {
    async sendTransaction() {
      return {
        hash: "0x" + "ab".repeat(32),
        async wait() {
          return { status: 1, blockNumber: APPLIED_AT_BLOCK };
        },
      };
    },
  };

  const client = createTabBookClient(provider, `0x${"11".repeat(20)}`, "finalized", signer);
  const result = await client.applyProvisionalClearing({
    replayKey: `0x${"22".repeat(32)}`,
    agent: `0x${"33".repeat(20)}`,
    serviceId: `0x${"44".repeat(32)}`,
    asset: `0x${"55".repeat(20)}`,
    amount: 2000n,
    chainKey: 1n,
    sourceTxHash: `0x${"66".repeat(32)}`,
    attestedDigestAtApply: `0x${"77".repeat(32)}`,
  });

  assert.equal(result.ok, true, "the write succeeded");
  assert.equal(result.value.clearingState, "APPLIED", "the outcome is read at the receipt's block");
  assert.deepEqual(seen, [APPLIED_AT_BLOCK], "the confirming read used the block, not the pinned tag");
});

// ---------------------------------------------------------------- reversal crank

/**
 * The reversal crank.
 *
 * `reverseExpiredClearing` is permissionless on purpose, and that is what makes the
 * two cases below the interesting ones. Somebody else may have cranked the clearing
 * already, so a stored `APPLIED` is a hint and not a fact, and acting on it would
 * spend gas on a certain `ClearingNotInState` revert. And the deadline belongs to
 * Creditcoin's clock, not to the host's, because `TabBook` compares it against
 * `block.timestamp`; a Watcher whose clock ran fast would crank early and pay for a
 * `ClearingNotExpired` revert.
 */
function reversalClient({ record, reverseResult, onReverse }) {
  return {
    async clearingOf() {
      return record;
    },
    async applyProvisionalClearing() {
      throw new Error("the reversal sweep must not apply a clearing");
    },
    async reportReorg() {
      throw new Error("the reversal sweep must not report a reorg");
    },
    async reverseExpiredClearing(clearingId) {
      onReverse?.(clearingId);
      return reverseResult;
    },
  };
}

const APPLIED_RECORD = {
  ok: true,
  value: { state: "APPLIED", amount: 3000n, reduced: 3000n, deadline: 1000n, attestedDigestAtApply: ZERO_DIGEST },
};

test("the reversal sweep cranks a clearing whose deadline has passed", async () => {
  const written = [];
  let cranked = 0;
  const report = await sweepReversals(
    {
      client: reversalClient({
        record: APPLIED_RECORD,
        reverseResult: { ok: true, value: { txHash: "0xfeed", clearingState: "REVERSED" } },
        onReverse: () => { cranked += 1; },
      }),
      persist: async (replayKey, clearingState) => { written.push([replayKey, clearingState]); return { ok: true, value: 1 }; },
      chainTimestamp: async () => ({ ok: true, value: 1001 }),
      submit: true,
    },
    [{ replayKey: "0xaa" }],
  );

  assert.equal(report.ok, true);
  assert.equal(report.value.reversed, 1);
  assert.equal(report.value.failed, 0);
  assert.equal(cranked, 1);
  assert.equal(report.value.attempts[0].txHash, "0xfeed");
  assert.equal(report.value.attempts[0].stateAfter, "REVERSED");
  assert.deepEqual(written, [["0xaa", "REVERSED"]], "the state the chain reported is what is persisted");
});

test("the reversal sweep sends nothing while the deadline is in the future", async () => {
  let cranked = 0;
  const report = await sweepReversals(
    {
      client: reversalClient({ record: APPLIED_RECORD, reverseResult: { ok: false }, onReverse: () => { cranked += 1; } }),
      persist: async () => ({ ok: true, value: 1 }),
      // One second short. `TabBook` reverts `ClearingNotExpired` for exactly this.
      chainTimestamp: async () => ({ ok: true, value: 999 }),
      submit: true,
    },
    [{ replayKey: "0xaa" }],
  );

  assert.equal(report.value.notExpired, 1);
  assert.equal(report.value.reversed, 0);
  assert.equal(cranked, 0, "no transaction is sent before the deadline");
  assert.equal(report.value.attempts[0].secondsUntilDeadline, 1);
});

test("the deadline is read against Creditcoin's clock, not the host's", async () => {
  // The host clock is irrelevant here by construction: the only clock the sweep is
  // given is the chain's, and a value one second short refuses while a value one
  // second past cranks. A sweep that consulted `Date.now()` could not produce both
  // answers from the same fixture.
  const build = (chainNow) =>
    sweepReversals(
      {
        client: reversalClient({
          record: APPLIED_RECORD,
          reverseResult: { ok: true, value: { txHash: "0xfeed", clearingState: "REVERSED" } },
        }),
        persist: async () => ({ ok: true, value: 1 }),
        chainTimestamp: async () => ({ ok: true, value: chainNow }),
        submit: true,
      },
      [{ replayKey: "0xaa" }],
    );

  assert.equal((await build(999)).value.reversed, 0);
  assert.equal((await build(1000)).value.reversed, 1, "the deadline is inclusive, as `block.timestamp < deadline` is");
});

test("a clearing somebody else already reversed is recorded, not cranked again", async () => {
  const written = [];
  let cranked = 0;
  const report = await sweepReversals(
    {
      client: reversalClient({
        record: { ok: true, value: { state: "REVERSED", amount: 3000n, reduced: 3000n, deadline: 1000n, attestedDigestAtApply: ZERO_DIGEST } },
        reverseResult: { ok: false },
        onReverse: () => { cranked += 1; },
      }),
      persist: async (replayKey, clearingState) => { written.push([replayKey, clearingState]); return { ok: true, value: 1 }; },
      chainTimestamp: async () => ({ ok: true, value: 5000 }),
      submit: true,
    },
    [{ replayKey: "0xaa" }],
  );

  assert.equal(cranked, 0, "a permissionless crank means somebody else may have got there first");
  assert.equal(report.value.skipped, 1);
  assert.equal(report.value.attempts[0].skipped, "NOT_APPLIED");
  assert.deepEqual(written, [["0xaa", "REVERSED"]], "the stale row is corrected from the chain");
});

test("a clearing that confirmed in the meantime is recorded and left alone", async () => {
  const written = [];
  let cranked = 0;
  const report = await sweepReversals(
    {
      client: reversalClient({
        record: { ok: true, value: { state: "CONFIRMED", amount: 3000n, reduced: 3000n, deadline: 1000n, attestedDigestAtApply: ZERO_DIGEST } },
        reverseResult: { ok: false },
        onReverse: () => { cranked += 1; },
      }),
      persist: async (replayKey, clearingState) => { written.push([replayKey, clearingState]); return { ok: true, value: 1 }; },
      chainTimestamp: async () => ({ ok: true, value: 5000 }),
      submit: true,
    },
    [{ replayKey: "0xaa" }],
  );

  assert.equal(cranked, 0, "the Verified Settlement arrived, so there is nothing to reverse");
  assert.deepEqual(written, [["0xaa", "CONFIRMED"]]);
  assert.equal(report.value.reversed, 0);
});

test("a read-only sweep reports what it would crank and sends nothing", async () => {
  let cranked = 0;
  const report = await sweepReversals(
    {
      client: reversalClient({ record: APPLIED_RECORD, reverseResult: { ok: false }, onReverse: () => { cranked += 1; } }),
      persist: async () => ({ ok: true, value: 1 }),
      chainTimestamp: async () => ({ ok: true, value: 5000 }),
      submit: false,
    },
    [{ replayKey: "0xaa" }],
  );

  assert.equal(cranked, 0);
  assert.equal(report.value.skipped, 1);
  assert.equal(report.value.attempts[0].skipped, "READ_ONLY");
  assert.equal(report.value.attempts[0].secondsUntilDeadline, -4000, "the report still says it is overdue");
});

test("a crank that lands in a state other than Reversed is a failure, not a success", async () => {
  const report = await sweepReversals(
    {
      client: reversalClient({
        record: APPLIED_RECORD,
        // The read-back at the landing block still says Applied. Reporting that as a
        // reversal would leave the row out of the candidate set forever.
        reverseResult: { ok: true, value: { txHash: "0xfeed", clearingState: "APPLIED" } },
      }),
      persist: async () => ({ ok: true, value: 1 }),
      chainTimestamp: async () => ({ ok: true, value: 5000 }),
      submit: true,
    },
    [{ replayKey: "0xaa" }],
  );

  assert.equal(report.value.reversed, 0);
  assert.equal(report.value.failed, 1);
});

test("a candidate whose record cannot be read is reported, and the sweep continues", async () => {
  const report = await sweepReversals(
    {
      client: {
        async clearingOf(key) {
          return key === "0xaa"
            ? { ok: false, error: { category: "UPSTREAM", code: "CLEARING_READ_FAILED", message: "rpc down", retryable: true } }
            : APPLIED_RECORD;
        },
        async reverseExpiredClearing() {
          return { ok: true, value: { txHash: "0xfeed", clearingState: "REVERSED" } };
        },
        async applyProvisionalClearing() { throw new Error("unused"); },
        async reportReorg() { throw new Error("unused"); },
      },
      persist: async () => ({ ok: true, value: 1 }),
      chainTimestamp: async () => ({ ok: true, value: 5000 }),
      submit: true,
    },
    [{ replayKey: "0xaa" }, { replayKey: "0xbb" }],
  );

  assert.equal(report.value.failed, 1);
  assert.equal(report.value.reversed, 1, "one unreadable candidate does not stop the others");
});

test("a chain clock that cannot be read stops the sweep rather than guessing", async () => {
  const report = await sweepReversals(
    {
      client: reversalClient({ record: APPLIED_RECORD, reverseResult: { ok: false } }),
      persist: async () => ({ ok: true, value: 1 }),
      chainTimestamp: async () => ({ ok: false, error: { category: "UPSTREAM", code: "CREDITCOIN_BLOCK_UNAVAILABLE", message: "no block", retryable: true } }),
      submit: true,
    },
    [{ replayKey: "0xaa" }],
  );

  assert.equal(report.ok, false, "without the chain's clock there is no basis to crank anything");
  assert.equal(report.error.code, "CREDITCOIN_BLOCK_UNAVAILABLE");
});
