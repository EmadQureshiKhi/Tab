// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

/// @title DeploymentBase
/// @notice Chain guards, shared identifiers, and reporting helpers used by the seven numbered
/// deployment scripts in this directory.
/// @dev Every script here is split into two halves, deliberately.
///
///  - `run()` reads the environment, opens the broadcast, and calls the second half. It is the only
///    place a transaction is produced and the only place an environment variable is read.
///  - A parameterised entrypoint takes every input explicitly and returns what it produced. It opens
///    no broadcast and reads no environment, so `test/DeploymentScripts.t.sol` can drive the whole
///    sequence against a fresh in-memory tree with no key, no endpoint, and no configuration.
///
/// That split is what makes the deployment checkable rather than merely runnable. A deployment is
/// normally executed once, so without it the ordering, the wiring, and the registration calls would
/// be the only sequence in the system that nothing ever exercises before it matters.
///
/// Environment variable names are literals at every read site rather than shared constants, because
/// `scripts/env-check.mjs` resolves a name only from a literal or from a `string constant` declared in
/// the same file. Literals keep every read visible to that gate.
///
/// Requirements: 26.1, 26.2, 26.5, 11.6
abstract contract DeploymentBase is Script {
    // ------------------------------------------------------------------ attested chains

    /// @notice Attested-chain identifier of Ethereum Sepolia.
    uint64 internal constant CHAIN_KEY_SEPOLIA = 1;

    /// @notice Attested-chain identifier of Ethereum Mainnet.
    uint64 internal constant CHAIN_KEY_MAINNET = 3;

    // ------------------------------------------------------------------ chain ids

    /// @notice EVM chain id of Creditcoin CC3 Testnet, the deployment target. (R26.1)
    uint256 internal constant CREDITCOIN_TESTNET_CHAIN_ID = 102031;

    /// @notice EVM chain id of Creditcoin Mainnet.
    /// @dev Named so a script can tell the two apart and refuse the wrong one out loud, rather than
    /// leaving a one-digit endpoint mistake to be discovered from a block explorer afterwards.
    uint256 internal constant CREDITCOIN_MAINNET_CHAIN_ID = 102030;

    /// @notice EVM chain id of Ethereum Sepolia, where `TabSettlement` is the only deployment. (D16.2)
    uint256 internal constant ETHEREUM_SEPOLIA_CHAIN_ID = 11155111;

    // ------------------------------------------------------------------ the Proof Service

    /// @notice Identifier of the Proof Service, the metered Service Tab sells over its own rail.
    /// @dev A readable short string rather than a hash, so the identifier a block explorer shows is
    /// the identifier a reader can check by eye.
    bytes32 internal constant PROOF_SERVICE_ID = bytes32("tab.proof-service");

    /// @notice Named tool the Proof Service meters.
    bytes32 internal constant PROOF_SERVICE_TOOL = bytes32("proof.generate");

    // ------------------------------------------------------------------ types

    /// @notice The four Creditcoin contracts deployed before the verifier exists.
    /// @dev Grouped so that steps 2, 3, 4, 5, and 7 pass one value between them instead of four
    /// positional addresses that are all the same type and therefore all mistakable for each other.
    struct CoreAddresses {
        /// @dev `ServiceRegistry`, deployed first because `TabBook` takes it in its constructor.
        address serviceRegistry;
        /// @dev `AgentRegistry`.
        address agentRegistry;
        /// @dev `Bond`, deployed before `TabBook`, which takes it in its constructor.
        address bond;
        /// @dev `TabBook`.
        address tabBook;
    }

    // ------------------------------------------------------------------ errors

    /// @notice The endpoint answered with a chain id the script does not deploy to.
    /// @param expected Chain id the script requires.
    /// @param actual Chain id the endpoint reported.
    error WrongChain(uint256 expected, uint256 actual);

    /// @notice A required address was configured as the zero address.
    /// @param name Environment variable the address was read from.
    error MissingAddress(string name);

    /// @notice A configured address holds no code, so the contract it names is not deployed.
    /// @param name Environment variable the address was read from.
    /// @param at The address that holds no code.
    error NotDeployed(string name, address at);

    /// @notice Two configured addresses that must differ are the same address.
    /// @param first Name of the first variable.
    /// @param second Name of the second variable.
    /// @param shared The address both name.
    error AddressCollision(string first, string second, address shared);

    // ------------------------------------------------------------------ guards

    /// @notice Refuses to continue unless the endpoint is the Creditcoin chain the environment names.
    /// @dev Read from `CREDITCOIN_CHAIN_ID` rather than pinned to a constant, so the same scripts
    /// serve Mainnet the day that is wanted, while still refusing a mismatch between the configured
    /// chain and the endpoint actually connected. (R26.1)
    /// @param configured Chain id read from the environment.
    function _requireCreditcoinChain(uint256 configured) internal view {
        if (block.chainid != configured) revert WrongChain(configured, block.chainid);
    }

    /// @notice Refuses to continue unless the endpoint reports exactly this chain id.
    /// @param expected Chain id the script requires.
    function _requireChain(uint256 expected) internal view {
        if (block.chainid != expected) revert WrongChain(expected, block.chainid);
    }

    /// @notice Passes a non-zero address through, and names the variable when it is zero.
    /// @param name Environment variable the address came from.
    /// @param value The address read.
    /// @return checked The same address.
    function _requireAddress(string memory name, address value) internal pure returns (address checked) {
        if (value == address(0)) revert MissingAddress(name);
        checked = value;
    }

    /// @notice Passes an address through only when it holds code.
    /// @dev Used by the read-back script, where a zero-code address is the difference between "the
    /// deployment record is stale" and "the contract answers".
    /// @param name Environment variable the address came from.
    /// @param value The address read.
    /// @return checked The same address.
    function _requireCode(string memory name, address value) internal view returns (address checked) {
        if (value == address(0)) revert MissingAddress(name);
        if (value.code.length == 0) revert NotDeployed(name, value);
        checked = value;
    }

    /// @notice Refuses two addresses that must differ but do not.
    /// @param firstName Name of the first variable.
    /// @param first The first address.
    /// @param secondName Name of the second variable.
    /// @param second The second address.
    function _requireDistinct(
        string memory firstName,
        address first,
        string memory secondName,
        address second
    ) internal pure {
        if (first == second) revert AddressCollision(firstName, secondName, first);
    }

    // ------------------------------------------------------------------ reporting

    /// @notice Prints one labelled address.
    /// @param label Human-readable name.
    /// @param value Address to print.
    function _report(string memory label, address value) internal pure {
        console.log(label, value);
    }

    /// @notice Prints a section heading.
    /// @param title Heading text.
    function _heading(string memory title) internal pure {
        console.log("");
        console.log(title);
    }
}
