/**
 * Proof material: fetched from the Proof Builder, then checked before it is sold.
 *
 * ## A deliberate re-expression, narrowed to what a Service sells
 *
 * `apps/watcher/src/proof.ts` and `apps/watcher/src/derive.ts` already source and
 * check proof material, and the dependency rule puts both out of reach from
 * `services/*`. What is re-expressed here is the subset a paid endpoint needs: one
 * source, one normaliser, and the local fold. The Watcher's dual-source
 * corroboration is deliberately **not** copied, because its purpose is to decide
 * whether to spend gas submitting a Settlement, and this Service's purpose is to
 * decide whether to charge for material it is about to hand over. The report for
 * this task names the promotion into `packages/sdk` that would retire the copy.
 *
 * ## The material is folded locally before an Agent is charged for it
 *
 * The builder states a root. This module recomputes it from the encoded
 * transaction and the sibling path and refuses the material when the two disagree.
 * That check costs one keccak per level and is the difference between selling a
 * proof and selling a plausible-looking string: `verifyAndEmit` reverts
 * `Error("Merkle proof validation failed")` on a bad path, and an Agent that has
 * already been charged for it has paid for a revert.
 *
 * The domain tags are not optional. The tree is `leaf = keccak256(0x00 ‖ bytes)`
 * and `node = keccak256(0x01 ‖ left ‖ right)`; folding without them reproduces a
 * root that matches nothing, which the Watcher measured against genuine Mainnet
 * material before this was written down.
 *
 * ## The Continuity Proof perishes and the Merkle Proof does not
 *
 * A block's transaction tree never changes, so an inclusion proof is durable. A
 * Continuity Proof covers exactly one height and its length is the distance to the
 * nearest attestation endpoint at or above that height, so it grows as the range
 * ages off the stride-10 attestation grid onto the stride-100 checkpoint grid.
 * Recorded material for one Mainnet target went from 1 root to 31 over a month and
 * the precompile then refused it. This Service therefore fetches at request time
 * and caches nothing, which is also why {@link ProofMaterial} carries the source's
 * own `cached` flag through rather than hiding it.
 *
 * Requirements: 22.1, 22.3, 20.3, 20.5
 */

import { causeOf, err, keccak256, ok, type Bytes32, type Result, type TabError } from "@tabai/shared";

/** Fixed by R20.3. Not configurable. */
export const PROOF_BUILDER_TIMEOUT_MS = 30 * 1000;

/** Paths the Proof Builder API publishes, confirmed against the pinned client. */
export const PROOF_BUILDER_PATHS = {
  proofByTx: "/api/v1/proof-by-tx",
  attestedHeight: "/api/v1/attested-height",
} as const;

/** Domain tag prefixed before hashing a leaf. */
export const LEAF_TAG = 0x00;

/** Domain tag prefixed before hashing an inner node. */
export const INNER_TAG = 0x01;

/**
 * Longest sibling path this module will fold.
 *
 * The transaction index is a `uint64` on the wire and in the replay key, so a path
 * deeper than 64 could not be represented in the field it feeds. A real block is
 * nowhere near: a recorded Mainnet target carried 9 siblings. The bound exists so
 * an absurd path is refused rather than silently truncated.
 */
export const MAX_SIBLING_PATH = 64;

/** One step of a Merkle inclusion path. `isLeft` is the *sibling's* laterality. */
export interface MerkleProofEntry {
  readonly hash: string;
  readonly isLeft: boolean;
}

/** An inclusion proof as the builder returns it. */
export interface MerkleProof {
  readonly root: string;
  readonly siblings: readonly MerkleProofEntry[];
}

/** A Continuity Proof: the digest chain from an attested endpoint down to a block. */
export interface ContinuityProof {
  readonly lowerEndpointDigest: string;
  /**
   * Digest roots, lowest first. The precompile reads `roots[0]` as the root of the
   * height being proved, which is why one proof covers exactly one height.
   */
  readonly roots: readonly string[];
}

/** Everything a `verifyAndEmit` call needs, from one source. */
export interface ProofMaterial {
  readonly chainKey: bigint;
  /** The Source Chain block the transaction sits in. */
  readonly blockHeight: bigint;
  /** The index the source claims. Cross-checked against the sibling laterality. */
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

/** The one proof path this Service sells from. */
export interface ProofSource {
  /** One phrase naming the path, for the log line on a refusal. */
  readonly describe: string;
  fetchProof(chainKey: bigint, sourceTxHash: string): Promise<Result<ProofMaterial>>;
  /** The builder's own view of the frontier, carried as corroboration only. */
  latestAttestedHeight(chainKey: bigint): Promise<Result<bigint | undefined>>;
}

// ------------------------------------------------------------------- decoding

const HEX = /^0x[0-9a-fA-F]*$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

function malformed(detail: string): TabError {
  return {
    category: "PROOF",
    code: "PROOF_MATERIAL_MALFORMED",
    message: `the Proof Builder returned proof material this service cannot read: ${detail}`,
    retryable: false,
  };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asHex = (value: unknown): string | undefined =>
  typeof value === "string" && HEX.test(value) ? value : undefined;

/** Accepts the number, bigint, or decimal-string forms the builder uses. */
export function asBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value) : undefined;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

/**
 * Normalises a builder response into {@link ProofMaterial}.
 *
 * Every field is checked. A source that omits the sibling laterality would
 * otherwise fold as an all-right path and produce a plausible wrong root, which is
 * exactly the failure that is invisible until the precompile refuses it.
 */
export function normaliseProofMaterial(
  chainKey: bigint,
  sourceTxHash: string,
  raw: unknown,
): Result<ProofMaterial> {
  const body = asRecord(raw);
  if (body === undefined) return err(malformed("the response is not an object"));

  const blockHeight = asBigInt(body["headerNumber"]);
  if (blockHeight === undefined) return err(malformed("`headerNumber` is not an integer"));

  const txIndexFromSource = asBigInt(body["txIndex"]);
  if (txIndexFromSource === undefined) return err(malformed("`txIndex` is not an integer"));

  const encodedTransaction = asHex(body["txBytes"]);
  if (encodedTransaction === undefined) return err(malformed("`txBytes` is not a hex string"));

  const merkle = asRecord(body["merkleProof"]);
  const root = merkle === undefined ? undefined : asHex(merkle["root"]);
  if (merkle === undefined || root === undefined) {
    return err(malformed("`merkleProof.root` is missing or is not a hex string"));
  }
  if (!Array.isArray(merkle["siblings"])) {
    return err(malformed("`merkleProof.siblings` is not an array"));
  }
  const siblings: MerkleProofEntry[] = [];
  for (const [position, entry] of (merkle["siblings"] as readonly unknown[]).entries()) {
    const sibling = asRecord(entry);
    const hash = sibling === undefined ? undefined : asHex(sibling["hash"]);
    if (sibling === undefined || hash === undefined || typeof sibling["isLeft"] !== "boolean") {
      return err(malformed(`\`merkleProof.siblings[${position}]\` is not a {hash, isLeft} pair`));
    }
    siblings.push({ hash, isLeft: sibling["isLeft"] });
  }

  const continuity = asRecord(body["continuityProof"]);
  const lowerEndpointDigest =
    continuity === undefined ? undefined : asHex(continuity["lowerEndpointDigest"]);
  if (continuity === undefined || lowerEndpointDigest === undefined) {
    return err(malformed("`continuityProof.lowerEndpointDigest` is missing or is not a hex string"));
  }
  const rawRoots = continuity["roots"];
  if (!Array.isArray(rawRoots) || rawRoots.length === 0) {
    return err(
      malformed(
        "`continuityProof.roots` is empty or is not an array, and the first root is the root of the height being proved",
      ),
    );
  }
  const roots: string[] = [];
  for (const [position, entry] of (rawRoots as readonly unknown[]).entries()) {
    const digest = asHex(entry);
    if (digest === undefined) {
      return err(malformed(`\`continuityProof.roots[${position}]\` is not a hex string`));
    }
    roots.push(digest);
  }

  const reportedHash = asHex(body["txHash"]);
  if (reportedHash !== undefined && reportedHash.toLowerCase() !== sourceTxHash.toLowerCase()) {
    return err(
      malformed(
        `the material is for source transaction ${reportedHash}, not the requested ${sourceTxHash}`,
      ),
    );
  }

  return ok({
    chainKey,
    blockHeight,
    txIndexFromSource,
    sourceTxHash,
    encodedTransaction,
    merkleProof: { root, siblings },
    continuityProof: { lowerEndpointDigest, roots },
    cached: body["cached"] === true,
  });
}

// ------------------------------------------------------------- local folding

/** Parses an even-length `0x` hex string. Returns undefined rather than throwing. */
function bytesFromHex(value: string): Uint8Array | undefined {
  if (!HEX_BYTES.test(value)) return undefined;
  const body = value.slice(2);
  const bytes = new Uint8Array(body.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** True for a `0x`-prefixed 32-byte word. */
function isBytes32Hex(value: unknown): value is string {
  return typeof value === "string" && value.length === 66 && HEX_BYTES.test(value);
}

/** `keccak256(0x00 ‖ bytes)`. The leaf tag is not optional; see the module note. */
export function hashLeaf(bytes: Uint8Array): Bytes32 {
  const tagged = new Uint8Array(bytes.length + 1);
  tagged[0] = LEAF_TAG;
  tagged.set(bytes, 1);
  return keccak256(tagged);
}

/** `keccak256(0x01 ‖ left ‖ right)`. */
export function hashInner(left: Uint8Array, right: Uint8Array): Bytes32 {
  const tagged = new Uint8Array(65);
  tagged[0] = INNER_TAG;
  tagged.set(left, 1);
  tagged.set(right, 33);
  return keccak256(tagged);
}

/** What one pass over the sibling path establishes. */
export interface DerivedRoot {
  readonly root: string;
  /** Transaction index read out of the sibling laterality. */
  readonly txIndex: bigint;
  /** The tagged leaf hash, carried so a mismatch can be localised to the leaf. */
  readonly leaf: string;
  readonly depth: number;
}

function derivationError(code: string, message: string): TabError {
  return { category: "PROOF", code, message, retryable: false };
}

/**
 * Re-derives the Merkle root and the transaction index from the encoded
 * transaction and the sibling path.
 *
 * Fails rather than guessing on malformed input. Each failure is a `PROOF` error
 * and none is retryable, because re-asking the same builder for the same malformed
 * shape produces the same malformed shape.
 */
export function deriveRoot(
  encodedTransaction: string,
  siblings: readonly MerkleProofEntry[],
): Result<DerivedRoot> {
  const payload = bytesFromHex(encodedTransaction);
  if (payload === undefined) {
    return err(
      derivationError(
        "DERIVE_ENCODED_TRANSACTION_MALFORMED",
        "the encoded transaction is not an even-length 0x-prefixed hex string, so no leaf can be hashed from it",
      ),
    );
  }
  if (siblings.length > MAX_SIBLING_PATH) {
    return err(
      derivationError(
        "DERIVE_PATH_TOO_DEEP",
        `the sibling path is ${siblings.length} deep, past the ${MAX_SIBLING_PATH} a uint64 transaction index can address`,
      ),
    );
  }

  const leaf = hashLeaf(payload);
  let node = bytesFromHex(leaf);
  if (node === undefined) {
    return err(derivationError("DERIVE_LEAF_UNREADABLE", "the leaf hash did not parse as bytes"));
  }
  let txIndex = 0n;
  let bit = 1n;

  for (const [level, sibling] of siblings.entries()) {
    if (!isBytes32Hex(sibling.hash)) {
      return err(
        derivationError(
          "DERIVE_SIBLING_MALFORMED",
          `sibling ${level} is not a 0x-prefixed 32-byte word, so the path cannot be folded`,
        ),
      );
    }
    if (typeof sibling.isLeft !== "boolean") {
      return err(
        derivationError(
          "DERIVE_LATERALITY_MISSING",
          `sibling ${level} carries no boolean isLeft, and laterality cannot be inferred from a hash`,
        ),
      );
    }
    const other = bytesFromHex(sibling.hash);
    if (other === undefined) {
      return err(
        derivationError("DERIVE_SIBLING_MALFORMED", `sibling ${level} did not parse as bytes`),
      );
    }
    // A left sibling means our node is the right child, which is also this level's
    // index bit. One pass, one reading of laterality.
    const folded = sibling.isLeft ? hashInner(other, node) : hashInner(node, other);
    const next = bytesFromHex(folded);
    if (next === undefined) {
      return err(derivationError("DERIVE_NODE_UNREADABLE", `level ${level} folded to an unreadable word`));
    }
    node = next;
    if (sibling.isLeft) txIndex |= bit;
    bit <<= 1n;
  }

  let root = "0x";
  for (const byte of node) root += byte.toString(16).padStart(2, "0");

  return ok({ root, txIndex, leaf, depth: siblings.length });
}

/** The verdict of the local check, carried on the response so a buyer can see it. */
export interface MaterialCheck {
  /** The root this service reproduced from the leaf and the path. */
  readonly derivedRoot: string;
  /** The transaction index the sibling laterality encodes. */
  readonly derivedTxIndex: string;
  /** Whether the source's own `txIndex` agrees with the laterality. */
  readonly txIndexAgrees: boolean;
  readonly depth: number;
}

/**
 * Refuses material whose stated root this service cannot reproduce.
 *
 * A disagreement between the two indices is reported rather than refused: the
 * precompile computes the index from the path itself through `calculateTxIndex`,
 * so the laterality is what a submission will use and the source's own figure is
 * advisory. The root is different, and a mismatch there means the material would
 * revert on chain.
 */
export function checkMaterial(material: ProofMaterial): Result<MaterialCheck> {
  const derived = deriveRoot(material.encodedTransaction, material.merkleProof.siblings);
  if (!derived.ok) return derived;

  if (derived.value.root.toLowerCase() !== material.merkleProof.root.toLowerCase()) {
    return err({
      category: "PROOF",
      code: "MERKLE_ROOT_MISMATCH",
      message: `the Proof Builder states root ${material.merkleProof.root} for source transaction ${material.sourceTxHash} and this service folds the same leaf and path to ${derived.value.root}, so the material would be refused on chain and is not sold`,
      retryable: false,
      details: {
        sourceTxHash: material.sourceTxHash,
        statedRoot: material.merkleProof.root,
        derivedRoot: derived.value.root,
        depth: derived.value.depth,
      },
    });
  }

  return ok({
    derivedRoot: derived.value.root,
    derivedTxIndex: derived.value.txIndex.toString(10),
    txIndexAgrees: derived.value.txIndex === material.txIndexFromSource,
    depth: derived.value.depth,
  });
}

// ------------------------------------------------------ the Proof Builder API

export interface ProofBuilderApiOptions {
  readonly baseUrl: string;
  /** Defaults to {@link PROOF_BUILDER_TIMEOUT_MS}, which R20.3 fixes. */
  readonly timeoutMs?: number;
  /** Injected so a test drives the client without a network. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Plain HTTP against the Proof Builder API.
 *
 * Written against `fetch` and `AbortSignal.timeout` rather than an HTTP client
 * library, because the timeout is the requirement and a hand-rolled deadline is the
 * part worth being able to read.
 */
export function createProofBuilderApiSource(options: ProofBuilderApiOptions): ProofSource {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
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
      const cause = causeOf(error);
      const timedOut = cause.code === "TimeoutError" || /abort|timeout/i.test(cause.message);
      return err({
        category: "UPSTREAM",
        code: timedOut ? "PROOF_BUILDER_TIMEOUT" : "PROOF_BUILDER_UNREACHABLE",
        message: timedOut
          ? `the Proof Builder did not answer ${what} within ${timeoutMs}ms`
          : `the Proof Builder could not be reached for ${what}`,
        retryable: true,
        cause,
      });
    }

    if (!response.ok) {
      return err({
        category: response.status === 404 ? "NOT_FOUND" : "UPSTREAM",
        code: response.status === 404 ? "PROOF_MATERIAL_NOT_FOUND" : "PROOF_BUILDER_REFUSED",
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
        cause: causeOf(error),
      });
    }
  };

  return {
    describe: `the Proof Builder API at ${baseUrl}`,

    async fetchProof(chainKey: bigint, sourceTxHash: string): Promise<Result<ProofMaterial>> {
      const body = await get(
        `${PROOF_BUILDER_PATHS.proofByTx}/${chainKey.toString(10)}/${sourceTxHash}`,
        `proof material for source transaction ${sourceTxHash}`,
      );
      if (!body.ok) return body;
      return normaliseProofMaterial(chainKey, sourceTxHash, body.value);
    },

    async latestAttestedHeight(chainKey: bigint): Promise<Result<bigint | undefined>> {
      const body = await get(
        `${PROOF_BUILDER_PATHS.attestedHeight}/${chainKey.toString(10)}`,
        `the attested height of chainKey ${chainKey.toString(10)}`,
      );
      if (!body.ok) return body;
      const record = asRecord(body.value);
      return ok(record === undefined ? undefined : asBigInt(record["attestedHeight"]));
    },
  };
}
