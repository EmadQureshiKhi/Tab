/**
 * Independent local re-derivation of a Merkle root and a transaction index.
 *
 * This is the module that decides whether the Watcher is allowed to spend gas.
 * Nothing else in the pipeline may submit a Settlement whose root this file has
 * not reproduced from the encoded transaction and the sibling path alone (R20.4).
 * "Independent" is the whole point: the hash used here is `@tabai/shared`'s
 * dependency-free Keccak-256, pinned by published digests, not the hash shipped
 * inside whichever client fetched the proof. A builder that returns a
 * self-consistent lie has to defeat two implementations, not one.
 *
 * ## The tree is domain-separated, and design section 8.4 omitted it
 *
 * The pseudocode in design section 8.4 folds the path as
 * `keccak256(sibling ‖ node)`. Run against the genuine Mainnet proof material
 * recorded in `packages/contracts/test/live/results.json`, that derivation
 * produces `0x9ee83089…` where the real root is `0x2d72e37c…`. It is wrong, and
 * it is wrong in the direction that matters: it would have withheld *every*
 * Settlement, forever, and looked like a hostile proof builder while doing it.
 *
 * The real tree prefixes a one-byte domain tag before hashing:
 *
 * ```text
 *   leaf(bytes)          = keccak256(0x00 ‖ bytes)
 *   inner(left, right)   = keccak256(0x01 ‖ left ‖ right)
 * ```
 *
 * With those two prefixes the same material reproduces `0x2d72e37c…` exactly.
 * The tags are what stop a 32-byte leaf from being replayed as an inner node —
 * without them a leaf whose contents happen to be `left ‖ right` and the parent
 * of those two children hash identically, which is the classic second-preimage
 * attack on an untagged Merkle tree. {@link hashLeaf} and {@link hashInner} are
 * the only two hash call sites in this file for that reason.
 *
 * ## `isLeft` describes the sibling, and it is also the index bit
 *
 * A sibling on the left means *our* node is the right child at that level, which
 * is exactly the condition "this level's bit of the transaction index is 1". So
 * the root and the index fall out of one pass: no second traversal, and no way
 * for the two answers to be derived from different readings of the same path.
 * Bit 0 is the leaf level.
 *
 * That reading is confirmed rather than assumed. The recorded Mainnet proof has
 * three left siblings at the bottom and six right siblings above, which yields
 * `0b111 == 7`, and the Proof Builder independently reported `txIndex: 7` for the
 * same transaction. Flipping the interpretation would have produced 504.
 *
 * ## Two answers, both checked
 *
 * A root match alone is not sufficient (design section 8.4 step 5). The index is
 * cross-checked against `calculateTxIndex` read from the BlockProver Precompile,
 * because the index is part of the replay key: a laterality misreading that
 * happens to reproduce the root would mint a *different* replay key for the same
 * log, and replay resistance is keyed on that word. A disagreement withholds.
 *
 * Requirements: 3.3, 20.4, 20.5
 */

import { Interface, type BlockTag, type JsonRpcProvider } from "ethers";

import { keccak256, err, ok, type Bytes32, type Result, type TabError } from "@tabai/shared";

import { describeCause } from "./errors.js";

/** Domain tag prefixed before hashing a leaf. */
export const LEAF_TAG = 0x00;

/** Domain tag prefixed before hashing an inner node. */
export const INNER_TAG = 0x01;

/**
 * Longest sibling path this module will fold.
 *
 * The transaction index is a `uint64` on the wire and in the replay key, so a
 * path deeper than 64 could not be represented in the field it feeds. A real
 * block is nowhere near: the recorded Mainnet target carried 9 siblings, and the
 * task 1.3 spike observed 8 for a 134-transaction block. The bound exists so an
 * absurd path is refused rather than silently truncated.
 */
export const MAX_SIBLING_PATH = 64;

/**
 * The derivation this file performs, contrasted with what design section 8.4
 * printed. Kept next to the code because the design text is what a reader
 * reaches for first, and following it produces a root that matches nothing.
 */
export const DESIGN_PSEUDOCODE_CORRECTION = {
  designSection: "8.4",
  designDerivation: "node = keccak256(sibling ‖ node)",
  actualDerivation: "leaf = keccak256(0x00 ‖ bytes); node = keccak256(0x01 ‖ left ‖ right)",
  evidence:
    "the genuine Mainnet material in packages/contracts/test/live/results.json derives 0x9ee830892e5f5a5d889a0b91477ad934ea804594063eb54932bf04a4fdd40bbb without the tags and 0x2d72e37c7d7dc2f5fec2b412e9464d3fd42b197b2d505d252a70d610ff5ce434, the recorded genuine root, with them",
} as const;

/** One step of a Merkle inclusion path. `isLeft` is the *sibling's* laterality. */
export interface MerkleProofEntry {
  readonly hash: string;
  readonly isLeft: boolean;
}

/** An inclusion proof as both builders return it. */
export interface MerkleProof {
  readonly root: string;
  readonly siblings: readonly MerkleProofEntry[];
}

/** What one pass over the sibling path establishes. */
export interface DerivedRoot {
  /** Root reproduced from the encoded transaction and the path. */
  readonly root: Bytes32;
  /** Transaction index read out of the sibling laterality. */
  readonly txIndex: bigint;
  /** The tagged leaf hash, carried so a mismatch can be localised to the leaf. */
  readonly leaf: Bytes32;
  /** Path length, which is the tree depth this proof claims. */
  readonly depth: number;
}

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

function derivationError(code: string, message: string): TabError {
  return { category: "PROOF", code, message, retryable: false };
}

/** Parses an even-length `0x` hex string. Returns undefined rather than throwing. */
function bytesFromHex(value: string): Uint8Array | undefined {
  if (!HEX_BYTES.test(value)) return undefined;
  const body = value.slice(2);
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
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

/**
 * `keccak256(0x01 ‖ left ‖ right)`.
 *
 * @param left the left child as a 32-byte word
 * @param right the right child as a 32-byte word
 */
export function hashInner(left: Uint8Array, right: Uint8Array): Bytes32 {
  const tagged = new Uint8Array(65);
  tagged[0] = INNER_TAG;
  tagged.set(left, 1);
  tagged.set(right, 33);
  return keccak256(tagged);
}

/**
 * Re-derives the Merkle root and the transaction index from the encoded
 * transaction and the sibling path.
 *
 * Fails rather than guessing on malformed input: a non-hex payload, a sibling
 * that is not a 32-byte word, or a path longer than {@link MAX_SIBLING_PATH}.
 * Each is a `PROOF` error and none is retryable, because re-asking the same
 * builder for the same malformed shape produces the same malformed shape.
 *
 * @param encodedTransaction the attested transaction-and-receipt encoding
 * @param siblings the inclusion path, leaf level first
 */
export function deriveRoot(
  encodedTransaction: string | Uint8Array,
  siblings: readonly MerkleProofEntry[],
): Result<DerivedRoot> {
  const payload =
    typeof encodedTransaction === "string" ? bytesFromHex(encodedTransaction) : encodedTransaction;
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
  let node = bytesFromHex(leaf)!;
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
    const other = bytesFromHex(sibling.hash)!;
    // A left sibling means our node is the right child, which is also this
    // level's index bit. One pass, one reading of laterality.
    node = bytesFromHex(sibling.isLeft ? hashInner(other, node) : hashInner(node, other))!;
    if (sibling.isLeft) txIndex |= bit;
    bit <<= 1n;
  }

  let root = "0x";
  for (const byte of node) root += byte.toString(16).padStart(2, "0");

  return ok({ root: root as Bytes32, txIndex, leaf, depth: siblings.length });
}

/** What the local derivation concluded about one piece of proof material. */
export type DerivationOutcome =
  /** the local root equals the received root, and the index agrees where checked */
  | "MATCH"
  /** the path could not be folded at all; the material is malformed */
  | "UNDERIVABLE"
  /** the local root differs from the root the builder claimed (R20.5) */
  | "ROOT_MISMATCH"
  /** the root agrees but the precompile reads a different transaction index */
  | "TX_INDEX_MISMATCH";

/** The verdict, with everything an operator needs to act on it. */
export interface DerivationCheck {
  readonly outcome: DerivationOutcome;
  /** The Source Chain transaction hash, logged on every non-match (R20.5). */
  readonly sourceTxHash: string;
  /** Absent only when the outcome is `UNDERIVABLE`. */
  readonly derived: DerivedRoot | undefined;
  /** The root as the builder claimed it. */
  readonly receivedRoot: string;
  /** The precompile's own index, when it was read. */
  readonly txIndexFromPrecompile: bigint | undefined;
  /** One sentence for the log line. */
  readonly detail: string;
}

/** Inputs to {@link checkDerivedRoot}. */
export interface DerivationCheckInput {
  readonly sourceTxHash: string;
  readonly encodedTransaction: string | Uint8Array;
  readonly merkleProof: MerkleProof;
  /**
   * `calculateTxIndex(merkleProof)` read from the BlockProver Precompile. Omit it
   * to skip the cross-check; supply it and a disagreement withholds the
   * Settlement even when the root matched.
   */
  readonly txIndexFromPrecompile?: bigint;
}

/**
 * The gate. Compares the locally derived root against the received one, and the
 * locally derived index against the precompile's, and says which of the four
 * outcomes holds.
 *
 * Root comparison is case-insensitive on the hex and nothing else: the two
 * builders differ in casing, and a case difference is not a proof difference.
 */
export function checkDerivedRoot(input: DerivationCheckInput): DerivationCheck {
  const receivedRoot = input.merkleProof.root;
  const derivation = deriveRoot(input.encodedTransaction, input.merkleProof.siblings);

  if (!derivation.ok) {
    return {
      outcome: "UNDERIVABLE",
      sourceTxHash: input.sourceTxHash,
      derived: undefined,
      receivedRoot,
      txIndexFromPrecompile: input.txIndexFromPrecompile,
      detail: `proof material for source transaction ${input.sourceTxHash} could not be folded locally: ${derivation.error.message}`,
    };
  }

  const derived = derivation.value;
  if (!isBytes32Hex(receivedRoot) || derived.root.toLowerCase() !== receivedRoot.toLowerCase()) {
    return {
      outcome: "ROOT_MISMATCH",
      sourceTxHash: input.sourceTxHash,
      derived,
      receivedRoot,
      txIndexFromPrecompile: input.txIndexFromPrecompile,
      detail: `local re-derivation of source transaction ${input.sourceTxHash} produced root ${derived.root} against a received root of ${receivedRoot}, so submission is withheld`,
    };
  }

  if (input.txIndexFromPrecompile !== undefined && input.txIndexFromPrecompile !== derived.txIndex) {
    return {
      outcome: "TX_INDEX_MISMATCH",
      sourceTxHash: input.sourceTxHash,
      derived,
      receivedRoot,
      txIndexFromPrecompile: input.txIndexFromPrecompile,
      detail: `the root for source transaction ${input.sourceTxHash} matched, but the sibling laterality reads transaction index ${derived.txIndex} while calculateTxIndex reads ${input.txIndexFromPrecompile}, so the replay key is not agreed and submission is withheld`,
    };
  }

  return {
    outcome: "MATCH",
    sourceTxHash: input.sourceTxHash,
    derived,
    receivedRoot,
    txIndexFromPrecompile: input.txIndexFromPrecompile,
    detail: `local re-derivation of source transaction ${input.sourceTxHash} reproduced root ${derived.root} at transaction index ${derived.txIndex}`,
  };
}

/**
 * The one BlockProver Precompile method this module calls.
 *
 * `calculateTxIndex` is `view`, so the cross-check is a keyless `eth_call` that
 * costs nothing — the same property design section 15.5 leans on. Note that the
 * precompile reports **zero code bytes** to `eth_getCode`, as native precompiles
 * do, so a code-presence check is not a valid liveness probe for it; a successful
 * call is.
 */
export const BLOCK_PROVER_TX_INDEX_ABI = [
  {
    type: "function",
    name: "calculateTxIndex",
    stateMutability: "view",
    inputs: [
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
    ],
    outputs: [{ name: "txIndex", type: "uint64" }],
  },
] as const;

/** The precompile's own opinion of the transaction index. */
export interface TxIndexReader {
  calculateTxIndex(merkleProof: MerkleProof): Promise<Result<bigint>>;
}

/**
 * Reads `calculateTxIndex` at a pinned block tag.
 *
 * The tag is pinned for the same reason every ChainInfo read is: Creditcoin
 * `latest` runs ahead of `finalized`, and one process must not hold two views of
 * the chain.
 *
 * @param provider a provider from `createJsonRpcProvider`, so batching is off
 * @param address the BlockProver Precompile address, from configuration
 * @param blockTag one tag for every read; see `CREDITCOIN_BLOCK_TAG`
 */
export function createPrecompileTxIndexReader(
  provider: JsonRpcProvider,
  address: string,
  blockTag: BlockTag,
): TxIndexReader {
  const iface = new Interface(BLOCK_PROVER_TX_INDEX_ABI);

  return {
    async calculateTxIndex(merkleProof: MerkleProof): Promise<Result<bigint>> {
      const tuple = [
        merkleProof.root,
        merkleProof.siblings.map((sibling) => [sibling.hash, sibling.isLeft]),
      ];
      let returnData: string;
      try {
        returnData = await provider.call({
          to: address,
          data: iface.encodeFunctionData("calculateTxIndex", [tuple]),
          blockTag,
        });
      } catch (error) {
        const cause = describeCause(error);
        const unknownSelector = /unknown selector/i.test(cause.message);
        return err({
          category: unknownSelector ? "CHAIN" : "UPSTREAM",
          code: unknownSelector ? "BLOCKPROVER_SELECTOR_UNKNOWN" : "BLOCKPROVER_READ_FAILED",
          message: unknownSelector
            ? "the BlockProver Precompile does not expose `calculateTxIndex`, so the pinned ABI no longer matches the chain"
            : "the BlockProver Precompile did not answer `calculateTxIndex`",
          retryable: !unknownSelector,
          cause,
        });
      }
      try {
        const decoded = iface.decodeFunctionResult("calculateTxIndex", returnData);
        const txIndex = decoded[0];
        if (typeof txIndex !== "bigint") {
          return err(
            derivationError(
              "BLOCKPROVER_DECODE_FAILED",
              "`calculateTxIndex` returned something that is not a uint64",
            ),
          );
        }
        return ok(txIndex);
      } catch (error) {
        return err({
          category: "CHAIN",
          code: "BLOCKPROVER_DECODE_FAILED",
          message: "`calculateTxIndex` returned a shape this ABI cannot read",
          retryable: false,
          cause: describeCause(error),
        });
      }
    },
  };
}
