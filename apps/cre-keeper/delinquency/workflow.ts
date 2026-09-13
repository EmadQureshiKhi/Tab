/**
 * The CRE wiring: a cron trigger every ten minutes, two HTTP requests under
 * consensus, one secret from the Vault DON, and the tick in `tick.ts`.
 *
 * ## Why the chain write goes through the keeper
 *
 * CRE writes to a chain by generating a DON-signed report and handing it to a
 * `KeystoneForwarder`, which calls `onReport(bytes, bytes)` on a consumer
 * contract. `TabBook.markDelinquent(bytes32)` is a plain permissionless call
 * with no `onReport` entry point, so a CRE EVM write cannot reach it without
 * a receiver contract in between. Until Tab ships one, the keeper is that
 * receiver: this workflow decides which tabs to mark and asks the keeper to
 * send the marks, and the keeper simulates each one before it does. See the
 * README for how this changes once a receiver exists.
 */

import { CronCapability, HTTPClient, consensusIdenticalAggregation, handler, type HTTPSendRequester, type Runtime } from "@chainlink/cre-sdk";
import { err, ok, type Result } from "@tabai/shared";
import { z } from "zod";

import { fetchOverdue, postTick, type OverdueRead, type TickOutcome } from "./keeper-client.js";
import { runDelinquencyTick, TickFailure, type TickSummary } from "./tick.js";

export const configSchema = z.object({
  /** A 5 or 6 field cron expression. Six fields put seconds first. */
  schedule: z.string().min(1),
  /**
   * Where the keeper serves `/overdue` and `/tick`.
   *
   * Matched against a pattern rather than checked with `z.string().url()` or
   * with `new URL`, because neither works under the simulator. `url()` comes
   * from whichever Zod the WebAssembly bundle resolves, and a later major's
   * rejects a host with no dot, which rejects `http://localhost:8791`, the whole
   * staging configuration. `new URL` fails outright: the sandbox this runs in
   * has no `URL` global at all.
   *
   * A pattern is what is left, and it is enough: an absolute http or https URL
   * with a host and an optional path is exactly what the HTTP capability will
   * accept, and it says so the same way in every environment this compiles to.
   */
  keeperUrl: z.string().regex(/^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/, "must be an absolute http or https URL"),
  /** The HTTP capability's per-request timeout, as a duration string. The capability's ceiling is 10s. */
  requestTimeout: z.string().regex(/^[0-9]+(\.[0-9]+)?s$/).default("8s"),
  /** How many marks one tick asks for; the rest wait for the next tick. */
  maxMarksPerTick: z.number().int().positive().default(25),
});

export type Config = z.infer<typeof configSchema>;

/** The logical secret name in `secrets.yaml`. */
export const SECRET_ID = "KEEPER_SHARED_SECRET";

/**
 * The read, on every node, as the high-level HTTP client runs it.
 *
 * A failed `Result` is thrown here because that is the SDK's contract for a
 * node-mode function: a value is aggregated, a throw fails the tick and is
 * reported. Everything below this boundary answers with a `Result`.
 */
const readOverdueOnNode = (requester: HTTPSendRequester, keeperUrl: string, timeout: string, maxMarks: number): OverdueRead => {
  const read = fetchOverdue(requester, { keeperUrl, timeout, maxMarks });
  if (!read.ok) throw new TickFailure(read.error.code, read.error.message);
  return read.value;
};

const postTickOnNode = (requester: HTTPSendRequester, keeperUrl: string, timeout: string, secret: string, tabIds: string[]): TickOutcome => {
  const outcome = postTick(requester, { keeperUrl, timeout, secret, tabIds });
  if (!outcome.ok) throw new TickFailure(outcome.error.code, outcome.error.message);
  return outcome.value;
};

/** A thrown `TickFailure` from a node-mode function, back into a `Result` for the tick. */
const asResult = <T>(run: () => T): Result<T> => {
  try {
    return ok(run());
  } catch (error) {
    if (error instanceof TickFailure) return err({ category: "UPSTREAM", code: error.code, message: error.message, retryable: true });
    return err({ category: "UPSTREAM", code: "CRE_CAPABILITY_FAILED", message: error instanceof Error ? error.message : String(error), retryable: true });
  }
};

export const onCronTrigger = (runtime: Runtime<Config>): TickSummary => {
  const http = new HTTPClient();
  const { keeperUrl, requestTimeout, maxMarksPerTick } = runtime.config;
  return runDelinquencyTick(runtime, {
    readOverdue: () =>
      asResult(() => http.sendRequest(runtime, readOverdueOnNode, consensusIdenticalAggregation<OverdueRead>())(keeperUrl, requestTimeout, maxMarksPerTick).result()),
    secret: () => asResult(() => runtime.getSecret({ id: SECRET_ID }).result().value),
    postTick: (secret, tabIds) =>
      asResult(() =>
        http.sendRequest(runtime, postTickOnNode, consensusIdenticalAggregation<TickOutcome>())(keeperUrl, requestTimeout, secret, [...tabIds]).result(),
      ),
  });
};

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};
