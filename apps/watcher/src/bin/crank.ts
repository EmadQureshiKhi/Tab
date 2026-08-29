/**
 * `pnpm --filter @tabai/watcher crank`
 *
 * The permissionless cranks, run on their own rather than as part of a pipeline pass.
 *
 * Today that is `reverseExpiredClearing` (R15.5, R14.6). It is separate from the
 * pipeline because the two answer to different clocks. A pipeline pass is paced by
 * the attested frontier and takes minutes; a reversal deadline is a wall on Creditcoin's
 * clock and the crank should be able to run against it alone, on a short timer, without
 * dragging a chain scan behind it.
 *
 * **Read-only by default.** Without `--submit` it reads every candidate's record from
 * chain, reports which are due, and sends nothing. No key is loaded in that mode.
 *
 * Flags:
 *   --submit     actually crank. Costs CTC.
 *   --limit N    consider at most N candidates, default 100
 *
 * Exit codes: 0 the pass completed, 1 a crank failed, 2 it could not start.
 */

import { Wallet } from "ethers";

import { err, ok } from "@tabai/shared";

import { loadWatcherConfig } from "../config.js";
import { createJsonRpcProvider, CREDITCOIN_BLOCK_TAG } from "../rpc.js";
import { createTabBookClient, requireTabBook, sweepReversals } from "../clearing.js";
import { createDb, requireDatabaseUrl } from "../db/client.js";
import { loadReversalCandidates, recordClearingState } from "../db/observation-store.js";

function numericFlag(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function main(): Promise<number> {
  const submit = process.argv.includes("--submit");
  const limit = numericFlag("--limit") ?? 100;

  const config = loadWatcherConfig();
  if (!config.ok) {
    console.error(`crank: ${config.error.code}: ${config.error.message}`);
    return 2;
  }
  const tabBookAddress = requireTabBook(config.value);
  if (!tabBookAddress.ok) {
    console.error(`crank: ${tabBookAddress.error.code}: ${tabBookAddress.error.message}`);
    return 2;
  }
  const databaseUrl = requireDatabaseUrl(config.value);
  if (!databaseUrl.ok) {
    console.error(`crank: ${databaseUrl.error.code}: ${databaseUrl.error.message}`);
    return 2;
  }

  const creditcoin = createJsonRpcProvider(
    config.value.creditcoin.rpcUrl,
    config.value.creditcoin.chainId,
    config.value.rpcBatchMaxCount,
  );

  // The key is loaded only when the pass is going to send something, so a read-only
  // run of this tool is genuinely keyless.
  let signer: Wallet | undefined;
  if (submit) {
    const key = config.value.watcher.privateKey;
    if (key === undefined) {
      console.error("crank: WATCHER_PRIVATE_KEY is not set, so --submit cannot send");
      return 2;
    }
    signer = new Wallet(key, creditcoin);
  }

  const tabBook = createTabBookClient(
    creditcoin,
    tabBookAddress.value,
    CREDITCOIN_BLOCK_TAG,
    ...(signer === undefined ? [] : ([signer] as const)),
  );
  const handle = createDb(databaseUrl.value);

  try {
    const candidates = await loadReversalCandidates(handle.db, limit);
    if (!candidates.ok) {
      console.error(`crank: ${candidates.error.code}: ${candidates.error.message}`);
      return 2;
    }

    const report = await sweepReversals(
      {
        client: tabBook,
        persist: (replayKey, clearingState) => recordClearingState(handle.db, replayKey, clearingState),
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
        submit,
      },
      candidates.value,
    );
    if (!report.ok) {
      console.error(`crank: ${report.error.code}: ${report.error.message}`);
      return 2;
    }
    console.log(JSON.stringify({ mode: { submit }, reversal: report.value }, null, 2));
    return report.value.failed > 0 ? 1 : 0;
  } finally {
    await handle.close();
  }
}

process.exitCode = await main();
