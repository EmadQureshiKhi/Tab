/**
 * Finding one Settlement's log, naming it, and waiting for the rail to attribute it.
 *
 * Every claim this demo makes about a Settlement rests on the same two steps, so
 * they live here rather than being written twice.
 *
 * **A transaction hash is not a Settlement's identity.** One transaction can
 * carry several Settlements, and the identity is the replay key packing
 * `(chainKey, blockHeight, txIndex, logIndex)`, where the log index is the log's
 * position within its **own receipt** and never the block-wide index. Getting
 * that ordinal wrong produces a key that names a different log or no log at all.
 *
 * **Waiting for a balance to move is not the same as waiting for this payment.**
 * An Agent can have more than one Settlement in flight, and an earlier version of
 * act four waited on the holder's settlement history count, saw it rise because
 * an unrelated Settlement was proved first, and gave up on its own twenty minutes
 * early. What is waited for here is the `SettlementApplied` event for this exact
 * replay key.
 */

import type { TransactionReceipt } from "ethers";

import type { Address, Bytes32, Result } from "@tabai/shared";
import { err, ok, packReplayKey } from "@tabai/shared";

import type { Cast } from "./cast.js";
import type { DemoProviders } from "./chain.js";
import { receiptOrdinalOf, settlementAttributionOf } from "./chain.js";
import { waitFor, type WaitOutcome } from "./wait.js";

/** One Settlement log, located within its receipt. */
export interface LocatedSettlement {
  readonly replayKey: Bytes32;
  /** The token holder, taken from `topics[1]`. The payer, and never the sender. */
  readonly payerTopic: Address;
  /** The transaction's sender, for the comparison act four turns on. */
  readonly sender: Address;
  readonly blockNumber: number;
  readonly ordinal: number;
}

/**
 * Names the Settlement a receipt carries, or says why it carries none.
 *
 * Matches on the Asset's own log to the registered Collection Address, which is
 * what a `direct-transfer` Settlement is. A receipt with several such logs is
 * refused rather than guessed at: this demo sends one Settlement per transaction,
 * and picking the first of several would silently attribute the wrong one.
 */
export function locateSettlement(
  cast: Cast,
  receipt: TransactionReceipt,
): Result<LocatedSettlement> {
  const collectionTopic = `0x000000000000000000000000${cast.collectionAddress.slice(2)}`.toLowerCase();
  const candidates = receipt.logs.filter(
    (entry) =>
      entry.address.toLowerCase() === cast.asset.address.toLowerCase() &&
      entry.topics[2]?.toLowerCase() === collectionTopic,
  );
  const found = candidates[0];
  if (found === undefined) {
    return err({
      category: "CHAIN",
      code: "DEMO_NO_SETTLEMENT_LOG",
      message: `${receipt.hash} carried no ${cast.asset.symbol} Transfer to ${cast.collectionAddress}, so it settled nothing`,
      retryable: false,
    });
  }
  if (candidates.length > 1) {
    return err({
      category: "VALIDATION",
      code: "DEMO_MANY_SETTLEMENT_LOGS",
      message: `${receipt.hash} carried ${String(candidates.length)} Settlements and this act sends one, so which to attribute is ambiguous`,
      retryable: false,
    });
  }
  return ok({
    replayKey: packReplayKey({
      chainKey: cast.asset.chainKey,
      blockHeight: BigInt(receipt.blockNumber),
      txIndex: BigInt(receipt.index),
      logIndex: BigInt(receiptOrdinalOf(receipt.logs, found.index)),
    }),
    payerTopic: `0x${found.topics[1]?.slice(26) ?? ""}` as Address,
    sender: receipt.from as Address,
    blockNumber: receipt.blockNumber,
    ordinal: receiptOrdinalOf(receipt.logs, found.index),
  });
}

/** What the rail did with one Settlement, once it had proved it. */
export interface SettlementCredit {
  readonly outcome: WaitOutcome;
  readonly creditedAgent?: Address;
  readonly applied?: bigint;
  readonly toPrepaid?: bigint;
  /** What a Provisional Clearing had already taken off the tab before this proof landed. */
  readonly coveredByClearing?: bigint;
  readonly waitedMs: number;
}

/**
 * Waits for `TabBook.SettlementApplied` naming this replay key.
 *
 * The search starts a couple of hundred blocks back so a proof that lands between
 * the broadcast and the first reading is still found, rather than being missed
 * because the wait began one block too late.
 */
export async function awaitSettlementCredit(
  providers: DemoProviders,
  cast: Cast,
  replayKey: Bytes32,
  options: { readonly seconds: number; readonly log?: (line: string) => void },
): Promise<SettlementCredit> {
  const head = await providers.creditcoin.getBlockNumber();
  const fromBlock = Math.max(0, head - 200);
  const waited = await waitFor(
    () => settlementAttributionOf(providers, cast, replayKey, fromBlock),
    {
      seconds: options.seconds,
      ...(options.log === undefined ? {} : { log: options.log }),
      describe: (polls) =>
        `    waiting for the Watcher to prove ${replayKey}, ${String(polls)} readings so far`,
    },
  );
  if (waited.value === undefined) {
    return { outcome: waited.outcome, waitedMs: waited.elapsedMs };
  }
  return {
    outcome: waited.outcome,
    creditedAgent: waited.value.creditedAgent,
    applied: waited.value.applied,
    toPrepaid: waited.value.toPrepaid,
    coveredByClearing: waited.value.coveredByClearing,
    waitedMs: waited.elapsedMs,
  };
}
