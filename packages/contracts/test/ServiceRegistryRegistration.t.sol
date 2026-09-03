// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {IServiceRegistry, ServiceRegistry} from "../src/ServiceRegistry.sol";

contract ServiceRegistryRegistrationTest is Test {
    ServiceRegistry internal registry;

    address internal curationAuthority = makeAddr("curationAuthority");
    address internal proofOperator = makeAddr("proofOperator");
    address internal gatewayOperator = makeAddr("gatewayOperator");
    address internal usdc = makeAddr("usdc");
    address internal ausd = makeAddr("ausd");
    address internal dai = makeAddr("dai");
    address internal collectionUsdc = makeAddr("collectionUsdc");
    address internal collectionAusd = makeAddr("collectionAusd");
    address internal collectionGateway = makeAddr("collectionGateway");

    bytes32 internal constant DEMO_SERVICE = keccak256("demo-service");
    bytes32 internal constant GATEWAY_SERVICE = keccak256("gateway-service");
    bytes32 internal constant TOOL_QUOTE = keccak256("quote.generate");
    bytes32 internal constant TOOL_CONTINUITY = keccak256("proof.continuity");
    uint256 internal constant PRICE_QUOTE = 10_000;
    uint256 internal constant PRICE_CONTINUITY = 25_000;

    function setUp() public {
        registry = new ServiceRegistry(curationAuthority);
        address[] memory assets = new address[](2);
        assets[0] = usdc;
        assets[1] = ausd;
        address[] memory collections = new address[](2);
        collections[0] = collectionUsdc;
        collections[1] = collectionAusd;
        bytes32[] memory tools = new bytes32[](2);
        tools[0] = TOOL_QUOTE;
        tools[1] = TOOL_CONTINUITY;
        uint256[] memory prices = new uint256[](4);
        prices[0] = PRICE_QUOTE;
        prices[1] = PRICE_CONTINUITY;
        prices[2] = PRICE_QUOTE;
        prices[3] = PRICE_CONTINUITY;
        vm.prank(proofOperator);
        registry.registerService(DEMO_SERVICE, assets, collections, tools, prices, 1 hours);
    }

    function test_constructorRefusesZeroCurationAuthority() public {
        vm.expectRevert(IServiceRegistry.ZeroAddressField.selector);
        new ServiceRegistry(address(0));
    }

    function test_registerServiceStoresPermissionlessTierAndWindow() public view {
        IServiceRegistry.Service memory service = registry.serviceOf(DEMO_SERVICE);
        assertEq(service.operator, proofOperator, "operator");
        assertEq(uint256(service.tier), uint256(IServiceRegistry.Tier.Permissionless), "tier");
        assertEq(service.settlementWindow, uint32(1 hours), "settlementWindow");
        assertEq(service.bondAccount, proofOperator, "bondAccount");
        assertEq(service.registeredAt, uint64(block.timestamp), "registeredAt");
        assertTrue(service.exists, "exists");
        assertEq(
            uint256(registry.tierOf(DEMO_SERVICE)), uint256(IServiceRegistry.Tier.Permissionless), "tierOf"
        );
        assertEq(registry.settlementWindowOf(DEMO_SERVICE), uint32(1 hours), "settlementWindowOf");
    }

    function test_collectionOfResolvesPerAsset() public {
        assertEq(registry.collectionOf(DEMO_SERVICE, usdc), collectionUsdc, "usdc collection");
        assertEq(registry.collectionOf(DEMO_SERVICE, ausd), collectionAusd, "ausd collection");
        assertTrue(registry.acceptsAsset(DEMO_SERVICE, usdc), "accepts usdc");
        assertFalse(registry.acceptsAsset(DEMO_SERVICE, dai), "does not accept dai");
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.AssetNotAccepted.selector, DEMO_SERVICE, dai));
        registry.collectionOf(DEMO_SERVICE, dai);
        bytes32 absent = keccak256("absent");
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.UnknownService.selector, absent));
        registry.collectionOf(absent, usdc);
    }

    function test_priceOfReturnsRegisteredBaseUnitsPerAsset() public {
        assertEq(registry.priceOf(DEMO_SERVICE, usdc, TOOL_QUOTE), PRICE_QUOTE, "quote price");
        assertEq(registry.priceOf(DEMO_SERVICE, usdc, TOOL_CONTINUITY), PRICE_CONTINUITY, "continuity price");
        assertEq(registry.priceOf(DEMO_SERVICE, ausd, TOOL_QUOTE), PRICE_QUOTE, "quote price in ausd");
        bytes32 unsold = keccak256("proof.unsold");
        vm.expectRevert(
            abi.encodeWithSelector(IServiceRegistry.UnknownTool.selector, DEMO_SERVICE, usdc, unsold)
        );
        registry.priceOf(DEMO_SERVICE, usdc, unsold);
        vm.expectRevert(
            abi.encodeWithSelector(IServiceRegistry.UnknownTool.selector, DEMO_SERVICE, dai, TOOL_QUOTE)
        );
        registry.priceOf(DEMO_SERVICE, dai, TOOL_QUOTE);
    }

    function test_enumerationAndDefaultWindow() public {
        assertEq(registry.serviceCount(), 1, "count before");
        assertEq(registry.serviceIdAt(0), DEMO_SERVICE, "first id");
        _registerGateway(collectionGateway, 0);
        assertEq(registry.serviceCount(), 2, "count after");
        assertEq(registry.serviceIdAt(1), GATEWAY_SERVICE, "second id");
        assertEq(registry.settlementWindowOf(GATEWAY_SERVICE), uint32(6 hours), "default window");
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.ServiceIndexOutOfBounds.selector, 2, 2));
        registry.serviceIdAt(2);
    }

    function test_duplicateServiceIdReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.ServiceExists.selector, DEMO_SERVICE));
        _registerAs(gatewayOperator, DEMO_SERVICE, dai, collectionGateway, 1 hours);
        assertEq(registry.serviceCount(), 1, "count unchanged");
        assertEq(registry.serviceOf(DEMO_SERVICE).operator, proofOperator, "holder unchanged");
    }

    function test_twoServicesMaySharePayoutAddresses() public {
        _registerAs(gatewayOperator, GATEWAY_SERVICE, usdc, collectionUsdc, 1 hours);
        assertEq(registry.collectionOf(GATEWAY_SERVICE, usdc), collectionUsdc, "shared collection");
        assertEq(registry.collectionOf(DEMO_SERVICE, usdc), collectionUsdc, "original untouched");
    }

    function test_registrationRefusesMalformedInput() public {
        address[] memory none = new address[](0);
        bytes32[] memory tools = new bytes32[](1);
        tools[0] = TOOL_QUOTE;
        uint256[] memory prices = new uint256[](0);
        vm.prank(gatewayOperator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.NoAcceptedAsset.selector, GATEWAY_SERVICE));
        registry.registerService(GATEWAY_SERVICE, none, none, tools, prices, 1 hours);

        address[] memory assets = new address[](1);
        assets[0] = dai;
        address[] memory twoCollections = new address[](2);
        vm.prank(gatewayOperator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.ArrayLengthMismatch.selector, 1, 2));
        registry.registerService(GATEWAY_SERVICE, assets, twoCollections, tools, prices, 1 hours);

        address[] memory collections = new address[](1);
        collections[0] = collectionGateway;
        vm.prank(gatewayOperator);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.ArrayLengthMismatch.selector, 1, 0));
        registry.registerService(GATEWAY_SERVICE, assets, collections, tools, prices, 1 hours);

        uint256[] memory zeroPrice = new uint256[](1);
        vm.prank(gatewayOperator);
        vm.expectRevert(
            abi.encodeWithSelector(IServiceRegistry.ZeroToolPrice.selector, GATEWAY_SERVICE, dai, TOOL_QUOTE)
        );
        registry.registerService(GATEWAY_SERVICE, assets, collections, tools, zeroPrice, 1 hours);

        address[] memory zeroCollection = new address[](1);
        uint256[] memory onePrice = new uint256[](1);
        onePrice[0] = 1;
        vm.prank(gatewayOperator);
        vm.expectRevert(IServiceRegistry.ZeroAddressField.selector);
        registry.registerService(GATEWAY_SERVICE, assets, zeroCollection, tools, onePrice, 1 hours);

        address[] memory twice = new address[](2);
        twice[0] = dai;
        twice[1] = dai;
        address[] memory twiceCollections = new address[](2);
        twiceCollections[0] = collectionGateway;
        twiceCollections[1] = collectionGateway;
        uint256[] memory twoPrices = new uint256[](2);
        twoPrices[0] = 1;
        twoPrices[1] = 1;
        vm.prank(gatewayOperator);
        vm.expectRevert(
            abi.encodeWithSelector(IServiceRegistry.AssetAlreadyAccepted.selector, GATEWAY_SERVICE, dai)
        );
        registry.registerService(GATEWAY_SERVICE, twice, twiceCollections, tools, twoPrices, 1 hours);
    }

    function test_settlementWindowAboveTwentyFourHoursReverts() public {
        uint32 tooLong = uint32(24 hours) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                IServiceRegistry.SettlementWindowOutOfRange.selector, tooLong, uint32(24 hours)
            )
        );
        _registerGateway(collectionGateway, tooLong);
        _registerGateway(collectionGateway, uint32(24 hours));
        assertEq(registry.settlementWindowOf(GATEWAY_SERVICE), uint32(24 hours), "boundary accepted");
    }

    function _registerGateway(address collection, uint32 settlementWindow) internal {
        _registerAs(gatewayOperator, GATEWAY_SERVICE, dai, collection, settlementWindow);
    }

    function _registerAs(
        address operator,
        bytes32 serviceId,
        address asset,
        address collection,
        uint32 window
    ) internal {
        address[] memory assets = new address[](1);
        assets[0] = asset;
        address[] memory collections = new address[](1);
        collections[0] = collection;
        bytes32[] memory tools = new bytes32[](1);
        tools[0] = TOOL_QUOTE;
        uint256[] memory prices = new uint256[](1);
        prices[0] = 1;
        vm.prank(operator);
        registry.registerService(serviceId, assets, collections, tools, prices, window);
    }
}
