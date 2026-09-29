/**
 * Tab's contracts on each Monad network, as this Dashboard reads them.
 *
 * ## Built in, not configured
 *
 * One Dashboard serves both networks and the visitor picks which. Every address
 * below is a transaction result recorded in `deployments.json` and read back off
 * the chain keylessly, so none of it is a per-host setting: two hosts serving
 * the same network must name the same contracts, and an environment variable
 * that let one of them differ would only be a way to be wrong. The table is a
 * copy rather than an import because the Dashboard is deployed from its own
 * directory; `test/deployments.test.ts` fails the moment the copy and the record
 * disagree.
 *
 * ## Only what the pages read
 *
 * The four core contracts, the curation authority the Service directory names,
 * the Testnet mock token, and the block the registry starts indexing from. The
 * transaction hashes, notes and demo records stay in `deployments.json`.
 */

import { MONAD_MAINNET, MONAD_TESTNET, type MonadChainId } from "@tabai/shared";

/** One network's deployment, with every address lowercased. */
export interface NetworkDeployment {
  readonly chainId: MonadChainId;
  readonly serviceRegistry: string;
  readonly bond: string;
  readonly tabBook: string;
  readonly tabSettlement: string;
  /**
   * The `ServiceRegistry` constructor immutable that may promote a Service to
   * the Curated tier. The deploying account on Testnet, a 2-of-3
   * `CurationMultisig` on Mainnet.
   */
  readonly curationAuthority: string;
  /** The mintable test token, rendered as `mUSDC`. Testnet only. */
  readonly mockUsdc: string | undefined;
  /** The block the contracts were deployed in. Nothing before it carries a Tab log. */
  readonly startBlock: number;
}

/** Monad Testnet: the second deployment, from block 64554587. */
export const TESTNET_DEPLOYMENT: NetworkDeployment = {
  chainId: MONAD_TESTNET.chainId,
  serviceRegistry: "0x3638db35a76e5a22ea1e827636da994be622c139",
  bond: "0x29adfd90fc7c9026563fc60651f696ab089080e7",
  tabBook: "0x87571030cce27c84836baff85288eb1d85d908a4",
  tabSettlement: "0x654fac48185e4b71779eec2457b1f24aedf46717",
  curationAuthority: "0x49472ef9ed99f30d4ead45ac9e1c16c31f70783a",
  mockUsdc: "0x480209747417f5c830fda188a9b9acfa70bc4083",
  startBlock: 64554587,
};

/** Monad Mainnet: settles in the canonical USDC and AUSD, with no test token. */
export const MAINNET_DEPLOYMENT: NetworkDeployment = {
  chainId: MONAD_MAINNET.chainId,
  serviceRegistry: "0x4f791f13f94944fcb2f884f8c7991caa583884a6",
  bond: "0xba86c0d053ba88afdecbed8aba5b2ec3973fb230",
  tabBook: "0x0dabf8e52280d0f128f546602a99b6dc4fbb80dc",
  tabSettlement: "0x32a96bfeabe766b4898b961b333b7b89f079a9a9",
  curationAuthority: "0x123c19f46c38d5b4e922d1297250a71a03dffd17",
  mockUsdc: undefined,
  startBlock: 107094526,
};

/** Both deployments, keyed by chain id. Total over {@link MonadChainId}. */
export const DEPLOYMENTS: Readonly<Record<MonadChainId, NetworkDeployment>> = {
  [MONAD_TESTNET.chainId]: TESTNET_DEPLOYMENT,
  [MONAD_MAINNET.chainId]: MAINNET_DEPLOYMENT,
};

/** The deployment on a chain. */
export function deploymentFor(chainId: MonadChainId): NetworkDeployment {
  return DEPLOYMENTS[chainId];
}
