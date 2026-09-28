#!/usr/bin/env node
/**
 * Assert the runtime the job installed satisfies `engines.node` in the root
 * manifest.
 *
 * The pipeline pins one exact Node version and the manifest states a floor.
 * Those two facts can drift apart without anything complaining, and the failure
 * mode is a green pipeline compiling against a runtime the project does not
 * claim to run on. This turns that drift into a failed step.
 *
 * Only `>=x.y.z` is understood, because that is the only shape the manifest
 * uses. Anything else is a failure rather than a guess.
 *
 * Exit codes: 0 satisfied, 1 not satisfied or unparseable.
 */

import { readFileSync } from "node:fs";

const MANIFEST = "package.json";

/**
 * @param {string} version a dotted numeric version
 * @returns {number[]} its numeric parts, padded to three
 */
function parts(version) {
  const numbers = version.split(".").map((part) => Number.parseInt(part, 10));
  if (numbers.length === 0 || numbers.some((part) => !Number.isInteger(part) || part < 0)) {
    console.error(`engine-floor: \`${version}\` is not a dotted numeric version.`);
    process.exit(1);
  }
  while (numbers.length < 3) numbers.push(0);
  return numbers.slice(0, 3);
}

/**
 * @param {number[]} left
 * @param {number[]} right
 * @returns {number} negative when left sorts first
 */
function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const declared = JSON.parse(readFileSync(MANIFEST, "utf8")).engines?.node;
if (typeof declared !== "string") {
  console.error(`engine-floor: ${MANIFEST} declares no \`engines.node\`.`);
  process.exit(1);
}

const match = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(declared.trim());
if (match === null) {
  console.error(
    `engine-floor: \`engines.node\` is \`${declared}\`, and only the \`>=x.y.z\` shape is understood.`,
  );
  console.error("engine-floor: widen this check deliberately rather than letting it guess.");
  process.exit(1);
}

const floor = parts(match[1]);
const actual = parts(process.versions.node);

if (compare(actual, floor) < 0) {
  console.error(
    `engine-floor: the runtime is ${process.versions.node}, below the declared floor ${declared}.`,
  );
  process.exit(1);
}

console.log(`engine-floor: ok. runtime ${process.versions.node} satisfies ${declared}.`);
