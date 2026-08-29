/**
 * The attestation wait: the gate that must open before any proof material is
 * requested for a Settlement (R16.3, design section 8.3).
 *
 * The expected Ethereum Mainnet wait is **roughly 13 to 15 minutes** (R16.2).
 * That is the planning figure and the timeout is sized to it, deliberately not to
 * the 7-to-8.6-minute head-to-attested lag measured on a single day. Two samples
 * 155 seconds apart establish liveness and stride, not a service level, so
 * {@link ATTESTATION_WAIT_TIMEOUT_MS} stays at the conservative end and must not
 * be tuned tighter on the strength of one probe.
 *
 * ## `waitUntilHeightAttested` is not a precompile method — probed, not assumed
 *
 * R16.3 and design section 8.3 both name `waitUntilHeightAttested(chainKey,
 * blockHeight)` as though it were a ChainInfo call. It is not, and this was
 * checked against the live precompile rather than inferred from the three sibling
 * camelCase names that were already known absent. See
 * {@link PRECOMPILE_NAMES_THAT_DO_NOT_EXIST} for the raw evidence.
 *
 * The name is real, but it belongs to the client libraries, in two variants, and
 * neither is on chain:
 *
 * - `PrecompileChainInfoProvider.waitUntilHeightAttested` polls
 *   `get_latest_attestation_height_and_hash` — precisely the loop below — and its
 *   own documentation marks it a legacy implementation. Its default
 *   `waitTimeoutMs` is **60,000**, one minute, against a documented 13-to-15
 *   minute wait. Using it with defaults would abandon roughly thirteen out of
 *   fourteen Mainnet Settlements and look like an attestation outage.
 * - `ProofBuilder.waitUntilHeightAttested` polls the Proof Builder's own
 *   attested-height cache with a 15-minute ceiling. That answers a different
 *   question — *can the service serve a proof yet* — and the service can lag the
 *   chain, so it corroborates the chain read rather than replacing it.
 *
 * Both throw on timeout. Nothing in the Watcher throws, so the wait is
 * implemented here as a `Result`-returning poll with the timeout sized to the
 * documented figure, and the service cache is available as an optional
 * corroboration step through {@link AttestedHeightCorroborator}.
 *
 * ## The readiness read is the height-returning one, never the boolean
 *
 * `is_height_attested` is not dependable at the frontier: one height past the
 * tip, `(3, tip + 1)` answered false while `(1, tip + 1)` answered true, with the
 * frontier read reporting `tip` on both chains. The likeliest cause is that
 * Creditcoin `latest` runs ahead of `finalized`, and a bare boolean cannot
 * distinguish "not attested" from "not attested as of whatever block answered
 * this call". A height-returning read can be compared against a pinned block tag,
 * which is why {@link coversHeight} takes a frontier and not a verdict.
 *
 * ## Coverage, not membership
 *
 * Attestations land on a stride of {@link ATTESTATION_STRIDE_BLOCKS} source-chain
 * blocks, so most heights are never themselves an attestation endpoint. The
 * question is always "is this height at or below the attested frontier", never
 * "is this height an attestation" — a Settlement between two endpoints is exactly
 * what the Continuity Proof exists to bridge.
 *
 * Requirements: 16.2, 16.3, 20.2
 */

import { err, ok, type ChainKey, type Result, type TabError } from "@tabai/shared";

import type { AttestationFrontier, ChainInfoReader } from "./chain-info.js";

/**
 * Lower and upper bounds of the documented Mainnet attestation wait (R16.2).
 * These are the figures the Documentation Site and the operator runbook state.
 */
export const MAINNET_ATTESTATION_WAIT_LOWER_MS = 13 * 60 * 1000;
export const MAINNET_ATTESTATION_WAIT_UPPER_MS = 15 * 60 * 1000;

/**
 * How long the wait runs before giving up, set to the conservative end of the
 * documented figure. Not derived from the measured lag; see the module note.
 */
export const ATTESTATION_WAIT_TIMEOUT_MS = MAINNET_ATTESTATION_WAIT_UPPER_MS;

/**
 * Interval between frontier reads.
 *
 * The frontier advances on a stride of 10 source-chain blocks roughly every 2
 * minutes, so 15 seconds samples each stride about eight times. The read is a
 * keyless `eth_call` and costs nothing, so the interval is chosen for promptness
 * rather than for economy.
 */
export const ATTESTATION_POLL_INTERVAL_MS = 15 * 1000;

/** Source-chain blocks between attestation endpoints, measured on both chains. */
export const ATTESTATION_STRIDE_BLOCKS = 10n;

/**
 * Names probed against the ChainInfo Precompile that do **not** exist, each
 * having reverted `"Unknown selector"`, together with what actually answers the
 * question. This is the record task 14.3 was asked to leave behind, so the next
 * reader inherits a fact instead of repeating the call.
 *
 * Probed at the pinned block tag against
 * `0x0000000000000000000000000000000000000fd3` on CC3 Testnet. Raw returndata in
 * every case was the builtin `Error(string)` selector `0x08c379a0` carrying the
 * 16-byte string `Unknown selector`:
 * `0x08c379a0…0000100556e6b6e6f776e2073656c6563746f7200…`.
 */
export const PRECOMPILE_NAMES_THAT_DO_NOT_EXIST: Readonly<
  Record<string, { readonly selector: string; readonly instead: string }>
> = {
  "waitUntilHeightAttested(uint64,uint64)": {
    selector: "0xce6400cd",
    instead:
      "not on chain at any name — it is a client-side poll of get_latest_attestation_height_and_hash(uint64), which is what waitUntilHeightAttested below implements",
  },
  "wait_until_height_attested(uint64,uint64)": {
    selector: "0xafb314b0",
    instead: "the snake_case spelling does not exist either, so the absence is the method and not the casing",
  },
  "waitUntilHeightAttested(uint64,uint64,uint256)": {
    selector: "0x38c54eec",
    instead: "no arity of the name exists; a poll-interval parameter does not make it appear",
  },
};

/**
 * The default `waitTimeoutMs` of the pinned client library's precompile-backed
 * wait. Recorded because it is a trap rather than a default: one minute against a
 * documented 13-to-15-minute wait.
 */
export const CLIENT_LIBRARY_WAIT_DEFAULT_TIMEOUT_MS = 60 * 1000;

/**
 * Whether the attested frontier covers a height.
 *
 * Three conditions, and all three are load-bearing. `exists: false` means the
 * chain carries no attestation record at all. `isAttestation: false` means the
 * newest record is a *checkpoint*, which sits on a coarser grid and carries no
 * proof material, so it is not a frontier a proof can be built against. And the
 * height comparison is `>=` rather than `==`, because attestations are sparse and
 * a Settlement almost never sits on an endpoint.
 */
export function coversHeight(frontier: AttestationFrontier, height: bigint): boolean {
  return frontier.exists && frontier.isAttestation && frontier.height >= height;
}

/**
 * The nearest attestation endpoint at or above a height, on the measured stride.
 *
 * Used for the log line that tells an operator which attestation will first cover
 * a Settlement, without a second network read.
 */
export function nextEndpointAtOrAbove(height: bigint): bigint {
  const remainder = height % ATTESTATION_STRIDE_BLOCKS;
  return remainder === 0n ? height : height + (ATTESTATION_STRIDE_BLOCKS - remainder);
}

/** How the wait ended. */
export type AttestationWaitOutcome =
  /** the frontier reached the target height; proof material may be requested */
  | "ATTESTED"
  /** the deadline passed with the frontier still below the target */
  | "TIMED_OUT"
  /** the chain carries no attestation record, or only a checkpoint */
  | "NOT_ATTESTING";

/** What the wait observed. */
export interface AttestationWait {
  readonly outcome: AttestationWaitOutcome;
  readonly chainKey: ChainKey;
  readonly targetHeight: bigint;
  /** The last frontier read, or undefined when no read ever succeeded. */
  readonly frontier: AttestationFrontier | undefined;
  /** The attestation endpoint expected to first cover the target. */
  readonly expectedEndpoint: bigint;
  readonly waitedMs: number;
  readonly polls: number;
  /**
   * The Proof Builder's own attested height when corroboration ran, so a
   * precompile that is ahead of the service is visible rather than inferred from
   * a later 404.
   */
  readonly corroboratedHeight: bigint | undefined;
  /** One sentence for the log line. */
  readonly detail: string;
}

/**
 * The Proof Builder's attested-height cache, as a corroboration source.
 *
 * The chain is the authority; this answers the narrower question of whether the
 * *service* can serve a proof yet. `undefined` means the service holds no height
 * for the chain, which is a "not yet", not a failure.
 */
export interface AttestedHeightCorroborator {
  readonly id: string;
  latestAttestedHeight(chainKey: ChainKey): Promise<Result<bigint | undefined>>;
}

export interface AttestationWaitOptions {
  /** Defaults to {@link ATTESTATION_WAIT_TIMEOUT_MS}. Do not tighten it. */
  readonly timeoutMs?: number;
  /** Defaults to {@link ATTESTATION_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
  /**
   * When supplied, the wait does not report `ATTESTED` until the service's cache
   * has also reached the target height. A corroboration read that fails is
   * treated as "not yet" rather than as an error: the chain has already said yes,
   * and the service catching up is a matter of time.
   */
  readonly corroborator?: AttestedHeightCorroborator;
  /** Injected so a test exercises the deadline without waiting. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected alongside `sleep`, so elapsed time is whatever the test says. */
  readonly now?: () => number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function unreadableFrontier(chainKey: ChainKey, cause: TabError, polls: number): TabError {
  return {
    category: cause.category,
    code: "ATTESTATION_FRONTIER_UNREADABLE",
    message: `the attested frontier of chainKey ${chainKey} could not be read on any of ${polls} attempt(s) before the wait deadline: ${cause.message}`,
    retryable: true,
    details: { chainKey, polls },
    ...(cause.cause === undefined ? {} : { cause: cause.cause }),
  };
}

/**
 * Waits until the Attestation covering `targetHeight` exists.
 *
 * The loop reads the frontier at the reader's pinned block tag, so every answer
 * inside one wait comes from the same view of Creditcoin. A read failure does not
 * end the wait — the endpoint may simply have hiccuped, and the deadline is the
 * only thing that ends it — but a wait where *no* read ever succeeded fails
 * rather than reporting a timeout, because "the chain is slow" and "we cannot see
 * the chain" are different operator problems.
 *
 * Nothing in an Agent's request path calls this (R16.1). It is a background job.
 *
 * @param reader the ChainInfo reader, already pinned to one block tag
 * @param chainKey the Source Chain
 * @param targetHeight the Settlement's block height
 */
export async function waitUntilHeightAttested(
  reader: ChainInfoReader,
  chainKey: ChainKey,
  targetHeight: bigint,
  options: AttestationWaitOptions = {},
): Promise<Result<AttestationWait>> {
  const timeoutMs = options.timeoutMs ?? ATTESTATION_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? ATTESTATION_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;

  const startedAt = now();
  const expectedEndpoint = nextEndpointAtOrAbove(targetHeight);
  let polls = 0;
  let frontier: AttestationFrontier | undefined;
  let lastError: TabError | undefined;
  let corroboratedHeight: bigint | undefined;

  for (;;) {
    polls += 1;
    const read = await reader.getLatestAttestation(BigInt(chainKey));
    if (read.ok) {
      frontier = read.value;
      lastError = undefined;

      if (coversHeight(frontier, targetHeight)) {
        if (options.corroborator === undefined) {
          return ok({
            outcome: "ATTESTED",
            chainKey,
            targetHeight,
            frontier,
            expectedEndpoint,
            waitedMs: now() - startedAt,
            polls,
            corroboratedHeight: undefined,
            detail: `chainKey ${chainKey} is attested to height ${frontier.height}, which covers the Settlement at height ${targetHeight}`,
          });
        }

        const corroboration = await options.corroborator.latestAttestedHeight(chainKey);
        corroboratedHeight = corroboration.ok ? corroboration.value : undefined;
        if (corroboratedHeight !== undefined && corroboratedHeight >= targetHeight) {
          return ok({
            outcome: "ATTESTED",
            chainKey,
            targetHeight,
            frontier,
            expectedEndpoint,
            waitedMs: now() - startedAt,
            polls,
            corroboratedHeight,
            detail: `chainKey ${chainKey} is attested to height ${frontier.height} and ${options.corroborator.id} has ingested to height ${corroboratedHeight}, both covering the Settlement at height ${targetHeight}`,
          });
        }
        // The chain has said yes and the service has not caught up. Keep waiting:
        // requesting material now would be answered with a retryable miss.
      }
    } else {
      lastError = read.error;
    }

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      if (frontier === undefined) {
        return err(
          unreadableFrontier(
            chainKey,
            lastError ?? {
              category: "UPSTREAM",
              code: "CHAININFO_READ_FAILED",
              message: "no reason was recorded",
              retryable: true,
            },
            polls,
          ),
        );
      }
      const notAttesting = !frontier.exists || !frontier.isAttestation;
      return ok({
        outcome: notAttesting ? "NOT_ATTESTING" : "TIMED_OUT",
        chainKey,
        targetHeight,
        frontier,
        expectedEndpoint,
        waitedMs: elapsedMs,
        polls,
        corroboratedHeight,
        detail: notAttesting
          ? `chainKey ${chainKey} carries ${frontier.exists ? "a checkpoint rather than an attestation" : "no attestation record"} after ${Math.round(elapsedMs / 1000)}s, so nothing at height ${targetHeight} is provable yet`
          : `chainKey ${chainKey} is attested only to height ${frontier.height} after ${Math.round(elapsedMs / 1000)}s, short of the Settlement at height ${targetHeight}, which expects endpoint ${expectedEndpoint}`,
      });
    }

    await sleep(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
  }
}
