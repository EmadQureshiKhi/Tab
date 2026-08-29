/**
 * Dual proof sourcing, and the gate between proof material and gas.
 *
 * Two independent sources answer the same question, and a third opinion — the
 * local re-derivation in `derive.ts` — decides which of them to believe. That is
 * the whole architecture: **the Watcher never pays gas for a proof it has not
 * itself verified**, so a faulty or hostile proof builder costs nothing.
 *
 * 1. Ask the Proof Builder API with a {@link PROOF_BUILDER_TIMEOUT_MS} timeout.
 * 2. On error or timeout, ask the RawProofBuilder path — a genuinely independent
 *    code path that rebuilds the block's Merkle tree from the Source Chain itself,
 *    not a retry of the same client (R20.3).
 * 3. Re-derive the root locally and submit only on an exact match (R20.4).
 * 4. On mismatch: withhold, log the Source Chain transaction hash, and retry
 *    through the alternate builder (R20.5).
 * 5. Both builders disagreeing with the local derivation is `HALTED`, not a
 *    retry loop. Two independent sources and a local fold cannot be reconciled by
 *    asking again.
 *
 * ## The 30-second timeout is a requirement, not a knob
 *
 * R20.3 fixes it, so it is a named constant rather than configuration. Making it
 * tunable would let an operator turn a requirement off by widening it until the
 * fallback never fires.
 *
 * ## One Continuity Proof per height. Never one shared across a batch
 *
 * The precompile reads a Continuity Proof's **first root** as the root of the
 * height being proved. A proof spanning several heights therefore verifies only
 * the lowest of them and reverts `Error("Merkle root mismatch")` for every other
 * height — measured on chain, evidence in `spike/gas-transcript.json`. So
 * {@link ProofMaterial} carries its own `continuityProof` and the Continuity Proof
 * travels inside each Settlement, never beside an array of them. A caller that
 * hoists one member's proof out to cover a batch has built a batch where nine of
 * ten members revert.
 *
 * ## Bad material is refused by the precompile, not by the contract
 *
 * `verifyAndEmit` **reverts** with the builtin `Error(string)` selector
 * `0x08c379a0` carrying `"Merkle proof validation failed"` rather than returning
 * `false`, so the contract's `ProofRejected` branch is unreachable through bad
 * proof material on this network. Two consequences, both encoded below:
 *
 * - a string revert is the *expected* refusal shape, not an anomaly, and
 * - the retry decision keys on the decoded **message**, because a selector cannot
 *   distinguish a proof-material refusal from any other string revert inside the
 *   precompile. An unrecognised `Error(string)` is SKIP-and-flag, never a
 *   retryable builder fault. See {@link classifyPrecompileRefusal} and design
 *   section 15.4.
 *
 * ## The preflight is free, so there is no excuse for skipping it
 *
 * The precompile publishes a `view` `verify` overload that answers over a plain
 * `eth_call` with no key and no gas. {@link createPrecompileVerifyPreflight} is
 * that call: a refusal costs nothing where the same refusal as a transaction costs
 * a receipt. Note that the precompile reports **zero code bytes** to
 * `eth_getCode`, as native precompiles do, so a successful call is the only valid
 * liveness probe for it.
 *
 * ## Proof material perishes, and only half of it does
 *
 * Measured, not assumed — see {@link PROOF_MATERIAL_PERISHES}. The **Merkle
 * inclusion proof is durable**: a block's transaction tree never changes, and the
 * root recorded for a Mainnet target in August re-derived byte-identically months
 * later. The **Continuity Proof is not**. Its length is the distance from the
 * proved height up to the nearest attestation endpoint at or above it, and that
 * distance *grows* as a range ages off the dense attestation grid onto the coarse
 * checkpoint grid. The same target needed 1 root when it was fresh and 31 roots
 * later, and the 1-root proof no longer verifies at all.
 *
 * Two consequences. Continuity Proofs must be fetched close to submission rather
 * than cached across a long delay. And a Settlement left unsubmitted gets steadily
 * more expensive to submit, which is the concrete mechanism behind the claim that
 * Settlement Windows under 24 hours keep material in the cheap regime (R16.5).
 *
 * Requirements: 20.2, 20.3, 20.4, 20.5, 3.3
 */

import { Interface, type BlockTag, type JsonRpcProvider } from "ethers";

import { err, ok, type ChainKey, type Result, type TabError } from "@tabai/shared";

import type { AttestedHeightCorroborator } from "./attestation.js";
import { checkDerivedRoot, type DerivationCheck, type MerkleProof, type TxIndexReader } from "./derive.js";
import { describeCause } from "./errors.js";
import type { SettlementState } from "./state.js";

/** Fixed by R20.3. Not configurable; see the module note. */
export const PROOF_BUILDER_TIMEOUT_MS = 30 * 1000;

/** The Proof Builder API for this network, per design section 8.4. */
export const DEFAULT_PROOF_BUILDER_URL = "https://prover.cc3-testnet.creditcoin.network";

/** Paths the Proof Builder API publishes, confirmed against the pinned client. */
export const PROOF_BUILDER_PATHS = {
  proofByTx: "/api/v1/proof-by-tx",
  attestedHeight: "/api/v1/attested-height",
} as const;

/**
 * The measured shelf life of proof material, recorded beside the code that has to
 * live with it.
 *
 * One Mainnet target, `0xe644fbd4…d1ed6fea` at height 25876970 on chainKey 3, was
 * proved by the live suite on 2026-08-31 while it sat 100 blocks below the attested
 * frontier. Re-preflighted keylessly from the same recorded material: the
 * precompile reverts `Error(string) "Continuity proof does not match attestation or
 * checkpoint"`. Freshly fetched material for the *same transaction* passes, raw
 * `0x…01`.
 *
 * What changed, and what did not:
 *
 * - the Merkle root is byte-identical, and the local fold still reproduces it;
 * - `get_attestation_bounds(3, 25876970)` now brackets the height with 25876900 and
 *   25877000, both reporting `isAttestation: false` — checkpoints on the stride-100
 *   grid — with `isAttested: true`. When the material was built, the height was
 *   itself an endpoint on the stride-10 attestation grid;
 * - so the Continuity Proof went from 1 root to 31, which is the 30-block distance
 *   up to the 25877000 endpoint plus the proved block itself.
 *
 * The arithmetic is the useful part: proof length is set by distance to the nearest
 * endpoint above, and ageing off the dense grid multiplies that distance by up to
 * the ratio of the two strides.
 */
export const PROOF_MATERIAL_PERISHES = {
  merkleInclusionProof: "durable — a block's transaction tree does not change",
  continuityProof:
    "perishable — length is the distance to the nearest endpoint at or above the proved height, plus one, and that distance grows as the range ages from the stride-10 attestation grid onto the stride-100 checkpoint grid",
  observedRefusal: "Continuity proof does not match attestation or checkpoint",
  observedRootCounts: { whenBuilt: 1, monthsLater: 31 },
  target: { chainKey: 3, height: 25876970, sourceTxHash: "0xe644fbd48f71010fa80f65d4549c0f8fa1f0d5cd9db4b22d21b89845d1ed6fea" },
} as const;

/**
 * The Proof Builder base URL from the environment, falling back to the network's
 * own. `PROOF_BUILDER_URL` is already declared in the tracked `.env.example`
 * contract; this reads it and introduces nothing new.
 */
export function proofBuilderUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PROOF_BUILDER_URL?.trim();
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_PROOF_BUILDER_URL;
}

/** Which of the two independent paths produced a piece of proof material. */
export type ProofSourceId = "PROOF_BUILDER" | "RAW_BUILDER";

/** A Continuity Proof: the digest chain from an attested endpoint down to a block. */
export interface ContinuityProof {
  readonly lowerEndpointDigest: string;
  /**
   * Digest roots, lowest first. The precompile reads `roots[0]` as the root of the
   * height being proved, which is why one proof covers exactly one height.
   */
  readonly roots: readonly string[];
}

/** Everything one Settlement needs to be submitted, from one source. */
export interface ProofMaterial {
  readonly source: ProofSourceId;
  readonly chainKey: ChainKey;
  /** The Source Chain block the transaction sits in. */
  readonly blockHeight: bigint;
  /** The index the *source* claims. Never trusted; cross-checked in `derive.ts`. */
  readonly txIndexFromSource: bigint;
  readonly sourceTxHash: string;
  /** The attested transaction-and-receipt encoding, which is the Merkle leaf. */
  readonly encodedTransaction: string;
  readonly merkleProof: MerkleProof;
  /** This height's own Continuity Proof. Never shared with another height. */
  readonly continuityProof: ContinuityProof;
  /** Whether the source served this from its cache. */
  readonly cached: boolean;
}

/** One of the two independent proof paths. */
export interface ProofSource {
  readonly id: ProofSourceId;
  /** One phrase naming the path, for the log line on a mismatch. */
  readonly describe: string;
  fetchProof(chainKey: ChainKey, sourceTxHash: string): Promise<Result<ProofMaterial>>;
}

// ------------------------------------------------------------------- decoding

const HEX = /^0x[0-9a-fA-F]*$/;

function malformed(source: ProofSourceId, detail: string): TabError {
  return {
    category: "PROOF",
    code: "PROOF_MATERIAL_MALFORMED",
    message: `${source} returned proof material this pipeline cannot read: ${detail}`,
    retryable: false,
  };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asHex = (value: unknown): string | undefined =>
  typeof value === "string" && HEX.test(value) ? value : undefined;

/** Accepts the number, bigint, or decimal-string forms the two paths use. */
function asBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value) : undefined;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

/**
 * Normalises either path's response into {@link ProofMaterial}.
 *
 * The Proof Builder API and the raw builder return the same field names —
 * `headerNumber`, `txIndex`, `txHash`, `txBytes`, `merkleProof`, `continuityProof`
 * — so one decoder serves both, and the two paths cannot drift into two shapes
 * this pipeline reads differently. Every field is checked: a source that omits the
 * sibling laterality would otherwise fold as an all-right path and produce a
 * plausible wrong root.
 */
export function normaliseProofMaterial(
  source: ProofSourceId,
  chainKey: ChainKey,
  sourceTxHash: string,
  raw: unknown,
): Result<ProofMaterial> {
  const body = asRecord(raw);
  if (body === undefined) return err(malformed(source, "the response is not an object"));

  const blockHeight = asBigInt(body.headerNumber);
  if (blockHeight === undefined) return err(malformed(source, "`headerNumber` is not an integer"));

  const txIndexFromSource = asBigInt(body.txIndex);
  if (txIndexFromSource === undefined) return err(malformed(source, "`txIndex` is not an integer"));

  const encodedTransaction = asHex(body.txBytes);
  if (encodedTransaction === undefined) return err(malformed(source, "`txBytes` is not a hex string"));

  const merkle = asRecord(body.merkleProof);
  const root = merkle === undefined ? undefined : asHex(merkle.root);
  if (merkle === undefined || root === undefined) {
    return err(malformed(source, "`merkleProof.root` is missing or is not a hex string"));
  }
  if (!Array.isArray(merkle.siblings)) {
    return err(malformed(source, "`merkleProof.siblings` is not an array"));
  }
  const siblings: { hash: string; isLeft: boolean }[] = [];
  for (const [position, entry] of merkle.siblings.entries()) {
    const sibling = asRecord(entry);
    const hash = sibling === undefined ? undefined : asHex(sibling.hash);
    if (sibling === undefined || hash === undefined || typeof sibling.isLeft !== "boolean") {
      return err(
        malformed(source, `\`merkleProof.siblings[${position}]\` is not a {hash, isLeft} pair`),
      );
    }
    siblings.push({ hash, isLeft: sibling.isLeft });
  }

  const continuity = asRecord(body.continuityProof);
  const lowerEndpointDigest =
    continuity === undefined ? undefined : asHex(continuity.lowerEndpointDigest);
  if (continuity === undefined || lowerEndpointDigest === undefined) {
    return err(malformed(source, "`continuityProof.lowerEndpointDigest` is missing or not a hex string"));
  }
  if (!Array.isArray(continuity.roots) || continuity.roots.length === 0) {
    return err(
      malformed(
        source,
        "`continuityProof.roots` is empty or not an array, and the first root is the root of the height being proved",
      ),
    );
  }
  const roots: string[] = [];
  for (const [position, entry] of continuity.roots.entries()) {
    const digest = asHex(entry);
    if (digest === undefined) {
      return err(malformed(source, `\`continuityProof.roots[${position}]\` is not a hex string`));
    }
    roots.push(digest);
  }

  const reportedHash = asHex(body.txHash);
  if (reportedHash !== undefined && reportedHash.toLowerCase() !== sourceTxHash.toLowerCase()) {
    return err(
      malformed(
        source,
        `the material is for source transaction ${reportedHash}, not the requested ${sourceTxHash}`,
      ),
    );
  }

  return ok({
    source,
    chainKey,
    blockHeight,
    txIndexFromSource,
    sourceTxHash,
    encodedTransaction,
    merkleProof: { root, siblings },
    continuityProof: { lowerEndpointDigest, roots },
    cached: body.cached === true,
  });
}

// ------------------------------------------------------ the Proof Builder API

export interface ProofBuilderApiOptions {
  /** Defaults to {@link proofBuilderUrlFromEnv}. */
  readonly baseUrl?: string;
  /** Defaults to {@link PROOF_BUILDER_TIMEOUT_MS}, which R20.3 fixes. */
  readonly timeoutMs?: number;
  /** Injected so a test drives the client without a network. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * The primary path: plain HTTP against the Proof Builder API.
 *
 * Written against `fetch` and `AbortSignal.timeout` rather than an HTTP client
 * library, because the timeout is the requirement and a hand-rolled deadline is
 * the part worth being able to read. The returned object also satisfies
 * {@link AttestedHeightCorroborator}, so the attestation wait can ask this same
 * service whether it has ingested a height yet — the service can lag the chain,
 * and a request one second too early comes back as a miss rather than a proof.
 */
export function createProofBuilderApiSource(
  options: ProofBuilderApiOptions = {},
): ProofSource & AttestedHeightCorroborator {
  const baseUrl = (options.baseUrl ?? proofBuilderUrlFromEnv()).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? PROOF_BUILDER_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  /** One GET with the deadline attached. A timeout is retryable; a 4xx is not. */
  const get = async (path: string, what: string): Promise<Result<unknown>> => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const cause = describeCause(error);
      const timedOut = cause.code === "TimeoutError" || /abort|timeout/i.test(cause.message);
      return err({
        category: "UPSTREAM",
        code: timedOut ? "PROOF_BUILDER_TIMEOUT" : "PROOF_BUILDER_UNREACHABLE",
        message: timedOut
          ? `the Proof Builder did not answer ${what} within ${timeoutMs}ms, so the independent builder path takes over`
          : `the Proof Builder could not be reached for ${what}`,
        retryable: true,
        cause,
      });
    }

    if (!response.ok) {
      return err({
        category: "UPSTREAM",
        code: "PROOF_BUILDER_REFUSED",
        message: `the Proof Builder answered HTTP ${response.status} for ${what}`,
        // A 5xx may pass; a 4xx means this request will never succeed as asked.
        retryable: response.status >= 500,
        details: { status: response.status },
      });
    }

    try {
      return ok(await response.json());
    } catch (error) {
      return err({
        category: "UPSTREAM",
        code: "PROOF_BUILDER_UNPARSEABLE",
        message: `the Proof Builder answered ${what} with a body that is not JSON`,
        retryable: true,
        cause: describeCause(error),
      });
    }
  };

  return {
    id: "PROOF_BUILDER",
    describe: `the Proof Builder API at ${baseUrl}`,

    async fetchProof(chainKey: ChainKey, sourceTxHash: string): Promise<Result<ProofMaterial>> {
      const body = await get(
        `${PROOF_BUILDER_PATHS.proofByTx}/${chainKey}/${sourceTxHash}`,
        `proof material for source transaction ${sourceTxHash}`,
      );
      if (!body.ok) return err(body.error);
      return normaliseProofMaterial("PROOF_BUILDER", chainKey, sourceTxHash, body.value);
    },

    async latestAttestedHeight(chainKey: ChainKey): Promise<Result<bigint | undefined>> {
      const body = await get(
        `${PROOF_BUILDER_PATHS.attestedHeight}/${chainKey}`,
        `the attested height of chainKey ${chainKey}`,
      );
      if (!body.ok) return err(body.error);
      const record = asRecord(body.value);
      const height = record === undefined ? undefined : asBigInt(record.attestedHeight);
      return ok(height);
    },
  };
}

// ------------------------------------------------------- the raw builder path

/**
 * The shape the raw builder path presents.
 *
 * Declared structurally rather than imported, so `apps/watcher` does not need the
 * proof-building client on its dependency list to compile this seam. The pinned
 * client's `RawProofBuilder` satisfies it as written: same method, same result
 * envelope. Wiring it is one constructor call at the pipeline's edge.
 */
export interface RawProofProviderLike {
  getProof(
    transactionHash: string,
  ): Promise<{ success: boolean; data?: unknown; error?: string | undefined }>;
}

/**
 * The fallback path, wrapped as a {@link ProofSource}.
 *
 * This is independent in the way R20.3 means: the raw builder fetches every
 * transaction and receipt in the block from a Source Chain endpoint, re-encodes
 * them, and rebuilds the tree. It shares no client, no cache, and no network hop
 * with the Proof Builder API, so the two failing identically is evidence about the
 * material rather than about one service.
 */
export function createRawProofBuilderSource(provider: RawProofProviderLike): ProofSource {
  return {
    id: "RAW_BUILDER",
    describe: "the RawProofBuilder path, rebuilding the block's tree from the Source Chain",

    async fetchProof(chainKey: ChainKey, sourceTxHash: string): Promise<Result<ProofMaterial>> {
      let outcome: Awaited<ReturnType<RawProofProviderLike["getProof"]>>;
      try {
        outcome = await provider.getProof(sourceTxHash);
      } catch (error) {
        return err({
          category: "UPSTREAM",
          code: "RAW_BUILDER_FAILED",
          message: `the RawProofBuilder path could not build proof material for source transaction ${sourceTxHash}`,
          retryable: true,
          cause: describeCause(error),
        });
      }
      if (!outcome.success) {
        return err({
          category: "UPSTREAM",
          code: "RAW_BUILDER_REFUSED",
          message: `the RawProofBuilder path refused source transaction ${sourceTxHash}: ${outcome.error ?? "no reason given"}`,
          retryable: true,
        });
      }
      return normaliseProofMaterial("RAW_BUILDER", chainKey, sourceTxHash, outcome.data);
    },
  };
}

// --------------------------------------------------------------- the sourcing

/** What one source attempt produced. */
export interface ProofAttempt {
  readonly source: ProofSourceId;
  /** Absent when the source could not be reached or answered malformed material. */
  readonly check: DerivationCheck | undefined;
  /** Absent when the source answered and the failure was the derivation. */
  readonly error: TabError | undefined;
  /** The log line, always populated, always naming the Source Chain hash (R20.5). */
  readonly detail: string;
}

/** The outcome of asking both sources and folding both answers. */
export interface ProofSourcingResult {
  /**
   * The state this Settlement moves to: `READY` on a verified match, `WITHHELD`
   * when one source disagreed and the other has not been tried or also failed to
   * answer, `HALTED` when both independent sources disagreed with the local fold.
   */
  readonly nextState: Extract<SettlementState, "READY" | "WITHHELD" | "HALTED">;
  /** Present only when `nextState` is `READY`. */
  readonly material: ProofMaterial | undefined;
  /** The verified derivation, present only alongside `material`. */
  readonly check: DerivationCheck | undefined;
  /** Every attempt, in order, so the log explains the verdict rather than asserts it. */
  readonly attempts: readonly ProofAttempt[];
}

export interface ProofSourcingInput {
  readonly chainKey: ChainKey;
  readonly sourceTxHash: string;
  /** The Proof Builder API path (R20.2). */
  readonly primary: ProofSource;
  /** The independent RawProofBuilder path (R20.3). Omit only where none is wired. */
  readonly fallback?: ProofSource;
  /**
   * Reads `calculateTxIndex` from the precompile for the design section 8.4 step 5
   * cross-check. Omitted, the root check still gates spending; supplied, a
   * laterality misreading that happens to reproduce the root is caught too.
   */
  readonly txIndexReader?: TxIndexReader;
}

/**
 * Asks the sources in order and returns the first answer the local derivation
 * agrees with.
 *
 * The escalation is deliberate and is not a retry loop. A source that cannot be
 * reached and a source whose root does not fold to the same value are different
 * failures, but they take the same next step — ask the *other* source — because
 * neither is evidence about the material. Only when both independent sources have
 * answered and both disagree with the local fold does this halt: at that point
 * asking again cannot produce new information, and an operator has a question to
 * answer.
 *
 * A cross-check read that itself fails is not allowed to withhold a Settlement
 * whose root matched. The precompile being briefly unreachable says nothing about
 * the proof, and treating it as a mismatch would convert an RPC hiccup into a
 * halted Settlement.
 */
export async function sourceVerifiedProofMaterial(
  input: ProofSourcingInput,
): Promise<ProofSourcingResult> {
  const sources: readonly ProofSource[] =
    input.fallback === undefined ? [input.primary] : [input.primary, input.fallback];
  const attempts: ProofAttempt[] = [];
  let disagreements = 0;

  for (const source of sources) {
    const fetched = await source.fetchProof(input.chainKey, input.sourceTxHash);
    if (!fetched.ok) {
      attempts.push({
        source: source.id,
        check: undefined,
        error: fetched.error,
        detail: `${source.describe} did not supply proof material for source transaction ${input.sourceTxHash}: ${fetched.error.message}`,
      });
      continue;
    }

    const material = fetched.value;
    let txIndexFromPrecompile: bigint | undefined;
    if (input.txIndexReader !== undefined) {
      const read = await input.txIndexReader.calculateTxIndex(material.merkleProof);
      if (read.ok) txIndexFromPrecompile = read.value;
    }

    const check = checkDerivedRoot({
      sourceTxHash: input.sourceTxHash,
      encodedTransaction: material.encodedTransaction,
      merkleProof: material.merkleProof,
      ...(txIndexFromPrecompile === undefined ? {} : { txIndexFromPrecompile }),
    });

    attempts.push({
      source: source.id,
      check,
      error: undefined,
      detail: `${source.describe}: ${check.detail}`,
    });

    if (check.outcome === "MATCH") {
      return { nextState: "READY", material, check, attempts };
    }
    disagreements += 1;
  }

  // Both independent sources answered and neither agreed with the local fold.
  const bothDisagreed = sources.length > 1 && disagreements === sources.length;
  return {
    nextState: bothDisagreed ? "HALTED" : "WITHHELD",
    material: undefined,
    check: undefined,
    attempts,
  };
}

// ------------------------------------------------------- refusal classification

/** What the pipeline does with a refusal from the precompile. */
export type RefusalAction =
  /** the material is unproven; ask the other builder once */
  | "RETRY_ALTERNATE_BUILDER"
  /** unrecognised, or a refusal no builder can fix; skip and flag for an operator */
  | "SKIP_AND_FLAG";

/**
 * Refusal messages observed from the precompile, mapped to what to do about them.
 * Keyed on the decoded message rather than on the selector, because
 * `Error(string)` is the same selector for every string revert the precompile
 * raises and so carries no information on its own.
 */
export const KNOWN_PRECOMPILE_REFUSALS: Readonly<Record<string, RefusalAction>> = {
  // Observed on chain for a forged root and for a one-byte-tampered payload.
  "merkle proof validation failed": "RETRY_ALTERNATE_BUILDER",
  // Observed live for proof material that was correct when it was built and has
  // since expired; see PROOF_MATERIAL_PERISHES. Re-fetching is exactly the fix,
  // so this is the one refusal where a retry is not a hopeful guess.
  "continuity proof does not match attestation or checkpoint": "RETRY_ALTERNATE_BUILDER",
  // Observed for a Continuity Proof shared across a batch: every height above the
  // lowest is refused. The material is wrong by construction, not stale.
  "merkle root mismatch": "SKIP_AND_FLAG",
  // The pinned ABI no longer matches the chain. No builder can fix that.
  "unknown selector": "SKIP_AND_FLAG",
};

/** The verdict on one refusal, with the reasoning attached. */
export interface RefusalClassification {
  readonly action: RefusalAction;
  /** True when the message is one this pipeline has seen from this precompile. */
  readonly recognised: boolean;
  readonly message: string;
  readonly detail: string;
}

/**
 * Classifies an `Error(string)` refusal from the precompile.
 *
 * The conservative default is the point: an unrecognised message is SKIP-and-flag,
 * never a retryable builder fault. Guessing "retry" on an unknown refusal spends
 * gas twice to learn nothing, and design section 15.4 is explicit that the
 * selector cannot tell a proof-material refusal from any other string revert.
 */
export function classifyPrecompileRefusal(revertMessage: string): RefusalClassification {
  const normalised = revertMessage.trim().toLowerCase();
  for (const [known, action] of Object.entries(KNOWN_PRECOMPILE_REFUSALS)) {
    if (normalised.includes(known)) {
      return {
        action,
        recognised: true,
        message: revertMessage,
        detail:
          action === "RETRY_ALTERNATE_BUILDER"
            ? `the precompile refused the material with "${revertMessage}", which the alternate builder may supply correctly, so it is retried once`
            : `the precompile refused the material with "${revertMessage}", which no builder can supply differently, so the Settlement is skipped and flagged`,
      };
    }
  }
  return {
    action: "SKIP_AND_FLAG",
    recognised: false,
    message: revertMessage,
    detail: `the precompile reverted Error(string) with the unrecognised message "${revertMessage}"; an unrecognised string revert is not treated as a retryable builder fault, so the Settlement is skipped and flagged`,
  };
}

// --------------------------------------------------------------- the preflight

/**
 * The `view` `verify` overload. Confirmed live: it answers over a plain
 * `eth_call` with no key and no gas, returning raw `0x…01` for genuine material.
 *
 * Only the single-Settlement overload is declared. The array-shaped one exists and
 * verifies, but returns one boolean for a whole batch and so cannot attribute a
 * failure to a named Settlement (R9.7).
 */
export const BLOCK_PROVER_VERIFY_ABI = [
  {
    type: "function",
    name: "verify",
    stateMutability: "view",
    inputs: [
      { name: "chainKey", type: "uint64" },
      { name: "height", type: "uint64" },
      { name: "encodedTransaction", type: "bytes" },
      {
        name: "merkleProof",
        type: "tuple",
        components: [
          { name: "root", type: "bytes32" },
          {
            name: "siblings",
            type: "tuple[]",
            components: [
              { name: "hash", type: "bytes32" },
              { name: "isLeft", type: "bool" },
            ],
          },
        ],
      },
      {
        name: "continuityProof",
        type: "tuple",
        components: [
          { name: "lowerEndpointDigest", type: "bytes32" },
          { name: "roots", type: "bytes32[]" },
        ],
      },
    ],
    outputs: [{ name: "verified", type: "bool" }],
  },
] as const;

/** What the keyless preflight established. */
export interface PreflightVerdict {
  /** True only when the precompile returned `true`. */
  readonly accepted: boolean;
  /** Raw returndata, kept because the bytes are the evidence and the decode is a convenience. */
  readonly raw: string | undefined;
  /** The decoded `Error(string)` message, when the call reverted with one. */
  readonly revertMessage: string | undefined;
  /** What to do about a refusal, absent when the material was accepted. */
  readonly classification: RefusalClassification | undefined;
  readonly detail: string;
}

/** The keyless preflight surface. */
export interface VerifyPreflight {
  preflight(material: ProofMaterial): Promise<Result<PreflightVerdict>>;
}

/** The builtin `Error(string)` selector. Every string revert carries it. */
const ERROR_STRING_SELECTOR = "0x08c379a0";

/** Pulls the message out of `Error(string)` returndata, or returns undefined. */
function decodeErrorString(iface: Interface, data: unknown): string | undefined {
  if (typeof data !== "string" || !data.startsWith(ERROR_STRING_SELECTOR)) return undefined;
  try {
    const decoded = iface.decodeErrorResult("Error(string)", data);
    return typeof decoded[0] === "string" ? decoded[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the keyless preflight against the BlockProver Precompile.
 *
 * @param provider a provider from `createJsonRpcProvider`, so batching is off
 * @param address the BlockProver Precompile address, from configuration
 * @param blockTag one tag for every read, as everywhere else in the Watcher
 */
export function createPrecompileVerifyPreflight(
  provider: JsonRpcProvider,
  address: string,
  blockTag: BlockTag,
): VerifyPreflight {
  const iface = new Interface(BLOCK_PROVER_VERIFY_ABI);

  return {
    async preflight(material: ProofMaterial): Promise<Result<PreflightVerdict>> {
      const data = iface.encodeFunctionData("verify", [
        BigInt(material.chainKey),
        material.blockHeight,
        material.encodedTransaction,
        [material.merkleProof.root, material.merkleProof.siblings.map((s) => [s.hash, s.isLeft])],
        [material.continuityProof.lowerEndpointDigest, material.continuityProof.roots],
      ]);

      let returnData: string;
      try {
        returnData = await provider.call({ to: address, data, blockTag });
      } catch (error) {
        const revertMessage = decodeErrorString(
          iface,
          (error as { data?: unknown } | null)?.data,
        );
        if (revertMessage === undefined) {
          return err({
            category: "UPSTREAM",
            code: "PREFLIGHT_UNREADABLE",
            message: `the keyless preflight of source transaction ${material.sourceTxHash} neither answered nor reverted with a decodable Error(string)`,
            retryable: true,
            cause: describeCause(error),
          });
        }
        const classification = classifyPrecompileRefusal(revertMessage);
        return ok({
          accepted: false,
          raw: typeof (error as { data?: unknown }).data === "string"
            ? ((error as { data: string }).data)
            : undefined,
          revertMessage,
          classification,
          detail: `the keyless preflight refused source transaction ${material.sourceTxHash} for nothing: ${classification.detail}`,
        });
      }

      let accepted = false;
      try {
        accepted = iface.decodeFunctionResult("verify", returnData)[0] === true;
      } catch {
        return err({
          category: "CHAIN",
          code: "PREFLIGHT_DECODE_FAILED",
          message: "`verify` returned a shape this ABI cannot read",
          retryable: false,
        });
      }

      return {
        ok: true,
        value: {
          accepted,
          raw: returnData,
          revertMessage: undefined,
          classification: accepted
            ? undefined
            : classifyPrecompileRefusal("verify returned false without reverting"),
          detail: accepted
            ? `the keyless preflight accepted source transaction ${material.sourceTxHash}, so a submission is worth its gas`
            : `the keyless preflight of source transaction ${material.sourceTxHash} returned false without reverting, which this network has not been observed to do`,
        },
      };
    },
  };
}
