/**
 * ```
 * pnpm tsx apps/watcher/src/bin/probe-attestation.ts
 * ```
 *
 * Discharges the probe task 14.3 was blocked on, and re-runs it on demand so the
 * answer stays a fact rather than a note. No key, no transaction, no write: every
 * call here is a keyless `eth_call` or a public GET.
 *
 * It has no package script yet, because `apps/watcher/package.json` is not this
 * change's to edit. Registering it as `probe:attestation` is a one-line addition
 * for whoever next touches that file.
 *
 * Five questions, each answered against the live network:
 *
 * 1. **Does `waitUntilHeightAttested` exist on the ChainInfo Precompile?** R16.3
 *    and design section 8.3 both name it as though it did. Every spelling and
 *    arity is called raw and the revert is recorded verbatim.
 * 2. **Does the fallback shape work?** `get_latest_attestation_height_and_hash`
 *    at the pinned tag, which is what the wait polls instead.
 * 3. **Is `is_height_attested` dependable at the frontier?** It is called one
 *    height past the tip on both chains, which is where it was previously
 *    observed disagreeing with itself.
 * 4. **Does the keyless `verify` preflight work?** Run against the genuine
 *    Mainnet material recorded by the live suite, with no key and no gas.
 * 5. **Does the local re-derivation reproduce the genuine root and index?** The
 *    same material folded locally and cross-checked against `calculateTxIndex`.
 *
 * Exit codes: 0 every question answered as recorded, 1 an answer changed, 2 the
 * probe could not run.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Interface, type JsonRpcProvider } from "ethers";

import { PRECOMPILES, type ChainKey } from "@tabai/shared";

import {
  PRECOMPILE_NAMES_THAT_DO_NOT_EXIST,
  waitUntilHeightAttested,
} from "../attestation.js";
import { createPrecompileChainInfoReader } from "../chain-info.js";
import { loadWatcherConfig } from "../config.js";
import { checkDerivedRoot, createPrecompileTxIndexReader } from "../derive.js";
import {
  createPrecompileVerifyPreflight,
  createProofBuilderApiSource,
  normaliseProofMaterial,
} from "../proof.js";
import { CREDITCOIN_BLOCK_TAG, createJsonRpcProvider, readCreditcoinTip } from "../rpc.js";

/** Where the live suite recorded genuine Mainnet proof material. */
/**
 * Resolved against this module rather than the working directory, so the probe runs
 * the same from the repository root and from `pnpm --filter @tabai/watcher`, whose
 * working directory is the package.
 */
const LIVE_RESULTS = fileURLToPath(
  new URL("../../../../packages/contracts/test/live/results.json", import.meta.url),
);

/** The case whose `encodedTransaction` is genuine and whose root was forged. */
const GENUINE_PAYLOAD_CASE = "forged-merkle-root";

const jsonSafe = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

/** One raw `eth_call` at the pinned tag, reporting the revert rather than throwing. */
async function rawCall(
  provider: JsonRpcProvider,
  to: string,
  data: string,
): Promise<{ ok: boolean; raw: string | undefined; message: string | undefined }> {
  try {
    return { ok: true, raw: await provider.call({ to, data, blockTag: CREDITCOIN_BLOCK_TAG }), message: undefined };
  } catch (error) {
    const carried = (error as { data?: unknown; shortMessage?: unknown } | null) ?? {};
    return {
      ok: false,
      raw: typeof carried.data === "string" ? carried.data : undefined,
      message:
        typeof carried.shortMessage === "string"
          ? carried.shortMessage
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

async function main(): Promise<number> {
  const config = loadWatcherConfig();
  if (!config.ok) {
    console.error(`probe-attestation: ${config.error.code}: ${config.error.message}`);
    return 2;
  }
  const blockProver = (process.env.BLOCKPROVER_PRECOMPILE ?? PRECOMPILES.blockProver).toLowerCase();
  const chainInfo = config.value.creditcoin.chainInfoPrecompile;

  const provider = createJsonRpcProvider(
    config.value.creditcoin.rpcUrl,
    config.value.creditcoin.chainId,
    config.value.rpcBatchMaxCount,
  );

  try {
    const tip = await readCreditcoinTip(provider);
    if (!tip.ok) {
      console.error(`probe-attestation: ${tip.error.code}: ${tip.error.message}`);
      return 2;
    }

    // ---- 1. does `waitUntilHeightAttested` exist on the precompile?
    const absence: Record<string, unknown> = {};
    let everyNameAbsent = true;
    for (const [signature, expected] of Object.entries(PRECOMPILE_NAMES_THAT_DO_NOT_EXIST)) {
      const iface = new Interface([`function ${signature} view returns (bool)`]);
      const argCount = signature.slice(signature.indexOf("(") + 1, -1).split(",").length;
      const args = [3n, 25876970n, 1n].slice(0, argCount);
      const call = await rawCall(provider, chainInfo, iface.encodeFunctionData(signature.slice(0, signature.indexOf("(")), args));
      const unknownSelector = !call.ok && /unknown selector/i.test(call.message ?? "");
      if (!unknownSelector) everyNameAbsent = false;
      absence[signature] = {
        expectedSelector: expected.selector,
        actualSelector: iface.getFunction(signature.slice(0, signature.indexOf("(")))!.selector,
        answered: call.ok,
        rawReturnData: call.raw,
        nodeMessage: call.message,
        verdict: unknownSelector ? "absent, as recorded" : "ANSWERED — the record is now wrong",
      };
    }

    // ---- 2. the fallback shape, and the wait built on it
    const reader = createProofBuilderApiSource();
    const chainInfoReader = createPrecompileChainInfoReader(provider, chainInfo, CREDITCOIN_BLOCK_TAG);
    const frontiers: Record<string, unknown> = {};
    const waits: Record<string, unknown> = {};
    let everyChainAttesting = true;

    for (const chainKey of [1, 3] as const satisfies readonly ChainKey[]) {
      const frontier = await chainInfoReader.getLatestAttestation(BigInt(chainKey));
      if (!frontier.ok) {
        everyChainAttesting = false;
        frontiers[chainKey] = { error: frontier.error.code, message: frontier.error.message };
        continue;
      }
      frontiers[chainKey] = frontier.value;

      // A height well below the frontier is covered, so this returns on poll 1.
      const covered = await waitUntilHeightAttested(chainInfoReader, chainKey, frontier.value.height - 100n, {
        timeoutMs: 1_000,
        pollIntervalMs: 1_000,
      });
      // A height far above it cannot be covered, so this reports TIMED_OUT rather
      // than blocking for the documented 15 minutes.
      const uncovered = await waitUntilHeightAttested(chainInfoReader, chainKey, frontier.value.height + 1_000_000n, {
        timeoutMs: 1,
        pollIntervalMs: 1,
      });
      if (!covered.ok || covered.value.outcome !== "ATTESTED") everyChainAttesting = false;
      waits[chainKey] = {
        belowFrontier: covered.ok ? covered.value.outcome : covered.error.code,
        farAboveFrontier: uncovered.ok ? uncovered.value.outcome : uncovered.error.code,
      };

      // ---- 3. is_height_attested one height past the frontier
      const iface = new Interface(["function is_height_attested(uint64,uint64) view returns (bool)"]);
      const pastTip = await rawCall(
        provider,
        chainInfo,
        iface.encodeFunctionData("is_height_attested", [BigInt(chainKey), frontier.value.height + 1n]),
      );
      const corroboration = await reader.latestAttestedHeight(chainKey);
      frontiers[`${chainKey}-cross-checks`] = {
        isHeightAttestedAtTipPlusOne: pastTip.ok ? pastTip.raw : pastTip.message,
        proofBuilderAttestedHeight: corroboration.ok ? corroboration.value : corroboration.error.code,
      };
    }

    // ---- 4 and 5. the genuine material: keyless preflight, and the local fold
    let live: unknown;
    try {
      live = JSON.parse(readFileSync(LIVE_RESULTS, "utf8"));
    } catch (error) {
      console.error(`probe-attestation: ${LIVE_RESULTS} could not be read: ${String(error)}`);
      return 2;
    }
    const recorded = (live as { cases?: Record<string, Record<string, never>> }).cases?.[
      GENUINE_PAYLOAD_CASE
    ] as
      | {
          submitted: { blockHeight: number; encodedTransaction: string; merkleProof: unknown; continuityProof: unknown };
          mutation: { genuine: string };
          target: { chainKey: number; sourceTxHash: string };
          proofMaterial: { txIndexFromProofBuilder: number };
        }
      | undefined;
    if (recorded === undefined) {
      console.error(`probe-attestation: ${LIVE_RESULTS} carries no \`${GENUINE_PAYLOAD_CASE}\` case`);
      return 2;
    }

    // The recorded case forged the root, so the genuine root is the mutation's
    // `genuine` field. Everything else in it is untouched.
    const genuine = normaliseProofMaterial("PROOF_BUILDER", recorded.target.chainKey as ChainKey, recorded.target.sourceTxHash, {
      headerNumber: recorded.submitted.blockHeight,
      txIndex: recorded.proofMaterial.txIndexFromProofBuilder,
      txHash: recorded.target.sourceTxHash,
      txBytes: recorded.submitted.encodedTransaction,
      merkleProof: {
        ...(recorded.submitted.merkleProof as Record<string, unknown>),
        root: recorded.mutation.genuine,
      },
      continuityProof: recorded.submitted.continuityProof,
    });
    if (!genuine.ok) {
      console.error(`probe-attestation: ${genuine.error.code}: ${genuine.error.message}`);
      return 2;
    }

    const txIndexReader = createPrecompileTxIndexReader(provider, blockProver, CREDITCOIN_BLOCK_TAG);
    const readIndex = await txIndexReader.calculateTxIndex(genuine.value.merkleProof);
    const check = checkDerivedRoot({
      sourceTxHash: genuine.value.sourceTxHash,
      encodedTransaction: genuine.value.encodedTransaction,
      merkleProof: genuine.value.merkleProof,
      ...(readIndex.ok ? { txIndexFromPrecompile: readIndex.value } : {}),
    });
    const preflight = await createPrecompileVerifyPreflight(
      provider,
      blockProver,
      CREDITCOIN_BLOCK_TAG,
    ).preflight(genuine.value);

    // ---- 6. is a refused preflight the material or the age of the material?
    // The recorded Continuity Proof was built against the frontier as it stood
    // when the live suite ran. If a refusal is staleness rather than corruption,
    // freshly fetched material for the *same* transaction carries the same Merkle
    // root and a different Continuity Proof, and passes.
    const fresh = await reader.fetchProof(
      recorded.target.chainKey as ChainKey,
      recorded.target.sourceTxHash,
    );
    const freshPreflight = fresh.ok
      ? await createPrecompileVerifyPreflight(provider, blockProver, CREDITCOIN_BLOCK_TAG).preflight(
          fresh.value,
        )
      : undefined;
    // Where the proved height now sits relative to the attestation grid, which is
    // what sets a Continuity Proof's length.
    const boundsIface = new Interface([
      "function get_attestation_bounds(uint64,uint64) view returns (tuple(uint64 parentHeight, bytes32 parentHash, bool parentIsAttestation, uint64 childHeight, bytes32 childHash, bool childIsAttestation, bool isAttested))",
    ]);
    const boundsCall = await rawCall(
      provider,
      chainInfo,
      boundsIface.encodeFunctionData("get_attestation_bounds", [
        BigInt(recorded.target.chainKey),
        BigInt(recorded.submitted.blockHeight),
      ]),
    );
    const boundsNow =
      boundsCall.ok && boundsCall.raw !== undefined
        ? boundsIface.decodeFunctionResult("get_attestation_bounds", boundsCall.raw)[0]
        : boundsCall.message;

    const staleness = fresh.ok
      ? {
          provedHeight: recorded.submitted.blockHeight,
          attestationBoundsNow: boundsNow,
          merkleRootUnchanged: fresh.value.merkleProof.root.toLowerCase() === recorded.mutation.genuine.toLowerCase(),
          recordedContinuityRootCount: genuine.value.continuityProof.roots.length,
          freshContinuityRootCount: fresh.value.continuityProof.roots.length,
          continuityProofChanged:
            fresh.value.continuityProof.lowerEndpointDigest.toLowerCase() !==
            genuine.value.continuityProof.lowerEndpointDigest.toLowerCase(),
          freshPreflight:
            freshPreflight === undefined
              ? undefined
              : freshPreflight.ok
                ? freshPreflight.value
                : { error: freshPreflight.error.code, message: freshPreflight.error.message },
        }
      : { error: fresh.error.code, message: fresh.error.message };

    const derivationHolds = check.outcome === "MATCH";
    const preflightHolds =
      freshPreflight !== undefined && freshPreflight.ok && freshPreflight.value.accepted;

    console.log(
      JSON.stringify(
        {
          creditcoin: { ...tip.value, blockTag: CREDITCOIN_BLOCK_TAG },
          precompiles: { chainInfo, blockProver },
          question1_waitUntilHeightAttested: absence,
          question2_frontierAndWait: { frontiers, waits },
          question4_keylessPreflight: preflight.ok
            ? preflight.value
            : { error: preflight.error.code, message: preflight.error.message },
          question5_localDerivation: {
            recordedGenuineRoot: recorded.mutation.genuine,
            recordedTxIndex: recorded.proofMaterial.txIndexFromProofBuilder,
            derived: check.derived,
            txIndexFromPrecompile: readIndex.ok ? readIndex.value : readIndex.error.code,
            outcome: check.outcome,
            detail: check.detail,
          },
          question6_continuityProofStaleness: staleness,
        },
        jsonSafe,
        2,
      ),
    );

    return everyNameAbsent && everyChainAttesting && derivationHolds && preflightHolds ? 0 : 1;
  } finally {
    provider.destroy();
  }
}

process.exitCode = await main();
