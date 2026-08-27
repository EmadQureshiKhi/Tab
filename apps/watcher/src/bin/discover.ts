/**
 * `pnpm --filter @tabai/watcher discover`
 *
 * Runs chain discovery once against the live network and prints what it found. No
 * key, no transaction, no write unless `--persist` is passed.
 *
 * This is the operator's answer to "which chains is the Watcher monitoring, and
 * why not the others". It is also the check that keeps two facts about this network
 * honest, because both are exercised on every run:
 *
 * - the pinned ChainInfo ABI still matches the precompile — a drifted name reverts
 *   with `"Unknown selector"` and is reported as such rather than as an outage;
 * - the RPC client tolerates Creditcoin block objects, which carry no `mixHash`.
 *   `blockObjectDecoded` is that answer.
 *
 * Exit codes: 0 at least one chain is monitorable, 1 none is, 2 the run could not
 * start.
 */

import { loadWatcherConfig } from "../config.js";
import { createPrecompileChainInfoReader } from "../chain-info.js";
import { createJsonRpcProvider, readCreditcoinTip, CREDITCOIN_BLOCK_TAG } from "../rpc.js";
import { describeDiscovery, discoverChains } from "../discovery.js";
import { createDb, requireDatabaseUrl } from "../db/client.js";
import { loadPersistedFrontiers, recordDiscovery } from "../db/discovery-store.js";

/** `JSON.stringify` cannot serialise a bigint, and every height here is one. */
const jsonSafe = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

async function main(): Promise<number> {
  const persist = process.argv.includes("--persist");

  const config = loadWatcherConfig();
  if (!config.ok) {
    console.error(`discover: ${config.error.code}: ${config.error.message}`);
    return 2;
  }

  const provider = createJsonRpcProvider(
    config.value.creditcoin.rpcUrl,
    config.value.creditcoin.chainId,
    config.value.rpcBatchMaxCount,
  );

  try {
    const tip = await readCreditcoinTip(provider);
    if (!tip.ok) {
      console.error(`discover: ${tip.error.code}: ${tip.error.message}`);
      return 2;
    }

    const reader = createPrecompileChainInfoReader(
      provider,
      config.value.creditcoin.chainInfoPrecompile,
      CREDITCOIN_BLOCK_TAG,
    );

    let previousFrontiers: Awaited<ReturnType<typeof loadPersistedFrontiers>> | undefined;
    let db: ReturnType<typeof createDb> | undefined;
    if (persist) {
      const databaseUrl = requireDatabaseUrl(config.value);
      if (!databaseUrl.ok) {
        console.error(`discover: ${databaseUrl.error.code}: ${databaseUrl.error.message}`);
        return 2;
      }
      db = createDb(databaseUrl.value);
      previousFrontiers = await loadPersistedFrontiers(db.db);
      if (!previousFrontiers.ok) {
        console.error(
          `discover: ${previousFrontiers.error.code}: ${previousFrontiers.error.message}`,
        );
        await db.close();
        return 2;
      }
    }

    const discovery = await discoverChains(reader, config.value, {
      ...(previousFrontiers?.ok === true ? { previousFrontiers: previousFrontiers.value } : {}),
    });
    if (!discovery.ok) {
      console.error(`discover: ${discovery.error.code}: ${discovery.error.message}`);
      if (db !== undefined) await db.close();
      return 2;
    }

    if (db !== undefined) {
      const written = await recordDiscovery(db.db, discovery.value);
      if (!written.ok) {
        console.error(`discover: ${written.error.code}: ${written.error.message}`);
        await db.close();
        return 2;
      }
      console.error(
        `discover: persisted ${written.value.attestingChainKeys.length} attesting and ${written.value.quietChainKeys.length} quiet chain(s), offered ${written.value.endpointRowsOffered} endpoint row(s)`,
      );
      await db.close();
    }

    console.log(
      JSON.stringify(
        {
          creditcoin: { ...tip.value, blockTag: CREDITCOIN_BLOCK_TAG },
          chainInfoPrecompile: config.value.creditcoin.chainInfoPrecompile,
          rpcBatchMaxCount: config.value.rpcBatchMaxCount,
          summary: describeDiscovery(discovery.value),
          discovery: discovery.value,
        },
        jsonSafe,
        2,
      ),
    );

    return discovery.value.mode === "NO_CHAIN_MONITORABLE" ? 1 : 0;
  } finally {
    provider.destroy();
  }
}

process.exitCode = await main();
