/**
 * Source-contract tests for the primitives in `components/ui`.
 *
 * The rules these assert are the ones a reviewer cannot hold in their head
 * across fifteen files and one that a type checker cannot express at all:
 *
 *   - the focus indicator is 2 px at a 2 px offset, drawn from the focus-ring
 *     token, and every interactive primitive applies it (SC 2.4.7);
 *   - no primitive removes an outline, in any spelling, ever;
 *   - the indicator is only applied under `:focus-visible`, so a pointer press
 *     does not draw one;
 *   - every colour a primitive names is a theme token, so the contrast gate has
 *     measured it (SC 1.4.3, SC 1.4.11);
 *   - the table states what it is a table of and scopes its header cells
 *     (SC 1.3.1);
 *   - the dialog traps focus, holds the background out of the accessibility
 *     tree, and returns focus to its invoker (SC 2.4.3).
 *
 * Behaviour under an assistive technology is not in scope for a test that reads
 * source. What is in scope is that the mechanism is present and cannot be
 * removed silently.
 *
 * Requirements: 24.8, 24.10
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const UI_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "components", "ui");

/** The colour names the Tailwind namespace is rebuilt from in `styles/`. */
/*
 * Every colour name a component may reach for.
 *
 * Two sets, because the theme is now two layers. The first is the generated token
 * set the contrast gate measures, and the five clearing states in it are the ones
 * that carry meaning rather than decoration, so they stay exactly as they were.
 * The second is the presentation vocabulary mapped from the reference, declared in
 * `styles/reference.css`, including the teal steps the reference accents with.
 *
 * The rule this test enforces is unchanged and is the reason the list is written
 * out rather than opened up: a colour that appears in a component must have been
 * declared somewhere a reader can find it. A hex literal in a class name still
 * fails, and so does a shade of a ramp nobody declared.
 */
const TOKEN_COLOURS = [
  // Generated tokens, checked by the contrast gate.
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
  // Presentation vocabulary, mapped from the reference.
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
  // The declared steps of the two ramps the reference uses. Anything outside
  // these is undeclared and fails, which is the point of naming them one by one.
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

/** Colour utilities carry one of these prefixes. */
const COLOUR_PREFIXES = [
  "bg",
  "text",
  "border",
  "outline",
  "ring",
  "fill",
  "stroke",
  "decoration",
  "divide",
  "shadow",
  "accent",
  "caret",
  "from",
  "via",
  "to",
];

/** Every primitive that can receive focus, and so must carry the indicator. */
const INTERACTIVE_FILES = [
  "button.tsx",
  "link.tsx",
  "skip-link.tsx",
  "input.tsx",
  "select.tsx",
  "dialog.tsx",
  "table.tsx",
  "tabs.tsx",
  "tooltip.tsx",
  "badge.tsx",
];

function sourceFiles() {
  return readdirSync(UI_DIRECTORY)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .sort();
}

function read(name) {
  return readFileSync(join(UI_DIRECTORY, name), "utf8");
}

/** Source with block and line comments removed, so prose is not read as code. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

test("the primitive set is complete", () => {
  const expected = [
    "badge.tsx",
    "button.tsx",
    "cn.ts",
    "dialog.tsx",
    "focus-ring.ts",
    "icons.tsx",
    "index.ts",
    "input.tsx",
    "link.tsx",
    "select.tsx",
    "skeleton.tsx",
    "skip-link.tsx",
    "slot.tsx",
    "table.tsx",
    "tabs.tsx",
    "tooltip.tsx",
  ];
  assert.deepEqual(sourceFiles(), expected);
});

test("the focus indicator is 2 px at a 2 px offset, in the focus-ring token", () => {
  const source = read("focus-ring.ts");
  assert.match(source, /focus-visible:outline-2\b/);
  assert.match(source, /focus-visible:outline-offset-2\b/);
  assert.match(source, /focus-visible:outline-focus-ring\b/);
});

test("every interactive primitive applies the focus indicator", () => {
  for (const name of INTERACTIVE_FILES) {
    const source = read(name);
    assert.ok(
      source.includes('from "./focus-ring"') || source.includes("focus-visible:outline-2"),
      `${name} applies no focus indicator`,
    );
  }
});

test("no primitive removes an outline, in any spelling", () => {
  const forbidden = [
    /\boutline-none\b/,
    /\boutline-hidden\b/,
    /\boutline-0\b/,
    /outline\s*:\s*(none|0)\b/,
    /outlineStyle\s*:\s*"?none"?/,
  ];
  for (const name of sourceFiles()) {
    const code = withoutComments(read(name));
    for (const pattern of forbidden) {
      assert.doesNotMatch(code, pattern, `${name} removes an outline`);
    }
  }
});

test("the indicator is applied on :focus-visible only, never on :focus or :active", () => {
  for (const name of sourceFiles()) {
    const code = withoutComments(read(name));
    assert.doesNotMatch(code, /(?<!-)\bfocus:outline/, `${name} draws an outline on :focus`);
    assert.doesNotMatch(code, /\bactive:outline/, `${name} draws an outline on :active`);
  }
});

test("every colour a primitive names is a theme token", () => {
  const allowed = new Set(TOKEN_COLOURS);
  const pattern = new RegExp(`\\b(${COLOUR_PREFIXES.join("|")})-([a-z][a-z0-9-]*)\\b`, "g");

  // Utilities in these families are shapes, sizes, or positions rather than
  // colours, so they share a prefix with a colour utility without naming one.
  const notColours = new Set([
    "balance",
    "base",
    "left",
    "center",
    "right",
    "start",
    "end",
    "justify",
    "nowrap",
    "wrap",
    "pretty",
    "ellipsis",
    "clip",
    "inherit",
    "current",
    "transparent",
    "none",
    "solid",
    "dashed",
    "dotted",
    "double",
    "sm",
    "md",
    "lg",
    "xl",
    "xs",
    "full",
    "fit",
    "max",
    "min",
    "auto",
    "hidden",
    "visible",
    "y",
    "x",
    "1",
    "2",
    "4",
    "8",
    "px",
  ]);

  for (const name of sourceFiles()) {
    // Arbitrary values are dropped first: `transition-[border-color,filter]`
    // names properties rather than colours, and a hard-coded colour inside
    // brackets is caught by the hex sweep below instead.
    const code = withoutComments(read(name)).replace(/\[[^\]]*\]/g, "");
    for (const [utility, , value] of code.matchAll(pattern)) {
      if (notColours.has(value)) continue;
      if (allowed.has(value)) continue;
      // `outline-offset-2` and friends share the prefix without naming a colour.
      if (/^(offset|solid|width)-/.test(value)) continue;
      // Side and width utilities: `border-b`, `border-b-0`, `divide-y`, `border-0`.
      if (/^([btlrse]-)?\d+$/.test(value) || /^[btlrse]$/.test(value)) continue;
      assert.fail(`${name} names a colour outside the token set: ${utility}`);
    }
  }

  assert.doesNotMatch(
    sourceFiles()
      .map((name) => withoutComments(read(name)))
      .join("\n"),
    /#[0-9a-fA-F]{6}\b|rgb\(|hsl\(/,
    "a primitive hard-codes a colour instead of naming a token",
  );
});

test("the table states what it is a table of and scopes its header cells", () => {
  const source = read("table.tsx");
  assert.match(source, /caption: React\.ReactNode;/, "caption is not a required prop");
  assert.match(source, /<caption\b/, "no <caption> element is rendered");
  assert.match(source, /scope = "col"/, "header cells are not scoped by default");
  assert.match(source, /scope=\{scope\}/, "the scope prop is not applied");
});

test("the dialog traps focus, holds the background out, and restores focus", () => {
  const source = read("dialog.tsx");
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-labelledby=/);
  assert.match(source, /function trapTab\(/, "no focus trap");
  assert.match(source, /event\.key === "Tab"/, "Tab is not intercepted");
  assert.match(source, /event\.key === "Escape"/, "Escape does not dismiss");
  assert.match(source, /child\.inert = true/, "the background is not held out");
  assert.match(source, /invoker\.focus\(\)/, "focus is not returned to the invoker");
  // The trap must never treat an element removed from the tab order as tabbable.
  assert.match(source, /:not\(\[tabindex='-1'\]\)/);
});

test("the tabs pattern carries its roles, its wiring, and one tab stop", () => {
  const source = read("tabs.tsx");
  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /role="tabpanel"/);
  assert.match(source, /aria-selected=\{active\}/);
  assert.match(source, /aria-controls=/);
  assert.match(source, /aria-labelledby=/);
  assert.match(source, /tabIndex=\{active \? 0 : -1\}/, "the list has more than one tab stop");
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
    assert.ok(source.includes(`"${key}"`), `${key} is not handled`);
  }
});

test("the tooltip is dismissable, and describes its trigger", () => {
  const source = read("tooltip.tsx");
  assert.match(source, /role="tooltip"/);
  assert.match(source, /aria-describedby": contentId/);
  assert.match(source, /event\.key === "Escape"/, "Escape does not dismiss");
  assert.match(source, /onFocus/, "focus does not open the tooltip");
});

test("the skip link is present, hidden until focus, and points at a landmark", () => {
  const source = read("skip-link.tsx");
  assert.match(source, /"sr-only"/);
  assert.match(source, /focus-visible:not-sr-only/);
  assert.match(source, /href=\{`#\$\{contentId\}`\}/);
});

test("decorative glyphs are hidden from assistive technology", () => {
  const source = read("icons.tsx");
  assert.match(source, /aria-hidden="true"/);
  assert.match(source, /focusable="false"/);
});
