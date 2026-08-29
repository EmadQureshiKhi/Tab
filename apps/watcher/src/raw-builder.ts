/**
 * Constructing the independent proof path (R20.3, design section 8.4 step 2).
 *
 * ## What this closes
 *
 * `proof.ts` declares {@link RawProofProviderLike} structurally and wraps it as a
 * `ProofSource`, so the fallback compiles without the proof-building client on the
 * dependency list. That kept the seam honest and left it inert: with nothing
 * constructing the object, a Proof Builder API timeout had nowhere to fall through
 * to, and R20.3's "independent fallback" was a shape rather than a path. This
 * module is the constructor call, and the dependency is now declared.
 *
 * ## Verified live before it was wired
 *
 * On 2026-09-06 against Sepolia, with the Proof Builder API path forced to time
 * out, the library's `RawProofBuilder` fed through `createRawProofBuilderSource`
 * produced material byte for byte identical to the API path for the same
 * transaction: the same Merkle root `0x4893d0f3...717b`, the same transaction
 * index 0, the same `lowerEndpointDigest`, and the same six Continuity Proof
 * roots. Both passed the local re-derivation gate and the `calculateTxIndex`
 * cross-check. So the two paths agree on real material and the fallback is
 * genuinely independent rather than a second name for the same answer.
 *
 * ## Independence is the point, so nothing is shared
 *
 * The raw builder takes its own Source Chain provider and rebuilds the block's
 * transaction tree from `eth_getBlockReceipts` and the transactions themselves. It
 * shares no client, no cache, and no network hop with the Proof Builder API. Two
 * paths failing identically is then evidence about the material, which is exactly
 * what design section 8.4 escalates to `HALT` on.
 *
 * ## It is slow, and that is why it is second
 *
 * Building a Continuity Proof means fetching every block from the attestation
 * endpoint below the target up to the endpoint above it, with receipts, and
 * re-encoding each one. The measured round trip on Sepolia was 32 seconds against
 * well under a second for the API. It is the fallback for that reason and not
 * because it is less trustworthy; if anything it trusts less.
 *
 * ## `chainEncoding` comes from discovery, never from a literal
 *
 * `get_supported_chains` reports a `chainEncoding` per Source Chain, and the
 * encoding decides how a transaction and its receipt are serialised into a Merkle
 * leaf. Both chains report `1` today, which is `EncodingVersion.V1`, but reading it
 * from discovery rather than pinning it means a chain added later with a different
 * encoding is refused loudly here instead of producing a plausible wrong root that
 * the local re-derivation would then reject with no explanation.
 *
 * Requirements: 20.2, 20.3, 20.4
 */

import type { JsonRpcApiProvider } from "ethers";
import { chainInfo, encoding, proofProvider } from "@gluwa/usc-sdk";

import { err, ok, type ChainKey, type Result } from "@tabai/shared";

import { createRawProofBuilderSource, type ProofSource } from "./proof.js";

/**
 * `EncodingVersion` by the ordinal `get_supported_chains` reports.
 *
 * Only `1` exists on this network, measured on both chains. An unknown ordinal is
 * an error rather than a default, because guessing an encoding produces a wrong
 * Merkle leaf and therefore a wrong root, which surfaces as a mismatch with no
 * indication of the cause.
 */
export function encodingVersionOf(chainEncoding: number): Result<encoding.EncodingVersion> {
  if (chainEncoding === 1) return ok(encoding.EncodingVersion.V1);
  return err({
    category: "UNAVAILABLE",
    code: "UNKNOWN_CHAIN_ENCODING",
    message: `the precompile reports chainEncoding ${chainEncoding}, which this build has no EncodingVersion for, so the raw proof path cannot serialise a leaf for it`,
    retryable: false,
    details: { chainEncoding },
  });
}

export interface RawProofBuilderConfig {
  readonly chainKey: ChainKey;
  /** The Source Chain provider the block and receipt reads go through. */
  readonly sourceProvider: JsonRpcApiProvider;
  /** The Creditcoin provider the attestation bounds are read through. */
  readonly creditcoinProvider: JsonRpcApiProvider;
  /** The ChainInfo Precompile address, from configuration rather than the library default. */
  readonly chainInfoPrecompile: string;
  /** As reported by `get_supported_chains` for this chainKey. */
  readonly chainEncoding: number;
}

/**
 * Builds the independent fallback source for one Source Chain.
 *
 * The returned `ProofSource` is what `sourceVerifiedProofMaterial` takes as its
 * `fallback`, so the escalation is: API, then this, then `HALT` when both
 * disagree with the local fold.
 */
export function createRawProofBuilder(config: RawProofBuilderConfig): Result<ProofSource> {
  const version = encodingVersionOf(config.chainEncoding);
  if (!version.ok) return err(version.error);

  // The two casts below are the only ones in this module and they are a packaging
  // artefact, not a type risk. The pinned client ships CommonJS declarations, so
  // its `JsonRpcApiProvider` resolves to `ethers/lib.commonjs/...` while this ESM
  // package resolves the identical class from `ethers/lib.esm/...`. The compiler
  // treats the two paths as distinct nominal types; at runtime there is one
  // `ethers` in the tree, which `dep-audit` asserts on every CI run, so the object
  // handed over is exactly the class the library expects.
  const asLibraryProvider = (provider: JsonRpcApiProvider): never => provider as never;

  const blockProvider = new proofProvider.raw.blockProvider.SimpleBlockProvider(
    asLibraryProvider(config.sourceProvider),
  );
  const chainInfoProvider = new chainInfo.PrecompileChainInfoProvider(
    asLibraryProvider(config.creditcoinProvider),
    config.chainInfoPrecompile,
  );
  const builder = new proofProvider.raw.RawProofBuilder(
    Number(config.chainKey),
    blockProvider,
    chainInfoProvider,
    version.value,
  );
  return ok(createRawProofBuilderSource(builder));
}
