/**
 * The batch planner (R9.1, R9.4, R16.6, R16.7).
 *
 * Three bounds hold at once and the third is the one with teeth. The member count
 * and the block span are both checked by the contract, so getting them wrong costs
 * a reverted transaction and nothing more. Attestation-window adjacency is checked
 * by nobody: a batch whose members straddle a gap no digest chain can bridge is
 * accepted by the planner, refused by `mergeProofs` or by the precompile, and the
 * failure names the whole batch rather than the member that caused it.
 *
 * Bounds reads are faked here on a stride of 10, which is the stride measured on
 * both chains, so the windows in these cases are the windows the network has.
 *
 * Run against the built output, so what is tested is what the pipeline imports.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_BATCH_LIMITS, describePlan, planBatches } from "../dist/batch.js";

const LIMITS = { maxProofs: 10, maxSpan: 1000 };

/** Attestation endpoints land on a stride of 10, measured on both chains. */
const STRIDE = 10n;
const parentOf = (height) => (height / STRIDE) * STRIDE;
const childOf = (height) => (height % STRIDE === 0n ? height : parentOf(height) + STRIDE);

/**
 * A bounds reader over the real stride. `attestedBelow` is the frontier: a height
 * above it answers `isAttested: false`, which is what the live precompile does for
 * a block the attestors have not reached.
 */
function boundsOf({ attestedBelow = 10n ** 12n, fail = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    async bounds(chainKey, height) {
      calls.push({ chainKey, height });
      if (fail.has(height)) {
        return {
          ok: false,
          error: { category: "UPSTREAM", code: "CHAININFO_READ_FAILED", message: "no", retryable: true },
        };
      }
      return {
        ok: true,
        value: {
          parentHeight: parentOf(height),
          childHeight: childOf(height),
          childHash: `0x${"cc".repeat(32)}`,
          isAttested: height <= attestedBelow,
        },
      };
    },
  };
}

const candidate = (height, overrides = {}) => ({
  replayKey: `0x${height.toString(16).padStart(64, "0")}`,
  chainKey: 3,
  blockHeight: BigInt(height),
  sourceTxHash: `0x${"aa".repeat(32)}`,
  ...overrides,
});

test("the contract's own bounds are mirrored, so a misconfiguration is refused here", () => {
  assert.equal(CONTRACT_BATCH_LIMITS.maxProofs, 10);
  assert.equal(CONTRACT_BATCH_LIMITS.maxSpan, 1000);
});

test("members in one attestation window form one batch", async () => {
  const planning = await planBatches(
    [candidate(1001), candidate(1002), candidate(1005)],
    LIMITS,
    boundsOf(),
  );
  assert.equal(planning.ok, true);
  assert.equal(planning.value.plans.length, 1);
  const [plan] = planning.value.plans;
  assert.equal(plan.members.length, 3);
  assert.equal(plan.lowestHeight, 1001n);
  assert.equal(plan.highestHeight, 1005n);
  assert.equal(plan.lowerEndpoint, 1000n);
  assert.equal(plan.upperEndpoint, 1010n);
});

test("members in adjacent windows share an endpoint and still batch together", async () => {
  // 1005's window is 1000 to 1010 and 1012's is 1010 to 1020. They touch at 1010,
  // so one digest chain from 1000 to 1020 covers both.
  const planning = await planBatches([candidate(1005), candidate(1012)], LIMITS, boundsOf());
  assert.equal(planning.ok, true);
  assert.equal(planning.value.plans.length, 1);
  assert.equal(planning.value.plans[0].lowerEndpoint, 1000n);
  assert.equal(planning.value.plans[0].upperEndpoint, 1020n);
});

test("a gap between windows splits the batch, because no chain bridges it", async () => {
  // 1005 tops out at 1010; 1085's window starts at 1080. Nothing links them, and a
  // batch spanning both is what `mergeProofs` refuses.
  const planning = await planBatches([candidate(1005), candidate(1085)], LIMITS, boundsOf());
  assert.equal(planning.ok, true);
  assert.equal(planning.value.plans.length, 2);
  assert.deepEqual(
    planning.value.plans.map((plan) => plan.members.length),
    [1, 1],
  );
  assert.equal(planning.value.plans[0].upperEndpoint, 1010n);
  assert.equal(planning.value.plans[1].lowerEndpoint, 1080n);
});

test("the member bound closes a batch at exactly ten and opens the next", async () => {
  // Eleven contiguous heights inside one window: the split is the count bound and
  // nothing else, so the eleventh starts a second batch rather than being dropped.
  const heights = Array.from({ length: 11 }, (_, index) => 2001 + index);
  const planning = await planBatches(heights.map(candidate), LIMITS, boundsOf());
  assert.equal(planning.ok, true);
  assert.deepEqual(
    planning.value.plans.map((plan) => plan.members.length),
    [10, 1],
  );
  assert.equal(planning.value.deferred.length, 0);
});

test("the span bound closes a batch, measured from the batch's own lowest member", async () => {
  // Adjacency has to be held out of the way to see the span bound alone, so this
  // reader puts every height in one window. On the real stride of 10 two heights
  // 1000 apart are never adjacent anyway, which is worth knowing: the span bound
  // is the looser of the two and the one that almost never binds in practice.
  const oneWindow = {
    async bounds() {
      return {
        ok: true,
        value: {
          parentHeight: 0n,
          childHeight: 10n ** 9n,
          childHash: `0x${"cc".repeat(32)}`,
          isAttested: true,
        },
      };
    },
  };

  // The contract measures `highest - lowest`, so 1000 is legal and 1001 is not.
  const exact = await planBatches(
    [candidate(3000), candidate(4000)],
    { maxProofs: 10, maxSpan: 1000 },
    oneWindow,
  );
  assert.equal(exact.value.plans.length, 1, "a span of exactly 1000 blocks is one batch");

  const over = await planBatches(
    [candidate(3000), candidate(4001)],
    { maxProofs: 10, maxSpan: 1000 },
    oneWindow,
  );
  assert.equal(over.value.plans.length, 2, "a span of 1001 blocks is two");
});

test("two heights a full span apart are split by adjacency long before the span bound", async () => {
  // Recorded because it is the practical shape: attestations land every 10 blocks,
  // so the 1000-block ceiling R9.4 sets is never what closes a batch on this
  // network. Proof availability is, exactly as the requirement's own note says.
  const planning = await planBatches(
    [candidate(3000), candidate(4000)],
    { maxProofs: 10, maxSpan: 1000 },
    boundsOf(),
  );
  assert.equal(planning.value.plans.length, 2);
});

test("a height above the attested frontier is deferred, never planned", async () => {
  // The contract would refuse it and the proof cannot be built yet, so planning it
  // would spend a round trip to learn that.
  const planning = await planBatches(
    [candidate(1005), candidate(9005)],
    LIMITS,
    boundsOf({ attestedBelow: 2000n }),
  );
  assert.equal(planning.ok, true);
  assert.equal(planning.value.plans.length, 1);
  assert.equal(planning.value.plans[0].members[0].blockHeight, 1005n);
  assert.equal(planning.value.deferred.length, 1);
  assert.equal(planning.value.deferred[0].reason, "NOT_YET_ATTESTED");
  assert.equal(planning.value.deferred[0].error, undefined);
});

test("an unreadable bounds read defers its member and leaves the others planned", async () => {
  const planning = await planBatches(
    [candidate(1001), candidate(1002)],
    LIMITS,
    boundsOf({ fail: new Set([1002n]) }),
  );
  assert.equal(planning.ok, true);
  assert.equal(planning.value.plans.length, 1);
  assert.equal(planning.value.plans[0].members.length, 1);
  assert.equal(planning.value.deferred[0].reason, "BOUNDS_UNREADABLE");
  assert.notEqual(planning.value.deferred[0].error, undefined);
});

test("one bounds read serves every member in a block", async () => {
  // Two Settlements in one Source Chain transaction share a height, and asking the
  // precompile twice for one answer is a round trip spent on nothing.
  const reader = boundsOf();
  await planBatches([candidate(1001), candidate(1001), candidate(1001)], LIMITS, reader);
  assert.equal(reader.calls.length, 1);
});

test("chains are planned separately, because a batch is one chainKey", async () => {
  const planning = await planBatches(
    [candidate(1001), candidate(1002, { chainKey: 1 })],
    LIMITS,
    boundsOf(),
  );
  assert.equal(planning.ok, true);
  assert.equal(planning.value.plans.length, 2);
  assert.deepEqual(planning.value.plans.map((plan) => plan.chainKey).sort(), [1, 3]);
});

test("members arrive in whatever order and are planned in height order", async () => {
  const planning = await planBatches(
    [candidate(1005), candidate(1001), candidate(1003)],
    LIMITS,
    boundsOf(),
  );
  assert.equal(planning.ok, true);
  assert.deepEqual(
    planning.value.plans[0].members.map((member) => member.blockHeight),
    [1001n, 1003n, 1005n],
  );
});

test("nothing to plan is an empty plan, not an error", async () => {
  const planning = await planBatches([], LIMITS, boundsOf());
  assert.equal(planning.ok, true);
  assert.deepEqual(planning.value.plans, []);
  assert.deepEqual(planning.value.deferred, []);
});

test("a configured limit past the contract's own is refused before any read", async () => {
  const reader = boundsOf();
  const tooMany = await planBatches([candidate(1001)], { maxProofs: 11, maxSpan: 1000 }, reader);
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.error.code, "BATCH_LIMIT_INVALID");

  const tooWide = await planBatches([candidate(1001)], { maxProofs: 10, maxSpan: 1001 }, reader);
  assert.equal(tooWide.ok, false);
  assert.equal(tooWide.error.code, "BATCH_LIMIT_INVALID");

  const tooFew = await planBatches([candidate(1001)], { maxProofs: 0, maxSpan: 1000 }, reader);
  assert.equal(tooFew.ok, false);
  assert.equal(tooFew.error.code, "BATCH_LIMIT_INVALID");

  assert.equal(reader.calls.length, 0, "a refused configuration costs no round trip");
});

test("a plan describes itself with both its heights and its chain", async () => {
  const planning = await planBatches([candidate(1001), candidate(1005)], LIMITS, boundsOf());
  const line = describePlan(planning.value.plans[0]);
  assert.match(line, /chainKey 3/);
  assert.match(line, /2 member/);
  assert.match(line, /1001 to 1005/);
  assert.match(line, /1000 to 1010/);
});
