/**
 * Waiting for the other half of the rail.
 *
 * A Settlement is broadcast on the Source Chain and becomes credit on Creditcoin
 * only after the Watcher observes it, waits for the height to be attested, folds
 * a Continuity Proof and submits it. Nothing in this package does any of that, and
 * nothing here tries to hurry it. These helpers only watch the Creditcoin ledger
 * and report the moment it changes, so the demo can tell a continuous story
 * instead of ending on "now go and run the Watcher".
 *
 * The timeout is generous and it is not a failure. Attestation lands on a
 * ten-block stride, so a Settlement can wait minutes through no fault of anyone,
 * and an act that gave up says so as an unfinished act rather than a broken one.
 */

import type { AgentIdentity, Cast } from "./cast.js";
import type { DemoProviders } from "./chain.js";
import { readLedger } from "./chain.js";
import type { AgentLedger } from "./ledger.js";

/** How the wait ended. */
export type WaitOutcome = "OBSERVED" | "TIMED_OUT";

export interface WaitResult {
  readonly outcome: WaitOutcome;
  readonly ledger: AgentLedger;
  readonly polls: number;
  readonly elapsedMs: number;
  /** Readings that failed on the transport and were retried. */
  readonly readFailures: number;
}

export interface WaitOptions {
  readonly seconds: number;
  /** Seconds between readings. Six is a little under one Creditcoin block. */
  readonly intervalSeconds?: number;
  readonly log?: (line: string) => void;
  /** Injected so a test does not sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected so a test does not depend on the wall clock. */
  readonly now?: () => number;
  /**
   * The reader. Defaults to {@link readLedger}.
   *
   * Injectable so the loop itself is what a test exercises. A test that
   * reimplemented the loop against a stub would assert that the test's copy
   * behaves, which is the one thing nobody needs to know.
   */
  readonly read?: (
    providers: DemoProviders,
    cast: Cast,
    agent: AgentIdentity,
  ) => Promise<AgentLedger>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Reads the Agent's ledger until `settled` says the thing arrived, or time runs out.
 *
 * Always reads at least once, before any sleeping, so a change that had already
 * landed is reported immediately rather than after one interval.
 */
export async function waitForLedger(
  providers: DemoProviders,
  cast: Cast,
  agent: AgentIdentity,
  settled: (ledger: AgentLedger) => boolean,
  options: WaitOptions,
): Promise<WaitResult> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const read = options.read ?? readLedger;
  const intervalMs = (options.intervalSeconds ?? 6) * 1000;
  const startedAt = now();
  const deadline = startedAt + options.seconds * 1000;

  let polls = 0;
  let readFailures = 0;
  let lastLedger: AgentLedger | undefined;

  for (;;) {
    // A wait can run for twenty minutes across two public RPCs, and one of them
    // timing out is an ordinary event over that span. A transient read must not
    // end the wait: the whole point of the deadline is that it, and nothing else,
    // decides when to stop. An earlier version let a single `request timeout`
    // throw out of a real run that had already broadcast its Settlement.
    let ledger: AgentLedger;
    try {
      ledger = await read(providers, cast, agent);
    } catch (error) {
      readFailures += 1;
      if (now() >= deadline) break;
      options.log?.(`    a reading failed and will be retried: ${String(error)}`);
      await sleep(intervalMs);
      continue;
    }

    lastLedger = ledger;
    polls += 1;
    if (settled(ledger)) {
      return { outcome: "OBSERVED", ledger, polls, elapsedMs: now() - startedAt, readFailures };
    }
    if (now() >= deadline) {
      return { outcome: "TIMED_OUT", ledger, polls, elapsedMs: now() - startedAt, readFailures };
    }
    options.log?.(
      `    waiting for the Watcher to prove it, ${String(polls)} readings so far, block ${String(ledger.atBlock)}`,
    );
    await sleep(intervalMs);
  }

  // Every reading failed and the deadline passed, so there is nothing to report a
  // state from. One last attempt, and if that fails too the transport error is the
  // honest answer rather than a fabricated reading.
  const final = lastLedger ?? (await read(providers, cast, agent));
  return { outcome: "TIMED_OUT", ledger: final, polls, elapsedMs: now() - startedAt, readFailures };
}

/** Settled once the Agent's settlement history has grown past a known count. */
export const historyPast = (count: number) => (ledger: AgentLedger) => ledger.historyCount > count;

/** How a {@link waitFor} poll ended, and what it produced. */
export interface WaitForResult<T> {
  readonly outcome: WaitOutcome;
  /** The value, once the producer returned one. Undefined on a timeout. */
  readonly value: T | undefined;
  readonly polls: number;
  readonly elapsedMs: number;
  readonly readFailures: number;
}

/**
 * Polls `produce` until it returns something, or until time runs out.
 *
 * The general form of {@link waitForLedger}, and the one an act should reach for
 * when what it is waiting for is a specific fact rather than a change in a
 * balance. Act four learned that distinction the hard way: it waited on the
 * holder's settlement history count, which rose because an *unrelated* Settlement
 * of the holder's was proved first, and then gave up on its own Settlement twenty
 * minutes early. Waiting for the exact thing the verdict reads removes a whole
 * class of that mistake.
 *
 * Transient read failures are retried, for the same reason they are in
 * {@link waitForLedger}: over twenty minutes across two public RPCs, one timing
 * out is ordinary and the deadline should be the only thing that stops the wait.
 */
export async function waitFor<T>(
  produce: () => Promise<T | undefined>,
  options: WaitOptions & { readonly describe?: (polls: number) => string },
): Promise<WaitForResult<T>> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const intervalMs = (options.intervalSeconds ?? 6) * 1000;
  const startedAt = now();
  const deadline = startedAt + options.seconds * 1000;

  let polls = 0;
  let readFailures = 0;
  for (;;) {
    let value: T | undefined;
    try {
      value = await produce();
    } catch (error) {
      readFailures += 1;
      if (now() >= deadline) break;
      options.log?.(`    a reading failed and will be retried: ${String(error)}`);
      await sleep(intervalMs);
      continue;
    }
    polls += 1;
    if (value !== undefined) {
      return { outcome: "OBSERVED", value, polls, elapsedMs: now() - startedAt, readFailures };
    }
    if (now() >= deadline) break;
    options.log?.(
      options.describe?.(polls) ??
        `    waiting for the Watcher to prove it, ${String(polls)} readings so far`,
    );
    await sleep(intervalMs);
  }
  return { outcome: "TIMED_OUT", value: undefined, polls, elapsedMs: now() - startedAt, readFailures };
}
