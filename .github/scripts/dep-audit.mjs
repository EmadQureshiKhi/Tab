#!/usr/bin/env node
/**
 * Dependency-pinning assertion for the `dep-audit` job.
 *
 * Requirement 26.4 names three dependencies at exact versions:
 *
 *   @gluwa/usc-sdk        0.18.0
 *   @gluwa/usc-contracts  0.1.2
 *   @openzeppelin/contracts 5.4.0
 *
 * and `ethers` at the `^6` range. So the rule is not "everything is exact". It
 * is "those three are exact, and `ethers` resolves to exactly one version across
 * the whole workspace". A range is a deliberate choice; two resolved versions of
 * a signing library in one tree is not.
 *
 * The manifest is checked because that is where the declaration lives, and the
 * lockfile is checked because that is where the resolution lives. Trusting the
 * manifest alone would miss a transitive edge pulling a second `ethers`, which
 * is the failure this exists to catch.
 *
 * Why a hand-rolled lockfile reader: the pipeline asserts pinning before it
 * trusts anything installed, so this runs with no dependency of its own. The
 * lockfile shape it understands is pnpm's v9, and it fails rather than guesses
 * when it meets anything else.
 *
 * Exit codes: 0 every assertion holds, 1 at least one fails, 2 the check could
 * not run.
 *
 * Requirements: 26.4, 28.3
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(process.argv[2] ?? ".");
const MANIFEST_FILE = "package.json";
const LOCKFILE = "pnpm-lock.yaml";
const SUPPORTED_LOCKFILE_VERSIONS = new Set(["9.0"]);

/** Name to the exact version required, with the manifest block it lives in. */
const EXACT_PINS = [
  { name: "@gluwa/usc-sdk", version: "0.18.0", block: "dependencies" },
  { name: "@gluwa/usc-contracts", version: "0.1.2", block: "devDependencies" },
  { name: "@openzeppelin/contracts", version: "5.4.0", block: "devDependencies" },
];

/** The deliberate range, and the major it must resolve inside. */
const SINGLE_VERSION_RANGE = { name: "ethers", range: "^6", major: 6, block: "dependencies" };

/** Anything other than digits and dots makes a specifier a range, not a pin. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-+]+)?$/;

/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const notes = [];

/**
 * @param {string} message
 * @returns {never}
 */
function cannotRun(message) {
  console.error(`dep-audit: ${message}`);
  process.exit(2);
}

/**
 * @param {string} relPath
 * @returns {string}
 */
function read(relPath) {
  try {
    return readFileSync(resolve(REPO_ROOT, relPath), "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    cannotRun(`${relPath} could not be read: ${error.message}`);
  }
}

// ---------------------------------------------------------------- lockfile

/**
 * @param {string} raw
 * @returns {string} the value with surrounding quotes removed
 */
function unquote(raw) {
  const trimmed = raw.trim();
  const quote = trimmed.slice(0, 1);
  if (trimmed.length >= 2 && (quote === "'" || quote === '"') && trimmed.slice(-1) === quote) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Splits a lockfile package key into its name and version. Peer suffixes such as
 * `(peer@1.2.3)` are part of the key but not part of the resolved version, so
 * they are dropped.
 *
 * @param {string} key for example `'@scope/name@1.2.3(peer@4.5.6)'`
 * @returns {{ name: string, version: string } | null}
 */
function splitPackageKey(key) {
  let body = unquote(key);
  const suffix = body.indexOf("(");
  if (suffix !== -1) body = body.slice(0, suffix);
  const at = body.lastIndexOf("@");
  if (at <= 0) return null;
  const name = body.slice(0, at);
  const version = body.slice(at + 1);
  if (name.length === 0 || version.length === 0) return null;
  return { name, version };
}

/**
 * Reads the lockfile into the three shapes this check needs. The reader walks
 * indentation rather than parsing YAML in general, because the lockfile is
 * machine-written and its shape is fixed.
 *
 * @param {string} text
 * @returns {{
 *   version: string,
 *   overrides: Map<string, string>,
 *   importers: { path: string, block: string, name: string, specifier: string, version: string }[],
 *   resolved: Map<string, Set<string>>,
 * }}
 */
function readLockfile(text) {
  const lines = text.split(/\r\n|\n|\r/);

  let lockfileVersion = "";
  /** @type {Map<string, string>} */
  const overrides = new Map();
  /** @type {{ path: string, block: string, name: string, specifier: string, version: string }[]} */
  const importers = [];
  /** @type {Map<string, Set<string>>} */
  const resolved = new Map();

  /** @type {string} the top-level section currently open */
  let section = "";
  let importerPath = "";
  let importerBlock = "";
  let dependencyName = "";
  let specifier = "";

  const flushImporter = () => {
    dependencyName = "";
    specifier = "";
  };

  for (const line of lines) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (indent === 0) {
      const topLevelVersion = /^lockfileVersion:\s*'?([\d.]+)'?$/.exec(body);
      if (topLevelVersion !== null) {
        lockfileVersion = topLevelVersion[1];
        section = "";
        continue;
      }
      section = body.endsWith(":") ? body.slice(0, -1) : "";
      importerPath = "";
      importerBlock = "";
      flushImporter();
      continue;
    }

    if (section === "overrides" && indent === 2) {
      const entry = /^(.+?):\s*(.+)$/.exec(body);
      if (entry !== null) overrides.set(unquote(entry[1]), unquote(entry[2]));
      continue;
    }

    if (section === "importers") {
      if (indent === 2 && body.endsWith(":")) {
        importerPath = unquote(body.slice(0, -1));
        importerBlock = "";
        flushImporter();
      } else if (indent === 4 && body.endsWith(":")) {
        importerBlock = unquote(body.slice(0, -1));
        flushImporter();
      } else if (indent === 6 && body.endsWith(":")) {
        dependencyName = unquote(body.slice(0, -1));
        specifier = "";
      } else if (indent === 8) {
        const entry = /^(specifier|version):\s*(.+)$/.exec(body);
        if (entry === null) continue;
        if (entry[1] === "specifier") {
          specifier = unquote(entry[2]);
        } else if (dependencyName.length > 0) {
          importers.push({
            path: importerPath,
            block: importerBlock,
            name: dependencyName,
            specifier,
            version: unquote(entry[2]),
          });
        }
      }
      continue;
    }

    // Both blocks are keyed by `name@version`, so a second resolved version of a
    // package shows up as a second key in either one.
    if ((section === "packages" || section === "snapshots") && indent === 2 && body.endsWith(":")) {
      const split = splitPackageKey(body.slice(0, -1));
      if (split === null) continue;
      const versions = resolved.get(split.name);
      if (versions === undefined) resolved.set(split.name, new Set([split.version]));
      else versions.add(split.version);
    }
  }

  return { version: lockfileVersion, overrides, importers, resolved };
}

// ---------------------------------------------------------------- assertions

const manifest = JSON.parse(read(MANIFEST_FILE));
const lock = readLockfile(read(LOCKFILE));

if (!SUPPORTED_LOCKFILE_VERSIONS.has(lock.version)) {
  cannotRun(
    `${LOCKFILE} declares lockfileVersion \`${lock.version || "nothing"}\`, and this check reads ${[
      ...SUPPORTED_LOCKFILE_VERSIONS,
    ].join(", ")}.`,
  );
}
if (lock.importers.length === 0) {
  cannotRun(`${LOCKFILE} yielded no importer entries, so the reader is broken rather than the tree clean.`);
}
notes.push(
  `${LOCKFILE} is lockfileVersion ${lock.version}, with ${lock.importers.length} importer entries and ${lock.resolved.size} resolved packages.`,
);

// 1. The three exact pins, in the manifest, in the overrides, and in the lockfile.
for (const pin of EXACT_PINS) {
  const declared = manifest[pin.block]?.[pin.name];
  if (declared === undefined) {
    failures.push(`${MANIFEST_FILE} \`${pin.block}\` declares no \`${pin.name}\``);
  } else if (declared !== pin.version) {
    failures.push(
      `${MANIFEST_FILE} pins \`${pin.name}\` at \`${declared}\`, and requirement 26.4 names \`${pin.version}\``,
    );
  } else if (!EXACT_VERSION.test(declared)) {
    failures.push(`${MANIFEST_FILE} declares \`${pin.name}\` as \`${declared}\`, which is a range, not a pin`);
  } else {
    notes.push(`${MANIFEST_FILE} pins ${pin.name} at ${declared}`);
  }

  const override = manifest.pnpm?.overrides?.[pin.name];
  if (override !== pin.version) {
    failures.push(
      `${MANIFEST_FILE} \`pnpm.overrides\` gives \`${pin.name}\` as \`${override ?? "nothing"}\`, and it must be \`${pin.version}\` so a transitive edge cannot resolve elsewhere`,
    );
  }

  const lockedOverride = lock.overrides.get(pin.name);
  if (lockedOverride !== pin.version) {
    failures.push(
      `${LOCKFILE} \`overrides\` gives \`${pin.name}\` as \`${lockedOverride ?? "nothing"}\`, and it must be \`${pin.version}\``,
    );
  }

  const versions = lock.resolved.get(pin.name);
  if (versions === undefined) {
    failures.push(`${LOCKFILE} resolves no \`${pin.name}\` at all`);
  } else if (versions.size !== 1 || !versions.has(pin.version)) {
    failures.push(
      `${LOCKFILE} resolves \`${pin.name}\` to ${[...versions].sort().join(", ")}, and it must resolve to \`${pin.version}\` alone`,
    );
  } else {
    notes.push(`${LOCKFILE} resolves ${pin.name} to exactly ${pin.version}`);
  }

  for (const entry of lock.importers) {
    if (entry.name !== pin.name) continue;
    if (entry.specifier !== pin.version) {
      failures.push(
        `${LOCKFILE} importer \`${entry.path}\` requests \`${pin.name}\` as \`${entry.specifier}\`, and it must request \`${pin.version}\``,
      );
    }
    if (entry.version !== pin.version) {
      failures.push(
        `${LOCKFILE} importer \`${entry.path}\` resolves \`${pin.name}\` to \`${entry.version}\`, and it must resolve to \`${pin.version}\``,
      );
    }
  }
}

// 2. `ethers` keeps its deliberate range and still resolves to one version.
const declaredRange = manifest[SINGLE_VERSION_RANGE.block]?.[SINGLE_VERSION_RANGE.name];
if (declaredRange !== SINGLE_VERSION_RANGE.range) {
  failures.push(
    `${MANIFEST_FILE} declares \`${SINGLE_VERSION_RANGE.name}\` as \`${declaredRange ?? "nothing"}\`, and the design names the \`${SINGLE_VERSION_RANGE.range}\` range`,
  );
} else {
  notes.push(`${MANIFEST_FILE} declares ${SINGLE_VERSION_RANGE.name} as the deliberate ${declaredRange} range`);
}

const ethersVersions = lock.resolved.get(SINGLE_VERSION_RANGE.name);
if (ethersVersions === undefined) {
  failures.push(`${LOCKFILE} resolves no \`${SINGLE_VERSION_RANGE.name}\` at all`);
} else if (ethersVersions.size !== 1) {
  failures.push(
    `${LOCKFILE} resolves \`${SINGLE_VERSION_RANGE.name}\` to ${ethersVersions.size} versions (${[...ethersVersions].sort().join(", ")}); the workspace must carry exactly one`,
  );
} else {
  const [only] = [...ethersVersions];
  const major = Number.parseInt(only.split(".")[0], 10);
  if (major !== SINGLE_VERSION_RANGE.major) {
    failures.push(
      `${LOCKFILE} resolves \`${SINGLE_VERSION_RANGE.name}\` to \`${only}\`, outside the \`${SINGLE_VERSION_RANGE.range}\` range`,
    );
  } else {
    notes.push(`${LOCKFILE} resolves ${SINGLE_VERSION_RANGE.name} to exactly one version, ${only}`);
  }

  for (const entry of lock.importers) {
    if (entry.name !== SINGLE_VERSION_RANGE.name) continue;
    if (entry.version !== only) {
      failures.push(
        `${LOCKFILE} importer \`${entry.path}\` resolves \`${SINGLE_VERSION_RANGE.name}\` to \`${entry.version}\` while the tree resolves \`${only}\``,
      );
    }
  }
}

// ---------------------------------------------------------------- reporting

for (const note of notes) console.log(`dep-audit: ${note}`);

if (failures.length > 0) {
  console.error(
    `\ndep-audit: ${failures.length} pinning ${failures.length === 1 ? "assertion" : "assertions"} failed\n`,
  );
  for (const failure of failures) console.error(`  x ${failure}`);
  console.error(
    "\ndep-audit: requirement 26.4 names three exact versions, and the design names a single resolved `ethers`.",
  );
  process.exit(1);
}

console.log(
  `dep-audit: ok. ${EXACT_PINS.length} exact pins hold in the manifest, the overrides, and the lockfile, and \`${SINGLE_VERSION_RANGE.name}\` resolves to one version.`,
);
