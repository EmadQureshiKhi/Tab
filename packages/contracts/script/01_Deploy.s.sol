// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeploymentBase} from "./DeploymentBase.sol";
import {Bond} from "../src/Bond.sol";
import {ServiceRegistry} from "../src/ServiceRegistry.sol";
import {TabBook} from "../src/TabBook.sol";
import {TabSettlement} from "../src/TabSettlement.sol";
import {MockUsdc} from "../src/test/MockUsdc.sol";
import {console} from "forge-std/console.sol";

/// @title Deploy
/// @notice Deploys and wires every Tab contract on Monad in one broadcast.
///
/// Reads from the environment:
///  - `MONAD_CHAIN_ID`             the chain this run is allowed to touch (143 mainnet, 10143 testnet)
///  - `CURATION_AUTHORITY_ADDRESS` the account (ideally a `CurationMultisig`) that moves Services to the
///                                 Curated Tier
///  - `CREDIT_BASELINE_BASE_UNITS` credit extended with no history, in Asset base units
///  - `GROWTH_FACTOR_BPS`          per-counterparty growth factor, in basis points
///  - `PERMIT2_ADDRESS`            the canonical Permit2 on this chain; must already hold code
///  - `DEPLOY_MOCK_USDC`           optional; `true` deploys a mintable six-decimal test token for demos
///
/// The broadcasting account becomes the one-shot wiring authority and spends that authority inside
/// this run, so after it returns there is nothing left for the key to do.
///
///   forge script script/01_Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast
contract Deploy is DeploymentBase {
    function run() external returns (Deployment memory deployed, address mockUsdc) {
        _requireMonadChain();
        address curationAuthority =
            _requireAddress("CURATION_AUTHORITY_ADDRESS", vm.envAddress("CURATION_AUTHORITY_ADDRESS"));
        uint256 baseline = vm.envUint("CREDIT_BASELINE_BASE_UNITS");
        uint256 growthFactorBps = vm.envUint("GROWTH_FACTOR_BPS");
        address permit2 = _requireCode("PERMIT2_ADDRESS", vm.envAddress("PERMIT2_ADDRESS"));
        bool withMock = vm.envOr("DEPLOY_MOCK_USDC", false);

        vm.startBroadcast();
        // The wiring authority must be the account the broadcast sends from, because it is that
        // account which calls `setSettlementSurface` a moment later.
        address broadcaster = _broadcaster();
        deployed = deploy(broadcaster, curationAuthority, baseline, growthFactorBps, permit2);
        if (withMock) mockUsdc = address(new MockUsdc());
        vm.stopBroadcast();

        _heading("Tab on Monad");
        console.log("chainId              ", block.chainid);
        _report("ServiceRegistry      ", deployed.serviceRegistry);
        _report("Bond                 ", deployed.bond);
        _report("TabBook              ", deployed.tabBook);
        _report("TabSettlement        ", deployed.tabSettlement);
        _report("Permit2              ", deployed.permit2);
        _report("curationAuthority    ", curationAuthority);
        console.log("baseline (base units)", baseline);
        console.log("growthFactorBps      ", growthFactorBps);
        if (withMock) _report("MockUsdc             ", mockUsdc);
    }

    /// @notice Deploy and wire. Public so tests can exercise the exact code the deployment ran.
    function deploy(
        address wiringAuthority,
        address curationAuthority,
        uint256 baseline,
        uint256 growthFactorBps,
        address permit2
    ) public returns (Deployment memory deployed) {
        ServiceRegistry registry = new ServiceRegistry(curationAuthority);
        Bond bond = new Bond();
        TabBook book =
            new TabBook(wiringAuthority, address(registry), address(bond), baseline, growthFactorBps);
        TabSettlement settlement = new TabSettlement(address(registry), address(book), permit2);
        book.setSettlementSurface(address(settlement));
        deployed = Deployment({
            serviceRegistry: address(registry),
            bond: address(bond),
            tabBook: address(book),
            tabSettlement: address(settlement),
            permit2: permit2
        });
    }
}
