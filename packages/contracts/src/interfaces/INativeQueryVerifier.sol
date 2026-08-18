// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title INativeQueryVerifier
/// @notice Typed surface of the BlockProver Precompile at
/// `0x0000000000000000000000000000000000000FD2`, which proves that a Source Chain transaction was
/// included in an attested block of an attested chain and, on success, emits the decoded
/// transaction so the calling contract can read its fields through `EvmV1Decoder`.
/// @dev Tab declares only the two methods it actually calls, and declares them with the exact
/// argument types, argument order, struct layouts, and state mutability published in the pinned
/// Attestcoin packages: the BlockProver ABI in usc-sdk 0.18.0
/// (`src/block-prover/block_prover.json`) and the interface in usc-contracts 0.1.2
/// (`contracts/write-ability/INativeQueryVerifier.sol`).
/// A precompile has no source to link against, so the 4-byte selector produced by this declaration
/// *is* the integration: any deviation in a type or in struct field order silently changes the
/// selector or the calldata encoding and the call reverts with `"Unknown selector"` or decodes
/// garbage. Field order below is therefore wire order and must not be reordered for readability.
///
/// The precompile also publishes array-shaped `verify` and `verifyAndEmit` overloads. Tab does not
/// declare them. Settlement batching is N sequential single-transaction `verifyAndEmit` calls, each
/// carrying its own Continuity Proof, so that a failure is attributable to one Settlement rather
/// than to an opaque batch and so that each ingestion runs the same code path as a lone submission.
/// The array overload returns one boolean for the whole batch, which cannot name the member that
/// failed, and the batch behaviour Tab specifies is all-or-nothing revert plus per-Settlement
/// resubmission — so the overload cannot express the requirement even setting cost aside. Measured
/// on the live network, the sequential shape costs 557,718 gas for ten Settlements against 525,448
/// for the array shape: 5.8 percent more, of a submission that occupies 0.74 percent of a block.
interface INativeQueryVerifier {
    /// @notice One sibling hash on the path from a transaction leaf to the transaction-trie root.
    /// @dev `isLeft` records which side the sibling sits on, and is what makes the path
    /// reconstructible into a transaction index by `calculateTxIndex`. Laterality is the whole
    /// reason this is a struct rather than a bare `bytes32`.
    struct MerkleProofEntry {
        /// @dev The sibling hash at this level of the tree.
        bytes32 hash;
        /// @dev True when the sibling is the left-hand input at this level.
        bool isLeft;
    }

    /// @notice Inclusion proof for a single Source Chain transaction against one block's root.
    struct MerkleProof {
        /// @dev The transaction-trie root the sibling path must reproduce.
        bytes32 root;
        /// @dev Sibling path ordered leaf-to-root.
        MerkleProofEntry[] siblings;
    }

    /// @notice Chain of roots linking an attested endpoint to the block holding the transaction.
    /// @dev Attested heights are sparse, so a Settlement's block is normally not itself an
    /// attestation endpoint. This proof is what closes the gap between the nearest attested
    /// endpoint and the block being proved.
    ///
    /// One proof proves exactly one height, and it cannot be shared across a batch. The precompile
    /// treats `roots[0]` as the transaction-trie root of the height under proof, so a proof built
    /// for height H verifies only H and reverts `"Merkle root mismatch"` at every other height in
    /// the span. This was measured, not assumed: a keyless preflight over ten Settlements verified
    /// 10 of 10 against their own proofs and 1 of 10 against a shared one, and the failing
    /// submission is on chain. Each batch member therefore carries its own Continuity Proof.
    struct ContinuityProof {
        /// @dev Digest of the attested endpoint the chain of roots descends from.
        bytes32 lowerEndpointDigest;
        /// @dev Successive block roots from that endpoint through to the proved block.
        bytes32[] roots;
    }

    /// @notice Verify inclusion and, on success, emit the decoded Source Chain transaction.
    /// @dev State-changing (`nonpayable` in the published ABI) because it emits, so it cannot be
    /// called from a `view` context. Tab calls this before touching any tab, credit, or Bond state,
    /// and treats a `false` return exactly like a revert.
    /// @param chainKey Attested-chain identifier the transaction belongs to.
    /// @param height Source Chain block height holding the transaction.
    /// @param encodedTransaction The Source Chain transaction as published on that chain.
    /// @param merkleProof Inclusion proof of the transaction against the block's root.
    /// @param continuityProof Link from an attested endpoint to that block.
    /// @return verified True when inclusion is proved.
    function verifyAndEmit(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external returns (bool verified);

    /// @notice Recover the transaction's index within its block from the proof's sibling laterality.
    /// @dev `view`, deliberately and load-bearing. The transaction index is one of the four fields
    /// of Tab's replay key, so it must come from proof material rather than from a caller-supplied
    /// argument. Being `view` also lets an independent party recompute the index with no key and no
    /// gas, which is what the keyless reproduction path depends on.
    /// @param merkleProof The same inclusion proof passed to `verifyAndEmit`.
    /// @return txIndex Zero-based index of the transaction within its block.
    function calculateTxIndex(MerkleProof calldata merkleProof) external view returns (uint64 txIndex);
}

/// @notice Single place where the BlockProver Precompile address is written down.
/// @dev Every call site obtains the precompile through `getVerifier()` rather than casting a
/// literal, so the address appears exactly once in the contract tree and the call is typed.
library NativeQueryVerifierLib {
    /// @notice The BlockProver Precompile address on Creditcoin.
    address internal constant PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000FD2;

    /// @notice The precompile, typed.
    /// @return verifier `INativeQueryVerifier` bound to `PRECOMPILE_ADDRESS`.
    function getVerifier() internal pure returns (INativeQueryVerifier verifier) {
        verifier = INativeQueryVerifier(PRECOMPILE_ADDRESS);
    }
}
