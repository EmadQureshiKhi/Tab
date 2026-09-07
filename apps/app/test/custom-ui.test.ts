/**
 * Tests for the composites in `components/custom-ui`.
 *
 * Two kinds of assertion, because the composites carry two kinds of rule.
 *
 * **Behaviour.** The numeric rule and the countdown are pure functions, so they
 * are exercised directly: the decimal form of an amount must re-parse to exactly
 * the base-unit integer it came from, at every scale, and the countdown must
 * never claim time remains once the deadline has passed.
 *
 * **Source contract.** The rules a type checker cannot express: that every
 * colour a composite names is a theme token the contrast gate has measured, that
 * the clearing badge carries all three of its redundant channels, and that the
 * clearing set draws a distinct glyph per state.
 *
 * What is *not* in scope here is behaviour under an assistive technology. These
 * tests establish that the mechanism is present and cannot be removed silently;
 * whether a given screen reader announces it well is a question for a manual
 * pass with real assistive technology.
 *
 * Requirements: 15.7, 24.10, 11.8, 11.9
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  bondSegments,
  derivedFreeBaseUnits,
  freeBaseUnits,
  isLedgerConsistent,
} from "../components/custom-ui/bond";
import {
  CLEARING_STATES,
  clearingStateDescriptor,
  isClearingState,
} from "../components/custom-ui/clearing-state";
import {
  describeDeadline,
  formatAssetAmount,
  formatDurationShort,
  formatDurationSpoken,
  formatInstantUtc,
  shareOf,
  toDecimalUnits,
} from "../components/custom-ui/format";
import {
  SERVICE_TIERS,
  tierAccessibleName,
  tierDescriptor,
} from "../components/custom-ui/tier";

const DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "components", "custom-ui");

const USDC = { symbol: "USDC", decimals: 6 } as const;

/** The colour names the Tailwind namespace is rebuilt from in `styles/`. */
/*
 * Every colour name a composite may reach for.
 *
 * Two layers, and the same rule over both: a colour in a class must have been
 * declared somewhere a reader can find it. The generated set is what the contrast
 * gate measures, and the five clearing tokens, the two tier tokens, `badge-ink`
 * and `focus-ring` stay in it untouched because they carry meaning rather than
 * decoration. The rest is the presentation vocabulary mapped from the reference
 * and declared in `styles/reference.css`, including only the ramp steps in use.
 */
const TOKEN_COLOURS = [
  "surface",
  "surface-raised",
  "text",
  "text-muted",
  "accent",
  "stroke",
  "clearing-applied",
  "clearing-confirmed",
  "clearing-reversed",
  "clearing-declined",
  "clearing-superseded",
  "tier-curated",
  "tier-permissionless",
  "badge-ink",
  "focus-ring",
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "muted-2",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "white",
  "black",
  "teal-200",
  "teal-300",
  "teal-400",
  "teal-500",
  "teal-600",
  "teal-700",
  "teal-800",
  "neutral-400",
  "amber-500",
  "slate-300",
  "slate-400",
  "slate-500",
  "slate-600",
  "slate-700",
  "blue-400",
  "blue-600",
  "amber-400",
  "amber-600",
  "gray-200",
  "gray-400",
  "gray-600",
  "gray-800",
];

function sourceFiles(): readonly { readonly name: string; readonly text: string }[] {
  return readdirSync(DIRECTORY)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => ({ name, text: readFileSync(join(DIRECTORY, name), "utf8") }));
}

/* ------------------------------------------------------------------ numbers */

test("an amount renders as decimal Asset units with its symbol", () => {
  assert.equal(formatAssetAmount(5_000_000n, USDC).text, "5.00 USDC");
  assert.equal(formatAssetAmount(0n, USDC).text, "0.00 USDC");
  assert.equal(formatAssetAmount(1n, USDC).text, "0.000001 USDC");
  assert.equal(formatAssetAmount(1_234_567n, USDC).text, "1.234567 USDC");
  assert.equal(formatAssetAmount(1_000_000_000_000n, USDC).text, "1,000,000.00 USDC");
  assert.equal(toDecimalUnits(7n, 0), "7");
});

test("the title carries the exact base-unit integer and its scale", () => {
  const amount = formatAssetAmount(999_999_999_999n, USDC);
  assert.equal(amount.baseUnits, "999999999999");
  assert.equal(amount.title, "999999999999 base units (USDC, 6 decimals)");
});

test("the decimal form re-parses to exactly the base units it came from", () => {
  // A deterministic generator, so a failure is reproducible rather than a story
  // about one unlucky run.
  let seed = 0x2f6e2b1;
  const nextInt = (): number => {
    seed = (seed * 48271) % 0x7fffffff;
    return seed;
  };

  const parseBack = (decimal: string, decimals: number): bigint => {
    const negative = decimal.startsWith("-");
    const body = (negative ? decimal.slice(1) : decimal).replace(/,/g, "");
    const [whole = "0", fraction = ""] = body.split(".");
    const padded = fraction.padEnd(decimals, "0");
    const magnitude =
      BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded.length === 0 ? "0" : padded);
    return negative ? -magnitude : magnitude;
  };

  let checked = 0;
  for (const decimals of [0, 2, 6, 18]) {
    for (let index = 0; index < 500; index += 1) {
      const magnitude = BigInt(nextInt()) * BigInt(nextInt()) * BigInt(index + 1);
      const value = index % 3 === 0 ? -magnitude : magnitude;
      const decimal = toDecimalUnits(value, decimals);
      assert.equal(parseBack(decimal, decimals), value, `${decimal} at ${decimals} decimals`);
      checked += 1;
    }
  }
  assert.equal(checked, 2000);
});

test("an implausible token scale is refused rather than guessed at", () => {
  assert.throws(() => toDecimalUnits(1n, -1), RangeError);
  assert.throws(() => toDecimalUnits(1n, 1.5), RangeError);
  assert.throws(() => toDecimalUnits(1n, 37), RangeError);
});

/* ---------------------------------------------------------------- countdown */

test("a countdown states the time remaining before the deadline", () => {
  const deadline = 1_700_000_000_000;
  const pending = describeDeadline(deadline, deadline - (12 * 60 + 30) * 1000);
  assert.equal(pending.passed, false);
  assert.equal(pending.short, "12m 30s");
  assert.equal(pending.spoken, "12 minutes 30 seconds");
});

test("a countdown never claims time remains once the deadline has passed", () => {
  const deadline = 1_700_000_000_000;

  // At the deadline exactly, and after it, the answer is the same: passed.
  assert.equal(describeDeadline(deadline, deadline).passed, true);

  const after = describeDeadline(deadline, deadline + 185_000);
  assert.equal(after.passed, true);
  assert.equal(after.short, "3m 5s");
  assert.equal(after.spoken, "3 minutes 5 seconds");

  // And the badge has copy for that case rather than falling through to a zero.
  const badge = readFileSync(join(DIRECTORY, "clearing-badge.tsx"), "utf8");
  assert.match(badge, /deadline passed/);
  assert.match(badge, /due to be reversed/);
});

test("durations read sensibly at their boundaries", () => {
  assert.equal(formatDurationShort(0), "0s");
  assert.equal(formatDurationSpoken(0), "less than a second");
  assert.equal(formatDurationSpoken(61_000), "1 minute 1 second");
  assert.equal(formatDurationShort(27 * 60 * 60 * 1000), "1d 3h");
  assert.equal(formatInstantUtc(0), "1970-01-01 00:00 UTC");
});

/* --------------------------------------------------------- clearing states */

test("the clearing lifecycle has exactly five states, each with its own colour", () => {
  assert.equal(CLEARING_STATES.length, 5);
  assert.deepEqual(
    CLEARING_STATES.map((state) => clearingStateDescriptor(state).label),
    ["Provisional", "Confirmed", "Reversed", "Declined", "Superseded"],
  );
  assert.equal(new Set(CLEARING_STATES.map((s) => clearingStateDescriptor(s).token)).size, 5);
  assert.equal(new Set(CLEARING_STATES.map((s) => clearingStateDescriptor(s).tone)).size, 5);

  for (const state of CLEARING_STATES) {
    const descriptor = clearingStateDescriptor(state);
    assert.ok(descriptor.meaning.length > 40, `${state} explains itself`);
    assert.equal(descriptor.carriesDeadline, state === "provisional");
  }

  assert.equal(isClearingState("provisional"), true);
  assert.equal(isClearingState("applied"), false);
});

test("Declined is described as a Bond shortfall, not a failed Settlement", () => {
  const { meaning } = clearingStateDescriptor("declined");
  assert.match(meaning, /free Bond did not cover/);
  assert.match(meaning, /Open Tab is unchanged/);
  assert.match(meaning, /did not fail/);
});

test("the clearing badge carries text, an icon, and colour, and names all three", () => {
  const badge = readFileSync(join(DIRECTORY, "clearing-badge.tsx"), "utf8");

  // colour: a tone handed to the primitive, never a bare colour class here
  assert.match(badge, /tone=\{descriptor\.tone\}/);
  // text: the state word is always rendered
  assert.match(badge, /\{descriptor\.label\}/);
  // icon: one per state, and five distinct components
  for (const component of [
    "HourglassIcon",
    "CheckIcon",
    "ReturnArrowIcon",
    "SlashedCircleIcon",
    "StackedPanelsIcon",
  ]) {
    assert.match(badge, new RegExp(component), `${component} is wired to a state`);
  }
  // a name that spells the state out, on an element that carries a name
  assert.match(badge, /role="img"/);
  assert.match(badge, /aria-label=\{accessibleName\}/);
  assert.match(badge, /Clearing state: \$\{descriptor\.label\}/);
});

/* ------------------------------------------------------------------- tiers */

test("a tier gates credit weight rather than recognition, and says so", () => {
  assert.deepEqual([...SERVICE_TIERS], ["permissionless", "curated"]);
  assert.equal(tierDescriptor("curated").carriesCreditWeight, true);

  const permissionless = tierDescriptor("permissionless");
  assert.equal(permissionless.carriesCreditWeight, false);
  assert.match(permissionless.meaning, /paid in full/);
  assert.match(permissionless.meaning, /weight of zero/);

  assert.ok(tierAccessibleName("permissionless", "Asset").startsWith("Asset curation tier:"));
  assert.ok(tierAccessibleName("curated", "Service").startsWith("Service curation tier:"));
});

/* -------------------------------------------------------------------- bond */

test("free Bond is staked minus reserved, slashed, and released, per Asset", () => {
  const ledger = {
    asset: USDC,
    stakedBaseUnits: 100_000_000n,
    reservedBaseUnits: 20_000_000n,
    slashedBaseUnits: 5_000_000n,
    releasedBaseUnits: 15_000_000n,
  };

  assert.equal(derivedFreeBaseUnits(ledger), 60_000_000n);
  assert.equal(freeBaseUnits(ledger), 60_000_000n);
  assert.equal(freeBaseUnits({ ...ledger, freeBaseUnits: 59_000_000n }), 59_000_000n);
  assert.equal(isLedgerConsistent(ledger), true);
  assert.equal(isLedgerConsistent({ ...ledger, reservedBaseUnits: 90_000_000n }), false);

  const segments = bondSegments(ledger);
  assert.deepEqual(
    segments.map((segment) => segment.key),
    ["reserved", "slashed", "released", "free"],
  );
  assert.equal(
    segments.reduce((total, segment) => total + segment.baseUnits, 0n),
    ledger.stakedBaseUnits,
    "the four parts account for the whole stake",
  );
  assert.equal(new Set(segments.map((segment) => segment.fillClassName)).size, 4);
});

test("nothing in the Bond meter sums across Assets", () => {
  const bond = readFileSync(join(DIRECTORY, "bond.ts"), "utf8");
  const meter = readFileSync(join(DIRECTORY, "bond-meter.tsx"), "utf8");

  // One ledger per Asset, and copy that says why there is no total.
  assert.match(meter, /One ledger per Asset/);
  assert.match(meter, /no figure below is a total across Assets/);
  // The only reduction in either file is within one Asset's four parts.
  assert.equal((bond.match(/reduce\(/g) ?? []).length, 0);
});

test("shares stay inside their bounds", () => {
  assert.equal(shareOf(20_000_000n, 100_000_000n), 20);
  assert.equal(shareOf(200_000_000n, 100_000_000n), 100);
  assert.equal(shareOf(-1n, 100_000_000n), 0);
  assert.equal(shareOf(1n, 0n), 0);
});

/* --------------------------------------------------------- source contract */

test("every colour a composite names is a theme token", () => {
  const prefixes = ["bg", "text", "border", "outline", "ring", "fill", "stroke", "decoration"];
  const utility = new RegExp(`\\b(${prefixes.join("|")})-([a-z][a-z0-9-]*)`, "g");

  // Utilities in these families that are not colours at all.
  const NON_COLOUR = new Set([
    "text-xs",
    "text-sm",
    "text-base",
    "text-lg",
    "text-right",
    "text-left",
    "text-center",
    "text-inherit",
    "border-t",
    "border-t-0",
    "border-b",
    "border-transparent",
    "ring-0",
    "stroke-linecap",
    "decoration-1",
  ]);

  for (const file of sourceFiles()) {
    for (const match of file.text.matchAll(utility)) {
      const [full, , name = ""] = match;
      if (NON_COLOUR.has(full)) continue;
      // Word fragments from token names themselves, e.g. the `ring-applied` that
      // falls out of `clearing-applied`, are not utilities.
      if (!/[\s"'`]/.test(file.text.charAt(match.index - 1) || " ")) continue;
      assert.ok(
        TOKEN_COLOURS.includes(name) || NON_COLOUR.has(full),
        `${file.name} names \`${full}\`, which is not a theme token`,
      );
    }
  }
});

test("an amount always carries its exact base-unit value in a title", () => {
  const amount = readFileSync(join(DIRECTORY, "asset-amount.tsx"), "utf8");
  assert.match(amount, /title=\{amount\.title\}/);
  assert.match(amount, /\{amount\.symbol\}/);
});

test("all six composites are present and exported", () => {
  const index = readFileSync(join(DIRECTORY, "index.ts"), "utf8");
  for (const composite of [
    "ProofCard",
    "SettlementTimeline",
    "ClearingBadge",
    "CreditGauge",
    "TierBadge",
    "BondMeter",
  ]) {
    assert.match(index, new RegExp(`\\b${composite}\\b`), `${composite} is exported`);
  }
});

test("a proof card identifies a Verified Settlement by its replay key alone", () => {
  const card = readFileSync(join(DIRECTORY, "proof-card.tsx"), "utf8");
  assert.match(card, /packReplayKey/);
  for (const field of ["chainKey", "blockHeight", "txIndex", "logIndex"]) {
    assert.match(card, new RegExp(field), `${field} is shown`);
  }
  assert.doesNotMatch(card, /sourceTxHash/);
  assert.match(card, /carries no Source Chain transaction hash/);
});
