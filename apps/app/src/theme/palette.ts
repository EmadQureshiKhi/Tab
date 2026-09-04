/**
 * Reader for `assets/palette.json`.
 *
 * `assets/palette.json` is the single source of truth for every colour value
 * in the Dashboard. The theme CSS is generated from it and the CI contrast
 * check reads it, so a colour cannot be changed in the artwork without the
 * theme and the check noticing. No hex value is retyped anywhere in
 * `apps/app`: everything downstream of this module resolves through it.
 *
 * Requirements: 24.8, 24.10
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the palette lives, relative to the repository root. */
export const PALETTE_RELATIVE_PATH = join("assets", "palette.json");

/** The five clearing states, in the order the state machine introduces them. */
export const CLEARING_STATES = [
  "applied",
  "confirmed",
  "reversed",
  "declined",
  "superseded",
] as const;

export type ClearingState = (typeof CLEARING_STATES)[number];

export type ClearingPalette = Readonly<Record<ClearingState, string>>;

/** The six base colours plus the clearing set, for one appearance mode. */
export interface ModePalette {
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly text: string;
  readonly textMuted: string;
  readonly accent: string;
  readonly stroke: string;
  readonly clearing: ClearingPalette;
}

/** One row of the ratio table published in `assets/palette.json`. */
export interface PublishedRatio {
  readonly pair: string;
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
  readonly minimum: number;
  readonly kind: string;
  readonly note: string;
}

export interface PaletteThresholds {
  readonly bodyAndNumericText: number;
  readonly largeText: number;
  readonly controlBoundaryFocusRingChartStrokeBadgeBorder: number;
}

export interface Palette {
  readonly thresholds: PaletteThresholds;
  readonly light: ModePalette;
  readonly dark: ModePalette;
  readonly publishedRatios: readonly PublishedRatio[];
}

export const MODES = ["light", "dark"] as const;
export type Mode = (typeof MODES)[number];

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`palette: ${where} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asColour(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    throw new Error(`palette: ${where} is not a six-digit hex colour`);
  }
  return value.toUpperCase();
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`palette: ${where} is not a finite number`);
  }
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`palette: ${where} is not a non-empty string`);
  }
  return value;
}

function readClearing(value: unknown, where: string): ClearingPalette {
  const block = asRecord(value, where);
  const entries: [ClearingState, string][] = CLEARING_STATES.map((state) => [
    state,
    asColour(block[state], `${where}.${state}`),
  ]);
  return Object.freeze(Object.fromEntries(entries)) as ClearingPalette;
}

function readMode(value: unknown, where: string): ModePalette {
  const block = asRecord(value, where);
  return {
    surface: asColour(block["surface"], `${where}.surface`),
    surfaceRaised: asColour(block["surfaceRaised"], `${where}.surfaceRaised`),
    text: asColour(block["text"], `${where}.text`),
    textMuted: asColour(block["textMuted"], `${where}.textMuted`),
    accent: asColour(block["accent"], `${where}.accent`),
    stroke: asColour(block["stroke"], `${where}.stroke`),
    clearing: readClearing(block["clearing"], `${where}.clearing`),
  };
}

function readPublishedRatios(value: unknown, where: string): readonly PublishedRatio[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`palette: ${where} is not a non-empty array`);
  }
  return value.map((entry, index) => {
    const row = asRecord(entry, `${where}[${index}]`);
    const note = row["note"];
    return {
      pair: asString(row["pair"], `${where}[${index}].pair`),
      foreground: asColour(row["fg"], `${where}[${index}].fg`),
      background: asColour(row["bg"], `${where}[${index}].bg`),
      ratio: asNumber(row["ratio"], `${where}[${index}].ratio`),
      minimum: asNumber(row["min"], `${where}[${index}].min`),
      kind: asString(row["kind"], `${where}[${index}].kind`),
      note: typeof note === "string" ? note : "",
    };
  });
}

/**
 * Walks up from this module until it finds the directory holding
 * `assets/palette.json`. Depth-independent, so it behaves the same whether it
 * runs from `src/` under a TypeScript runner or from `dist/` after a build.
 */
export function findRepositoryRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(current, PALETTE_RELATIVE_PATH))) return current;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `palette: could not find \`${PALETTE_RELATIVE_PATH}\` in any directory above ${dirname(
      fileURLToPath(import.meta.url),
    )}`,
  );
}

export interface LoadedPalette {
  readonly palette: Palette;
  readonly repositoryRoot: string;
  readonly palettePath: string;
}

/** Reads and validates `assets/palette.json`. Throws on any shape violation. */
export function loadPalette(): LoadedPalette {
  const repositoryRoot = findRepositoryRoot();
  const palettePath = join(repositoryRoot, PALETTE_RELATIVE_PATH);
  const parsed: unknown = JSON.parse(readFileSync(palettePath, "utf8"));
  const root = asRecord(parsed, "palette.json");
  const thresholds = asRecord(root["thresholds"], "thresholds");
  const palette: Palette = {
    thresholds: {
      bodyAndNumericText: asNumber(
        thresholds["bodyAndNumericText"],
        "thresholds.bodyAndNumericText",
      ),
      largeText: asNumber(thresholds["largeText"], "thresholds.largeText"),
      controlBoundaryFocusRingChartStrokeBadgeBorder: asNumber(
        thresholds["controlBoundaryFocusRingChartStrokeBadgeBorder"],
        "thresholds.controlBoundaryFocusRingChartStrokeBadgeBorder",
      ),
    },
    light: readMode(root["light"], "light"),
    dark: readMode(root["dark"], "dark"),
    publishedRatios: readPublishedRatios(root["computedRatios"], "computedRatios"),
  };
  return { palette, repositoryRoot, palettePath };
}

/** Picks one mode out of a loaded palette. */
export function modePalette(palette: Palette, mode: Mode): ModePalette {
  return mode === "light" ? palette.light : palette.dark;
}
