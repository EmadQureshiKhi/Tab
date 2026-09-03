// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeploymentBase} from "./DeploymentBase.sol";
import {CurationMultisig} from "../src/CurationMultisig.sol";
import {console} from "forge-std/console.sol";

/// @title DeployCuration
/// @notice Deploys the `CurationMultisig` that holds the curation role on a deployment that wants one.
///
/// This runs **before** `01_Deploy`, because `ServiceRegistry` takes the curation authority as a
/// constructor argument and exposes no setter: the authority cannot be moved afterwards, so it has
/// to exist first. Its address then goes into `CURATION_AUTHORITY_ADDRESS` for that run.
///
/// The role it holds is narrow on purpose. It moves a Service into the Curated tier and does
/// nothing else: it cannot meter, cannot touch a tab, cannot apply a Settlement, cannot move a
/// Bond, and cannot reach an Agent's funds. Every change it makes is queued and held 48 hours in
/// public before it can apply. And the multisig itself holds no value: it has no `receive`, no
/// `payable` function, and an immutable owner set.
///
/// Reads from the environment:
///  - `MONAD_CHAIN_ID`             the chain this run is allowed to touch
///  - `CURATION_OWNER_1_ADDRESS`   the first owner; the others are optional and appended in order
///  - `CURATION_OWNER_2_ADDRESS`   optional
///  - `CURATION_OWNER_3_ADDRESS`   optional
///  - `CURATION_THRESHOLD`         how many must approve, default 2
///
///   forge script script/00_DeployCuration.s.sol:DeployCuration --rpc-url monad_mainnet --broadcast
contract DeployCuration is DeploymentBase {
    error NoOwnerConfigured();
    error ThresholdAboveOwners(uint8 threshold, uint256 owners);

    function run() external returns (address multisig, address[] memory owners, uint8 threshold) {
        _requireMonadChain();
        owners = _owners();
        if (owners.length == 0) revert NoOwnerConfigured();
        threshold = uint8(vm.envOr("CURATION_THRESHOLD", uint256(2)));
        if (threshold == 0 || threshold > owners.length) {
            revert ThresholdAboveOwners(threshold, owners.length);
        }

        vm.startBroadcast();
        multisig = deploy(owners, threshold);
        vm.stopBroadcast();

        _heading("Curation multisig");
        console.log("chainId          ", block.chainid);
        _report("multisig             ", multisig);
        for (uint256 i = 0; i < owners.length; ++i) {
            _report("owner                ", owners[i]);
        }
        console.log("threshold        ", threshold);
        console.log("Set CURATION_AUTHORITY_ADDRESS to the multisig before running 01_Deploy.");
    }

    /// @notice Deploys the multisig over an explicit owner set.
    /// @dev Split from `run` so a test drives it without the environment; the constructor is what
    /// validates the threshold against the owners, and this only refuses earlier and by name.
    function deploy(address[] memory owners, uint8 threshold) public returns (address multisig) {
        multisig = address(new CurationMultisig(owners, threshold));
    }

    /// @dev The configured owners, in order, stopping at the first that is not set.
    function _owners() internal view returns (address[] memory owners) {
        address first = vm.envOr("CURATION_OWNER_1_ADDRESS", address(0));
        address second = vm.envOr("CURATION_OWNER_2_ADDRESS", address(0));
        address third = vm.envOr("CURATION_OWNER_3_ADDRESS", address(0));
        uint256 count = first == address(0) ? 0 : second == address(0) ? 1 : third == address(0) ? 2 : 3;
        owners = new address[](count);
        if (count > 0) owners[0] = first;
        if (count > 1) owners[1] = second;
        if (count > 2) owners[2] = third;
    }
}
