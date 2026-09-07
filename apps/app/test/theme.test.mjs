/**
 * Unit tests for the theme layer: the contrast arithmetic, the rounding the
 * published table uses, and the token derivation.
 *
 * The suite runs against the built output, in the same shape the rest of the
 * repository uses, so no test runner is added.
 *
 * Requirements: 24.8, 24.10
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contrastRatio,
  floorToTwoDecimals,
  formatRatio,
  parseHexColour,
  relativeLuminance,
  roundToTwoDecimals,
} from "../dist/theme/contrast.js";
import { loadPalette, modePalette } from "../dist/theme/palette.js";
import {
  LOW_CONTRAST_ALLOWLIST,
  TOKEN_PAIRS,
  TOKENS,
  pairThreshold,
  resolveTokenColour,
} from "../dist/theme/tokens.js";

test("relative luminance hits the two anchors of the scale", () => {
  assert.equal(relativeLuminance(parseHexColour("#000000")), 0);
  assert.equal(relativeLuminance(parseHexColour("#FFFFFF")), 1);
});

test("contrast ratio spans 1:1 to 21:1 and is symmetric", () => {
  assert.equal(roundToTwoDecimals(contrastRatio("#000000", "#FFFFFF")), 21);
  assert.equal(contrastRatio("#0B1220", "#0B1220"), 1);
  assert.equal(
    contrastRatio("#0B6B62", "#FFFFFF"),
    contrastRatio("#FFFFFF", "#0B6B62"),
  );
});

test("a malformed colour is rejected rather than coerced", () => {
  assert.throws(() => parseHexColour("0B1220"));
  assert.throws(() => parseHexColour("#0B122"));
  assert.throws(() => parseHexColour("#GGGGGG"));
});

test("rounding to two decimals rounds half away from zero, flooring does not", () => {
  assert.equal(roundToTwoDecimals(7.748997), 7.75);
  assert.equal(floorToTwoDecimals(7.748997), 7.74);
  assert.equal(formatRatio(5.7), "5.70");
});

test("every ratio published in the palette is reproducible", () => {
  const { palette } = loadPalette();
  assert.ok(palette.publishedRatios.length > 0);
  for (const row of palette.publishedRatios) {
    assert.equal(
      roundToTwoDecimals(contrastRatio(row.foreground, row.background)),
      row.ratio,
      `${row.pair} does not reproduce`,
    );
  }
});

test("tier, badge ink, and focus ring resolve through the palette, never to a colour of their own", () => {
  const { palette } = loadPalette();
  for (const mode of ["light", "dark"]) {
    const colours = modePalette(palette, mode);
    assert.equal(resolveTokenColour("tier-curated", colours), colours.accent);
    assert.equal(resolveTokenColour("tier-permissionless", colours), colours.textMuted);
    assert.equal(resolveTokenColour("badge-ink", colours), colours.surface);
    assert.equal(resolveTokenColour("focus-ring", colours), colours.accent);
    assert.equal(
      resolveTokenColour("clearing-superseded", colours),
      colours.clearing.superseded,
    );
  }
});

test("every token resolves to a colour drawn from the palette", () => {
  const { palette } = loadPalette();
  for (const mode of ["light", "dark"]) {
    const colours = modePalette(palette, mode);
    const fromPalette = new Set([
      colours.surface,
      colours.surfaceRaised,
      colours.text,
      colours.textMuted,
      colours.accent,
      colours.stroke,
      ...Object.values(colours.clearing),
    ]);
    for (const spec of TOKENS) {
      assert.ok(
        fromPalette.has(resolveTokenColour(spec.token, colours)),
        `${spec.token} resolves outside the palette in ${mode}`,
      );
    }
  }
});

test("a pair is held to the strictest ratio any of its roles demands", () => {
  const textPair = TOKEN_PAIRS.find((pair) => pair.id === "light.accent-on-surface");
  assert.ok(textPair);
  assert.equal(pairThreshold(textPair), 4.5);

  const boundaryPair = TOKEN_PAIRS.find((pair) => pair.id === "dark.stroke-on-surface");
  assert.ok(boundaryPair);
  assert.equal(pairThreshold(boundaryPair), 3);
});

test("pair identifiers are unique and both modes are covered", () => {
  const ids = new Set(TOKEN_PAIRS.map((pair) => pair.id));
  assert.equal(ids.size, TOKEN_PAIRS.length);
  assert.ok(TOKEN_PAIRS.some((pair) => pair.mode === "light"));
  assert.ok(TOKEN_PAIRS.some((pair) => pair.mode === "dark"));
});

test("every pair below the non-text floor carries a reason and a compensating pair", () => {
  const { palette } = loadPalette();
  const allowed = new Map(LOW_CONTRAST_ALLOWLIST.map((entry) => [entry.pairId, entry]));
  const ids = new Set(TOKEN_PAIRS.map((pair) => pair.id));

  for (const pair of TOKEN_PAIRS) {
    const colours = modePalette(palette, pair.mode);
    const ratio = roundToTwoDecimals(
      contrastRatio(
        resolveTokenColour(pair.foregroundToken, colours),
        resolveTokenColour(pair.backgroundToken, colours),
      ),
    );
    if (ratio >= 3) continue;
    const allowance = allowed.get(pair.id);
    assert.ok(allowance, `${pair.id} sits at ${ratio}:1 with no stated allowance`);
    assert.ok(allowance.reason.length >= 40, `${pair.id} states no usable reason`);
    assert.ok(allowance.compensatingPairIds.length > 0);
    for (const compensatingId of allowance.compensatingPairIds) {
      assert.ok(ids.has(compensatingId), `${compensatingId} is not a pair in the matrix`);
    }
  }
});

test("no allowance is stale: each allowed pair really is below the floor", () => {
  const { palette } = loadPalette();
  for (const allowance of LOW_CONTRAST_ALLOWLIST) {
    const pair = TOKEN_PAIRS.find((candidate) => candidate.id === allowance.pairId);
    assert.ok(pair, `${allowance.pairId} is not a pair in the matrix`);
    const colours = modePalette(palette, pair.mode);
    const ratio = contrastRatio(
      resolveTokenColour(pair.foregroundToken, colours),
      resolveTokenColour(pair.backgroundToken, colours),
    );
    assert.ok(ratio < 3, `${allowance.pairId} clears the floor, so its allowance is stale`);
  }
});
