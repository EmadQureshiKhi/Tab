// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {TabAscBaseHarness} from "../harness/TabAscBaseHarness.sol";

/// @title ReplayKeyDifferentialTest
/// @notice Differential test between the on-chain replay-key packing and the off-chain one.
/// @dev **How this is differential.** The fixture at `test/fixtures/replay-key-vectors.json` is not
/// a hand-written table. `tools/replay-key-fixture.mjs` builds a deterministic tuple set and *runs*
/// `packages/shared/src/replay-key.ts` over it, recording what that implementation returned. This
/// test runs `TabAscBase.replayKey` and `TabAscBase.unpackReplayKey` over the same tuples and
/// compares. Two implementations execute, and their outputs are compared value by value.
///
/// **What it proves.** For every tuple in the set, the two implementations agree in both directions:
/// the Solidity packing produces the exact word the off-chain packing produced, and the Solidity
/// inverse recovers the exact tuple from that word. The set includes a single set bit walked through
/// all 64 positions of each of the four fields, so any disagreement about a field's bit offset or
/// width moves 64 recorded words and cannot escape. It also includes both boundaries of every field,
/// the seven vectors pinned in prose, and 128 pseudorandom mixed-magnitude tuples.
///
/// **What it does not prove.** Three things.
///
/// 1. It is a finite tuple set, not a proof over all `2^256` tuples. The companion fuzz test in
///    `ReplayKeyRoundTrip.t.sol` covers the Solidity round trip over generated inputs, and the
///    off-chain test suite covers the off-chain round trip, but neither crosses the boundary; only
///    this fixture does, and only for the tuples in it.
/// 2. It cannot catch the two implementations being wrong together. If the layout in the design were
///    itself wrong, both sides would agree on the wrong layout and this test would pass. The seven
///    pinned words are the guard for that, and they are asserted against literals in the generator,
///    which is a third place the layout is written down.
/// 3. It says nothing about range rejection. The off-chain implementation throws a `RangeError` for a
///    field outside `[0, 2^64 - 1]`, and that half has no on-chain counterpart to compare against: a
///    Solidity `uint64` parameter cannot hold an out-of-range value in the first place, so there is
///    no reachable state for an on-chain test to assert about. The rejection behaviour is therefore
///    tested off-chain only, in `packages/shared/test/replay-key.test.mjs`.
///
/// The fixture is committed. `forge test` then needs no Node process, no build of another workspace
/// package, and no network, which keeps the Solidity suite runnable on its own. Committing it does
/// create one staleness risk — an off-chain change with no regenerated fixture — so the generator has
/// a `--check` mode that re-runs the off-chain implementation and fails if the committed words no
/// longer match, and this package's `test` script runs that check before `forge test`.
///
/// Requirements: 4.1
contract ReplayKeyDifferentialTest is Test {
    /// @notice Fixture location, resolved from the Foundry project root.
    string internal constant FIXTURE_PATH = "test/fixtures/replay-key-vectors.json";

    /// @notice Floor on the vector count, so a truncated fixture fails instead of passing vacuously.
    uint256 internal constant MINIMUM_VECTORS = 400;

    /// @notice Deployable instance of the base, since `replayKey` lives on the abstract contract.
    TabAscBaseHarness internal asc;

    /// @notice Deploys the harness.
    function setUp() public {
        asc = new TabAscBaseHarness();
    }

    /// @notice Every recorded off-chain word is reproduced on chain, and inverted back to its tuple.
    function test_onChainPackingAgreesWithTheOffChainPacking() public view {
        string memory fixture = vm.readFile(FIXTURE_PATH);

        string[] memory chainKeys = vm.parseJsonStringArray(fixture, ".vectors.chainKey");
        string[] memory blockHeights = vm.parseJsonStringArray(fixture, ".vectors.blockHeight");
        string[] memory txIndices = vm.parseJsonStringArray(fixture, ".vectors.txIndex");
        string[] memory logIndices = vm.parseJsonStringArray(fixture, ".vectors.logIndex");
        string[] memory keys = vm.parseJsonStringArray(fixture, ".vectors.key");

        uint256 count = chainKeys.length;
        assertGe(count, MINIMUM_VECTORS, "fixture carries fewer vectors than expected");
        assertEq(count, vm.parseJsonUint(fixture, ".count"), "declared count disagrees with column length");
        assertEq(blockHeights.length, count, "blockHeight column length");
        assertEq(txIndices.length, count, "txIndex column length");
        assertEq(logIndices.length, count, "logIndex column length");
        assertEq(keys.length, count, "key column length");

        for (uint256 i = 0; i < count; ++i) {
            uint64 chainKey = _toUint64(chainKeys[i], i, "chainKey");
            uint64 blockHeight = _toUint64(blockHeights[i], i, "blockHeight");
            uint64 txIndex = _toUint64(txIndices[i], i, "txIndex");
            uint64 logIndex = _toUint64(logIndices[i], i, "logIndex");
            bytes32 offChainKey = vm.parseBytes32(keys[i]);

            // Forward direction: the same tuple must pack to the same word on both sides.
            assertEq(
                asc.replayKey(chainKey, blockHeight, txIndex, logIndex),
                offChainKey,
                string.concat("packing disagrees at vector ", vm.toString(i))
            );

            // Inverse direction: the on-chain inverse must recover the tuple from the off-chain word,
            // which is what makes the comparison two-sided rather than a one-way hash check.
            (uint64 gotChainKey, uint64 gotBlockHeight, uint64 gotTxIndex, uint64 gotLogIndex) =
                asc.unpackReplayKey(offChainKey);
            string memory at = string.concat(" at vector ", vm.toString(i));
            assertEq(gotChainKey, chainKey, string.concat("chainKey", at));
            assertEq(gotBlockHeight, blockHeight, string.concat("blockHeight", at));
            assertEq(gotTxIndex, txIndex, string.concat("txIndex", at));
            assertEq(gotLogIndex, logIndex, string.concat("logIndex", at));
        }
    }

    /// @notice Reads one decimal field from the fixture and narrows it to `uint64`.
    /// @dev The fixture stores every field as a decimal string, so nothing depends on how a JSON
    /// number of `2^64 - 1` would be coerced. The bound is asserted rather than silently truncated:
    /// a fixture value above the ceiling means the generator is wrong, and truncating it here would
    /// hide that.
    /// @param value The decimal string as recorded.
    /// @param index Index of the vector, for the failure message.
    /// @param field Name of the field, for the failure message.
    /// @return narrowed The value as a `uint64`.
    function _toUint64(string memory value, uint256 index, string memory field)
        private
        pure
        returns (uint64 narrowed)
    {
        uint256 parsed = vm.parseUint(value);
        assertLe(
            parsed,
            uint256(type(uint64).max),
            string.concat("fixture ", field, " exceeds uint64 at vector ", vm.toString(index))
        );
        // casting to 'uint64' is safe because the assertion above establishes the bound.
        // forge-lint: disable-next-line(unsafe-typecast)
        narrowed = uint64(parsed);
    }
}
