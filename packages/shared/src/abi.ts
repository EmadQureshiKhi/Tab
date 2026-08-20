/**
 * Contract interface constants shared by the contracts, the Watcher, the SDK,
 * and the Dashboard.
 *
 * ## Why this file holds signatures and not ABIs yet
 *
 * No Tab contract compiles yet, so there is nothing to generate an ABI from.
 * Hand-written ABI arrays for `SettlementVerifier`, `TabBook`, `ServiceRegistry`,
 * `AgentRegistry`, `Bond`, or `TabSettlement` would be a second, drifting source
 * of truth — precisely what this package exists to prevent. So this module holds
 * only what is already fixed and independently checkable, and the ABI arrays
 * arrive by generation.
 *
 * ## Generation path
 *
 * ```text
 * packages/contracts  --forge build-->  out/<Name>.sol/<Name>.json  --.abi-->  src/abi.generated.ts
 * ```
 *
 * `packages/contracts/out/<Name>.sol/<Name>.json` carries the compiler's own
 * `abi` array. A generator script reads those artefacts and writes
 * `src/abi.generated.ts`, which this module then re-exports. Nothing is
 * transcribed by hand at any point.
 *
 * Task 12.1 owns that step: it implements the deployment scripts, which is the
 * first point at which every contract in `packages/contracts` compiles and the
 * full artefact set exists. Task 12.2 records the deployed addresses in
 * `deployments.json`, which stays the source of addresses — addresses are
 * deployment output and do not belong in a generated ABI module.
 *
 * ## Precompile addresses
 *
 * They live in `chains.ts` as `PRECOMPILES`, next to the rest of the chain-level
 * constants. This module deliberately keeps no second copy.
 *
 * Requirements: 18.1
 */

import { keccak256Ascii } from "./keccak256.js";
import type { Bytes32 } from "./hex.js";

/**
 * Canonical event signatures — the exact strings the topic hash is taken over.
 * No spaces, no parameter names, canonical types.
 */
export const EVENT_SIGNATURES = {
  /**
   * ERC-20 `Transfer`, the Settlement surface on chainKey 3, where Tab deploys
   * no contract at all.
   *
   * Topic layout: `topics[1]` is the payer, `topics[2]` is the recipient, and
   * `data` carries the amount. The payer is read from `topics[1]` and never from
   * the transaction sender, so a relayer paying gas cannot be credited.
   */
  Transfer: "Transfer(address,address,uint256)",

  /**
   * `TabSettled(address agent, address service, uint256 amount, bytes32 tabId)`
   * with `agent`, `service`, and `tabId` indexed — the Settlement surface on
   * chainKey 1.
   *
   * Topic layout: `topics[1]` is the agent, `topics[2]` is the Service
   * Collection Address, `topics[3]` is the tabId, and `data` carries the amount.
   * Three indexed parameters leave `amount` as the only unindexed one, which is
   * what puts the agent in `topics[1]`.
   */
  TabSettled: "TabSettled(address,address,uint256,bytes32)",
} as const;

/** Name of an event whose signature this module pins. */
export type EventName = keyof typeof EVENT_SIGNATURES;

/**
 * `topics[0]` for each pinned event: the Keccak-256 hash of its canonical
 * signature. Derived rather than transcribed, so a signature edit cannot leave a
 * stale hash behind.
 */
export const EVENT_TOPIC0: Readonly<Record<EventName, Bytes32>> = {
  Transfer: keccak256Ascii(EVENT_SIGNATURES.Transfer),
  TabSettled: keccak256Ascii(EVENT_SIGNATURES.TabSettled),
};

/** `topics[0]` for a pinned event. */
export const eventTopic0 = (name: EventName): Bytes32 => EVENT_TOPIC0[name];

/** The index within `topics` at which each pinned event carries the payer. */
export const PAYER_TOPIC_INDEX = 1 as const;
