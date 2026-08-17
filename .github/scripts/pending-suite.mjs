#!/usr/bin/env node
/**
 * The guard that keeps a declared-but-unimplemented job honest.
 *
 * Three jobs in this pipeline — `property-tests`, `e2e`, and `reproduce` — are
 * declared now so the job graph and the required-check list are complete, while
 * the suites they run arrive with later tasks. A job like that has one dangerous
 * failure mode: it finds nothing to run, succeeds, and is then indistinguishable
 * from a job that ran a real suite and passed. `deploy-gate` exists to stop
 * exactly that, so it cannot be allowed to happen underneath it.
 *
 * This guard makes the empty state loud instead:
 *
 *   - When the suite is absent, it emits a workflow warning annotation, writes a
 *     line into the job summary naming the task that will fill the gap, and
 *     reports `pending=true` as a step output. `deploy-gate` collects those
 *     outputs and publishes the ledger, so every run states in plain text which
 *     of its required checks ran nothing.
 *
 *   - When the suite appears, the guard FAILS. That is the point. The real steps
 *     of each job are already written and are conditional on the guard reporting
 *     `pending`, so a job converts from placeholder to real check by deleting
 *     the guard step and nothing else. Failing on arrival is what forces that
 *     deletion instead of letting a real suite sit unrun behind a stale
 *     condition.
 *
 * Discovery
 *
 *   --paths <pathspec>...   git pathspecs, matched against everything git tracks
 *                           plus untracked paths git does not ignore
 *   --script <name>         a script name in the root manifest
 *
 * A suite counts as present when any pathspec matches or any named script
 * exists. Discovery goes through git so the ignore rules decide scope, and an
 * untracked-but-not-ignored file counts, because a suite in the working tree is
 * a suite whether or not it has been recorded yet.
 *
 * Exit codes: 0 the suite is still absent, 1 the suite exists and the guard
 * must be deleted, 2 the guard could not run.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(".");
const MANIFEST_FILE = "package.json";

/**
 * @param {string} message
 * @returns {never}
 */
function cannotRun(message) {
  console.error(`pending-suite: ${message}`);
  process.exit(2);
}

/**
 * @param {string[]} argv
 * @returns {{ label: string, task: string, paths: string[], scripts: string[] }}
 */
function parseArgs(argv) {
  let label = "";
  let task = "";
  /** @type {string[]} */
  const paths = [];
  /** @type {string[]} */
  const scripts = [];
  /** @type {"paths" | "scripts" | null} */
  let collecting = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--label":
        label = argv[index + 1] ?? "";
        index += 1;
        collecting = null;
        break;
      case "--task":
        task = argv[index + 1] ?? "";
        index += 1;
        collecting = null;
        break;
      case "--paths":
        collecting = "paths";
        break;
      case "--script":
      case "--scripts":
        collecting = "scripts";
        break;
      default:
        if (argument.startsWith("--")) cannotRun(`unrecognised argument \`${argument}\``);
        if (collecting === "paths") paths.push(argument);
        else if (collecting === "scripts") scripts.push(argument);
        else cannotRun(`\`${argument}\` arrived before any of --paths or --script`);
    }
  }

  if (label.length === 0) cannotRun("--label is required");
  if (task.length === 0) cannotRun("--task is required, so the warning names what fills the gap");
  if (paths.length === 0 && scripts.length === 0) {
    cannotRun("give at least one --paths pathspec or --script name, or the guard proves nothing");
  }
  return { label, task, paths, scripts };
}

/**
 * @param {string[]} pathspecs
 * @returns {string[]} matching paths
 */
function matchingPaths(pathspecs) {
  if (pathspecs.length === 0) return [];
  try {
    return execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...pathspecs],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\0")
      .filter((entry) => entry.length > 0);
  } catch (error) {
    cannotRun(`git refused to list paths: ${String(error.message).trim()}`);
    return [];
  }
}

/**
 * @param {string[]} names
 * @returns {string[]} the names the root manifest declares
 */
function matchingScripts(names) {
  if (names.length === 0) return [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, MANIFEST_FILE), "utf8"));
  } catch (error) {
    cannotRun(`${MANIFEST_FILE} could not be read: ${error.message}`);
  }
  const declared = manifest.scripts ?? {};
  return names.filter((name) => typeof declared[name] === "string");
}

/**
 * @param {string} name the environment variable naming a file to append to
 * @param {string} line
 */
function appendToJobFile(name, line) {
  const target = process.env[name];
  if (target === undefined || target.length === 0) return;
  try {
    appendFileSync(target, `${line}\n`, "utf8");
  } catch (error) {
    cannotRun(`${name} could not be appended to: ${error.message}`);
  }
}

const { label, task, paths, scripts } = parseArgs(process.argv.slice(2));
const foundPaths = matchingPaths(paths);
const foundScripts = matchingScripts(scripts);
const described = [...paths.map((entry) => `path \`${entry}\``), ...scripts.map((entry) => `script \`${entry}\``)];

if (foundPaths.length > 0 || foundScripts.length > 0) {
  console.error(`pending-suite: ${label} now exists, so this guard is stale.\n`);
  for (const path of foundPaths) console.error(`  + ${path}`);
  for (const script of foundScripts) console.error(`  + ${MANIFEST_FILE} declares the \`${script}\` script`);
  console.error(
    `\npending-suite: delete this guard step from the job. The steps below it are already written and`,
  );
  console.error(
    "pending-suite: run as soon as the guard is gone, which turns the placeholder into a real check.",
  );
  appendToJobFile("GITHUB_OUTPUT", "pending=false");
  process.exit(1);
}

const summary = `${label} runs nothing yet. It arrives with ${task}. Discovery looked for ${described.join(
  " and ",
)}.`;

// The annotation puts the empty state on the run's own summary page, where a
// green check would otherwise be the only thing visible.
console.log(`::warning title=Declared placeholder::${summary}`);
console.log(`pending-suite: ${summary}`);
appendToJobFile("GITHUB_OUTPUT", "pending=true");
appendToJobFile("GITHUB_STEP_SUMMARY", `- **Placeholder** — ${summary}`);
