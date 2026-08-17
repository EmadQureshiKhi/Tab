#!/usr/bin/env node
/**
 * Tracked-versus-ignored assertion for the `secret-scan` job.
 *
 * Requirement 28.5 says the ignore rules keep the local-only working
 * directories and the vocabulary denylist file out of version control. A secret
 * scanner will not catch a breach of that rule: a scratch directory or a
 * populated `.env` can enter history carrying nothing a detector recognises and
 * still be exactly the thing the rule exists to prevent. So the rule is asserted
 * directly.
 *
 * The assertion is `git ls-files --cached --ignored --exclude-standard`: every
 * path git tracks that git also ignores. That set should be empty. It is
 * deliberately wider than the local-only rules alone — build output and the
 * denylist file are covered by the same sweep — because a tracked path that the
 * ignore rules exclude is a contradiction whichever rule produced it.
 *
 * One exemption, and only one: a submodule gitlink. The Foundry dependency tree
 * is ignored as a directory while one entry inside it is a gitlink this project
 * pins on purpose, declared in the repository-root `.gitmodules`. A gitlink is
 * mode 160000 in the index, carries no file contents, and cannot leak a secret.
 * Each exempted path must be declared in `.gitmodules`, so the exemption cannot
 * quietly widen: an ignored-and-tracked gitlink nobody declared still fails.
 *
 * Exit codes: 0 the tracked and ignored sets are disjoint, 1 they overlap,
 * 2 the check could not run.
 *
 * Requirements: 28.5
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(process.argv[2] ?? ".");
const MODULES_FILE = ".gitmodules";
const GITLINK_MODE = "160000";

/**
 * @param {string} message
 * @returns {never}
 */
function cannotRun(message) {
  console.error(`tracked-ignore: ${message}`);
  process.exit(2);
}

/**
 * @param {string[]} args
 * @returns {string[]} NUL-separated git output, split
 */
function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((entry) => entry.length > 0);
  } catch (error) {
    cannotRun(`git refused \`${args.join(" ")}\`: ${String(error.message).trim()}`);
    return [];
  }
}

/**
 * The submodule paths the repository declares. Read from `.gitmodules` rather
 * than from the index, so a gitlink nobody declared is not exempt.
 *
 * @returns {Set<string>}
 */
function declaredSubmodulePaths() {
  let raw;
  try {
    raw = readFileSync(resolve(REPO_ROOT, MODULES_FILE), "utf8");
  } catch {
    // No submodules declared is an ordinary state, not an error.
    return new Set();
  }
  const paths = new Set();
  for (const line of raw.split(/\r\n|\n|\r/)) {
    const entry = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (entry !== null) paths.add(entry[1].replace(/\\/g, "/"));
  }
  return paths;
}

/**
 * Index mode per path, so a gitlink can be told apart from a regular file.
 *
 * @param {string[]} paths
 * @returns {Map<string, string>}
 */
function indexModes(paths) {
  if (paths.length === 0) return new Map();
  const modes = new Map();
  for (const entry of git(["ls-files", "--stage", "-z", "--", ...paths])) {
    const parsed = /^(\d{6})\s+[0-9a-f]+\s+\d+\t([\s\S]+)$/.exec(entry);
    if (parsed !== null) modes.set(parsed[2], parsed[1]);
  }
  return modes;
}

const trackedAndIgnored = git(["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"]);
const declared = declaredSubmodulePaths();
const modes = indexModes(trackedAndIgnored);

/** @type {string[]} */
const offenders = [];
/** @type {string[]} */
const exempt = [];

for (const path of trackedAndIgnored) {
  const mode = modes.get(path);
  if (mode === GITLINK_MODE && declared.has(path)) {
    exempt.push(path);
    continue;
  }
  const why =
    mode === GITLINK_MODE
      ? `a submodule gitlink that ${MODULES_FILE} does not declare`
      : `mode ${mode ?? "unknown"}`;
  offenders.push(`${path}  (${why})`);
}

if (exempt.length > 0) {
  console.log(
    `tracked-ignore: ${exempt.length} declared submodule ${
      exempt.length === 1 ? "gitlink is" : "gitlinks are"
    } exempt, each declared in ${MODULES_FILE}:`,
  );
  for (const path of exempt) console.log(`  - ${path}`);
}

if (offenders.length > 0) {
  console.error(
    `\ntracked-ignore: ${offenders.length} tracked ${
      offenders.length === 1 ? "path matches" : "paths match"
    } the ignore rules\n`,
  );
  for (const offender of offenders) console.error(`  x ${offender}`);
  console.error(
    "\ntracked-ignore: requirement 28.5 keeps every local-only working directory and the vocabulary",
  );
  console.error(
    "tracked-ignore: denylist file out of version control. Remove each path from the index, and if it",
  );
  console.error("tracked-ignore: carried a secret, rotate that secret before anything else.");
  process.exit(1);
}

console.log(
  `tracked-ignore: ok. git tracks ${trackedAndIgnored.length} ignored ${
    trackedAndIgnored.length === 1 ? "path" : "paths"
  }, all of them declared submodule gitlinks.`,
);
