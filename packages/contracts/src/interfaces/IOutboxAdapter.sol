// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title IOutboxAdapter
/// @notice The Creditcoin-to-Source-Chain write path, declared as a type and nothing more.
/// @dev **Zero implementation ships with this interface, and that is the requirement rather than an
/// omission.** (R19.2) Publishing a Credit Limit, a delinquency, or a Bond withdrawal onto a Source
/// Chain needs Writability — the prospective Attestcoin Protocol capability that lets Creditcoin
/// write to a chain it currently only reads. Writability is unavailable on CC3 Testnet and sits
/// outside the scope of this feature, so there is no contract here to point at a live endpoint, and
/// a stub returning `true` from {isAvailable} would be worse than nothing: it would let a caller
/// treat an unpublished limit as published.
///
/// The full settlement, verification, and credit flow runs on Readability alone (R19.1). Nothing in
/// `SettlementVerifier`, `TabBook`, `AgentRegistry`, `ServiceRegistry`, `Bond`, or `LimitLib` calls
/// any function declared below, and no deployment wires an address into this type. What the
/// declaration buys is that enabling the path later is a wiring task against a fixed shape rather
/// than a design task: the arguments each publication needs are settled now, while the reasons for
/// them are still in view.
///
/// Two consequences of the absence are recorded elsewhere as limitations rather than as solved
/// problems, and both are the same missing capability seen from different sides: prepaid credit and
/// slashed value stay on Creditcoin as Asset-denominated credit because returning Asset value to a
/// Source Chain address would require this interface to be implemented.
///
/// Every amount is an integer count of the Asset's base units. There is no price, rate, or
/// conversion factor in any argument, because there is none anywhere in the system. (R18.6)
///
/// Requirements: 19.1, 19.2
interface IOutboxAdapter {
    /// @notice A Credit Limit was published to a Source Chain.
    /// @param chainKey Attested-chain identifier the limit was published to.
    /// @param agent Creditcoin Agent identity the limit belongs to.
    /// @param asset Asset the limit is denominated in.
    /// @param limit The published Credit Limit in Asset base units.
    /// @param receiptId Identifier the publication's progress is tracked under.
    event CreditLimitPublished(
        uint64 chainKey, address indexed agent, address indexed asset, uint256 limit, bytes32 receiptId
    );

    /// @notice A delinquent tab was published to a Source Chain.
    /// @param chainKey Attested-chain identifier the notice was published to.
    /// @param agent Creditcoin Agent identity the delinquency belongs to.
    /// @param asset Asset whose Credit Limit the delinquency zeroed.
    /// @param receiptId Identifier the publication's progress is tracked under.
    event DelinquencyPublished(
        uint64 chainKey, address indexed agent, address indexed asset, bytes32 receiptId
    );

    /// @notice A Bond withdrawal was published to a Source Chain.
    /// @param chainKey Attested-chain identifier the withdrawal was published to.
    /// @param to Source Chain address the released stake is owed to.
    /// @param asset Asset the stake is denominated in.
    /// @param amount Released amount in Asset base units.
    /// @param receiptId Identifier the publication's progress is tracked under.
    event BondWithdrawalPublished(
        uint64 chainKey, address indexed to, address indexed asset, uint256 amount, bytes32 receiptId
    );

    /// @notice Is a write path to a Source Chain available at all?
    /// @dev The first call every caller has to make, and the reason the interface is safe to declare
    /// unimplemented: with no implementation there is nothing to answer `true`, and an implementation
    /// that ever answers `false` tells a caller to fall back rather than to assume a publication
    /// landed. (R19.4)
    /// @return available True only where Writability is live for at least one Source Chain.
    function isAvailable() external view returns (bool available);

    /// @notice Publish an Agent's Credit Limit for one Asset onto a Source Chain.
    /// @param chainKey Attested-chain identifier to publish to.
    /// @param agent Creditcoin Agent identity the limit belongs to.
    /// @param asset Asset the limit is denominated in.
    /// @param limit The Credit Limit in Asset base units.
    /// @return receiptId Identifier to read the publication's status back under.
    function publishCreditLimit(uint64 chainKey, address agent, address asset, uint256 limit)
        external
        returns (bytes32 receiptId);

    /// @notice Publish that an Agent's tab is delinquent for one Asset onto a Source Chain.
    /// @dev Carries no amount. A delinquency zeroes the Credit Limit for that Asset, so the figure it
    /// publishes is fixed by the event itself.
    /// @param chainKey Attested-chain identifier to publish to.
    /// @param agent Creditcoin Agent identity the delinquency belongs to.
    /// @param asset Asset whose Credit Limit is zeroed.
    /// @return receiptId Identifier to read the publication's status back under.
    function publishDelinquency(uint64 chainKey, address agent, address asset)
        external
        returns (bytes32 receiptId);

    /// @notice Publish a released Bond withdrawal onto a Source Chain so stake can be paid out.
    /// @param chainKey Attested-chain identifier to publish to.
    /// @param to Source Chain address the released stake is owed to.
    /// @param asset Asset the stake is denominated in.
    /// @param amount Released amount in Asset base units.
    /// @return receiptId Identifier to read the publication's status back under.
    function publishBondWithdrawal(uint64 chainKey, address to, address asset, uint256 amount)
        external
        returns (bytes32 receiptId);

    /// @notice Status of one publication.
    /// @dev Deliberately a small integer rather than a boolean. A cross-chain write is not settled by
    /// the transaction that requests it, so a caller needs to distinguish "not yet" from "never", and
    /// collapsing the two would let an unpublished figure read as a failed one or the reverse.
    /// @param receiptId Identifier returned by whichever publish call created it.
    /// @return status `0` unknown, `1` pending, `2` published, `3` failed.
    function receiptStatusOf(bytes32 receiptId) external view returns (uint8 status);
}
