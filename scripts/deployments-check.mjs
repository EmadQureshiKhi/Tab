#!/usr/bin/env node
/**
 * Deployment-record agreement gate.
 *
 * `deployments.json` records every address this deployment produced, each one
 * read back off the chain. `.env.example` is the tracked contract for every
 * variable the workspace reads. Those two files name the same addresses through
 * different keys, and this gate makes them agree.
 *
 * That gap is how a deployment record goes stale without anyone noticing. A
 * contract gets redeployed and only one of the two files learns about it. A new
 * address variable is declared and never recorded. A recorded contract is
 * removed from the template and every consumer keeps reading a variable the
 * contract no longer has. None of those show up as a test failure, a type
 * error, or a lint finding: both files stay individually well-formed and
 * individually plausible while describing two different deployments.
 *
 * So this gate asserts the join, in both directions, on names:
 *
 *   forward   every `envKey` in `deployments.json` is declared in
 *             `.env.example` and classified below as a recorded address
 *   reverse   every address key in `.env.example` classified as a recorded
 *             address appears as an `envKey` in `deployments.json`
 *   closure   every address-bearing key in `.env.example` is classified below
 *             one way or the other
 *
 * The third is what keeps the first two from decaying. Without it, a new
 * address variable could be added to the template, never recorded, and never
 * noticed, because a gate that only compares two named sets cannot see a key
 * that is in neither. With it, adding an address variable forces a decision
 * about whether it belongs in the record, and the decision is written down here
 * rather than re-derived by the next reader.
 *
 * The join key
 *
 * `deployments.json` carries an explicit `envKey` on each node whose address a
 * consumer reads through the environment. That field is the intended join and
 * this gate uses nothing else - no name-shape guessing, no mapping table on the
 * record side. The absence of an `envKey` is therefore a statement too: it says
 * this address is recorded for orientation and is not part of the environment
 * contract.
 *
 * ------------------------------------------------------------------ the split
 *
 * `.env.example` declares several address-bearing variables and only some of
 * them belong in the deployment record. The line between them is not "is it a
 * contract we wrote". It is *did this deployment fix this value*.
 *
 * RECORDED. Each was fixed by an irreversible act of this deployment, and
 * changing any of them takes a new deployment.
 *
 *   The four Monad contracts. `ServiceRegistry`, `Bond`, `TabBook` and
 *   `TabSettlement` are deployment outputs in the plainest sense: a transaction
 *   created each one and its address is that transaction's result.
 *
 *   `MockUsdc` on Testnet. The test token the deploy script ships so the rail
 *   can be exercised without a faucet for the Asset. Absent from a Mainnet
 *   deployment, where the Assets are the canonical stablecoins.
 *
 *   The curation authority. Not a contract, and it would be easy to file it as
 *   a configuration input and leave it out. That would be wrong: it is a
 *   `ServiceRegistry` constructor immutable, never settable afterwards, and
 *   therefore as permanent as any deployed address.
 *
 * EXCLUDED. None was fixed by this deployment, so none can go stale relative
 * to it, and asserting the record against them would assert a value nobody in
 * this project chose: the Agent a trial call is billed to; the Asset a gateway
 * meters in, which is a per-deployment choice among the Assets the chain
 * already has; and the network constants, contracts other people deployed at
 * addresses that are the same on every chain they exist on (Permit2, the
 * ERC-8004 registries) or published by their issuer (Circle's USDC). A Tab
 * deployment reads those; it cannot move them, so the record has nothing to
 * say about them.
 *
 * -------------------------------------------------------------- about values
 *
 * `.env.example` holds zero-address placeholders by design. It is the tracked
 * template; the real values live in the gitignored `.env`. Comparing values
 * against the template would therefore compare every recorded address against
 * `0x0000...0000` and fail on every one, so this gate does not attempt it. The
 * template is checked for names only.
 *
 * A value comparison against `.env` is meaningful, and this gate makes it when
 * `.env` is present. Two outcomes, deliberately at different severities:
 *
 *   failure   a recorded key holds a different non-zero address in `.env` than
 *             the record read back off the chain. One of the two is wrong about
 *             a live deployment and somebody has to decide which.
 *   warning   a recorded key is absent from `.env`, or still holds the zero
 *             placeholder. That is an unfilled local file, not a wrong record,
 *             an ordinary state for a fresh clone, so it is named and does not
 *             fail. `--strict-env` promotes these to a failure.
 *
 * When `.env` is absent the comparison is skipped with a line saying so. CI has
 * no `.env`, and a gate that fails for its absence would either be switched off
 * or would push somebody into committing one.
 *
 * Addresses compare as the twenty bytes they are, case-folded. EIP-55 checksum
 * casing is a display convention and two spellings of one address are one
 * address.
 *
 * The only values this gate ever prints are addresses under the recorded keys
 * and the excluded ones. Addresses are public by construction: they are what
 * `deployments.json` exists to publish. Nothing else in `.env` is read
 * at all: the parser indexes by name and the gate looks up nothing outside the
 * classification below, so no key, endpoint, or connection string can reach the
 * log through here.
 *
 * Command surface
 *
 *   node scripts/deployments-check.mjs               gate the join, both directions
 *   node scripts/deployments-check.mjs --list        print the classification and stop
 *   node scripts/deployments-check.mjs --strict-env  fail on an unfilled `.env` slot
 *   node scripts/deployments-check.mjs --no-env      names only, ignore `.env` entirely
 *   node scripts/deployments-check.mjs --help
 *
 * Exit codes: 0 the two files agree, 1 they disagree, 2 the gate could not run,
 * with either file absent, unparseable, or carrying no address at all. The third
 * code is the point: a gate that reports success because it could not find its
 * subject is worse than no gate.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The deployment record. Tracked, written from on-chain read-backs. */
const RECORD_FILE = "deployments.json";
/** The tracked environment contract. Placeholder values by design. */
const TEMPLATE_FILE = ".env.example";
/** The real values. Gitignored, absent under CI. */
const LOCAL_FILE = ".env";

/** The field in the record that names the environment variable. The join key. */
const JOIN_FIELD = "envKey";
/** Fields an `envKey`-bearing node may carry its address in. */
const ADDRESS_FIELDS = ["address", "value"];

/** A well-formed environment variable name. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A 20-byte hexadecimal address. */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
/** The unfilled placeholder. Twenty zero bytes. */
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

/**
 * Name shapes that make a template key address-bearing regardless of its value,
 * so a key declared with an empty or malformed value is still classified rather
 * than skipped. A value that parses as an address counts on its own too - see
 * `isAddressBearing`.
 */
const ADDRESS_NAME_SUFFIXES = ["_ADDRESS"];

/**
 * Every address-bearing key in `.env.example`, with its category and the reason
 * for it. `perNetwork: true` softens that to "where the deployment has one":
 * the test token exists on Testnet and deliberately not on a chain where the
 * Assets are real, so its absence from that record is the record being right.
 * `recorded: true` means the key must appear as an `envKey` in the
 * record; `recorded: false` means it must not. A key missing from this table
 * fails the gate, which is how a newly declared address variable forces the
 * decision instead of slipping through unjoined.
 *
 * The header above argues the split at length. These are the one-line forms.
 */
const CLASSIFICATION = new Map([
  [
    "SERVICE_REGISTRY_ADDRESS",
    { recorded: true, why: "a Monad contract this deployment created; its address is a transaction result" },
  ],
  [
    "BOND_ADDRESS",
    { recorded: true, why: "a Monad contract this deployment created; its address is a transaction result" },
  ],
  [
    "TAB_BOOK_ADDRESS",
    { recorded: true, why: "a Monad contract this deployment created; its address is a transaction result" },
  ],
  [
    "TAB_SETTLEMENT_ADDRESS",
    { recorded: true, why: "a Monad contract this deployment created; its address is a transaction result" },
  ],
  [
    "MOCK_USDC_ADDRESS",
    {
      recorded: true,
      perNetwork: true,
      why:
        "the test token the deploy script ships to Testnet; created by this deployment, so it can go stale " +
        "like any other address, and absent from a Mainnet record where the Assets are the canonical stablecoins",
    },
  ],
  [
    "CURATION_OWNER_1_ADDRESS",
    {
      recorded: false,
      why:
        "an owner of the CurationMultisig, not an output of this deployment: the multisig's address is " +
        "what ServiceRegistry was constructed over and what the record carries, and who holds its keys is " +
        "written beside that address as prose rather than joined to a variable",
    },
  ],
  [
    "CURATION_OWNER_2_ADDRESS",
    {
      recorded: false,
      why: "an owner of the CurationMultisig; see CURATION_OWNER_1_ADDRESS",
    },
  ],
  [
    "CURATION_OWNER_3_ADDRESS",
    {
      recorded: false,
      why: "an owner of the CurationMultisig; see CURATION_OWNER_1_ADDRESS",
    },
  ],
  [
    "CURATION_AUTHORITY_ADDRESS",
    {
      recorded: true,
      why:
        "not a contract, but a ServiceRegistry constructor immutable that is never settable afterwards, " +
        "so it is as permanent as any deployed address",
    },
  ],
  [
    "GATEWAY_ASSET_ADDRESS",
    {
      recorded: false,
      why:
        "the Asset one gateway meters in, chosen per deployment among the Assets the chain already has; " +
        "on Testnet it falls back to MOCK_USDC_ADDRESS, which is recorded",
    },
  ],
  [
    "GATEWAY_COLLECTION_ADDRESS",
    {
      recorded: false,
      why:
        "where one gateway sends a prepaid call's funds when it cannot read ServiceRegistry.collectionOf at " +
        "startup; the registry is read first and this is the operator's fallback, chosen per deployment",
    },
  ],
  [
    "PERMIT2_ADDRESS",
    {
      recorded: false,
      why:
        "a network constant: Uniswap's Permit2 at its canonical address on every chain, Monad included. " +
        "TabSettlement is immutable over it, but this deployment did not create it and cannot move it",
    },
  ],
  [
    "USDC_ADDRESS",
    {
      recorded: false,
      why:
        "a network constant: Circle's USDC on the configured chain, published by its issuer. Accepted by " +
        "the demo Service beside MOCK_USDC_ADDRESS, which is recorded",
    },
  ],
  [
    "ERC8004_IDENTITY_REGISTRY_ADDRESS",
    {
      recorded: false,
      why:
        "a network constant: the canonical ERC-8004 Identity Registry of the selected Monad network. " +
        "Empty means that network's canonical address; nothing here created it",
    },
  ],
  [
    "ERC8004_REPUTATION_REGISTRY_ADDRESS",
    {
      recorded: false,
      why:
        "a network constant: the canonical ERC-8004 Reputation Registry, at the same address on every " +
        "chain it is deployed to. Empty means that canonical address; nothing here created it",
    },
  ],
  [
    "TRY_IT_AGENT",
    {
      recorded: false,
      why:
        "the Agent a trial call from the Dashboard is billed to. An externally owned account chosen by " +
        "whoever runs the deployment, not a deployment output, and it differs for every reader. " +
        "Recording it would publish one person's demonstration account as though it were part of the rail",
    },
  ],
]);

// ------------------------------------------------------------------ arguments

/**
 * @param {string[]} argv
 * @returns {{ mode: "gate" | "list" | "help", useLocal: boolean, strictLocal: boolean }}
 */
function parseArgs(argv) {
  let mode = /** @type {"gate" | "list" | "help"} */ ("gate");
  let useLocal = true;
  let strictLocal = false;

  for (const flag of argv) {
    switch (flag) {
      case "--help":
      case "-h":
        return { mode: "help", useLocal: true, strictLocal: false };
      case "--list":
        mode = "list";
        break;
      case "--no-env":
        useLocal = false;
        break;
      case "--strict-env":
        strictLocal = true;
        break;
      default:
        cannotRun(`unrecognised argument \`${flag}\`. Run with \`--help\` for the command surface.`);
    }
  }

  if (!useLocal && strictLocal) {
    cannotRun("`--strict-env` and `--no-env` ask for opposite things");
  }
  return { mode, useLocal, strictLocal };
}

function usage() {
  console.log(
    [
      `deployments-check - ${RECORD_FILE} and ${TEMPLATE_FILE} name the same addresses.`,
      "",
      "  node scripts/deployments-check.mjs               gate the join, both directions",
      "  node scripts/deployments-check.mjs --list        print the classification and stop",
      "  node scripts/deployments-check.mjs --strict-env  fail on an unfilled `.env` slot",
      "  node scripts/deployments-check.mjs --no-env      names only, ignore `.env` entirely",
      "",
      `The join key is the \`${JOIN_FIELD}\` field the record carries on each address a`,
      "consumer reads through the environment. A key in one file and not the other is",
      "the failure this gate exists to catch: that is how a record goes stale unnoticed.",
      "",
      `Values are never compared against ${TEMPLATE_FILE} - it holds zero-address`,
      `placeholders by design. They are compared against ${LOCAL_FILE} when it is present,`,
      "and the comparison is skipped with a line saying so when it is not.",
      "",
      "Exit codes: 0 the two files agree, 1 they disagree, 2 the gate could not run.",
    ].join("\n"),
  );
}

/**
 * The gate could not run. Never used for a disagreement.
 *
 * @param {string} message
 * @returns {never}
 */
function cannotRun(message) {
  console.error(`deployments: ${message}`);
  process.exit(2);
}

/**
 * @param {number} count
 * @param {string} one
 * @param {string} many
 */
function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** @param {string} address */
function normaliseAddress(address) {
  return address.trim().toLowerCase();
}

// ----------------------------------------------------------- the env template

/**
 * Parses a dotenv-shaped file into name-to-value pairs, in file order.
 *
 * Strict on the template, because an unparseable contract means the gate cannot
 * run rather than that it passes. Lenient on `.env`, where a line this parser
 * does not recognise is somebody's local business and the gate reads only the
 * classified names out of it anyway.
 *
 * @param {string} relPath
 * @param {boolean} strict
 * @returns {Map<string, string>}
 */
function parseDotenv(relPath, strict) {
  const absolute = join(REPO_ROOT, relPath);
  let raw;
  try {
    if (!statSync(absolute).isFile()) cannotRun(`${relPath} is not a regular file`);
    raw = readFileSync(absolute, "utf8");
  } catch (error) {
    cannotRun(`${relPath} could not be read: ${error.message}`);
  }

  /** @type {Map<string, string>} */
  const values = new Map();
  const lines = raw.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equals = body.indexOf("=");
    if (equals <= 0) {
      if (!strict) continue;
      cannotRun(
        `${relPath}:${index + 1} is neither blank, a comment, nor a NAME=VALUE assignment, ` +
          "so the gate cannot read the contract it is meant to check",
      );
    }

    const name = body.slice(0, equals).trim();
    if (!NAME_PATTERN.test(name)) {
      if (!strict) continue;
      cannotRun(`${relPath}:${index + 1} declares \`${name}\`, which is not a valid variable name`);
    }
    if (strict && values.has(name)) {
      cannotRun(
        `${relPath}:${index + 1} declares \`${name}\` a second time, which makes the contract ambiguous`,
      );
    }
    // Strip a surrounding quote pair and an inline trailing comment. Neither
    // shape appears in either file today; both are cheap to tolerate.
    let value = body.slice(equals + 1).trim();
    const quote = value.slice(0, 1);
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.slice(-1) === quote) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(" #");
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    values.set(name, value);
  }

  return values;
}

/**
 * A template key is address-bearing when its name says so or its value parses
 * as one. The name test alone would miss a future key spelled differently; the
 * value test alone would miss a key whose placeholder is empty or malformed.
 *
 * @param {string} name
 * @param {string} value
 */
function isAddressBearing(name, value) {
  if (ADDRESS_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  return ADDRESS_PATTERN.test(value);
}

// --------------------------------------------------------- the deployment record

/**
 * @typedef {object} RecordedAddress
 * @property {string} envKey
 * @property {string} address as spelled in the record
 * @property {string} path where in the record it sits, for messages
 */

/**
 * Every `envKey` in the record, wherever it sits. Walked rather than read from
 * a fixed list of locations, so a contract recorded under a new chain or a new
 * section joins the gate the moment it is written down.
 *
 * @param {unknown} node
 * @param {string} path
 * @param {RecordedAddress[]} found
 * @param {string[]} problems
 */
function collectEnvKeys(node, path, found, problems) {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => collectEnvKeys(entry, `${path}[${index}]`, found, problems));
    return;
  }
  if (node === null || typeof node !== "object") return;

  const envKey = /** @type {Record<string, unknown>} */ (node)[JOIN_FIELD];
  if (typeof envKey === "string") {
    if (!NAME_PATTERN.test(envKey)) {
      problems.push(`${path}.${JOIN_FIELD} is \`${envKey}\`, which is not a valid variable name`);
    } else {
      const field = ADDRESS_FIELDS.find(
        (candidate) => typeof /** @type {Record<string, unknown>} */ (node)[candidate] === "string",
      );
      const address = field === undefined ? null : String(node[field]);
      if (address === null) {
        problems.push(
          `${path} names \`${envKey}\` through ${JOIN_FIELD} but carries no ` +
            `${ADDRESS_FIELDS.map((name) => `\`${name}\``).join(" or ")} beside it`,
        );
      } else if (!ADDRESS_PATTERN.test(address)) {
        problems.push(`${path}.${field} is \`${address}\`, which is not a 20-byte address`);
      } else {
        found.push({ envKey, address, path });
      }
    }
  } else if (envKey !== undefined) {
    problems.push(`${path}.${JOIN_FIELD} is present but is not a string`);
  }

  for (const [key, child] of Object.entries(node)) {
    if (key === JOIN_FIELD) continue;
    collectEnvKeys(child, path === "" ? key : `${path}.${key}`, found, problems);
  }
}

/**
 * Which deployment the environment is pointed at, and which file said so.
 *
 * `.env` wins where it exists, because that is the deployment a developer is
 * actually working against; the template answers for a fresh checkout. A
 * chain id that is absent or unreadable stops the gate rather than defaulting,
 * because guessing a network is how the wrong addresses get blessed.
 *
 * @returns {{ chainId: number, source: string }}
 */
function activeChainId() {
  for (const [file, strict] of [
    [LOCAL_FILE, false],
    [TEMPLATE_FILE, true],
  ]) {
    if (file === LOCAL_FILE && !existsSync(join(REPO_ROOT, file))) continue;
    const raw = parseDotenv(file, strict).get("MONAD_CHAIN_ID");
    if (raw === undefined) continue;
    const chainId = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(chainId) || chainId <= 0) {
      cannotRun(`${file} sets MONAD_CHAIN_ID to \`${raw}\`, which is not a chain id.`);
    }
    return { chainId, source: file };
  }
  cannotRun(`neither ${LOCAL_FILE} nor ${TEMPLATE_FILE} sets MONAD_CHAIN_ID, so the gate cannot tell which deployment to join.`);
  throw new Error("unreachable");
}

/**
 * @returns {{ byKey: Map<string, RecordedAddress>, count: number }}
 */
function loadRecord() {
  const absolute = join(REPO_ROOT, RECORD_FILE);
  if (!existsSync(absolute)) {
    console.error(`deployments: ${RECORD_FILE} is absent, so there is no record to check against.`);
    console.error(
      "deployments: the gate refuses to pass without it - a gate that cannot find its subject must not report success.",
    );
    process.exit(2);
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    cannotRun(`${RECORD_FILE} is not readable JSON: ${error.message}`);
  }

  /*
    The record holds one entry per network and `.env` names which one, so only
    that entry is joined. Walking them all would collide every variable against
    itself on another chain, and a Mainnet address answering to
    TAB_BOOK_ADDRESS while `.env` points at Testnet is exactly the confusion
    this gate exists to catch.
  */
  const { chainId, source } = activeChainId();
  const networks = parsed?.networks;
  if (networks === undefined || networks === null || typeof networks !== "object") {
    cannotRun(`${RECORD_FILE} carries no \`networks\` map, so the gate cannot tell which deployment ${source} names.`);
  }
  const active = networks[String(chainId)];
  if (active === undefined) {
    const known = Object.keys(networks).sort().join(", ") || "none";
    cannotRun(
      `${source} names chain ${chainId} and ${RECORD_FILE} records ${known}. ` +
        "Deploy to it and record the result, or point the environment at a chain the record knows.",
    );
  }

  /** @type {RecordedAddress[]} */
  const found = [];
  /** @type {string[]} */
  const problems = [];
  collectEnvKeys(active, `networks.${chainId}`, found, problems);

  if (problems.length > 0) {
    console.error(
      `deployments: ${RECORD_FILE} carries ${plural(problems.length, "node", "nodes")} the gate cannot join on:\n`,
    );
    for (const problem of problems) console.error(`  x ${problem}`);
    console.error(
      `\ndeployments: every \`${JOIN_FIELD}\` must be a variable name sitting beside a 20-byte address.`,
    );
    process.exit(2);
  }

  /** @type {Map<string, RecordedAddress>} */
  const byKey = new Map();
  /** @type {string[]} */
  const collisions = [];
  for (const entry of found) {
    const existing = byKey.get(entry.envKey);
    if (existing === undefined) {
      byKey.set(entry.envKey, entry);
      continue;
    }
    // One variable naming two different addresses is unresolvable, so it stops
    // the gate. One variable naming the same address twice is redundant but
    // unambiguous, and is left alone.
    if (normaliseAddress(existing.address) !== normaliseAddress(entry.address)) {
      collisions.push(
        `${entry.envKey}: ${existing.path} says ${existing.address}, ${entry.path} says ${entry.address}`,
      );
    }
  }
  if (collisions.length > 0) {
    console.error(
      `deployments: ${plural(collisions.length, "variable", "variables")} named twice in ${RECORD_FILE} ` +
        "with different addresses:\n",
    );
    for (const collision of collisions) console.error(`  x ${collision}`);
    console.error("\ndeployments: the record has to say one thing per variable before it can be joined.");
    process.exit(2);
  }

  if (byKey.size === 0) {
    // An entry with no addresses is a network that has not been deployed to,
    // which is a different fact from a record whose shape changed, and sending
    // a reader to look for the second when it is the first wastes their time.
    console.error(
      `deployments: ${RECORD_FILE} records chain ${chainId} but no contracts under it, so there is nothing to join.`,
    );
    console.error(
      `deployments: deploy to it and record the addresses, or point ${source} at a chain that has been deployed to.`,
    );
    process.exit(2);
  }


  return { byKey, count: found.length };
}

// ----------------------------------------------------------------- reporting

function listClassification() {
  const recorded = [...CLASSIFICATION.entries()].filter(([, entry]) => entry.recorded);
  const excluded = [...CLASSIFICATION.entries()].filter(([, entry]) => !entry.recorded);

  console.log(`deployments-check - how each address key in ${TEMPLATE_FILE} is classified.\n`);
  console.log(
    `  recorded - must appear as an \`${JOIN_FIELD}\` in ${RECORD_FILE}. ` +
      `${plural(recorded.length, "key", "keys")}.`,
  );
  console.log("  Each was fixed by an irreversible act of this deployment.\n");
  for (const [name, entry] of recorded) console.log(`    ${name}\n      ${entry.why}`);
  console.log(
    `\n  excluded - must not appear as an \`${JOIN_FIELD}\`. ${plural(excluded.length, "key", "keys")}.`,
  );
  console.log("  None was fixed by this deployment, so none can go stale relative to it.\n");
  for (const [name, entry] of excluded) console.log(`    ${name}\n      ${entry.why}`);
  console.log(
    `\n  An address-bearing key in ${TEMPLATE_FILE} that this table does not name fails the gate.` +
      "\n  That is how a newly declared address variable forces the decision instead of slipping through.",
  );
}

// ---------------------------------------------------------------------- main

function main() {
  const { mode, useLocal, strictLocal } = parseArgs(process.argv.slice(2));

  if (mode === "help") {
    usage();
    return;
  }
  if (mode === "list") {
    listClassification();
    return;
  }

  const template = parseDotenv(TEMPLATE_FILE, true);
  const { byKey: record, count } = loadRecord();

  /** @type {string[]} */
  const templateAddressKeys = [];
  for (const [name, value] of template) {
    if (isAddressBearing(name, value)) templateAddressKeys.push(name);
  }

  if (templateAddressKeys.length === 0) {
    console.error(`deployments: ${TEMPLATE_FILE} declares no address-bearing variable at all.`);
    console.error(
      "deployments: that means the template shape changed rather than that the two files agree, so the gate refuses to pass.",
    );
    process.exit(2);
  }

  console.log(
    `deployments: ${TEMPLATE_FILE} declares ${plural(template.size, "variable", "variables")}, ` +
      `${templateAddressKeys.length} of them address-bearing.`,
  );
  console.log(
    `deployments: ${RECORD_FILE} carries ${plural(count, "address", "addresses")} named through ` +
      `\`${JOIN_FIELD}\`, resolving to ${plural(record.size, "variable", "variables")}.`,
  );

  const expected = [...CLASSIFICATION.entries()]
    .filter(([, entry]) => entry.recorded)
    .map(([name]) => name);

  // -------------------------------------------------------------- closure
  // An address key the classification does not name. Checked first: until every
  // key is classified, neither direction below is speaking about a known set.
  const unclassified = templateAddressKeys.filter((name) => !CLASSIFICATION.has(name));
  // The mirror of that: a classified key the template no longer declares, which
  // means this script's table has gone stale.
  const staleTable = [...CLASSIFICATION.keys()].filter((name) => !template.has(name));

  // -------------------------------------------------- the two directions
  /** @type {string[]} */
  const notDeclared = [];
  /** @type {string[]} */
  const declaredButExcluded = [];
  for (const [envKey, entry] of record) {
    if (!template.has(envKey)) {
      notDeclared.push(`${envKey}  (${RECORD_FILE} ${entry.path})`);
      continue;
    }
    const classification = CLASSIFICATION.get(envKey);
    if (classification !== undefined && !classification.recorded) {
      declaredButExcluded.push(`${envKey}  (${RECORD_FILE} ${entry.path}) - classified excluded here: ${classification.why}`);
    }
  }
  // A key a deployment may or may not have, absent here because this network
  // does not have it. `MOCK_USDC_ADDRESS` is the case: the deploy script ships
  // a test token to Testnet and deliberately ships none to a chain where the
  // Assets are real, so its absence from a Mainnet record is the record being
  // right rather than stale. Everything else must be present.
  const notRecorded = expected.filter((name) => !record.has(name) && CLASSIFICATION.get(name)?.perNetwork !== true);

  // A key only joins when all three agree it should: the classification calls it
  // a deployment output, the record names it, and the template declares it.
  // Anything short of that belongs in one of the failure lists above, not in the
  // `ok` rows - a summary that prints `ok` beside a key it is about to fail on
  // is the kind of output that gets a gate distrusted.
  const matched = expected.filter((name) => record.has(name) && template.has(name));

  // ------------------------------------------------------ values, if any
  /** @type {string[]} */
  const valueMismatches = [];
  /** @type {string[]} */
  const unfilled = [];
  let localPresent = false;
  if (useLocal) {
    localPresent = existsSync(join(REPO_ROOT, LOCAL_FILE));
    if (localPresent) {
      const local = parseDotenv(LOCAL_FILE, false);
      for (const name of matched) {
        const recorded = /** @type {RecordedAddress} */ (record.get(name));
        const actual = local.get(name);
        if (actual === undefined || actual.length === 0) {
          unfilled.push(`${name}  absent from ${LOCAL_FILE}; the record says ${recorded.address}`);
          continue;
        }
        if (!ADDRESS_PATTERN.test(actual)) {
          unfilled.push(`${name}  holds no readable address in ${LOCAL_FILE}; the record says ${recorded.address}`);
          continue;
        }
        if (normaliseAddress(actual) === ZERO_ADDRESS) {
          unfilled.push(`${name}  still the zero placeholder in ${LOCAL_FILE}; the record says ${recorded.address}`);
          continue;
        }
        if (normaliseAddress(actual) !== normaliseAddress(recorded.address)) {
          const width = Math.max(LOCAL_FILE.length, RECORD_FILE.length) + " says".length + 2;
          valueMismatches.push(
            `${name}\n      ${`${LOCAL_FILE} says`.padEnd(width)}${actual}\n` +
              `      ${`${RECORD_FILE} says`.padEnd(width)}${recorded.address}  (${recorded.path})`,
          );
        }
      }
    }
  }

  // ----------------------------------------------------------- the report
  console.log(
    `deployments: ${plural(matched.length, "key joins", "keys join")} on \`${JOIN_FIELD}\`, ` +
      `${plural(
        CLASSIFICATION.size - expected.length,
        "key classified out of the record",
        "keys classified out of the record",
      )}.`,
  );
  for (const name of matched) {
    const entry = /** @type {RecordedAddress} */ (record.get(name));
    console.log(`  ok  ${name}  ->  ${entry.path}`);
  }
  const excludedPresent = templateAddressKeys.filter((name) => CLASSIFICATION.get(name)?.recorded === false);
  for (const name of excludedPresent) {
    console.log(`  --  ${name}  not a deployment output`);
    console.log(`        ${CLASSIFICATION.get(name)?.why}`);
  }

  if (!useLocal) {
    console.log(`deployments: value comparison switched off with \`--no-env\`. Names only.`);
  } else if (!localPresent) {
    console.log(
      `deployments: no ${LOCAL_FILE} on disk, so values are not compared. Names only - this is the CI case.`,
    );
  } else {
    console.log(
      `deployments: ${LOCAL_FILE} is present, so ${plural(matched.length, "value was", "values were")} compared ` +
        "against the record as well.",
    );
  }

  if (unfilled.length > 0) {
    const verb = strictLocal ? "failure" : "warning";
    console.log(
      `deployments: ${verb} - ${plural(unfilled.length, "recorded key is", "recorded keys are")} unfilled in ${LOCAL_FILE}:`,
    );
    for (const line of unfilled) console.log(`  ~ ${line}`);
    if (!strictLocal) {
      console.log(
        `deployments: an unfilled local file is not a wrong record, so this does not fail. Copy the addresses ` +
          `from ${RECORD_FILE}, or run with \`--strict-env\` to make this a failure.`,
      );
    }
  }

  // Order matters. Closure first: a gate that has not classified every key is
  // not yet speaking about a known set, so its two directions mean less.
  if (unclassified.length > 0) {
    console.error(
      `\ndeployments: ${plural(
        unclassified.length,
        "address-bearing key in",
        "address-bearing keys in",
      )} ${TEMPLATE_FILE} that this gate has never been told how to treat:\n`,
    );
    for (const name of unclassified) console.error(`  x ${name}`);
    console.error(
      `\ndeployments: decide whether each one is a deployment output - something an irreversible act of the`,
    );
    console.error(
      `deployments: deployment fixed, which must be recorded in ${RECORD_FILE} with an \`${JOIN_FIELD}\` - or`,
    );
    console.error(
      "deployments: a network constant or third-party address this project did not choose, which must not be.",
    );
    console.error(
      "deployments: then add it to CLASSIFICATION in scripts/deployments-check.mjs with the reason, so the next",
    );
    console.error("deployments: reader does not have to work it out again.");
    process.exit(1);
  }

  // A dropped declaration trips this and the forward direction at once, and
  // both facts are worth having in one message: the record still names the
  // address, and this script's own table still expects it. So they are reported
  // together rather than one exiting ahead of the other.
  if (
    staleTable.length > 0 ||
    notDeclared.length > 0 ||
    declaredButExcluded.length > 0 ||
    notRecorded.length > 0
  ) {
    console.error(
      `\ndeployments: ${RECORD_FILE} and ${TEMPLATE_FILE} do not name the same set of addresses\n`,
    );
    if (notDeclared.length > 0) {
      console.error(
        `  ${plural(notDeclared.length, "address is", "addresses are")} recorded through \`${JOIN_FIELD}\` ` +
          `but declared nowhere in ${TEMPLATE_FILE}:`,
      );
      for (const line of notDeclared) console.error(`  x ${line}`);
      console.error(
        `  Every consumer reads these through the environment, so a variable the template does not declare is`,
      );
      console.error("  a variable nobody will set. Declare each one, then add it to CLASSIFICATION here.\n");
    }
    if (declaredButExcluded.length > 0) {
      console.error(
        `  ${plural(declaredButExcluded.length, "address is", "addresses are")} recorded through ` +
          `\`${JOIN_FIELD}\` but classified as outside the record:`,
      );
      for (const line of declaredButExcluded) console.error(`  x ${line}`);
      console.error(
        "  The record and this classification disagree about what the deployment produced. One of them is wrong.\n",
      );
    }
    if (notRecorded.length > 0) {
      console.error(
        `  ${plural(notRecorded.length, "key is", "keys are")} classified as a deployment output but ` +
          `carry no \`${JOIN_FIELD}\` anywhere in ${RECORD_FILE}:`,
      );
      for (const name of notRecorded) console.error(`  x ${name}  (${CLASSIFICATION.get(name)?.why})`);
      console.error(
        `  This is a stale deployment record: something was deployed, or renamed, and ${RECORD_FILE} never`,
      );
      console.error(
        `  learned about it. Add the address with its \`${JOIN_FIELD}\`, read back off the chain rather than`,
      );
      console.error("  copied from a terminal.\n");
    }
    if (staleTable.length > 0) {
      console.error(
        `  ${plural(
          staleTable.length,
          "key this gate classifies is",
          "keys this gate classifies are",
        )} no longer declared in ${TEMPLATE_FILE}:`,
      );
      for (const name of staleTable) console.error(`  x ${name}`);
      console.error(
        "  The classification in scripts/deployments-check.mjs has gone stale alongside whatever else moved.",
      );
      console.error("  Remove each entry, or restore the declaration if it was dropped by mistake.\n");
    }
    console.error(
      "deployments: this is the failure the gate exists to catch. A key in one file and not the other is how a",
    );
    console.error("deployments: deployment record goes stale without anyone noticing.");
    process.exit(1);
  }

  if (valueMismatches.length > 0) {
    console.error(
      `\ndeployments: ${plural(valueMismatches.length, "key holds", "keys hold")} a different address in ` +
        `${LOCAL_FILE} than ${RECORD_FILE} read back off the chain\n`,
    );
    for (const line of valueMismatches) console.error(`  x ${line}`);
    console.error(
      "\ndeployments: the names agree and the addresses do not, so one of the two describes a deployment that is",
    );
    console.error(
      `deployments: not the live one. Re-run script/07_VerifyDeployment.s.sol - it holds no key - and correct`,
    );
    console.error("deployments: whichever file the chain disagrees with.");
    process.exit(1);
  }

  if (strictLocal && unfilled.length > 0) {
    console.error(
      `\ndeployments: \`--strict-env\` was given and ${plural(
        unfilled.length,
        "recorded key is",
        "recorded keys are",
      )} unfilled in ${LOCAL_FILE}.`,
    );
    process.exit(1);
  }

  const valueNote =
    useLocal && localPresent
      ? ` Values agree with ${LOCAL_FILE} too.`
      : ` Values not compared${useLocal ? `, no ${LOCAL_FILE} on disk` : ""}.`;
  console.log(
    `\ndeployments: ok. ${RECORD_FILE} and ${TEMPLATE_FILE} name the same ` +
      `${plural(matched.length, "address", "addresses")}, in both directions.${valueNote}`,
  );
}

main();
