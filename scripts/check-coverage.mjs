#!/usr/bin/env node
/**
 * Per-contract line-coverage gate.
 *
 * R27.1 names six Creditcoin contracts and a coverage obligation over them.
 * This script is the mechanical form of that obligation: it reads the LCOV
 * report `forge coverage` writes, computes line coverage per contract, prints
 * every figure beside the floor that applies to it, and fails the build when
 * any floored contract sits below its floor. Before this existed the floors
 * were read off the terminal by hand on each batch, which is a habit rather
 * than a gate.
 *
 * Two tiers, both on lines
 *
 *   90 percent  SettlementVerifier, TabBook, LimitLib, Bond
 *               The money-handling contracts. Every value transfer, every
 *               credit-limit decision, and every replay defence lives in these
 *               four, so an unexecuted line here is an untested claim about
 *               someone's money.
 *
 *   75 percent  AgentRegistry, ServiceRegistry
 *               The stated reason, recorded here because a threshold without
 *               its reason becomes folklore: these two are predominantly
 *               setters and timelock bookkeeping. The marginal safety of the
 *               last fifteen points does not justify the time it would take to
 *               reach them, and that time is better spent on the four above.
 *
 * Lines only, never branches
 *
 * `ServiceRegistry` currently reports roughly 99 percent of lines against
 * roughly 23 percent of branches. That gap is an artefact of how branch
 * coverage is attributed when a file is compiled through the Yul pipeline —
 * which `ServiceRegistry` alone is, through the `coverage` profile in
 * `packages/contracts/foundry.toml`, because that is what stops the decoder
 * running out of stack. A branch floor would therefore fail on the compilation
 * strategy rather than on a real testing gap, and a gate that fires for a
 * reason nobody can act on gets switched off.
 *
 * The attribution error runs one way only: it drops instrumentation it cannot
 * place, so a figure can be understated and never overstated. A line gate can
 * consequently fail earlier than the truth warrants, but it cannot be talked
 * into passing a genuine gap. That asymmetry is what makes gating on lines
 * safe and gating on branches not.
 *
 * A missing subject fails
 *
 * When a floored contract has no record in the report, this exits 2 rather
 * than passing it. A gate that reports success because it could not find its
 * subject is worse than no gate — it is the exact failure this script exists
 * to end. Renaming or moving a floored contract will therefore break this
 * gate loudly, which is the intended cost of naming subjects explicitly.
 *
 * Contracts with no floor
 *
 * Everything else the report carries is printed with its measured figure and
 * `none` in the floor column, and never affects the exit code. Floors come
 * from R27.1, which names exactly six contracts; a floor this tooling invented
 * for itself would gate a batch on a threshold nobody agreed to, and the first
 * time it fired the argument would be about the gate rather than about the
 * code. `UNFLOORED` below records why each such file is unfloored rather than
 * leaving the omission to be guessed at, and a file the map does not recognise
 * is printed as unclassified so somebody decides which tier it belongs in.
 *
 * Command surface
 *
 *   node scripts/check-coverage.mjs                 gate the report already on disk
 *   node scripts/check-coverage.mjs --run           measure first, then gate
 *   node scripts/check-coverage.mjs --report PATH   gate a report elsewhere
 *   node scripts/check-coverage.mjs --list          print the floor table and stop
 *   node scripts/check-coverage.mjs --help
 *
 * Exit codes: 0 every floored contract meets its floor, 1 at least one sits
 * below it, 2 the gate could not run — no report, an unreadable or unparseable
 * report, or a floored contract missing from it. The third code is the point:
 * a gate that cannot run must not report success.
 *
 * Requirements: 27.1
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The Foundry workspace. LCOV paths are relative to this directory. */
const FOUNDRY_DIR = "packages/contracts";
/** Where `forge coverage --report lcov` writes. Gitignored. */
const DEFAULT_REPORT = `${FOUNDRY_DIR}/lcov.info`;
/** The workspace script that produces the report, and the only definition of its flags. */
const MEASURE_SCRIPT = "coverage";
/** The workspace the measuring script belongs to. */
const MEASURE_FILTER = "@tabai/contracts";

/**
 * The floors, keyed by path as the report spells it. Each carries the reason
 * for its tier, so `--list` and every failure message can state it.
 */
const FLOORS = new Map([
  ["src/SettlementVerifier.sol", { floor: 90, tier: "money-handling" }],
  ["src/TabBook.sol", { floor: 90, tier: "money-handling" }],
  ["src/LimitLib.sol", { floor: 90, tier: "money-handling" }],
  ["src/Bond.sol", { floor: 90, tier: "money-handling" }],
  ["src/AgentRegistry.sol", { floor: 75, tier: "setters and bookkeeping" }],
  ["src/ServiceRegistry.sol", { floor: 75, tier: "setters and bookkeeping" }],
]);

/** What each tier means, printed with the table so the numbers carry their reason. */
const TIERS = new Map([
  [
    "money-handling",
    "value transfer, credit-limit decisions, and replay defence — an unexecuted line is an untested claim about money",
  ],
  [
    "setters and bookkeeping",
    "predominantly setters and timelock bookkeeping, so the marginal safety of the last fifteen points does not justify the time",
  ],
]);

/**
 * Why each remaining file the report carries — everything under `src/` that is
 * not floored above, plus the deployment scripts under `script/` — has no
 * floor. Informational only; nothing here can fail the build. Present so the
 * omissions are stated rather than inferred from the absence of an entry above.
 */
const UNFLOORED = new Map([
  [
    "script/01_DeployDecoder.s.sol",
    "a deployment script rather than a deployed contract. Every file under `script/` is split into a `run()` half that reads the environment and opens a broadcast, and a parameterised half that takes its inputs explicitly; only the second half is reachable without deploying, and `test/DeploymentScripts.t.sol` drives all seven scripts end to end through it. What stays unexecuted is the `run()` wrappers and the revert paths of guards that fire only on a misconfigured deployment, so a floor here would either be unreachable or would be satisfiable only by a test that actually deploys — which is task 12.2's job and not a unit test's. R27.1 floors the six Creditcoin contracts by name and these are not among them",
  ],
  [
    "script/02_DeployCore.s.sol",
    "a deployment script, split the same way: its parameterised half runs under `test/DeploymentScripts.t.sol`, and what is left is the `run()` wrapper and the misconfiguration guards",
  ],
  [
    "script/03_DeployVerifier.s.sol",
    "a deployment script, split the same way: its parameterised half runs under `test/DeploymentScripts.t.sol`, and what is left is the `run()` wrapper and the misconfiguration guards",
  ],
  [
    "script/04_Wire.s.sol",
    "a deployment script, split the same way: its parameterised half runs under `test/DeploymentScripts.t.sol`, and what is left is the `run()` wrapper and the misconfiguration guards",
  ],
  [
    "script/05_RegisterAssets.s.sol",
    "a deployment script, split the same way: its parameterised half runs under `test/DeploymentScripts.t.sol`, and what is left is the `run()` wrapper and the misconfiguration guards",
  ],
  [
    "script/06_DeploySepolia.s.sol",
    "a deployment script, split the same way: its parameterised half runs under `test/DeploymentScripts.t.sol`, and what is left is the `run()` wrapper and the misconfiguration guards",
  ],
  [
    "script/07_VerifyDeployment.s.sol",
    "a deployment script too, though a read-only check over a finished deployment rather than a step that writes one; `test/DeploymentScripts.t.sol` drives its parameterised half, and the `run()` wrapper and the revert paths that fire only on a deployment wired wrong need a real deployment to reach",
  ],
  [
    "script/DeploymentBase.sol",
    "the shared base those seven scripts inherit, split the same way and exercised through them, so the lines left over are the environment reading and the chain and address guards that only a misconfigured deployment trips",
  ],
  [
    "src/asc/TabAscBase.sol",
    "the shared base the floored contracts inherit, so its lines are exercised through them rather than by a suite of its own, and R27.1 floors the six by name",
  ],
  [
    "src/source/TabSettlement.sol",
    "on the settlement path and fully covered today, but it deploys to the Source Chain rather than to Creditcoin, and R27.1 floors the Creditcoin six",
  ],
  [
    "src/interfaces/IChainInfo.sol",
    "a pure declaration — the two lines the report counts have no body to execute, so a floor here would gate on nothing",
  ],
  [
    "src/interfaces/INativeQueryVerifier.sol",
    "a pure declaration, for the same reason",
  ],
]);

/** Suffix that marks a Solidity source file, for the staleness note. */
const SOL_SUFFIX = ".sol";
/** Directories the staleness note does not walk. */
const SKIP_DIRS = new Set(["lib", "node_modules", "out", "cache", "broadcast"]);

// ------------------------------------------------------------------ arguments

/**
 * @param {string[]} argv
 * @returns {{ mode: "gate" | "list" | "help", report: string, run: boolean }}
 */
function parseArgs(argv) {
  let mode = /** @type {"gate" | "list" | "help"} */ ("gate");
  let report = DEFAULT_REPORT;
  let run = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        mode = "help";
        break;
      case "--list":
        mode = "list";
        break;
      case "--run":
        run = true;
        break;
      case "--report": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          fail("`--report` needs a path to an LCOV report");
        }
        report = toRepoRelative(value);
        index += 1;
        break;
      }
      default:
        fail(`unrecognised argument \`${arg}\`. Run with \`--help\` for the command surface.`);
    }
  }

  return { mode, report, run };
}

function usage() {
  console.log(
    [
      "check-coverage — the per-contract line-coverage gate (R27.1).",
      "",
      "  node scripts/check-coverage.mjs                 gate the report already on disk",
      `                                                  (${DEFAULT_REPORT})`,
      "  node scripts/check-coverage.mjs --run           measure first, then gate",
      "  node scripts/check-coverage.mjs --report PATH   gate a report elsewhere",
      "  node scripts/check-coverage.mjs --list          print the floor table and stop",
      "",
      "Gates on line coverage only, never on branch coverage. Branch attribution",
      "under the Yul pipeline understates and never overstates, so a branch floor",
      "would fail on the compilation strategy rather than on a real gap.",
      "",
      "Exit codes: 0 every floored contract meets its floor, 1 at least one is below it,",
      "2 the gate could not run — no report, an unparseable report, or a missing subject.",
    ].join("\n"),
  );
}

/**
 * The gate could not run. Never used for a coverage shortfall.
 *
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`coverage: ${message}`);
  process.exit(2);
}

/**
 * @param {string} input a path in any form the shell produced
 * @returns {string} slash-separated and relative to the repository root
 */
function toRepoRelative(input) {
  const absolute = resolve(REPO_ROOT, input);
  const relative = absolute.slice(REPO_ROOT.length).replace(/\\/g, "/").replace(/^\/+/, "");
  if (relative.length === 0 || absolute.slice(0, REPO_ROOT.length) !== REPO_ROOT) {
    fail(`\`${input}\` sits outside the repository root`);
  }
  return relative;
}

// ------------------------------------------------------------------ measuring

/**
 * Produces the report by delegating to the workspace script that owns the
 * command. The flags matter — plain `forge coverage` fails with a decoder
 * stack overflow, and the `skip_files` profile key is inert in the pinned
 * toolchain, so `--no-match-coverage` is required rather than optional — and
 * they are written once, in `packages/contracts/package.json`. Shelling out to
 * that script keeps a second copy of them from drifting away from the first.
 *
 * @param {string} report the path the run is expected to write
 */
function measure(report) {
  const onWindows = process.platform === "win32";
  const runner = onWindows ? "pnpm.cmd" : "pnpm";
  console.log(
    `coverage: measuring — pnpm --filter ${MEASURE_FILTER} ${MEASURE_SCRIPT}. This takes several minutes.`,
  );
  try {
    // `shell` on Windows only, because Node refuses to spawn a `.cmd` without
    // one. Every argument here is a constant declared at the top of this file
    // and none comes from the command line, so there is nothing a shell could
    // be talked into interpreting.
    execFileSync(runner, ["--filter", MEASURE_FILTER, MEASURE_SCRIPT], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: onWindows,
    });
  } catch (error) {
    // A non-zero exit here usually means the suites did not all pass, or the
    // tree did not compile. Either way the figures such a run produces describe
    // something other than a passing suite, so this is exit 2 — the gate could
    // not run — rather than a coverage verdict of any kind. `--report` or
    // `coverage:check` will gate whatever report the run did leave behind, for
    // whoever wants to look at it deliberately.
    fail(
      `the measuring run exited non-zero, so its figures describe a run that did not pass: ` +
        `${error.message.trim()}. Run \`pnpm --filter ${MEASURE_FILTER} ${MEASURE_SCRIPT}\` ` +
        `directly to see why, or \`pnpm coverage:check\` to gate the report it left behind.`,
    );
  }
  if (!existsSync(join(REPO_ROOT, ...report.split("/")))) {
    fail(`the measuring run finished but wrote no report at ${report}`);
  }
}

// -------------------------------------------------------------------- parsing

/**
 * Normalises an LCOV `SF:` path to the repository-relative spelling used as a
 * key above. Producers write these relative to their own working directory,
 * and some write them absolute, so both are folded down to `src/...`.
 *
 * @param {string} raw
 * @returns {string}
 */
function normaliseSourcePath(raw) {
  let path = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const rootPrefix = `${REPO_ROOT.replace(/\\/g, "/")}/`;
  if (path.startsWith(rootPrefix)) path = path.slice(rootPrefix.length);
  const foundryPrefix = `${FOUNDRY_DIR}/`;
  if (path.startsWith(foundryPrefix)) path = path.slice(foundryPrefix.length);
  // An absolute path from another checkout root still ends in `src/...`.
  const marker = path.lastIndexOf("/src/");
  if (marker !== -1) path = path.slice(marker + 1);
  return path;
}

/**
 * @typedef {object} Record
 * @property {string} path
 * @property {Map<number, number>} lines line number to execution count
 * @property {number | null} declaredFound the report's own `LF:`, when present
 * @property {number | null} declaredHit the report's own `LH:`, when present
 */

/**
 * Parses LCOV into one record per source file, merging duplicate records for
 * the same file by summing execution counts.
 *
 * `DA:` is the authority here rather than `LF:`/`LH:`, because the per-line
 * records are what a reader can check by eye against the source. The declared
 * totals are kept and cross-checked; a disagreement is reported rather than
 * silently resolved.
 *
 * @param {string} text
 * @param {string} reportPath for messages
 * @returns {{ records: Map<string, Record>, mismatches: string[] }}
 */
function parseLcov(text, reportPath) {
  /** @type {Map<string, Record>} */
  const records = new Map();
  const mismatches = [];
  /** @type {Record | null} */
  let current = null;
  let lineNumber = 0;

  const finish = () => {
    if (current === null) return;
    const { declaredFound, declaredHit, lines, path } = current;
    if (lines.size === 0 && declaredFound === null) {
      fail(
        `${reportPath} carries a record for ${path} with neither per-line data nor an \`LF:\` total, so it cannot be read`,
      );
    }
    if (declaredFound !== null && lines.size > 0) {
      const hit = [...lines.values()].filter((count) => count > 0).length;
      if (declaredFound !== lines.size || (declaredHit !== null && declaredHit !== hit)) {
        mismatches.push(
          `${path}: per-line data says ${hit}/${lines.size}, the report's own totals say ${declaredHit ?? "?"}/${declaredFound}`,
        );
      }
    }
    current = null;
  };

  for (const raw of text.split(/\r\n|\n|\r/)) {
    lineNumber += 1;
    const line = raw.trim();
    if (line.length === 0) continue;

    if (line.startsWith("SF:")) {
      finish();
      const path = normaliseSourcePath(line.slice(3));
      if (path.length === 0) fail(`${reportPath}:${lineNumber} declares a source file with no path`);
      const existing = records.get(path);
      if (existing !== undefined) {
        current = existing;
        // A second record for one file replaces the declared totals it is
        // about to invalidate; the merged per-line data is what counts.
        current.declaredFound = null;
        current.declaredHit = null;
      } else {
        current = { path, lines: new Map(), declaredFound: null, declaredHit: null };
        records.set(path, current);
      }
      continue;
    }

    if (line === "end_of_record") {
      finish();
      continue;
    }

    if (current === null) continue;

    if (line.startsWith("DA:")) {
      const [rawLine, rawCount] = line.slice(3).split(",");
      const sourceLine = Number.parseInt(rawLine, 10);
      // A count can be `-` in some producers, meaning "no data".
      const count = rawCount === undefined || rawCount.trim() === "-" ? 0 : Number(rawCount);
      if (!Number.isInteger(sourceLine) || sourceLine < 0 || !Number.isFinite(count)) {
        fail(`${reportPath}:${lineNumber} is not a readable \`DA:\` record: \`${line}\``);
      }
      current.lines.set(sourceLine, (current.lines.get(sourceLine) ?? 0) + Math.max(0, count));
      continue;
    }

    if (line.startsWith("LF:") || line.startsWith("LH:")) {
      const value = Number.parseInt(line.slice(3), 10);
      if (!Number.isInteger(value) || value < 0) {
        fail(`${reportPath}:${lineNumber} is not a readable \`${line.slice(0, 2)}:\` record`);
      }
      if (line.startsWith("LF:")) current.declaredFound = value;
      else current.declaredHit = value;
    }
  }
  finish();

  if (records.size === 0) {
    fail(
      `${reportPath} carries no source records, so there is nothing to gate. ` +
        `Produce a report with \`pnpm --filter ${MEASURE_FILTER} ${MEASURE_SCRIPT}\`.`,
    );
  }

  return { records, mismatches };
}

/**
 * @param {Record} record
 * @returns {{ found: number, hit: number }}
 */
function tally(record) {
  if (record.lines.size === 0) {
    return { found: record.declaredFound ?? 0, hit: record.declaredHit ?? 0 };
  }
  return {
    found: record.lines.size,
    hit: [...record.lines.values()].filter((count) => count > 0).length,
  };
}

/**
 * The comparison is integer arithmetic on purpose: `hit / found * 100 >= floor`
 * in floating point can call 89.999... a pass at exactly the boundary.
 *
 * @param {number} hit
 * @param {number} found
 * @param {number} floor percent, integral
 * @returns {boolean}
 */
function meetsFloor(hit, found, floor) {
  return hit * 100 >= floor * found;
}

/**
 * Truncated rather than rounded, so a figure below a floor can never be
 * displayed as though it met it.
 *
 * @param {number} hit
 * @param {number} found
 * @returns {string}
 */
function formatPercent(hit, found) {
  if (found === 0) return "n/a";
  return `${(Math.floor((hit / found) * 10000) / 100).toFixed(2)} %`;
}

// ------------------------------------------------------------------ staleness

/**
 * @param {string} dir absolute
 * @returns {number} the newest modification time among Solidity sources, or 0
 */
function newestSolidityMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      newest = Math.max(newest, newestSolidityMtime(join(dir, entry.name)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(SOL_SUFFIX)) continue;
    try {
      newest = Math.max(newest, statSync(join(dir, entry.name)).mtimeMs);
    } catch {
      // A file that vanished between listing and stat tells us nothing.
    }
  }
  return newest;
}

/**
 * A note, never a failure. Gating a stale report is a real hazard, but the
 * remedy is a measuring run the reader chooses to make, and refusing to run
 * would make the gate unusable while sources are being edited.
 *
 * @param {string} reportPath repository-relative
 */
function noteStaleness(reportPath) {
  let reportMtime;
  try {
    reportMtime = statSync(join(REPO_ROOT, ...reportPath.split("/"))).mtimeMs;
  } catch {
    return;
  }
  const sourceMtime = newestSolidityMtime(join(REPO_ROOT, FOUNDRY_DIR, "src"));
  const testMtime = newestSolidityMtime(join(REPO_ROOT, FOUNDRY_DIR, "test"));
  const newest = Math.max(sourceMtime, testMtime);
  if (newest > reportMtime) {
    console.log(
      `coverage: note — a Solidity file has changed since this report was written ` +
        `(${new Date(reportMtime).toISOString()}). The figures below describe the tree as it was then. ` +
        `Re-measure with \`--run\` for current ones.`,
    );
  }
}

// ----------------------------------------------------------------- reporting

/** Prints the floor table and the reason for each tier. */
function listFloors() {
  console.log("check-coverage — floors, on line coverage only (R27.1).\n");
  for (const [tier, reason] of TIERS) {
    const members = [...FLOORS.entries()].filter(([, entry]) => entry.tier === tier);
    if (members.length === 0) continue;
    console.log(`  ${members[0][1].floor} percent — ${reason}`);
    for (const [path] of members) console.log(`    ${path}`);
    console.log("");
  }
  console.log("  no floor — reported with its figure, never gated:");
  for (const [path, reason] of UNFLOORED) console.log(`    ${path}\n      ${reason}`);
  console.log(
    "\n  A floored contract missing from the report exits 2, not 0. A gate that passes\n" +
      "  because it could not find its subject is worse than no gate.",
  );
}

/**
 * @param {{ path: string, found: number, hit: number, floor: number | null, verdict: string }[]} rows
 */
function printTable(rows) {
  const pathWidth = Math.max(8, ...rows.map((row) => row.path.length));
  const linesWidth = Math.max(5, ...rows.map((row) => `${row.hit}/${row.found}`.length));
  console.log(
    `${"".padEnd(6)}${"contract".padEnd(pathWidth)}  ${"lines".padEnd(linesWidth)}  ${"measured".padStart(8)}  floor`,
  );
  for (const row of rows) {
    const mark =
      row.verdict === "below" ? " FAIL " : row.verdict === "none" ? "  --  " : "  ok  ";
    console.log(
      `${mark}${row.path.padEnd(pathWidth)}  ${`${row.hit}/${row.found}`.padEnd(linesWidth)}  ${formatPercent(
        row.hit,
        row.found,
      ).padStart(8)}  ${row.floor === null ? "none" : `${row.floor} %`}`,
    );
  }
}

// ---------------------------------------------------------------------- main

function main() {
  const { mode, report, run } = parseArgs(process.argv.slice(2));

  if (mode === "help") {
    usage();
    return;
  }
  if (mode === "list") {
    listFloors();
    return;
  }

  if (run) measure(report);

  const absolute = join(REPO_ROOT, ...report.split("/"));
  if (!existsSync(absolute)) {
    console.error(`coverage: no report at ${report}, so there is nothing to gate.`);
    console.error("coverage: produce one, then run the gate again:");
    console.error(`coverage:   pnpm --filter ${MEASURE_FILTER} ${MEASURE_SCRIPT}`);
    console.error("coverage: or do both in one command:");
    console.error("coverage:   node scripts/check-coverage.mjs --run");
    process.exit(2);
  }

  let text;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    fail(`${report} could not be read: ${error.message}`);
  }
  if (text.trim().length === 0) fail(`${report} is empty, so there is nothing to gate`);

  const { records, mismatches } = parseLcov(text, report);
  console.log(
    `coverage: read ${report} — ${records.size} source ${records.size === 1 ? "record" : "records"}.`,
  );
  if (!run) noteStaleness(report);
  console.log(
    "coverage: gating on line coverage only. Branch attribution under the Yul pipeline understates",
  );
  console.log(
    "coverage: and never overstates, so a branch floor would fail on the compilation strategy.",
  );

  /** @type {{ path: string, found: number, hit: number, floor: number | null, verdict: string }[]} */
  const floored = [];
  /** @type {{ path: string, found: number, hit: number, floor: number | null, verdict: string }[]} */
  const informational = [];
  const missing = [];
  const unclassified = [];
  const belowFloor = [];

  for (const [path, entry] of FLOORS) {
    const record = records.get(path);
    if (record === undefined) {
      missing.push(path);
      continue;
    }
    const { found, hit } = tally(record);
    if (found === 0) {
      missing.push(`${path} (present in the report with zero instrumented lines)`);
      continue;
    }
    const ok = meetsFloor(hit, found, entry.floor);
    if (!ok) {
      belowFloor.push({ path, found, hit, floor: entry.floor, tier: entry.tier });
    }
    floored.push({ path, found, hit, floor: entry.floor, verdict: ok ? "meets" : "below" });
  }

  for (const [path, record] of records) {
    if (FLOORS.has(path)) continue;
    const { found, hit } = tally(record);
    informational.push({ path, found, hit, floor: null, verdict: "none" });
    if (!UNFLOORED.has(path)) unclassified.push(path);
  }

  console.log("");
  printTable([...floored, ...informational]);

  if (mismatches.length > 0) {
    console.log(
      `\ncoverage: note — ${mismatches.length} ${
        mismatches.length === 1 ? "record disagrees" : "records disagree"
      } with the report's own totals. Per-line data is authoritative here:`,
    );
    for (const mismatch of mismatches) console.log(`  - ${mismatch}`);
  }

  if (informational.length > 0) {
    console.log("\ncoverage: the rows marked `--` carry no floor:");
    for (const row of informational) {
      const reason = UNFLOORED.get(row.path);
      console.log(
        `  - ${row.path}: ${
          reason ?? "unclassified — no floor and no recorded reason. Decide which tier it belongs in."
        }`,
      );
    }
  }

  if (unclassified.length > 0) {
    console.log(
      `\ncoverage: ${unclassified.length} unclassified ${
        unclassified.length === 1 ? "file" : "files"
      } above. Floors come from R27.1, so a new file is not a coverage failure —`,
    );
    console.log(
      "coverage: but it is a decision this script cannot make for you. Add it to FLOORS or to UNFLOORED.",
    );
  }

  // Order matters. A missing subject means the gate did not run over what it
  // was asked to gate, which is a different and worse condition than a
  // shortfall, so it is reported first and with its own exit code.
  if (missing.length > 0) {
    console.error(
      `\ncoverage: ${missing.length} floored ${
        missing.length === 1 ? "contract is" : "contracts are"
      } absent from the report, so the gate did not run over ${
        missing.length === 1 ? "it" : "them"
      }:\n`,
    );
    for (const path of missing) console.error(`  x ${path}`);
    console.error(
      "\ncoverage: this exits 2 rather than passing. A gate that reports success because it could not",
    );
    console.error(
      "coverage: find its subject is worse than no gate. If a contract moved, update FLOORS in this script;",
    );
    console.error(
      `coverage: if the report is partial, re-measure with \`pnpm --filter ${MEASURE_FILTER} ${MEASURE_SCRIPT}\`.`,
    );
    process.exit(2);
  }

  if (belowFloor.length > 0) {
    console.error(
      `\ncoverage: ${belowFloor.length} ${
        belowFloor.length === 1 ? "contract sits" : "contracts sit"
      } below ${belowFloor.length === 1 ? "its" : "their"} line-coverage floor\n`,
    );
    for (const row of belowFloor) {
      console.error(
        `  x ${row.path}: ${formatPercent(row.hit, row.found)} of lines (${row.hit}/${row.found}), floor ${row.floor} %`,
      );
      console.error(`      ${row.floor} percent because ${TIERS.get(row.tier)}`);
      console.error(
        `      ${Math.ceil((row.floor * row.found) / 100) - row.hit} more executed ${
          Math.ceil((row.floor * row.found) / 100) - row.hit === 1 ? "line" : "lines"
        } would clear it`,
      );
    }
    console.error(
      "\ncoverage: add tests for the unexecuted lines. `forge coverage --report summary` names them per function,",
    );
    console.error(
      `coverage: and the per-line detail is in ${report} as \`DA:<line>,0\` records under each contract.`,
    );
    process.exit(1);
  }

  console.log(
    `\ncoverage: ok. ${floored.length} floored ${
      floored.length === 1 ? "contract meets its" : "contracts meet their"
    } floor, ${informational.length} reported without one.`,
  );
}

main();
