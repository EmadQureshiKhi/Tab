/**
 * Process entry point.
 *
 * Wiring only: read the environment, open the database, apply the schema, build the
 * chain reader, start the loop, serve the probes, and shut all of it down cleanly on
 * a signal. Every decision worth arguing about lives in the module that owns it.
 *
 * `--once` runs a single tick and exits with the tick's outcome, which is what makes
 * the indexer checkable by hand against a live chain without leaving a process
 * behind.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClassifier, findTeamAddresses, loadTeamAddresses } from "./adoption.js";
import { serve } from "@hono/node-server";

import { createCardFetcher } from "./agent-card.js";
import { loadConfig, readProcessEnvironment, watchedAddresses, type RegistryConfig } from "./config.js";
import { EthersCreditChainReader, EthersErc8004ChainReader } from "./chain-reads.js";
import { EthersLogSource, createProvider, requireChainId } from "./chain.js";
import { HyperSyncLogSource, createCatchUpSource, createHyperSyncClient } from "./hypersync.js";
import type { LogSource } from "./indexer.js";
import { createNansenLabels } from "./nansen.js";
import { PostgresSink } from "./postgres-sink.js";
import { PostgresReads } from "./queries.js";
import { IndexerService } from "./service.js";
import { createApp } from "./server.js";
import { DEFAULT_STREAM } from "./sink.js";

/**
 * The log source: the RPC alone, or HyperSync for catch-up with the RPC for the
 * head, the live window and any range the archive cannot answer. See
 * `hypersync.ts` for the rule.
 */
async function createLogSource(config: RegistryConfig, live: LogSource): Promise<LogSource> {
  if (config.hypersync === null) return live;
  const client = await createHyperSyncClient({ url: config.hypersync.url, apiToken: config.hypersync.apiToken });
  const fast = new HyperSyncLogSource(client, watchedAddresses(config), { chunkBlocks: config.hypersync.chunkBlocks });
  console.log(
    `registry: HyperSync at ${config.hypersync.url} for ranges older than ${config.hypersync.liveWindowBlocks} blocks, ` +
      `${config.hypersync.chunkBlocks} blocks per request${config.hypersync.apiToken === null ? ", no API token" : ""}`,
  );
  return createCatchUpSource({
    fast,
    live,
    liveWindow: config.hypersync.liveWindowBlocks,
    liveChunkBlocks: config.logChunkBlocks,
    onFallback: (error, fromBlock, toBlock) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`registry: HyperSync failed for ${fromBlock}..${toBlock}, reading the range from the RPC: ${message}`);
    },
  });
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  const config = loadConfig(readProcessEnvironment());

  const provider = createProvider(config);
  await requireChainId(provider, config.chainId);
  const source = await createLogSource(config, new EthersLogSource(provider, watchedAddresses(config)));
  const sink = PostgresSink.open(config.databaseUrl);

  await sink.applySchema();

  const service = new IndexerService(source, sink, {
    stream: DEFAULT_STREAM,
    startBlock: config.startBlock,
    logChunkBlocks: config.logChunkBlocks,
    reorgWindowBlocks: config.reorgWindowBlocks,
    pollIntervalMs: config.pollIntervalMs,
  });

  if (config.erc8004 !== null) {
    console.log(`registry: ERC-8004 Identity registry ${config.erc8004.identityRegistry} is watched from block ${config.startBlock}`);
  }

  if (once) {
    const started = Date.now();
    const report = await service.tickOnce();
    await sink.close();
    provider.destroy();
    if (report === null) {
      console.error(`registry: tick failed: ${service.status.lastError ?? "unknown"}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `registry: blocks ${report.fromBlock}..${report.toBlock} of head ${report.head}, ` +
        `${report.logsSeen} logs seen, ${report.rowsWritten} rows written, ` +
        `${report.logsSkipped} skipped, reorg ${report.reorgDetected ? `from ${report.reorgFrom}` : "none"}, ` +
        `${Date.now() - started} ms`,
    );
    return;
  }

  service.start();

  // A second pool, for reads only. The indexer is a single writer whose transactions
  // must not queue behind a slow read, and the read side is the half that scales out,
  // so the two are kept apart rather than sharing one pool.
  const reads = PostgresReads.open(config.databaseUrl);

  // The Monad reader the credit and Bond cross-checks go through. It shares the
  // indexer's provider deliberately: both read the same chain at the same endpoint,
  // and a figure checked against a second endpoint would be checked against a
  // possibly different view of it.
  const chain = new EthersCreditChainReader(provider, config.addresses.TabBook, config.addresses.Bond);

  // The allowlist is read once, at start. Reading it per request would turn an edit
  // into a silent mid-flight change of the counting rule, and a deployment that cannot
  // read it serves everything except `/adoption` rather than publishing figures under
  // an empty allowlist, which would call every address external.
  const configured = process.env.TEAM_ADDRESSES_PATH?.trim();
  const allowlistPath =
    configured !== undefined && configured.length > 0
      ? resolve(configured)
      : ((await findTeamAddresses(dirname(fileURLToPath(import.meta.url)))) ?? resolve(process.cwd(), "team-addresses.json"));
  const team = await loadTeamAddresses(allowlistPath);
  if (!team.ok) {
    console.warn(`registry: ${team.error.code}: ${team.error.message}. /adoption will not be served`);
  }

  // ERC-8004 identity and Nansen labels are context on the Agent read. Each is
  // wired only when configured, and each names its own absence in the response
  // rather than leaving a field out.
  const identity =
    config.erc8004 === null
      ? undefined
      : {
          registries: { identity: config.erc8004.identityRegistry, reputation: config.erc8004.reputationRegistry },
          cards: createCardFetcher(),
          chain: new EthersErc8004ChainReader(provider, config.erc8004.identityRegistry, config.erc8004.reputationRegistry),
        };
  const labels = config.nansen === null ? undefined : createNansenLabels(config.nansen);

  const app = createApp({
    status: () => service.status,
    databaseReachable: () => sink.ping(),
    reads,
    chain,
    ...(identity === undefined ? {} : { identity }),
    ...(labels === undefined ? {} : { labels }),
    ...(team.ok ? { adoption: { classifier: createClassifier(team.value), allowlistPath } } : {}),
  });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`registry: listening on ${info.port}, indexing from block ${config.startBlock}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`registry: ${signal} received, draining`);
    server.close();
    await service.stop();
    await reads.close();
    await sink.close();
    provider.destroy();
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

await main();
