// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {INativeQueryVerifier, NativeQueryVerifierLib} from "@tabai-contracts/interfaces/INativeQueryVerifier.sol";

/// @title Probe
/// @notice Throwaway spike contract for Tab task 1.3. It exercises the BlockProver Precompile at
/// `0x0000000000000000000000000000000000000FD2` end to end against a real Ethereum Mainnet USDC
/// `Transfer`, and settles the one question the whole design rests on: does credit resolve from the
/// log's indexed sender, `topics[1]`, rather than from the transaction's `from` field?
///
/// @dev Not product code and not a template for product code. It carries no access control, no
/// replay protection, and no state, because its only job is to make the precompile's answer
/// observable and then be thrown away. The product path lives in `SettlementVerifier`.
///
/// @dev Three things here are load-bearing and are worth stating plainly:
///
/// 1. `verifyAndEmit` is measured with `gasleft()` either side of the call, so the figure reported
///    is the precompile call alone rather than the whole probe transaction. Task 1.4 needs that
///    isolated figure to reason about batch headroom.
///
/// 2. The payer is read from `topics[1]` of the Asset's `Transfer` log and the transaction `from`
///    field is read separately from the common-fields chunk. The contract then *requires* them to
///    differ. A target where they are equal proves nothing about payer resolution, so the probe
///    refuses to report success on one.
///
/// 3. Every argument arrives inside one calldata struct. Passing them as eight separate parameters
///    exhausts the EVM's addressable stack slots and the contract will not compile without
///    `via_ir`. The struct keeps one calldata pointer live instead of eight values, which keeps the
///    probe on the same plain codegen settings as the product Foundry project.
contract Probe {
    /// @notice One proof submission, as a single calldata argument.
    struct ProofInput {
        /// @dev Attested-chain identifier. `3` is Ethereum Mainnet, `1` is Ethereum Sepolia.
        uint64 chainKey;
        /// @dev Source Chain block height holding the transaction.
        uint64 height;
        /// @dev The transaction and receipt in the attested `(uint8, bytes[])` encoding.
        bytes encodedTransaction;
        /// @dev Inclusion proof of the transaction against its block's transaction root.
        INativeQueryVerifier.MerkleProof merkleProof;
        /// @dev Link from the nearest attested endpoint down to that block.
        INativeQueryVerifier.ContinuityProof continuityProof;
        /// @dev The Asset contract expected to have emitted the log, e.g. Mainnet USDC.
        address asset;
        /// @dev `keccak256("Transfer(address,address,uint256)")`. Passed in rather than hardcoded so
        /// the probe can be pointed at another event shape without a redeploy.
        bytes32 transferTopic0;
        /// @dev Index of the log *within this transaction's own* log array. Not the block-wide
        /// `logIndex`, because the decoded receipt carries only this transaction's logs.
        uint256 logIndexInTx;
    }

    /// @notice Everything the spike needs to observe from one proved Source Chain transaction.
    /// @dev `payerFromTopic1` and `txFrom` are both indexed so a third party can filter on either
    /// and see for themselves that they are different addresses.
    event ProbeResult(
        uint64 chainKey,
        uint64 height,
        uint64 txIndex,
        address indexed payerFromTopic1,
        address indexed txFrom,
        address recipientFromTopic2,
        uint256 amount,
        bool payerDiffersFromTxFrom,
        uint256 verifyAndEmitGasUsed,
        uint8 sourceReceiptStatus,
        uint256 sourceLogCount
    );

    /// @notice `verifyAndEmit` answered false rather than reverting.
    error VerificationReturnedFalse(uint64 chainKey, uint64 height);
    /// @notice The proved Source Chain transaction reverted on its own chain.
    error SourceTransactionFailed(uint8 receiptStatus);
    /// @notice `logIndexInTx` does not name a log this transaction emitted.
    error LogIndexOutOfRange(uint256 logIndexInTx, uint256 logCount);
    /// @notice The named log was emitted by a contract other than the expected Asset.
    error LogAddressMismatch(address expected, address found);
    /// @notice The named log is not a three-topic ERC-20 `Transfer`.
    error LogShapeMismatch(uint256 topicCount, bytes32 topicZero);
    /// @notice `topics[1]` and the transaction `from` field name the same address, so this target
    /// cannot demonstrate that payer resolution ignores the gas payer.
    error PayerEqualsTxFrom(address shared);

    /// @notice The four fields the probe reads out of one decoded Source Chain transaction.
    struct Decoded {
        /// @dev `topics[1]` — the address Tab must credit.
        address payer;
        /// @dev The transaction `from` field — the address that paid the gas.
        address txFrom;
        /// @dev `topics[2]` — the recipient.
        address recipient;
        /// @dev The transfer amount from the log's single data word.
        uint256 amount;
        /// @dev The Source Chain receipt status. `1` is success.
        uint8 receiptStatus;
        /// @dev How many logs this transaction emitted.
        uint256 logCount;
    }

    /// @notice Prove one Source Chain transaction and emit the payer decoded from its `Transfer` log.
    /// @param input The submission. See {ProofInput}.
    /// @return payer The address in `topics[1]`, which is who Tab must credit.
    /// @return txFrom The transaction's `from` field, which is who paid the gas.
    /// @return txIndex The transaction index recovered from the proof's sibling laterality.
    /// @return verifyAndEmitGasUsed Gas consumed by the `verifyAndEmit` call alone.
    function probe(ProofInput calldata input)
        external
        returns (address payer, address txFrom, uint64 txIndex, uint256 verifyAndEmitGasUsed)
    {
        INativeQueryVerifier verifier = NativeQueryVerifierLib.getVerifier();

        uint256 gasBefore = gasleft();
        bool verified = verifier.verifyAndEmit(
            input.chainKey, input.height, input.encodedTransaction, input.merkleProof, input.continuityProof
        );
        verifyAndEmitGasUsed = gasBefore - gasleft();
        if (!verified) revert VerificationReturnedFalse(input.chainKey, input.height);

        txIndex = verifier.calculateTxIndex(input.merkleProof);

        Decoded memory d = _decode(input.encodedTransaction, input.logIndexInTx, input.asset, input.transferTopic0);
        payer = d.payer;
        txFrom = d.txFrom;

        // The assertion this whole spike exists for. Credit follows the log's indexed sender, so a
        // target whose gas payer happens to be the same address cannot demonstrate the rule.
        if (payer == txFrom) revert PayerEqualsTxFrom(payer);

        emit ProbeResult(
            input.chainKey,
            input.height,
            txIndex,
            payer,
            txFrom,
            d.recipient,
            d.amount,
            true,
            verifyAndEmitGasUsed,
            d.receiptStatus,
            d.logCount
        );
    }

    /// @notice `calculateTxIndex` through the probe, so the index can be recomputed with no key and
    /// no gas and compared against the index read from the Source Chain's own RPC.
    /// @param merkleProof The same inclusion proof carried in {ProofInput}.
    /// @return txIndex Zero-based index of the transaction within its block.
    function txIndexOf(INativeQueryVerifier.MerkleProof calldata merkleProof)
        external
        view
        returns (uint64 txIndex)
    {
        txIndex = NativeQueryVerifierLib.getVerifier().calculateTxIndex(merkleProof);
    }

    /// @notice Decode a submission without proving anything, so the transcript can separate a
    /// decoding problem from a proving problem.
    /// @param encodedTransaction The transaction and receipt in the attested `(uint8, bytes[])` encoding.
    /// @param logIndexInTx Index of the log within this transaction's own log array.
    /// @param asset The Asset contract expected to have emitted the log.
    /// @param transferTopic0 `keccak256("Transfer(address,address,uint256)")`.
    /// @return decoded The decoded fields. See {Decoded}.
    function decodeOnly(
        bytes calldata encodedTransaction,
        uint256 logIndexInTx,
        address asset,
        bytes32 transferTopic0
    ) external pure returns (Decoded memory decoded) {
        decoded = _decode(encodedTransaction, logIndexInTx, asset, transferTopic0);
    }

    /// @notice Pull the payer, the gas payer, the recipient, and the amount out of one encoded
    /// Source Chain transaction.
    /// @dev Only `EvmV1Decoder`'s `internal` helpers are called, so the library inlines and never
    /// has to be deployed or linked. The first 32-byte word of the encoding is the transaction
    /// type, which decides whether the receipt sits at chunk index 2 or 3; reading it directly
    /// avoids a call into the library's `public` surface, which *would* force linking.
    /// @param encodedTransaction The transaction and receipt in the attested `(uint8, bytes[])` encoding.
    /// @param logIndexInTx Index of the log within this transaction's own log array.
    /// @param asset The Asset contract expected to have emitted the log.
    /// @param transferTopic0 `keccak256("Transfer(address,address,uint256)")`.
    /// @return decoded The decoded fields. See {Decoded}.
    function _decode(
        bytes calldata encodedTransaction,
        uint256 logIndexInTx,
        address asset,
        bytes32 transferTopic0
    ) private pure returns (Decoded memory decoded) {
        uint8 txType = abi.decode(encodedTransaction[0:32], (uint8));

        decoded.txFrom = EvmV1Decoder._decodeCommonTxChunk(encodedTransaction).from;

        EvmV1Decoder.ReceiptFields memory receipt =
            EvmV1Decoder._decodeReceiptChunk(encodedTransaction, txType);
        decoded.receiptStatus = receipt.receiptStatus;
        decoded.logCount = receipt.receiptLogs.length;

        if (receipt.receiptStatus != 1) revert SourceTransactionFailed(receipt.receiptStatus);
        if (logIndexInTx >= decoded.logCount) revert LogIndexOutOfRange(logIndexInTx, decoded.logCount);

        EvmV1Decoder.LogEntry memory entry = receipt.receiptLogs[logIndexInTx];
        if (entry.address_ != asset) revert LogAddressMismatch(asset, entry.address_);
        if (entry.topics.length != 3 || entry.topics[0] != transferTopic0) {
            revert LogShapeMismatch(
                entry.topics.length, entry.topics.length == 0 ? bytes32(0) : entry.topics[0]
            );
        }

        decoded.payer = address(uint160(uint256(entry.topics[1])));
        decoded.recipient = address(uint160(uint256(entry.topics[2])));
        decoded.amount = abi.decode(entry.data, (uint256));
    }
}
