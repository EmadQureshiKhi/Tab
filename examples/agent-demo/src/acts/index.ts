/**
 * The story, in acts.
 *
 * An act is a scene with a precondition, one kind of movement, and a reading
 * before and after it. They are ordered but not chained: each one reads the chain
 * for its own preconditions rather than trusting a value the previous act left in
 * memory, so any act can be run alone against a rail somebody else moved.
 *
 * **Nothing broadcasts without `--broadcast`.** Every act's default is to read the
 * chain, simulate whatever it would submit, and print what would change. That is
 * not caution for its own sake: a refused `recordDelivery` costs real CTC and
 * returns the same revert data a free `eth_call` returns, so paying for it first
 * would be paying for information already available.
 */

import type { Result } from "@tabai/shared";

import type { AgentIdentity, Cast } from "../cast.js";
import type { DemoProviders } from "../chain.js";
import type { DemoSecrets } from "../secrets.js";

/** What a run was asked to do, after argv was parsed. */
export interface DemoOptions {
  /** Submit transactions. Without it every act reads and simulates only. */
  readonly broadcast: boolean;
  /** Restrict the act to one Agent by short name. */
  readonly onlyAgent?: string;
  /** Units of the priced tool to buy in act two. */
  readonly units: number;
  /** Base units to settle in acts three and four. */
  readonly amount: bigint;
  /** Ceiling to grant in act one, in Asset base units. */
  readonly ceiling: bigint;
  /** Seconds from now that act one's authorisation expires. */
  readonly ttlSeconds: number;
  /** Override for a stated gas limit. */
  readonly gas?: bigint;
  /** How long an act will wait for the Watcher to prove a Settlement, in seconds. */
  readonly waitSeconds: number;
}

/** Everything an act is handed. */
export interface ActContext {
  readonly cast: Cast;
  readonly providers: DemoProviders;
  readonly options: DemoOptions;
  readonly secrets: DemoSecrets;
  /** Narration. Goes to stderr, so stdout stays a machine-readable result. */
  readonly log: (line: string) => void;
}

/** What an act reports when it finishes. */
export interface ActOutcome {
  readonly act: string;
  /** True when the act's own claim held. A read-only pass that found nothing wrong is true. */
  readonly ok: boolean;
  /** Whether anything was actually submitted. */
  readonly broadcast: boolean;
  /** One line for a human. */
  readonly summary: string;
  /** Whatever the act wants on stdout, as JSON. */
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface Act {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly synopsis: string;
  run(context: ActContext): Promise<Result<ActOutcome>>;
}

/** The agents this run should act for, in narration order. */
export function agentsInScope(cast: Cast, options: DemoOptions): readonly AgentIdentity[] {
  if (options.onlyAgent === undefined) return cast.agents;
  const wanted = options.onlyAgent.trim().toLowerCase();
  return cast.agents.filter((agent) => agent.name.toLowerCase() === wanted);
}
