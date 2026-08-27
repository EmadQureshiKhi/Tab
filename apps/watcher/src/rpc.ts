/**
 * JSON-RPC provider construction.
 *
 * Every provider in the Watcher is built here, because two measured properties of
 * the endpoints this rail runs against are easy to get wrong once and impossible
 * to notice until a chain goes quiet.
 *
 * ## 1. Batching is off
 *
 * Several public endpoints reject JSON-RPC batching outright — `drpc` answers
 * HTTP 500 to a batched request that succeeds unbatched (design section 8.2). So
 * `batchMaxCount` comes from configuration and defaults to 1, and every provider
 * is constructed through {@link createJsonRpcProvider} rather than with a bare
 * `new JsonRpcProvider(url)`.
 *
 * ## 2. `staticNetwork` is on, and it is not only an optimisation
 *
 * With the chain id supplied and `staticNetwork` set, the client never re-runs
 * network detection. That removes a whole class of `eth_chainId` round trips from
 * the hot path, and on Creditcoin it also keeps the client away from block-object
 * decoding it does not need: **the Creditcoin RPC returns block objects with no
 * `mixHash` field**, and a client that requires the field fails outright with
 * `deserialization error: missing field mixHash`. `ethers` v6 tolerates the
 * absence — {@link readCreditcoinTip} is the read that demonstrates it, and it is
 * exercised by `pnpm --filter @tabai/watcher discover` against the live network.
 *
 * ## Block tag consistency
 *
 * {@link CREDITCOIN_BLOCK_TAG} is pinned to `finalized` and every ChainInfo read
 * uses it. Creditcoin `latest` was observed 2 blocks ahead of `finalized`, so
 * mixing tags produces two different attested frontiers inside one process
 * (design section 8.11). One tag, chosen once, used everywhere.
 *
 * Requirements: 20.1, 20.11
 */

import { JsonRpcProvider, Network, type BlockTag } from "ethers";

import { causeOf, err, ok, type Result } from "@tabai/shared";

/**
 * The block tag every Creditcoin read uses. `finalized` rather than `latest`
 * because the two disagree on this network and the attested frontier must be one
 * answer per process. It also matches the tag the pinned Creditcoin SDK's own
 * chain-info provider uses, so a corroborating read cannot drift from ours.
 */
export const CREDITCOIN_BLOCK_TAG: BlockTag = "finalized";

/**
 * Builds a provider with batching disabled and the network pinned.
 *
 * @param url endpoint to reach
 * @param chainId the endpoint's chain id, supplied rather than detected
 * @param batchMaxCount calls per request; 1 unless an operator has measured otherwise
 */
export function createJsonRpcProvider(
  url: string,
  chainId: number,
  batchMaxCount: number,
): JsonRpcProvider {
  return new JsonRpcProvider(url, Network.from(chainId), {
    batchMaxCount,
    staticNetwork: true,
  });
}

/** What a Creditcoin node reports about its own head. */
export interface CreditcoinTip {
  readonly chainId: number;
  readonly latestBlockNumber: number;
  /** Height of the block at {@link CREDITCOIN_BLOCK_TAG}, or null when the node serves none. */
  readonly finalizedBlockNumber: number | null;
  /**
   * True when the node answered a full block-object read at the pinned tag. The
   * flag is carried rather than assumed because a client that requires `mixHash`
   * fails on exactly this call, and that failure is worth reporting as a fact
   * about the client rather than as an outage.
   */
  readonly blockObjectDecoded: boolean;
}

/**
 * Reads the node's chain id, its head, and the block at the pinned tag.
 *
 * The block-object read is deliberate: it is the call that a client requiring
 * `mixHash` cannot complete, so a green answer here is evidence the client
 * tolerates Creditcoin's block shape.
 */
export async function readCreditcoinTip(provider: JsonRpcProvider): Promise<Result<CreditcoinTip>> {
  try {
    const [network, latestBlockNumber, finalized] = await Promise.all([
      provider.getNetwork(),
      provider.getBlockNumber(),
      provider.getBlock(CREDITCOIN_BLOCK_TAG),
    ]);
    return ok({
      chainId: Number(network.chainId),
      latestBlockNumber,
      finalizedBlockNumber: finalized === null ? null : finalized.number,
      blockObjectDecoded: finalized !== null,
    });
  } catch (error) {
    return err({
      category: "UPSTREAM",
      code: "CREDITCOIN_RPC_UNREACHABLE",
      message: "the Creditcoin endpoint did not answer a head read",
      retryable: true,
      cause: causeOf(error),
    });
  }
}
