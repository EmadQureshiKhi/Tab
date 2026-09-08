/**
 * The judgements each act makes before it touches a chain.
 *
 * Every function here decides whether an act can run and what it would do, and
 * each has cases a live pass cannot stage on demand: an authorisation that lapsed
 * an hour ago, a cast where both agents hold a smart account, a readiness report
 * where the blocking precondition belongs to act one rather than act four.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assessReadiness } from "../dist/acts/stage.js";
import { assessAuthorisation, AUTHORISE_GAS_LIMIT } from "../dist/acts/authorise.js";
import { castSmartAccount } from "../dist/acts/smart-account.js";
import { bindingTargets } from "../dist/acts/bind.js";
import { meteringDigest, toolWord, DEFAULT_TOOL, METERED_PATH } from "../dist/acts/consume.js";

const ADA = {
  name: "Ada",
  role: "settles from her own wallet",
  creditcoin: "0x1F6f797Edc2EECb02BD54009B805fb2E99F80542",
  ethereum: "0xA302940db97345c5aDAF8dA23Ff46Ae63613d728",
};
const BEX = {
  name: "Bex",
  role: "settles through a smart account",
  creditcoin: "0xE5eaB26CaE0855BcCaBBb9A64faFce28C8432b37",
  ethereum: "0xE5eaB26CaE0855BcCaBBb9A64faFce28C8432b37",
  smartAccount: "0x623B7059c9E67C690594085D280d50449Eb7D1d9",
};

// -------------------------------------------------------------------- readiness

const precondition = (id, act, met) => ({ id, neededByAct: act, met, found: id });

test("a readiness report with nothing unmet is ready and lists nothing", () => {
  const readiness = assessReadiness([precondition("a", 1, true), precondition("b", 4, true)]);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.unmet, []);
  assert.equal(readiness.firstBlockedAct, undefined);
});

test("the blocked act reported is the earliest one, not the first found", () => {
  const readiness = assessReadiness([
    precondition("late", 4, false),
    precondition("early", 1, false),
    precondition("fine", 2, true),
  ]);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.firstBlockedAct, 1);
  assert.deepEqual(readiness.unmet.map((p) => p.id), ["late", "early"]);
});

test("an empty report is vacuously ready", () => {
  assert.equal(assessReadiness([]).ready, true);
});

// ---------------------------------------------------------------- authorisation

const NOW = 1_800_000_000;
const authorised = (overrides = {}) => ({
  authorised: true,
  authorisationCeiling: 1_000_000n,
  authorisationSpent: 0n,
  authorisationExpiry: NOW + 3_600,
  ...overrides,
});

test("an authorisation with room to spare is adequate", () => {
  const verdict = assessAuthorisation(authorised(), 10_000n, NOW);
  assert.equal(verdict.adequate, true);
  assert.equal(verdict.remaining, 1_000_000n);
});

test("no authorisation at all is inadequate and says so plainly", () => {
  const verdict = assessAuthorisation(authorised({ authorised: false }), 10_000n, NOW);
  assert.equal(verdict.adequate, false);
  assert.equal(verdict.remaining, 0n);
  assert.match(verdict.reason, /no authorisation/);
});

test("a lapsed authorisation is inadequate however much ceiling is left", () => {
  const verdict = assessAuthorisation(authorised({ authorisationExpiry: NOW - 1 }), 1n, NOW);
  assert.equal(verdict.adequate, false);
  assert.match(verdict.reason, /expired/);
});

test("an authorisation expiring exactly now has already lapsed", () => {
  assert.equal(assessAuthorisation(authorised({ authorisationExpiry: NOW }), 1n, NOW).adequate, false);
});

test("a ceiling with less room than the act needs is inadequate", () => {
  const verdict = assessAuthorisation(
    authorised({ authorisationCeiling: 15_000n, authorisationSpent: 10_000n }),
    10_000n,
    NOW,
  );
  assert.equal(verdict.adequate, false);
  assert.equal(verdict.remaining, 5_000n);
  assert.match(verdict.reason, /5000 base units remain/);
});

test("a ceiling with exactly enough room is adequate", () => {
  const verdict = assessAuthorisation(
    authorised({ authorisationCeiling: 20_000n, authorisationSpent: 10_000n }),
    10_000n,
    NOW,
  );
  assert.equal(verdict.adequate, true);
  assert.equal(verdict.remaining, 10_000n);
});

test("spending past the ceiling floors the remainder at zero rather than going negative", () => {
  const verdict = assessAuthorisation(
    authorised({ authorisationCeiling: 1_000n, authorisationSpent: 5_000n }),
    1n,
    NOW,
  );
  assert.equal(verdict.remaining, 0n);
  assert.equal(verdict.adequate, false);
});

test("the stated gas limit sits above the 307,986 measured for authorise", () => {
  assert.ok(AUTHORISE_GAS_LIMIT > 307_986n);
});

// -------------------------------------------------------------- smart-account casting

test("one holder and one other Agent casts cleanly", () => {
  const casting = castSmartAccount([ADA, BEX]);
  assert.equal(casting.ok, true);
  assert.equal(casting.value.holder.name, "Bex");
  assert.equal(casting.value.sender.name, "Ada");
  assert.equal(casting.value.smartAccount, BEX.smartAccount);
});

test("no smart account anywhere means no transaction can separate the two roles", () => {
  const refused = castSmartAccount([ADA, { ...BEX, smartAccount: undefined }]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "DEMO_NO_SMART_ACCOUNT");
});

test("two smart accounts leave it ambiguous who sends", () => {
  const refused = castSmartAccount([{ ...ADA, smartAccount: BEX.smartAccount }, BEX]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "DEMO_TOO_MANY_SMART_ACCOUNTS");
});

test("a single Agent holding the smart account leaves nobody distinct to send", () => {
  const refused = castSmartAccount([BEX]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "DEMO_NO_DISTINCT_SENDER");
});

// -------------------------------------------------------------------- binding targets

test("wallets are bound before smart accounts, because a wallet pays for one", () => {
  const targets = bindingTargets([ADA, BEX], [ADA, BEX]);
  assert.deepEqual(targets.map((t) => t.sourceAddress), [ADA.ethereum, BEX.ethereum, BEX.smartAccount]);
  assert.deepEqual(targets.map((t) => t.viaSmartAccount), [false, false, true]);
  assert.deepEqual(targets.map((t) => t.index), [0, 1, 1]);
});

test("restricting the scope to one Agent leaves the cast index intact", () => {
  const targets = bindingTargets([BEX], [ADA, BEX]);
  assert.deepEqual(targets.map((t) => t.index), [1, 1]);
});

test("an Agent with no smart account contributes one target", () => {
  assert.equal(bindingTargets([ADA], [ADA, BEX]).length, 1);
});

// ------------------------------------------------------------------ metering digest

test("the metering digest is newline-separated in a fixed order", () => {
  // Pinned against the literal string the gateway's own `meteringDigest`
  // produces. This file may not depend on the gateway package, so the copy here
  // is defended by this assertion: a change on the gateway's side that this file
  // did not follow becomes a failure here rather than an unexplained 401 in a
  // live run.
  const digest = meteringDigest({
    method: "post",
    path: "/meter/proof",
    agent: "0x1F6f797Edc2EECb02BD54009B805fb2E99F80542",
    tool: `0x${"33".repeat(32)}`,
    units: 1,
    issuedAt: 1_788_700_000_000,
  });
  assert.equal(
    digest,
    [
      "tab-metering-request",
      "POST",
      "/meter/proof",
      "0x1f6f797edc2eecb02bd54009b805fb2e99f80542",
      `0x${"33".repeat(32)}`,
      "1",
      "1788700000000",
    ].join("\n"),
  );
});

test("changing any bound field changes the digest", () => {
  const base = {
    method: "POST",
    path: METERED_PATH,
    agent: ADA.creditcoin,
    tool: toolWord(DEFAULT_TOOL),
    units: 1,
    issuedAt: 1_788_700_000_000,
  };
  const original = meteringDigest(base);
  for (const change of [
    { method: "GET" },
    { path: "/meter/other" },
    { agent: BEX.creditcoin },
    { tool: toolWord("proof.verify") },
    { units: 2 },
    { issuedAt: 1_788_700_000_001 },
  ]) {
    assert.notEqual(meteringDigest({ ...base, ...change }), original, JSON.stringify(change));
  }
});

test("a tool name is right-padded to a word, and a word passes through lowercased", () => {
  assert.equal(
    toolWord("proof.generate"),
    "0x70726f6f662e67656e657261746500000000000000000000000000000000000000".slice(0, 66),
  );
  assert.equal(toolWord(`0x${"AB".repeat(32)}`), `0x${"ab".repeat(32)}`);
  assert.equal(toolWord(DEFAULT_TOOL).length, 66);
});
