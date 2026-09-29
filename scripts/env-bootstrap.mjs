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

/**
 * The deployment this bootstrap writes from.
 *
 * The record holds one entry per network and the template names the chain, so
 * only that entry is read. Taking addresses from all of them would write a
 * `.env` that mixes two chains, which is the one mistake this file exists to
 * prevent. `--chain` overrides the template, for writing a `.env` for the
 * other network without editing anything first.
 */
function activeNetwork(record) {
  const flag = process.argv.indexOf("--chain");
  const fromFlag = flag === -1 ? undefined : process.argv[flag + 1];
  const fromTemplate = /^MONAD_CHAIN_ID=(.*)$/m.exec(readFileSync(TEMPLATE, "utf8"))?.[1];
  const raw = (fromFlag ?? fromTemplate ?? "").trim();
  const chainId = Number.parseInt(raw, 10);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    console.error(`env-bootstrap: MONAD_CHAIN_ID is \`${raw}\`, which is not a chain id, so there is no deployment to read.`);
    process.exit(2);
  }
  const network = record?.networks?.[String(chainId)];
  if (network === undefined) {
    const known = Object.keys(record?.networks ?? {}).sort().join(", ") || "none";
    console.error(`env-bootstrap: deployments.json records ${known}, not chain ${chainId}.`);
    process.exit(2);
  }
  return network;
}

const record = JSON.parse(readFileSync(RECORD, "utf8"));
const network = activeNetwork(record);
const recorded = recordedAddresses(network);

/*
  The network's own coordinates come from the same entry as its addresses, so
  a `--chain 143` run never pairs Mainnet addresses with the template's Testnet
  chain id and RPC. USDC is Circle's on each network,
  recorded without an envKey, so it is chosen by chain id here.
*/
const assets = network.chainId === 143 ? record.mainnetAssets : record.testnetAssets;
const coordinates = new Map(
  [
    ["MONAD_CHAIN_ID", network.chainId],
    ["MONAD_RPC_URL", network.rpcUrl],
    ["MONAD_EXPLORER_URL", network.explorerUrl],
    ["REGISTRY_START_BLOCK", network.startBlock],
    ["USDC_ADDRESS", assets?.USDC],
  ]
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [key, String(value)]),
);

const filled = [];
const output = readFileSync(TEMPLATE, "utf8")
  .split("\n")
  .map((line) => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) return line;
    const [, key] = match;
    const coordinate = coordinates.get(key);
    if (coordinate !== undefined) return `${key}=${coordinate}`;
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
console.log("  fill AGENT_PRIVATE_KEY only if you intend to broadcast a Settlement.");
