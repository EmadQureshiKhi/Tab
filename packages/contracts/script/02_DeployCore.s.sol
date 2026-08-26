// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeploymentBase} from "./DeploymentBase.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Bond} from "../src/Bond.sol";
import {ServiceRegistry} from "../src/ServiceRegistry.sol";
import {TabBook} from "../src/TabBook.sol";
import {console} from "forge-std/console.sol";

/// @title DeployCore
/// @notice Step 2. Deploys `ServiceRegistry`, `AgentRegistry`, `Bond`, and `TabBook`, in that order.
/// @dev The order is forced by the constructors rather than chosen. `TabBook` takes the registry and
/// the Bond as constructor immutables, so both have to exist first; `AgentRegistry` and `Bond` take
/// only a wiring authority, so they can go anywhere before `TabBook`. Nothing here takes the
/// `SettlementVerifier`, because the verifier takes all four of these and cannot exist yet. That
/// direction is closed by step 4's one-shot wiring.
///
/// `curationAuthority` is a constructor argument of `ServiceRegistry`, not a setter. Curation gates
/// Credit Limit weight and only that, and every later change to a tier, a price, a Collection Address,
/// an accepted Asset, or a Settlement Window goes through the registry's own 48-hour hold instead of
/// through this script. So there is exactly one moment at which the authority is chosen, it is this
/// one, and it is visible in the deployment transaction. (R11.6)
///
/// The wiring authority is the broadcasting account, taken from `msg.sender` rather than from the
/// environment. It has to be the same account that runs step 4, because `AgentRegistry`, `Bond`, and
/// `TabBook` each gate their one-shot setters on it, and taking it from the account already signing
/// removes the way that can be got wrong. Read it back in step 7 to confirm what it is.
///
/// Run, from `packages/contracts`:
///
/// ```
/// forge script script/02_DeployCore.s.sol:DeployCore --rpc-url creditcoin --sig "run()"
/// ```
///
/// Requirements: 26.1, 26.2, 11.6
contract DeployCore is DeploymentBase {
    /// @notice Deploys the four core contracts against the configured Creditcoin chain.
    /// @return core Addresses of the four deployed contracts.
    function run() external returns (CoreAddresses memory core) {
        _requireCreditcoinChain(vm.envUint("CREDITCOIN_CHAIN_ID"));

        address curationAuthority =
            _requireAddress("CURATION_AUTHORITY_ADDRESS", vm.envAddress("CURATION_AUTHORITY_ADDRESS"));
        uint256 baseline = vm.envUint("CREDIT_BASELINE_BASE_UNITS");
        uint256 growthFactorBps = vm.envUint("GROWTH_FACTOR_BPS");

        // The account Foundry is signing with. Every one-shot setter in step 4 is gated on it.
        address wiringAuthority = msg.sender;

        vm.startBroadcast();
        core = deployCore(wiringAuthority, curationAuthority, baseline, growthFactorBps);
        vm.stopBroadcast();

        _heading("Step 2 of 7 - core contracts");
        _report("ServiceRegistry", core.serviceRegistry);
        _report("AgentRegistry  ", core.agentRegistry);
        _report("Bond           ", core.bond);
        _report("TabBook        ", core.tabBook);
        _report("wiringAuthority", wiringAuthority);
        _report("curationAuthority", curationAuthority);
        console.log("baseline (base units)", baseline);
        console.log("growthFactorBps      ", growthFactorBps);
    }

    /// @notice Deploys the four core contracts in constructor-forced order.
    /// @dev Reads no environment and opens no broadcast, so the test suite runs the identical sequence.
    /// @param wiringAuthority Account permitted to call each one-shot setter, exactly once.
    /// @param curationAuthority Account permitted to queue a promotion into the Curated Tier.
    /// @param baseline Credit granted before any history exists, in Asset base units.
    /// @param growthFactorBps Share of weighted history converted into growth, in basis points.
    /// @return core Addresses of the four deployed contracts.
    function deployCore(
        address wiringAuthority,
        address curationAuthority,
        uint256 baseline,
        uint256 growthFactorBps
    ) public returns (CoreAddresses memory core) {
        ServiceRegistry registry = new ServiceRegistry(curationAuthority);
        AgentRegistry agents = new AgentRegistry(wiringAuthority);
        Bond bond = new Bond(wiringAuthority);
        TabBook book =
            new TabBook(wiringAuthority, address(registry), address(bond), baseline, growthFactorBps);

        core = CoreAddresses({
            serviceRegistry: address(registry),
            agentRegistry: address(agents),
            bond: address(bond),
            tabBook: address(book)
        });
    }
}
