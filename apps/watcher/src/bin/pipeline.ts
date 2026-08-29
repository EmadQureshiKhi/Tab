/**
 * `pnpm --filter @tabai/watcher pipeline`
 *
 * One pass of the whole rail, in the order design section 8 lays it out:
 *
 *   discover -> observe -> clear -> attest -> prove -> plan -> submit -> reconcile
 *
 * `observe.ts` runs the first three stages and stops. This runs all eight, so a
 * Settlement observed at the top of a pass can be a Verified Settlement by the
 * bottom of it, and the stages that were only ever exercised by their own tests
 * are exercised against each other.
 *
 * ## Read-only unless told otherwise, and the flags are separate for a reason
 *
 * Three costs, three flags, because they are not the same cost:
 *
 *   --persist   writes rows and moves the read cursor. Costs a database.
 *   --clear     applies Provisional Clearings. Costs CTC and pledges a Service's
 *               Bond, which is somebody else's money.
 *   --submit    submits proofs. Costs CTC, and is the step that actually reduces
 *               an Open Tab.
 *
 * With none of them the pass reads every chain, simulates every submission
 * keylessly, and prints exactly what it would have done. That is the mode to run
 * first and the mode this file defaults to.
 *
 * ## Nothing is broadcast that was not simulated
 *
 * Every submission is replayed over `eth_call` from the Watcher's own address
 * before a key is written or a transaction is signed, so a batch that would revert
 * costs nothing and, more usefully, names the member that would have caused it.
 * That is the whole reason Requirement 9 chose sequential `verifyAndEmit` calls
 * over the array-shaped overload.
 *
 * ## The proof stage refuses to spend on material it has not folded itself
 *
 * `sourceVerifiedProofMaterial` asks the Proof Builder API, falls back to the
 * independent `RawProofBuilder` on error or timeout, re-derives the Merkle root
 * locally from the encoded transaction and the sibling path, and cross-checks the
 * derived transaction index against `calculateTxIndex` read from the precompile. A
 * root mismatch withholds; both builders disagreeing halts. Only a match reaches
 * the planner.
 *
 * Exit codes: 0 the pass completed, 1 it stopped short or something halted, 2 it
 * could not start.
 */

import { Wallet } from "ethers";

import { err, ok, type ChainKey } from "@tabai/shared";
import type { JsonRpcProvider } from "ethers";

import { createAgentRegistryReader, requireAgentRegistry } from "../agent-registry.js";
import { waitUntilHeightAttested } from "../attestation.js";
import { planBatches, describePlan } from "../batch.js";
import { createPrecompileChainInfoReader } from "../chain-info.js";
import {
  createAttestationReader,
  createSourceChainReader,
  createTabBookClient,
  requireServiceRegistry,
  requireTabBook,
  sweepClearings,
  sweepReversals,
} from "../clearing.js";
import { loadWatcherConfig } from "../config.js";
import { createPrecompileTxIndexReader } from "../derive.js";
import { describeDiscovery, discoverChains, monitoredChainKeys } from "../discovery.js";
import {
  createEndpointRotation,
  createRotatingProviders,
  createRotationState,
  type EndpointRotation,
  type RotatingProviders,
} from "../endpoints.js";
import { activeEndpointOf, createEndpointStore, loadEndpointHealth } from "../db/endpoint-store.js";
import {
  createServiceRegistryReader,
  createReceiptLogReader,
  createSourceLogReader,
  describeTargets,
  resolveWatchTargets,
  scanChain,
  type WatchTarget,
} from "../observation.js";
import {
  createProofBuilderApiSource,
  sourceVerifiedProofMaterial,
  type ProofMaterial,
} from "../proof.js";
import { createRawProofBuilder } from "../raw-builder.js";
import { proofQueueOf } from "../state.js";
import { CREDITCOIN_BLOCK_TAG, createJsonRpcProvider, readCreditcoinTip } from "../rpc.js";
import {
  createSettlementVerifierClient,
  reconcileSubmitted,
  submitBatch,
  type SubmissionMember,
} from "../submission.js";
import { createDb, requireDatabaseUrl } from "../db/client.js";
import { loadPersistedFrontiers } from "../db/discovery-store.js";
import {
  advanceCursor,
  countByState,
  loadClearingCandidates,
  loadProofCandidates,
  loadReversalCandidates,
  loadReadCursors,
  loadSubmissionCandidates,
  loadSubmittedRows,
  type PendingSettlement,
  markSubmitted,
  recordClearingOutcome,
  recordClearingState,
  recordObservations,
  recordSubmissionOutcome,
} from "../db/observation-store.js";

/** `JSON.stringify` cannot serialise a bigint, and every height here is one. */
const jsonSafe = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

/** How far back a cold start reaches when no cursor exists yet. */
const DEFAULT_COLD_START_BLOCKS = 500n;

function numericFlag(name: string): bigint | undefined {
  const at = process.argv.indexOf(name);
  if (at === -1) return undefined;
  const raw = process.argv[at + 1];
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  return BigInt(raw);
}

async function main(): Promise<number> {
  const submit = process.argv.includes("--submit");
  const clear = process.argv.includes("--clear");
  // Both writes imply persistence: a clearing or a submission whose outcome is not
  // written is a transaction the next pass repeats.
  const persist = submit || clear || process.argv.includes("--persist");
  const coldStartBlocks = numericFlag("--blocks") ?? DEFAULT_COLD_START_BLOCKS;
  const fromOverride = numericFlag("--from");

  const config = loadWatcherConfig();
  if (!config.ok) {
    console.error(`pipeline: ${config.error.code}: ${config.error.message}`);
    return 2;
  }

  const registryAddress = requireServiceRegistry(config.value);
  if (!registryAddress.ok) {
    console.error(`pipeline: ${registryAddress.error.code}: ${registryAddress.error.message}`);
    return 2;
  }
  const tabBookAddress = requireTabBook(config.value);
  if (!tabBookAddress.ok) {
    console.error(`pipeline: ${tabBookAddress.error.code}: ${tabBookAddress.error.message}`);
    return 2;
  }
  const agentRegistryAddress = requireAgentRegistry(config.value);
  if (!agentRegistryAddress.ok) {
    console.error(`pipeline: ${agentRegistryAddress.error.code}: ${agentRegistryAddress.error.message}`);
    return 2;
  }
  const verifierAddress = process.env.SETTLEMENT_VERIFIER_ADDRESS?.trim();
  if (verifierAddress === undefined || !/^0x[0-9a-fA-F]{40}$/.test(verifierAddress)) {
    console.error("pipeline: SETTLEMENT_VERIFIER_ADDRESS is unset or not an address");
    return 2;
  }

  if (submit && config.value.watcher.privateKey === undefined) {
    console.error("pipeline: WATCHER_KEY_MISSING: --submit needs WATCHER_PRIVATE_KEY");
    return 2;
  }

  const creditcoin = createJsonRpcProvider(
    config.value.creditcoin.rpcUrl,
    config.value.creditcoin.chainId,
    config.value.rpcBatchMaxCount,
  );
  const sourceProviders: Partial<Record<ChainKey, JsonRpcProvider>> = {};
  // Hoisted beside the providers they own, because the cleanup in `finally` has to
  // reach them however the run ends.
  const rotations = new Map<ChainKey, EndpointRotation>();
  const rotatingProviders = new Map<ChainKey, RotatingProviders>();
  let db: ReturnType<typeof createDb> | undefined;
  const stages: Record<string, unknown> = {};

  try {
    const tip = await readCreditcoinTip(creditcoin);
    if (!tip.ok) {
      console.error(`pipeline: ${tip.error.code}: ${tip.error.message}`);
      return 2;
    }
    stages["creditcoin"] = { ...tip.value, blockTag: CREDITCOIN_BLOCK_TAG };

    if (persist) {
      const databaseUrl = requireDatabaseUrl(config.value);
      if (!databaseUrl.ok) {
        console.error(`pipeline: ${databaseUrl.error.code}: ${databaseUrl.error.message}`);
        return 2;
      }
      db = createDb(databaseUrl.value);
    }

    // ---------------------------------------------------------------- 1. discover
    const chainInfo = createPrecompileChainInfoReader(
      creditcoin,
      config.value.creditcoin.chainInfoPrecompile,
      CREDITCOIN_BLOCK_TAG,
    );
    const frontiers = db === undefined ? undefined : await loadPersistedFrontiers(db.db);
    const discovery = await discoverChains(chainInfo, config.value, {
      ...(frontiers?.ok === true ? { previousFrontiers: frontiers.value } : {}),
    });
    if (!discovery.ok) {
      console.error(`pipeline: ${discovery.error.code}: ${discovery.error.message}`);
      return 2;
    }
    console.error(`pipeline: ${describeDiscovery(discovery.value)}`);
    stages["discovery"] = discovery.value.monitored.map((chain) => ({
      chainKey: chain.chainKey,
      attestedHeight: chain.attestedHeight,
    }));

    // One rotation per chain, resumed from `endpoint_health` so a restart does not
    // begin again on an endpoint the last run had already given up on (R20.11).
    const persistedEndpoints =
      db === undefined ? undefined : await loadEndpointHealth(db.db);
    for (const chain of discovery.value.monitored) {
      if (chain.endpoints.length === 0) continue;
      const resumed =
        persistedEndpoints?.ok === true
          ? activeEndpointOf(persistedEndpoints.value, chain.chainKey)
          : undefined;
      const initial = createRotationState(
        chain.chainKey,
        chain.endpoints,
        config.value.endpointFailureThreshold,
        resumed?.url,
        resumed?.failures ?? 0,
      );
      if (!initial.ok) {
        console.error(`pipeline: ${initial.error.code}: ${initial.error.message}`);
        continue;
      }
      const rotation = createEndpointRotation(
        initial.value,
        db === undefined ? undefined : createEndpointStore(db.db),
      );
      const providers = createRotatingProviders(rotation, chain.evmChainId, config.value.rpcBatchMaxCount);
      rotations.set(chain.chainKey, rotation);
      rotatingProviders.set(chain.chainKey, providers);
      sourceProviders[chain.chainKey] = providers.provider();
      if (resumed !== undefined && resumed.url !== chain.endpoints[0]) {
        console.error(
          `pipeline: chainKey ${chain.chainKey} resumed on ${resumed.url} rather than the first configured endpoint, with ${resumed.failures} failure(s) already against it`,
        );
      }
    }

    const registry = createServiceRegistryReader(creditcoin, registryAddress.value, CREDITCOIN_BLOCK_TAG);
    const resolution = await resolveWatchTargets(
      registry,
      config.value,
      monitoredChainKeys(discovery.value),
    );
    if (!resolution.ok) {
      console.error(`pipeline: ${resolution.error.code}: ${resolution.error.message}`);
      return 2;
    }
    console.error(`pipeline: ${describeTargets(resolution.value)}`);

    // ---------------------------------------------------------------- 2. observe
    const cursors = db === undefined ? undefined : await loadReadCursors(db.db);
    const scans = [];
    let stoppedShort = false;

    for (const chain of discovery.value.monitored) {
      const provider = sourceProviders[chain.chainKey];
      if (provider === undefined) continue;
      const targets: readonly WatchTarget[] = resolution.value.targets.filter(
        (target) => target.chainKey === chain.chainKey,
      );
      if (targets.length === 0) continue;

      const head = BigInt(await provider.getBlockNumber());
      const persisted =
        cursors?.ok === true
          ? cursors.value.find((entry) => entry.chainKey === chain.chainKey)?.lastProcessedBlock
          : undefined;
      const cold = head > coldStartBlocks ? head - coldStartBlocks : 0n;
      const lastProcessedBlock =
        fromOverride !== undefined ? fromOverride - 1n : persisted !== undefined && persisted > 0n ? persisted : cold;

      const rotation = rotations.get(chain.chainKey);
      const providers = rotatingProviders.get(chain.chainKey);
      const scan = await scanChain({
        chainKey: chain.chainKey,
        targets,
        lastProcessedBlock,
        head,
        window: config.value.logChunk,
        receipts: createReceiptLogReader(provider),
        reader: createSourceLogReader(provider),
        ...(rotation === undefined || providers === undefined
          ? {}
          : {
              endpointCount: rotation.endpoints.length,
              onFailure: () => rotation.noteFailure(),
              rotate: async () => {
                const before = rotation.active();
                if (!(await rotation.moveOn())) return undefined;
                // The rotating providers build lazily per URL, so this hands back a
                // provider for whatever endpoint is active now, and both readers are
                // rebuilt from it together.
                const next = providers.provider();
                sourceProviders[chain.chainKey] = next;
                console.error(
                  `pipeline: chainKey ${chain.chainKey} moved from ${before} to ${rotation.active()}`,
                );
                return {
                  reader: createSourceLogReader(next),
                  receipts: createReceiptLogReader(next),
                };
              },
            }),
        commit: async ({ chunk, observations }) => {
          if (db === undefined) return { ok: true, value: observations.length };
          const written = await recordObservations(db.db, observations);
          if (!written.ok) return written;
          const moved = await advanceCursor(db.db, chain.chainKey, chunk.to);
          if (!moved.ok) return moved;
          return { ok: true, value: written.value.inserted };
        },
      });
      if (!scan.ok) {
        console.error(`pipeline: ${scan.error.code}: ${scan.error.message}`);
        return 2;
      }
      if (scan.value.stopped !== undefined) {
        stoppedShort = true;
        console.error(
          `pipeline: chainKey ${chain.chainKey} stopped at ${scan.value.lastProcessedBlock}: ${scan.value.stopped.code}`,
        );
      }
      scans.push(scan.value);
    }
    stages["observation"] = scans;

    if (db === undefined) {
      // Everything below reads rows, and without persistence there are none. The
      // pass is still useful: it proved discovery, target resolution, and the scan.
      console.log(JSON.stringify({ mode: { persist, clear, submit }, ...stages }, jsonSafe, 2));
      return stoppedShort ? 1 : 0;
    }
    const handle = db;

    // ---------------------------------------------------------------- 3. clear
    const signer =
      (clear || submit) && config.value.watcher.privateKey !== undefined
        ? new Wallet(config.value.watcher.privateKey, creditcoin)
        : undefined;
    const signerAddress = signer === undefined ? undefined : await signer.getAddress();

    const tabBook = createTabBookClient(
      creditcoin,
      tabBookAddress.value,
      CREDITCOIN_BLOCK_TAG,
      ...(signer === undefined ? [] : ([signer] as const)),
    );
    const sourceReader = createSourceChainReader(sourceProviders);
    const agents = createAgentRegistryReader(creditcoin, agentRegistryAddress.value, CREDITCOIN_BLOCK_TAG);

    const clearingCandidates = await loadClearingCandidates(handle.db);
    if (!clearingCandidates.ok) {
      console.error(`pipeline: ${clearingCandidates.error.code}: ${clearingCandidates.error.message}`);
      return 2;
    }
    const sweep = await sweepClearings(
      {
        client: tabBook,
        source: sourceReader,
        agents,
        targets: resolution.value.targets,
        persist: (record) => recordClearingOutcome(handle.db, record),
        submit: clear,
        ...(signerAddress === undefined ? {} : { signerAddress }),
        ...(config.value.watcher.address === undefined ? {} : { watcherAddress: config.value.watcher.address }),
      },
      clearingCandidates.value,
    );
    if (!sweep.ok) {
      console.error(`pipeline: ${sweep.error.code}: ${sweep.error.message}`);
      return 2;
    }
    stages["clearing"] = sweep.value;

    // ------------------------------------------------- 3b. reverse expired clearings
    //
    // Permissionless by design, so this is the normal path and not the guarantee:
    // anybody may crank a clearing whose deadline passed unconfirmed, precisely so
    // that reversal liveness never depends on the Watcher that applied it and
    // therefore benefits from never reversing it (R15.5, R14.6).
    const reversalCandidates = await loadReversalCandidates(handle.db);
    if (!reversalCandidates.ok) {
      console.error(`pipeline: ${reversalCandidates.error.code}: ${reversalCandidates.error.message}`);
      return 2;
    }
    const reversals = await sweepReversals(
      {
        client: tabBook,
        persist: (replayKey, clearingState) => recordClearingState(handle.db, replayKey, clearingState),
        // Creditcoin's clock, because `TabBook` compares the deadline against
        // `block.timestamp` and a host clock that ran fast would crank early and pay
        // gas for a certain `ClearingNotExpired` revert.
        chainTimestamp: async () => {
          const block = await creditcoin.getBlock(CREDITCOIN_BLOCK_TAG);
          if (block === null) {
            return err({
              category: "UPSTREAM",
              code: "CREDITCOIN_BLOCK_UNAVAILABLE",
              message: `no block at ${String(CREDITCOIN_BLOCK_TAG)}, so the deadline cannot be compared`,
              retryable: true,
            });
          }
          return ok(block.timestamp);
        },
        submit: clear,
      },
      reversalCandidates.value,
    );
    if (!reversals.ok) {
      console.error(`pipeline: ${reversals.error.code}: ${reversals.error.message}`);
      return 2;
    }
    stages["reversal"] = reversals.value;

    // ------------------------------------------------- 4 and 5. attest and prove
    //
    // Rows sit in OBSERVED or PROVISIONAL until their block is attested and their
    // material folds locally; only then do they become READY, which is the state
    // the planner draws from. The attestation wait is a poll, so a row whose block
    // is not covered yet is left for the next pass rather than blocked on here.
    const proofApi = createProofBuilderApiSource();
    const txIndexReader = createPrecompileTxIndexReader(
      creditcoin,
      process.env.BLOCKPROVER_PRECOMPILE?.trim() ?? "0x0000000000000000000000000000000000000FD2",
      CREDITCOIN_BLOCK_TAG,
    );

    const proven: { member: SubmissionMember; chainKey: ChainKey; blockHeight: bigint; sourceTxHash: string }[] = [];
    const proofOutcomes = [];
    // Its own loader, not the clearing stage's. A row that already carries a
    // Provisional Clearing is excluded from clearing candidates on purpose, and it
    // is precisely a row that still needs proving: the clearing is Bond-covered and
    // revocable, and only the proof makes it a Verified Settlement.
    const pendingProof = await loadProofCandidates(handle.db, 25);

    // Rows that reached READY in an earlier pass rejoin here, before the proof
    // stage rather than after it, and they are re-sourced rather than trusted.
    // Both halves of that matter. A proof perishes as attestations age onto the
    // checkpoint grid, so material folded in a previous pass may no longer verify
    // and is not carried across a pass boundary. And a READY row that is only
    // counted, never re-proved, is stranded for good: measured on this deployment,
    // two rows sat READY through repeated passes while the planner reported no
    // plans, because `proven` was built from this pass's OBSERVED rows alone.
    const readyRows = await loadSubmissionCandidates(handle.db);
    const rejoining = readyRows.ok ? readyRows.value : [];

    // Attempt counts come from the row, so the backoff schedule continues rather
    // than restarting each time a row rejoins.
    const proofQueue = proofQueueOf<PendingSettlement, { readonly attempts: number }>(
      pendingProof.ok ? pendingProof.value : [],
      rejoining,
      (row) => row.replayKey,
    );

    {
      for (const { row, attempts: priorAttempts } of proofQueue) {
        const attested = await waitUntilHeightAttested(chainInfo, row.chainKey, row.blockHeight, {
          // One read, not a wait: this is a pass and not a daemon, so a block that
          // is not covered yet is next pass's business.
          timeoutMs: 0,
        });
        if (!attested.ok || attested.value.outcome !== "ATTESTED") {
          proofOutcomes.push({
            replayKey: row.replayKey,
            stage: "attestation",
            outcome: attested.ok ? attested.value.outcome : "UNREADABLE",
          });
          continue;
        }

        const provider = sourceProviders[row.chainKey];
        const chain = discovery.value.monitored.find((entry) => entry.chainKey === row.chainKey);
        const fallback =
          provider === undefined || chain === undefined
            ? undefined
            : createRawProofBuilder({
                chainKey: row.chainKey,
                sourceProvider: provider,
                creditcoinProvider: creditcoin,
                chainInfoPrecompile: config.value.creditcoin.chainInfoPrecompile,
                chainEncoding: chain.chainEncoding,
              });

        const sourced = await sourceVerifiedProofMaterial({
          chainKey: row.chainKey,
          sourceTxHash: row.sourceTxHash,
          primary: proofApi,
          txIndexReader,
          ...(fallback?.ok === true ? { fallback: fallback.value } : {}),
        });
        proofOutcomes.push({
          replayKey: row.replayKey,
          stage: "proof",
          outcome: sourced.nextState,
          attempts: sourced.attempts.map((attempt) => attempt.detail),
        });
        if (sourced.nextState !== "READY" || sourced.material === undefined) continue;

        proven.push({
          member: {
            replayKey: row.replayKey,
            material: sourced.material as ProofMaterial,
            attempts: priorAttempts,
          },
          chainKey: row.chainKey,
          blockHeight: row.blockHeight,
          sourceTxHash: row.sourceTxHash,
        });
      }
    }

    stages["proof"] = { attempted: proofQueue.length, outcomes: proofOutcomes, alreadyReady: rejoining.length };

    // ---------------------------------------------------------------- 6. plan
    const attestationReader = createAttestationReader(
      creditcoin,
      config.value.creditcoin.chainInfoPrecompile,
      CREDITCOIN_BLOCK_TAG,
    );
    const planning = await planBatches(
      proven.map((entry) => ({
        replayKey: entry.member.replayKey,
        chainKey: entry.chainKey,
        blockHeight: entry.blockHeight,
        sourceTxHash: entry.sourceTxHash,
      })),
      { maxProofs: config.value.batch.maxProofs, maxSpan: config.value.batch.maxSpan },
      attestationReader,
    );
    if (!planning.ok) {
      console.error(`pipeline: ${planning.error.code}: ${planning.error.message}`);
      return 2;
    }
    for (const plan of planning.value.plans) console.error(`pipeline: ${describePlan(plan)}`);
    stages["planning"] = {
      plans: planning.value.plans.map(describePlan),
      deferred: planning.value.deferred.map((entry) => ({
        replayKey: entry.candidate.replayKey,
        reason: entry.reason,
      })),
    };

    // ---------------------------------------------------------------- 7. submit
    const verifier = createSettlementVerifierClient(
      creditcoin,
      verifierAddress,
      CREDITCOIN_BLOCK_TAG,
      ...(signer === undefined ? [] : ([signer] as const)),
    );
    const from = signerAddress ?? config.value.watcher.address ?? `0x${"00".repeat(20)}`;
    const reports = [];
    let halted = false;

    for (const plan of planning.value.plans) {
      const members = plan.members
        .map((candidate) => proven.find((entry) => entry.member.replayKey === candidate.replayKey)?.member)
        .filter((entry): entry is SubmissionMember => entry !== undefined);
      if (members.length === 0) continue;

      const report = await submitBatch(
        {
          client: verifier,
          from,
          submit,
          markSubmitted: (keys) => markSubmitted(handle.db, keys),
          recordOutcome: (record) => recordSubmissionOutcome(handle.db, record),
        },
        members,
      );
      if (!report.ok) {
        console.error(`pipeline: ${report.error.code}: ${report.error.message}`);
        return 2;
      }
      if (report.value.halted) halted = true;
      reports.push({
        plan: describePlan(plan),
        confirmed: report.value.confirmed,
        txHashes: report.value.txHashes,
        members: report.value.members.map((entry) => ({
          replayKey: entry.replayKey,
          state: entry.state,
          action: entry.action,
          detail: entry.detail,
        })),
      });
    }
    stages["submission"] = reports;

    // ---------------------------------------------------------------- 8. reconcile
    const submitted = await loadSubmittedRows(handle.db);
    if (submitted.ok && submitted.value.length > 0) {
      const reconciled = await reconcileSubmitted(
        verifier,
        submitted.value,
        (record) => recordSubmissionOutcome(handle.db, record),
        !persist,
      );
      stages["reconciliation"] = reconciled;
    }

    const counts = await countByState(handle.db);
    stages["states"] = counts.ok ? counts.value : undefined;

    console.log(JSON.stringify({ mode: { persist, clear, submit }, ...stages }, jsonSafe, 2));
    return stoppedShort || halted ? 1 : 0;
  } finally {
    // The rotating set owns every provider it built lazily, including ones the
    // scan moved on from, so destroying `sourceProviders` alone would leak them.
    for (const providers of rotatingProviders.values()) providers.destroy();
    for (const provider of Object.values(sourceProviders)) provider?.destroy();
    creditcoin.destroy();
    if (db !== undefined) await db.close();
  }
}

process.exitCode = await main();
