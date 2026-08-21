// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {TabAscBase} from "../../src/asc/TabAscBase.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

/// @title TabAscBaseHarness
/// @notice Smallest concrete contract that satisfies every abstract member of `TabAscBase`.
/// @dev This exists to prove two things at compile time: that the base is inheritable, and that each
/// hook signature is actually implementable — including the pairing of a `view` hook with signature
/// filtering, which is the shape `_filteredRecognisedCount` is meant to be written in. It carries no
/// registry, no accounting, and no assertions; the behavioural suite for `TabAscBase` is task 4.4's.
///
/// It is also the deployable instance the replay-key tests call, since `replayKey` and
/// `unpackReplayKey` are `public` on the base and need no wrapper here: an earlier `packReplayKey`
/// wrapper existed only while the packing was `internal`, and it was dropped when the pair became
/// part of the base's read surface.
contract TabAscBaseHarness is TabAscBase {
    /// @notice The single Settlement signature this harness recognises.
    bytes32 public constant RECOGNISED_SIG = keccak256("Settled(address,uint256)");

    /// @notice Attested chains this harness settles from.
    uint64 public constant CHAIN_KEY_SEPOLIA = 1;
    uint64 public constant CHAIN_KEY_MAINNET = 3;

    /// @notice Replay key of the most recent log handed to the handler, for inspection.
    bytes32 public lastHandledKey;

    /// @notice Total logs the handler has been invoked for.
    uint256 public handledCount;

    /// @inheritdoc TabAscBase
    function _isSupportedChainKey(uint64 chainKey) internal pure override returns (bool supported) {
        supported = chainKey == CHAIN_KEY_SEPOLIA || chainKey == CHAIN_KEY_MAINNET;
    }

    /// @inheritdoc TabAscBase
    /// @dev `chainKey` reaches the hook, which is the point of the signature; the harness reads it
    /// so the parameter is demonstrably usable rather than decorative.
    function _isRecognised(uint64 chainKey, EvmV1Decoder.LogEntry memory logEntry)
        internal
        pure
        override
        returns (bool recognised)
    {
        recognised = _isSupportedChainKey(chainKey) && logEntry.topics[0] == RECOGNISED_SIG;
    }

    /// @inheritdoc TabAscBase
    function _handleRecognisedLog(uint64, uint64, uint64, uint64, bytes32 key, EvmV1Decoder.LogEntry memory)
        internal
        override
    {
        lastHandledKey = key;
        ++handledCount;
    }

    /// @inheritdoc TabAscBase
    /// @dev Filters the receipt by the one registered signature. A real implementation totals one
    /// filter call per registered signature.
    function _filteredRecognisedCount(uint64, EvmV1Decoder.ReceiptFields memory receipt)
        internal
        pure
        override
        returns (uint256 count)
    {
        count = EvmV1Decoder.getLogsByEventSignature(receipt, RECOGNISED_SIG).length;
    }
}
