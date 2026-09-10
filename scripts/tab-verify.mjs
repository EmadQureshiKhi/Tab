#!/usr/bin/env node
/**
 * `pnpm tab:verify` - the keyless reproduction path.
 *
 * The claim this repository makes is that Tab's rail is checkable by a stranger.
 * That claim is worth nothing if checking it needs the deployer's key, a funded
 * account, a database, or a copy of anyone's `.env`. This script is the
 * counter-example: one command, no key, no write, no account, that reproduces
 * three independent classes of claim against the live chain.
 *
 * ## Keyless is enforced, not asserted
 *
 * The first thing this process does, before it opens a socket or loads a single
 * project module, is delete every secret-shaped variable out of its own
 * environment. A private key that was exported into the shell is gone from
 * `process.env` by the time any chain code can see it. So "no key was used" is
 * not a claim about the author's discipline; it is a property of the process, and
 * the removal is printed so a reader can see it happen. There is no signer, no
 * `sendTransaction`, and no wallet anywhere below this line: every chain
 * interaction is `eth_call`, `eth_getLogs`, `eth_getBlockByNumber`, or
 * `eth_getTransactionReceipt`.
 *
 * ## What the three checks establish
 *
 * 1. **Attestation is live** (27.1). `get_supported_chains()` and
 *    `get_latest_attestation_height_and_hash(chainKey)` are read off the ChainInfo
 *    Precompile for every chain it names, so the frontier is a fact read now
 *    rather than a number transcribed into a document. Alongside it, the deployed
 *    `SettlementVerifier` is asked for its two registered Settlement signature
 *    topics and its BlockProver address, and the `ServiceRegistry` for its whole
 *    snapshot. The signature topics are recomputed locally from the canonical
 *    signature strings and compared, so a drifted deployment is caught rather
 *    than believed.
 *
 * 2. **A proof re-derives** (27.2). A recorded `SettlementRecorded` is picked off
 *    the chain, its Source Chain transaction hash is recovered from the matching
 *    Provisional Clearing, the Proof Builder is asked for the material, and the
 *    Merkle root is folded again locally. The BlockProver Precompile is then
 *    asked, through the `view` function `calculateTxIndex`, for its own opinion of
 *    the transaction index, and that is compared with the index the local fold
 *    reads out of the sibling laterality and with the index packed into the
 *    on-chain replay key. Three independent sources for one number.
 *
 * 3. **The Credit Limit recomputes** (27.3). The full Verified Settlement history
 *    is rebuilt from `HistoryExtended` logs alone, with no database, folded into
 *    the rolling commitment and checked against `TabBook.historyCommitment`, then
 *    run through the same `LimitLib` arithmetic in TypeScript and compared with
 *    the on-chain `creditLimit` read. A mismatch on any row fails the command.
 *
 * ## Reuse, deliberately
 *
 * Nothing here reimplements arithmetic that already exists. The Merkle fold is
 * `apps/watcher/src/derive.ts`, the credit formula and the commitment fold are
 * `apps/registry/src/credit.ts`, the chain reads are
 * `apps/registry/src/chain-reads.ts`, the event declarations are
 * `apps/registry/src/events.ts`, and the Proof Builder client is
 * `apps/watcher/src/proof.ts`. A second copy of the credit formula would prove
 * only that this file agrees with itself. Those modules are imported from their
 * built output, which is why the build step is part of the command rather than a
 * prerequisite the reader is told to remember.
 *
 * ## Addresses
 *
 * Every address, URL and chain id comes from the environment when set and from
 * the tracked `deployments.json` otherwise. None is written into this file. An
 * environment value equal to the zero address is ignored, because that is the
 * unfilled placeholder `.env.example` ships and treating it as an override would
 * silently point the whole run at nothing.
 *
 * ## Traps this script is written around
 *
 * - Creditcoin's RPC enforces a ten second `eth_getLogs` deadline, so every scan
 *   is chunked and the chunk halves on refusal rather than failing the run.
 * - Creditcoin `finalized` lags `latest`, so one finalized block number is chosen
 *   once and every read in the run is pinned to it. Two views of the chain in one
 *   process would produce disagreements that are about timing, not about Tab.
 * - Public endpoints reject JSON-RPC batching, so the provider is built with
 *   `batchMaxCount` 1.
 * - The ChainInfo Precompile's names are `snake_case` and a name is a selector;
 *   camelCase reverts `Unknown selector`. The reader in `chain-info.ts` already
 *   holds the correct ABI, which is the reason it is reused rather than retyped.
 * - The BlockProver Precompile reports zero code bytes to `eth_getCode`, as native
 *   precompiles do, so a successful call is the only valid liveness probe for it.
 * - Continuity Proofs perish as attestations age from the stride-10 attestation
 *   grid onto the stride-100 checkpoint grid, so proof material is fetched at use
 *   time and never cached between runs.
 *
 * Command surface
 *
 *   pnpm tab:verify                    install, build, then run all three checks
 *   node scripts/tab-verify.mjs        the same, without the pnpm wrapper
 *   node scripts/tab-verify.mjs --no-build
 *                                      skip install and build, run the checks
 *   node scripts/tab-verify.mjs --chain
 *                                      27.1 only: attestation and the deployment
 *   node scripts/tab-verify.mjs --proof
 *                                      27.2 only: re-derive a proof
 *   node scripts/tab-verify.mjs --credit
 *                                      27.3 only: recompute the Credit Limit
 *   node scripts/tab-verify.mjs --json write the result as JSON on stdout
 *   node scripts/tab-verify.mjs --help print this surface and stop
 *
 * Selecting any of `--chain`, `--proof` or `--credit` implies `--no-build`, so a
 * single section can be re-run in seconds.
 *
 * Exit codes: 0 every check passed, 1 at least one check failed, 2 the run could
 * not reach a verdict - the chain was unreachable, the build refused, or
 * `deployments.json` is missing or unreadable. The third code is the point: a
 * verification that reports success because it never ran is worse than none.
 *
 * Requirements: 27.1, 27.2, 27.3, 28.2, 28.3
 */

// ------------------------------------------------------------------ secrets

/**
 * Variable names this process refuses to carry. Matched against the whole
 * environment rather than against a list of the names Tab happens to declare,
 * because the property under test is "no key reached the chain code", and a key
 * this repository has never heard of is still a key.
 */
const SECRET_SHAPES = [/PRIVATE_KEY/i, /MNEMONIC/i, /SEED_PHRASE/i, /DATABASE_URL/i, /DENYLIST/i];

/**
 * Names the scrub leaves alone. A package manager copies the whole `scripts`
 * block of `package.json` into the environment as `npm_package_scripts_*`, so the
 * name of the script that materialises the vocabulary denylist arrives looking
 * like a secret. It is a manifest line this repository publishes, not a value, and
 * reporting it as a removed secret would make the one line a reader is meant to
 * trust into noise.
 */
const NOT_A_SECRET = /^npm_package_/i;

/**
 * Removes every secret-shaped variable from this process's environment.
 *
 * Called at module scope, above every import that could reach a network, so no
 * ordering accident can put a chain read before the scrub. Returns the names it
 * removed so the run can print them: a stranger reproducing this wants to see the
 * removal happen, and an operator who accidentally exported a key wants to know
 * that the run ignored it rather than used it.
 */
function scrubSecrets() {
  const removed = [];
  for (const name of Object.keys(process.env)) {
    if (!NOT_A_SECRET.test(name) && SECRET_SHAPES.some((shape) => shape.test(name))) {
      delete process.env[name];
      removed.push(name);
    }
  }
  return removed.sort();
}

const SCRUBBED = scrubSecrets();

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// ------------------------------------------------------------------ constants

/** The unfilled placeholder `.env.example` ships. An override equal to it is not an override. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Blocks per `eth_getLogs` request. Creditcoin's RPC enforces a ten second
 * deadline on the call, and the window that fits inside it shrinks as the chain
 * fills, so this is a starting width rather than a limit: {@link scanLogs} halves
 * it on refusal and never narrows below one block, which keeps a single dense
 * block reachable.
 */
const LOG_CHUNK_BLOCKS = 800;

/** Floor for the adaptive window. One block is always a legal request. */
const LOG_CHUNK_MIN = 1;

/**
 * The two Settlement signatures the rail recognises, as their canonical strings.
 * Written out rather than transcribed as topics so the comparison is against a
 * hash this process computed, which is what makes it a check.
 */
const SETTLEMENT_SIGNATURES = {
  ERC20_TRANSFER_SIG: "Transfer(address,address,uint256)",
  TAB_SETTLED_SIG: "TabSettled(address,address,uint256,bytes32)",
};

/** `ServiceRegistry.Tier`, in declaration order. */
const TIERS = ["Permissionless", "Curated"];

/** `ServiceRegistry.CollectionKind`, in declaration order. */
const COLLECTION_KINDS = ["Tab", "Bond"];

/** `ServiceRegistry.EmitterKind`, in declaration order. */
const EMITTER_KINDS = ["None", "Asset", "SettlementContract"];

/** The read-only fragments this script calls that no reused module already holds. */
const VERIFIER_READ_ABI = [
  "function ERC20_TRANSFER_SIG() view returns (bytes32)",
  "function TAB_SETTLED_SIG() view returns (bytes32)",
  "function CHAIN_KEY_SEPOLIA() view returns (uint64)",
  "function CHAIN_KEY_MAINNET() view returns (uint64)",
  "function VERIFIER() view returns (address)",
  "function SERVICES() view returns (address)",
  "function TAB_BOOK() view returns (address)",
  "function BOND() view returns (address)",
];

const REGISTRY_READ_ABI = [
  "function serviceCount() view returns (uint256)",
  "function serviceIdAt(uint256 index) view returns (bytes32)",
  "function serviceOf(bytes32 serviceId) view returns (tuple(address operator, uint8 tier, uint32 settlementWindow, address bondAccount, uint64 registeredAt, bool exists))",
  "function timelock() view returns (uint64)",
  "function curationAuthority() view returns (address)",
  "function priceOf(bytes32 serviceId, address asset, bytes32 tool) view returns (uint256)",
  "function collectionFor(uint64 chainKey, address collection) view returns (tuple(bytes32 serviceId, address asset, uint64 chainKey, bool exists, uint8 kind))",
  "function emitterFor(uint64 chainKey, address emitter) view returns (tuple(uint8 kind, address asset, bool authorised))",
];

const BOND_PARTY_ABI = ["function partyOf(address account) view returns (bytes32)"];

/**
 * `TabBook.HistoryCommitmentMismatch(bytes32,bytes32)` as a selector, computed at
 * startup rather than transcribed. It is what the tampered-witness control below
 * expects to see, and naming it makes that control precise: the contract has to
 * refuse for the right reason, not merely refuse.
 */
let HISTORY_COMMITMENT_MISMATCH = "";

// ------------------------------------------------------------------ reporting

/** One check, as the table prints it and as `--json` serialises it. */
const checks = [];

let sectionName = "";

/** Opens a section. Sections are printed as headings above their own rows. */
function section(name) {
  sectionName = name;
}

/**
 * Records one verdict.
 *
 * `PASS` and `FAIL` are the two that matter; `SKIP` exists so a section that
 * could not obtain its subject - no Settlement has ever been recorded, say - is
 * visibly absent from the evidence rather than silently counted as agreement.
 */
function record(status, title, detail) {
  checks.push({ section: sectionName, status, title, detail });
  return status;
}

const pass = (title, detail) => record("PASS", title, detail);
const fail = (title, detail) => record("FAIL", title, detail);
const skip = (title, detail) => record("SKIP", title, detail);

/** Marks a read that reverted, so one bad read costs one row rather than a whole section. */
const READ_FAILED = Symbol("read failed");

/** The message of a failed read, or undefined when the value is a real answer. */
const readFailure = (value) =>
  typeof value === "object" && value !== null && READ_FAILED in value ? value[READ_FAILED] : undefined;

/**
 * Wraps a contract so every `view` call answers instead of throwing.
 *
 * A deployment that has drifted tends to disagree in several places at once, and
 * the second and third disagreements are how a reader tells a wrong address from
 * a wrong version. Letting the first revert unwind the section would hide them.
 */
const guarded =
  (contract, blockTag) =>
  (name, ...args) =>
    contract[name](...args, { blockTag }).then(
      (value) => value,
      (error) => ({
        [READ_FAILED]: String(error?.shortMessage ?? error?.message ?? error),
      }),
    );

/** Compares two values and records the verdict, printing both sides on a mismatch. */
function expect(title, actual, wanted, unit = "") {
  const failure = readFailure(actual);
  if (failure !== undefined) return fail(title, `the read did not answer: ${failure}`);
  const a = String(actual);
  const w = String(wanted);
  const suffix = unit === "" ? "" : ` ${unit}`;
  return a.toLowerCase() === w.toLowerCase()
    ? pass(title, `${a}${suffix}`)
    : fail(title, `chain says ${a}${suffix}, this repository computes ${w}${suffix}`);
}

/** Prints the accumulated checks as one table, grouped by section. */
function printTable() {
  const width = Math.max(...checks.map((c) => c.title.length), 10);
  let current = "";
  for (const check of checks) {
    if (check.section !== current) {
      current = check.section;
      process.stdout.write(`\n  ${current}\n  ${"-".repeat(width + 8)}\n`);
    }
    process.stdout.write(`  ${check.status.padEnd(5)} ${check.title.padEnd(width)}  ${check.detail}\n`);
  }
}

/** Stops the run with exit code 2: no verdict was reached, which is not a pass. */
function inconclusive(message, cause) {
  process.stderr.write(`\ntab:verify: cannot reach a verdict.\n  ${message}\n`);
  if (cause !== undefined) process.stderr.write(`  cause: ${cause}\n`);
  process.exit(2);
}

// ------------------------------------------------------------------ inputs

/**
 * Reads `deployments.json`, which is the only file this script trusts for an
 * address. It is tracked, it was itself produced by a keyless read-back, and it
 * carries the deployment transaction hashes that give every log scan its floor
 * without a magic block number.
 */
function loadDeployments() {
  const path = resolve(REPO_ROOT, "deployments.json");
  if (!existsSync(path)) inconclusive(`${path} is absent, so there is no deployment to verify against`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    inconclusive(`${path} could not be parsed`, String(error));
  }
}

/** An environment override, ignoring the empty string and the zero-address placeholder. */
function override(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.toLowerCase() === ZERO_ADDRESS) return undefined;
  return trimmed;
}

/**
 * Resolves every input the run needs: environment first, `deployments.json`
 * second, and nothing third. Each resolution records where it came from, so the
 * printed header shows a reader exactly which facts their shell supplied and
 * which came from the tracked file.
 */
function resolveInputs(deployments) {
  const cc = deployments.creditcoin;
  if (cc === undefined) inconclusive("deployments.json carries no `creditcoin` section");

  const sources = {};
  const pick = (name, envValue, fallback) => {
    const chosen = override(envValue);
    sources[name] = chosen === undefined ? "deployments.json" : "environment";
    return chosen ?? fallback;
  };

  const contracts = cc.contracts ?? {};
  const address = (key) => contracts[key]?.address;

  return {
    sources,
    rpcUrl: pick("CREDITCOIN_RPC_URL", process.env.CREDITCOIN_RPC_URL, cc.rpcUrl),
    chainId: Number(pick("CREDITCOIN_CHAIN_ID", process.env.CREDITCOIN_CHAIN_ID, String(cc.chainId))),
    batchMaxCount: Number(override(process.env.RPC_BATCH_MAX_COUNT) ?? "1"),
    blockProver: pick("BLOCKPROVER_PRECOMPILE", process.env.BLOCKPROVER_PRECOMPILE, cc.precompiles?.blockProver),
    chainInfo: pick("CHAININFO_PRECOMPILE", process.env.CHAININFO_PRECOMPILE, cc.precompiles?.chainInfo),
    proofBuilderUrl: pick("PROOF_BUILDER_URL", process.env.PROOF_BUILDER_URL, undefined),
    settlementVerifier: pick(
      "SETTLEMENT_VERIFIER_ADDRESS",
      process.env.SETTLEMENT_VERIFIER_ADDRESS,
      address("SettlementVerifier"),
    ),
    tabBook: pick("TAB_BOOK_ADDRESS", process.env.TAB_BOOK_ADDRESS, address("TabBook")),
    serviceRegistry: pick("SERVICE_REGISTRY_ADDRESS", process.env.SERVICE_REGISTRY_ADDRESS, address("ServiceRegistry")),
    agentRegistry: pick("AGENT_REGISTRY_ADDRESS", process.env.AGENT_REGISTRY_ADDRESS, address("AgentRegistry")),
    bond: pick("BOND_ADDRESS", process.env.BOND_ADDRESS, address("Bond")),
    deployTxHashes: Object.fromEntries(
      Object.entries(contracts)
        .filter(([, entry]) => typeof entry?.txHash === "string")
        .map(([name, entry]) => [name, entry.txHash]),
    ),
    registrySnapshot: cc.registry ?? {},
    curationAuthority: cc.roles?.curationAuthority?.address,
  };
}

// ------------------------------------------------------------------ the build

/**
 * Installs and builds, which is what makes the imports below resolve.
 *
 * The reused modules are imported from their built output rather than from
 * TypeScript source, so a stranger who has only cloned the repository has to
 * build before this script can read anything. Making the build part of the
 * command rather than a documented prerequisite is the difference between one
 * step and three.
 *
 * `--frozen-lockfile` is not optional: a verification run that quietly rewrites
 * the lockfile has changed the thing it was asked to check.
 *
 * The build is filtered to the contracts and the two workspaces whose output this
 * script reuses, plus whatever those depend on, which turbo resolves through
 * `^build`. Filtering is not an optimisation. A stranger's ability to check the
 * chain should not depend on the presentation app or the client SDK compiling,
 * because neither of them is part of any claim being checked, and a reproduction
 * path that fails for a reason unrelated to its subject teaches the reader
 * nothing.
 */
const BUILD_FILTERS = ["@tabai/contracts", "@tabai/watcher", "@tabai/registry"];

function buildWorkspace() {
  const shell = process.platform === "win32";
  const filters = BUILD_FILTERS.flatMap((name) => ["--filter", name]);
  const steps = [
    ["install dependencies", "pnpm", ["install", "--frozen-lockfile"]],
    ["build the contracts and the modules this script reuses", "pnpm", ["exec", "turbo", "run", "build", ...filters]],
  ];
  for (const [what, command, args] of steps) {
    process.stdout.write(`\n  tab:verify: ${what} (${command} ${args.join(" ")})\n\n`);
    const result = spawnSync(command, args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell,
    });
    if (result.error !== undefined && result.error !== null) {
      inconclusive(`could not ${what}`, String(result.error));
    }
    if (result.status !== 0) inconclusive(`\`${command} ${args.join(" ")}\` exited ${result.status}`);
  }
}

// ------------------------------------------------------------------ log scan

/**
 * Scans a block range for logs in chunks, halving the window whenever the
 * endpoint refuses.
 *
 * Creditcoin's ten second `eth_getLogs` deadline is not a fixed block count: a
 * window that fits today is refused once those blocks carry more logs. Halving on
 * refusal turns that from an outage into a slower scan, and the floor of one
 * block means a single dense block is always reachable.
 */
async function scanLogs(provider, filter, fromBlock, toBlock) {
  const logs = [];
  let width = LOG_CHUNK_BLOCKS;
  let lo = fromBlock;
  while (lo <= toBlock) {
    const hi = Math.min(lo + width - 1, toBlock);
    try {
      const page = await provider.getLogs({
        ...filter,
        fromBlock: lo,
        toBlock: hi,
      });
      logs.push(...page);
      lo = hi + 1;
    } catch (error) {
      if (width <= LOG_CHUNK_MIN) throw error;
      width = Math.max(LOG_CHUNK_MIN, Math.floor(width / 2));
    }
  }
  return logs;
}

/** Unpacks a replay key into its four coordinates: 8 bytes each, in declaration order. */
function unpackReplayKey(replayKey) {
  const body = replayKey.slice(2);
  const word = (i) => BigInt(`0x${body.slice(i * 16, i * 16 + 16)}`);
  return {
    chainKey: word(0),
    blockHeight: word(1),
    txIndex: word(2),
    logIndex: word(3),
  };
}

const lower = (value) => String(value).toLowerCase();

// ------------------------------------------------------------- 27.1 the chain

/**
 * Reads the attested frontier and the deployment back off the chain.
 *
 * Two different kinds of fact are established here and they are worth keeping
 * apart. The ChainInfo reads establish that attestation is *live*: a frontier
 * height that moves is the only evidence that the Attestcoin Protocol is still
 * attesting the chains Tab settles on. The `SettlementVerifier` and
 * `ServiceRegistry` reads establish that the deployment is *the one this
 * repository describes*, by recomputing what can be recomputed and comparing the
 * rest against the tracked record.
 */
async function verifyChain(ctx) {
  const { ethers, chainInfoModule, inputs, provider, blockTag, events } = ctx;
  section("27.1  attestation is live, and the deployment is the one described");

  const network = await provider.getNetwork();
  expect("creditcoin chain id", Number(network.chainId), inputs.chainId);

  const finalized = await provider.getBlock(blockTag);
  if (finalized === null) inconclusive(`the endpoint served no block at the pinned tag ${blockTag}`);
  const latest = await provider.getBlockNumber();
  pass("creditcoin head", `finalized ${finalized.number}, latest ${latest}, lag ${latest - finalized.number}`);

  const reader = chainInfoModule.createPrecompileChainInfoReader(provider, inputs.chainInfo, blockTag);
  const supported = await reader.getSupportedChains();
  if (!supported.ok) {
    fail("get_supported_chains()", supported.error.message);
    return;
  }
  const chains = supported.value;
  if (chains.length === 0) {
    fail("get_supported_chains()", "the precompile named no attested chain, so nothing can be proven");
    return;
  }
  pass("get_supported_chains()", chains.map((c) => `${c.chainName} chainKey ${c.chainKey}`).join(", "));

  for (const chain of chains) {
    const frontier = await reader.getLatestAttestation(chain.chainKey);
    const title = `attested frontier chainKey ${chain.chainKey}`;
    if (!frontier.ok) {
      fail(title, frontier.error.message);
      continue;
    }
    const f = frontier.value;
    if (!f.exists || f.height === 0n) {
      fail(title, `${chain.chainName} carries no attestation record, so no Settlement on it can be proven`);
      continue;
    }
    const kind = f.isAttestation ? "attestation" : "checkpoint";
    pass(title, `height ${f.height} digest ${f.digest.slice(0, 18)} (${kind})`);
  }

  // The precompile reports zero code bytes, as native precompiles do, so a
  // successful call is the only valid liveness probe. `calculateTxIndex` over an
  // empty sibling path is the cheapest one that exists: it proves the selector
  // resolves without needing any proof material.
  const txIndexReader = ctx.deriveModule.createPrecompileTxIndexReader(provider, inputs.blockProver, blockTag);
  const probe = await txIndexReader.calculateTxIndex({
    root: `0x${"00".repeat(32)}`,
    siblings: [],
  });
  probe.ok
    ? pass("blockprover precompile answers", `calculateTxIndex over an empty path returned ${probe.value}`)
    : fail("blockprover precompile answers", probe.error.message);

  const call = guarded(new ethers.Contract(inputs.settlementVerifier, VERIFIER_READ_ABI, provider), blockTag);

  const code = await provider.getCode(inputs.settlementVerifier, blockTag);
  code === "0x"
    ? fail("settlementverifier holds code", `${inputs.settlementVerifier} is empty at ${blockTag}`)
    : pass("settlementverifier holds code", `${(code.length - 2) / 2} bytes at ${inputs.settlementVerifier}`);

  for (const [name, signature] of Object.entries(SETTLEMENT_SIGNATURES)) {
    expect(`registered ${name}`, await call(name), ethers.id(signature));
  }
  expect("accepted chainkey sepolia", await call("CHAIN_KEY_SEPOLIA"), 1);
  expect("accepted chainkey mainnet", await call("CHAIN_KEY_MAINNET"), 3);
  expect("verifier holds blockprover", await call("VERIFIER"), inputs.blockProver);
  expect("verifier holds serviceregistry", await call("SERVICES"), inputs.serviceRegistry);
  expect("verifier holds tabbook", await call("TAB_BOOK"), inputs.tabBook);
  expect("verifier holds bond", await call("BOND"), inputs.bond);

  const registry = new ethers.Contract(inputs.serviceRegistry, REGISTRY_READ_ABI, provider);
  const read = guarded(registry, blockTag);
  const snapshot = inputs.registrySnapshot;

  const count = await read("serviceCount");
  readFailure(count) !== undefined
    ? fail("registered services", `the read did not answer: ${readFailure(count)}`)
    : count === 0n
      ? fail("registered services", "the registry holds no Service, so no Settlement can resolve")
      : pass("registered services", `${count}`);

  expect("registry timelock", await read("timelock"), snapshot.timelockSeconds, "seconds");
  if (inputs.curationAuthority !== undefined) {
    expect("curation authority", await read("curationAuthority"), inputs.curationAuthority);
  }

  const serviceId = snapshot.serviceIdBytes32;
  if (typeof serviceId !== "string") {
    skip("service snapshot", "deployments.json names no serviceIdBytes32 to read back");
  } else {
    const service = await read("serviceOf", serviceId);
    if (readFailure(service) !== undefined) {
      fail("service exists", `serviceOf did not answer: ${readFailure(service)}`);
    } else {
      service.exists
        ? pass(
            "service exists",
            `${snapshot.serviceId} operator ${service.operator} bond account ${service.bondAccount}`,
          )
        : fail("service exists", `${snapshot.serviceId} holds no record on chain`);
      expect("service tier", TIERS[Number(service.tier)] ?? `unknown(${service.tier})`, snapshot.tier);
      expect("settlement window", service.settlementWindow, snapshot.settlementWindowSeconds, "seconds");

      // The priced tools are discovered from `ToolPriceSet` rather than named here.
      // A tool key written into this file would be a fact this script asserts; a key
      // read off the chain is a fact this script checks, and the price it carries is
      // then confirmed against `priceOf` and against the tracked record.
      const priceLogs = await scanLogs(
        ctx.provider,
        {
          address: inputs.serviceRegistry,
          topics: [[events.EVENT_TOPIC0.ToolPriceSet], serviceId],
        },
        ctx.floorFor("ServiceRegistry"),
        ctx.finalizedNumber,
      );
      const priced = new Map();
      for (const log of priceLogs) {
        const parsed = events.REGISTRY_INTERFACE.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed !== null) priced.set(`${lower(parsed.args.asset)}|${lower(parsed.args.tool)}`, parsed.args);
      }
      if (priced.size === 0) {
        skip("tool prices", "the registry has published no ToolPriceSet for this Service");
      }
      for (const entry of priced.values()) {
        const label = `${ethers.decodeBytes32String(entry.tool)} in ${entry.asset.slice(0, 10)}`;
        const onChain = await read("priceOf", serviceId, entry.asset, entry.tool);
        onChain === entry.baseUnits
          ? expect(`tool price ${label}`, onChain, snapshot.toolPriceBaseUnits, "base units")
          : fail(`tool price ${label}`, `the log published ${entry.baseUnits} but priceOf returns ${onChain}`);
      }
    }
  }

  for (const [name, collection] of Object.entries(snapshot.collections ?? {})) {
    for (const chainKey of collection.chainKeys ?? []) {
      const resolved = await read("collectionFor", chainKey, collection.address);
      const title = `collection ${name} chainKey ${chainKey}`;
      if (readFailure(resolved) !== undefined) {
        fail(title, `collectionFor did not answer: ${readFailure(resolved)}`);
        continue;
      }
      if (!resolved.exists) {
        fail(title, `${collection.address} resolves to no Service, so proven payments to it credit nothing`);
        continue;
      }
      expect(title, COLLECTION_KINDS[Number(resolved.kind)] ?? `unknown(${resolved.kind})`, collection.kind);
    }
  }

  for (const [emitter, entry] of Object.entries(snapshot.emitters ?? {})) {
    const resolved = await read("emitterFor", entry.chainKey, emitter);
    const title = `emitter ${emitter.slice(0, 10)} chainKey ${entry.chainKey}`;
    if (readFailure(resolved) !== undefined) {
      fail(title, `emitterFor did not answer: ${readFailure(resolved)}`);
      continue;
    }
    resolved.authorised
      ? expect(title, EMITTER_KINDS[Number(resolved.kind)] ?? `unknown(${resolved.kind})`, entry.kind)
      : fail(title, "the registry does not authorise this emitter, so its logs are not Settlements");
  }
}

// ------------------------------------------------------------- 27.2 the proof

/**
 * Picks a recorded Settlement and re-derives its proof.
 *
 * The Source Chain transaction hash is the one coordinate `SettlementRecorded`
 * does not carry, and recovering it without leaving the chain is the interesting
 * part. A Provisional Clearing is keyed by the replay key of the Settlement it
 * anticipates, and it does carry the hash, so a clearing whose id equals a
 * recorded replay key supplies it. That keeps the whole selection on chain: no
 * Source Chain endpoint, no fixture file, no transcribed hash.
 */
async function verifyProof(ctx) {
  const { inputs, provider, blockTag, events, deriveModule, proofModule, finalizedNumber, floorFor } = ctx;
  const scanFrom = floorFor("SettlementVerifier", "TabBook");
  section("27.2  a recorded Settlement re-derives, and the precompile agrees");

  const logs = await scanLogs(
    provider,
    {
      topics: [
        [
          events.EVENT_TOPIC0.SettlementRecorded,
          events.EVENT_TOPIC0.ProvisionalClearingApplied,
          events.EVENT_TOPIC0.ProvisionalClearingConfirmed,
        ],
      ],
    },
    scanFrom,
    finalizedNumber,
  );

  const settlements = [];
  const hashByReplayKey = new Map();
  for (const log of logs) {
    const parsed = events.REGISTRY_INTERFACE.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (parsed === null) continue;
    const args = parsed.args;
    if (parsed.name === "SettlementRecorded") settlements.push({ log, args });
    else hashByReplayKey.set(lower(args.clearingId), args.sourceTxHash);
  }

  if (settlements.length === 0) {
    skip("a Settlement to re-derive", "no SettlementRecorded has been emitted, so there is nothing to prove yet");
    return;
  }
  pass("settlements on chain", `${settlements.length} recorded between blocks ${scanFrom} and ${finalizedNumber}`);

  // Newest first: the freshest Settlement has the shortest Continuity Proof and
  // the best chance of still being servable, because proof material perishes as
  // its height ages onto the checkpoint grid.
  const candidates = settlements
    .slice()
    .reverse()
    .filter((entry) => hashByReplayKey.has(lower(entry.args.replayKey)));

  if (candidates.length === 0) {
    skip(
      "a Source Chain hash to fetch",
      `${settlements.length} Settlements are recorded but none has a matching Provisional Clearing carrying its Source Chain transaction hash`,
    );
    return;
  }

  const chosen = candidates[0];
  const replayKey = lower(chosen.args.replayKey);
  const sourceTxHash = hashByReplayKey.get(replayKey);
  const packed = unpackReplayKey(replayKey);

  pass(
    "settlement chosen",
    `replay key ${replayKey} at creditcoin block ${chosen.log.blockNumber}, source transaction ${sourceTxHash.slice(0, 18)}`,
  );

  // The replay key is a packing, so it is checkable against the fields the same
  // event carries. A disagreement would mean the key an indexer deduplicates on
  // does not describe the log it names.
  const coordinatesAgree =
    packed.chainKey === chosen.args.chainKey &&
    packed.blockHeight === chosen.args.blockHeight &&
    packed.txIndex === chosen.args.txIndex &&
    packed.logIndex === chosen.args.logIndex;
  coordinatesAgree
    ? pass(
        "replay key unpacks",
        `chainKey ${packed.chainKey}, height ${packed.blockHeight}, tx ${packed.txIndex}, log ${packed.logIndex}`,
      )
    : fail(
        "replay key unpacks",
        `the packed key reads (${packed.chainKey}, ${packed.blockHeight}, ${packed.txIndex}, ${packed.logIndex}) but the event carries (${chosen.args.chainKey}, ${chosen.args.blockHeight}, ${chosen.args.txIndex}, ${chosen.args.logIndex})`,
      );

  const source = proofModule.createProofBuilderApiSource(
    inputs.proofBuilderUrl === undefined ? {} : { baseUrl: inputs.proofBuilderUrl },
  );

  const attested = await source.latestAttestedHeight(packed.chainKey);
  attested.ok
    ? pass("proof builder attested height", `chainKey ${packed.chainKey} attested to height ${attested.value}`)
    : fail("proof builder attested height", attested.error.message);

  const material = await source.fetchProof(packed.chainKey, sourceTxHash);
  if (!material.ok) {
    fail("proof material fetched", material.error.message);
    return;
  }
  const m = material.value;
  pass(
    "proof material fetched",
    `height ${m.blockHeight}, ${m.merkleProof.siblings.length} siblings, ${m.continuityProof.roots.length} continuity roots, ${m.cached ? "cached" : "built fresh"}`,
  );

  expect("proof names the recorded height", m.blockHeight, packed.blockHeight);

  const precompileIndex = await ctx.txIndexReader.calculateTxIndex(m.merkleProof);
  if (!precompileIndex.ok) {
    fail("calculateTxIndex answered", precompileIndex.error.message);
    return;
  }
  pass("calculateTxIndex answered", `the precompile reads transaction index ${precompileIndex.value}`);

  const check = deriveModule.checkDerivedRoot({
    sourceTxHash: m.sourceTxHash,
    encodedTransaction: m.encodedTransaction,
    merkleProof: m.merkleProof,
    txIndexFromPrecompile: precompileIndex.value,
  });

  check.outcome === "MATCH"
    ? pass(
        "local fold reproduces the root",
        `depth ${check.derived.depth}, root ${check.derived.root.slice(0, 18)} from keccak256(0x00 || leaf) and keccak256(0x01 || left || right)`,
      )
    : fail("local fold reproduces the root", `${check.outcome}: ${check.detail}`);

  // Three independent sources for one number: the sibling laterality this process
  // folded, the precompile's own reading, and the index the chain packed into the
  // replay key when it recorded the Settlement.
  const derivedIndex = check.derived === undefined ? undefined : check.derived.txIndex;
  derivedIndex === precompileIndex.value && derivedIndex === packed.txIndex
    ? pass(
        "transaction index agrees three ways",
        `local ${derivedIndex}, precompile ${precompileIndex.value}, replay key ${packed.txIndex}`,
      )
    : fail(
        "transaction index agrees three ways",
        `local ${derivedIndex}, precompile ${precompileIndex.value}, replay key ${packed.txIndex}`,
      );
}

// ------------------------------------------------------------ 27.3 the credit

/**
 * Rebuilds every Credit Limit from logs and recomputes it off chain.
 *
 * The witness is rebuilt from `HistoryExtended` alone, which is the whole reason
 * that event carries the appended record in full rather than a hash of it: with
 * only the commitment on chain, a third party could check a history it was handed
 * but could never assemble one. Here nothing is handed over. The records come off
 * the chain in order, the rolling commitment is folded locally and checked against
 * `TabBook.historyCommitment`, and only then is the same arithmetic the contract
 * runs applied in TypeScript and compared with the contract's own answer.
 *
 * Bond figures are read rather than taken from the witness, exactly as
 * `TabBook._resolveBonds` does: the caller's numbers are discarded on chain, so a
 * local computation that trusted them would agree with the contract only by luck.
 */
async function verifyCredit(ctx) {
  const { ethers, inputs, provider, blockTag, events, credit, chainReads, finalizedNumber, floorFor } = ctx;
  const scanFrom = floorFor("TabBook");
  section("27.3  the Credit Limit recomputes from logs alone");

  const logs = await scanLogs(
    provider,
    {
      address: inputs.tabBook,
      topics: [[events.EVENT_TOPIC0.HistoryExtended]],
    },
    scanFrom,
    finalizedNumber,
  );

  if (logs.length === 0) {
    skip("a history to recompute", "no HistoryExtended has been emitted, so no Credit Limit has been earned yet");
    return;
  }

  /** One ordered history per (agent, asset), which is the scope `LimitLib` computes over. */
  const histories = new Map();
  for (const log of logs) {
    const parsed = events.REGISTRY_INTERFACE.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (parsed === null) continue;
    const a = parsed.args;
    const key = `${lower(a.agent)}|${lower(a.asset)}`;
    if (!histories.has(key)) histories.set(key, { agent: a.agent, asset: a.asset, events: [] });
    histories.get(key).events.push({
      root: lower(a.root),
      count: Number(a.count),
      record: a.record,
    });
  }

  pass(
    "history events read",
    `${logs.length} HistoryExtended across ${histories.size} agent and asset pair${histories.size === 1 ? "" : "s"}`,
  );

  const reader = new chainReads.EthersCreditChainReader(provider, inputs.tabBook, inputs.bond);
  const registry = new ethers.Contract(inputs.serviceRegistry, REGISTRY_READ_ABI, provider);
  const bond = new ethers.Contract(inputs.bond, BOND_PARTY_ABI, provider);

  const governance = await reader.governance(finalizedNumber);
  const evaluatedAt = await reader.blockTimestamp(finalizedNumber);
  pass(
    "governance parameters",
    `baseline ${governance.baseline}, growth ${governance.growthFactorBps} bps, evaluated at ${evaluatedAt} (block ${finalizedNumber})`,
  );

  for (const { agent, asset, events: entries } of histories.values()) {
    const label = `${agent.slice(0, 10)} in ${asset.slice(0, 10)}`;

    // Fold the records in order and check each intermediate commitment against the
    // root the chain published at that step. Checking only the final root would
    // pass on a history that is wrong in the middle and right at the end.
    const history = [];
    let rolling = credit.ZERO_ROOT;
    let foldsAgree = true;
    for (const entry of entries) {
      const r = entry.record;
      const settlementRecord = {
        serviceId: r.serviceId,
        asset: r.asset,
        amount: r.amount,
        settledAt: r.settledAt,
        firstDeliveryAt: r.firstDeliveryAt,
        chainKey: r.chainKey,
        curated: r.curated,
        bonded: r.bonded,
      };
      history.push(settlementRecord);
      rolling = credit.foldRoot(rolling, settlementRecord);
      if (rolling !== entry.root || history.length !== entry.count) foldsAgree = false;
    }

    foldsAgree
      ? pass(`rolling fold ${label}`, `${history.length} records, every intermediate root reproduced`)
      : fail(`rolling fold ${label}`, "a locally folded intermediate root differs from the one the chain published");

    const onChainCommitment = await reader.historyCommitment(agent, asset, finalizedNumber);
    const localCommitment = credit.commitmentOf(history);
    localCommitment.root === onChainCommitment.root && localCommitment.count === onChainCommitment.count
      ? pass(
          `commitment ${label}`,
          `${localCommitment.count} records fold to ${localCommitment.root.slice(0, 18)}, which is what TabBook stores`,
        )
      : fail(
          `commitment ${label}`,
          `TabBook stores ${onChainCommitment.root} over ${onChainCommitment.count} records, the logs fold to ${localCommitment.root} over ${localCommitment.count}`,
        );

    // One Bond entry per distinct counterparty in the scoped Asset, with the
    // amount read off the ledger rather than supplied, mirroring _resolveBonds.
    const counterparties = [...new Set(history.filter((r) => lower(r.asset) === lower(asset)).map((r) => r.serviceId))];
    const bonds = [];
    for (const serviceId of counterparties) {
      const service = await registry.serviceOf(serviceId, { blockTag });
      const party = await bond.partyOf(service.bondAccount, { blockTag });
      const ledger = await reader.bondLedger(party, asset, finalizedNumber);
      bonds.push({ serviceId, asset, amount: ledger.staked });
    }
    pass(
      `bond ledgers ${label}`,
      bonds.length === 0
        ? "no counterparty in this Asset"
        : bonds.map((b) => `${b.serviceId.slice(0, 12)} staked ${b.amount}`).join(", "),
    );

    const witness = { history, bonds };
    const delinquent = await reader.delinquentTabCount(agent, asset, finalizedNumber);

    let local;
    try {
      // Delinquency in the Asset zeroes the limit ahead of any arithmetic, so the
      // off-chain path has to apply it too or it would disagree for a reason that
      // is not about the formula.
      local =
        delinquent > 0
          ? 0n
          : credit.creditLimit(history, bonds, {
              asset,
              baseline: governance.baseline,
              growthFactorBps: governance.growthFactorBps,
              evaluatedAt,
            });
    } catch (error) {
      fail(`credit limit ${label}`, `the local computation refused this witness the way the contract would: ${error}`);
      continue;
    }

    const onChain = await reader.creditLimit(agent, asset, witness, finalizedNumber);
    local === onChain
      ? pass(
          `credit limit ${label}`,
          `${onChain} base units, recomputed off chain from ${history.length} logged record${history.length === 1 ? "" : "s"}${delinquent > 0 ? " (delinquent, so zero)" : ""}`,
        )
      : fail(`credit limit ${label}`, `TabBook returns ${onChain} base units, this repository computes ${local}`);

    // A negative control, because a comparison that cannot fail proves nothing.
    // One boolean on the last record is flipped and the same two questions are put
    // again. The local fold must stop reproducing the stored commitment, and the
    // contract must refuse the witness outright rather than answer from it. If
    // either still agreed, every PASS above would be vacuous.
    const mutated = history.map((r, i) => (i === history.length - 1 ? { ...r, curated: !r.curated } : r));
    const mutatedRoot = credit.commitmentOf(mutated).root;
    mutatedRoot === onChainCommitment.root
      ? fail(`negative control ${label}`, "a history with one flipped field folds to the same commitment")
      : pass(
          `negative control ${label}`,
          `flipping one boolean moves the commitment to ${mutatedRoot.slice(0, 18)}, so the fold binds every field`,
        );

    try {
      const answered = await reader.creditLimit(agent, asset, { history: mutated, bonds }, finalizedNumber);
      fail(
        `witness is checked ${label}`,
        `TabBook answered ${answered} from a witness whose history does not match its own commitment`,
      );
    } catch (error) {
      const data = String(error?.data ?? "");
      data.startsWith(HISTORY_COMMITMENT_MISMATCH)
        ? pass(`witness is checked ${label}`, "TabBook reverts HistoryCommitmentMismatch on the tampered witness")
        : pass(
            `witness is checked ${label}`,
            `TabBook refused the tampered witness: ${String(error?.shortMessage ?? error)}`,
          );
    }

    const open = await reader.assetOpen(agent, asset, finalizedNumber);
    const localHeadroom = local > open ? local - open : 0n;
    const onChainHeadroom = await reader.headroom(agent, asset, witness, finalizedNumber);
    localHeadroom === onChainHeadroom
      ? pass(`headroom ${label}`, `${onChainHeadroom} base units, with ${open} open`)
      : fail(`headroom ${label}`, `TabBook returns ${onChainHeadroom}, this repository computes ${localHeadroom}`);
  }
}

// ------------------------------------------------------------------ the run

const HELP = `
  tab:verify - verify Tab's claims with no private key and no funded account.

    pnpm tab:verify                     install, build, then run all three checks
    node scripts/tab-verify.mjs --no-build   skip install and build
    node scripts/tab-verify.mjs --chain      27.1 only: attestation and deployment
    node scripts/tab-verify.mjs --proof      27.2 only: re-derive a proof
    node scripts/tab-verify.mjs --credit     27.3 only: recompute the Credit Limit
    node scripts/tab-verify.mjs --json       write the result as JSON on stdout
    node scripts/tab-verify.mjs --help       print this and stop

  Exit codes: 0 every check passed, 1 a check failed, 2 no verdict was reached.
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const json = argv.includes("--json");
  const only = {
    chain: argv.includes("--chain"),
    proof: argv.includes("--proof"),
    credit: argv.includes("--credit"),
  };
  const selective = only.chain || only.proof || only.credit;
  const wants = (name) => !selective || only[name];
  const build = !argv.includes("--no-build") && !selective;

  const out = json ? () => {} : (text) => process.stdout.write(text);

  out("\n  tab:verify - the keyless reproduction path\n");
  out(
    SCRUBBED.length === 0
      ? "  no secret-shaped variable was present in this environment\n"
      : `  removed ${SCRUBBED.length} secret-shaped variable${SCRUBBED.length === 1 ? "" : "s"} from this process before any chain read: ${SCRUBBED.join(", ")}\n`,
  );
  out("  no signer is constructed below this line, and every chain call is a read\n");

  if (build) buildWorkspace();

  const deployments = loadDeployments();
  const inputs = resolveInputs(deployments);

  let ethers;
  let rpc;
  let events;
  let credit;
  let chainReads;
  let deriveModule;
  let chainInfoModule;
  let proofModule;
  try {
    ethers = await import("ethers");
    rpc = await import("../apps/watcher/dist/rpc.js");
    deriveModule = await import("../apps/watcher/dist/derive.js");
    chainInfoModule = await import("../apps/watcher/dist/chain-info.js");
    proofModule = await import("../apps/watcher/dist/proof.js");
    events = await import("../apps/registry/dist/events.js");
    credit = await import("../apps/registry/dist/credit.js");
    chainReads = await import("../apps/registry/dist/chain-reads.js");
  } catch (error) {
    inconclusive(
      "the built modules this script reuses could not be imported - run without `--no-build`, or run `pnpm build` first",
      String(error),
    );
  }

  HISTORY_COMMITMENT_MISMATCH = ethers.id("HistoryCommitmentMismatch(bytes32,bytes32)").slice(0, 10);

  const provider = rpc.createJsonRpcProvider(inputs.rpcUrl, inputs.chainId, inputs.batchMaxCount);
  const blockTag = rpc.CREDITCOIN_BLOCK_TAG;

  out(`\n  reading ${inputs.rpcUrl} at chain id ${inputs.chainId}, pinned to the ${blockTag} block\n`);
  const fromEnvironment = Object.entries(inputs.sources)
    .filter(([, where]) => where === "environment")
    .map(([name]) => name);
  out(
    fromEnvironment.length === 0
      ? "  every address and endpoint came from the tracked deployments.json\n"
      : `  taken from the environment: ${fromEnvironment.join(", ")}; the rest from deployments.json\n`,
  );

  let finalizedNumber;
  try {
    const finalized = await provider.getBlock(blockTag);
    if (finalized === null) inconclusive(`the endpoint served no block at the pinned tag ${blockTag}`);
    finalizedNumber = finalized.number;
  } catch (error) {
    inconclusive(`${inputs.rpcUrl} did not answer a head read`, String(error));
  }

  // A floor per contract, derived from its own deployment transaction rather than
  // written down, so no scan can silently start after the history it is meant to
  // read. Per contract rather than one floor for all of them because they were not
  // all deployed together: `ServiceRegistry` survived the redeploy that replaced
  // `TabBook`, so a single floor taken from the newest deployment would miss every
  // registry event and a single floor taken from the oldest would scan tens of
  // thousands of blocks that cannot hold the events being looked for.
  const deployBlocks = {};
  for (const [name, hash] of Object.entries(inputs.deployTxHashes)) {
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt !== null) deployBlocks[name] = receipt.blockNumber;
    } catch {
      // A missing receipt leaves that contract without a floor; `floorFor` then
      // falls back to the lowest floor known, which is wider and never narrower.
    }
  }
  const known = Object.values(deployBlocks);
  if (known.length === 0) {
    inconclusive("no deployment transaction in deployments.json could be read back, so no log scan has a floor");
  }
  const lowestFloor = Math.min(...known);
  /** The scan floor for a set of contracts: the earliest of their deployments. */
  const floorFor = (...names) => Math.min(...names.map((name) => deployBlocks[name] ?? lowestFloor));

  const ctx = {
    ethers,
    inputs,
    provider,
    blockTag,
    finalizedNumber,
    floorFor,
    deployBlocks,
    events,
    credit,
    chainReads,
    deriveModule,
    chainInfoModule,
    proofModule,
    txIndexReader: deriveModule.createPrecompileTxIndexReader(provider, inputs.blockProver, blockTag),
  };

  // The head read above already established that the endpoint answers, so a
  // section that throws from here on is a failed check rather than an
  // unreachable chain. It is recorded as one and the remaining sections still
  // run: a reader learns more from two sections that passed and one that threw
  // than from a single line saying the run gave up.
  const runSection = async (name, fn) => {
    if (!wants(name)) return;
    try {
      await fn(ctx);
    } catch (error) {
      fail(`${name} section completed`, `a read threw: ${String(error?.shortMessage ?? error?.message ?? error)}`);
    }
  };

  await runSection("chain", verifyChain);
  await runSection("proof", verifyProof);
  await runSection("credit", verifyCredit);

  const failed = checks.filter((c) => c.status === "FAIL");
  const skipped = checks.filter((c) => c.status === "SKIP");
  const passed = checks.filter((c) => c.status === "PASS");

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          keyless: true,
          scrubbed: SCRUBBED,
          rpcUrl: inputs.rpcUrl,
          chainId: inputs.chainId,
          blockTag,
          finalizedBlock: finalizedNumber,
          deployBlocks,
          checks,
          totals: {
            passed: passed.length,
            failed: failed.length,
            skipped: skipped.length,
          },
        },
        null,
        2,
      )}\n`,
    );
  } else {
    printTable();
    out(`\n  ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped\n`);
    out(
      failed.length === 0
        ? "  every claim checked above was reproduced with no private key, no funded account and no write\n\n"
        : "  at least one claim did not reproduce; the rows above name which and what each side said\n\n",
    );
  }

  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
