#!/usr/bin/env node
/**
 * Writes a working `.env` from `.env.example` and `deployments.json`.
 *
 * `.env.example` is the tracked contract for variable *names* and deliberately
 * holds zero-address placeholders rather than values, for the reasons
 * `scripts/deployments-check.mjs` sets out at length. That is the right rule for
 * the template and it leaves a real gap for anyone arriving at the repository
 * for the first time: copying the template produces a file that names everything
 * correctly and reads nothing, and the first command they run fails on an
 * address that is public, recorded, and one file away.
 *
 * So this closes exactly that gap and nothing wider. It copies the template
 * verbatim, and for every key `deployments.json` carries an `envKey` for, it
 * substitutes the recorded address. Every other line, secrets included, is left
 * exactly as the template wrote it, so a key is still something you supply
 * yourself and nothing here can invent one.
 *
 * It refuses to overwrite an existing `.env`. That file holds private keys on
 * any machine that has settled anything, and a bootstrap command that could
 * silently replace it is a command nobody should run twice.
 *
 *   node scripts/env-bootstrap.mjs            # write .env, refusing to clobber
 *   node scripts/env-bootstrap.mjs --print    # write nothing, print the result
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE = join(ROOT, ".env.example");
const RECORD = join(ROOT, "deployments.json");
const TARGET = join(ROOT, ".env");

const printOnly = process.argv.includes("--print");

/** Every `{ envKey, address }` pair anywhere in the record, at any depth. */
function recordedAddresses(node, into = new Map()) {
  if (Array.isArray(node)) {
    for (const child of node) recordedAddresses(child, into);
    return into;
  }
  if (node === null || typeof node !== "object") return into;

  const address = node.address ?? node.value;
  if (typeof node.envKey === "string" && typeof address === "string") {
    into.set(node.envKey, address);
  }
  for (const child of Object.values(node)) recordedAddresses(child, into);
  return into;
}

const recorded = recordedAddresses(JSON.parse(readFileSync(RECORD, "utf8")));

const filled = [];
const output = readFileSync(TEMPLATE, "utf8")
  .split("\n")
  .map((line) => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) return line;
    const [, key] = match;
    const address = recorded.get(key);
    if (address === undefined) return line;
    filled.push(key);
    return `${key}=${address}`;
  })
  .join("\n");

if (printOnly) {
  process.stdout.write(output);
  process.exit(0);
}

if (existsSync(TARGET)) {
  console.error("env-bootstrap: .env already exists, and this command will not overwrite it.");
  console.error("  That file holds private keys on any machine that has settled anything.");
  console.error("  Compare against the record instead:  pnpm deployments:check");
  process.exit(1);
}

writeFileSync(TARGET, output, "utf8");

console.log(`env-bootstrap: wrote .env from .env.example, with ${filled.length} recorded address(es):`);
for (const key of filled) console.log(`  ${key.padEnd(34)} ${recorded.get(key)}`);
console.log();
console.log("Every read-only command works from here. Secrets are still placeholders:");
console.log("  fill AGENT_ETHEREUM_PRIVATE_KEY only if you intend to broadcast a Settlement.");
