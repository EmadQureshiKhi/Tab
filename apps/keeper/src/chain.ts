// Copied verbatim from `apps/app/src/dashboard/chain.ts`. Apps may not depend
// on apps, and the keeper must judge a tab exactly as the Dashboard does, so
// the file is duplicated rather than imported. `test/copies.test.mjs` fails
// when this copy and the original diverge below this header.
/**
 * The Dashboard's own read path to Monad, with no signer and no library.
 *
 * ## Why the Dashboard talks to the chain at all
 *
 * Every other figure on this Dashboard comes from the registry read API, and that
 * is the right default: the index is fast, it is paginated, and it carries a
 * horizon so no answer is horizonless. Two things cannot come from it.
 *
 * The first is upstream reachability. `/api/health` reports whether the Monad
 * RPC endpoint answers, and asking the registry whether the chain is up would
 * report the registry's opinion rather than the endpoint's.
 *
 * The second is the overdue-tab list, and the reason is worth stating because
 * it looks like a shortcut and is the opposite of one. `markDelinquent` is
 * permissionless so that delinquency liveness never depends on the Service that
 * metered the tab. A view whose whole purpose is letting an outsider act without
 * trusting us must not itself require our indexer to be up and honest. Reading
 * the tabs straight from the chain makes the page verifiable by the person using
 * it: every figure on it came from a node, and the reader can point this at any
 * node they like.
 *
 * ## No library, and no key
 *
 * This module imports nothing but the shared types. The two shapes it needs are
 * a fixed-layout static tuple and an event topic, and both are a few lines of
 * slicing over a hex string, so the encoding lives here and the module stays
 * small enough to carry verbatim into the keeper. Nothing in this module signs,
 * and there is no code path from it to a key, which keeps every route that uses
 * it readable without a wallet.
 *
 * ## Every failure is a value
 *
 * A dead endpoint, a malformed answer and a short return are all `Result` errors
 * carrying a code a route can act on. Nothing here throws, so a route that reads
 * the chain can always render something, and `/api/health` can report the endpoint
 * as unreachable rather than failing to answer at all.
 */

import { err, keccak256Ascii, ok, type Result, type TabError } from "@tabai/shared";

/** The little of a `fetch` response this module reads. */
export interface RpcResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

/** The `fetch` this reader posts with. The host's global is the default. */
export type RpcFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<RpcResponse>;

export interface ChainReaderOptions {
  readonly rpcUrl: string;
  readonly fetchImpl?: RpcFetch;
  /**
   * Blocks per `eth_getLogs` window.
   *
   * Monad's public RPC caps `eth_getLogs` at 100 blocks per request, so a wide
   * scan is refused outright. A fixed window is not a performance tuning knob
   * here, it is what makes the scan finish at all.
   */
  readonly logWindow?: number;
}

/**
 * Default `eth_getLogs` window.
 *
 * Monad's public RPC caps the range at 100 blocks per request and refuses
 * anything wider, so the default is the cap itself. A private endpoint can be
 * configured wider through `logWindow`; the halving below still catches an
 * endpoint that turns out to be stricter than it was told.
 */
export const DEFAULT_LOG_WINDOW = 100;

/**
 * The smallest window a refused scan will climb down to.
 *
 * At ten blocks a refusal is no longer "this range was too wide", it is an
 * endpoint that cannot answer, and continuing to halve would turn one unavailable
 * upstream into a long series of doomed requests. The page says it could not read
 * the chain instead, which is the answer that is true.
 */
export const MIN_LOG_WINDOW = 10;

/** One block, reduced to the two fields a deadline comparison needs. */
export interface BlockStamp {
  readonly number: number;
  /** Seconds since the epoch, as the chain reports it. */
  readonly timestamp: number;
}

/** One log, in the shape `eth_getLogs` returns. */
export interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly logIndex: string;
}

export interface ChainReader {
  /** The endpoint's chain id, which is also the cheapest liveness probe there is. */
  chainId(): Promise<Result<number>>;
  /** The latest block's number and timestamp, read together so they agree. */
  latestBlock(): Promise<Result<BlockStamp>>;
  /** `eth_call` at a named block, returning the raw return data. */
  call(to: string, data: string, blockNumber: number): Promise<Result<string>>;
  /** Every matching log between two heights, scanned in windows. */
  logs(query: {
    readonly address: string;
    readonly topics: readonly (string | null)[];
    readonly fromBlock: number;
    readonly toBlock: number;
  }): Promise<Result<readonly RawLog[]>>;
}

const upstream = (code: string, message: string, cause?: unknown): TabError => ({
  category: "UPSTREAM",
  code,
  message,
  retryable: true,
  ...(cause === undefined
    ? {}
    : { cause: { code: "Error", message: cause instanceof Error ? cause.message : String(cause) } }),
});

/** The host's global `fetch`, or undefined where the runtime has none. */
function hostFetch(): RpcFetch | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== "function") return undefined;
  return candidate as RpcFetch;
}

/** A JSON-RPC quantity to a number, refusing anything that is not one. */
export function parseQuantity(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value.slice(2), 16);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Builds the reader.
 *
 * Construction cannot fail, matching `createRegistryClient`: an unusable URL is
 * reported by the call that needs it, which is the only place a route can act on
 * it.
 */
export function createChainReader(options: ChainReaderOptions): ChainReader {
  const window = options.logWindow ?? DEFAULT_LOG_WINDOW;

  const rpc = async (method: string, params: readonly unknown[]): Promise<Result<unknown>> => {
    const send = options.fetchImpl ?? hostFetch();
    if (send === undefined) {
      return err(upstream("FETCH_UNAVAILABLE", "this host has no global fetch, so the chain cannot be read"));
    }

    let response: RpcResponse;
    try {
      response = await send(options.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (cause) {
      return err(upstream("RPC_UNREACHABLE", `${method} could not reach ${options.rpcUrl}`, cause));
    }

    if (response.status !== 200) {
      return err(upstream("RPC_STATUS", `${method} answered HTTP ${response.status}`));
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      return err(upstream("RPC_MALFORMED", `${method} did not answer with JSON`, cause));
    }

    if (typeof payload !== "object" || payload === null) {
      return err(upstream("RPC_MALFORMED", `${method} answered with something that is not an object`));
    }
    const body = payload as { result?: unknown; error?: { message?: unknown } };
    if (body.error !== undefined && body.error !== null) {
      const detail = typeof body.error.message === "string" ? body.error.message : "no message";
      // A JSON-RPC error is the endpoint answering, so it is reported as what it
      // is rather than as unreachability. `/api/health` distinguishes the two.
      return err(upstream("RPC_ERROR", `${method} was refused: ${detail}`));
    }
    return ok(body.result);
  };

  return {
    async chainId(): Promise<Result<number>> {
      const answer = await rpc("eth_chainId", []);
      if (!answer.ok) return answer;
      const parsed = parseQuantity(answer.value);
      if (parsed === undefined) {
        return err(upstream("RPC_MALFORMED", "eth_chainId did not answer with a quantity"));
      }
      return ok(parsed);
    },

    async latestBlock(): Promise<Result<BlockStamp>> {
      // The number and the timestamp come from one block object rather than from
      // two calls, so a block mined between them cannot produce a height and a
      // time that never coexisted.
      const answer = await rpc("eth_getBlockByNumber", ["latest", false]);
      if (!answer.ok) return answer;
      if (typeof answer.value !== "object" || answer.value === null) {
        return err(upstream("RPC_MALFORMED", "eth_getBlockByNumber did not answer with a block"));
      }
      const block = answer.value as { number?: unknown; timestamp?: unknown };
      const number = parseQuantity(block.number);
      const timestamp = parseQuantity(block.timestamp);
      if (number === undefined || timestamp === undefined) {
        return err(upstream("RPC_MALFORMED", "the latest block carried no readable number or timestamp"));
      }
      return ok({ number, timestamp });
    },

    async call(to, data, blockNumber): Promise<Result<string>> {
      const answer = await rpc("eth_call", [{ to, data }, `0x${blockNumber.toString(16)}`]);
      if (!answer.ok) return answer;
      if (typeof answer.value !== "string" || !answer.value.startsWith("0x")) {
        return err(upstream("RPC_MALFORMED", "eth_call did not answer with return data"));
      }
      return ok(answer.value);
    },

    async logs(query): Promise<Result<readonly RawLog[]>> {
      const collected: RawLog[] = [];
      // Carried across windows on purpose. An endpoint that refused a width once
      // will refuse it again, and resetting to the configured width every window would
      // spend one doomed request per window for the rest of a long scan.
      let width = window;
      for (let from = query.fromBlock; from <= query.toBlock; ) {
        // The window matches the public cap, but an endpoint may also bound the
        // query by time or by result size, so a window that is comfortable most of
        // the time is refused some of the time.
        //
        // So a refused window is halved and retried rather than ending the scan. The
        // floor is what stops that from becoming an infinite climb down: below it the
        // endpoint is not slow, it is unavailable, and saying so is the honest answer.
        let span = Math.min(width, query.toBlock - from + 1);
        let answer: Result<unknown> | undefined;
        for (;;) {
          const to = from + span - 1;
          answer = await rpc("eth_getLogs", [
            {
              address: query.address,
              topics: query.topics,
              fromBlock: `0x${from.toString(16)}`,
              toBlock: `0x${to.toString(16)}`,
            },
          ]);
          if (answer.ok || span <= MIN_LOG_WINDOW) break;
          span = Math.max(MIN_LOG_WINDOW, Math.floor(span / 2));
          width = span;
        }
        if (!answer.ok) return answer;
        const to = from + span - 1;
        from = to + 1;
        if (!Array.isArray(answer.value)) {
          return err(upstream("RPC_MALFORMED", "eth_getLogs did not answer with an array"));
        }
        for (const entry of answer.value) {
          const log = entry as Partial<RawLog>;
          if (
            typeof log.address !== "string" ||
            !Array.isArray(log.topics) ||
            typeof log.data !== "string" ||
            typeof log.blockNumber !== "string" ||
            typeof log.transactionHash !== "string" ||
            typeof log.logIndex !== "string"
          ) {
            // One malformed log invalidates the scan rather than being skipped: a
            // silently short list of overdue tabs reads as "none overdue",
            // which is the one wrong answer this page must never give.
            return err(upstream("RPC_MALFORMED", "eth_getLogs returned a log with missing fields"));
          }
          collected.push({
            address: log.address,
            topics: log.topics as readonly string[],
            data: log.data,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
          });
        }
      }
      return ok(collected);
    },
  };
}

// ---------------------------------------------------------------- encoding

/** The four-byte selector of a function signature. */
export function selectorOf(signature: string): string {
  return keccak256Ascii(signature).slice(0, 10);
}

/** A `bytes32` argument, already 32 bytes, as one ABI word. */
export function bytes32Arg(value: string): string {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  return body.toLowerCase().padStart(64, "0");
}

/** The `n`th 32-byte word of return data, or undefined where the data is short. */
export function wordAt(data: string, index: number): string | undefined {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  const start = index * 64;
  if (body.length < start + 64) return undefined;
  return body.slice(start, start + 64);
}

/** A word as an unsigned integer. */
export function uintFromWord(word: string): bigint {
  return BigInt(`0x${word}`);
}

/** A word as an address, which is its low 20 bytes. */
export function addressFromWord(word: string): string {
  return `0x${word.slice(24)}`;
}

/** A word as a `bytes32`. */
export function bytes32FromWord(word: string): string {
  return `0x${word}`;
}

/** An unsigned integer argument as one ABI word. */
export function uintArg(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

/** An address argument as one ABI word, left-padded to 32 bytes. */
export function addressArg(value: string): string {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  return body.toLowerCase().padStart(64, "0");
}
