/**
 * The hook seam of the proxy layer (R23.4).
 *
 * A hook is a named pair of optional phases. `before` runs ahead of the proxied
 * request, in registration order; `after` runs once the response exists, in
 * reverse order, so the hook registered first is the last to see the response
 * on the way out. That is the same nesting a middleware stack has, expressed as
 * two lists rather than as recursion, because two lists are what a Service
 * reads back when it asks "which hooks ran, and in what order".
 *
 * ## A hook cannot fail a request unless it says so
 *
 * Every phase returns a `Result`. An `err` is logged with the hook's name and
 * the phase, and the request carries on. That is the default because a hook is
 * observation: it logs, it annotates, it looks something up. A Service whose
 * log shipper is down should still deliver work. The one exception is a hook
 * that declares `critical: true`, whose `err` replaces the response with the
 * error it returned, at the HTTP status its category maps to. A hook that
 * *throws* is treated exactly as one that returned an `INTERNAL` error, so the
 * distinction between "misbehaved" and "reported a problem" is the `critical`
 * flag and never the control flow.
 *
 * ## What a hook can see and what it can change
 *
 * The context is one object per request, shared by both phases and every hook,
 * with two writable parts. `settlement` is where the Attestcoin proof hook
 * attaches the Verified Settlement it matched (R23.5), and `state` is scratch a
 * hook uses to hand something from its `before` to its `after` phase. A hook
 * cannot replace the request or the response through the context; only a
 * critical failure changes what goes out.
 *
 * Requirements: 23.4, 23.5
 */

import type { Result } from "@tabai/shared";
import type { Logger } from "../logger.js";
import type { MeteredCharge, MeteringOutcome } from "../server/post-paid.js";
import type { VerifiedSettlementView } from "./verifier.js";

export type ProxyPhase = "before" | "after";

export interface ProxyHookContext {
  readonly phase: ProxyPhase;
  /** The request as it reached the proxy, before any header was dropped for forwarding. */
  readonly request: Request;
  /** The response about to be returned. Present in the `after` phase only. */
  readonly response?: Response;
  /**
   * The delivery the metering plugin recorded for this request, when it recorded
   * one. Absent when the request was not metered, when metering refused it, and
   * under `release: "before-metering"`, where the recording is still pending
   * while the hooks run.
   */
  readonly charge?: MeteredCharge;
  /** The metering outcome in full, present whenever the plugin reached one before the hooks ran. */
  readonly metering?: MeteringOutcome;
  /**
   * The Verified Settlement attached to this request, if a hook found one.
   * Writable: attaching it is the proof hook's job (R23.5).
   */
  settlement?: VerifiedSettlementView;
  /** Scratch for the life of one request. Convention: keyed by hook name. */
  readonly state: Map<string, unknown>;
  readonly logger: Logger;
}

export interface ProxyHook {
  /** Names the hook in logs and in `state`. Unique within one proxy. */
  readonly name: string;
  /**
   * When true, an `err` from either phase fails the request with that error.
   * Defaults to false: a hook observes, and observation failing is not a reason
   * to withhold delivered work.
   */
  readonly critical?: boolean;
  before?(context: ProxyHookContext): Promise<Result<void>>;
  after?(context: ProxyHookContext): Promise<Result<void>>;
}
