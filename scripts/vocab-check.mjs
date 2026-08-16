#!/usr/bin/env node
/**
 * Vocabulary gate.
 *
 * Fails the build when prohibited terminology appears anywhere git considers
 * part of this repository — in file contents, in filenames, or in directory
 * names. Its purpose is editorial consistency: every document, comment,
 * identifier, and string here speaks about Creditcoin, the Attestcoin
 * Protocol, and Tab, in Creditcoin's own vocabulary, and nothing else.
 *
 * The denylist is itself a secret and is never committed. It is materialised
 * into the gitignored `.vocabulary-denylist` file — one term per line — from
 * the `VOCAB_DENYLIST` environment variable, so the prohibited terms never
 * appear in the tree, including inside the tool that enforces their absence.
 * When the file is absent or carries no terms the gate exits 2 with a clear
 * message. A gate that passes vacuously is worse than no gate at all.
 *
 * Command surface
 *
 *   node scripts/vocab-check.mjs                 scan everything git tracks
 *                                                plus every untracked path
 *                                                git does not ignore
 *   node scripts/vocab-check.mjs --staged        scan staged paths only
 *   node scripts/vocab-check.mjs --files a b c   scan an explicit set
 *   node scripts/vocab-check.mjs --materialise   write the denylist file from
 *                                                VOCAB_DENYLIST and stop
 *   node scripts/vocab-check.mjs --help
 *
 * Exit codes: 0 clean, 1 at least one match, 2 the gate could not run.
 *
 * Local enforcement mirrors CI through `.githooks/pre-commit`, which runs this
 * script over staged paths only. One-time setup, from the repository root:
 *
 *   git config core.hooksPath .githooks        (or: pnpm hooks:install)
 *
 * Because the candidate set comes from git, everything `.gitignore` excludes is
 * out of scope automatically — including the local-only working directories and
 * the denylist file itself.
 *
 * Requirements: 28.5, 28.6
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The gitignored file holding one prohibited term per line. */
const DENYLIST_FILE = ".vocabulary-denylist";
/** The environment variable the denylist file is materialised from. */
const DENYLIST_ENV = "VOCAB_DENYLIST";

/** Any path with one of these segments is out of scope. */
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "out",
  "dist",
  ".next",
  "cache",
  "broadcast",
]);

/**
 * Lockfiles mirror upstream package names verbatim, so they are out of scope.
 * The denylist file is out of scope for the obvious reason.
 */
const EXCLUDED_BASENAMES = new Set([
  DENYLIST_FILE,
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
  "foundry.lock",
  "Cargo.lock",
]);

/** Cheap first pass before content sniffing. SVG is text and stays in scope. */
const BINARY_EXTENSIONS = new Set([
  "7z", "avif", "bin", "bmp", "br", "bz2", "class", "dll", "dylib", "eot",
  "exe", "gif", "gz", "heic", "ico", "icns", "jar", "jpeg", "jpg", "keystore",
  "mov", "mp3", "mp4", "node", "otf", "pdf", "png", "so", "tar", "tgz", "ttf",
  "wasm", "wav", "webm", "webp", "woff", "woff2", "zip", "zst",
]);

/** Bytes inspected when sniffing for a NUL byte. */
const SNIFF_BYTES = 8192;

/** Characters that must be escaped before a term becomes a pattern. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/g;
/** A word character, for the boundary lookarounds. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;
/** Widest window of an offending line printed either side of a match. */
const CONTEXT_WIDTH = 48;

// ------------------------------------------------------------------ arguments

/**
 * @param {string[]} argv
 * @returns {{ mode: "all" | "staged" | "files" | "materialise" | "help", files: string[] }}
 */
function parseArgs(argv) {
  if (argv.length === 0) return { mode: "all", files: [] };

  const [flag, ...rest] = argv;
  switch (flag) {
    case "--help":
    case "-h":
      return { mode: "help", files: [] };
    case "--staged":
      if (rest.length > 0) fail(`\`--staged\` takes no arguments, received ${rest.length}`);
      return { mode: "staged", files: [] };
    case "--materialise":
    case "--materialize":
      if (rest.length > 0) fail(`\`${flag}\` takes no arguments, received ${rest.length}`);
      return { mode: "materialise", files: [] };
    case "--files":
      if (rest.length === 0) fail("`--files` needs at least one path");
      return { mode: "files", files: rest.map(toRepoRelative) };
    default:
      fail(`unrecognised argument \`${flag}\`. Run with \`--help\` for the command surface.`);
      return { mode: "help", files: [] };
  }
}

function usage() {
  console.log(
    [
      "vocab-check — the repository's vocabulary gate.",
      "",
      "  node scripts/vocab-check.mjs                 scan everything git tracks plus",
      "                                               untracked paths git does not ignore",
      "  node scripts/vocab-check.mjs --staged        scan staged paths only",
      "  node scripts/vocab-check.mjs --files a b c   scan an explicit set of paths",
      "  node scripts/vocab-check.mjs --materialise   write the denylist file from",
      `                                               ${DENYLIST_ENV} and stop`,
      "",
      `The denylist is read from \`${DENYLIST_FILE}\`, which is gitignored and never`,
      `committed. In CI it is materialised at job start from the ${DENYLIST_ENV} secret.`,
      "",
      "Exit codes: 0 clean, 1 at least one match, 2 the gate could not run.",
      "",
      "Install the pre-commit hook once, from the repository root:",
      "  git config core.hooksPath .githooks",
    ].join("\n"),
  );
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`vocab: ${message}`);
  process.exit(2);
}

/**
 * @param {string} input a path in any form the shell or git produced
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

// -------------------------------------------------------------------- denylist

/**
 * @param {string} raw newline-separated terms
 * @returns {string[]} trimmed, comment-free, case-insensitively deduplicated
 */
function parseTerms(raw) {
  const seen = new Set();
  const terms = [];
  for (const line of raw.split(/\r\n|\n|\r/)) {
    const term = line.trim();
    if (term.length === 0 || term.startsWith("#")) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

/**
 * Writes the denylist file from the environment. Reports the term count only,
 * never a term.
 *
 * @param {{ required: boolean }} options
 * @returns {boolean} whether the file was written
 */
function materialiseDenylist({ required }) {
  const raw = process.env[DENYLIST_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    if (!required) return false;
    fail(
      `${DENYLIST_ENV} is unset or empty, so the denylist cannot be materialised. ` +
        `In CI, supply it from the repository secret of the same name.`,
    );
  }

  const terms = parseTerms(raw);
  if (terms.length === 0) {
    fail(`${DENYLIST_ENV} carries no terms once blank and comment lines are dropped.`);
  }

  writeFileSync(join(REPO_ROOT, DENYLIST_FILE), `${terms.join("\n")}\n`, "utf8");
  console.log(
    `vocab: materialised ${DENYLIST_FILE} from ${DENYLIST_ENV} — ${terms.length} ${
      terms.length === 1 ? "term" : "terms"
    }.`,
  );
  return true;
}

/**
 * @returns {string[]} the denylist terms, or exits 2 when there are none to read
 */
function loadDenylist() {
  const denylistPath = join(REPO_ROOT, DENYLIST_FILE);

  if (!existsSync(denylistPath)) materialiseDenylist({ required: false });

  if (!existsSync(denylistPath)) {
    console.error(`vocab: ${DENYLIST_FILE} is absent, so there is nothing to enforce.`);
    console.error("vocab: the gate refuses to pass without a denylist. Supply one of:");
    console.error(
      `vocab:   - a local ${DENYLIST_FILE} file, one term per line (gitignored, never committed)`,
    );
    console.error(
      `vocab:   - the ${DENYLIST_ENV} environment variable, from which this script writes that file`,
    );
    process.exit(2);
  }

  let raw;
  try {
    raw = readFileSync(denylistPath, "utf8");
  } catch (error) {
    fail(`${DENYLIST_FILE} could not be read: ${error.message}`);
  }

  const terms = parseTerms(raw);
  if (terms.length === 0) {
    console.error(
      `vocab: ${DENYLIST_FILE} carries no terms once blank and comment lines are dropped.`,
    );
    console.error("vocab: the gate refuses to pass with an empty denylist.");
    process.exit(2);
  }
  return terms;
}

/**
 * @param {string[]} terms
 * @returns {{ term: string, pattern: RegExp }[]}
 */
function buildMatchers(terms) {
  return terms.map((term) => {
    const body = term.replace(REGEX_SPECIAL, "\\$&");
    const lead = WORD_CHAR.test(term.slice(0, 1)) ? "(?<![\\p{L}\\p{N}_])" : "";
    const tail = WORD_CHAR.test(term.slice(-1)) ? "(?![\\p{L}\\p{N}_])" : "";
    return { term, pattern: new RegExp(`${lead}${body}${tail}`, "giu") };
  });
}

// ---------------------------------------------------------------- candidates

/**
 * @param {string[]} args
 * @returns {string[]} NUL-separated git output, split
 */
function git(args) {
  const stdout = execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

function hasCommits() {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The candidate set always comes from git, so `.gitignore` decides scope.
 *
 * @param {"all" | "staged" | "files"} mode
 * @param {string[]} explicit
 * @returns {string[]}
 */
function listCandidates(mode, explicit) {
  try {
    if (mode === "files") return explicit;
    if (mode === "staged") {
      return hasCommits()
        ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
        : git(["ls-files", "--cached", "-z"]);
    }
    // Everything git tracks, plus untracked paths it does not ignore. The
    // second half matters in a tree whose first commit does not exist yet: a
    // gate that scanned an empty set would pass vacuously.
    return git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  } catch (error) {
    fail(`git refused to list paths: ${error.message.trim()}`);
    return [];
  }
}

/**
 * @param {string} relPath
 * @returns {boolean}
 */
function isExcluded(relPath) {
  const segments = relPath.split("/");
  const basename = segments[segments.length - 1];
  if (EXCLUDED_BASENAMES.has(basename)) return true;
  return segments.some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

/**
 * @param {string} relPath
 * @returns {boolean}
 */
function hasBinaryExtension(relPath) {
  const basename = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(basename.slice(dot + 1).toLowerCase());
}

/**
 * @param {Buffer} buffer
 * @returns {{ binary: true, why: string } | { binary: false, text: string }}
 */
function decode(buffer) {
  const sniffed = buffer.subarray(0, Math.min(buffer.length, SNIFF_BYTES));
  if (sniffed.includes(0)) return { binary: true, why: "NUL byte in the leading bytes" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { binary: false, text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
  } catch {
    return { binary: true, why: "not decodable as UTF-8" };
  }
}

// ----------------------------------------------------------------- reporting

/**
 * Renders the offending line with the match marked, windowed so a long line
 * stays readable, and with tabs flattened so the marker stays aligned.
 *
 * @param {string} line
 * @param {number} index zero-based offset of the match
 * @param {number} length
 * @returns {{ text: string, marker: string }}
 */
function markMatch(line, index, length) {
  const flat = line.replace(/\t/g, " ");
  const from = Math.max(0, index - CONTEXT_WIDTH);
  const to = Math.min(flat.length, index + length + CONTEXT_WIDTH);
  const head = from > 0 ? "..." : "";
  const tail = to < flat.length ? "..." : "";
  return {
    text: `${head}${flat.slice(from, to)}${tail}`,
    marker: `${" ".repeat(head.length + index - from)}${"^".repeat(Math.max(1, length))}`,
  };
}

/**
 * @param {{ term: string, pattern: RegExp }[]} matchers
 * @param {string} haystack
 * @returns {{ term: string, index: number, length: number }[]}
 */
function findMatches(matchers, haystack) {
  const found = [];
  for (const { term, pattern } of matchers) {
    pattern.lastIndex = 0;
    for (const match of haystack.matchAll(pattern)) {
      found.push({ term, index: match.index, length: match[0].length });
    }
  }
  return found.sort((a, b) => a.index - b.index || a.term.localeCompare(b.term));
}

// ---------------------------------------------------------------------- main

function main() {
  const { mode, files } = parseArgs(process.argv.slice(2));

  if (mode === "help") {
    usage();
    return;
  }

  if (mode === "materialise") {
    materialiseDenylist({ required: true });
    return;
  }

  const terms = loadDenylist();
  const matchers = buildMatchers(terms);
  console.log(
    `vocab: loaded ${terms.length} ${terms.length === 1 ? "term" : "terms"} from ${DENYLIST_FILE}.`,
  );

  const candidates = listCandidates(mode, files);
  /** @type {string[]} */
  const violations = [];
  /** @type {string[]} */
  const skipped = [];
  let scannedFiles = 0;
  let scannedPaths = 0;
  let matchCount = 0;

  for (const relPath of candidates) {
    if (isExcluded(relPath)) continue;
    scannedPaths += 1;

    // A path component can carry a prohibited term, so the path is in scope
    // whether or not its contents can be read.
    for (const { term, index, length } of findMatches(matchers, relPath)) {
      matchCount += 1;
      violations.push(`${relPath}:0:${index + 1}  ${term}  [path]`);
      const marked = markMatch(relPath, index, length);
      violations.push(`      ${marked.text}`);
      violations.push(`      ${marked.marker}`);
    }

    const absolute = join(REPO_ROOT, ...relPath.split("/"));
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      // Staged deletions and unreadable paths carry no contents to scan.
      continue;
    }
    if (!stats.isFile()) {
      skipped.push(`${relPath} (not a regular file)`);
      continue;
    }
    if (hasBinaryExtension(relPath)) {
      skipped.push(`${relPath} (binary by extension)`);
      continue;
    }

    let buffer;
    try {
      buffer = readFileSync(absolute);
    } catch (error) {
      fail(`${relPath} could not be read: ${error.message}`);
    }

    const decoded = decode(buffer);
    if (decoded.binary) {
      skipped.push(`${relPath} (${decoded.why})`);
      continue;
    }

    scannedFiles += 1;
    const lines = decoded.text.split(/\r\n|\n|\r/);
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
      const line = lines[lineNumber];
      for (const { term, index, length } of findMatches(matchers, line)) {
        matchCount += 1;
        violations.push(`${relPath}:${lineNumber + 1}:${index + 1}  ${term}`);
        const marked = markMatch(line, index, length);
        violations.push(`      ${marked.text}`);
        violations.push(`      ${marked.marker}`);
      }
    }
  }

  if (skipped.length > 0) {
    console.log(
      `vocab: skipped ${skipped.length} binary or non-file ${
        skipped.length === 1 ? "payload" : "payloads"
      }:`,
    );
    for (const entry of skipped) console.log(`  - ${entry}`);
  }

  if (matchCount > 0) {
    console.error(
      `\nvocab: ${matchCount} prohibited ${
        matchCount === 1 ? "term" : "terms"
      } across ${scannedPaths} scanned ${scannedPaths === 1 ? "path" : "paths"}\n`,
    );
    for (const line of violations) console.error(line);
    console.error(
      "\nvocab: line 0 marks a match in the path itself rather than in file contents.",
    );
    console.error(
      "vocab: rewrite each occurrence in the project's own vocabulary. See the style guide in apps/docs.",
    );
    process.exit(1);
  }

  console.log(
    `vocab: ok. ${scannedPaths} ${
      scannedPaths === 1 ? "path" : "paths"
    } in scope, ${scannedFiles} scanned for content, 0 matches.`,
  );
}

main();
