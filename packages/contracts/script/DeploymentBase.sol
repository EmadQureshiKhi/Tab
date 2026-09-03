// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

/// @title DeploymentBase
/// @notice Shared checks and reporting for the Monad deployment scripts.
abstract contract DeploymentBase is Script {
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10143;

    /// @notice Every Tab contract on one chain, plus the one third-party contract the surface is wired
    /// to.
    struct Deployment {
        address serviceRegistry;
        address bond;
        address tabBook;
        address tabSettlement;
        /// @dev The canonical Permit2 `TabSettlement` verifies gasless Settlements against. Not deployed
        /// by Tab; recorded because the surface is immutable over it.
        address permit2;
    }

    error WrongChain(uint256 expected, uint256 actual);
    error MissingAddress(string name);
    error NotDeployed(string name, address at);

    /// @dev Refuses to run against any chain but the one the environment names, so a wallet pointed
    /// at the wrong RPC cannot deploy to it.
    function _requireMonadChain() internal view {
        uint256 configured = vm.envUint("MONAD_CHAIN_ID");
        if (block.chainid != configured) revert WrongChain(configured, block.chainid);
    }

    function _requireAddress(string memory name, address value) internal pure returns (address checked) {
        if (value == address(0)) revert MissingAddress(name);
        checked = value;
    }

    function _requireCode(string memory name, address value) internal view returns (address checked) {
        if (value == address(0)) revert MissingAddress(name);
        if (value.code.length == 0) revert NotDeployed(name, value);
        checked = value;
    }

    /// @dev The account a broadcast sends from, whichever way the script was invoked (`--private-key`,
    /// `--account`, `--ledger`, or a plain simulation). Must be read inside `startBroadcast`.
    function _broadcaster() internal returns (address account) {
        (, account,) = vm.readCallers();
    }

    function _report(string memory label, address value) internal pure {
        console.log(label, value);
    }

    function _heading(string memory title) internal pure {
        console.log("");
        console.log(title);
    }
}
