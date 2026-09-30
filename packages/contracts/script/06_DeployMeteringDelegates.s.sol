// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeploymentBase} from "./DeploymentBase.sol";
import {MeteringDelegates} from "../src/MeteringDelegates.sol";
import {console} from "forge-std/console.sol";

/// @title DeployMeteringDelegates
/// @notice Deploys the `MeteringDelegates` registry on a network that already runs Tab.
///
/// It stands apart from `01_Deploy` because nothing is wired to it: no Tab contract reads it and it
/// reads none, so adding it changes no deployed bytecode and needs no fresh deployment of the rest.
/// Metering gateways read it off chain, through `METERING_DELEGATES_ADDRESS`, to decide whether a
/// session key's signature on a metering claim counts for the Agent that named it.
///
/// It takes no constructor argument and grants its deployer nothing, so the broadcasting account is
/// reported and never retained.
///
/// Reads from the environment:
///  - `MONAD_CHAIN_ID`              the chain this run is allowed to touch
///  - `METERING_DELEGATES_ADDRESS`  optional; when it names a deployed registry, that one is checked
///                                  and kept and nothing is deployed, so running this twice deploys once
///
///   forge script script/06_DeployMeteringDelegates.s.sol:DeployMeteringDelegates --rpc-url monad_testnet --broadcast
contract DeployMeteringDelegates is DeploymentBase {
    string constant ADDRESS_KEY = "METERING_DELEGATES_ADDRESS";

    error NotMeteringDelegates(address at);

    function run() external returns (address meteringDelegates, bool deployed) {
        _requireMonadChain();
        address recorded = _recorded();
        address broadcaster;
        if (recorded != address(0)) {
            meteringDelegates = check(_requireCode(ADDRESS_KEY, recorded));
        } else {
            vm.startBroadcast();
            broadcaster = _broadcaster();
            meteringDelegates = deploy();
            vm.stopBroadcast();
            deployed = true;
        }

        _heading("Metering delegates");
        console.log("chainId              ", block.chainid);
        _report("MeteringDelegates    ", meteringDelegates);
        if (deployed) _report("deployer             ", broadcaster);
        console.log(deployed ? "deployed by this run" : "already deployed; nothing sent");
        if (deployed) {
            console.log("Record it under contracts.MeteringDelegates with envKey METERING_DELEGATES_ADDRESS.");
        }
    }

    /// @notice Deploys the registry. Public so a test exercises the exact code the deployment ran.
    function deploy() public returns (address meteringDelegates) {
        meteringDelegates = address(new MeteringDelegates());
    }

    /// @notice Confirms `at` answers as a `MeteringDelegates` with the bound this source declares.
    /// @dev A recorded address that holds some other contract would otherwise be kept silently, and every
    /// gateway pointed at it would refuse every delegate signature with a read error.
    function check(address at) public view returns (address checked) {
        try MeteringDelegates(at).MAX_DELEGATION() returns (uint64 bound) {
            if (bound != 365 days) revert NotMeteringDelegates(at);
        } catch {
            revert NotMeteringDelegates(at);
        }
        checked = at;
    }

    /// @dev The recorded address, or zero when the variable is unset, empty, or the template's placeholder.
    function _recorded() internal view returns (address recorded) {
        string memory raw = vm.envOr(ADDRESS_KEY, string(""));
        if (bytes(raw).length == 0) return address(0);
        recorded = vm.parseAddress(raw);
    }
}
