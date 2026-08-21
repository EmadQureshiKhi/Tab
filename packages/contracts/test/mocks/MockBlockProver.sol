// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {INativeQueryVerifier} from "../../src/interfaces/INativeQueryVerifier.sol";

/// @title MockBlockProver
/// @notice Stand-in for the BlockProver Precompile, to be placed at its fixed address with `vm.etch`.
/// @dev `TabAscBase` binds the precompile as an immutable read from the address library, so there is
/// no constructor seam to inject a test double through, and that is deliberate: no deployment path
/// can aim verification at a contract that merely answers `true`. The way to exercise the contract
/// locally is therefore to put code at the address the library names.
///
/// Etched rather than mocked per call, because this contract implements the real interface and so
/// solc generates a real ABI decoder for it. A `SourceTx` field ordering that did not match what the
/// precompile expects would fail to decode here and the test would go red, which is the whole point;
/// a per-call return-value stub would accept any calldata at all and catch nothing.
///
/// Storage starts all-zero after an etch, since only the runtime code is copied and no constructor
/// runs. The defaults are chosen so that zeroed storage is the useful case: `rejectProofs` false
/// means proofs verify, and `txIndex` zero is a legitimate transaction index.
contract MockBlockProver is INativeQueryVerifier {
    /// @notice When true, {verifyAndEmit} answers `false` instead of `true`.
    /// @dev A `false` return rather than a revert, because that is the branch `ProofRejected` covers
    /// and the two have to be indistinguishable as far as state is concerned.
    bool public rejectProofs;

    /// @notice The transaction index {calculateTxIndex} reports.
    uint64 public txIndex;

    /// @notice How many times {verifyAndEmit} has been called.
    uint256 public verifyCalls;

    /// @notice `chainKey` of the most recent verification call, as this contract decoded it.
    uint64 public lastChainKey;

    /// @notice `blockHeight` of the most recent verification call.
    uint64 public lastHeight;

    /// @notice Claimed transaction-trie root of the most recent Merkle Proof.
    bytes32 public lastMerkleRoot;

    /// @notice Sibling count of the most recent Merkle Proof.
    uint256 public lastSiblingCount;

    /// @notice Lower endpoint digest of the most recent Continuity Proof.
    bytes32 public lastLowerEndpointDigest;

    /// @notice Root count of the most recent Continuity Proof.
    uint256 public lastContinuityRootCount;

    /// @notice Digest of the encoded transaction the most recent call carried.
    bytes32 public lastEncodedTransactionDigest;

    /// @notice Make the next verification fail, or succeed again.
    /// @param value True to answer `false` from {verifyAndEmit}.
    function setRejectProofs(bool value) external {
        rejectProofs = value;
    }

    /// @notice Set the transaction index {calculateTxIndex} reports.
    /// @param value The index to report.
    function setTxIndex(uint64 value) external {
        txIndex = value;
    }

    /// @inheritdoc INativeQueryVerifier
    /// @dev Records what it decoded so a test can assert the struct arrived intact rather than
    /// merely that the call did not revert.
    function verifyAndEmit(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external override returns (bool) {
        ++verifyCalls;
        lastChainKey = chainKey;
        lastHeight = height;
        lastMerkleRoot = merkleProof.root;
        lastSiblingCount = merkleProof.siblings.length;
        lastLowerEndpointDigest = continuityProof.lowerEndpointDigest;
        lastContinuityRootCount = continuityProof.roots.length;
        lastEncodedTransactionDigest = keccak256(encodedTransaction);
        return !rejectProofs;
    }

    /// @inheritdoc INativeQueryVerifier
    /// @dev The live precompile derives the index from the sibling laterality of the proof. Here it is
    /// whatever {setTxIndex} last stored, because what the suite needs is control over the index, not
    /// a second implementation of the derivation.
    function calculateTxIndex(MerkleProof calldata) external view override returns (uint64) {
        return txIndex;
    }
}
