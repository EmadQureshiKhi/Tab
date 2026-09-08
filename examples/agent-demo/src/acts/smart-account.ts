/**
 * Act four. The account that pays is not the account that sends.
 *
 * An ERC-20 `Transfer` puts the **token holder** in `topics[1]`. For a wallet
 * moving its own tokens the holder and the transaction sender are the same
 * account, so the two can never be told apart and a verifier that reads either
 * one looks correct. A contract that holds the Asset and moves it on somebody
 * else's instruction separates them: the contract is `topics[1]`, and whoever
 * called is `from`. That is the relayer, sponsored-gas and smart-account case,
 * and it is why requirement 8 exists.
 *
 * This act stages the strongest form of the claim, where **both** addresses are
 * bound and to different agents:
 *
 * - the smart account holds the USDC, so `topics[1]` is the smart account, bound
 *   to one Agent;
 * - the other Agent's own wallet sends the transaction, so `from` is bound to a
 *   *different* Agent.
 *
 * The rail must credit the Agent bound to `topics[1]` and leave the Agent bound
 * to `from` untouched. Had the verifier resolved the payer from the transaction
 * sender, as the canonical base pattern does, the wrong Agent would be credited -
 * and the assertion in `resolvePayerVerdict` would say so rather than shrug.
 *
 * The contract is `packages/contracts/test/live/SourceRelay.sol`, already deployed
 * to Sepolia for the live negative-path suite. It is reused rather than replaced:
 * Tab deploys exactly one contract to a Source Chain and a second would
 * misrepresent the deployment surface.
 *
 * Requirements: 8.1, 8.2, 8.3
 */

import { Interface, JsonRpcProvider, Wallet } from "ethers";

import type { Address, Result } from "@tabai/shared";
import { err, ok } from "@tabai/shared";

import { boundAgentOf, readLedger } from "../chain.js";
import { awaitSettlementCredit, locateSettlement } from "../settlement.js";
import type { AgentIdentity } from "../cast.js";
import { diffLedger, resolvePayerVerdict } from "../ledger.js";
import { describeDelta, describeVerdict, formatBaseUnits, shortAddress } from "../narrate.js";
import { ethereumRoleFor } from "../secrets.js";
import { type Act, type ActContext, type ActOutcome } from "./index.js";

/** The one function this act calls. The relay's other two shapes belong to the live suite. */
export const SOURCE_RELAY_ABI = [
  "function relay(address asset, address to, uint256 amount)",
] as const;

export const SOURCE_RELAY_INTERFACE = new Interface([...SOURCE_RELAY_ABI]);

/** Stated, not estimated. A `transfer` out of a contract, with room for a cold recipient slot. */
export const RELAY_GAS_LIMIT = 120_000n;

/** The two roles this act needs filled, and by different agents. */
export interface SmartAccountCasting {
  /** Holds the Asset. Its address is `topics[1]`. */
  readonly holder: AgentIdentity;
  /** Sends the transaction. Its address is `from`. */
  readonly sender: AgentIdentity;
  readonly smartAccount: Address;
}

/**
 * Picks who plays which part, or explains why the act cannot be staged.
 *
 * Pure. The refusals matter as much as the success: an act that ran with both
 * roles played by one Agent would print a passing verdict that proved nothing,
 * which is worse than not running.
 */
export function castSmartAccount(
  agents: readonly AgentIdentity[],
): Result<SmartAccountCasting> {
  const holders = agents.filter((agent) => agent.smartAccount !== undefined);
  if (holders.length === 0) {
    return err({
      category: "VALIDATION",
      code: "DEMO_NO_SMART_ACCOUNT",
      message:
        "no Agent in the cast has a smart account, so no transaction can separate topics[1] from the sender",
      retryable: false,
    });
  }
  if (holders.length > 1) {
    return err({
      category: "VALIDATION",
      code: "DEMO_TOO_MANY_SMART_ACCOUNTS",
      message:
        "more than one Agent has a smart account, so which Agent plays the sender is ambiguous",
      retryable: false,
    });
  }
  const holder = holders[0] as AgentIdentity;
  const sender = agents.find((agent) => agent.creditcoin !== holder.creditcoin);
  if (sender === undefined) {
    return err({
      category: "VALIDATION",
      code: "DEMO_NO_DISTINCT_SENDER",
      message:
        "the only Agent in the cast holds the smart account, so nobody distinct is left to send the transaction",
      retryable: false,
    });
  }
  return ok({ holder, sender, smartAccount: holder.smartAccount as Address });
}

const ZERO = "0x0000000000000000000000000000000000000000";

export const smartAccountAct: Act = {
  id: "smart-account",
  number: 4,
  title: "The account that pays is not the account that sends",
  synopsis:
    "A smart account holding USDC settles on one Agent's behalf while a different Agent's wallet sends the transaction. Credit must land on the Agent in topics[1] and on nobody else.",

  async run(context: ActContext): Promise<Result<ActOutcome>> {
    const { cast, providers, options, log } = context;

    const casting = castSmartAccount(cast.agents);
    if (!casting.ok) return casting;
    const { holder, sender, smartAccount } = casting.value;

    const boundHolder = await boundAgentOf(providers, cast, smartAccount);
    const boundSender = await boundAgentOf(providers, cast, sender.ethereum);

    log(`  topics[1] will be ${smartAccount}`);
    log(
      `    bound to ${boundHolder === ZERO ? "nobody" : boundHolder}${boundHolder.toLowerCase() === holder.creditcoin.toLowerCase() ? `, which is ${holder.name}` : ""}`,
    );
    log(`  from will be ${sender.ethereum}`);
    log(
      `    bound to ${boundSender === ZERO ? "nobody" : boundSender}${boundSender.toLowerCase() === sender.creditcoin.toLowerCase() ? `, which is ${sender.name}` : ""}`,
    );

    if (boundHolder.toLowerCase() !== holder.creditcoin.toLowerCase()) {
      return err({
        category: "VALIDATION",
        code: "DEMO_SMART_ACCOUNT_UNBOUND",
        message: `${smartAccount} is not bound to ${holder.name}, so a Settlement it makes credits nobody and the act would prove nothing`,
        retryable: false,
      });
    }
    if (boundSender.toLowerCase() !== sender.creditcoin.toLowerCase()) {
      return err({
        category: "VALIDATION",
        code: "DEMO_SENDER_UNBOUND",
        message: `${sender.ethereum} is not bound to ${sender.name}; the negative half of this act needs the sender to be an Agent that could have been credited`,
        retryable: false,
      });
    }

    const holderBefore = await readLedger(providers, cast, holder);
    const senderBefore = await readLedger(providers, cast, sender);

    log("");
    log(
      `  ${holder.name} owes ${formatBaseUnits(holderBefore.open, cast.asset.decimals, cast.asset.symbol)}; the smart account holds ${formatBaseUnits(holderBefore.smartAccountBalance ?? 0n, cast.asset.decimals, cast.asset.symbol)}`,
    );
    log(
      `  ${sender.name} owes ${formatBaseUnits(senderBefore.open, cast.asset.decimals, cast.asset.symbol)} across ${String(senderBefore.historyCount)} settlement history entries`,
    );

    if ((holderBefore.smartAccountBalance ?? 0n) < options.amount) {
      return err({
        category: "VALIDATION",
        code: "DEMO_SMART_ACCOUNT_UNDERFUNDED",
        message: `${smartAccount} holds less than the ${String(options.amount)} base units this act would move`,
        retryable: false,
      });
    }

    const data = SOURCE_RELAY_INTERFACE.encodeFunctionData("relay", [
      cast.asset.address,
      cast.collectionAddress,
      options.amount,
    ]);

    if (!options.broadcast) {
      await providers.source.call({ to: smartAccount, data, from: sender.ethereum });
      log("");
      log(
        `  simulated: ${shortAddress(sender.ethereum)} would call relay(${shortAddress(cast.asset.address)}, ${shortAddress(cast.collectionAddress)}, ${String(options.amount)})`,
      );
      log(`  it would credit ${holder.name} and leave ${sender.name} untouched`);
      return ok({
        act: "smart-account",
        ok: true,
        broadcast: false,
        summary: "simulated the smart-account Settlement without sending it",
        detail: {
          smartAccount,
          topicAgent: holder.creditcoin,
          senderAddress: sender.ethereum,
          senderAgent: sender.creditcoin,
          amount: options.amount.toString(),
        },
      });
    }

    const key = context.secrets.keyFor(
      ethereumRoleFor(cast.agents.findIndex((candidate) => candidate.name === sender.name)),
    );
    if (!key.ok) return key;
    const wallet = new Wallet(key.value, providers.source as JsonRpcProvider);
    if (wallet.address.toLowerCase() !== sender.ethereum.toLowerCase()) {
      return err({
        category: "VALIDATION",
        code: "DEMO_KEY_IS_NOT_THE_SENDER",
        message: `the Source Chain key configured for ${sender.name} controls ${wallet.address}, not ${sender.ethereum}`,
        retryable: false,
      });
    }

    const sent = await wallet.sendTransaction({ to: smartAccount, data, gasLimit: options.gas ?? RELAY_GAS_LIMIT });
    log("");
    log(`  ${sender.name}'s wallet submitted ${sent.hash}`);
    const receipt = await sent.wait();
    if (receipt === null || receipt.status !== 1) {
      return err({
        category: "CHAIN",
        code: "DEMO_RELAY_REVERTED",
        message: `the smart account refused the transfer in ${sent.hash}`,
        retryable: false,
      });
    }

    // The evidence, read off the receipt rather than assumed: the Settlement log's
    // topics[1] is the smart account and the transaction's from is somebody else.
    const located = locateSettlement(cast, receipt);
    if (!located.ok) return located;
    const { replayKey, payerTopic } = located.value;

    log(`    from       ${receipt.from}`);
    log(`    topics[1]  ${payerTopic}`);
    const diverge = payerTopic.toLowerCase() !== receipt.from.toLowerCase();
    log(
      `    the two ${diverge ? "differ, which is the whole point of this act" : "do not differ, so the act proves nothing"}`,
    );
    if (!diverge) {
      return err({
        category: "VALIDATION",
        code: "DEMO_PAYER_DID_NOT_DIVERGE",
        message:
          "topics[1] and the transaction sender are the same address, so this transaction cannot distinguish the two rules",
        retryable: false,
      });
    }
    log(`    replay key ${replayKey}`);

    const credit = await awaitSettlementCredit(providers, cast, replayKey, {
      seconds: options.waitSeconds,
      log,
    });
    const attribution =
      credit.creditedAgent === undefined
        ? undefined
        : {
            creditedAgent: credit.creditedAgent,
            applied: credit.applied ?? 0n,
            toPrepaid: credit.toPrepaid ?? 0n,
            coveredByClearing: credit.coveredByClearing ?? 0n,
          };

    const holderAfter = await readLedger(providers, cast, holder);
    const senderAfter = await readLedger(providers, cast, sender);
    const holderDelta = diffLedger(holderBefore, holderAfter);
    const senderDelta = diffLedger(senderBefore, senderAfter);

    log("");
    for (const line of describeDelta(holder.name, holderDelta, cast.asset.decimals, cast.asset.symbol)) log(line);
    for (const line of describeDelta(sender.name, senderDelta, cast.asset.decimals, cast.asset.symbol)) log(line);
    log("");
    log(
      "  those readings are colour, not evidence: a window can hold Settlements this transaction did not cause. The verdict below reads this Settlement's own event.",
    );

    if (attribution === undefined) {
      log("");
      log(
        `  the Watcher had not proved this Settlement after ${String(Math.round(credit.waitedMs / 1000))}s, so no verdict can be given yet. Run the Watcher pipeline and run this act again with --wait raised.`,
      );
      return ok({
        act: "smart-account",
        ok: false,
        broadcast: true,
        summary: "the Settlement was sent but is not yet proven, so no verdict can be given",
        detail: {
          sourceTxHash: sent.hash,
          from: receipt.from,
          topicOne: payerTopic,
          replayKey,
          smartAccount,
          waitedMs: credit.waitedMs,
        },
      });
    }

    log(
      `  TabBook credited ${attribution.creditedAgent} for ${replayKey}: ${String(attribution.applied)} against the Open Tab, ${String(attribution.toPrepaid)} banked as prepaid credit, ${String(attribution.coveredByClearing)} already covered by the Provisional Clearing this confirmed`,
    );

    const resolution = resolvePayerVerdict({
      topicAgent: { name: holder.name, creditcoin: holder.creditcoin },
      senderAgent: { name: sender.name, creditcoin: sender.creditcoin },
      amount: options.amount,
      attribution: { replayKey, ...attribution },
    });

    log("");
    for (const line of describeVerdict(resolution)) log(line);

    return ok({
      act: "smart-account",
      ok: resolution.verdict === "PASS",
      broadcast: true,
      summary:
        resolution.verdict === "PASS"
          ? `credit for ${replayKey} landed on ${holder.name}, bound to topics[1], and not on ${sender.name}, who sent the transaction`
          : `payer resolution failed: ${resolution.reasons.join("; ")}`,
      detail: {
        sourceTxHash: sent.hash,
        from: receipt.from,
        topicOne: payerTopic,
        replayKey,
        smartAccount,
        amount: options.amount.toString(),
        topicAgent: holder.creditcoin,
        senderAgent: sender.creditcoin,
        attribution: {
          creditedAgent: attribution.creditedAgent,
          applied: attribution.applied.toString(),
          toPrepaid: attribution.toPrepaid.toString(),
          coveredByClearing: attribution.coveredByClearing.toString(),
        },
        resolution,
        holderDelta: {
          open: holderDelta.open.toString(),
          prepaid: holderDelta.prepaid.toString(),
          historyCount: holderDelta.historyCount,
        },
        senderDelta: {
          open: senderDelta.open.toString(),
          prepaid: senderDelta.prepaid.toString(),
          historyCount: senderDelta.historyCount,
        },
      },
    });
  },
};
