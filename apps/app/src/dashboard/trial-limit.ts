/**
 * How many trial calls `/api/try` lets through, and to whom.
 *
 * ## Why Mainnet is limited and Testnet barely is
 *
 * A trial call is not free to whoever runs the Dashboard. The route signs the
 * metering claim with the operator key, the gateway records the delivery in a
 * Monad transaction the operator pays gas for, and the charge lands on the demo
 * Agent's Open Tab. On Testnet all of that is play money, so the only limit is
 * a loose per-address one that stops a stuck button or a script from flooding
 * the gateway. On Mainnet the gas is real MON and the charge is real USDC, so a
 * caller gets a few calls a minute and the whole site gets a fixed number a
 * day, after which the button says so rather than spending on.
 *
 * ## Two sliding windows
 *
 * Each window is a list of the times a call was let through, trimmed to the
 * window on every check, so a burst is counted exactly rather than by the
 * fixed bucket it happened to fall in. A refused call takes nothing from
 * either window. The address window is checked first, so one caller running
 * into their own limit does not spend the site's daily allowance.
 *
 * The clock is injected so the windows are tested without waiting on one.
 */

/** The limits one network's trial calls run under. */
export interface TrialLimits {
  /** Calls one client address may make in any sixty seconds. */
  readonly perAddressPerMinute: number;
  /** Calls the whole site may make in any twenty-four hours; `undefined` is no cap. */
  readonly perDay: number | undefined;
}

/** Whether a call may go ahead, and when to try again if not. */
export type TrialDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly scope: "address" | "site"; readonly retryAfterSeconds: number }
  /** A limit of zero: trial calls on this network are switched off. */
  | { readonly ok: false; readonly scope: "off" };

export interface TrialLimiter {
  /** Counts a call from `address` when both windows have room, and says whether it may proceed. */
  take(address: string): TrialDecision;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Mainnet, when the environment says nothing: three a minute per address, a hundred a day. */
export const MAINNET_TRIAL_DEFAULTS: TrialLimits = { perAddressPerMinute: 3, perDay: 100 };

/** Testnet: a loose per-address limit and no daily cap, because nothing real is spent. */
export const TESTNET_TRIAL_LIMITS: TrialLimits = { perAddressPerMinute: 20, perDay: undefined };

/**
 * A limit from the environment: a whole number, zero included, or the fallback.
 *
 * Zero is a real setting and means no trial calls at all, which is the switch
 * an operator reaches for when the demo Agent's tab needs to stop growing. A
 * value that is not a whole number is ignored rather than read as zero, so a
 * typo cannot quietly turn the button off.
 */
export function limitFromEnv(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  return Number.parseInt(value, 10);
}

/**
 * The client address a request came from, as the host's proxy reports it.
 *
 * The first entry of `x-forwarded-for` is the address the edge saw. Behind a
 * platform proxy that header is written by the platform; a server reached
 * directly would take it from the caller, which is why this is a limit on
 * casual abuse and not an identity.
 */
export function clientAddressOf(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded !== undefined && forwarded.length > 0) return forwarded;
  const real = headers.get("x-real-ip")?.trim();
  return real !== undefined && real.length > 0 ? real : "unknown";
}

/** Drops the entries older than the window, in place. The list is in time order. */
function trim(times: number[], now: number, windowMs: number): void {
  let stale = 0;
  while (stale < times.length && (times[stale] as number) <= now - windowMs) stale += 1;
  if (stale > 0) times.splice(0, stale);
}

/** Seconds until the oldest entry leaves the window, never less than one. */
function retryAfter(times: readonly number[], now: number, windowMs: number): number {
  const oldest = times[0] ?? now;
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}

export function createTrialLimiter(limits: TrialLimits, now: () => number = Date.now): TrialLimiter {
  const byAddress = new Map<string, number[]>();
  const site: number[] = [];

  return {
    take(address) {
      if (limits.perAddressPerMinute === 0 || limits.perDay === 0) return { ok: false, scope: "off" };
      const at = now();

      // Addresses that have gone quiet are forgotten, so the map holds only
      // the last minute's callers however long the process lives.
      for (const [key, times] of byAddress) {
        trim(times, at, MINUTE_MS);
        if (times.length === 0) byAddress.delete(key);
      }

      const mine = byAddress.get(address) ?? [];
      if (mine.length >= limits.perAddressPerMinute) {
        return { ok: false, scope: "address", retryAfterSeconds: retryAfter(mine, at, MINUTE_MS) };
      }

      if (limits.perDay !== undefined) {
        trim(site, at, DAY_MS);
        if (site.length >= limits.perDay) {
          return { ok: false, scope: "site", retryAfterSeconds: retryAfter(site, at, DAY_MS) };
        }
        site.push(at);
      }

      mine.push(at);
      byAddress.set(address, mine);
      return { ok: true };
    },
  };
}
