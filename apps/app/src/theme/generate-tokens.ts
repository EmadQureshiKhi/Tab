#!/usr/bin/env node
/**
 * Writes the generated theme stylesheets from `assets/palette.json`.
 *
 *   pnpm --filter @tabai/app theme:tokens
 *
 * The lint task renders the same files in memory and compares them with what is
 * on disk, so running this is the only way to change a colour in the Dashboard.
 *
 * Requirements: 24.8, 24.10
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { renderGeneratedStylesheets } from "./css.js";
import { loadPalette } from "./palette.js";
import { stylesDirectory } from "./paths.js";

function main(): void {
  const { palette, repositoryRoot, palettePath } = loadPalette();
  const directory = stylesDirectory(repositoryRoot);
  mkdirSync(directory, { recursive: true });

  console.log(`theme: palette read from ${relative(repositoryRoot, palettePath)}`);

  for (const [name, contents] of renderGeneratedStylesheets(palette)) {
    const target = join(directory, name);
    writeFileSync(target, contents, { encoding: "utf8" });
    console.log(
      `theme: wrote ${relative(repositoryRoot, target)} (${contents.length} bytes)`,
    );
  }

  console.log("theme: generated stylesheets are in step with the palette");
}

main();
