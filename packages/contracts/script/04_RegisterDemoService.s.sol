// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeploymentBase} from "./DeploymentBase.sol";
import {Bond} from "../src/Bond.sol";
import {IServiceRegistry, ServiceRegistry} from "../src/ServiceRegistry.sol";
import {MockUsdc} from "../src/test/MockUsdc.sol";
import {console} from "forge-std/console.sol";

/// @title RegisterDemoService
/// @notice Registers the demo Service the gateway meters for and posts its Bond, once.
///
/// Reads from the environment:
///  - `MONAD_CHAIN_ID`              the chain this run is allowed to touch
///  - `SERVICE_REGISTRY_ADDRESS`    Tab's registry on that chain
///  - `BOND_ADDRESS`                Tab's Bond escrow on that chain
///  - `USDC_ADDRESS`                optional; the canonical USDC, accepted as a settlement Asset if set
///  - `MOCK_USDC_ADDRESS`           optional; the test token, accepted as an Asset and used for the Bond
///  - `GATEWAY_SERVICE_ID`          the Service id, default `bytes32("tab.demo")`
///  - `GATEWAY_TOOL`                the one priced tool, default `quote.generate`
///  - `GATEWAY_PRICE_BASE_UNITS`    its price in every Asset, default 10000
///  - `DEFAULT_SETTLEMENT_WINDOW_S` the Settlement Window, default 21600
///
/// The broadcasting account becomes the Service's operator, its bond account, and the Collection
/// address for every Asset. Registration is skipped when the Service already exists, and the Bond
/// deposit when the operator already holds free stake in the test token, so the script can be run
/// again after a partial failure without changing anything it already did.
///
///   forge script script/04_RegisterDemoService.s.sol:RegisterDemoService --rpc-url monad_testnet --broadcast
contract RegisterDemoService is DeploymentBase {
    /// @notice Stake posted in the test token, in base units: 50 MockUsdc.
    uint128 public constant DEMO_BOND_BASE_UNITS = 50_000_000;

    /// @notice What one run did.
    struct Outcome {
        bytes32 serviceId;
        address operator;
        address[] assets;
        bool registered;
        bool bonded;
    }

    error NoAssetConfigured();
    error ToolNameTooLong(string tool);

    function run() external returns (Outcome memory outcome) {
        _requireMonadChain();
        ServiceRegistry registry = ServiceRegistry(
            _requireCode("SERVICE_REGISTRY_ADDRESS", vm.envAddress("SERVICE_REGISTRY_ADDRESS"))
        );
        Bond bond = Bond(_requireCode("BOND_ADDRESS", vm.envAddress("BOND_ADDRESS")));
        address usdc = vm.envOr("USDC_ADDRESS", address(0));
        address mockUsdc = vm.envOr("MOCK_USDC_ADDRESS", address(0));
        bytes32 serviceId = vm.envOr("GATEWAY_SERVICE_ID", bytes32("tab.demo"));
        bytes32 tool = _toolId(vm.envOr("GATEWAY_TOOL", string("quote.generate")));
        uint256 price = vm.envOr("GATEWAY_PRICE_BASE_UNITS", uint256(10_000));
        uint256 window = vm.envOr("DEFAULT_SETTLEMENT_WINDOW_S", uint256(21_600));
        address[] memory assets = _assets(usdc, mockUsdc);

        vm.startBroadcast();
        address operator = _broadcaster();
        // casting to 'uint32' is safe because the registry refuses any window above 24 hours anyway.
        // forge-lint: disable-next-line(unsafe-typecast)
        bool registered = register(registry, serviceId, assets, operator, tool, price, uint32(window));
        bool bonded = mockUsdc == address(0) ? false : fund(bond, MockUsdc(mockUsdc), operator);
        vm.stopBroadcast();

        outcome = Outcome({
            serviceId: serviceId, operator: operator, assets: assets, registered: registered, bonded: bonded
        });
        _heading("Demo Service");
        console.log("chainId          ", block.chainid);
        console.log("serviceId        ", vm.toString(serviceId));
        _report("operator         ", operator);
        for (uint256 i = 0; i < assets.length; ++i) {
            _report("asset            ", assets[i]);
        }
        console.log("tool             ", vm.toString(tool));
        console.log("price (base units)", price);
        console.log("settlementWindow ", window);
        string memory registryVerdict = "already, kept as is";
        if (registered) registryVerdict = "by this run";
        console.log("registered       ", registryVerdict);
        string memory bondVerdict = "already, kept as is";
        if (bonded) bondVerdict = "by this run";
        if (mockUsdc == address(0)) bondVerdict = "skipped, no test token";
        console.log("bonded           ", bondVerdict);
    }

    /// @notice Register unless the Service exists. Public so tests can exercise the exact code the run
    /// executed.
    /// @return registered True when this run registered it.
    function register(
        ServiceRegistry registry,
        bytes32 serviceId,
        address[] memory assets,
        address collection,
        bytes32 tool,
        uint256 price,
        uint32 window
    ) public returns (bool registered) {
        if (_exists(registry, serviceId)) return false;
        address[] memory collections = new address[](assets.length);
        uint256[] memory prices = new uint256[](assets.length);
        for (uint256 i = 0; i < assets.length; ++i) {
            collections[i] = collection;
            prices[i] = price;
        }
        bytes32[] memory tools = new bytes32[](1);
        tools[0] = tool;
        registry.registerService(serviceId, assets, collections, tools, prices, window);
        registered = true;
    }

    /// @notice Mint the test token to the operator and stake it, unless the operator is already bonded
    /// in it.
    /// @return bonded True when this run posted the Bond.
    function fund(Bond bond, MockUsdc token, address operator) public returns (bool bonded) {
        if (bond.freeOf(bond.partyOf(operator), address(token)) > 0) return false;
        token.mint(operator, DEMO_BOND_BASE_UNITS);
        token.approve(address(bond), DEMO_BOND_BASE_UNITS);
        bond.deposit(address(token), DEMO_BOND_BASE_UNITS);
        bonded = true;
    }

    function _exists(ServiceRegistry registry, bytes32 serviceId) internal view returns (bool exists) {
        try registry.serviceOf(serviceId) returns (IServiceRegistry.Service memory) {
            exists = true;
        } catch {
            exists = false;
        }
    }

    /// @dev The canonical USDC first, then the test token; each only when configured.
    function _assets(address usdc, address mockUsdc) internal view returns (address[] memory assets) {
        uint256 n = (usdc == address(0) ? 0 : 1) + (mockUsdc == address(0) ? 0 : 1);
        if (n == 0) revert NoAssetConfigured();
        assets = new address[](n);
        uint256 i;
        if (usdc != address(0)) assets[i++] = _requireCode("USDC_ADDRESS", usdc);
        if (mockUsdc != address(0)) assets[i++] = _requireCode("MOCK_USDC_ADDRESS", mockUsdc);
    }

    /// @dev A tool name is its bytes, left aligned in a word, exactly as `bytes32("quote.generate")`.
    function _toolId(string memory tool) internal pure returns (bytes32 id) {
        if (bytes(tool).length == 0 || bytes(tool).length > 32) revert ToolNameTooLong(tool);
        id = bytes32(bytes(tool));
    }
}
