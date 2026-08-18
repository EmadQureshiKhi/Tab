// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {INativeQueryVerifier, NativeQueryVerifierLib} from "@tabai-contracts/interfaces/INativeQueryVerifier.sol";

/// @title IBlockProverArray
/// @notice The BlockProver Precompile's *array-shaped* `verifyAndEmit` overload, which the product
/// interface deliberately does not declare.
/// @dev Declared here, in throwaway spike scope, because task 1.4 measured something the design did
/// not anticipate: the single-transaction overload only accepts a Continuity Proof whose first root
/// is the root of the height being proved. A proof that spans a batch therefore verifies for the
/// batch's lowest height and reverts `"Merkle root mismatch"` for every other one. Sharing one
/// Continuity Proof across ten proofs is only expressible through this overload, so the probe has to
/// be able to call it to measure the shape that actually works.
///
/// Types, order, and struct layout are taken from the published BlockProver ABI in usc-sdk 0.18.0,
/// so the 4-byte selector matches. Field order is wire order and must not be reordered.
interface IBlockProverArray {
    /// @notice Verify a batch of inclusion proofs against one shared Continuity Proof and emit one
    /// `TransactionVerified` event per proof.
    /// @param chainKey Attested-chain identifier every transaction in the batch belongs to.
    /// @param heights Source Chain block heights, one per proof.
    /// @param encodedTransactions The transactions, one per proof, in the attested encoding.
    /// @param merkleProofs Inclusion proofs, one per transaction.
    /// @param sharedContinuityProof The one Continuity Proof covering the batch's whole height range.
    /// @return verified True when every proof in the batch is proved.
    function verifyAndEmit(
        uint64 chainKey,
        uint64[] calldata heights,
        bytes[] calldata encodedTransactions,
        INativeQueryVerifier.MerkleProof[] calldata merkleProofs,
        INativeQueryVerifier.ContinuityProof calldata sharedContinuityProof
    ) external returns (bool verified);
}

/// @title BatchProbe
/// @notice Throwaway spike contract for Tab task 1.4. It answers the batch question the design rests
/// on — do ten proofs fit inside a single Creditcoin transaction? — and it answers it for all three
/// batch shapes that are physically available, because the shape the design assumed turns out not to
/// be one of them.
///
/// @dev The three entry points exist to separate three different questions:
///
/// - {probeSequentialOwnProofs} — N sequential single-transaction `verifyAndEmit` calls, each with
///   its own Continuity Proof. This is the shape that verifies for every height, and it is what
///   requirement 9.2's "one call per Merkle Proof, sequentially" costs in practice.
/// - {probeSequentialSharedProof} — the same sequential shape but with ONE shared Continuity Proof,
///   exactly as requirement 9.1 and 9.2 read together describe it. It is kept so that the negative
///   result is reproducible on chain by a third party rather than only asserted: it reverts
///   `"Merkle root mismatch"` on the first item whose height is not the proof's own start height.
/// - {probeArraySharedProof} — one array-shaped `verifyAndEmit` against one shared Continuity Proof.
///   This is the only shape in which a batch genuinely shares a Continuity Proof.
///
/// @dev Not product code. No access control, no replay protection, no state. Its only job is to make
/// four figures observable from real submitted transactions and then be thrown away:
///
/// 1. the `gasleft()` delta across each `verifyAndEmit` call — the precompile's own cost, and the
///    only figure comparable with spike 1.3's 6,745 control;
/// 2. the gas consumed inside the probe function, which adds the caller-side index recovery, receipt
///    decoding, and event work a real ingestion performs;
/// 3. the transaction's `gasUsed` from its receipt, which is what the block actually pays for;
/// 4. by subtraction, the intrinsic and calldata charge — the term that grows fastest with batch
///    size, because ten encoded transactions is ~27 KB charged per byte whether or not it is read.
///
/// @dev Every argument arrives inside one nested calldata struct. A batch passed as parallel
/// parameters exhausts the legacy code generator's addressable stack exactly as the single-proof
/// probe did; the spike's own `foundry.toml` sets `via_ir = true` on top of that.
contract BatchProbe {
    /// @notice One proof carrying its own Continuity Proof.
    struct OwnProofItem {
        /// @dev Source Chain block height holding the transaction.
        uint64 height;
        /// @dev The transaction and receipt in the attested `(uint8, bytes[])` encoding.
        bytes encodedTransaction;
        /// @dev Inclusion proof of the transaction against its block's transaction root.
        INativeQueryVerifier.MerkleProof merkleProof;
        /// @dev Link from an attested endpoint down to this item's own block.
        INativeQueryVerifier.ContinuityProof continuityProof;
        /// @dev Index of the log within this transaction's own log array. Not the block-wide index.
        uint256 logIndexInTx;
    }

    /// @notice One proof inside a batch that shares a Continuity Proof, so it carries none itself.
    struct SharedProofItem {
        /// @dev Source Chain block height holding the transaction.
        uint64 height;
        /// @dev The transaction and receipt in the attested `(uint8, bytes[])` encoding.
        bytes encodedTransaction;
        /// @dev Inclusion proof of the transaction against its block's transaction root.
        INativeQueryVerifier.MerkleProof merkleProof;
        /// @dev Index of the log within this transaction's own log array.
        uint256 logIndexInTx;
    }

    /// @notice A batch in which every item carries its own Continuity Proof.
    struct OwnProofBatch {
        /// @dev Attested-chain identifier. `3` is Ethereum Mainnet.
        uint64 chainKey;
        /// @dev The Asset contract expected to have emitted each log, e.g. Mainnet USDC.
        address asset;
        /// @dev `keccak256("Transfer(address,address,uint256)")`.
        bytes32 transferTopic0;
        /// @dev The proofs, in ascending height order.
        OwnProofItem[] items;
    }

    /// @notice A batch of one to ten Merkle Proofs against exactly one Continuity Proof.
    struct SharedProofBatch {
        /// @dev Attested-chain identifier.
        uint64 chainKey;
        /// @dev The Asset contract expected to have emitted each log.
        address asset;
        /// @dev `keccak256("Transfer(address,address,uint256)")`.
        bytes32 transferTopic0;
        /// @dev The single Continuity Proof shared by every item.
        INativeQueryVerifier.ContinuityProof sharedContinuityProof;
        /// @dev The proofs, in ascending height order.
        SharedProofItem[] items;
    }

    /// @notice One item proved, decoded, and measured.
    /// @dev `verifyAndEmitGasUsed` is zero for the array shape, where one precompile call covers the
    /// whole batch and no per-item figure exists.
    event ItemVerified(
        uint256 indexed index,
        uint64 height,
        uint64 txIndex,
        address indexed payerFromTopic1,
        address recipientFromTopic2,
        uint256 amount,
        uint256 verifyAndEmitGasUsed
    );

    /// @notice The whole batch, measured.
    /// @dev `gasUsedInsideFunction` is a `gasleft()` delta across the function body, so it excludes
    /// the intrinsic charge, the calldata charge, and this event's own cost.
    event BatchMeasured(
        string shape,
        uint256 itemCount,
        uint256 sumOfVerifyAndEmitGas,
        uint256 gasUsedInsideFunction,
        uint256 continuityRootCount,
        uint64 lowestHeight,
        uint64 highestHeight
    );

    /// @notice A batch with no items proves nothing.
    error EmptyBatch();
    /// @notice `verifyAndEmit` answered false rather than reverting, naming the item that failed.
    error VerificationReturnedFalse(uint256 index, uint64 height);
    /// @notice The array-shaped `verifyAndEmit` answered false for the batch as a whole.
    error BatchVerificationReturnedFalse(uint256 itemCount);
    /// @notice The proved Source Chain transaction reverted on its own chain.
    error SourceTransactionFailed(uint256 index, uint8 receiptStatus);
    /// @notice `logIndexInTx` does not name a log this transaction emitted.
    error LogIndexOutOfRange(uint256 index, uint256 logIndexInTx, uint256 logCount);
    /// @notice The named log was emitted by a contract other than the expected Asset.
    error LogAddressMismatch(uint256 index, address expected, address found);
    /// @notice The named log is not a three-topic ERC-20 `Transfer`.
    error LogShapeMismatch(uint256 index, uint256 topicCount, bytes32 topicZero);

    /// @notice The fields read out of one decoded Source Chain transaction.
    struct Decoded {
        /// @dev `topics[1]` — the address Tab must credit.
        address payer;
        /// @dev `topics[2]` — the recipient.
        address recipient;
        /// @dev The transfer amount from the log's single data word.
        uint256 amount;
        /// @dev The Source Chain receipt status. `1` is success.
        uint8 receiptStatus;
        /// @dev How many logs this transaction emitted.
        uint256 logCount;
    }

    /// @notice Prove every item sequentially, each against its own Continuity Proof.
    /// @dev The shape that verifies for every height. With one item this is also the control that
    /// reproduces spike 1.3's per-proof figure.
    /// @param input The batch. See {OwnProofBatch}.
    /// @return sumOfVerifyAndEmitGas Sum of the per-item `gasleft()` deltas across the precompile calls.
    /// @return gasUsedInsideFunction Gas consumed inside this function, caller-side work included.
    function probeSequentialOwnProofs(OwnProofBatch calldata input)
        external
        returns (uint256 sumOfVerifyAndEmitGas, uint256 gasUsedInsideFunction)
    {
        uint256 gasAtEntry = gasleft();
        uint256 count = input.items.length;
        if (count == 0) revert EmptyBatch();

        INativeQueryVerifier verifier = NativeQueryVerifierLib.getVerifier();
        uint256 roots = 0;
        for (uint256 i = 0; i < count; ++i) {
            OwnProofItem calldata item = input.items[i];
            uint256 gasBefore = gasleft();
            bool verified = verifier.verifyAndEmit(
                input.chainKey, item.height, item.encodedTransaction, item.merkleProof, item.continuityProof
            );
            uint256 spent = gasBefore - gasleft();
            if (!verified) revert VerificationReturnedFalse(i, item.height);
            sumOfVerifyAndEmitGas += spent;
            roots += item.continuityProof.roots.length;

            _readOut(verifier, input.chainKey, input.asset, input.transferTopic0, i, item.height, item.encodedTransaction, item.merkleProof, item.logIndexInTx, spent);
        }

        gasUsedInsideFunction = gasAtEntry - gasleft();
        emit BatchMeasured(
            "sequential single verifyAndEmit calls, one Continuity Proof each",
            count,
            sumOfVerifyAndEmitGas,
            gasUsedInsideFunction,
            roots,
            input.items[0].height,
            input.items[count - 1].height
        );
    }

    /// @notice Prove every item sequentially against ONE shared Continuity Proof.
    /// @dev Requirement 9.1 and 9.2 as written. Kept even though it reverts, so that the finding is
    /// reproducible: the precompile treats the Continuity Proof's first root as the root of the
    /// height being proved, so a proof spanning the batch verifies for the lowest height only and
    /// reverts `"Merkle root mismatch"` on the next item.
    /// @param input The batch. See {SharedProofBatch}.
    /// @return sumOfVerifyAndEmitGas Sum of the per-item `gasleft()` deltas across the precompile calls.
    /// @return gasUsedInsideFunction Gas consumed inside this function, caller-side work included.
    function probeSequentialSharedProof(SharedProofBatch calldata input)
        external
        returns (uint256 sumOfVerifyAndEmitGas, uint256 gasUsedInsideFunction)
    {
        uint256 gasAtEntry = gasleft();
        uint256 count = input.items.length;
        if (count == 0) revert EmptyBatch();

        INativeQueryVerifier verifier = NativeQueryVerifierLib.getVerifier();
        for (uint256 i = 0; i < count; ++i) {
            SharedProofItem calldata item = input.items[i];
            uint256 gasBefore = gasleft();
            bool verified = verifier.verifyAndEmit(
                input.chainKey, item.height, item.encodedTransaction, item.merkleProof, input.sharedContinuityProof
            );
            uint256 spent = gasBefore - gasleft();
            if (!verified) revert VerificationReturnedFalse(i, item.height);
            sumOfVerifyAndEmitGas += spent;

            _readOut(verifier, input.chainKey, input.asset, input.transferTopic0, i, item.height, item.encodedTransaction, item.merkleProof, item.logIndexInTx, spent);
        }

        gasUsedInsideFunction = gasAtEntry - gasleft();
        emit BatchMeasured(
            "sequential single verifyAndEmit calls, one shared Continuity Proof",
            count,
            sumOfVerifyAndEmitGas,
            gasUsedInsideFunction,
            input.sharedContinuityProof.roots.length,
            input.items[0].height,
            input.items[count - 1].height
        );
    }

    /// @notice Prove the whole batch with one array-shaped `verifyAndEmit` against one shared
    /// Continuity Proof, then decode and emit per item.
    /// @dev The only shape in which a batch genuinely shares a Continuity Proof. The precompile cost
    /// is one figure for the batch rather than ten, so `ItemVerified.verifyAndEmitGasUsed` is zero
    /// for every item and the batch figure travels in {BatchMeasured} instead.
    /// @param input The batch. See {SharedProofBatch}.
    /// @return sumOfVerifyAndEmitGas Gas consumed by the single array-shaped precompile call.
    /// @return gasUsedInsideFunction Gas consumed inside this function, caller-side work included.
    function probeArraySharedProof(SharedProofBatch calldata input)
        external
        returns (uint256 sumOfVerifyAndEmitGas, uint256 gasUsedInsideFunction)
    {
        uint256 gasAtEntry = gasleft();
        uint256 count = input.items.length;
        if (count == 0) revert EmptyBatch();

        uint64[] memory heights = new uint64[](count);
        bytes[] memory encoded = new bytes[](count);
        INativeQueryVerifier.MerkleProof[] memory proofs = new INativeQueryVerifier.MerkleProof[](count);
        for (uint256 i = 0; i < count; ++i) {
            heights[i] = input.items[i].height;
            encoded[i] = input.items[i].encodedTransaction;
            proofs[i] = input.items[i].merkleProof;
        }

        uint256 gasBefore = gasleft();
        bool verified = IBlockProverArray(NativeQueryVerifierLib.PRECOMPILE_ADDRESS).verifyAndEmit(
            input.chainKey, heights, encoded, proofs, input.sharedContinuityProof
        );
        sumOfVerifyAndEmitGas = gasBefore - gasleft();
        if (!verified) revert BatchVerificationReturnedFalse(count);

        INativeQueryVerifier verifier = NativeQueryVerifierLib.getVerifier();
        for (uint256 i = 0; i < count; ++i) {
            SharedProofItem calldata item = input.items[i];
            _readOut(verifier, input.chainKey, input.asset, input.transferTopic0, i, item.height, item.encodedTransaction, item.merkleProof, item.logIndexInTx, 0);
        }

        gasUsedInsideFunction = gasAtEntry - gasleft();
        emit BatchMeasured(
            "one array-shaped verifyAndEmit, one shared Continuity Proof",
            count,
            sumOfVerifyAndEmitGas,
            gasUsedInsideFunction,
            input.sharedContinuityProof.roots.length,
            input.items[0].height,
            input.items[count - 1].height
        );
    }

    /// @notice Recover the transaction index, decode the named log, and emit what a real ingestion
    /// would read out of one proved transaction.
    /// @dev Kept out of the loops so one item's locals fall out of scope before the next item's come
    /// in, and so all three shapes charge themselves the same caller-side work.
    /// @param verifier The BlockProver Precompile.
    /// @param chainKey Attested-chain identifier, carried through for symmetry with the events.
    /// @param asset The Asset contract expected to have emitted the log.
    /// @param transferTopic0 `keccak256("Transfer(address,address,uint256)")`.
    /// @param i Index of the item within the batch.
    /// @param height Source Chain block height of the item.
    /// @param encodedTransaction The transaction and receipt in the attested encoding.
    /// @param merkleProof The item's inclusion proof, from which the transaction index is recovered.
    /// @param logIndexInTx Index of the log within this transaction's own log array.
    /// @param verifyAndEmitGasUsed The item's own precompile cost, or zero where only a batch figure exists.
    function _readOut(
        INativeQueryVerifier verifier,
        uint64 chainKey,
        address asset,
        bytes32 transferTopic0,
        uint256 i,
        uint64 height,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProof calldata merkleProof,
        uint256 logIndexInTx,
        uint256 verifyAndEmitGasUsed
    ) private {
        chainKey; // Read for symmetry with the product path; not needed to decode.

        // The transaction index is part of Tab's replay key and must come from proof material rather
        // than from calldata, so a realistic per-item cost has to include recovering it.
        uint64 txIndex = verifier.calculateTxIndex(merkleProof);
        Decoded memory d = _decode(i, encodedTransaction, logIndexInTx, asset, transferTopic0);
        emit ItemVerified(i, height, txIndex, d.payer, d.recipient, d.amount, verifyAndEmitGasUsed);
    }

    /// @notice Decode a batch without proving anything, so a decoding problem stays separable from a
    /// proving problem and costs no gas to diagnose.
    /// @param input The same batch passed to {probeArraySharedProof}.
    /// @return decoded One entry per item, in the same order.
    function decodeOnly(SharedProofBatch calldata input) external pure returns (Decoded[] memory decoded) {
        uint256 count = input.items.length;
        decoded = new Decoded[](count);
        for (uint256 i = 0; i < count; ++i) {
            SharedProofItem calldata item = input.items[i];
            decoded[i] = _decode(i, item.encodedTransaction, item.logIndexInTx, input.asset, input.transferTopic0);
        }
    }

    /// @notice Pull the payer, the recipient, and the amount out of one encoded Source Chain transaction.
    /// @dev Only `EvmV1Decoder`'s `internal` helpers are called, so the library inlines and never has
    /// to be deployed or linked. The first 32-byte word of the encoding is the transaction type,
    /// which decides whether the receipt sits at chunk index 2 or 3; reading it directly avoids a
    /// call into the library's `public` surface, which *would* force linking.
    /// @param i Index of the item, carried into every error so a revert names the offending item.
    /// @param encodedTransaction The transaction and receipt in the attested `(uint8, bytes[])` encoding.
    /// @param logIndexInTx Index of the log within this transaction's own log array.
    /// @param asset The Asset contract expected to have emitted the log.
    /// @param transferTopic0 `keccak256("Transfer(address,address,uint256)")`.
    /// @return decoded The decoded fields. See {Decoded}.
    function _decode(
        uint256 i,
        bytes calldata encodedTransaction,
        uint256 logIndexInTx,
        address asset,
        bytes32 transferTopic0
    ) private pure returns (Decoded memory decoded) {
        uint8 txType = abi.decode(encodedTransaction[0:32], (uint8));

        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder._decodeReceiptChunk(encodedTransaction, txType);
        decoded.receiptStatus = receipt.receiptStatus;
        decoded.logCount = receipt.receiptLogs.length;

        if (receipt.receiptStatus != 1) revert SourceTransactionFailed(i, receipt.receiptStatus);
        if (logIndexInTx >= decoded.logCount) revert LogIndexOutOfRange(i, logIndexInTx, decoded.logCount);

        EvmV1Decoder.LogEntry memory entry = receipt.receiptLogs[logIndexInTx];
        if (entry.address_ != asset) revert LogAddressMismatch(i, asset, entry.address_);
        if (entry.topics.length != 3 || entry.topics[0] != transferTopic0) {
            revert LogShapeMismatch(i, entry.topics.length, entry.topics.length == 0 ? bytes32(0) : entry.topics[0]);
        }

        decoded.payer = address(uint160(uint256(entry.topics[1])));
        decoded.recipient = address(uint160(uint256(entry.topics[2])));
        decoded.amount = abi.decode(entry.data, (uint256));
    }
}
