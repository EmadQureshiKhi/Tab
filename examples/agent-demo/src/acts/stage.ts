/**
 * Act zero. Who is on stage, and is anything missing.
 *
 * A demo that fails halfway through because one address was never bound teaches
 * the reader nothing except that somebody's `.env` was wrong. This act reads
 * every precondition the other four acts depend on, prints them as a table, and
 * names each one that is not met together with the act it would have broken.
 *
 * It writes nothing and needs no key, which is deliberate: the readiness of this
 * deployment is a public fact, and anybody with the repository and an RPC URL can
 * check it without being trusted with anything.
 */

import type { Result } from "@tabai/shared";
import { ok } from "@tabai/shared";

import type { AgentIdentity } from "../cast.js";
import { boundAgentOf, readLedger } from "../chain.js";
import { formatBaseUnits, shortAddress } from "../narrate.js";
import type { Act, ActContext, ActOutcome } from "./index.js";

/** One precondition, as a fact rather than a sentence. */
export interface Precondition {
  /** Short identifier, stable enough to grep a log for. */
  readonly id: string;
  /** Which act needs it. Zero means the demo cannot start at all. */
  readonly neededByAct: number;
  readonly met: boolean;
  /** What was found. */
  readonly found: string;
  /** What to do about it, when it is not met. */
  readonly remedy?: string;
}

export interface Readiness {
  readonly ready: boolean;
  /** The lowest act number blocked by an unmet precondition, or undefined when all hold. */
  readonly firstBlockedAct?: number;
  readonly unmet: readonly Precondition[];
}

/**
 * Reduces the facts to a verdict.
 *
 * Pure, and the reason it is separate from the reads above it: the interesting
 * behaviour is which act a missing binding blocks, and that is worth testing
 * without a chain.
 */
export function assessReadiness(preconditions: readonly Precondition[]): Readiness {
  const unmet = preconditions.filter((precondition) => !precondition.met);
  if (unmet.length === 0) return { ready: true, unmet: [] };
  const firstBlockedAct = unmet.reduce(
    (lowest, precondition) => Math.min(lowest, precondition.neededByAct),
    Number.POSITIVE_INFINITY,
  );
  return { ready: false, firstBlockedAct, unmet };
}

const ZERO = "0x0000000000000000000000000000000000000000";

export const stageAct: Act = {
  id: "stage",
  number: 0,
  title: "The stage",
  synopsis:
    "Reads every precondition the other acts depend on and names each one that is not met. Writes nothing, needs no key.",

  async run(context: ActContext): Promise<Result<ActOutcome>> {
    const { cast, providers, log } = context;
    const preconditions: Precondition[] = [];

    log(`  Service ${cast.serviceId}`);
    log(`  Asset   ${formatBaseUnits(0n, cast.asset.decimals, cast.asset.symbol).split(" ")[1] ?? ""} at ${cast.asset.address} on chainKey ${cast.asset.chainKey.toString()}`);
    log(`  Tab collection ${cast.collectionAddress}`);
    log("");

    for (const [index, agent] of cast.agents.entries()) {
      const ledger = await readLedger(providers, cast, agent);
      const boundWallet = await boundAgentOf(providers, cast, agent.ethereum);
      const walletBound = boundWallet.toLowerCase() === agent.creditcoin.toLowerCase();

      log(`  ${agent.name}, ${agent.role}`);
      log(`    rail identity     ${agent.creditcoin}`);
      log(`    source wallet     ${agent.ethereum} holding ${formatBaseUnits(ledger.walletBalance, cast.asset.decimals, cast.asset.symbol)}`);
      log(`    open tab          ${formatBaseUnits(ledger.open, cast.asset.decimals, cast.asset.symbol)}`);
      log(`    prepaid credit    ${formatBaseUnits(ledger.prepaid, cast.asset.decimals, cast.asset.symbol)}`);
      log(`    deliveries        ${String(ledger.deliveryCount)}`);
      log(`    history entries   ${String(ledger.historyCount)}`);
      log(
        `    authorisation     ${ledger.authorised ? `${formatBaseUnits(ledger.authorisationCeiling - ledger.authorisationSpent, cast.asset.decimals, cast.asset.symbol)} of ceiling remaining, expiring ${new Date(ledger.authorisationExpiry * 1000).toISOString()}` : "none"}`,
      );

      preconditions.push({
        id: `${agent.name.toLowerCase()}-wallet-bound`,
        neededByAct: 3,
        met: walletBound,
        found: walletBound
          ? `${shortAddress(agent.ethereum)} is bound to ${agent.name}`
          : boundWallet === ZERO
            ? `${shortAddress(agent.ethereum)} is bound to nobody`
            : `${shortAddress(agent.ethereum)} is bound to ${shortAddress(boundWallet)}, not to ${agent.name}`,
        remedy: `run the bind act for ${agent.name}, which requests a binding and prints the exact amount to send`,
      });

      preconditions.push({
        id: `${agent.name.toLowerCase()}-can-settle`,
        neededByAct: 3,
        met: ledger.walletBalance > 0n,
        found: `${shortAddress(agent.ethereum)} holds ${formatBaseUnits(ledger.walletBalance, cast.asset.decimals, cast.asset.symbol)}`,
        remedy: `fund ${agent.name}'s source wallet with ${cast.asset.symbol} before act three`,
      });

      preconditions.push({
        id: `${agent.name.toLowerCase()}-creditcoin-key`,
        neededByAct: 1,
        met: context.secrets.has(index === 0 ? "agent-one-creditcoin" : "agent-two-creditcoin"),
        found: context.secrets.has(index === 0 ? "agent-one-creditcoin" : "agent-two-creditcoin")
          ? "present"
          : "absent",
        remedy: `set the private key for ${agent.name}'s rail identity to broadcast act one`,
      });

      if (agent.smartAccount !== undefined) {
        const boundSmart = await boundAgentOf(providers, cast, agent.smartAccount);
        const smartBound = boundSmart.toLowerCase() === agent.creditcoin.toLowerCase();
        log(
          `    smart account     ${agent.smartAccount} holding ${formatBaseUnits(ledger.smartAccountBalance ?? 0n, cast.asset.decimals, cast.asset.symbol)}`,
        );
        preconditions.push({
          id: `${agent.name.toLowerCase()}-smart-account-bound`,
          neededByAct: 4,
          met: smartBound,
          found: smartBound
            ? `${shortAddress(agent.smartAccount)} is bound to ${agent.name}`
            : boundSmart === ZERO
              ? `${shortAddress(agent.smartAccount)} is bound to nobody`
              : `${shortAddress(agent.smartAccount)} is bound to ${shortAddress(boundSmart)}, not to ${agent.name}`,
          remedy: `run the bind act for ${agent.name}'s smart account; act four cannot make its claim until topics[1] resolves to an Agent`,
        });
        preconditions.push({
          id: `${agent.name.toLowerCase()}-smart-account-funded`,
          neededByAct: 4,
          met: (ledger.smartAccountBalance ?? 0n) >= context.options.amount,
          found: `${shortAddress(agent.smartAccount)} holds ${formatBaseUnits(ledger.smartAccountBalance ?? 0n, cast.asset.decimals, cast.asset.symbol)}`,
          remedy: `send at least ${formatBaseUnits(context.options.amount, cast.asset.decimals, cast.asset.symbol)} to the smart account, which is the account that pays in act four`,
        });
      }
      log("");
    }

    const otherAgent = cast.agents.find((candidate: AgentIdentity) => candidate.smartAccount === undefined);
    preconditions.push({
      id: "smart-account-sender-differs",
      neededByAct: 4,
      met: otherAgent !== undefined && cast.agents.some((candidate) => candidate.smartAccount !== undefined),
      found:
        otherAgent === undefined
          ? "both agents carry a smart account, so no Agent is left to send act four's transaction"
          : "one Agent holds the Asset in a smart account and the other sends the transaction",
      remedy: "give exactly one Agent a smart account; the divergence act four asserts needs both roles filled by different agents",
    });

    const readiness = assessReadiness(preconditions);
    if (readiness.ready) {
      log("  every precondition holds; all four acts can run");
    } else {
      log(`  ${String(readiness.unmet.length)} precondition(s) not met, first blocking act ${String(readiness.firstBlockedAct)}:`);
      for (const precondition of readiness.unmet) {
        log(`    - ${precondition.id} (act ${String(precondition.neededByAct)}): ${precondition.found}`);
        if (precondition.remedy !== undefined) log(`      remedy: ${precondition.remedy}`);
      }
    }

    return ok({
      act: "stage",
      ok: readiness.ready,
      broadcast: false,
      summary: readiness.ready
        ? "every precondition holds"
        : `${String(readiness.unmet.length)} precondition(s) not met, first blocking act ${String(readiness.firstBlockedAct)}`,
      detail: { preconditions, readiness },
    });
  },
};
