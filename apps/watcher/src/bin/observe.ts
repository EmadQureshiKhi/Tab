/**
 * `pnpm --filter @tabai/watcher observe`
 *
 * One pass of the observation pipeline against the live network: discover chains,
 * resolve watch targets through the registry, scan from each cursor to each Source
 * Chain head, and report what it found.
 *
 * **Read-only by default, and read-only in three separate senses.** Without
 * `--persist` nothing is written to the database; without `--clear` no Provisional
 * Clearing is submitted; without both, no key is ever loaded. The flags are separate
 * because they carry different costs: persistence costs a row, a clearing costs CTC
 * and pledges a Service's Bond.
 *
 * Flags:
 *   --persist        write observations and advance the read cursor
 *   --clear          submit Provisional Clearings for eligible rows (implies --persist)
 *   --check-reorgs   run the reorg check over confirmed clearings, reporting only with --clear
 *   --from N         start the scan at block N rather than at the persisted cursor
 *   --blocks N       scan at most N blocks back from the head on a cold start
 *
 * Exit codes: 0 the pass completed, 1 it stopped short of a head, 2 it could not start.
 */

import { Wallet } from "ethers";

import { createAgentRegistryReader, requireAgentRegistry } from "../agent-registry.js";
import { loadWatcherConfig } from "../config.js";
import { createPrecompileChainInfoReader } from "../chain-info.js";
import { createJsonRpcProvider, readCreditcoinTip, CREDITCOIN_BLOCK_TAG } from "../rpc.js";
import { describeDiscovery, discoverChains, monitoredChainKeys } from "../discovery.js";
import {
  createServiceRegistryReader,
  createReceiptLogReader,
  createSourceLogReader,
  describeTargets,
  resolveWatchTargets,
  scanChain,
  type ScanReport,
  type WatchTarget,
} from "../observation.js";
import {
  checkForReorgs,
  createAttestationReader,
  createSourceChainReader,
  createTabBookClient,
  requireServiceRegistry,
  requireTabBook,
  sweepClearings,
  type ReorgFinding,
} from "../clearing.js";
import { createDb, requireDatabaseUrl } from "../db/client.js";
import { loadPersistedFrontiers } from "../db/discovery-store.js";
import {
  advanceCursor,
  loadClearingCandidates,
  loadReadCursors,
  loadReorgCheckCandidates,
  loadResumableSettlements,
  recordClearingOutcome,
  recordObservations,
} from "../db/observation-store.js";
import type { ChainKey } from "@tabai/shared";
import type { JsonRpcProvider } from "ethers";

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
  const clear = process.argv.includes("--clear");
  const persist = clear || process.argv.includes("--persist");
  const checkReorgs = process.argv.includes("--check-reorgs");
  const fromOverride = numericFlag("--from");
  const coldStartBlocks = numericFlag("--blocks") ?? DEFAULT_COLD_START_BLOCKS;

  const config = loadWatcherConfig();
  if (!config.ok) {
    console.error(`observe: ${config.error.code}: ${config.error.message}`);
    return 2;
  }

  const registryAddress = requireServiceRegistry(config.value);
  if (!registryAddress.ok) {
    console.error(`observe: ${registryAddress.error.code}: ${registryAddress.error.message}`);
    return 2;
  }

  const creditcoin = createJsonRpcProvider(
    config.value.creditcoin.rpcUrl,
    config.value.creditcoin.chainId,
    config.value.rpcBatchMaxCount,
  );
  const sourceProviders: Partial<Record<ChainKey, JsonRpcProvider>> = {};
  let db: ReturnType<typeof createDb> | undefined;

  try {
    const tip = await readCreditcoinTip(creditcoin);
    if (!tip.ok) {
      console.error(`observe: ${tip.error.code}: ${tip.error.message}`);
      return 2;
    }

    if (persist) {
      const databaseUrl = requireDatabaseUrl(config.value);
      if (!databaseUrl.ok) {
        console.error(`observe: ${databaseUrl.error.code}: ${databaseUrl.error.message}`);
        return 2;
      }
      db = createDb(databaseUrl.value);
    }

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
      console.error(`observe: ${discovery.error.code}: ${discovery.error.message}`);
      return 2;
    }
    console.error(`observe: ${describeDiscovery(discovery.value)}`);

    const registry = createServiceRegistryReader(
      creditcoin,
      registryAddress.value,
      CREDITCOIN_BLOCK_TAG,
    );
    const resolution = await resolveWatchTargets(
      registry,
      config.value,
      monitoredChainKeys(discovery.value),
    );
    if (!resolution.ok) {
      console.error(`observe: ${resolution.error.code}: ${resolution.error.message}`);
      return 2;
    }
    console.error(`observe: ${describeTargets(resolution.value)}`);

    // One provider per monitored chain, from the highest-priority endpoint. Rotation
    // across the rest is task 14.4's; a single pass uses the first.
    for (const chain of discovery.value.monitored) {
      const [endpoint] = chain.endpoints;
      if (endpoint === undefined) continue;
      sourceProviders[chain.chainKey] = createJsonRpcProvider(
        endpoint,
        chain.evmChainId,
        config.value.rpcBatchMaxCount,
      );
    }

    const cursors = db === undefined ? undefined : await loadReadCursors(db.db);
    if (cursors !== undefined && !cursors.ok) {
      console.error(`observe: ${cursors.error.code}: ${cursors.error.message}`);
      return 2;
    }

    const logReaderByChain = new Map<ChainKey, ReturnType<typeof createSourceLogReader>>();
    const scans: ScanReport[] = [];
    let stoppedShort = false;

    for (const chain of discovery.value.monitored) {
      const provider = sourceProviders[chain.chainKey];
      if (provider === undefined) continue;
      const targets: readonly WatchTarget[] = resolution.value.targets.filter(
        (target) => target.chainKey === chain.chainKey,
      );
      if (targets.length === 0) {
        console.error(`observe: chainKey ${chain.chainKey} has no resolved target, so nothing to read`);
        continue;
      }

      const head = BigInt(await provider.getBlockNumber());
      const persisted = cursors?.ok === true
        ? cursors.value.find((entry) => entry.chainKey === chain.chainKey)?.lastProcessedBlock
        : undefined;
      const cold = head > coldStartBlocks ? head - coldStartBlocks : 0n;
      const lastProcessedBlock =
        fromOverride !== undefined
          ? fromOverride - 1n
          : persisted !== undefined && persisted > 0n
            ? persisted
            : cold;

      const reader = createSourceLogReader(provider);
      logReaderByChain.set(chain.chainKey, reader);

      const scan = await scanChain({
        chainKey: chain.chainKey,
        targets,
        lastProcessedBlock,
        head,
        window: config.value.logChunk,
        receipts: createReceiptLogReader(provider),
        reader,
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
        console.error(`observe: ${scan.error.code}: ${scan.error.message}`);
        return 2;
      }
      if (scan.value.stopped !== undefined) {
        stoppedShort = true;
        console.error(
          `observe: chainKey ${chain.chainKey} stopped at block ${scan.value.lastProcessedBlock}: ${scan.value.stopped.code}: ${scan.value.stopped.message}`,
        );
      }
      scans.push(scan.value);
    }

    let clearing: unknown;
    let reorgs: readonly ReorgFinding[] = [];
    if (db !== undefined) {
      // Bound to a const so the persistence callbacks below close over a handle
      // the compiler can see is present.
      const handle = db;
      const tabBook = requireTabBook(config.value);
      if (!tabBook.ok) {
        console.error(`observe: ${tabBook.error.code}: ${tabBook.error.message}`);
        return 2;
      }
      const agentRegistry = requireAgentRegistry(config.value);
      if (!agentRegistry.ok) {
        console.error(`observe: ${agentRegistry.error.code}: ${agentRegistry.error.message}`);
        return 2;
      }
      const signer =
        clear && config.value.watcher.privateKey !== undefined
          ? new Wallet(config.value.watcher.privateKey, creditcoin)
          : undefined;
      if (clear && signer === undefined) {
        console.error("observe: WATCHER_KEY_MISSING: --clear needs WATCHER_PRIVATE_KEY");
        return 2;
      }
      const client = createTabBookClient(
        creditcoin,
        tabBook.value,
        CREDITCOIN_BLOCK_TAG,
        ...(signer === undefined ? [] : ([signer] as const)),
      );
      const source = createSourceChainReader(sourceProviders);

      const candidates = await loadClearingCandidates(db.db);
      if (!candidates.ok) {
        console.error(`observe: ${candidates.error.code}: ${candidates.error.message}`);
        return 2;
      }
      const sweep = await sweepClearings(
        {
          client,
          source,
          agents: createAgentRegistryReader(creditcoin, agentRegistry.value, CREDITCOIN_BLOCK_TAG),
          targets: resolution.value.targets,
          persist: (record) => recordClearingOutcome(handle.db, record),
          submit: clear,
          ...(signer === undefined ? {} : { signerAddress: await signer.getAddress() }),
          ...(config.value.watcher.address === undefined
            ? {}
            : { watcherAddress: config.value.watcher.address }),
        },
        candidates.value,
      );
      if (!sweep.ok) {
        console.error(`observe: ${sweep.error.code}: ${sweep.error.message}`);
        return 2;
      }
      clearing = sweep.value;

      if (checkReorgs) {
        const confirmed = await loadReorgCheckCandidates(db.db);
        if (!confirmed.ok) {
          console.error(`observe: ${confirmed.error.code}: ${confirmed.error.message}`);
          return 2;
        }
        reorgs = await checkForReorgs(
          {
            attestation: createAttestationReader(
              creditcoin,
              config.value.creditcoin.chainInfoPrecompile,
              CREDITCOIN_BLOCK_TAG,
            ),
            source,
            client,
            persist: (record) => recordClearingOutcome(handle.db, record),
            submit: clear,
          },
          confirmed.value,
        );
      }
    }

    const resumable = db === undefined ? undefined : await loadResumableSettlements(db.db, 20);

    console.log(
      JSON.stringify(
        {
          creditcoin: { ...tip.value, blockTag: CREDITCOIN_BLOCK_TAG },
          mode: { persist, clear, checkReorgs },
          targets: resolution.value.targets,
          unresolved: resolution.value.unresolved,
          scans,
          clearing,
          reorgs,
          resumable: resumable?.ok === true ? resumable.value.length : undefined,
        },
        jsonSafe,
        2,
      ),
    );

    return stoppedShort ? 1 : 0;
  } finally {
    for (const provider of Object.values(sourceProviders)) provider?.destroy();
    creditcoin.destroy();
    if (db !== undefined) await db.close();
  }
}

process.exitCode = await main();
