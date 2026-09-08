/**
 * The arithmetic the demo's claims rest on.
 *
 * `resolvePayerVerdict` is the assertion requirement 8 asks for, and the cases
 * below are the ones a live run can never stage: the wrong Agent credited, the
 * sending Agent credited as well, a partial credit, and the degenerate casting
 * where both roles fall to one Agent. A claim that is only ever observed once,
 * live, on the happy path is not a tested claim.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { diffLedger, resolvePayerVerdict } from "../dist/ledger.js";

const ADA = "0x1F6f797Edc2EECb02BD54009B805fb2E99F80542";
const BEX = "0xE5eaB26CaE0855BcCaBBb9A64faFce28C8432b37";

const ledger = (agent, overrides = {}) => ({
  agent,
  tabId: `0x${"11".repeat(32)}`,
  open: 0n,
  prepaid: 0n,
  deliveryCount: 0,
  authorisationCeiling: 1_000_000n,
  authorisationSpent: 0n,
  authorisationExpiry: 1_800_000_000,
  authorised: true,
  historyCount: 0,
  historyCommitment: `0x${"22".repeat(32)}`,
  walletBalance: 0n,
  atBlock: 100,
  ...overrides,
});

const quiet = (agent) => diffLedger(ledger(agent), ledger(agent));

test("two identical readings differ by nothing and say so", () => {
  const delta = quiet(ADA);
  assert.equal(delta.quiet, true);
  assert.equal(delta.open, 0n);
  assert.equal(delta.historyCount, 0);
});

test("every field is differenced with its sign kept", () => {
  const before = ledger(ADA, {
    open: 7_000n,
    prepaid: 1_000n,
    deliveryCount: 3,
    authorisationSpent: 230_000n,
    historyCount: 4,
    walletBalance: 53_777_000n,
    smartAccountBalance: 718_999n,
  });
  const after = ledger(ADA, {
    open: 0n,
    prepaid: 4_000n,
    deliveryCount: 4,
    authorisationSpent: 240_000n,
    historyCount: 5,
    walletBalance: 53_767_000n,
    smartAccountBalance: 708_999n,
  });
  const delta = diffLedger(before, after);
  assert.equal(delta.quiet, false);
  assert.equal(delta.open, -7_000n);
  assert.equal(delta.prepaid, 3_000n);
  assert.equal(delta.deliveryCount, 1);
  assert.equal(delta.authorisationSpent, 10_000n);
  assert.equal(delta.historyCount, 1);
  assert.equal(delta.walletBalance, -10_000n);
  assert.equal(delta.smartAccountBalance, -10_000n);
});

test("a missing smart-account balance counts as zero on both sides", () => {
  const delta = diffLedger(ledger(ADA), ledger(ADA, { smartAccountBalance: 500n }));
  assert.equal(delta.smartAccountBalance, 500n);
});

test("differencing two different agents throws rather than returning zeroes", () => {
  assert.throws(() => diffLedger(ledger(ADA), ledger(BEX)), /two different agents/);
});

const KEY = `0x${"aa".repeat(32)}`;

const verdictFor = ({
  creditedAgent,
  applied = 0n,
  toPrepaid = 0n,
  coveredByClearing = 0n,
  amount = 10_000n,
}) =>
  resolvePayerVerdict({
    topicAgent: { name: "Bex", creditcoin: BEX },
    senderAgent: { name: "Ada", creditcoin: ADA },
    amount,
    attribution: { replayKey: KEY, creditedAgent, applied, toPrepaid, coveredByClearing },
  });

test("the Settlement's own event crediting the topic Agent in full is a pass", () => {
  const resolution = verdictFor({ creditedAgent: BEX, applied: 10_000n });
  assert.equal(resolution.verdict, "PASS");
  assert.equal(resolution.creditLandedOnTopicAgent, true);
  assert.equal(resolution.senderAgentUncredited, true);
  assert.match(resolution.reasons[0], /credited Bex, the Agent bound to topics\[1\]/);
  assert.match(resolution.reasons[1], /whole 10000 base units reached it/);
  assert.match(resolution.reasons[2], /resolving the payer from the sender would have been wrong/);
});

test("a split between the tab and prepaid credit is still the whole amount", () => {
  const resolution = verdictFor({ creditedAgent: BEX, applied: 4_000n, toPrepaid: 6_000n });
  assert.equal(resolution.verdict, "PASS");
  assert.match(resolution.reasons[1], /4000 against the Open Tab, 6000 banked as prepaid credit/);
});

test("a payment banked entirely as prepaid credit is still a credit", () => {
  assert.equal(verdictFor({ creditedAgent: BEX, toPrepaid: 10_000n }).verdict, "PASS");
});

test("a Settlement a Provisional Clearing already covered still accounts for the whole amount", () => {
  // The ordinary path, and the one an amount check naively written fails on.
  // `applyVerifiedSettlement` takes the confirming branch when a clearing covered
  // the tab and emits `applied = 0`, banking only the excess, because the covered
  // part came off the Open Tab at clearing time against pledged Bond. Measured
  // live: a 10,000 Settlement whose clearing had reduced 7,000 emitted
  // `applied = 0, toPrepaid = 3,000`.
  const resolution = verdictFor({ creditedAgent: BEX, toPrepaid: 3_000n, coveredByClearing: 7_000n });
  assert.equal(resolution.verdict, "PASS");
  assert.match(resolution.reasons[1], /7000 already taken off by the Provisional Clearing/);
});

test("a clearing covering the whole amount leaves nothing to apply or bank", () => {
  assert.equal(verdictFor({ creditedAgent: BEX, coveredByClearing: 10_000n }).verdict, "PASS");
});

test("a clearing that does not close the gap is still a fail", () => {
  const resolution = verdictFor({ creditedAgent: BEX, toPrepaid: 1_000n, coveredByClearing: 2_000n });
  assert.equal(resolution.verdict, "FAIL");
  assert.match(resolution.reasons[1], /it received 3000 base units/);
});

test("the event naming the sending Agent is the failure this act exists to catch", () => {
  const resolution = verdictFor({ creditedAgent: ADA, applied: 10_000n });
  assert.equal(resolution.verdict, "FAIL");
  assert.equal(resolution.creditLandedOnTopicAgent, false);
  assert.equal(resolution.senderAgentUncredited, false);
  assert.match(resolution.reasons[0], new RegExp(ADA));
  assert.match(resolution.reasons[2], /credited Ada, which is the payer resolved from the sender/);
});

test("the event naming a third Agent fails the positive half and passes the negative one", () => {
  const stranger = "0x0000000000000000000000000000000000000009";
  const resolution = verdictFor({ creditedAgent: stranger, applied: 10_000n });
  assert.equal(resolution.verdict, "FAIL");
  assert.equal(resolution.creditLandedOnTopicAgent, false);
  assert.equal(resolution.senderAgentUncredited, true);
});

test("the right Agent credited for the wrong amount is a fail", () => {
  const resolution = verdictFor({ creditedAgent: BEX, applied: 6_000n });
  assert.equal(resolution.verdict, "FAIL");
  assert.equal(resolution.creditLandedOnTopicAgent, false);
  assert.equal(resolution.senderAgentUncredited, true);
  assert.match(resolution.reasons[1], /it received 6000 base units/);
});

test("the address comparison is case-insensitive, as chain addresses always are", () => {
  assert.equal(verdictFor({ creditedAgent: BEX.toLowerCase(), applied: 10_000n }).verdict, "PASS");
  assert.equal(verdictFor({ creditedAgent: ADA.toUpperCase().replace("0X", "0x"), applied: 10_000n }).senderAgentUncredited, false);
});

test("both roles played by one Agent is refused rather than passed", () => {
  const resolution = resolvePayerVerdict({
    topicAgent: { name: "Ada", creditcoin: ADA },
    senderAgent: { name: "Ada", creditcoin: ADA },
    amount: 10_000n,
    attribution: { replayKey: KEY, creditedAgent: ADA, applied: 10_000n, toPrepaid: 0n, coveredByClearing: 0n },
  });
  assert.equal(resolution.verdict, "FAIL");
  assert.match(resolution.reasons[0], /cannot distinguish them/);
});

test("a Settlement of nothing attributes nothing", () => {
  for (const amount of [0n, -1n]) {
    const resolution = verdictFor({ creditedAgent: BEX, amount });
    assert.equal(resolution.verdict, "FAIL");
    assert.match(resolution.reasons[0], /moved nothing/);
  }
});
