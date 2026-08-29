/**
 * `pnpm --filter @tabai/watcher health`
 *
 * The unauthenticated health server, run as its own long-lived process (R20.12).
 *
 * It is a separate entry point rather than a side effect of the pipeline because the
 * two have opposite lifetimes. The pipeline is a pass: it starts, does one sweep, and
 * exits, and an orchestrator that probed a port owned by a process which exits on
 * success would read every healthy run as a crash. The health server is the thing
 * that stays up.
 *
 * It loads no key. It reads the database and the chain-info precompile and nothing
 * else, which is what lets it be exposed without authentication.
 *
 * Flags:
 *   --port N   bind port, default `WATCHER_HEALTH_PORT` then 8081
 *   --host H   bind host, default 0.0.0.0
 *   --once     print one `/healthz` body to stdout and exit, binding no port
 *
 * Exit codes: 0 clean shutdown or a successful `--once`, 2 it could not start.
 */

import { loadWatcherConfig } from "../config.js";
import { createPrecompileChainInfoReader } from "../chain-info.js";
import { createJsonRpcProvider, CREDITCOIN_BLOCK_TAG } from "../rpc.js";
import { discoverChains, monitoredChainKeys } from "../discovery.js";
import { createDb, requireDatabaseUrl } from "../db/client.js";
import { loadPersistedFrontiers } from "../db/discovery-store.js";
import { buildHealthSnapshot, startHealthServer } from "../health.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const once = process.argv.includes("--once");
  const portFlag = flag("--port");
  const host = flag("--host") ?? "0.0.0.0";

  const config = loadWatcherConfig();
  if (!config.ok) {
    console.error(`health: ${config.error.code}: ${config.error.message}`);
    return 2;
  }
  const databaseUrl = requireDatabaseUrl(config.value);
  if (!databaseUrl.ok) {
    console.error(`health: ${databaseUrl.error.code}: ${databaseUrl.error.message}`);
    return 2;
  }
  const db = createDb(databaseUrl.value);

  const creditcoin = createJsonRpcProvider(
    config.value.creditcoin.rpcUrl,
    config.value.creditcoin.chainId,
    config.value.rpcBatchMaxCount,
  );
  const chainInfo = createPrecompileChainInfoReader(
    creditcoin,
    config.value.creditcoin.chainInfoPrecompile,
    CREDITCOIN_BLOCK_TAG,
  );
  const frontiers = await loadPersistedFrontiers(db.db);
  const discovery = await discoverChains(chainInfo, config.value, {
    ...(frontiers.ok ? { previousFrontiers: frontiers.value } : {}),
  });

  if (!discovery.ok) {
    console.error(`health: ${discovery.error.code}: ${discovery.error.message}`);
    await db.close();
    return 2;
  }

  // Which chains this deployment is responsible for is settled once, at start, and
  // held for the life of the process. Re-deriving it per request would let a chain
  // that stopped attesting quietly drop out of `chainsWithoutCursor` and turn a real
  // fault into a green light.
  const monitoredChains = monitoredChainKeys(discovery.value);
  const deps = { db: db.db, monitoredChains };

  if (once) {
    const snapshot = await buildHealthSnapshot(deps);
    console.log(JSON.stringify(snapshot, null, 2));
    await db.close();
    return 0;
  }

  const started = await startHealthServer(deps, {
    ...(portFlag === undefined ? {} : { port: Number(portFlag) }),
    host,
  });
  if (!started.ok) {
    console.error(`health: ${started.error.code}: ${started.error.message}`);
    await db.close();
    return 2;
  }
  console.log(
    `health: listening on ${host}:${started.value.port}, monitoring chainKey ${monitoredChains.join(", ")}`,
  );

  await new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      console.log(`health: ${signal}, closing`);
      resolve();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
  await started.value.close();
  await db.close();
  return 0;
}

process.exitCode = await main();
