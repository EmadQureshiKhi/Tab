// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {IServiceRegistry, ServiceRegistry} from "../src/ServiceRegistry.sol";

contract ServiceRegistryTimelockTest is Test {
    ServiceRegistry internal registry;

    address internal curationAuthority = makeAddr("curationAuthority");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");
    address internal usdc = makeAddr("usdc");
    address internal dai = makeAddr("dai");
    address internal collection = makeAddr("collection");
    address internal collectionNext = makeAddr("collectionNext");
    address internal collectionDai = makeAddr("collectionDai");

    bytes32 internal constant SERVICE = keccak256("demo-service");
    bytes32 internal constant TOOL = keccak256("quote.generate");
    uint256 internal constant PRICE_APPLIED = 10_000;
    uint256 internal constant PRICE_QUEUED = 25_000;
    uint32 internal constant WINDOW_APPLIED = 1 hours;
    uint32 internal constant WINDOW_QUEUED = 4 hours;

    function setUp() public {
        registry = new ServiceRegistry(curationAuthority);
        address[] memory assets = new address[](1);
        assets[0] = usdc;
        address[] memory collections = new address[](1);
        collections[0] = collection;
        bytes32[] memory tools = new bytes32[](1);
        tools[0] = TOOL;
        uint256[] memory prices = new uint256[](1);
        prices[0] = PRICE_APPLIED;
        vm.prank(operator);
        registry.registerService(SERVICE, assets, collections, tools, prices, WINDOW_APPLIED);
    }

    function test_queueChangeSetsEtaFortyEightHoursOut() public {
        assertEq(registry.timelock(), uint64(48 hours), "published hold");
        (bytes32 changeId, uint64 eta) = _queueWindow(WINDOW_QUEUED);
        assertEq(eta, uint64(block.timestamp) + 48 hours, "eta");
        IServiceRegistry.PendingChange memory pending = registry.pendingChangeOf(changeId);
        assertTrue(pending.open, "open");
        assertEq(pending.serviceId, SERVICE, "serviceId");
        assertEq(uint256(pending.kind), uint256(IServiceRegistry.ChangeKind.SettlementWindow), "kind");
        assertEq(pending.eta, eta, "stored eta");
        assertEq(pending.payload, abi.encode(uint256(WINDOW_QUEUED)), "payload");
    }

    function test_settlementWindowChangeAppliesAtEtaAndNotBefore() public {
        (bytes32 changeId, uint64 eta) = _queueWindow(WINDOW_QUEUED);
        assertEq(registry.settlementWindowOf(SERVICE), WINDOW_APPLIED, "at queue");
        vm.warp(eta - 24 hours);
        assertEq(registry.settlementWindowOf(SERVICE), WINDOW_APPLIED, "mid-hold");
        vm.warp(eta - 1);
        assertEq(registry.settlementWindowOf(SERVICE), WINDOW_APPLIED, "at eta - 1");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.TimelockPending.selector, changeId, eta));
        registry.applyChange(changeId);
        vm.warp(eta);
        assertEq(registry.settlementWindowOf(SERVICE), WINDOW_APPLIED, "at eta, before apply");
        vm.expectEmit(true, true, false, true, address(registry));
        emit IServiceRegistry.RegistryChangeApplied(
            changeId,
            SERVICE,
            IServiceRegistry.ChangeKind.SettlementWindow,
            abi.encode(uint256(WINDOW_QUEUED))
        );
        vm.prank(operator);
        registry.applyChange(changeId);
        assertEq(registry.settlementWindowOf(SERVICE), WINDOW_QUEUED, "after apply");
        assertEq(registry.serviceOf(SERVICE).settlementWindow, WINDOW_QUEUED, "record");
        assertFalse(registry.pendingChangeOf(changeId).open, "queue emptied");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.UnknownChange.selector, changeId));
        registry.applyChange(changeId);
    }

    function test_priceChangeServesPreviousValueThroughoutHold() public {
        bytes memory payload = abi.encode(usdc, TOOL, PRICE_QUEUED);
        vm.prank(operator);
        (bytes32 changeId, uint64 eta) =
            registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Price, payload);
        assertEq(registry.priceOf(SERVICE, usdc, TOOL), PRICE_APPLIED, "at queue");
        vm.warp(eta - 1);
        assertEq(registry.priceOf(SERVICE, usdc, TOOL), PRICE_APPLIED, "at eta - 1");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.TimelockPending.selector, changeId, eta));
        registry.applyChange(changeId);
        vm.warp(eta);
        vm.prank(operator);
        registry.applyChange(changeId);
        assertEq(registry.priceOf(SERVICE, usdc, TOOL), PRICE_QUEUED, "after apply");
    }

    function test_priceChangeForAnUnacceptedAssetIsRefusedAtQueueTime() public {
        vm.prank(operator);
        (bytes32 changeId, uint64 eta) = registry.queueChange(
            SERVICE, IServiceRegistry.ChangeKind.Price, abi.encode(dai, TOOL, PRICE_QUEUED)
        );
        vm.warp(eta);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.AssetNotAccepted.selector, SERVICE, dai));
        registry.applyChange(changeId);
    }

    function test_collectionMoveServesOldAddressThroughoutHold() public {
        bytes memory payload = abi.encode(usdc, collectionNext);
        vm.prank(operator);
        (bytes32 changeId, uint64 eta) =
            registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Collection, payload);
        vm.warp(eta - 1);
        assertEq(registry.collectionOf(SERVICE, usdc), collection, "old resolves at eta - 1");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.TimelockPending.selector, changeId, eta));
        registry.applyChange(changeId);
        vm.warp(eta);
        vm.expectEmit(true, true, true, true, address(registry));
        emit IServiceRegistry.CollectionReleased(SERVICE, usdc, collection);
        vm.expectEmit(true, true, true, true, address(registry));
        emit IServiceRegistry.CollectionRegistered(SERVICE, usdc, collectionNext);
        vm.prank(operator);
        registry.applyChange(changeId);
        assertEq(registry.collectionOf(SERVICE, usdc), collectionNext, "new resolves");
    }

    function test_acceptedAssetChangeLandsOnlyAtEta() public {
        bytes memory payload = abi.encode(dai, collectionDai);
        vm.prank(operator);
        (bytes32 changeId, uint64 eta) =
            registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.AcceptedAsset, payload);
        vm.warp(eta - 1);
        assertFalse(registry.acceptsAsset(SERVICE, dai), "not accepted at eta - 1");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.TimelockPending.selector, changeId, eta));
        registry.applyChange(changeId);
        vm.warp(eta);
        vm.prank(operator);
        registry.applyChange(changeId);
        assertTrue(registry.acceptsAsset(SERVICE, dai), "accepted");
        assertEq(registry.collectionOf(SERVICE, dai), collectionDai, "collection set");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.AssetAlreadyAccepted.selector, SERVICE, dai));
        registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.AcceptedAsset, payload);
    }

    function test_tierChangeIsGatedOnCurationAuthorityAlone() public {
        bytes memory payload = abi.encode(uint256(IServiceRegistry.Tier.Curated));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.NotCurationAuthority.selector, operator));
        registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Tier, payload);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.NotCurationAuthority.selector, stranger));
        registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Tier, payload);
        vm.prank(curationAuthority);
        (bytes32 changeId, uint64 eta) =
            registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Tier, payload);
        vm.warp(eta - 1);
        assertEq(
            uint256(registry.tierOf(SERVICE)),
            uint256(IServiceRegistry.Tier.Permissionless),
            "tier at eta - 1"
        );
        vm.prank(curationAuthority);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.TimelockPending.selector, changeId, eta));
        registry.applyChange(changeId);
        vm.warp(eta);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.NotCurationAuthority.selector, operator));
        registry.applyChange(changeId);
        vm.prank(curationAuthority);
        registry.applyChange(changeId);
        assertEq(uint256(registry.tierOf(SERVICE)), uint256(IServiceRegistry.Tier.Curated), "tier applied");
    }

    function test_nonTierChangesAreGatedOnTheOperator() public {
        bytes memory payload = abi.encode(uint256(WINDOW_QUEUED));
        vm.prank(curationAuthority);
        vm.expectRevert(
            abi.encodeWithSelector(IServiceRegistry.NotServiceOperator.selector, SERVICE, curationAuthority)
        );
        registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.SettlementWindow, payload);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IServiceRegistry.NotServiceOperator.selector, SERVICE, stranger)
        );
        registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.SettlementWindow, payload);
        bytes32 absent = keccak256("absent");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.UnknownService.selector, absent));
        registry.queueChange(absent, IServiceRegistry.ChangeKind.SettlementWindow, payload);
    }

    function test_cancelChangeEmptiesQueueAndLeavesAppliedValuesUntouched() public {
        (bytes32 windowChange, uint64 eta) = _queueWindow(WINDOW_QUEUED);
        vm.prank(operator);
        (bytes32 moveChange,) = registry.queueChange(
            SERVICE, IServiceRegistry.ChangeKind.Collection, abi.encode(usdc, collectionNext)
        );
        vm.warp(eta - 1);
        vm.expectEmit(true, true, false, false, address(registry));
        emit IServiceRegistry.RegistryChangeCancelled(windowChange, SERVICE);
        vm.prank(operator);
        registry.cancelChange(windowChange);
        vm.prank(operator);
        registry.cancelChange(moveChange);
        assertFalse(registry.pendingChangeOf(windowChange).open, "window queue emptied");
        assertEq(registry.pendingChangeOf(windowChange).serviceId, bytes32(0), "window record cleared");
        assertFalse(registry.pendingChangeOf(moveChange).open, "move queue emptied");
        assertEq(registry.settlementWindowOf(SERVICE), WINDOW_APPLIED, "window untouched");
        assertEq(registry.collectionOf(SERVICE, usdc), collection, "collection untouched");
        vm.warp(eta);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.UnknownChange.selector, windowChange));
        registry.applyChange(windowChange);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.UnknownChange.selector, windowChange));
        registry.cancelChange(windowChange);
    }

    function test_identicalRequestsQueueAsDistinctChanges() public {
        (bytes32 first,) = _queueWindow(WINDOW_QUEUED);
        (bytes32 second,) = _queueWindow(WINDOW_QUEUED);
        assertTrue(first != second, "distinct identifiers");
        assertTrue(registry.pendingChangeOf(first).open, "first still open");
        assertTrue(registry.pendingChangeOf(second).open, "second open");
    }

    function test_malformedPayloadIsRejectedAtQueueTime() public {
        vm.startPrank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IServiceRegistry.InvalidChangePayload.selector, IServiceRegistry.ChangeKind.Price, 32
            )
        );
        registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Price, abi.encode(uint256(1)));
        vm.expectRevert(
            abi.encodeWithSelector(
                IServiceRegistry.InvalidChangePayload.selector,
                IServiceRegistry.ChangeKind.SettlementWindow,
                96
            )
        );
        registry.queueChange(
            SERVICE, IServiceRegistry.ChangeKind.SettlementWindow, abi.encode(usdc, TOOL, uint256(1))
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                IServiceRegistry.InvalidChangePayload.selector, IServiceRegistry.ChangeKind.Collection, 96
            )
        );
        registry.queueChange(
            SERVICE, IServiceRegistry.ChangeKind.Collection, abi.encode(uint256(1), usdc, collectionNext)
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                IServiceRegistry.SettlementWindowOutOfRange.selector, uint32(24 hours) + 1, uint32(24 hours)
            )
        );
        registry.queueChange(
            SERVICE, IServiceRegistry.ChangeKind.SettlementWindow, abi.encode(uint256(24 hours) + 1)
        );
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.ZeroToolPrice.selector, SERVICE, usdc, TOOL));
        registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Price, abi.encode(usdc, TOOL, uint256(0)));
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.ZeroAddressField.selector));
        registry.queueChange(
            SERVICE, IServiceRegistry.ChangeKind.Price, abi.encode(address(0), TOOL, PRICE_QUEUED)
        );
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.ZeroAddressField.selector));
        registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.AcceptedAsset, abi.encode(dai, address(0)));
        vm.stopPrank();
        vm.prank(curationAuthority);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.InvalidTier.selector, uint256(2)));
        registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Tier, abi.encode(uint256(2)));
    }

    function test_collectionMoveRequiresAnAcceptedAsset() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.AssetNotAccepted.selector, SERVICE, dai));
        registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Collection, abi.encode(dai, collectionDai));
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.ZeroAddressField.selector));
        registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Collection, abi.encode(usdc, address(0)));
        vm.stopPrank();
    }

    function test_zeroWindowPayloadAppliesTheRegistryDefault() public {
        (bytes32 changeId, uint64 eta) = _queueWindow(0);
        vm.warp(eta);
        vm.prank(operator);
        registry.applyChange(changeId);
        assertEq(registry.settlementWindowOf(SERVICE), uint32(6 hours), "default applied");
    }

    function test_unknownChangeIdIsRejected() public {
        bytes32 absent = keccak256("never-queued");
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.UnknownChange.selector, absent));
        registry.applyChange(absent);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.UnknownChange.selector, absent));
        registry.cancelChange(absent);
    }

    function _queueWindow(uint32 window) internal returns (bytes32 changeId, uint64 eta) {
        vm.prank(operator);
        (changeId, eta) = registry.queueChange(
            SERVICE, IServiceRegistry.ChangeKind.SettlementWindow, abi.encode(uint256(window))
        );
    }
}
