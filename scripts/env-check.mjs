#!/usr/bin/env node
/**
 * Environment-variable completeness check.
 *
 * `.env.example` is the tracked contract for every variable this workspace
 * reads (R28.6). This script keeps that contract honest in the only way that
 * survives contact with a growing tree: it extracts every environment read it
 * can find in the sources and fails the build when a read has no matching
 * declaration.
 *
 * What counts as a read
 *
 *   .ts .tsx .mts .cts .js .jsx .mjs .cjs
 *     process.env.NAME              plain and optional-chained
 *     process.env["NAME"]           single, double, or non-interpolated backtick
 *     process.env[IDENTIFIER]       resolved against `const IDENTIFIER = "..."`
 *                                   declared in the same file
 *     const { A, B: c, D = 1 } = process.env
 *
 *   .sol
 *     vm.env*("NAME")               every accessor form — envOr, envString,
 *                                   envUint, envInt, envAddress, envBytes32,
 *                                   envBool, envBytes, envExists, and the
 *                                   array variants
 *     vm.env*(IDENTIFIER)           resolved against `string constant
 *                                   IDENTIFIER = "..."` in the same file
 *
 *   foundry.toml
 *     ${NAME}                       and the ${NAME:-default} shape
 *
 * A read inside a comment counts as a read. That is deliberate: the cost of
 * the occasional over-strict finding is one line in `.env.example`, whereas
 * comment-aware parsing per language would be a parser this script has no
 * business carrying.
 *
 * Scope
 *
 * The candidate set comes from git, so `.gitignore` decides what is in play and
 * generated or vendored trees fall out on their own. `packages/contracts/lib/`
 * is excluded on top of that: the Foundry dependency tree reads its own
 * variables and those are not ours to declare. This file excludes itself, since
 * the patterns above and their documentation are descriptions of reads rather
 * than reads.
 *
 * `spike/` is advisory scope. Its probes are throwaway exploration rather than
 * part of the shipped command surface, and their ad-hoc knobs do not belong in
 * the tracked contract — so an undeclared read there is named in a warning
 * instead of failing the build. Nothing is hidden: every such read is printed
 * with its variable name and location.
 *
 * Platform-provided variables — NODE_ENV, CI, the GITHUB_* and RUNNER_* job
 * surface, npm_* and TURBO_* tooling variables, and the rest of PLATFORM_NAMES
 * and PLATFORM_PREFIXES below — are supplied by the runtime and are not part of
 * this project's contract, so they need no declaration. Each one classified this
 * way is reported by name, so the exemption stays visible.
 *
 * The reverse direction: a declaration nothing reads
 *
 * This is a WARNING, not a failure. `.env.example` legitimately runs ahead of
 * the code: it declares the deployment address keys before the deployment
 * scripts that consume them exist, and it declares variables that only a CI job
 * definition supplies. Failing the build on those would punish declarations
 * that are correct but early, and the pressure that creates — delete the
 * declaration to make the gate quiet — is exactly backwards for a file whose
 * whole job is to be complete. So the check names them and moves on.
 *
 * Two escape valves keep that from becoming permanent noise. `CI_ONLY_NAMES`
 * declares the variables a job definition supplies and no source will ever
 * read, so they are exempt from the warning entirely. And `--strict-unused`
 * promotes the remaining warnings to a failure, which is the flag to turn on
 * once the deployment scripts land and every declaration has a consumer.
 *
 * Values are never printed. Only names, counts, and locations. That holds even
 * when a real `.env` is on disk, because this script reads `.env.example` and
 * nothing else, and prints no value from it either.
 *
 * Command surface
 *
 *   node scripts/env-check.mjs                  scan everything git tracks plus
 *                                               untracked paths git does not ignore
 *   node scripts/env-check.mjs --staged         scan staged paths only
 *   node scripts/env-check.mjs --files a b c    scan an explicit set
 *   node scripts/env-check.mjs --list           print the resolved inventory and stop
 *   node scripts/env-check.mjs --strict-unused  fail on an unreferenced declaration
 *   node scripts/env-check.mjs --help
 *
 * Exit codes: 0 clean, 1 a read with no declaration, 2 the check could not run.
 *
 * A scan that finds no reads at all exits 2 rather than 0. Zero reads across a
 * workspace this size means the extractor is broken, not that the tree is
 * clean, and a gate that passes vacuously is worse than no gate at all. The one
 * exception is `--staged`, where a commit touching nothing that reads the
 * environment is an ordinary outcome rather than a broken extractor.
 *
 * `--staged` and `--files` scan a subset, so they check the missing-declaration
 * direction only. The reverse direction needs the whole tree to mean anything
 * and is reported on a full scan alone.
 *
 * Requirements: 28.6
 */

import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The tracked contract this check enforces. */
const TEMPLATE_FILE = ".env.example";

/** This file describes environment reads; it does not perform them. */
const SELF_PATH = "scripts/env-check.mjs";

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

/** Lockfiles carry no environment reads and are large. */
const EXCLUDED_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
  "foundry.lock",
  "Cargo.lock",
]);

/** The Foundry dependency tree declares its own variables. */
const EXCLUDED_PREFIXES = ["packages/contracts/lib/"];

/** Exploration probes. Undeclared reads here warn rather than fail. */
const ADVISORY_PREFIXES = ["spike/"];

/** Extensions carrying JavaScript or TypeScript environment reads. */
const JS_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]);

/** Basenames scanned for shell-style `${NAME}` interpolation. */
const INTERPOLATED_BASENAMES = new Set(["foundry.toml"]);

/**
 * Supplied by the runtime, the job runner, or the package manager. Not part of
 * this project's contract, so no declaration is expected.
 */
const PLATFORM_NAMES = new Set([
  "CI",
  "COLORTERM",
  "DEBUG",
  "FORCE_COLOR",
  "HOME",
  "HOSTNAME",
  "LANG",
  "NO_COLOR",
  "NODE_ENV",
  "NODE_OPTIONS",
  "PATH",
  "PWD",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
]);

/** Same idea, by prefix. */
const PLATFORM_PREFIXES = [
  "DAPP_",
  "ETH_",
  "FOUNDRY_",
  "GITHUB_",
  "npm_",
  "RUNNER_",
  "TURBO_",
  "VERCEL_",
];

/**
 * Declared for a CI job definition to supply, and no source will ever read
 * them, so the unreferenced-declaration warning skips them.
 *
 * `VOCAB_DENYLIST` deliberately has no entry here: `scripts/vocab-check.mjs`
 * reads it through `process.env[DENYLIST_ENV]`, and the identifier resolution
 * above finds that read, so the variable is genuinely referenced. Add a name
 * here only when nothing in the tree can ever reference it.
 */
const CI_ONLY_NAMES = new Set([]);

/** A well-formed environment variable name. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ------------------------------------------------------------------ arguments

/**
 * @param {string[]} argv
 * @returns {{ mode: "all" | "staged" | "files" | "list" | "help", files: string[], strictUnused: boolean }}
 */
function parseArgs(argv) {
  let mode = /** @type {"all" | "staged" | "files" | "list" | "help"} */ ("all");
  let strictUnused = false;
  /** @type {string[]} */
  const files = [];
  let modeSet = false;

  /** @param {"all" | "staged" | "files" | "list" | "help"} next */
  const setMode = (next, flag) => {
    if (modeSet && mode !== next) fail(`\`${flag}\` cannot be combined with the earlier mode flag`);
    mode = next;
    modeSet = true;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--help":
      case "-h":
        return { mode: "help", files: [], strictUnused: false };
      case "--staged":
        setMode("staged", flag);
        break;
      case "--list":
        setMode("list", flag);
        break;
      case "--strict-unused":
        strictUnused = true;
        break;
      case "--files": {
        setMode("files", flag);
        const rest = argv.slice(i + 1).filter((entry) => !entry.startsWith("--"));
        for (const entry of rest) files.push(toRepoRelative(entry));
        i += rest.length;
        break;
      }
      default:
        fail(`unrecognised argument \`${flag}\`. Run with \`--help\` for the command surface.`);
    }
  }

  return { mode, files, strictUnused };
}

function usage() {
  console.log(
    [
      "env-check — every environment read has a declaration in .env.example.",
      "",
      "  node scripts/env-check.mjs                  scan everything git tracks plus",
      "                                              untracked paths git does not ignore",
      "  node scripts/env-check.mjs --staged         scan staged paths only",
      "  node scripts/env-check.mjs --files a b c    scan an explicit set of paths",
      "  node scripts/env-check.mjs --list           print the resolved inventory and stop",
      "  node scripts/env-check.mjs --strict-unused  fail on an unreferenced declaration",
      "",
      "Reads are extracted from process.env accesses in JavaScript and TypeScript,",
      "vm.env* accessors in Solidity, and ${NAME} interpolation in foundry.toml.",
      "",
      "Only names, counts, and locations are printed. Never a value.",
      "",
      "Exit codes: 0 clean, 1 a read with no declaration, 2 the check could not run.",
    ].join("\n"),
  );
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`env-check: ${message}`);
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

// -------------------------------------------------------------- declarations

/**
 * Parses `.env.example` into the set of declared names. Values are read past
 * and discarded — nothing downstream can print one.
 *
 * @returns {string[]} declared names, in file order
 */
function loadDeclarations() {
  const templatePath = join(REPO_ROOT, TEMPLATE_FILE);
  try {
    if (!statSync(templatePath).isFile()) fail(`${TEMPLATE_FILE} is not a regular file`);
  } catch {
    console.error(`env-check: ${TEMPLATE_FILE} is absent, so there is no contract to check against.`);
    console.error(`env-check: the check refuses to pass without it. Restore ${TEMPLATE_FILE}.`);
    process.exit(2);
  }

  let raw;
  try {
    raw = readFileSync(templatePath, "utf8");
  } catch (error) {
    fail(`${TEMPLATE_FILE} could not be read: ${error.message}`);
  }

  const seen = new Set();
  /** @type {string[]} */
  const names = [];
  const lines = raw.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equals = body.indexOf("=");
    if (equals <= 0) {
      console.error(
        `env-check: ${TEMPLATE_FILE}:${i + 1} is neither blank, a comment, nor a NAME=VALUE assignment.`,
      );
      console.error("env-check: the check cannot run against a template it cannot parse.");
      process.exit(2);
    }

    const name = body.slice(0, equals).trim();
    if (!NAME_PATTERN.test(name)) {
      console.error(`env-check: ${TEMPLATE_FILE}:${i + 1} declares \`${name}\`, which is not a valid name.`);
      process.exit(2);
    }
    if (seen.has(name)) {
      console.error(`env-check: ${TEMPLATE_FILE}:${i + 1} declares \`${name}\` a second time.`);
      console.error("env-check: a duplicate declaration makes the contract ambiguous.");
      process.exit(2);
    }
    seen.add(name);
    names.push(name);
  }

  if (names.length === 0) {
    console.error(`env-check: ${TEMPLATE_FILE} declares nothing.`);
    console.error("env-check: the check refuses to pass against an empty contract.");
    process.exit(2);
  }
  return names;
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
 * @param {"all" | "staged" | "files" | "list"} mode
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
    return git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  } catch (error) {
    fail(`git refused to list paths: ${error.message.trim()}`);
    return [];
  }
}

/** @param {string} relPath */
function basenameOf(relPath) {
  return relPath.slice(relPath.lastIndexOf("/") + 1);
}

/** @param {string} relPath */
function extensionOf(relPath) {
  const basename = basenameOf(relPath);
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? "" : basename.slice(dot + 1).toLowerCase();
}

/** @param {string} relPath */
function isExcluded(relPath) {
  if (relPath === SELF_PATH) return true;
  if (EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return true;
  const segments = relPath.split("/");
  if (EXCLUDED_BASENAMES.has(segments[segments.length - 1])) return true;
  return segments.some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

/** @param {string} relPath */
function isAdvisory(relPath) {
  return ADVISORY_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/**
 * @param {string} relPath
 * @returns {"js" | "sol" | "interpolated" | null} the extractor to apply
 */
function classify(relPath) {
  if (INTERPOLATED_BASENAMES.has(basenameOf(relPath))) return "interpolated";
  const extension = extensionOf(relPath);
  if (extension === "sol") return "sol";
  if (JS_EXTENSIONS.has(extension)) return "js";
  return null;
}

/** @param {string} name */
function isPlatformProvided(name) {
  if (PLATFORM_NAMES.has(name)) return true;
  return PLATFORM_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// ---------------------------------------------------------------- extraction

/**
 * @param {string} text
 * @returns {(index: number) => number} one-based line number for a character offset
 */
function lineLookup(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/**
 * A string literal with no interpolation resolves to its contents.
 *
 * @param {string} expression
 * @returns {string | null}
 */
function literalValue(expression) {
  const trimmed = expression.trim();
  const quote = trimmed.slice(0, 1);
  if (trimmed.length < 2 || trimmed.slice(-1) !== quote) return null;
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const body = trimmed.slice(1, -1);
  if (body.includes(quote) || body.includes("\\")) return null;
  if (quote === "`" && body.includes("${")) return null;
  return body;
}

/**
 * The first argument of a call, given the offset just past its opening
 * parenthesis. Nested calls and bracketed expressions are stepped over, so an
 * argument that is itself an expression comes back whole and is then reported
 * as unresolvable rather than silently missed.
 *
 * @param {string} text
 * @param {number} from offset immediately after the opening parenthesis
 * @returns {string}
 */
function firstArgument(text, from) {
  let depth = 0;
  let quote = "";
  for (let i = from; i < text.length; i += 1) {
    const character = text[i];
    if (quote !== "") {
      if (character === "\\") i += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") {
      if (depth === 0) return text.slice(from, i);
      depth -= 1;
    } else if (character === "," && depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

/**
 * Module-level string bindings, so an environment read through a named constant
 * resolves to the name it actually reads.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
function collectStringBindings(text) {
  const bindings = new Map();
  const patterns = [
    // JavaScript and TypeScript: const NAME = "LITERAL";
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=;]+)?=\s*("[^"\n]*"|'[^'\n]*'|`[^`\n]*`)/g,
    // Solidity: string constant NAME = "LITERAL";
    /\bstring\s+(?:constant|immutable)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*("[^"\n]*")/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = literalValue(match[2]);
      if (value === null || !NAME_PATTERN.test(value)) continue;
      if (!bindings.has(match[1])) bindings.set(match[1], value);
    }
  }
  return bindings;
}

/**
 * @typedef {{ name: string, path: string, line: number, form: string }} Reference
 * @typedef {{ path: string, line: number, expression: string, form: string }} DynamicRead
 */

/**
 * @param {string} relPath
 * @param {string} text
 * @param {"js" | "sol" | "interpolated"} kind
 * @returns {{ references: Reference[], dynamic: DynamicRead[] }}
 */
function extract(relPath, text, kind) {
  const lineOf = lineLookup(text);
  const bindings = collectStringBindings(text);
  /** @type {Reference[]} */
  const references = [];
  /** @type {DynamicRead[]} */
  const dynamic = [];

  /**
   * @param {number} index
   * @param {string} name
   * @param {string} form
   */
  const push = (index, name, form) => {
    if (!NAME_PATTERN.test(name)) return;
    references.push({ name, path: relPath, line: lineOf(index), form });
  };

  if (kind === "js") {
    // process.env.NAME and process.env?.NAME
    for (const match of text.matchAll(
      /\bprocess\s*\.\s*env\b\s*(?:\?\s*\.|\.)\s*([A-Za-z_$][A-Za-z0-9_$]*)/g,
    )) {
      push(match.index, match[1], "process.env member");
    }

    // process.env["NAME"] and process.env[IDENTIFIER]
    for (const match of text.matchAll(/\bprocess\s*\.\s*env\b\s*(?:\?\s*\.)?\s*\[([^\]\n]*)\]/g)) {
      const expression = match[1].trim();
      const literal = literalValue(expression);
      if (literal !== null) {
        push(match.index, literal, "process.env index");
        continue;
      }
      const bound = bindings.get(expression);
      if (bound !== undefined) {
        push(match.index, bound, `process.env index via ${expression}`);
        continue;
      }
      dynamic.push({
        path: relPath,
        line: lineOf(match.index),
        expression,
        form: "process.env index",
      });
    }

    // const { A, B: c, D = 1 } = process.env
    for (const match of text.matchAll(
      /\b(?:const|let|var)\s*\{([^}]*)\}\s*(?::\s*[^=]+)?=\s*process\s*\.\s*env\b/g,
    )) {
      for (const entry of match[1].split(",")) {
        const trimmed = entry.trim();
        if (trimmed.length === 0 || trimmed.startsWith("...")) continue;
        const key = trimmed.split(/[:=]/)[0].trim().replace(/^["'`]|["'`]$/g, "");
        push(match.index, key, "process.env destructuring");
      }
    }
  }

  if (kind === "sol") {
    // vm.envOr("NAME", ...), vm.envUint("NAME"), and every other accessor form
    for (const match of text.matchAll(/\bvm\s*\.\s*(env[A-Za-z0-9]*)\s*\(/g)) {
      const form = `vm.${match[1]}`;
      const argument = firstArgument(text, match.index + match[0].length);

      const literal = literalValue(argument);
      if (literal !== null) {
        push(match.index, literal, form);
        continue;
      }
      const bound = bindings.get(argument.trim());
      if (bound !== undefined) {
        push(match.index, bound, `${form} via ${argument.trim()}`);
        continue;
      }
      dynamic.push({
        path: relPath,
        line: lineOf(match.index),
        expression: argument.trim(),
        form,
      });
    }
  }

  if (kind === "interpolated") {
    // ${NAME} and the ${NAME:-default} shape
    for (const match of text.matchAll(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::?[-+?][^}]*)?\}/g)) {
      push(match.index, match[1], "toml interpolation");
    }
  }

  return { references, dynamic };
}

// ----------------------------------------------------------------- reporting

/**
 * @param {number} count
 * @param {string} one
 * @param {string} many
 */
function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * @param {Reference[]} references
 * @returns {Map<string, Reference[]>} grouped by name, each group in path order
 */
function groupByName(references) {
  /** @type {Map<string, Reference[]>} */
  const grouped = new Map();
  for (const reference of references) {
    const bucket = grouped.get(reference.name);
    if (bucket === undefined) grouped.set(reference.name, [reference]);
    else bucket.push(reference);
  }
  for (const bucket of grouped.values()) {
    bucket.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }
  return new Map([...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

// ---------------------------------------------------------------------- main

function main() {
  const { mode, files, strictUnused } = parseArgs(process.argv.slice(2));

  if (mode === "help") {
    usage();
    return;
  }

  const declared = loadDeclarations();
  const declaredSet = new Set(declared);
  console.log(
    `env-check: ${TEMPLATE_FILE} declares ${plural(declared.length, "variable", "variables")}.`,
  );

  const candidates = listCandidates(mode === "list" ? "all" : mode, files);

  /** @type {Reference[]} */
  const references = [];
  /** @type {Reference[]} */
  const advisoryReferences = [];
  /** @type {DynamicRead[]} */
  const dynamic = [];
  let scannedFiles = 0;
  let skippedPaths = 0;

  for (const relPath of candidates) {
    if (isExcluded(relPath)) continue;
    const kind = classify(relPath);
    if (kind === null) continue;

    const absolute = join(REPO_ROOT, ...relPath.split("/"));
    try {
      if (!statSync(absolute).isFile()) continue;
    } catch {
      // A staged deletion carries no contents to scan.
      skippedPaths += 1;
      continue;
    }

    let text;
    try {
      text = readFileSync(absolute, "utf8");
    } catch (error) {
      fail(`${relPath} could not be read: ${error.message}`);
    }

    scannedFiles += 1;
    const found = extract(relPath, text.replace(/^\uFEFF/, ""), kind);
    if (isAdvisory(relPath)) advisoryReferences.push(...found.references);
    else references.push(...found.references);
    dynamic.push(...found.dynamic);
  }

  const totalReferences = references.length + advisoryReferences.length;

  if (totalReferences === 0) {
    // A staged set legitimately touches nothing that reads the environment.
    // Every other mode asserts a set worth checking, so zero reads there means
    // the extractor is broken rather than the tree being clean.
    if (mode === "staged") {
      console.log(
        `env-check: ok. ${plural(
          scannedFiles,
          "staged file",
          "staged files",
        )} in scope, none of them reading the environment.`,
      );
      return;
    }
    console.error(
      `env-check: ${plural(scannedFiles, "file", "files")} scanned and not a single environment read found.`,
    );
    console.error(
      "env-check: that means the extractor is broken, not that the tree is clean, so the check refuses to pass.",
    );
    process.exit(2);
  }

  const byName = groupByName(references);
  const platform = [...byName.keys()].filter(isPlatformProvided);
  const missing = [...byName.entries()].filter(
    ([name]) => !declaredSet.has(name) && !isPlatformProvided(name),
  );
  const referencedNames = new Set([
    ...byName.keys(),
    ...advisoryReferences.map((reference) => reference.name),
  ]);
  // Only a whole-tree scan can speak to the reverse direction. A subset that
  // happens to reference nothing says nothing about the declaration.
  const wholeTree = mode === "all" || mode === "list";
  const unreferenced = wholeTree
    ? declared.filter((name) => !referencedNames.has(name) && !CI_ONLY_NAMES.has(name))
    : [];
  const advisoryUndeclared = [...groupByName(advisoryReferences).entries()].filter(
    ([name]) => !declaredSet.has(name) && !isPlatformProvided(name),
  );

  console.log(
    `env-check: ${plural(totalReferences, "read", "reads")} across ${plural(
      scannedFiles,
      "scanned file",
      "scanned files",
    )}, resolving to ${plural(referencedNames.size, "distinct variable", "distinct variables")}.`,
  );
  if (skippedPaths > 0) {
    console.log(`env-check: skipped ${plural(skippedPaths, "unreadable path", "unreadable paths")}.`);
  }

  if (mode === "list") {
    for (const [name, group] of byName) {
      const tag = declaredSet.has(name)
        ? "declared"
        : isPlatformProvided(name)
          ? "platform"
          : "MISSING";
      console.log(`  ${name}  [${tag}]  ${plural(group.length, "read", "reads")}`);
      for (const reference of group) console.log(`      ${reference.path}:${reference.line}  ${reference.form}`);
    }
    for (const [name, group] of groupByName(advisoryReferences)) {
      console.log(`  ${name}  [advisory]  ${plural(group.length, "read", "reads")}`);
      for (const reference of group) console.log(`      ${reference.path}:${reference.line}  ${reference.form}`);
    }
    return;
  }

  if (platform.length > 0) {
    console.log(
      `env-check: ${plural(
        platform.length,
        "variable",
        "variables",
      )} classified as platform-provided, so no declaration is expected:`,
    );
    for (const name of platform) console.log(`  - ${name}`);
  }

  if (dynamic.length > 0) {
    console.log(
      `env-check: warning — ${plural(
        dynamic.length,
        "read",
        "reads",
      )} whose variable name is computed and cannot be resolved statically:`,
    );
    for (const read of dynamic) {
      console.log(`  ? ${read.path}:${read.line}  ${read.form}  <- ${read.expression}`);
    }
    console.log(
      "env-check: rewrite each one against a module-level string constant so the check can see it.",
    );
  }

  if (advisoryUndeclared.length > 0) {
    console.log(
      `env-check: warning — ${plural(
        advisoryUndeclared.length,
        "variable",
        "variables",
      )} read only in advisory scope (${ADVISORY_PREFIXES.join(", ")}) with no declaration:`,
    );
    for (const [name, group] of advisoryUndeclared) {
      console.log(`  ~ ${name}`);
      for (const reference of group) console.log(`      ${reference.path}:${reference.line}  ${reference.form}`);
    }
    console.log(
      "env-check: exploration probes are not a shipped command surface, so these do not fail the build.",
    );
  }

  if (unreferenced.length > 0) {
    console.log(
      `env-check: warning — ${plural(
        unreferenced.length,
        "declaration",
        "declarations",
      )} in ${TEMPLATE_FILE} that nothing reads yet:`,
    );
    for (const name of unreferenced) console.log(`  ~ ${name}`);
    console.log(
      `env-check: a declaration may legitimately run ahead of its consumer. Add a name to CI_ONLY_NAMES in`,
    );
    console.log(
      `env-check: ${SELF_PATH} when a job definition supplies it and no source will ever read it.`,
    );
  }

  if (missing.length > 0) {
    console.error(
      `\nenv-check: ${plural(missing.length, "variable", "variables")} read with no declaration in ${TEMPLATE_FILE}\n`,
    );
    for (const [name, group] of missing) {
      console.error(`  x ${name}  (${plural(group.length, "read", "reads")})`);
      for (const reference of group) {
        console.error(`      ${reference.path}:${reference.line}  ${reference.form}`);
      }
    }
    console.error(
      `\nenv-check: declare each one in ${TEMPLATE_FILE} with its consumers and a non-secret example value,`,
    );
    console.error(
      "env-check: or a shape hint only when the value is a secret. Then add it to the design's environment table.",
    );
    process.exit(1);
  }

  if (strictUnused && unreferenced.length > 0) {
    console.error(
      `\nenv-check: --strict-unused — ${plural(
        unreferenced.length,
        "declaration",
        "declarations",
      )} in ${TEMPLATE_FILE} that nothing reads.\n`,
    );
    for (const name of unreferenced) console.error(`  x ${name}`);
    process.exit(1);
  }

  console.log(
    `env-check: ok. every one of ${plural(
      referencedNames.size,
      "read variable",
      "read variables",
    )} is declared in ${TEMPLATE_FILE}.`,
  );
}

main();
