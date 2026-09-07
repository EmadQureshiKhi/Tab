/**
 * A third-party strategy, as a consumer would publish one.
 *
 * It imports nothing from `@tabai/sdk`. The seam is structural, so a strategy a
 * consumer writes around its own signer (a session key, a smart account) needs no
 * build-time relationship with this package at all.
 */

/** @returns a strategy for an imaginary chainId Tab ships no support for. */
export default function createPluginStrategy() {
  const chainId = 7n;
  return {
    id: "plugin-strategy",
    chainIds: [chainId],
    supports: (asset) => asset.chainId === chainId,
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
  };
}
