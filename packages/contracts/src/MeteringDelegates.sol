// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title IMeteringDelegates
/// @notice Which session keys an Agent has named to sign its metering claims, and until when.
interface IMeteringDelegates {
    /// @notice An Agent named `delegate` to sign its metering claims until `expiry`.
    event DelegateSet(address indexed agent, address indexed delegate, uint64 expiry);

    /// @notice An Agent withdrew `delegate` before its expiry.
    event DelegateRevoked(address indexed agent, address indexed delegate);

    error ZeroAddressDelegate();
    error ExpiryNotInFuture(uint64 expiry, uint64 nowTs);
    error ExpiryTooFar(uint64 expiry, uint64 latest);
    error DelegateNotSet(address agent, address delegate);

    function setDelegate(address delegate, uint64 expiry) external;
    function revokeDelegate(address delegate) external;
    function expiryOf(address agent, address delegate) external view returns (uint64 expiry);
    function isDelegate(address agent, address delegate) external view returns (bool);
}

/// @title MeteringDelegates
/// @notice An Agent names a session key that may sign metering claims on its behalf, until an expiry.
///
/// A metering gateway takes a metered call only when it is signed: by the Service operator, by the
/// Agent the call is charged to, or by a key the Agent has named here. The third exists for an Agent
/// whose own key can submit transactions but cannot sign an arbitrary message, such as a wallet that
/// exposes a transaction executor and nothing else. That Agent sends one transaction naming a local
/// key, and the key signs each call's claim from then on.
///
/// **What a delegate can do is the security argument.** A delegate signs the same metering digest the
/// Agent would, and nothing in Tab reads this contract except to decide whether that signature
/// counts. It can never move funds: a Settlement is made by `TabSettlement` from the Agent's own key
/// or the Agent's own Permit2 signature, and neither consults this registry. Every charge a delegate
/// can cause still passes `TabBook.recordDelivery`, which enforces the Agent's own
/// `TabBook.authorise` ceiling and expiry for that Service and Asset, and the Credit Limit on top. So
/// the most a leaked delegate key costs the Agent is metered calls, at the listed price, up to the
/// ceilings the Agent already set, until the delegate's expiry or the Agent's revocation, whichever
/// comes first. The Agent revokes with one transaction.
///
/// An expiry is required and bounded to `MAX_DELEGATION` ahead, so a forgotten key lapses on its own.
/// Setting a delegate again replaces its expiry, which is how an Agent extends or shortens one.
///
/// Nothing here is owned, pausable, or upgradeable, and the contract holds nothing: there is no
/// `payable` function and no `receive`. The only state is what each Agent wrote for itself.
contract MeteringDelegates is IMeteringDelegates {
    /// @notice The furthest ahead a delegation may expire, measured from the block it is set in.
    uint64 public constant MAX_DELEGATION = 365 days;

    /// @dev Agent to delegate to the expiry, in seconds since the epoch. Zero means never set or revoked.
    mapping(address agent => mapping(address delegate => uint64 expiry)) internal _expiries;

    /// @notice Name `delegate` to sign the caller's metering claims until `expiry`.
    /// @dev The caller is the Agent. `expiry` must be after the current block and no more than
    /// `MAX_DELEGATION` after it. Calling again for the same delegate replaces the expiry.
    function setDelegate(address delegate, uint64 expiry) external {
        if (delegate == address(0)) revert ZeroAddressDelegate();
        uint64 nowTs = uint64(block.timestamp);
        if (expiry <= nowTs) revert ExpiryNotInFuture(expiry, nowTs);
        uint64 latest = nowTs + MAX_DELEGATION;
        if (expiry > latest) revert ExpiryTooFar(expiry, latest);
        _expiries[msg.sender][delegate] = expiry;
        emit DelegateSet(msg.sender, delegate, expiry);
    }

    /// @notice Withdraw `delegate` at once. Its signatures stop counting from this block.
    /// @dev Reverts for a delegate the caller never set or already revoked, so a typo in the address is
    /// a refusal rather than a transaction that looks like it revoked something.
    function revokeDelegate(address delegate) external {
        if (_expiries[msg.sender][delegate] == 0) revert DelegateNotSet(msg.sender, delegate);
        delete _expiries[msg.sender][delegate];
        emit DelegateRevoked(msg.sender, delegate);
    }

    /// @notice When `agent`'s delegation to `delegate` lapses. Zero when never set or revoked; a past
    /// value when it has lapsed.
    function expiryOf(address agent, address delegate) external view returns (uint64 expiry) {
        expiry = _expiries[agent][delegate];
    }

    /// @notice Whether `delegate` may sign `agent`'s metering claims in this block.
    function isDelegate(address agent, address delegate) external view returns (bool) {
        return _expiries[agent][delegate] > block.timestamp;
    }
}
