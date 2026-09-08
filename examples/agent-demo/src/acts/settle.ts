/**
 * Act three. Each Agent pays its own tab, with its own key, on the Source Chain.
 *
 * The Agent moves USDC on Ethereum Sepolia to the Collection Address the Service
 * registered. That transfer *is* the Settlement: no Tab contract is involved on
 * the Source Chain, nothing is escrowed, and the Agent needs no permission from
 * anybody to make it. The transfer goes out through the SDK's Ethereum USDC
 * strategy, which is the same seam a consumer would add a chain to.
 *
 * **Broadcasting the transfer is not the end of the act.** The payment becomes
 * credit only once the Watcher observes the log, waits for the height to be
 * attested, folds a Continuity Proof and submits it on Creditcoin. This act
 * broadcasts and then watches the Creditcoin ledger until the Agent's settlement
 * history grows, so the story stays continuous. It never proves anything itself
 * and it never asks the Watcher to hurry.
 *
 * Requirements: 1.1, 2.1, 12.4, 22.4, 23.1
 */

import { JsonRpcProvider, Wallet } from "ethers";

import type { Result } from "@tabai/shared";
import { ok } from "@tabai/shared";

import { createEthereumUsdcStrategy } from "@tabai/sdk";

import { readLedger } from "../chain.js";
import { diffLedger } from "../ledger.js";
import { describeDelta, formatBaseUnits } from "../narrate.js";
import { ethereumRoleFor } from "../secrets.js";
import { awaitSettlementCredit, locateSettlement } from "../settlement.js";
import { agentsInScope, type Act, type ActContext, type ActOutcome } from "./index.js";

export const settleAct: Act = {
  id: "settle",
  number: 3,
  title: "Each Agent pays its own tab with its own key",
  synopsis:
    "A plain USDC transfer to the Service's Collection Address on Sepolia is the Settlement. The Watcher proves it, and the Open Tab falls without either side trusting the other.",

  async run(context: ActContext): Promise<Result<ActOutcome>> {
    const { cast, providers, options, log } = context;

    const results: Record<string, unknown>[] = [];
    let allWell = true;
    let broadcastAny = false;

    for (const agent of agentsInScope(cast, options)) {
      const index = cast.agents.findIndex((candidate) => candidate.name === agent.name);
      const before = await readLedger(providers, cast, agent);

      log(
        `  ${agent.name} owes ${formatBaseUnits(before.open, cast.asset.decimals, cast.asset.symbol)} and holds ${formatBaseUnits(before.walletBalance, cast.asset.decimals, cast.asset.symbol)} on the Source Chain`,
      );
      log(
        `    would send ${formatBaseUnits(options.amount, cast.asset.decimals, cast.asset.symbol)} to the Collection Address ${cast.collectionAddress}`,
      );

      if (before.walletBalance < options.amount) {
        allWell = false;
        log(`    refused: the wallet holds less than the Settlement amount`);
        results.push({ agent: agent.name, action: "underfunded", balance: before.walletBalance.toString() });
        continue;
      }

      if (!options.broadcast) {
        results.push({
          agent: agent.name,
          action: "simulated",
          amount: options.amount.toString(),
          collectionAddress: cast.collectionAddress,
        });
        continue;
      }

      const key = context.secrets.keyFor(ethereumRoleFor(index));
      if (!key.ok) return key;
      const signer = new Wallet(key.value, providers.source as JsonRpcProvider);

      const strategy = createEthereumUsdcStrategy({
        signer,
        assets: { [`${cast.asset.chainKey.toString()}:${cast.asset.address.toLowerCase()}`]: cast.asset },
      });

      const receipt = await strategy.settle({
        agent: agent.creditcoin,
        serviceId: cast.serviceId,
        asset: cast.asset,
        amount: options.amount,
        collectionAddress: cast.collectionAddress,
        tabId: before.tabId,
        mode: "direct-transfer",
      });

      if (!receipt.ok) {
        allWell = false;
        log(`    the Settlement was not submitted: ${receipt.error.code} ${receipt.error.message}`);
        results.push({ agent: agent.name, action: "refused", error: receipt.error });
        continue;
      }

      broadcastAny = true;
      log(`    submitted ${receipt.value.sourceTxHash} on chainKey ${receipt.value.chainKey.toString()}`);

      // The strategy's receipt is a submission receipt: it proves nothing and does
      // not know where the log landed. The mined receipt does, and the replay key
      // built from it is this Settlement's identity, which is what the wait below
      // is for rather than a movement in the Agent's balances.
      const mined = await providers.source.waitForTransaction(receipt.value.sourceTxHash);
      if (mined === null || mined.status !== 1) {
        allWell = false;
        log(`    the Settlement transaction did not succeed on the Source Chain`);
        results.push({ agent: agent.name, action: "reverted", sourceTxHash: receipt.value.sourceTxHash });
        continue;
      }
      const located = locateSettlement(cast, mined);
      if (!located.ok) return located;
      log(`    replay key ${located.value.replayKey}`);

      const credit = await awaitSettlementCredit(providers, cast, located.value.replayKey, {
        seconds: options.waitSeconds,
        log,
      });

      const after = await readLedger(providers, cast, agent);
      const delta = diffLedger(before, after);
      for (const line of describeDelta(agent.name, delta, cast.asset.decimals, cast.asset.symbol)) log(line);

      if (credit.outcome === "TIMED_OUT") {
        log(
          `    the Watcher had not proved it after ${String(Math.round(credit.waitedMs / 1000))}s. That is a wait, not a failure: attestation lands on a ten-block stride. Run the Watcher pipeline and read the ledger again.`,
        );
        allWell = false;
      } else {
        log(
          `    proven and applied to ${String(credit.creditedAgent)}: ${String(credit.applied)} base units against the Open Tab, ${String(credit.toPrepaid)} banked as prepaid credit, ${String(credit.coveredByClearing)} already covered by the Provisional Clearing this confirmed.`,
        );
        if (credit.creditedAgent?.toLowerCase() !== agent.creditcoin.toLowerCase()) {
          allWell = false;
          log(
            `    but that is not ${agent.name}. A Settlement from an Agent's own wallet must credit that Agent.`,
          );
        }
      }

      results.push({
        agent: agent.name,
        action: credit.outcome === "OBSERVED" ? "settled" : "awaiting-proof",
        sourceTxHash: receipt.value.sourceTxHash,
        replayKey: located.value.replayKey,
        amount: options.amount.toString(),
        creditedAgent: credit.creditedAgent,
        applied: credit.applied?.toString(),
        toPrepaid: credit.toPrepaid?.toString(),
        coveredByClearing: credit.coveredByClearing?.toString(),
        openDelta: delta.open.toString(),
        prepaidDelta: delta.prepaid.toString(),
        historyDelta: delta.historyCount,
        waitedMs: credit.waitedMs,
      });
    }

    return ok({
      act: "settle",
      ok: allWell,
      broadcast: broadcastAny,
      summary: allWell
        ? "every Agent in scope settled from its own key and the credit landed"
        : "at least one Settlement is unproven or was not sent",
      detail: { agents: results },
    });
  },
};
