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
 *
 * Requirements: 12.6, 24.4
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClassifier, findTeamAddresses, loadTeamAddresses } from "./adoption.js";
import { serve } from "@hono/node-server";

import { loadConfig, readProcessEnvironment } from "./config.js";
import { EthersCreditChainReader } from "./chain-reads.js";
import { EthersLogSource, createProvider } from "./chain.js";
import { PostgresSink } from "./postgres-sink.js";
import { PostgresReads } from "./queries.js";
import { IndexerService } from "./service.js";
import { createApp } from "./server.js";
import { DEFAULT_STREAM } from "./sink.js";

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  const config = loadConfig(readProcessEnvironment());

  const provider = createProvider(config);
  const source = new EthersLogSource(provider, config.addresses);
  const sink = PostgresSink.open(config.databaseUrl);

  await sink.applySchema();

  const service = new IndexerService(source, sink, {
    stream: DEFAULT_STREAM,
    startBlock: config.startBlock,
    logChunkBlocks: config.logChunkBlocks,
    reorgWindowBlocks: config.reorgWindowBlocks,
    pollIntervalMs: config.pollIntervalMs,
  });

  if (once) {
    const report = await service.tickOnce();
    await sink.close();
    provider.destroy();
    if (report === null) {
      console.error(`registry: tick failed — ${service.status.lastError ?? "unknown"}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `registry: blocks ${report.fromBlock}..${report.toBlock} of head ${report.head}, ` +
        `${report.logsSeen} logs seen, ${report.rowsWritten} rows written, ` +
        `${report.logsSkipped} skipped, reorg ${report.reorgDetected ? `from ${report.reorgFrom}` : "none"}`,
    );
    return;
  }

  service.start();

  // A second pool, for reads only. The indexer is a single writer whose transactions
  // must not queue behind a slow read, and the read side is the half that scales out,
  // so the two are kept apart rather than sharing one pool.
  const reads = PostgresReads.open(config.databaseUrl);

  // The Creditcoin reader the credit and Bond cross-checks go through. It shares the
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

  const app = createApp({
    status: () => service.status,
    databaseReachable: () => sink.ping(),
    reads,
    chain,
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
