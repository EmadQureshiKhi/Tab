#!/usr/bin/env node
/**
 * Runs Slither over the contracts in `src/` and writes `audit/slither.json`.
 *
 *   node tools/slither.mjs          (or: pnpm --filter @tabai/contracts audit:slither)
 *
 * Slither is not a dependency of this repository. Install it once, isolated,
 * from PyPI (`slither-analyzer`), and either put it on `PATH` or point
 * `SLITHER_BIN` at it:
 *
 *   python3 -m venv ~/.venvs/slither && ~/.venvs/slither/bin/pip install slither-analyzer
 *   SLITHER_BIN=~/.venvs/slither/bin/slither node tools/slither.mjs
 *
 * ## Why the compile is done here and not by Slither
 *
 * OpenZeppelin resolves through `../../node_modules`, outside the Foundry
 * root. With the relative remapping from `foundry.toml`, forge names each
 * OpenZeppelin file twice in the build info, once by the remapped relative
 * path and once by the absolute path its own relative imports resolve to.
 * Slither keeps one copy and then cannot resolve references into the other,
 * which it reports as "Failed to resolved name for reference id". The
 * findings are the same either way, but an analysis that could not resolve
 * `IERC20` is not one to publish. So this compiles once with the remapping
 * made absolute, into a separate out and cache directory under `cache/` so
 * the ordinary build is untouched, and Slither reads that build info as is.
 *
 * `test/`, `script/` and `lib/` are not compiled, and `slither.config.json`
 * filters `src/test/MockUsdc.sol`, the Testnet mock, out of the findings.
 *
 * The JSON is rewritten with repository-relative paths so the committed file
 * does not depend on where the repository was checked out. Slither exits
 * non-zero whenever it has findings; this exits 0 when the analysis ran, and
 * the triage lives in `audit/slither.md`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(CONTRACTS, "..", "..");
const OUT = join("cache", "slither", "out");
const CACHE = join("cache", "slither", "cache");
const REPORT = join("audit", "slither.json");
const OPENZEPPELIN = join(REPO_ROOT, "node_modules", "@openzeppelin", "contracts");

function findSlither() {
  const executable = platform() === "win32" ? "slither.exe" : "slither";
  const candidates = [];
  if (process.env.SLITHER_BIN) candidates.push(process.env.SLITHER_BIN);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir) candidates.push(join(dir, executable));
  }
  // Where `pipx install` and `uv tool install` put their entry points.
  candidates.push(join(homedir(), ".local", "bin", executable));
  return candidates.find((path) => existsSync(path));
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: CONTRACTS, stdio: "inherit" });
  if (result.signal) {
    console.error(`${command}: terminated by ${result.signal}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

const slither = findSlither();
if (slither === undefined) {
  console.error("slither: not found on PATH, in ~/.local/bin, or at SLITHER_BIN.");
  console.error();
  console.error("Install it isolated from PyPI, for example:");
  console.error("  python3 -m venv ~/.venvs/slither && ~/.venvs/slither/bin/pip install slither-analyzer");
  console.error("then run again with SLITHER_BIN=~/.venvs/slither/bin/slither.");
  process.exit(127);
}
if (!existsSync(OPENZEPPELIN)) {
  console.error(`OpenZeppelin not found at ${OPENZEPPELIN}; run pnpm install at the repository root.`);
  process.exit(1);
}

const buildStatus = run(process.execPath, [
  join("tools", "forge.mjs"),
  "build",
  "--build-info",
  "--force",
  "--skip",
  "./test/**",
  "--skip",
  "./script/**",
  "--out",
  OUT,
  "--cache-path",
  CACHE,
  "--remappings",
  `@openzeppelin/contracts/=${OPENZEPPELIN}${sep}`,
]);
if (buildStatus !== 0) process.exit(buildStatus);

rmSync(join(CONTRACTS, REPORT), { force: true });
run(slither, [
  ".",
  "--config-file",
  "slither.config.json",
  "--foundry-ignore-compile",
  "--foundry-out-directory",
  OUT,
  "--json",
  REPORT,
]);

const reportPath = join(CONTRACTS, REPORT);
if (!existsSync(reportPath)) {
  console.error(`slither wrote no ${REPORT}`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportPath, "utf8"));
if (!report.success) {
  console.error(`slither failed: ${report.error}`);
  process.exit(1);
}

/** Every `filename_absolute`, at any depth, becomes relative to the repository root. */
function relativise(node) {
  if (Array.isArray(node)) {
    node.forEach(relativise);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "filename_absolute" && typeof value === "string") {
        node[key] = relative(REPO_ROOT, value).split(sep).join("/");
      } else {
        relativise(value);
      }
    }
  }
}

const detectors = report.results?.detectors ?? [];
relativise(report);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

const tally = new Map();
for (const { check, impact, confidence } of detectors) {
  const key = `${check} (${impact}, ${confidence})`;
  tally.set(key, (tally.get(key) ?? 0) + 1);
}
console.log();
console.log(`${detectors.length} result(s) written to ${REPORT}:`);
for (const [key, count] of tally) console.log(`  ${String(count).padStart(3)}  ${key}`);
