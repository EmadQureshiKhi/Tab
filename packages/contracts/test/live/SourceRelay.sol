// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title SourceRelay - a Source Chain helper that creates the three Settlement shapes an externally
/// owned account cannot produce on its own.
///
/// @dev **This is test material, not product.** It is deployed to Ethereum Sepolia so the live
/// negative-path suite can reach three of requirement 27's cases, and nothing on Creditcoin knows or
/// cares that it exists. It is deliberately not under `src/`: Tab deploys exactly one contract to a
/// Source Chain, the `TabSettlement` of requirement 1, and adding a second would misrepresent the
/// deployment surface.
///
/// Three shapes, and why each needs a contract at all:
///
/// - **The payer is not the sender (R27.10).** An ERC-20 `Transfer` puts the *token holder* in
///   `topics[1]`, and for a plain wallet call the holder and the transaction sender are the same
///   account, so `from` and `topics[1]` can never diverge. Holding the Asset here and moving it on
///   somebody else's instruction separates them: this contract is `topics[1]`, and whoever called is
///   `from`. That is the relayer, sponsored-gas, and smart-account case, and requirement 8 exists
///   because the two must not be confused.
/// - **Two Settlements in one transaction (R27.11).** One transaction, two `transfer` calls, two
///   independent `Transfer` logs at distinct receipt ordinals. `TabSettlement.settleBatch` would also
///   emit two Settlements, but each of its instructions additionally emits the `Transfer` that funded
///   it, and on chainKey 1 both shapes are recognised, so a batch of two presents four creditable
///   logs. That is the emitter-registration defect of task 10.12, and a case built on it would record
///   a defect as a pass. Two plain transfers present exactly two Settlements and nothing else.
/// - **An anonymous log beside a recognised one (R27.12).** `log0` writes a log with zero topics,
///   which no `topics[0]` can match. The sweep has to step over it and still reach the `Transfer`
///   after it. Solidity has no expression for a topicless log, so this is the one place the contract
///   drops to assembly.
///
/// **Every shape here is a plain ERC-20 `Transfer` and none of them calls `TabSettlement.settle`.**
/// That is the point rather than a convenience. On chainKey 1 a `settle` call emits the `Transfer`
/// that funded it *and* its own `TabSettled`, and the deployed registry authorises both the Asset and
/// the settlement contract as emitters, so both logs are recognised and one payment is ingested twice.
/// A `settleBatch` of two instructions therefore presents four creditable logs for two payments, not
/// two. That is the emitter-registration defect recorded as task 10.12, and a case built on it would
/// record a defect as a pass. Moving the Asset directly produces exactly one recognised log per
/// Settlement, so the counts these cases assert mean what requirement 4.3 says they mean.
contract SourceRelay {
    /// @notice The Asset transfer failed, or returned something other than success.
    error TransferFailed(address asset, address to, uint256 amount);

    /// @dev `transfer(address,uint256)`, taken once rather than hashed at each call site.
    bytes4 private constant TRANSFER_SELECTOR = bytes4(keccak256("transfer(address,uint256)"));

    /// @dev The single word the anonymous log carries. Its value is immaterial; what the case turns
    /// on is that the log has no topics at all.
    uint256 private constant ANONYMOUS_LOG_WORD = 1;

    /// @notice Moves `amount` of `asset` to `to`, making this contract the payer in `topics[1]`.
    /// @dev Permissionless on purpose. It holds only what a test funded it with, on a test network,
    /// and a guard here would be ceremony rather than security.
    /// @param asset Asset contract on this chain.
    /// @param to Collection Address receiving the Settlement.
    /// @param amount Amount in the Asset's base units.
    function relay(address asset, address to, uint256 amount) external {
        _move(asset, to, amount);
    }

    /// @notice Two distinct Settlements in one transaction, at two receipt ordinals. (R27.11)
    /// @dev Distinct amounts are the caller's job. Two logs with identical fields are still two
    /// Settlements with two replay keys, because the key packs the log ordinal, but distinct amounts
    /// make the record legible to somebody reading it later.
    /// @param asset Asset contract on this chain.
    /// @param to Collection Address receiving both Settlements.
    /// @param first Amount of the first Settlement.
    /// @param second Amount of the second Settlement.
    function relayTwice(address asset, address to, uint256 first, uint256 second) external {
        _move(asset, to, first);
        _move(asset, to, second);
    }

    /// @notice An anonymous log, then a Settlement, in that order. (R27.12)
    /// @dev `log0` is emitted *before* the transfer so the sweep meets the topicless log first and has
    /// to carry on past it to reach the recognised one. A log emitted afterwards would be skipped
    /// after the work was already done and would prove nothing about continuation.
    /// @param asset Asset contract on this chain.
    /// @param to Collection Address receiving the Settlement.
    /// @param amount Amount in the Asset's base units.
    function relayAfterAnonymousLog(address asset, address to, uint256 amount) external {
        uint256 word = ANONYMOUS_LOG_WORD;
        assembly ("memory-safe") {
            // One word of data and no topics. `topics.length == 0` is the condition the sweep skips
            // on, and it is unreachable from Solidity's own event syntax, which always writes at
            // least the signature topic.
            mstore(0x00, word)
            log0(0x00, 0x20)
        }
        _move(asset, to, amount);
    }

    /// @dev `transfer`, accepting both the bool-returning and the void-returning conventions, because
    /// a token that returns nothing on success is as common as one returning `true` and a helper that
    /// reverted on the first kind would be a harness bug wearing a Settlement's clothes.
    function _move(address asset, address to, uint256 amount) private {
        (bool ok, bytes memory returned) = asset.call(abi.encodeWithSelector(TRANSFER_SELECTOR, to, amount));
        if (!ok || (returned.length != 0 && !abi.decode(returned, (bool)))) {
            revert TransferFailed(asset, to, amount);
        }
    }
}
