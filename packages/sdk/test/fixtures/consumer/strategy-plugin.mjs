/**
 * A third-party strategy, as a consumer would publish one.
 *
 * It imports nothing from `@tabai/sdk`. That is the point of R23.6: the seam is
 * structural, so a strategy for a chain Tab has never heard of needs no build-time
 * relationship with this package at all.
 */

/** @returns a strategy for an imaginary chainKey Tab ships no support for. */
export default function createPluginStrategy() {
  const chainKey = 7n;
  return {
    id: "plugin-strategy",
    chainKeys: [chainKey],
    supports: (asset) => asset.chainKey === chainKey,
    quote: async (request) => ({
      ok: true,
      value: { amount: request.amount, asset: request.asset, feeNote: "no fee" },
    }),
    settle: async () => ({
      ok: false,
      error: {
        category: "UNAVAILABLE",
        code: "FIXTURE_ONLY",
        message: "this fixture strategy submits nothing",
        retryable: false,
      },
    }),
    watchHint: (receipt) => ({
      chainKey: receipt.chainKey,
      sourceTxHash: receipt.sourceTxHash,
      expectedEventSignature: `0x${"00".repeat(32)}`,
      expectedEmitter: receipt.emitter,
      expectedPayerTopic: `0x${"00".repeat(32)}`,
      expectedCollectionTopic: `0x${"00".repeat(32)}`,
      asset: receipt.asset,
      amount: receipt.amount,
    }),
  };
}
