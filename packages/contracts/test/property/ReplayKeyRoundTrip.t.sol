// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {TabAscBaseHarness} from "../harness/TabAscBaseHarness.sol";

/// @title ReplayKeyRoundTripTest
/// @notice Fuzz test over the replay-key round trip.
/// @dev `unpackReplayKey(replayKey(a, b, c, d))` must return `(a, b, c, d)` for every quadruple of
/// `uint64` values. The four fields fill the 32-byte word exactly, so the round trip holding is the
/// same statement as the tuple-to-key map being injective: two tuples packing to one word could not
/// both be recovered from it. That injectivity is what the replay ledger relies on, since a collision
/// would let one Settlement log consume another log's identity.
///
/// The generated inputs are all four `uint64` parameters with no assumptions, so the whole input
/// space is in scope and the fuzzer needs no constraint to stay inside it. Runs come from the
/// `[profile.default.fuzz]` block in `foundry.toml`, currently 256.
///
/// This is the on-chain half only. The same round trip is asserted off-chain in
/// `packages/shared/test/replay-key.test.mjs`, and the two implementations are compared against each
/// other in `ReplayKeyDifferential.t.sol`.
///
/// Requirements: 4.1
contract ReplayKeyRoundTripTest is Test {
    /// @notice Deployable instance of the base, since the packing pair lives on the abstract contract.
    TabAscBaseHarness internal asc;

    /// @notice Deploys the harness.
    function setUp() public {
        asc = new TabAscBaseHarness();
    }

    /// @notice Packing then unpacking returns every field unchanged.
    /// @param chainKey Attested-chain identifier.
    /// @param blockHeight Source Chain block height.
    /// @param txIndex Index of the transaction within its block.
    /// @param logIndex Receipt-wide ordinal of the log.
    function testFuzz_roundTripReturnsEveryFieldUnchanged(
        uint64 chainKey,
        uint64 blockHeight,
        uint64 txIndex,
        uint64 logIndex
    ) public view {
        bytes32 key = asc.replayKey(chainKey, blockHeight, txIndex, logIndex);
        (uint64 gotChainKey, uint64 gotBlockHeight, uint64 gotTxIndex, uint64 gotLogIndex) =
            asc.unpackReplayKey(key);

        assertEq(gotChainKey, chainKey, "chainKey");
        assertEq(gotBlockHeight, blockHeight, "blockHeight");
        assertEq(gotTxIndex, txIndex, "txIndex");
        assertEq(gotLogIndex, logIndex, "logIndex");
    }
}
