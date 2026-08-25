#!/usr/bin/env node
/**
 * Generates the replay-key differential fixture by *executing* the off-chain
 * implementation.
 *
 * `packages/shared/src/replay-key.ts` is the authority for the packing. This
 * script imports the built output of that module, runs it over a deterministic
 * tuple set, and records what it returned. The Solidity half of the differential
 * test (`test/property/ReplayKeyDifferential.t.sol`) runs `TabAscBase.replayKey`
 * and `TabAscBase.unpackReplayKey` over the same tuples and compares against
 * these recorded words. Both implementations therefore actually run; neither side
 * is checked against constants that a single wrong transcription could satisfy.
 *
 * Two modes:
 *
 *   node tools/replay-key-fixture.mjs            write the fixture
 *   node tools/replay-key-fixture.mjs --check    fail if the committed fixture
 *                                                disagrees with the off-chain
 *                                                implementation as it stands now
 *
 * The tuple set is a pure function of the seed below, so `--check` also fails if
 * the fixture has been trimmed, reordered, or hand-edited.
 *
 * The import below reaches `packages/shared` by relative path rather than through
 * a workspace dependency on purpose: `scripts/check-dep-direction.mjs` allows no
 * edge from `packages/contracts` to `packages/shared`, and the Solidity sources
 * genuinely have none. Only this fixture tool reads the other package, and only
 * its built output. Build ordering for the check comes from `turbo.json` in this
 * package, not from the manifest.
 *
 * Requirements: 4.1
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const FIXTURE_PATH = join(PACKAGE_ROOT, "test", "fixtures", "replay-key-vectors.json");
const SHARED_DIST = resolve(PACKAGE_ROOT, "..", "shared", "dist", "index.js");

const UINT64_MAX = 18_446_744_073_709_551_615n;
const FIELDS = ["chainKey", "blockHeight", "txIndex", "logIndex"];

/** Fixed seed. The tuple set is reproducible from it alone. */
const SEED = 0x7461_625f_7234_2e31n; // "tab_r4.1" as bytes

/**
 * The vectors pinned in prose on both sides of the boundary. Recorded here as a
 * third, independent statement of the layout: the generator asserts that the
 * off-chain implementation still produces exactly these words, so a change to
 * the off-chain packing cannot quietly propagate into the fixture and from there
 * into the Solidity expectation.
 */
const PINNED = [
  {
    tuple: [3n, 25_868_090n, 42n, 7n],
    key: "0x000000000000000300000000018ab73a000000000000002a0000000000000007",
  },
  { tuple: [0n, 0n, 0n, 0n], key: `0x${"0".repeat(64)}` },
  { tuple: [UINT64_MAX, UINT64_MAX, UINT64_MAX, UINT64_MAX], key: `0x${"f".repeat(64)}` },
  { tuple: [1n, 0n, 0n, 0n], key: `0x${"0".repeat(15)}1${"0".repeat(48)}` },
  { tuple: [0n, 1n, 0n, 0n], key: `0x${"0".repeat(31)}1${"0".repeat(32)}` },
  { tuple: [0n, 0n, 1n, 0n], key: `0x${"0".repeat(47)}1${"0".repeat(16)}` },
  { tuple: [0n, 0n, 0n, 1n], key: `0x${"0".repeat(63)}1` },
];

/** splitmix64: a deterministic 64-bit generator, so the tuple set is reproducible. */
function splitmix64(state) {
  let s = state;
  const MASK = (1n << 64n) - 1n;
  return () => {
    s = (s + 0x9e37_79b9_7f4a_7c15n) & MASK;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK;
    return (z ^ (z >> 31n)) & MASK;
  };
}

/**
 * The deterministic tuple set. Four groups, each aimed at a different way the two
 * implementations could disagree.
 *
 * @returns {bigint[][]} tuples as `[chainKey, blockHeight, txIndex, logIndex]`
 */
function generateTuples() {
  const tuples = [];
  const seen = new Set();
  const push = (tuple) => {
    const fingerprint = tuple.join(",");
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    tuples.push(tuple);
  };

  // 1. The pinned vectors, so the fixture carries them too.
  for (const { tuple } of PINNED) push(tuple);

  // 2. Every combination of the three interesting magnitudes per field: the low
  //    boundary, one above it, and the high boundary. Catches a field that is
  //    masked one bit too narrowly or one bit too widely.
  const boundaries = [0n, 1n, UINT64_MAX];
  for (const chainKey of boundaries) {
    for (const blockHeight of boundaries) {
      for (const txIndex of boundaries) {
        for (const logIndex of boundaries) push([chainKey, blockHeight, txIndex, logIndex]);
      }
    }
  }

  // 3. A single set bit walked through all 64 positions of each field in turn,
  //    every other field zero. This is what actually pins the four bit offsets:
  //    a field placed at the wrong offset moves 64 words at once.
  for (let field = 0; field < 4; field += 1) {
    for (let bit = 0n; bit < 64n; bit += 1n) {
      const tuple = [0n, 0n, 0n, 0n];
      tuple[field] = 1n << bit;
      push(tuple);
    }
  }

  // 4. Pseudorandom tuples across mixed magnitude classes, so realistic
  //    coordinates and near-ceiling coordinates appear in the same word.
  const next = splitmix64(SEED);
  const classes = [
    (r) => r % 4n, // tiny, the shape a chainKey has
    (r) => r % 40_000_000n, // realistic Source Chain block height
    (r) => r % 1024n, // realistic transaction or log index
    (r) => UINT64_MAX - (r % 1024n), // just under the ceiling
    (r) => r, // the full width
  ];
  for (let i = 0; i < 128; i += 1) {
    const tuple = FIELDS.map(() => {
      const draw = next();
      return classes[Number(next() % BigInt(classes.length))](draw);
    });
    push(tuple);
  }

  return tuples;
}

/** @returns the off-chain implementation, or a clear failure if it is not built */
async function loadOffChainImplementation() {
  if (!existsSync(SHARED_DIST)) {
    console.error(
      `replay-key-fixture: the off-chain implementation is not built.\n` +
        `  expected: ${SHARED_DIST}\n` +
        `  build it: pnpm --filter @tabai/shared build`,
    );
    process.exit(1);
  }
  return import(`file://${SHARED_DIST.split("\\").join("/")}`);
}

/**
 * Runs the off-chain implementation over the tuple set.
 *
 * @returns {{ tuples: bigint[][], keys: string[] }}
 */
function runOffChain({ replayKey, unpackReplayKey }, tuples) {
  // The pinned words first: the off-chain implementation must still produce them.
  for (const { tuple, key } of PINNED) {
    const produced = replayKey(...tuple);
    assert.equal(
      produced,
      key,
      `off-chain packing of (${tuple.join(", ")}) drifted: expected ${key}, produced ${produced}`,
    );
  }

  const keys = tuples.map((tuple) => {
    const key = replayKey(...tuple);
    // The off-chain inverse must agree with the off-chain forward direction before
    // the word is worth handing to the Solidity side at all.
    const fields = unpackReplayKey(key);
    for (let i = 0; i < FIELDS.length; i += 1) {
      assert.equal(
        fields[FIELDS[i]],
        tuple[i],
        `off-chain round trip failed on ${FIELDS[i]} of (${tuple.join(", ")})`,
      );
    }
    return key;
  });

  return { tuples, keys };
}

/** Renders the fixture. Decimal strings throughout, so nothing depends on how a JSON number is coerced. */
function renderFixture(tuples, keys) {
  const column = (index) => tuples.map((tuple) => tuple[index].toString());
  const fixture = {
    description:
      "Replay-key vectors produced by executing packages/shared/src/replay-key.ts. " +
      "Regenerate with `pnpm --filter @tabai/contracts fixture:replay-key`; " +
      "`test/property/ReplayKeyDifferential.t.sol` reads this file and compares the Solidity implementation against it.",
    generator: "packages/contracts/tools/replay-key-fixture.mjs",
    authority: "packages/shared/src/replay-key.ts",
    seed: `0x${SEED.toString(16)}`,
    count: tuples.length,
    vectors: {
      chainKey: column(0),
      blockHeight: column(1),
      txIndex: column(2),
      logIndex: column(3),
      key: keys,
    },
  };
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

function write(tuples, keys) {
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, renderFixture(tuples, keys), "utf8");
  console.log(`replay-key-fixture: wrote ${tuples.length} vectors to ${FIXTURE_PATH}`);
}

function check(tuples, keys) {
  if (!existsSync(FIXTURE_PATH)) {
    console.error(
      `replay-key-fixture: ${FIXTURE_PATH} is missing. Generate it with ` +
        "`pnpm --filter @tabai/contracts fixture:replay-key`.",
    );
    process.exit(1);
  }

  const committed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const failures = [];

  if (committed.count !== tuples.length) {
    failures.push(`count: committed ${committed.count}, generated ${tuples.length}`);
  }
  for (const column of [...FIELDS, "key"]) {
    const values = committed.vectors?.[column];
    if (!Array.isArray(values) || values.length !== tuples.length) {
      failures.push(
        `vectors.${column}: committed ${Array.isArray(values) ? values.length : "absent"} entries, generated ${tuples.length}`,
      );
    }
  }

  if (failures.length === 0) {
    for (let i = 0; i < tuples.length; i += 1) {
      for (let f = 0; f < FIELDS.length; f += 1) {
        const committedField = committed.vectors[FIELDS[f]][i];
        if (committedField !== tuples[i][f].toString()) {
          failures.push(
            `vector ${i}, ${FIELDS[f]}: committed ${committedField}, generated ${tuples[i][f]}`,
          );
        }
      }
      if (committed.vectors.key[i] !== keys[i]) {
        failures.push(
          `vector ${i} (${tuples[i].join(", ")}): committed key ${committed.vectors.key[i]}, off-chain implementation now produces ${keys[i]}`,
        );
      }
      if (failures.length > 8) break;
    }
  }

  if (failures.length > 0) {
    console.error(
      "replay-key-fixture: the committed fixture disagrees with the off-chain implementation.\n" +
        "Regenerate it with `pnpm --filter @tabai/contracts fixture:replay-key` and re-read the diff:\n",
    );
    for (const failure of failures) console.error(`  x ${failure}`);
    process.exit(1);
  }

  console.log(
    `replay-key-fixture: ok. ${tuples.length} committed vectors match the off-chain implementation.`,
  );
}

async function main() {
  const checking = process.argv.includes("--check");
  const implementation = await loadOffChainImplementation();
  const { tuples, keys } = runOffChain(implementation, generateTuples());
  if (checking) check(tuples, keys);
  else write(tuples, keys);
}

await main();
