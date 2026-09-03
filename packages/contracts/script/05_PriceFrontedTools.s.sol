// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeploymentBase} from "./DeploymentBase.sol";
import {IServiceRegistry, ServiceRegistry} from "../src/ServiceRegistry.sol";
import {console} from "forge-std/console.sol";

/// @title PriceFrontedTools
/// @notice Publishes a price for the tools a Service fronts an x402 upstream under.
///
/// A fronted call's price is not known until the upstream answers: the API Hub charges per
/// request and the Service adds a margin. `TabBook.recordDelivery` refuses any unit price the
/// applied price list does not hold, so the varying amount cannot ride in the price. It rides in
/// the **unit count** instead: the Service publishes one base unit per unit, and a call consumes
/// as many units as it cost. Without that published price every fronted delivery reverts
/// `UnknownTool`, the metering plugin delivers the response anyway because a broken price list is
/// the Service's fault and not the caller's, and the Service pays the upstream for work it bills
/// nobody.
///
/// Prices after registration are timelocked, so this is two runs 48 hours apart: `queue` now and
/// `apply` once the hold has passed. Both are idempotent: a tool already priced at the intended
/// figure is skipped.
///
/// **The change ids this prints are the simulation's, not the broadcast's.** `queueChange` folds
/// `block.timestamp` and a nonce into the id, and a `forge script` run simulates before it
/// broadcasts, so the two differ every time. The ids that can actually be applied are the ones the
/// `RegistryChangeQueued` events carry, which the broadcast receipt holds:
///
///   jq -r '.receipts[].logs[] | select(.topics | length == 3) | .topics[1]' \
///     broadcast/05_PriceFrontedTools.s.sol/<chainId>/run-latest.json
///
/// Take them from there, and never from this script's output or its return value.
///
/// Reads from the environment:
///  - `MONAD_CHAIN_ID`            the chain this run is allowed to touch
///  - `SERVICE_REGISTRY_ADDRESS`  Tab's registry on that chain
///  - `GATEWAY_SERVICE_ID`        the Service, default `bytes32("tab.demo")`
///  - `USDC_ADDRESS`              optional; priced when set
///  - `MOCK_USDC_ADDRESS`         optional; priced when set
///  - `GATEWAY_HUB_TOOLS`         comma-separated tool names, default `apihub.run,nansen.query`
///  - `GATEWAY_HUB_UNIT_BASE_UNITS` the published unit price, default 1
///
///   forge script script/05_PriceFrontedTools.s.sol:PriceFrontedTools --rpc-url monad_testnet --broadcast
///   forge script script/05_PriceFrontedTools.s.sol:PriceFrontedTools --sig "applyQueued(bytes32[])" "[0x…]" --rpc-url monad_testnet --broadcast
contract PriceFrontedTools is DeploymentBase {
    /// @notice What one queue run did.
    struct Queued {
        bytes32 serviceId;
        bytes32[] changeIds;
        uint64 eta;
        uint256 alreadyPriced;
    }

    function run() external returns (Queued memory queued) {
        _requireMonadChain();
        ServiceRegistry registry = ServiceRegistry(
            _requireCode("SERVICE_REGISTRY_ADDRESS", vm.envAddress("SERVICE_REGISTRY_ADDRESS"))
        );
        bytes32 serviceId = vm.envOr("GATEWAY_SERVICE_ID", bytes32("tab.demo"));
        uint256 unit = vm.envOr("GATEWAY_HUB_UNIT_BASE_UNITS", uint256(1));

        address[] memory assets = _assets();
        bytes32[] memory tools = _tools();

        vm.startBroadcast();
        queued = queue(registry, serviceId, assets, tools, unit);
        vm.stopBroadcast();

        console.log("chain", block.chainid);
        console.log("service");
        console.logBytes32(queued.serviceId);
        console.log("already priced", queued.alreadyPriced);
        console.log("queued", queued.changeIds.length);
        if (queued.changeIds.length > 0) {
            console.log("apply after", queued.eta);
            console.log("The ids below are this simulation's and will NOT be the broadcast's.");
            console.log("Read the real ones from the RegistryChangeQueued events in the receipt:");
            console.log("  jq -r '.receipts[].logs[] | select(.topics|length==3) | .topics[1]' \\");
            console.log("    broadcast/05_PriceFrontedTools.s.sol/<chainId>/run-latest.json");
            for (uint256 i = 0; i < queued.changeIds.length; ++i) {
                console.logBytes32(queued.changeIds[i]);
            }
        }
    }

    /// @notice Queues one Price change per (asset, tool) pair that is not already at `unit`.
    /// @return queued The change ids to apply once the timelock has passed, and how many were skipped.
    function queue(
        ServiceRegistry registry,
        bytes32 serviceId,
        address[] memory assets,
        bytes32[] memory tools,
        uint256 unit
    ) public returns (Queued memory queued) {
        bytes32[] memory ids = new bytes32[](assets.length * tools.length);
        uint256 count;
        uint256 skipped;
        uint64 eta;
        for (uint256 a = 0; a < assets.length; ++a) {
            for (uint256 t = 0; t < tools.length; ++t) {
                // `priceOf` reverts `UnknownTool` for a tool with no price rather
                // than answering zero, so the read is a try: a revert means this
                // pair has never been priced, which is exactly the case to queue.
                if (_pricedAt(registry, serviceId, assets[a], tools[t], unit)) {
                    skipped += 1;
                    continue;
                }
                (bytes32 changeId, uint64 at) = registry.queueChange(
                    serviceId, IServiceRegistry.ChangeKind.Price, abi.encode(assets[a], tools[t], unit)
                );
                ids[count] = changeId;
                count += 1;
                eta = at;
            }
        }
        bytes32[] memory trimmed = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            trimmed[i] = ids[i];
        }
        queued = Queued({serviceId: serviceId, changeIds: trimmed, eta: eta, alreadyPriced: skipped});
    }

    /// @notice Applies changes the queue run printed, once their hold has passed.
    function applyQueued(bytes32[] calldata changeIds) external returns (uint256 applied) {
        _requireMonadChain();
        ServiceRegistry registry = ServiceRegistry(
            _requireCode("SERVICE_REGISTRY_ADDRESS", vm.envAddress("SERVICE_REGISTRY_ADDRESS"))
        );
        vm.startBroadcast();
        applied = applyAll(registry, changeIds);
        vm.stopBroadcast();
        console.log("applied", applied);
    }

    /// @notice Applies each change that is due, taking its inputs explicitly.
    /// @dev Each is applied on its own so one that is not yet due, or was cancelled, does not stop
    /// the rest; `applied` counts the ones that landed.
    function applyAll(ServiceRegistry registry, bytes32[] memory changeIds) public returns (uint256 applied) {
        for (uint256 i = 0; i < changeIds.length; ++i) {
            try registry.applyChange(changeIds[i]) {
                applied += 1;
                console.log("applied");
                console.logBytes32(changeIds[i]);
            } catch {
                console.log("not applied yet");
                console.logBytes32(changeIds[i]);
            }
        }
    }

    /// @dev Whether the pair already carries exactly this price.
    function _pricedAt(ServiceRegistry registry, bytes32 serviceId, address asset, bytes32 tool, uint256 unit)
        internal
        view
        returns (bool priced)
    {
        try registry.priceOf(serviceId, asset, tool) returns (uint256 applied) {
            priced = applied == unit;
        } catch {
            priced = false;
        }
    }

    /// @dev The canonical USDC and the test token, each only when configured.
    function _assets() internal view returns (address[] memory assets) {
        address usdc = vm.envOr("USDC_ADDRESS", address(0));
        address mockUsdc = vm.envOr("MOCK_USDC_ADDRESS", address(0));
        uint256 count = (usdc == address(0) ? 0 : 1) + (mockUsdc == address(0) ? 0 : 1);
        assets = new address[](count);
        uint256 i;
        if (usdc != address(0)) {
            assets[i] = usdc;
            i += 1;
        }
        if (mockUsdc != address(0)) assets[i] = mockUsdc;
    }

    /// @dev The fronted tool names, packed to the 32-byte keys the price list is held by.
    function _tools() internal view returns (bytes32[] memory tools) {
        string[] memory names = vm.envOr("GATEWAY_HUB_TOOLS", ",", _defaultTools());
        tools = new bytes32[](names.length);
        for (uint256 i = 0; i < names.length; ++i) {
            tools[i] = bytes32(bytes(names[i]));
        }
    }

    function _defaultTools() internal pure returns (string[] memory names) {
        names = new string[](2);
        names[0] = "apihub.run";
        names[1] = "nansen.query";
    }
}
