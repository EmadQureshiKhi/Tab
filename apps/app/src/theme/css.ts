/**
 * Renders the generated half of the theme from `assets/palette.json`.
 *
 * Tailwind v4 is configured in CSS, so the theme is a set of stylesheets rather
 * than a JavaScript object. Four files are generated here and one, `theme.css`,
 * is hand-written and imports them:
 *
 *   tokens.base.css   mode-independent scalars: focus ring, outline, motion
 *   tokens.light.css  the light colour set
 *   tokens.dark.css   the dark colour set
 *   tokens.theme.css  publishes the tokens into Tailwind's colour namespace
 *
 * Light and dark are separate files because the accent is a different hue in
 * each mode, so dark is not a filter over light and cannot be expressed as one.
 *
 * Requirements: 24.8, 24.10
 */

import {
  type Mode,
  type ModePalette,
  type Palette,
  modePalette,
} from "./palette.js";
import {
  SCALAR_TOKENS,
  TOKENS,
  resolveTokenColour,
  tokenCssVariable,
  tokenThemeVariable,
} from "./tokens.js";

/** File name of the hand-written entry stylesheet. */
export const THEME_ENTRY_FILE = "theme.css";

/** The generated file names, in import order. */
export const GENERATED_FILES = [
  "tokens.base.css",
  "tokens.light.css",
  "tokens.dark.css",
  "tokens.theme.css",
] as const;

export type GeneratedFile = (typeof GENERATED_FILES)[number];

const REGENERATE_COMMAND = "pnpm --filter @tabai/app theme:tokens";

function header(what: string): string {
  return [
    "/*",
    ` * ${what}`,
    " *",
    " * Generated from assets/palette.json. Do not edit by hand: edit the palette",
    ` * and run \`${REGENERATE_COMMAND}\`.`,
    " *",
    " * The lint task renders this file in memory and fails when what is on disk",
    " * differs, so the theme cannot drift from the palette the brand assets are",
    " * drawn in.",
    " *",
    " * Requirements: 24.8, 24.10",
    " */",
  ].join("\n");
}

/** The declaration lines for one mode, indented by `indent`. */
function colourDeclarations(mode: ModePalette, indent: string): string {
  const lines: string[] = [];
  for (const spec of TOKENS) {
    const property = tokenCssVariable(spec.token);
    const value =
      spec.value.kind === "alias"
        ? `var(${tokenCssVariable(spec.value.of)})`
        : resolveTokenColour(spec.token, mode);
    const derivation =
      spec.value.kind === "alias" ? `alias of ${spec.value.of}` : spec.purpose;
    lines.push(`${indent}/* ${derivation} */`);
    lines.push(`${indent}${property}: ${value};`);
  }
  return lines.join("\n");
}

function renderBase(): string {
  const scalars = SCALAR_TOKENS.map(
    (scalar) =>
      `  /* ${scalar.purpose} */\n  ${tokenCssVariable(scalar.token)}: ${scalar.value};`,
  ).join("\n");

  return [
    header("Mode-independent design tokens."),
    "",
    ":root {",
    scalars,
    "}",
    "",
    "/*",
    " * Reduced motion collapses the motion tokens rather than removing motion at",
    " * the call site, so a component never has to ask about the preference.",
    " */",
    "@media (prefers-reduced-motion: reduce) {",
    "  :root {",
    `    ${tokenCssVariable("motion-fast")}: var(${tokenCssVariable("motion-instant")});`,
    `    ${tokenCssVariable("motion-base")}: var(${tokenCssVariable("motion-instant")});`,
    "  }",
    "}",
    "",
  ].join("\n");
}

function renderLight(palette: Palette): string {
  return [
    header("Light colour tokens."),
    "",
    "/*",
    " * Light is the default set, so it lands on :root unconditionally and is",
    " * reasserted for an explicit light choice.",
    " */",
    ":root,",
    '[data-tab-theme="light"] {',
    "  color-scheme: light;",
    "",
    colourDeclarations(modePalette(palette, "light"), "  "),
    "}",
    "",
  ].join("\n");
}

function renderDark(palette: Palette): string {
  const declarations = colourDeclarations(modePalette(palette, "dark"), "    ");
  return [
    header("Dark colour tokens."),
    "",
    "/*",
    " * Dark is a distinct set rather than a transform of light: the accent moves",
    " * hue between the two modes, which no filter over the light set can produce.",
    " *",
    " * The system preference applies unless a light choice is pinned on the root,",
    " * and an explicit dark choice applies regardless of the system preference.",
    " */",
    "@media (prefers-color-scheme: dark) {",
    '  :root:not([data-tab-theme="light"]) {',
    "    color-scheme: dark;",
    "",
    declarations,
    "  }",
    "}",
    "",
    '[data-tab-theme="dark"] {',
    "  color-scheme: dark;",
    "",
    colourDeclarations(modePalette(palette, "dark"), "  "),
    "}",
    "",
  ].join("\n");
}

function renderThemeMapping(): string {
  const mapped = TOKENS.map(
    (spec) =>
      `  ${tokenThemeVariable(spec.token)}: var(${tokenCssVariable(spec.token)});`,
  ).join("\n");

  return [
    header("Tailwind colour namespace."),
    "",
    "/*",
    " * The default colour namespace is cleared first, so the only colour",
    " * utilities that exist are the tokens the contrast check evaluates. An",
    " * unchecked colour cannot reach a component by accident.",
    " */",
    "@theme {",
    "  --color-*: initial;",
    "}",
    "",
    "/*",
    " * `inline` keeps the var() reference in the utility instead of resolving it",
    " * at build time, which is what lets one utility follow the mode.",
    " */",
    "@theme inline {",
    mapped,
    "}",
    "",
  ].join("\n");
}

/** @returns every generated stylesheet, keyed by file name */
export function renderGeneratedStylesheets(
  palette: Palette,
): ReadonlyMap<GeneratedFile, string> {
  return new Map<GeneratedFile, string>([
    ["tokens.base.css", renderBase()],
    ["tokens.light.css", renderLight(palette)],
    ["tokens.dark.css", renderDark(palette)],
    ["tokens.theme.css", renderThemeMapping()],
  ]);
}

/** Normalises line endings so a check on disk is not a check on Windows. */
export function normaliseLineEndings(contents: string): string {
  return contents.replace(/\r\n/g, "\n");
}

/**
 * Drops CSS comments, so a rule the theme forbids can be named in prose without
 * the check reading the prose as the rule.
 */
export function stripCssComments(contents: string): string {
  return contents.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Convenience for callers that want one mode's resolved colours. */
export function resolvedColours(
  palette: Palette,
  mode: Mode,
): ReadonlyMap<string, string> {
  const resolved = modePalette(palette, mode);
  return new Map(
    TOKENS.map((spec) => [spec.token, resolveTokenColour(spec.token, resolved)]),
  );
}
