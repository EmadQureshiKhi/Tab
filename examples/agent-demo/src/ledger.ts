/**
 * What the rail says about an Agent at one moment, and what changed between two.
 *
 * The demo's claims are all differences: a tab rose because a delivery was
 * recorded, a tab fell because a Settlement was proven, a Bond grew because a
 * deposit was proven. So the unit this file works in is a **pair** of readings,
 * and every act is bracketed by one.
 *
 * Reading is in `chain.ts`. Everything here is pure, including
 * {@link resolvePayerVerdict}, which is the assertion requirement 8 turns on: it
 * takes two before-and-after pairs and decides whether the credit landed on the
 * Agent bound to `topics[1]` rather than on the Agent that sent the transaction.
 * Keeping it pure is not tidiness. It is the difference between a claim that is
 * tested and a claim that is only ever observed once, live, by whoever happened
 * to be watching the console.
 *
 * Requirements: 8.1, 8.2, 8.3, 12.1, 12.5, 22.4
 */

import type { Address, Bytes32 } from "@tabai/shared";

/** One reading of everything the rail holds about one Agent, for one Asset. */
export interface AgentLedger {
  readonly agent: Address;
  readonly tabId: Bytes32;
  /** Open Tab in Asset base units: what is owed and unsettled. */
  readonly open: bigint;
  /** Non-refundable prepaid credit banked by an over-payment. (R12.5) */
  readonly prepaid: bigint;
  /** Monotonic count of deliveries recorded on this tab. */
  readonly deliveryCount: number;
  /** Ceiling of the spending authorisation, or zero when there is none. */
  readonly authorisationCeiling: bigint;
  /** Cumulative charged under that authorisation. */
  readonly authorisationSpent: bigint;
  /** Unix seconds after which no delivery may be recorded, or zero for none. */
  readonly authorisationExpiry: number;
  /** Whether an authorisation record exists at all, as against one with a zero ceiling. */
  readonly authorised: boolean;
  /** Settlement history entries counted by the rolling on-chain commitment. */
  readonly historyCount: number;
  readonly historyCommitment: Bytes32;
  /** Asset balance of the Agent's bound Source Chain wallet, in base units. */
  readonly walletBalance: bigint;
  /** Asset balance of the Agent's bound smart account, when it has one. */
  readonly smartAccountBalance?: bigint;
  /** Block the Creditcoin half of this reading was pinned to. */
  readonly atBlock: number;
}

/** Signed field-by-field difference between two readings of the same Agent. */
export interface LedgerDelta {
  readonly agent: Address;
  readonly open: bigint;
  readonly prepaid: bigint;
  readonly deliveryCount: number;
  readonly authorisationSpent: bigint;
  readonly historyCount: number;
  readonly walletBalance: bigint;
  readonly smartAccountBalance: bigint;
  /** True when nothing at all moved. */
  readonly quiet: boolean;
}

/**
 * Differences two readings of one Agent.
 *
 * Refuses across agents rather than returning a meaningless difference: two
 * readings of different agents have no difference, and returning zeroes for a
 * mismatched pair would make a failed assertion look like a passing one.
 */
export function diffLedger(before: AgentLedger, after: AgentLedger): LedgerDelta {
  if (before.agent.toLowerCase() !== after.agent.toLowerCase()) {
    throw new Error(
      `diffLedger was given readings of two different agents, ${before.agent} and ${after.agent}`,
    );
  }
  const open = after.open - before.open;
  const prepaid = after.prepaid - before.prepaid;
  const deliveryCount = after.deliveryCount - before.deliveryCount;
  const authorisationSpent = after.authorisationSpent - before.authorisationSpent;
  const historyCount = after.historyCount - before.historyCount;
  const walletBalance = after.walletBalance - before.walletBalance;
  const smartAccountBalance = (after.smartAccountBalance ?? 0n) - (before.smartAccountBalance ?? 0n);
  return {
    agent: after.agent,
    open,
    prepaid,
    deliveryCount,
    authorisationSpent,
    historyCount,
    walletBalance,
    smartAccountBalance,
    quiet:
      open === 0n &&
      prepaid === 0n &&
      deliveryCount === 0 &&
      authorisationSpent === 0n &&
      historyCount === 0 &&
      walletBalance === 0n &&
      smartAccountBalance === 0n,
  };
}


/**
 * How the rail attributed one Settlement, read from the chain rather than inferred.
 *
 * `TabBook.SettlementApplied` carries the replay key and the credited Agent in
 * indexed topics, so this is the rail stating in public which Agent one specific
 * Settlement paid for. It is the only honest basis for requirement 8's claim:
 * a before-and-after reading of two tabs cannot tell this Settlement apart from
 * any other that landed in the same window, and an earlier version of this demo
 * duly failed itself when the sending Agent's own unrelated Settlement was proved
 * while act four was waiting.
 */
export interface PayerAttribution {
  /** The identity of the Settlement: `(chainKey, blockHeight, txIndex, logIndex)` packed. */
  readonly replayKey: Bytes32;
  /** The Agent named in the event, which is the Agent the rail credited. */
  readonly creditedAgent: Address;
  /** Base units applied against the Open Tab. */
  readonly applied: bigint;
  /** Base units banked as prepaid credit once the tab was clear. */
  readonly toPrepaid: bigint;
  /**
   * Base units a Provisional Clearing had already taken off the tab.
   *
   * Not double counting. When a clearing covered the tab, the confirming branch
   * emits `applied = 0` and banks only the excess, because the covered part came
   * off the Open Tab at clearing time against pledged Bond. The three figures sum
   * to the amount moved on either path.
   */
  readonly coveredByClearing: bigint;
}

/** The two agents an act four transaction names, and how the rail attributed it. */
export interface PayerResolutionInput {
  /** The Agent bound to the address in `topics[1]`, which held the Asset. */
  readonly topicAgent: { readonly name: string; readonly creditcoin: Address };
  /** The Agent bound to the address that sent the transaction. */
  readonly senderAgent: { readonly name: string; readonly creditcoin: Address };
  /** Amount moved on the Source Chain, in Asset base units. */
  readonly amount: bigint;
  /** What the rail said it did with that payment. */
  readonly attribution: PayerAttribution;
}

/** The verdict requirement 8 asks for, with the reasoning kept alongside it. */
export interface PayerResolution {
  readonly verdict: "PASS" | "FAIL";
  /** The topic Agent was credited, for the whole amount moved. */
  readonly creditLandedOnTopicAgent: boolean;
  /** The sending Agent was not the Agent this Settlement credited. */
  readonly senderAgentUncredited: boolean;
  /** One line per check, in the order they were made. */
  readonly reasons: readonly string[];
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Decides whether a smart-account Settlement credited the right Agent.
 *
 * Two independent claims, and both must hold. The positive one is that the Agent
 * named in this Settlement's own `SettlementApplied` event is the Agent bound to
 * `topics[1]`, and that the whole amount moved reached it, however the rail split
 * that between clearing the tab and banking prepaid credit. The negative one is
 * that the Agent bound to the transaction sender is not the Agent it credited.
 *
 * The negative claim carries most of the weight. A verifier resolving the payer
 * from the transaction sender, as the canonical base pattern does, would fail it
 * while quite possibly satisfying the positive one by accident.
 *
 * Refuses the degenerate case where both roles are the same Agent, because then
 * the two claims contradict each other and any verdict would be an artefact.
 */
export function resolvePayerVerdict(input: PayerResolutionInput): PayerResolution {
  const reasons: string[] = [];
  const { attribution: at } = input;

  if (sameAddress(input.topicAgent.creditcoin, input.senderAgent.creditcoin)) {
    return {
      verdict: "FAIL",
      creditLandedOnTopicAgent: false,
      senderAgentUncredited: false,
      reasons: [
        `the topic Agent and the sending Agent are both ${input.topicAgent.creditcoin}, so the transaction cannot distinguish them`,
      ],
    };
  }

  if (input.amount <= 0n) {
    return {
      verdict: "FAIL",
      creditLandedOnTopicAgent: false,
      senderAgentUncredited: false,
      reasons: ["the Settlement moved nothing, so there is no credit to attribute"],
    };
  }

  const credited = at.applied + at.toPrepaid + at.coveredByClearing;
  const rightAgent = sameAddress(at.creditedAgent, input.topicAgent.creditcoin);
  const wholeAmount = credited === input.amount;
  const creditLandedOnTopicAgent = rightAgent && wholeAmount;

  reasons.push(
    rightAgent
      ? `settlement ${at.replayKey} credited ${input.topicAgent.name}, the Agent bound to topics[1]`
      : `settlement ${at.replayKey} credited ${at.creditedAgent}, not ${input.topicAgent.name} who is bound to topics[1]`,
  );
  reasons.push(
    wholeAmount
      ? `the whole ${String(input.amount)} base units reached it: ${String(at.applied)} against the Open Tab, ${String(at.toPrepaid)} banked as prepaid credit, and ${String(at.coveredByClearing)} already taken off by the Provisional Clearing this confirmed`
      : `it received ${String(credited)} base units, ${String(at.applied)} against the Open Tab, ${String(at.toPrepaid)} banked and ${String(at.coveredByClearing)} covered by a clearing, against ${String(input.amount)} moved`,
  );

  const senderAgentUncredited = !sameAddress(at.creditedAgent, input.senderAgent.creditcoin);
  reasons.push(
    senderAgentUncredited
      ? `${input.senderAgent.name} sent the transaction and this Settlement credited a different Agent, so resolving the payer from the sender would have been wrong here`
      : `${input.senderAgent.name} sent the transaction and this Settlement credited ${input.senderAgent.name}, which is the payer resolved from the sender rather than from topics[1]`,
  );

  return {
    verdict: creditLandedOnTopicAgent && senderAgentUncredited ? "PASS" : "FAIL",
    creditLandedOnTopicAgent,
    senderAgentUncredited,
    reasons,
  };
}
