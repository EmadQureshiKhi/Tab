/**
 * Live harness — the entrypoint.
 *
 * Runs the negative-path cases of design section 15.4 against the deployed contracts on CC3 Testnet
 * with real proof material, and records every outcome to `results.json` with the Creditcoin
 * transaction hash and the observed revert data.
 *
 * ## How this is gated
 *
 * Three separate things keep it out of anybody's default run:
 *
 *  1. **It is not a Foundry test.** Nothing here is Solidity, so `forge test` neither compiles nor
 *     runs it, and the default suite still spends nothing. That is also why the results file is
 *     written from a Node driver: `foundry.toml` grants `fs_permissions` read access to
 *     `./test/fixtures` and write access to nothing, so a Foundry test could not write this file
 *     without a configuration change.
 *  2. **No mode is the default.** Invoked bare it prints this surface and exits non-zero, so it
 *     cannot end up in a green pipeline by accident. The caller has to type `--preflight` or
 *     `--broadcast`.
 *  3. **Only `--broadcast` spends anything.** `--preflight` needs no key and no funded account: it
 *     puts the identical calldata to the identical deployment over `eth_call` and records the same
 *     revert data, for nothing.
 *
 * No package script and no workflow invokes it. Adding one is a decision somebody should make on
 * purpose, not a thing that happens because the file exists.
 *
 * ## Three shapes of case, and why the driver has to know the difference
 *
 * A mutation case and an unmutated-refusal case are self-contained: the driver finds genuine Mainnet
 * history matching the shape the case asked for and hands it over. Material of one kind is fetched
 * **once per run** and shared, because the Proof Builder call is the slow part and three cases want
 * the same Mainnet Transfer.
 *
 * A named-Settlement case is not self-contained. It needs a Source Chain transaction that somebody
 * created first - a Settlement the rail actually accepted - and until that exists the case cannot
 * run at all. Those are supplied by `--tx <caseId>=<hash>` or by a hand-off file, and a case whose
 * input is missing is **recorded as blocked and skipped**, never failed: "nobody has produced this
 * Settlement yet" and "the defence under test did not hold" are different facts and the file must
 * not conflate them. A blocked record carries the recipe for the transaction it wants and the exact
 * command to run once it exists.
 *
 * ## Command surface
 *
 *     pnpm tsx packages/contracts/test/live/run.mts --preflight
 *     pnpm tsx packages/contracts/test/live/run.mts --broadcast
 *     pnpm tsx packages/contracts/test/live/run.mts --list
 *     pnpm tsx packages/contracts/test/live/run.mts --preflight --case forged-merkle-root
 *     pnpm tsx packages/contracts/test/live/run.mts --broadcast --case replayed-settlement --tx replayed-settlement=0xabc…
 *
 * Prerequisite: `forge build` in `packages/contracts`, because the error dictionary and the calldata
 * encoding are both taken from the compiled artefacts rather than from signatures written by hand.
 *
 * Exit codes: 0 every case that ran met its expectation, 1 anything else. A blocked case does not
 * fail the run, because it did not run.
 *
 * Requirements: 27.3, 27.4, 27.5, 27.6, 27.7, 27.8, 27.9, 27.10, 27.11, 27.12
 */

import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve as resolvePath} from 'node:path';

import {Wallet} from 'ethers';

import {
  CONTRACTS_DIR,
  RESULTS_PATH,
  loadConfig,
  redactUrl,
  type LiveConfig,
} from './config.mjs';
import {SUBMISSION_GAS_LIMIT, makeProvider, readChainContext, submit} from './chain.mjs';
import {loadErrorDictionary} from './revert.mjs';
import {
  encodeSubmitSettlement,
  fetchProofMaterial,
  findMainnetRevertedTarget,
  findMainnetTransferTarget,
  findMainnetZeroTopicTarget,
  plainSourceTx,
  readAttestedFrontier,
  readChainKeys,
  targetFromSourceTx,
  type ChainKeys,
  type ProofMaterial,
  type SourceTarget,
} from './proof.mjs';
import {DeploymentReads, type Assertion} from './assertions.mjs';
import {CASES, verdictFor, type CaseContext, type LiveCase, type MaterialKind, type Material} from './cases.mjs';

const SCHEMA_VERSION = 2;

type Mode = 'preflight' | 'broadcast';

interface Options {
  readonly mode: Mode | null;
  readonly caseIds: readonly string[];
  readonly list: boolean;
  readonly help: boolean;
  /** Explicit `caseId -> Source Chain transaction hash` overrides from the command line. */
  readonly namedTx: ReadonlyMap<string, string>;
  /** A JSON file mapping hand-off keys to hashes, for the cases that need a Settlement. */
  readonly handoffPath: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  let mode: Mode | null = null;
  let list = false;
  let help = false;
  let handoffPath: string | null = null;
  const caseIds: string[] = [];
  const namedTx = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--preflight':
        mode = 'preflight';
        break;
      case '--broadcast':
        mode = 'broadcast';
        break;
      case '--list':
        list = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      case '--case': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new Error('`--case` needs a case identifier. Run with `--list` to see them.');
        }
        for (const id of value.split(',')) if (id.trim().length > 0) caseIds.push(id.trim());
        i += 1;
        break;
      }
      case '--tx': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new Error('`--tx` needs `<caseId>=<sourceTxHash>`.');
        }
        const eq = value.indexOf('=');
        if (eq <= 0) throw new Error(`\`--tx ${value}\` is not of the form <caseId>=<sourceTxHash>.`);
        namedTx.set(value.slice(0, eq).trim(), value.slice(eq + 1).trim());
        i += 1;
        break;
      }
      case '--handoff': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new Error('`--handoff` needs a path to a JSON file of hand-off keys.');
        }
        handoffPath = value.trim();
        i += 1;
        break;
      }
      default:
        throw new Error(`unrecognised argument \`${flag}\`. Run with \`--help\` for the command surface.`);
    }
  }
  return {mode, caseIds, list, help, namedTx, handoffPath};
}

function usage(): void {
  console.log(
    [
      'Tab live negative-path harness — runs against the deployed contracts on CC3 Testnet.',
      '',
      '  --preflight              keyless. No key, no funded account, no gas. Records the same',
      '                           revert data over eth_call.',
      '  --broadcast              sends real transactions and spends real testnet CTC. Needs a',
      '                           signing key in the environment.',
      '  --case <id[,id]>         run a subset. Unrun cases keep their previous recorded result.',
      '  --tx <caseId>=<hash>     the Source Chain transaction a named-Settlement case should use.',
      '  --handoff <path>         a JSON file mapping hand-off keys to Source Chain transactions,',
      '                           for the cases that need a Settlement somebody else created.',
      '  --list                   print the registered cases and stop.',
      '',
      'There is no default mode, deliberately: this suite touches a live chain, and under',
      '--broadcast it spends money, so it will not run unless a mode is typed. Nothing in the',
      'default `forge test` run reaches it, and no package script or workflow invokes it.',
      '',
      'A case needing a Settlement nobody has produced yet is recorded as blocked and skipped. It',
      'does not fail the run, because it did not run.',
      '',
      `Every outcome is recorded to ${RESULTS_PATH}.`,
      '',
      'Prerequisite: `forge build` in packages/contracts.',
      '',
      'Exit codes: 0 every case that ran met its expectation, 1 anything else.',
    ].join('\n'),
  );
}

/** The commit the run was made from, so a recorded result is attributable to a tree. */
function headCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: CONTRACTS_DIR,
      encoding: 'utf8',
      // A tree with no commits yet is an ordinary state for this to be run from, so git's complaint
      // about it is discarded rather than printed over the run's own output.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** The deployed contract's own ABI, for encoding the submission. */
function loadVerifierAbi(): unknown[] {
  const path = resolvePath(CONTRACTS_DIR, 'out', 'SettlementVerifier.sol', 'SettlementVerifier.json');
  if (!existsSync(path)) {
    throw new Error('out/SettlementVerifier.sol/SettlementVerifier.json is absent. Run `forge build` in packages/contracts first.');
  }
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as {abi?: unknown[]};
  if (!Array.isArray(artifact.abi)) throw new Error('the SettlementVerifier artefact carries no ABI.');
  return artifact.abi;
}

interface ResultsDocument {
  $comment?: unknown;
  schemaVersion?: number;
  lastRun?: unknown;
  cases?: Record<string, unknown>;
}

/**
 * Read whatever is already recorded.
 *
 * Results merge by case identity rather than replacing the file, because the cases cannot all be run
 * in one sitting: some wait on Ethereum attestation, which is roughly a quarter of an hour, and
 * others need a Source Chain transaction created first. A run of one case must not erase the
 * evidence for the others.
 */
function readExisting(): ResultsDocument {
  if (!existsSync(RESULTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(RESULTS_PATH, 'utf8')) as ResultsDocument;
  } catch {
    return {};
  }
}

const RESULTS_PREAMBLE = [
  'Live negative-path results for Tab, produced by test/live/run.mts against the deployed',
  'contracts on Creditcoin CC3 Testnet with proof material from the Proof Builder.',
  '',
  'Every case records the raw revert returndata alongside the decoded custom error. The bytes are',
  'the evidence and the decoding is a convenience: anybody holding this file can decode them again',
  'against the ABI in out/ and check the harness rather than trust it.',
  '',
  'Records merge by case identifier. A run of one case leaves the other records untouched, so this',
  'file accumulates rather than being rewritten, and lastRun describes only the most recent run.',
  '',
  'A case recorded as blocked has not run: it needs a Source Chain Settlement that did not exist',
  'when the run was made. Its record carries the recipe and the command to run once one does.',
  '',
  'Reproduce a case with no key, no funded account, and no gas, from the repository root:',
  '  pnpm tsx packages/contracts/test/live/run.mts --preflight --case <id>',
];

/** Serialise with LF endings, a trailing newline, and no bigint anywhere. */
function writeResults(document: ResultsDocument): void {
  const json = JSON.stringify(
    document,
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  );
  writeFileSync(RESULTS_PATH, `${json.replace(/\r\n/g, '\n')}\n`, 'utf8');
}

function networkRecord(config: LiveConfig): Record<string, unknown> {
  return {
    network: config.deploymentRecord.network,
    chainId: config.creditcoinChainId,
    rpcUrl: redactUrl(config.creditcoinRpcUrl),
    settlementVerifier: config.settlementVerifier,
    blockProverPrecompile: config.blockProverPrecompile,
    proofBuilder: redactUrl(config.proofBuilderUrl),
    addressSource: 'the environment, checked against deployments.json before the run started',
    agreesWithDeploymentRecord: config.deploymentRecord.agreesWithEnvironment,
  };
}

// ------------------------------------------------------------------------------- named-tx hand-off

/** One Source Chain transaction a named case can be built from. */
interface NamedInput {
  readonly sourceTxHash: string;
  readonly chainKey: number | null;
  readonly origin: string;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Pull a Source Chain transaction out of a hand-off entry.
 *
 * Two shapes are accepted because both are natural for whoever writes the file: a bare hash string,
 * and an object carrying `sourceTxHash` and optionally the `chainKey` it belongs to. A `null` entry
 * is the honest way to say "not produced yet" and is read as absent rather than as an error.
 */
function readHandoffEntry(value: unknown, origin: string): NamedInput | null {
  if (typeof value === 'string') {
    return HASH.test(value.trim()) ? {sourceTxHash: value.trim(), chainKey: null, origin} : null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as {sourceTxHash?: unknown; chainKey?: unknown};
  const hash = typeof entry.sourceTxHash === 'string' ? entry.sourceTxHash.trim() : '';
  if (!HASH.test(hash)) return null;
  const chainKey = typeof entry.chainKey === 'number' && Number.isInteger(entry.chainKey) ? entry.chainKey : null;
  return {sourceTxHash: hash, chainKey, origin};
}

/** The hand-off file, read once, or an empty map when none was given. */
function loadHandoff(path: string | null): ReadonlyMap<string, NamedInput> {
  const resolved = new Map<string, NamedInput>();
  if (path === null) return resolved;
  const full = resolvePath(process.cwd(), path);
  if (!existsSync(full)) {
    throw new Error(`the hand-off file ${full} does not exist. Drop the --handoff flag to run without it.`);
  }
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`the hand-off file ${full} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const [key, value] of Object.entries(document)) {
    const entry = readHandoffEntry(value, `hand-off file ${path}, key ${key}`);
    if (entry !== null) resolved.set(key, entry);
  }
  return resolved;
}

/**
 * The transaction a named case should use, from the command line first and the hand-off file second.
 *
 * The command line wins so a single case can be pointed at a fresh Settlement without editing a file,
 * which is what the reruns during a live session actually need.
 */
function inputFor(entry: LiveCase, options: Options, handoff: ReadonlyMap<string, NamedInput>): NamedInput | null {
  const explicit = options.namedTx.get(entry.id);
  if (explicit !== undefined) {
    if (!HASH.test(explicit)) throw new Error(`\`--tx ${entry.id}=${explicit}\` is not a 32-byte transaction hash.`);
    return {sourceTxHash: explicit, chainKey: null, origin: `--tx ${entry.id}`};
  }
  if (entry.input === null) return null;
  return handoff.get(entry.input.handoffKey) ?? null;
}

// ---------------------------------------------------------------------------------------- the run

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    usage();
    return 0;
  }
  if (options.list) {
    console.log(`${CASES.length} registered case(s):\n`);
    for (const entry of CASES) {
      console.log(`  ${entry.id}`);
      console.log(`      ${entry.title} — requirements ${entry.requirements.join(', ')}`);
      console.log(
        `      expects ${entry.expected === 'acceptance' ? 'acceptance' : `one of: ${entry.expectedRefusals.join(', ')}`}`,
      );
      if (entry.input !== null) console.log(`      needs a Settlement: ${entry.input.recipe}`);
    }
    return 0;
  }
  if (options.mode === null) {
    usage();
    console.error('\nlive: no mode given, so nothing ran. Type --preflight or --broadcast.');
    return 1;
  }

  const selected =
    options.caseIds.length === 0 ? CASES : CASES.filter((entry) => options.caseIds.includes(entry.id));
  if (selected.length === 0) {
    throw new Error(`no registered case matches ${options.caseIds.join(', ')}. Run with --list.`);
  }

  const startedAt = new Date().toISOString();
  const config = loadConfig();
  const dictionary = loadErrorDictionary();
  const verifierAbi = loadVerifierAbi();
  const handoff = loadHandoff(options.handoffPath);

  const creditcoin = makeProvider(config.creditcoinRpcUrl, config.creditcoinChainId);
  let signer: Wallet | null = null;
  if (options.mode === 'broadcast') {
    if (config.submitterKey === null) {
      throw new Error(
        '--broadcast needs a signing key. Set WATCHER_PRIVATE_KEY to a funded CC3 Testnet account, or run --preflight, which needs no key at all.',
      );
    }
    signer = new Wallet(config.submitterKey, creditcoin);
  }

  try {
    const context = await readChainContext(creditcoin, config, signer);
    console.log(
      `live: ${config.deploymentRecord.network}, chain ${context.chainId}, block ${context.blockNumber}. ` +
        `Verifier ${config.settlementVerifier} holds ${context.settlementVerifierCodeBytes} bytes of code.`,
    );
    if (signer !== null) {
      console.log(`live: submitting from ${context.submitter}, balance ${context.submitterBalanceCtc} CTC.`);
    } else {
      console.log('live: preflight mode. No key, no transaction, nothing spent.');
    }

    const chainKeys = await readChainKeys(creditcoin, config);
    const frontiers = new Map<number, number>();
    for (const chainKey of [chainKeys.mainnet, chainKeys.sepolia]) {
      const frontier = await readAttestedFrontier(creditcoin, chainKey);
      if (!frontier.exists) {
        console.log(`live: chainKey ${chainKey} reports no attestation, so cases needing it cannot run.`);
        continue;
      }
      frontiers.set(chainKey, frontier.height);
      console.log(`live: attested frontier for chainKey ${chainKey} is height ${frontier.height}.`);
    }
    const mainnetFrontier = frontiers.get(chainKeys.mainnet);
    if (mainnetFrontier === undefined) {
      throw new Error(`the ChainInfo Precompile reports no attestation for chainKey ${chainKeys.mainnet}.`);
    }

    const reads = new DeploymentReads(creditcoin, config, verifierAbi);

    // Material of a Mainnet kind is fetched once and shared: three cases want the same Transfer, and
    // the Proof Builder round trip is the slow part of a run. Named material is never cached, because
    // a Continuity Proof perishes as attestations age onto the coarser checkpoint grid and a proof
    // reused across a long gap reverts where a fresh one verifies.
    const mainnetCache = new Map<MaterialKind, Material>();
    let pendingNamed: NamedInput | null = null;

    async function materialFor(kind: MaterialKind, caseId: string): Promise<Material> {
      if (kind === 'named-source-tx') {
        if (pendingNamed === null) {
          throw new Error(`case ${caseId} asked for a named Source Chain transaction and none was supplied.`);
        }
        const chainKey = pendingNamed.chainKey ?? chainKeys.sepolia;
        const frontier = frontiers.get(chainKey);
        if (frontier === undefined) {
          throw new Error(`chainKey ${chainKey} is not attesting, so ${pendingNamed.sourceTxHash} cannot be proven yet.`);
        }
        const target = await targetFromSourceTx(config, chainKeys, chainKey, pendingNamed.sourceTxHash, frontier);
        const material = await fetchProofMaterial(config, target);
        return {target, material};
      }

      const cached = mainnetCache.get(kind);
      if (cached !== undefined) return cached;
      const target =
        kind === 'mainnet-reverted'
          ? await findMainnetRevertedTarget(config, chainKeys, mainnetFrontier)
          : kind === 'mainnet-zero-topic'
            ? await findMainnetZeroTopicTarget(config, chainKeys, mainnetFrontier)
            : await findMainnetTransferTarget(config, chainKeys, mainnetFrontier);
      console.log(
        `live:   material (${kind}) ${target.sourceTxHash} at height ${target.blockHeight}, ` +
          `index ${target.txIndexFromSourceRpc}, ${target.receiptLogCount} log(s).`,
      );
      const material = await fetchProofMaterial(config, target);
      if (material.txIndexFromProofBuilder !== target.txIndexFromSourceRpc) {
        throw new Error(
          `the Proof Builder reports transaction index ${material.txIndexFromProofBuilder} where the Source Chain reports ${target.txIndexFromSourceRpc}. The material does not belong to the target, so no case built on it would mean anything.`,
        );
      }
      const resolved: Material = {target, material};
      mainnetCache.set(kind, resolved);
      return resolved;
    }

    const caseContext: CaseContext = {
      config,
      creditcoin,
      chainKeys,
      dictionary,
      reads,
      material: materialFor,
    };

    const existing = readExisting();
    const records: Record<string, unknown> = {...(existing.cases ?? {})};
    let feeSpentWei = 0n;
    let transactionsSent = 0;
    let allAsExpected = true;
    const ran: string[] = [];
    const blocked: string[] = [];

    for (const entry of selected) {
      console.log(`\nlive: ${entry.id} — ${entry.title}`);

      // A named case with no Settlement to point at is blocked, not failed. The distinction is the
      // whole reason this branch exists: a file that recorded "did not hold" for a case nobody could
      // run yet would be evidence of a defect that does not exist.
      if (entry.material === 'named-source-tx') {
        const input = inputFor(entry, options, handoff);
        if (input === null) {
          blocked.push(entry.id);
          console.log(
            `live:   blocked - no Source Chain Settlement supplied. Needs: ${entry.input?.recipe ?? 'a Settlement'}`,
          );
          records[entry.id] = {
            id: entry.id,
            title: entry.title,
            requirements: entry.requirements,
            expectation: entry.expectation,
            expectedRefusals: entry.expectedRefusals,
            recordedAt: new Date().toISOString(),
            mode: options.mode,
            status: 'blocked',
            blocked: {
              reason: 'this case needs a Source Chain Settlement that did not exist when the run was made',
              needs: entry.input?.recipe ?? null,
              handoffKey: entry.input?.handoffKey ?? null,
              runItWith: `pnpm tsx packages/contracts/test/live/run.mts --${options.mode} --case ${entry.id} --tx ${entry.id}=<sourceTxHash>`,
            },
          };
          continue;
        }
        pendingNamed = input;
        console.log(`live:   material from ${input.origin}: ${input.sourceTxHash}`);
      }

      let prepared;
      try {
        prepared = await entry.prepare(caseContext);
      } catch (error) {
        // A preparation failure is the harness or its inputs, never the defence under test, so it is
        // recorded as inconclusive rather than as a refusal the deployment produced.
        allAsExpected = false;
        const message = error instanceof Error ? error.message : String(error);
        console.log(`live:   inconclusive - material could not be prepared: ${message}`);
        records[entry.id] = {
          id: entry.id,
          title: entry.title,
          requirements: entry.requirements,
          expectation: entry.expectation,
          recordedAt: new Date().toISOString(),
          mode: options.mode,
          status: 'inconclusive',
          error: message,
        };
        continue;
      } finally {
        pendingNamed = null;
      }

      ran.push(entry.id);
      console.log(
        `live:   keyless control — genuine material verifies: ${prepared.controls.genuineMaterial.verified}, ` +
          `as submitted: ${prepared.controls.asSubmitted.verified}` +
          `${prepared.controls.asSubmitted.reverted ? ' (the precompile reverted)' : ''}`,
      );

      const calldata = encodeSubmitSettlement(verifierAbi, prepared.sourceTx);
      const outcome = await submit(creditcoin, config, signer, calldata, dictionary);
      const verdict = verdictFor(entry, outcome);
      if (outcome.onChain !== null) transactionsSent += 1;
      if (outcome.onChain?.feeSpentWei != null) feeSpentWei += BigInt(outcome.onChain.feeSpentWei);

      if (outcome.onChain !== null) {
        console.log(
          `live:   transaction ${outcome.onChain.transactionHash} in block ${outcome.onChain.blockNumber}, ` +
            `status ${outcome.onChain.status}, gas ${outcome.onChain.gasUsed} of ${outcome.onChain.gasLimit}.`,
        );
        console.log(`live:   revert data ${outcome.onChain.revertData?.raw ?? 'none'}`);
      }
      console.log(`live:   ${verdict.outcome}: ${verdict.note}`);

      // An acceptance case is settled by what it can read back off the chain, not by a status code.
      let assertions: readonly Assertion[] | null = null;
      let assertionsHold = true;
      if (entry.assert !== undefined) {
        assertions = await entry.assert(caseContext, prepared, outcome);
        assertionsHold = assertions.every((claim) => claim.holds);
        for (const claim of assertions) {
          console.log(`live:   ${claim.holds ? 'holds' : 'FAILS'} - ${claim.claim}`);
          console.log(`live:            ${claim.evidence}`);
        }
      }
      if (!verdict.matchesExpectation || !assertionsHold) allAsExpected = false;

      records[entry.id] = {
        id: entry.id,
        title: entry.title,
        requirements: entry.requirements,
        expectation: entry.expectation,
        expected: entry.expected,
        expectedRefusals: entry.expectedRefusals,
        recordedAt: new Date().toISOString(),
        mode: options.mode,
        status: 'ran',
        target: prepared.target,
        proofMaterial: {
          source: prepared.material.builderEndpoint,
          txIndexFromProofBuilder: prepared.material.txIndexFromProofBuilder,
          cached: prepared.material.cached,
          generatedAt: prepared.material.generatedAt,
        },
        mutation: prepared.mutation,
        keylessControls: prepared.controls,
        expectedIngestions: prepared.expectedIngestions,
        stateBefore: prepared.before,
        submitted: plainSourceTx(prepared.sourceTx),
        submission: outcome.submission,
        keylessPreflight: outcome.preflight,
        onChain: outcome.onChain,
        verdict,
        assertions,
        assertionsHold: assertions === null ? null : assertionsHold,
      };
    }

    const document: ResultsDocument = {
      $comment: RESULTS_PREAMBLE,
      schemaVersion: SCHEMA_VERSION,
      lastRun: {
        startedAt,
        finishedAt: new Date().toISOString(),
        mode: options.mode,
        commit: headCommit(),
        casesRun: ran,
        casesBlocked: blocked,
        registeredCases: CASES.map((entry) => entry.id),
        network: networkRecord(config),
        chainContext: context,
        gasLimitPerSubmission: SUBMISSION_GAS_LIMIT.toString(),
        errorDictionary: {
          knownErrors: dictionary.errorCount,
          assembledFrom: dictionary.sources,
          builtins: ['Error(string)', 'Panic(uint256)'],
        },
        spend: {
          transactionsSent,
          feeSpentWei: feeSpentWei.toString(),
          note:
            transactionsSent > 0
              ? 'Testnet CTC, spent by this run alone. A refused submission unwinds and refunds the unused gas.'
              : 'Nothing was spent. Preflight mode holds no key and sends no transaction.',
        },
      },
      cases: records,
    };
    writeResults(document);
    console.log(
      `\nlive: recorded ${ran.length} case(s) to ${RESULTS_PATH}` +
        `${blocked.length > 0 ? `, ${blocked.length} blocked: ${blocked.join(', ')}` : ''}.`,
    );
    if (transactionsSent > 0) {
      console.log(`live: spent ${feeSpentWei} wei of testnet CTC across ${transactionsSent} transaction(s).`);
    }

    return allAsExpected ? 0 : 1;
  } finally {
    creditcoin.destroy();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`\nlive: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
