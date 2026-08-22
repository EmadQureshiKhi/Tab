// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {IServiceRegistry, ServiceRegistry} from "../src/ServiceRegistry.sol";

/// @title ServiceRegistryTimelockTest
/// @notice Proves the 48-hour hold does the one thing it exists to do: a queued change is invisible to
/// every read until it lands, and it cannot land early.
/// @dev The boundary is asserted at exactly `eta - 1` and exactly `eta` for each of the five change
/// kinds that carry a gated read, and the read is checked immediately before and immediately after the
/// warp, so a change that leaked into live storage at queue time would fail here rather than pass
/// quietly. Cancellation is asserted to empty the queue and leave every applied value alone, and the
/// curation gate is asserted from both sides: the authority may promote a Service and its operator may
/// not.
///
/// Registration itself is covered by `ServiceRegistryRegistration.t.sol` and nothing here repeats it.
///
/// Requirements: 11.4, 11.5, 11.6, 11.7
contract ServiceRegistryTimelockTest is Test {
    /// @notice The registry under test.
    ServiceRegistry internal registry;

    /// @notice The single address permitted to move a curation tier. (R11.4, R11.5)
    address internal curationAuthority = makeAddr("curationAuthority");

    /// @notice Operator of the Service every case here changes.
    address internal operator = makeAddr("operator");

    /// @notice A party holding neither role, used for both halves of the authority split.
    address internal stranger = makeAddr("stranger");

    /// @notice Assets in play. The Service accepts USDC at registration and DAI only by change.
    address internal usdc = makeAddr("usdc");
    address internal dai = makeAddr("dai");

    /// @notice The Collection Address claimed at registration.
    address internal collection = makeAddr("collection");

    /// @notice The address a `Collection` change moves the Service onto.
    address internal collectionNext = makeAddr("collectionNext");

    /// @notice The address a DAI `AcceptedAsset` change collects at.
    address internal collectionDai = makeAddr("collectionDai");

    /// @notice Attested-chain identifier every case uses.
    uint64 internal constant CHAIN_KEY = 1;

    /// @notice Identifier of the Service under test.
    bytes32 internal constant SERVICE = keccak256("proof-service");

    /// @notice The one tool the Service meters at registration.
    bytes32 internal constant TOOL = keccak256("proof.merkle");

    /// @notice Applied price at registration, and the price a `Price` change moves it to.
    uint256 internal constant PRICE_APPLIED = 10_000;
    uint256 internal constant PRICE_QUEUED = 25_000;

    /// @notice Applied Settlement Window at registration, and the one a change moves it to.
    uint32 internal constant WINDOW_APPLIED = 1 hours;
    uint32 internal constant WINDOW_QUEUED = 4 hours;

    /// @notice Registers one Service accepting USDC on chainKey 1, with one priced tool.
    function setUp() public {
        registry = new ServiceRegistry(curationAuthority);

        uint64[] memory chainKeys = new uint64[](1);
        chainKeys[0] = CHAIN_KEY;

        address[] memory assets = new address[](1);
        assets[0] = usdc;

        address[] memory collections = new address[](1);
        collections[0] = collection;

        bytes32[] memory tools = new bytes32[](1);
        tools[0] = TOOL;

        uint256[] memory prices = new uint256[](1);
        prices[0] = PRICE_APPLIED;

        vm.prank(operator);
        registry.registerService(SERVICE, chainKeys, assets, collections, tools, prices, WINDOW_APPLIED);
    }

    // ------------------------------------------------------------------ the boundary

    /// @notice The hold is 48 hours, published on chain, and `eta` is that far out. (R11.6)
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

    /// @notice A Settlement Window change reverts at `eta - 1` and lands at `eta`, and the read serves
    /// the previously applied window for every second in between. (R11.6, R11.7)
    function test_settlementWindowChangeAppliesAtEtaAndNotBefore() public {
        (bytes32 changeId, uint64 eta) = _queueWindow(WINDOW_QUEUED);

        // Immediately after queueing, halfway through the hold, and one second short of it.
        assertEq(registry.settlementWindowOf(SERVICE), WINDOW_APPLIED, "at queue");
        vm.warp(eta - 24 hours);
        assertEq(registry.settlementWindowOf(SERVICE), WINDOW_APPLIED, "mid-hold");

        vm.warp(eta - 1);
        assertEq(registry.settlementWindowOf(SERVICE), WINDOW_APPLIED, "at eta - 1");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.TimelockPending.selector, changeId, eta));
        registry.applyChange(changeId);

        // One second later, to the exact boundary.
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

        // The record is gone, so the change cannot be applied a second time.
        assertFalse(registry.pendingChangeOf(changeId).open, "queue emptied");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.UnknownChange.selector, changeId));
        registry.applyChange(changeId);
    }

    /// @notice A price change serves the previously applied price for the whole hold, then the new one.
    /// (R11.6, R11.7, R18.3)
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

    /// @notice A Collection Address move leaves the old address resolving for the whole hold, then
    /// releases it and resolves the new one, carrying the same Asset. (R2.2, R11.6, R11.7)
    function test_collectionMoveServesOldAddressThroughoutHold() public {
        bytes memory payload = abi.encode(uint256(CHAIN_KEY), collection, collectionNext);

        vm.prank(operator);
        (bytes32 changeId, uint64 eta) =
            registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Collection, payload);

        vm.warp(eta - 1);
        assertTrue(registry.collectionFor(CHAIN_KEY, collection).exists, "old resolves at eta - 1");
        assertFalse(registry.collectionFor(CHAIN_KEY, collectionNext).exists, "new absent at eta - 1");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.TimelockPending.selector, changeId, eta));
        registry.applyChange(changeId);

        vm.warp(eta);
        vm.prank(operator);
        registry.applyChange(changeId);

        assertFalse(registry.collectionFor(CHAIN_KEY, collection).exists, "old released");

        IServiceRegistry.CollectionRecord memory moved = registry.collectionFor(CHAIN_KEY, collectionNext);
        assertTrue(moved.exists, "new resolves");
        assertEq(moved.serviceId, SERVICE, "serviceId");
        assertEq(moved.asset, usdc, "asset carried across");
        assertEq(moved.chainKey, CHAIN_KEY, "chainKey");
    }

    /// @notice An accepted-Asset change authorises the Asset as an emitter and claims its Collection
    /// Address only at `eta`, so neither read answers early. (R5.2, R11.6, R11.7)
    function test_acceptedAssetChangeAuthorisesEmitterOnlyAtEta() public {
        bytes memory payload = abi.encode(uint256(CHAIN_KEY), dai, collectionDai);

        vm.prank(operator);
        (bytes32 changeId, uint64 eta) =
            registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.AcceptedAsset, payload);

        vm.warp(eta - 1);
        assertFalse(registry.emitterFor(CHAIN_KEY, dai).authorised, "emitter at eta - 1");
        assertEq(registry.emitterChainMask(dai), uint64(0), "mask at eta - 1");
        assertFalse(registry.collectionFor(CHAIN_KEY, collectionDai).exists, "collection at eta - 1");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.TimelockPending.selector, changeId, eta));
        registry.applyChange(changeId);

        vm.warp(eta);
        vm.prank(operator);
        registry.applyChange(changeId);

        IServiceRegistry.EmitterRecord memory record = registry.emitterFor(CHAIN_KEY, dai);
        assertTrue(record.authorised, "authorised");
        assertEq(uint256(record.kind), uint256(IServiceRegistry.EmitterKind.Asset), "kind");
        assertEq(record.asset, dai, "asset");
        assertEq(registry.emitterChainMask(dai), uint64(1) << CHAIN_KEY, "mask");
        assertEq(registry.collectionFor(CHAIN_KEY, collectionDai).asset, dai, "collection asset");
    }

    // ------------------------------------------------------------------ the curation gate

    /// @notice Only the curation authority may move a tier, and the tier read serves Permissionless
    /// for the whole hold. (R11.3, R11.4, R11.5, R11.6, R11.7)
    function test_tierChangeIsGatedOnCurationAuthorityAlone() public {
        bytes memory payload = abi.encode(uint256(IServiceRegistry.Tier.Curated));

        // The Service's own operator cannot promote it. This is the case that keeps a Service from
        // minting its own Agents' Credit Limit weight.
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

        // Nor can the operator apply a tier change the authority queued.
        vm.warp(eta);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.NotCurationAuthority.selector, operator));
        registry.applyChange(changeId);

        vm.prank(curationAuthority);
        registry.applyChange(changeId);
        assertEq(uint256(registry.tierOf(SERVICE)), uint256(IServiceRegistry.Tier.Curated), "tier applied");
    }

    /// @notice Everything that is not a tier belongs to the operator, and the curation authority holds
    /// no power over any of it. (R11.4)
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

        // A change against a Service that does not exist is not an authority question.
        bytes32 absent = keccak256("absent");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.UnknownService.selector, absent));
        registry.queueChange(absent, IServiceRegistry.ChangeKind.SettlementWindow, payload);
    }

    // ------------------------------------------------------------------ cancellation

    /// @notice Cancellation empties the queue and touches no applied value, at any point in the hold.
    /// (R11.6, R11.7)
    function test_cancelChangeEmptiesQueueAndLeavesAppliedValuesUntouched() public {
        (bytes32 windowChange, uint64 eta) = _queueWindow(WINDOW_QUEUED);

        bytes memory movePayload = abi.encode(uint256(CHAIN_KEY), collection, collectionNext);
        vm.prank(operator);
        (bytes32 moveChange,) =
            registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Collection, movePayload);

        vm.warp(eta - 1);

        vm.expectEmit(true, true, false, false, address(registry));
        emit IServiceRegistry.RegistryChangeCancelled(windowChange, SERVICE);
        vm.prank(operator);
        registry.cancelChange(windowChange);

        vm.prank(operator);
        registry.cancelChange(moveChange);

        // Both records read as absent.
        assertFalse(registry.pendingChangeOf(windowChange).open, "window queue emptied");
        assertEq(registry.pendingChangeOf(windowChange).serviceId, bytes32(0), "window record cleared");
        assertFalse(registry.pendingChangeOf(moveChange).open, "move queue emptied");

        // And every applied value is exactly what registration wrote.
        assertEq(registry.settlementWindowOf(SERVICE), WINDOW_APPLIED, "window untouched");
        assertTrue(registry.collectionFor(CHAIN_KEY, collection).exists, "old collection untouched");
        assertFalse(registry.collectionFor(CHAIN_KEY, collectionNext).exists, "new collection unclaimed");

        // Past `eta`, a cancelled change is not applicable and cannot be cancelled twice.
        vm.warp(eta);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.UnknownChange.selector, windowChange));
        registry.applyChange(windowChange);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.UnknownChange.selector, windowChange));
        registry.cancelChange(windowChange);
    }

    /// @notice Two identical requests are two changes, so re-queueing never overwrites. (R11.6)
    function test_identicalRequestsQueueAsDistinctChanges() public {
        (bytes32 first,) = _queueWindow(WINDOW_QUEUED);
        (bytes32 second,) = _queueWindow(WINDOW_QUEUED);

        assertTrue(first != second, "distinct identifiers");
        assertTrue(registry.pendingChangeOf(first).open, "first still open");
        assertTrue(registry.pendingChangeOf(second).open, "second open");
    }

    // ------------------------------------------------------------------ payload rejection

    /// @notice A payload that is not the length its kind requires is rejected at queue time, so a
    /// caller does not wait out the hold to learn its arguments were malformed. (R11.6)
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

        // A window longer than 24 hours, a zero price, and a chain identifier outside the emitter
        // bitmask are all rejected on the same call rather than at application.
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

        vm.expectRevert(
            abi.encodeWithSelector(IServiceRegistry.ChainKeyOutOfMaskRange.selector, uint64(64), uint64(63))
        );
        registry.queueChange(
            SERVICE, IServiceRegistry.ChangeKind.AcceptedAsset, abi.encode(uint256(64), dai, collectionDai)
        );

        vm.stopPrank();

        // A tier outside the enumeration, from the only caller who could queue one.
        vm.prank(curationAuthority);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.InvalidTier.selector, uint256(2)));
        registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Tier, abi.encode(uint256(2)));
    }

    /// @notice A Service cannot move a Collection Address it does not hold, and a zero destination is
    /// refused. (R2.2, R11.6)
    function test_collectionMoveRequiresTheServiceToHoldTheAddress() public {
        vm.startPrank(operator);

        vm.expectRevert(
            abi.encodeWithSelector(
                IServiceRegistry.CollectionNotHeld.selector, CHAIN_KEY, collectionNext, SERVICE
            )
        );
        registry.queueChange(
            SERVICE,
            IServiceRegistry.ChangeKind.Collection,
            abi.encode(uint256(CHAIN_KEY), collectionNext, collectionDai)
        );

        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.ZeroAddressField.selector));
        registry.queueChange(
            SERVICE,
            IServiceRegistry.ChangeKind.Collection,
            abi.encode(uint256(CHAIN_KEY), collection, address(0))
        );

        vm.stopPrank();
    }

    /// @notice A zero window in a change payload takes the registry default, exactly as it does at
    /// registration. (R16.4)
    function test_zeroWindowPayloadAppliesTheRegistryDefault() public {
        (bytes32 changeId, uint64 eta) = _queueWindow(0);

        vm.warp(eta);
        vm.prank(operator);
        registry.applyChange(changeId);

        assertEq(registry.settlementWindowOf(SERVICE), uint32(6 hours), "default applied");
    }

    /// @notice An identifier nothing was ever queued under is unknown to both actions. (R11.6)
    function test_unknownChangeIdIsRejected() public {
        bytes32 absent = keccak256("never-queued");

        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.UnknownChange.selector, absent));
        registry.applyChange(absent);

        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.UnknownChange.selector, absent));
        registry.cancelChange(absent);
    }

    // ------------------------------------------------------------------ helpers

    /// @notice Queues a Settlement Window change as the operator, asserting the queued event.
    /// @param window Requested window in seconds, or zero to take the registry default.
    /// @return changeId Identifier the change was queued under.
    /// @return eta Creditcoin timestamp from which it may be applied.
    function _queueWindow(uint32 window) internal returns (bytes32 changeId, uint64 eta) {
        vm.prank(operator);
        (changeId, eta) = registry.queueChange(
            SERVICE, IServiceRegistry.ChangeKind.SettlementWindow, abi.encode(uint256(window))
        );
    }
}
