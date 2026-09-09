#!/usr/bin/env node
/**
 * Runs the README art generator through whichever interpreter the local venv put
 * on disk.
 *
 * A venv lays itself out differently on Windows (`Scripts/python.exe`) and on
 * POSIX (`bin/python`), and the package script used to name the Windows path
 * directly. That worked on the authoring machine and failed everywhere else with
 * a spawn error naming a file nobody would think to look for, which is a worse
 * message than "the venv is missing" — so this resolves the layout and says the
 * bootstrap command when neither exists.
 *
 * Every argument is forwarded, so `--check` still reaches the generator.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CANDIDATES = [
  join(ROOT, "tools", ".venv", "Scripts", "python.exe"),
  join(ROOT, "tools", ".venv", "bin", "python"),
];

const python = CANDIDATES.find((candidate) => existsSync(candidate));

if (!python) {
  console.error("art: no interpreter in tools/.venv. Bootstrap it once, from the repository root:");
  console.error();
  console.error("  python3 -m venv tools/.venv");
  console.error("  tools/.venv/bin/python -m pip install -r tools/requirements.txt");
  console.error();
  console.error("On Windows the second line is tools/.venv/Scripts/python.exe.");
  process.exit(2);
}

const result = spawnSync(python, ["-m", "tools.make_readme_art", ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
