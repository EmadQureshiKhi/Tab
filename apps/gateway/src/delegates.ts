/**
 * Whether a session key may sign an Agent's metering claims, read off `MeteringDelegates`.
 *
 * ## What a delegate is, and what it is not
 *
 * An Agent whose wallet submits transactions but cannot sign a message names a
 * local key in `MeteringDelegates` with one transaction, and that key signs
 * each metering claim from then on, in `Tab-Delegate-Signature`. The gateway
 * recovers the signature against `Tab-Delegate` exactly as it recovers an
 * Agent's against `Tab-Agent`, and then asks this reader whether the Agent
 * named that key and the name has not lapsed.
 *
 * A delegate widens who may *ask* for a metered call and nothing else. The
 * charge still passes `TabBook.recordDelivery`, which enforces the Agent's own
 * `TabBook.authorise` ceiling and expiry for this Service and Asset and the
 * Credit Limit on top, and no Settlement path reads `MeteringDelegates`, so a
 * delegate can never move the Agent's funds.
 *
 * ## The cache
 *
 * By default nothing is held: every call reads the chain, so an Agent that
 * revokes a key it suspects was taken is refused on the very next call, which
 * is what revoking is for. The read is two `eth_call`s beside the witness reads
 * a metered call already makes. A gateway that would rather trade that for
 * load may set `cacheMs`: a positive answer is then held for at most that long
 * and never past the delegation's own expiry, and a revoked key keeps counting
 * until the window closes. A negative answer is never held, so a key
 * registered a moment ago is accepted on the next call, and only registered
 * keys are ever held, so the cache is bounded by what Agents have registered,
 * not by what callers send.
 */

import { Interface } from "ethers";

import { METERING_DELEGATES_ABI, causeOf, err, ok, type Result } from "@tabai/shared";

/** How long a positive answer is trusted before it is read again: not at all, by default. */
export const DELEGATE_CACHE_MS = 0;

/** Past this many held answers, lapsed ones are swept on the next insert. */
const SWEEP_AT = 10_000;

const INTERFACE = new Interface([...METERING_DELEGATES_ABI]);

export interface MeteringDelegateReader {
  /** The `MeteringDelegates` contract this reader asks. */
  readonly address: string;
  /** Whether `delegate` may sign `agent`'s metering claims now. */
  isDelegate(agent: string, delegate: string): Promise<Result<boolean>>;
}

export interface MeteringDelegateReaderOptions {
  readonly address: string;
  /** `eth_call` at the latest block, returning the raw return data. The gateway passes its provider's. */
  readonly call: (request: { readonly to: string; readonly data: string }) => Promise<string>;
  /** Milliseconds since the epoch. Injected so a test can walk the clock. */
  readonly now?: () => number;
  readonly cacheMs?: number;
}

export function createMeteringDelegateReader(options: MeteringDelegateReaderOptions): MeteringDelegateReader {
  const now = options.now ?? (() => Date.now());
  const cacheMs = options.cacheMs ?? DELEGATE_CACHE_MS;
  const address = options.address.toLowerCase();
  /** `agent:delegate` to the millisecond the positive answer stops being trusted. */
  const held = new Map<string, number>();

  const read = async (fn: "isDelegate" | "expiryOf", agent: string, delegate: string): Promise<unknown> => {
    const data = INTERFACE.encodeFunctionData(fn, [agent, delegate]);
    const returned = await options.call({ to: address, data });
    return INTERFACE.decodeFunctionResult(fn, returned)[0];
  };

  return {
    address,
    async isDelegate(agent, delegate) {
      const key = `${agent.toLowerCase()}:${delegate.toLowerCase()}`;
      const until = held.get(key);
      if (until !== undefined) {
        if (now() < until) return ok(true);
        held.delete(key);
      }

      let registered: boolean;
      let expiry: bigint;
      try {
        const [answer, expiresAt] = await Promise.all([read("isDelegate", agent, delegate), read("expiryOf", agent, delegate)]);
        registered = answer === true;
        expiry = BigInt(expiresAt as bigint);
      } catch (error) {
        return err({
          category: "UPSTREAM",
          code: "METERING_DELEGATE_UNREADABLE",
          message: `whether ${delegate} is a metering delegate of ${agent} could not be read from MeteringDelegates at ${address}`,
          retryable: true,
          cause: causeOf(error),
        });
      }
      if (!registered) return ok(false);

      const heldUntil = Math.min(now() + cacheMs, Number(expiry) * 1000);
      if (heldUntil > now()) {
        if (held.size >= SWEEP_AT) {
          const at = now();
          for (const [entry, lapses] of held) if (lapses <= at) held.delete(entry);
        }
        held.set(key, heldUntil);
      }
      return ok(true);
    },
  };
}
