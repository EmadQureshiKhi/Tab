// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title IBond
/// @notice The stake a Service posts so that its Settlement history may carry Credit Limit weight.
interface IBond {
    /// @notice One party's stake in one Asset.
    struct Ledger {
        /// @dev Total ever deposited.
        uint128 staked;
        /// @dev Total ever withdrawn.
        uint128 withdrawn;
    }

    /// @notice Stake entered the escrow.
    event BondFunded(bytes32 indexed party, address indexed asset, uint128 amount, address depositor);

    /// @notice Stake left the escrow.
    event BondWithdrawn(bytes32 indexed party, address indexed asset, uint128 amount, address to);

    error AssetNotRegistered(address asset);
    error ZeroAmount();
    error InsufficientFreeBond(bytes32 party, address asset, uint128 requested, uint128 free);

    function deposit(address asset, uint128 amount) external;
    function depositFor(address account, address asset, uint128 amount) external;
    function withdraw(address asset, uint128 amount) external returns (uint128 released);
    function freeOf(bytes32 party, address asset) external view returns (uint128 free);
    function ledgerOf(bytes32 party, address asset) external view returns (Ledger memory ledger);
    function partyOf(address account) external pure returns (bytes32 party);
}

/// @title Bond
/// @notice Escrow for Service stake on Monad.
///
/// A Service's Settlement history only counts towards an Agent's Credit Limit while the Service is
/// bonded (`LimitLib` skips unbonded records), and the Credit Limit any history can earn is capped
/// strictly below the sum of the counterparties' stake (`LimitLib.bondCap`). So a Service that wants
/// its repayment record to vouch for Agents has to put capital behind that record, and a Service that
/// colludes with an Agent to manufacture history cannot manufacture more credit than it has staked.
///
/// The escrow holds the tokens itself: a deposit is a `transferFrom` into this contract and a
/// withdrawal is a transfer out, in the same transaction that updates the ledger. Nothing in here is owned, pausable, or upgradeable, and no
/// other contract can move a party's stake.
contract Bond is IBond {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ storage

    /// @dev `keccak256(party, asset)` to its ledger.
    mapping(bytes32 => Ledger) internal _ledgers;

    // ------------------------------------------------------------------ deposits

    /// @notice Stake `amount` of `asset` for the caller's own party.
    /// @dev The caller must have approved this contract for at least `amount`.
    function deposit(address asset, uint128 amount) external {
        _deposit(msg.sender, asset, amount);
    }

    /// @notice Stake `amount` of `asset` for `account`'s party, paid by the caller.
    /// @dev Lets a treasury fund a Service's bond account without holding its key. Only `account`
    /// can ever withdraw what is credited here.
    function depositFor(address account, address asset, uint128 amount) external {
        _deposit(account, asset, amount);
    }

    function _deposit(address account, address asset, uint128 amount) internal {
        if (asset == address(0) || account == address(0)) revert AssetNotRegistered(asset);
        if (amount == 0) revert ZeroAmount();
        bytes32 party = _partyOf(account);
        _ledgers[_ledgerKey(party, asset)].staked += amount;
        emit BondFunded(party, asset, amount, msg.sender);
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
    }

    // ------------------------------------------------------------------ withdrawals

    /// @notice Withdraw up to `amount` of the caller's free stake in `asset`.
    /// @return released The amount actually paid out, which is `min(amount, free)`.
    function withdraw(address asset, uint128 amount) external returns (uint128 released) {
        if (asset == address(0)) revert AssetNotRegistered(asset);
        if (amount == 0) revert ZeroAmount();
        bytes32 party = _partyOf(msg.sender);
        Ledger storage ledger = _ledgers[_ledgerKey(party, asset)];
        uint128 available = _free(ledger);
        if (available == 0) revert InsufficientFreeBond(party, asset, amount, 0);
        released = amount > available ? available : amount;
        ledger.withdrawn += released;
        emit BondWithdrawn(party, asset, released, msg.sender);
        IERC20(asset).safeTransfer(msg.sender, released);
    }

    // ------------------------------------------------------------------ views

    function freeOf(bytes32 party, address asset) external view returns (uint128 free) {
        return _free(_ledgers[_ledgerKey(party, asset)]);
    }

    function ledgerOf(bytes32 party, address asset) external view returns (Ledger memory ledger) {
        return _ledgers[_ledgerKey(party, asset)];
    }

    function partyOf(address account) external pure returns (bytes32 party) {
        return _partyOf(account);
    }

    // ------------------------------------------------------------------ internals

    function _ledgerKey(bytes32 party, address asset) internal pure returns (bytes32 key) {
        return keccak256(abi.encode(party, asset));
    }

    function _partyOf(address account) internal pure returns (bytes32 party) {
        return bytes32(uint256(uint160(account)));
    }

    function _free(Ledger storage ledger) internal view returns (uint128 free) {
        return ledger.staked - ledger.withdrawn;
    }
}
