/**
 * What the plugin assumes when the environment says nothing.
 *
 * The addresses are the Monad Testnet and Mainnet deployments recorded in the
 * repository's `deployments.json`, copied here because a published package
 * cannot read a file two directories above its own root. `test/settings.test.mjs`
 * compares these constants against that file whenever it is present, holding
 * each network's copy to its own entry, so neither can drift inside the
 * workspace without a test saying so.
 *
 * Testnet stays the default chain because it is where nothing is real; Mainnet
 * is one `MONAD_CHAIN_ID=143` away.
 */

import type { Address } from "@tabai/sdk";

/** Monad Testnet, the default chain. */
export const DEFAULT_CHAIN_ID = 10143;

/** Monad Mainnet, accepted when named, defaulted to nothing. */
export const MAINNET_CHAIN_ID = 143;

/** The Testnet contracts, as `deployments.json` records them. Lower-cased. */
export const TESTNET_DEFAULTS = {
  tabBook: "0x87571030cce27c84836baff85288eb1d85d908a4" as Address,
  tabSettlement: "0x654fac48185e4b71779eec2457b1f24aedf46717" as Address,
  serviceRegistry: "0x3638db35a76e5a22ea1e827636da994be622c139" as Address,
  /**
   * The test token the deployment shipped. The SDK names an Asset only when it
   * knows the address, and it learns this one from `MOCK_USDC_ADDRESS`; without
   * it `discover` would list the token with no symbol and no decimals.
   */
  mockUsdc: "0x480209747417f5c830fda188a9b9acfa70bc4083" as Address,
  explorerUrl: "https://testnet.monadvision.com",
  rpcUrl: "https://testnet-rpc.monad.xyz",
} as const;

/** The Mainnet contracts, as `deployments.json` records them. Lower-cased. No test token. */
export const MAINNET_DEFAULTS = {
  tabBook: "0x0dabf8e52280d0f128f546602a99b6dc4fbb80dc" as Address,
  tabSettlement: "0x32a96bfeabe766b4898b961b333b7b89f079a9a9" as Address,
  serviceRegistry: "0x4f791f13f94944fcb2f884f8c7991caa583884a6" as Address,
  explorerUrl: "https://monadvision.com",
  rpcUrl: "https://rpc.monad.xyz",
} as const;

/** The Mainnet explorer, for links. */
export const MAINNET_EXPLORER_URL = MAINNET_DEFAULTS.explorerUrl;

/** The recorded deployment for a supported chain id. */
export const deploymentDefaults = (chainId: number): typeof TESTNET_DEFAULTS | typeof MAINNET_DEFAULTS =>
  chainId === MAINNET_CHAIN_ID ? MAINNET_DEFAULTS : TESTNET_DEFAULTS;
