// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

/// @title SourceTxFixture
/// @notice Builds `encodedTransaction` bytes that `EvmV1Decoder` genuinely decodes.
/// @dev Not a stub. The prover publishes a transaction as `abi.encode(uint8 txType, bytes[] chunks)`
/// where the chunks are themselves abi-encoded field groups, and the decoder reads the receipt out of
/// the last chunk as `(uint8 receiptStatus, uint64 receiptGasUsed, LogEntryTuple[] receiptLogs,
/// bytes receiptLogsBloom)`. Every one of those is expressible in Solidity, so the fixtures this
/// library produces go through `getTransactionType`, `decodeCommonTxFields`, and
/// `decodeReceiptFields` unmodified, exactly as a real submission would.
///
/// That matters most for one field. {encode} takes `from` separately from any log, so a test can
/// build a transaction whose `from` is one party while `topics[1]` of its Settlement log is another —
/// which is the divergence that decides whether crediting reads the payer or the gas payer.
///
/// Type 2 only, and three chunks, because that is what the receipt decoder wants for types 0 through
/// 2 and type 2 is what an ordinary Source Chain settlement is. Nothing here needs a fourth chunk.
library SourceTxFixture {
    /// @notice `receiptStatus` of a successful Source Chain transaction.
    uint8 internal constant STATUS_SUCCESS = 1;

    /// @notice `receiptStatus` of a reverted Source Chain transaction.
    uint8 internal constant STATUS_REVERTED = 0;

    /// @notice EIP-1559 transaction type, which is what a modern settlement is.
    uint8 internal constant TX_TYPE_EIP1559 = 2;

    /// @notice Build one log entry.
    /// @param emitter Contract that emitted it.
    /// @param topics Its topics, signature first.
    /// @param data Its unindexed payload.
    /// @return entry The log entry.
    function logEntry(address emitter, bytes32[] memory topics, bytes memory data)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple memory entry)
    {
        entry = EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: data});
    }

    /// @notice Build a well-formed ERC-20 `Transfer` log.
    /// @param asset Asset contract that emitted it.
    /// @param from Sender, which lands in `topics[1]` and is the payer.
    /// @param to Recipient, which lands in `topics[2]`.
    /// @param amount Transferred amount, which is the whole of the data.
    /// @return entry The log entry.
    function transferLog(address asset, address from, address to, uint256 amount)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple memory entry)
    {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = keccak256("Transfer(address,address,uint256)");
        topics[1] = bytes32(uint256(uint160(from)));
        topics[2] = bytes32(uint256(uint160(to)));
        entry = logEntry(asset, topics, abi.encode(amount));
    }

    /// @notice Build a well-formed `TabSettled` log.
    /// @param emitter Source Chain settlement contract that emitted it.
    /// @param agent Payer, which lands in `topics[1]`.
    /// @param service Collection Address, which lands in `topics[2]`.
    /// @param amount Settled amount, which is the whole of the data.
    /// @param tabId The Agent's own tab identifier, which lands in `topics[3]`.
    /// @return entry The log entry.
    function tabSettledLog(address emitter, address agent, address service, uint256 amount, bytes32 tabId)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple memory entry)
    {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = keccak256("TabSettled(address,address,uint256,bytes32)");
        topics[1] = bytes32(uint256(uint160(agent)));
        topics[2] = bytes32(uint256(uint160(service)));
        topics[3] = tabId;
        entry = logEntry(emitter, topics, abi.encode(amount));
    }

    /// @notice Build a log carrying no topics at all, which can match no signature.
    /// @param emitter Contract that emitted it.
    /// @return entry The log entry.
    function zeroTopicLog(address emitter) internal pure returns (EvmV1Decoder.LogEntryTuple memory entry) {
        entry = logEntry(emitter, new bytes32[](0), hex"");
    }

    /// @notice Collect one log into an array, for the common single-Settlement case.
    /// @param entry The log entry.
    /// @return entries A one-element array.
    function one(EvmV1Decoder.LogEntryTuple memory entry)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple[] memory entries)
    {
        entries = new EvmV1Decoder.LogEntryTuple[](1);
        entries[0] = entry;
    }

    /// @notice Encode a successful type-2 transaction carrying the given logs.
    /// @param from The transaction sender, which is deliberately independent of every log's topics.
    /// @param entries Receipt logs, in receipt order.
    /// @return encoded The bytes a submission carries as `SourceTx.encodedTransaction`.
    function encode(address from, EvmV1Decoder.LogEntryTuple[] memory entries)
        internal
        pure
        returns (bytes memory encoded)
    {
        encoded = encodeWithStatus(from, STATUS_SUCCESS, entries);
    }

    /// @notice Encode a type-2 transaction with a chosen receipt status.
    /// @param from The transaction sender.
    /// @param receiptStatus `1` for a successful transaction, `0` for a reverted one.
    /// @param entries Receipt logs, in receipt order.
    /// @return encoded The bytes a submission carries as `SourceTx.encodedTransaction`.
    function encodeWithStatus(address from, uint8 receiptStatus, EvmV1Decoder.LogEntryTuple[] memory entries)
        internal
        pure
        returns (bytes memory encoded)
    {
        bytes[] memory chunks = new bytes[](3);

        // Chunk 0, the common transaction fields. `from` is here and nowhere else, which is the field
        // payer resolution must never read.
        chunks[0] = abi.encode(
            uint64(7), uint64(120_000), from, false, address(uint160(0x0DEC)), uint256(0), bytes("")
        );

        // Chunk 1, the type-2 fields. The receipt decoder never reads it; a real transaction carries
        // it, so the fixture does too.
        chunks[1] = abi.encode(
            uint64(1),
            uint128(1_500_000_000),
            uint128(30_000_000_000),
            new EvmV1Decoder.AccessListEntryBytes32[](0),
            uint8(1),
            keccak256("r"),
            keccak256("s")
        );

        // Chunk 2, the receipt. This is the chunk `decodeReceiptFields` reads.
        chunks[2] = abi.encode(receiptStatus, uint64(84_000), entries, hex"00");

        encoded = abi.encode(TX_TYPE_EIP1559, chunks);
    }
}
