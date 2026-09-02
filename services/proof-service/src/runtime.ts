/**
 * One composition of the whole service, shared by the server and the drivers.
 *
 * The alternative is each entry point wiring a provider, a witness reader, a
 * `TabBook` client, a Proof Builder source and an attestation reader for itself,
 * which is four chances for a driver to simulate against a different block tag or a
 * different Asset than the served app charges against. A driver that reports what
 * the server would do has to be the server, minus the socket.
 *
 * ## Read-only by default, and the key is the only thing that changes that
 *
 * Everything here works with no key: the Proof Builder is public, the ChainInfo
 * Precompile is a view, the witness is rebuilt from logs, and `recordDelivery` runs
 * as a keyless `eth_call` given the operator's address as `from`. Passing a signer
 * is what turns simulation into spending, and no path here creates one on its own.
 *
 * Requirements: 22.1, 22.2, 22.3, 22.5
 */

import { JsonRpcProvider, encodeBytes32String, type Signer } from "ethers";

import { ok, type Result } from "@tabai/shared";

import type { ProofServiceConfig } from "./config.js";
import { createPrecompileAttestationReader, type AttestationReader } from "./attestation.js";
import { createProofBuilderApiSource, type ProofSource } from "./proof.js";
import { createProofDeliverer, type ProofDeliverer } from "./delivery.js";
import { buildWitness, createWitnessReader, type WitnessReader } from "./witness.js";
import { createTabBookClient, type ProofServiceTabBookClient } from "./tab-book.js";
import { PROOF_TOOL_NAME, type ProofServiceAsset } from "./server.js";

/**
 * Every read is pinned to one tag, as the Watcher does.
 *
 * `finalized` and not `latest`, because a witness assembled across a reorganised
 * head folds to a commitment the contract no longer holds. The one place that rule
 * is inverted is confirming a write, which reads back at the block its receipt
 * names, because Creditcoin's `finalized` lags `latest` and a read-back at the
 * pinned tag can miss its own write.
 */
export const BLOCK_TAG = "finalized";

/**
 * First Creditcoin block the history scan reaches back to.
 *
 * The registry's own cold-start default, which is the deployment block of the
 * earliest watched contract. Lower costs a long catch-up; higher silently loses
 * history, and a witness missing one record cannot fold.
 */
export const HISTORY_FROM_BLOCK = 5_407_360;

/** The Asset a run meters and settles in. */
export function assetFor(config: ProofServiceConfig, chainKey: bigint): Result<ProofServiceAsset> {
  const source = config.sourceChains[chainKey.toString(10)];
  if (source === undefined) {
    return {
      ok: false,
      error: {
        category: "VALIDATION",
        code: "ASSET_NOT_CONFIGURED",
        message: `no USDC address is configured for chainKey ${chainKey.toString(10)}; set SEPOLIA_USDC_ADDRESS for chainKey 1 or MAINNET_USDC_ADDRESS for chainKey 3`,
        retryable: false,
        details: { chainKey: chainKey.toString(10) },
      },
    };
  }
  return ok({
    chainKey,
    address: source.usdc as `0x${string}`,
    decimals: source.decimals,
    symbol: "USDC",
  });
}

/** The 32-byte word the applied price list is keyed by. */
export const proofToolWord = (): `0x${string}` =>
  encodeBytes32String(PROOF_TOOL_NAME) as `0x${string}`;

export interface Runtime {
  readonly provider: JsonRpcProvider;
  readonly witnessReader: WitnessReader;
  readonly attestation: AttestationReader;
  readonly source: ProofSource;
  readonly deliverer: ProofDeliverer;
  readonly tabBook: ProofServiceTabBookClient;
}

export interface RuntimeOptions {
  readonly config: ProofServiceConfig;
  /** Absent on a read-only run, which is the default. */
  readonly signer?: Signer | undefined;
  /**
   * The address a simulation presents as `msg.sender`.
   *
   * Needed because `recordDelivery` is gated on the Service operator, so a keyless
   * `eth_call` runs as the zero address and is refused `NotServiceOperator` before
   * it can report anything useful.
   */
  readonly simulateFrom?: string | undefined;
  /** Injected so a test drives the Proof Builder without a network. */
  readonly fetchImpl?: typeof fetch | undefined;
}

/** Wires the service. Construction cannot fail; every fallible thing is a call. */
export function createRuntime(options: RuntimeOptions): Runtime {
  const { config } = options;

  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, {
    batchMaxCount: config.batchMaxCount,
    staticNetwork: true,
  });

  const witnessReader = createWitnessReader(
    provider,
    {
      tabBook: config.tabBook,
      bond: config.bond,
      serviceRegistry: config.serviceRegistry,
    },
    BLOCK_TAG,
    HISTORY_FROM_BLOCK,
  );

  const tabBook = createTabBookClient({
    provider,
    tabBook: config.tabBook,
    blockTag: BLOCK_TAG,
    ...(options.signer === undefined ? {} : { signer: options.signer }),
    ...(options.simulateFrom === undefined ? {} : { simulateFrom: options.simulateFrom }),
    // Rebuilt per call rather than cached: every Verified Settlement advances the
    // commitment, so a witness held across one would be refused on chain.
    witnessFor: async (agent, asset) => {
      const built = await buildWitness(witnessReader, agent, asset);
      return built.ok ? ok(built.value.witness) : built;
    },
  });

  const attestation = createPrecompileAttestationReader(provider, config.chainInfo, BLOCK_TAG);
  const source = createProofBuilderApiSource({
    baseUrl: config.proofBuilderUrl,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  return {
    provider,
    witnessReader,
    attestation,
    source,
    tabBook,
    deliverer: createProofDeliverer({ source, attestation }),
  };
}
