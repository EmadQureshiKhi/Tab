/**
 * A third-party strategy, as a consumer would publish one.
 *
 * It imports nothing from `@tabai/sdk`. The seam is structural, so a strategy a
 * consumer writes around its own signer (a session key, a smart account) needs no
 * build-time relationship with this package at all.
 */

const MONAD_TESTNET = 10143n;
const MOCK_USDC = "0x480209747417f5c830fda188a9b9acfa70bc4083";

/** @returns a strategy for mUSDC on Monad Testnet that submits nothing. */
export default function createPluginStrategy() {
  return {
    id: "plugin-strategy",
    chainIds: [MONAD_TESTNET],
    supports: (asset) => asset.chainId === MONAD_TESTNET && asset.address.toLowerCase() === MOCK_USDC,
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
