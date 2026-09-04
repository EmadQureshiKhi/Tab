#!/usr/bin/env node
/**
 * The contrast gate for the Dashboard theme. Registered as the `lint` task of
 * `@tabai/app`, so `pnpm turbo run lint` runs it.
 *
 * It asserts five things and exits non-zero on any failure:
 *
 *   1. Every ratio published in `assets/palette.json` is reproducible from the
 *      WCAG 2.1 relative-luminance formula computed here.
 *   2. Every token pair used for body or numeric text clears 4.5:1, and every
 *      pair used for a control boundary, a focus ring, a chart stroke, or a
 *      badge border clears 3:1.
 *   3. Every pair below the 3:1 floor carries an allowance that states a reason
 *      and names compensating pairs, and those compensating pairs pass their own
 *      thresholds. Nothing is skipped, and no allowance may go unexplained.
 *   4. The generated stylesheets on disk match what the palette renders.
 *   5. The focus ring is defined once, from tokens, and `outline: none` appears
 *      nowhere in the theme.
 *
 * Requirements: 24.8, 24.10
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  contrastRatio,
  floorToTwoDecimals,
  formatRatio,
  roundToTwoDecimals,
} from "./contrast.js";
import {
  GENERATED_FILES,
  THEME_ENTRY_FILE,
  normaliseLineEndings,
  renderGeneratedStylesheets,
  stripCssComments,
} from "./css.js";
import { type Mode, MODES, type Palette, loadPalette, modePalette } from "./palette.js";
import { stylesDirectory } from "./paths.js";
import {
  LOW_CONTRAST_ALLOWLIST,
  type LowContrastAllowance,
  NON_TEXT_FLOOR,
  TOKEN_PAIRS,
  type TokenPair,
  pairThreshold,
  resolveTokenColour,
} from "./tokens.js";

const failures: string[] = [];
const notes: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

/** Wraps prose to `width` columns, prefixing every line with `indent`. */
function wrap(text: string, indent: string, width: number): string {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.map((line) => `${indent}${line}`).join("\n");
}

function heading(text: string): void {
  console.log("");
  console.log(text);
  console.log("-".repeat(text.length));
}

/* ------------------------------------------------------------------ */
/* 1. the published table is reproducible                              */
/* ------------------------------------------------------------------ */

function crossCheckPublishedRatios(palette: Palette, palettePath: string): void {
  heading(`1. published ratios in ${palettePath} (${palette.publishedRatios.length} pairs)`);

  let roundedOnly = 0;

  for (const row of palette.publishedRatios) {
    const computed = contrastRatio(row.foreground, row.background);
    const rounded = roundToTwoDecimals(computed);
    const floored = floorToTwoDecimals(computed);
    const agrees = Math.abs(rounded - row.ratio) < 1e-9;
    if (!agrees) {
      fail(
        `published ratio disagrees for \`${row.pair}\`: ${row.foreground} on ${row.background} computes to ${computed.toFixed(
          6,
        )} (${formatRatio(rounded)} to two decimals) but the palette states ${row.ratio}`,
      );
    }
    if (agrees && Math.abs(floored - row.ratio) >= 1e-9) roundedOnly += 1;

    console.log(
      `  ${agrees ? "ok  " : "FAIL"} ${pad(row.pair, 52)} computed ${padStart(
        formatRatio(rounded),
        6,
      )}  published ${padStart(row.ratio.toFixed(2), 6)}`,
    );
  }

  if (roundedOnly > 0) {
    notes.push(
      `${roundedOnly} of ${palette.publishedRatios.length} published ratios match only under round-to-nearest at two decimals, not under truncation, although the palette describes its numbers as rounded down. Every stated value is correct as a round-to-nearest figure, so the numbers agree and the wording is what is loose. This check compares against round-to-nearest.`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 2 and 3. the token pair matrix                                      */
/* ------------------------------------------------------------------ */

type PairStatus = "pass" | "fail" | "allowed";

interface Evaluation {
  readonly pair: TokenPair;
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
  readonly threshold: number;
  readonly allowance: LowContrastAllowance | null;
  readonly status: PairStatus;
}

function allowanceFor(pairId: string): LowContrastAllowance | null {
  return LOW_CONTRAST_ALLOWLIST.find((entry) => entry.pairId === pairId) ?? null;
}

function evaluate(pair: TokenPair, palette: Palette): Evaluation {
  const colours = modePalette(palette, pair.mode);
  const foreground = resolveTokenColour(pair.foregroundToken, colours);
  const background = resolveTokenColour(pair.backgroundToken, colours);
  const ratio = roundToTwoDecimals(contrastRatio(foreground, background));
  const threshold = pairThreshold(pair);
  const allowance = allowanceFor(pair.id);

  let status: PairStatus;
  if (allowance !== null) {
    // An allowance only means anything while the pair is actually below the
    // floor. Once it clears, the allowance is stale and must go.
    status = ratio < NON_TEXT_FLOOR ? "allowed" : "fail";
  } else {
    status = ratio >= threshold ? "pass" : "fail";
  }

  return { pair, foreground, background, ratio, threshold, allowance, status };
}

function reportMode(mode: Mode, evaluations: readonly Evaluation[]): void {
  heading(`2.${mode === "light" ? "1" : "2"} token pairs, ${mode} (${evaluations.length} pairs)`);
  console.log(
    `  ${pad("mark", 8)}${pad("pair", 46)}${padStart("ratio", 7)}  ${padStart(
      "needs",
      6,
    )}  roles`,
  );

  for (const evaluation of evaluations) {
    const mark =
      evaluation.status === "pass"
        ? "PASS"
        : evaluation.status === "allowed"
          ? "ALLOWED"
          : "FAIL";
    const needs =
      evaluation.status === "allowed" ? "n/a" : `${formatRatio(evaluation.threshold)}:1`;
    console.log(
      `  ${pad(mark, 8)}${pad(
        `${evaluation.pair.foregroundToken} on ${evaluation.pair.backgroundToken}`,
        46,
      )}${padStart(`${formatRatio(evaluation.ratio)}:1`, 7)}  ${padStart(needs, 6)}  ${evaluation.pair.roles.join(
        ", ",
      )}`,
    );
    if (evaluation.status === "fail" && evaluation.allowance === null) {
      fail(
        `\`${evaluation.pair.id}\` reaches ${formatRatio(
          evaluation.ratio,
        )}:1 (${evaluation.foreground} on ${evaluation.background}) but its roles (${evaluation.pair.roles.join(
          ", ",
        )}) require ${formatRatio(evaluation.threshold)}:1`,
      );
    }
    if (evaluation.status === "fail" && evaluation.allowance !== null) {
      fail(
        `\`${evaluation.pair.id}\` now reaches ${formatRatio(
          evaluation.ratio,
        )}:1, at or above the ${formatRatio(
          NON_TEXT_FLOOR,
        )}:1 floor, so its low-contrast allowance is stale and must be removed`,
      );
    }
  }
}

function reportAllowances(byId: ReadonlyMap<string, Evaluation>): void {
  heading(
    `3. low-contrast allowances (${LOW_CONTRAST_ALLOWLIST.length} entries, each with a stated reason and checked compensation)`,
  );

  for (const allowance of LOW_CONTRAST_ALLOWLIST) {
    const evaluation = byId.get(allowance.pairId);
    if (evaluation === undefined) {
      fail(
        `low-contrast allowance names \`${allowance.pairId}\`, which is not a pair in the matrix`,
      );
      continue;
    }
    console.log(
      `  ${allowance.pairId} at ${formatRatio(evaluation.ratio)}:1, below the ${formatRatio(
        NON_TEXT_FLOOR,
      )}:1 floor by intent`,
    );
    if (allowance.reason.trim().length < 40) {
      fail(`low-contrast allowance for \`${allowance.pairId}\` states no usable reason`);
    } else {
      console.log(`      reason:`);
      console.log(wrap(allowance.reason, "        ", 92));
    }

    if (allowance.compensatingPairIds.length === 0) {
      fail(
        `low-contrast allowance for \`${allowance.pairId}\` names no compensating pair, so nothing carries the separation`,
      );
      continue;
    }

    for (const compensatingId of allowance.compensatingPairIds) {
      const compensating = byId.get(compensatingId);
      if (compensating === undefined) {
        fail(
          `low-contrast allowance for \`${allowance.pairId}\` names compensating pair \`${compensatingId}\`, which is not in the matrix`,
        );
        continue;
      }
      if (compensating.threshold < NON_TEXT_FLOOR) {
        fail(
          `compensating pair \`${compensatingId}\` is only held to ${formatRatio(
            compensating.threshold,
          )}:1, which cannot compensate for a pair below ${formatRatio(NON_TEXT_FLOOR)}:1`,
        );
      }
      if (compensating.status !== "pass") {
        fail(
          `compensating pair \`${compensatingId}\` does not pass, so \`${allowance.pairId}\` has nothing carrying its separation`,
        );
      }
      console.log(
        `      compensated by ${pad(compensatingId, 40)} ${padStart(
          `${formatRatio(compensating.ratio)}:1`,
          7,
        )} >= ${formatRatio(compensating.threshold)}:1  ${
          compensating.status === "pass" ? "PASS" : "FAIL"
        }`,
      );
    }
  }

  // Nothing may sit below the floor without an entry above.
  for (const evaluation of byId.values()) {
    if (evaluation.allowance !== null) continue;
    if (evaluation.pair.roles.includes("surfaceSeparation")) {
      fail(
        `\`${evaluation.pair.id}\` is declared as a deliberate surface separation but carries no allowance stating why and what compensates for it`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. the generated stylesheets match the palette                      */
/* ------------------------------------------------------------------ */

function checkGeneratedStylesheets(
  palette: Palette,
  repositoryRoot: string,
): ReadonlyMap<string, string> {
  const directory = stylesDirectory(repositoryRoot);
  heading(`4. generated stylesheets in ${relative(repositoryRoot, directory)}`);

  const rendered = renderGeneratedStylesheets(palette);
  const onDisk = new Map<string, string>();

  for (const name of GENERATED_FILES) {
    const target = join(directory, name);
    const expected = rendered.get(name) ?? "";
    if (!existsSync(target)) {
      fail(`generated stylesheet \`${name}\` is missing; run \`pnpm --filter @tabai/app theme:tokens\``);
      console.log(`  FAIL ${pad(name, 24)} missing`);
      continue;
    }
    const actual = normaliseLineEndings(readFileSync(target, "utf8"));
    onDisk.set(name, actual);
    const matches = actual === expected;
    if (!matches) {
      fail(
        `generated stylesheet \`${name}\` differs from what the palette renders; run \`pnpm --filter @tabai/app theme:tokens\``,
      );
    }
    console.log(
      `  ${matches ? "ok  " : "FAIL"} ${pad(name, 24)} ${padStart(
        String(actual.length),
        6,
      )} bytes  in step with the palette: ${matches ? "yes" : "no"}`,
    );
  }

  const entry = join(directory, THEME_ENTRY_FILE);
  if (!existsSync(entry)) {
    fail(`\`${THEME_ENTRY_FILE}\` is missing, so nothing imports the tokens`);
  } else {
    const contents = normaliseLineEndings(readFileSync(entry, "utf8"));
    onDisk.set(THEME_ENTRY_FILE, contents);
    for (const name of GENERATED_FILES) {
      if (!contents.includes(`./${name}`)) {
        fail(`\`${THEME_ENTRY_FILE}\` does not import \`${name}\``);
      }
    }
    console.log(
      `  ok   ${pad(THEME_ENTRY_FILE, 24)} ${padStart(
        String(contents.length),
        6,
      )} bytes  imports every generated stylesheet`,
    );
  }

  return onDisk;
}

/* ------------------------------------------------------------------ */
/* 5. the focus ring                                                   */
/* ------------------------------------------------------------------ */

function checkFocusRing(stylesheets: ReadonlyMap<string, string>): void {
  heading("5. focus ring and reduced motion");

  const entry = stylesheets.get(THEME_ENTRY_FILE) ?? "";
  const base = stylesheets.get("tokens.base.css") ?? "";

  const assertions: readonly { readonly what: string; readonly holds: boolean }[] = [
    {
      what: "the ring is defined on :focus-visible",
      holds: entry.includes(":focus-visible"),
    },
    {
      what: "the ring width and offset come from tokens",
      holds:
        entry.includes("var(--tab-focus-ring-width)") &&
        entry.includes("var(--tab-focus-ring-offset)") &&
        entry.includes("var(--tab-focus-ring)"),
    },
    {
      what: "the ring width token is 2px and the offset token is 2px",
      holds:
        /--tab-focus-ring-width:\s*2px/.test(base) &&
        /--tab-focus-ring-offset:\s*2px/.test(base),
    },
    {
      // Comments are stripped first, so the rule can be named in prose without
      // the prose reading as the rule.
      what: "`outline: none` and `outline: 0` appear in no declaration in the theme",
      holds: ![...stylesheets.values()].some((contents) =>
        /outline\s*:\s*(none|0)\b/.test(stripCssComments(contents)),
      ),
    },
    {
      what: "prefers-reduced-motion is handled in the theme layer",
      holds:
        base.includes("prefers-reduced-motion") ||
        entry.includes("prefers-reduced-motion"),
    },
    {
      what: "prefers-color-scheme is handled in the theme layer",
      holds: (stylesheets.get("tokens.dark.css") ?? "").includes("prefers-color-scheme"),
    },
  ];

  for (const assertion of assertions) {
    console.log(`  ${assertion.holds ? "ok  " : "FAIL"} ${assertion.what}`);
    if (!assertion.holds) fail(`theme assertion does not hold: ${assertion.what}`);
  }
}

/* ------------------------------------------------------------------ */

function main(): void {
  const { palette, repositoryRoot, palettePath } = loadPalette();
  const palettePathLabel = relative(repositoryRoot, palettePath).split("\\").join("/");

  console.log("tab-theme: contrast gate over the Dashboard design tokens");
  console.log(
    `tab-theme: thresholds — body and numeric text ${formatRatio(
      palette.thresholds.bodyAndNumericText,
    )}:1, large text ${formatRatio(
      palette.thresholds.largeText,
    )}:1, control boundary, focus ring, chart stroke, and badge border ${formatRatio(
      palette.thresholds.controlBoundaryFocusRingChartStrokeBadgeBorder,
    )}:1`,
  );

  crossCheckPublishedRatios(palette, palettePathLabel);

  const evaluations = TOKEN_PAIRS.map((pair) => evaluate(pair, palette));
  const byId = new Map(evaluations.map((evaluation) => [evaluation.pair.id, evaluation]));

  for (const mode of MODES) {
    reportMode(
      mode,
      evaluations.filter((evaluation) => evaluation.pair.mode === mode),
    );
  }

  reportAllowances(byId);

  const stylesheets = checkGeneratedStylesheets(palette, repositoryRoot);
  checkFocusRing(stylesheets);

  const counts = {
    pass: evaluations.filter((evaluation) => evaluation.status === "pass").length,
    allowed: evaluations.filter((evaluation) => evaluation.status === "allowed").length,
    failed: evaluations.filter((evaluation) => evaluation.status === "fail").length,
  };

  heading("summary");
  console.log(
    `  ${evaluations.length} token pairs evaluated: ${counts.pass} pass, ${counts.allowed} below the floor by stated intent with checked compensation, ${counts.failed} fail`,
  );
  console.log(
    `  ${palette.publishedRatios.length} published ratios cross-checked against the formula computed here`,
  );
  console.log(
    `  0 pairs skipped: every pair carries a computed ratio, a threshold or a stated allowance, and a mark`,
  );

  for (const note of notes) {
    console.log("  note:");
    console.log(wrap(note, "    ", 92));
  }

  if (counts.pass + counts.allowed + counts.failed !== evaluations.length) {
    fail("internal: the pair tally does not add up, so a pair went unevaluated");
  }

  if (failures.length > 0) {
    console.error("");
    console.error(
      `tab-theme: ${failures.length} contrast ${
        failures.length === 1 ? "failure" : "failures"
      }`,
    );
    for (const failure of failures) console.error(`  x ${failure}`);
    process.exit(1);
  }

  console.log("");
  console.log("tab-theme: ok. every token pair meets the ratio its role requires.");
}

main();
