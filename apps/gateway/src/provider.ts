/**
 * The gateway's JSON-RPC provider, which retries a read the node failed to answer.
 *
 * A metered call reads the chain several times before it records a delivery:
 * the Service, the price, the authorisation, the witness. When one of those
 * reads fails for a moment, a timeout or a rate limit on a public endpoint, the
 * plugin delivers the handler's response anyway and the Service absorbs the
 * charge, which is the right outcome for a failure that is the Service's and
 * the wrong one to reach over a blip. So a read-only request is sent again,
 * twice at most, after a short wait.
 *
 * What is never retried: a request that writes, because a resent transaction
 * is a second transaction and the send queue in `sender.ts` owns those; and a
 * read the node answered with an error, such as a revert, because asking again
 * gets the same answer. Only a transport failure, or a node that says it is
 * rate limited, earns another try.
 */

import { JsonRpcProvider, type JsonRpcError, type JsonRpcPayload, type JsonRpcResult } from "ethers";

/** The methods that change nothing, so sending one twice is harmless. */
const READ_ONLY = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "net_version",
]);

/** The waits before the second and the third try, in milliseconds. */
export const READ_RETRY_DELAYS_MS: readonly number[] = [250, 1_000];

/** A node's way of saying "not now" rather than "no". */
const isRateLimited = (entry: JsonRpcResult | JsonRpcError): boolean =>
  "error" in entry && (entry.error.code === -32005 || /rate limit|too many requests/i.test(entry.error.message ?? ""));

export class RetryingJsonRpcProvider extends JsonRpcProvider {
  readonly #delays: readonly number[];
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(
    url: string,
    network: ConstructorParameters<typeof JsonRpcProvider>[1],
    options: ConstructorParameters<typeof JsonRpcProvider>[2],
    retry: { readonly delaysMs?: readonly number[]; readonly sleep?: (ms: number) => Promise<void> } = {},
  ) {
    super(url, network, options);
    this.#delays = retry.delaysMs ?? READ_RETRY_DELAYS_MS;
    this.#sleep = retry.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  override async _send(payload: JsonRpcPayload | Array<JsonRpcPayload>): Promise<Array<JsonRpcResult>> {
    const requests = Array.isArray(payload) ? payload : [payload];
    const readOnly = requests.every((request) => READ_ONLY.has(request.method));
    for (let attempt = 0; ; attempt += 1) {
      const last = !readOnly || attempt >= this.#delays.length;
      try {
        const results = await super._send(payload);
        if (last || !(results as Array<JsonRpcResult | JsonRpcError>).some(isRateLimited)) return results;
      } catch (error) {
        if (last) throw error;
      }
      await this.#sleep(this.#delays[attempt] ?? 0);
    }
  }
}
