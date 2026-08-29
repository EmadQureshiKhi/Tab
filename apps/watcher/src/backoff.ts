/**
 * The retry schedule for a failed submission (R20.10, design section 8.9).
 *
 * Exponential from 2 seconds, doubling, capped at 5 minutes, with plus or minus
 * 20 percent jitter. The jitter is not decoration: several Watcher replicas that
 * fail at the same moment and retry on an identical schedule would hit the same
 * endpoint in lockstep forever, and the whole point of backing off is to stop
 * doing that.
 *
 * Everything here is pure. The random source and the clock are parameters, so a
 * test can pin both and assert exact instants rather than approximate ones.
 *
 * Requirements: 20.10
 */

/** The documented schedule. `WATCHER_BACKOFF_MIN_MS` and `_MAX_MS` carry the bounds. */
export const DEFAULT_BACKOFF = {
  minMs: 2_000,
  maxMs: 300_000,
  /** Plus or minus 20 percent, in basis points of the base delay. */
  jitterBps: 2_000,
} as const;

export interface BackoffSchedule {
  readonly minMs: number;
  readonly maxMs: number;
  readonly jitterBps: number;
}

/**
 * The base delay before attempt number `attempt + 1`, given `attempt` failures so
 * far, before jitter. Attempt 1 waits `minMs`, attempt 2 waits `2 * minMs`, and so
 * on up to `maxMs`. A non-positive attempt count is read as the first failure.
 */
export function baseDelayMs(attempt: number, schedule: BackoffSchedule = DEFAULT_BACKOFF): number {
  const failures = Math.max(1, Math.floor(attempt));
  // 2^(failures - 1) grows without bound, so the cap is applied to the exponent
  // as well, which keeps the arithmetic inside a safe integer for any count.
  const exponent = Math.min(failures - 1, 40);
  return Math.min(schedule.maxMs, schedule.minMs * 2 ** exponent);
}

/**
 * The delay with jitter applied: the base delay scaled by a factor drawn
 * uniformly from `[1 - jitter, 1 + jitter]`.
 *
 * @param random a source in `[0, 1)`, injectable so a schedule is testable
 */
export function backoffDelayMs(
  attempt: number,
  schedule: BackoffSchedule = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const base = baseDelayMs(attempt, schedule);
  const spread = schedule.jitterBps / 10_000;
  const factor = 1 - spread + 2 * spread * random();
  return Math.round(base * factor);
}

/** When the next attempt is allowed, as an instant. */
export function nextAttemptAt(
  now: Date,
  attempt: number,
  schedule: BackoffSchedule = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): Date {
  return new Date(now.getTime() + backoffDelayMs(attempt, schedule, random));
}

/**
 * Whether a row whose next attempt is scheduled for `at` is due at `now`. A row
 * with no schedule is due immediately, which is the state of every row that has
 * never failed.
 */
export function isDue(at: Date | null | undefined, now: Date): boolean {
  return at === null || at === undefined || at.getTime() <= now.getTime();
}
