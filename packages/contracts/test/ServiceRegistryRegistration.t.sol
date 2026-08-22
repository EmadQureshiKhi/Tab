// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {IServiceRegistry, ServiceRegistry} from "../src/ServiceRegistry.sol";

/// @title ServiceRegistryRegistrationTest
/// @notice Proves the registration half of `ServiceRegistry` is usable rather than merely compilable:
/// a Service registers permissionlessly, emitters land on both attested chains as
/// `(chainKey, emitterAddress)` pairs, and every read returns what registration wrote.
/// @dev Also asserts the two rejections registration exists to enforce — a second claim on one
/// Collection Address, and a Settlement Window longer than 24 hours. The timelock boundaries and the
/// rest of the negative surface belong to the unit suite for this contract, which is a separate task
/// and a separate file; nothing here overlaps it.
///
/// Requirements: 2.2, 5.2, 11.1, 11.2, 11.3, 16.4, 18.3
contract ServiceRegistryRegistrationTest is Test {
    /// @notice The registry under test.
    ServiceRegistry internal registry;

    /// @notice Curation authority bound at construction. Holds no power over anything asserted here.
    address internal curationAuthority = makeAddr("curationAuthority");

    /// @notice Operator of the Service registered by {setUp}.
    address internal proofOperator = makeAddr("proofOperator");

    /// @notice Operator of a second Service, used for the cross-Service collision cases.
    address internal gatewayOperator = makeAddr("gatewayOperator");

    /// @notice An Asset contract occupying one address on both attested chains.
    /// @dev The point of the fixture: the same address is authorised on chainKey 1 and chainKey 3 by
    /// two separate entries, which is the only way the pair keying can be observed at all.
    address internal usdc = makeAddr("usdc");

    /// @notice A second, unrelated Asset.
    address internal dai = makeAddr("dai");

    /// @notice Collection Addresses. One per Asset per chain, since a collection resolves to one pair.
    address internal collectionSepolia = makeAddr("collectionSepolia");
    address internal collectionMainnet = makeAddr("collectionMainnet");
    address internal collectionGateway = makeAddr("collectionGateway");

    /// @notice The Tab-authored settlement contract on Ethereum Sepolia.
    address internal tabSettlement = makeAddr("tabSettlement");

    /// @notice Attested-chain identifiers in play.
    uint64 internal constant CHAIN_KEY_SEPOLIA = 1;
    uint64 internal constant CHAIN_KEY_MAINNET = 3;

    /// @notice Identifier of the Service registered by {setUp}.
    bytes32 internal constant PROOF_SERVICE = keccak256("proof-service");

    /// @notice Identifier of the second Service.
    bytes32 internal constant GATEWAY_SERVICE = keccak256("gateway-service");

    /// @notice Named tools the first Service meters.
    bytes32 internal constant TOOL_MERKLE = keccak256("proof.merkle");
    bytes32 internal constant TOOL_CONTINUITY = keccak256("proof.continuity");

    /// @notice Prices in USDC base units. USDC carries six decimals, so 10_000 is one cent.
    uint256 internal constant PRICE_MERKLE = 10_000;
    uint256 internal constant PRICE_CONTINUITY = 25_000;

    /// @notice Registers one Service accepting USDC on both chains, with two priced tools.
    function setUp() public {
        registry = new ServiceRegistry(curationAuthority);

        uint64[] memory chainKeys = new uint64[](2);
        chainKeys[0] = CHAIN_KEY_SEPOLIA;
        chainKeys[1] = CHAIN_KEY_MAINNET;

        address[] memory assets = new address[](2);
        assets[0] = usdc;
        assets[1] = usdc;

        address[] memory collections = new address[](2);
        collections[0] = collectionSepolia;
        collections[1] = collectionMainnet;

        bytes32[] memory tools = new bytes32[](2);
        tools[0] = TOOL_MERKLE;
        tools[1] = TOOL_CONTINUITY;

        // Asset-major: one row of tool prices per accepted Asset entry. Both entries name the same
        // Asset here, so both rows carry the same integers.
        uint256[] memory prices = new uint256[](4);
        prices[0] = PRICE_MERKLE;
        prices[1] = PRICE_CONTINUITY;
        prices[2] = PRICE_MERKLE;
        prices[3] = PRICE_CONTINUITY;

        vm.prank(proofOperator);
        registry.registerService(PROOF_SERVICE, chainKeys, assets, collections, tools, prices, 1 hours);
    }

    // ------------------------------------------------------------------ happy path

    /// @notice Registration is open to any address, lands in the Permissionless Tier, and stores the
    /// operator, the Bond reference, and the requested Settlement Window. (R11.1, R11.2, R11.3, R16.4)
    function test_registerServiceStoresPermissionlessTierAndWindow() public view {
        IServiceRegistry.Service memory service = registry.serviceOf(PROOF_SERVICE);

        assertEq(service.operator, proofOperator, "operator");
        assertEq(uint256(service.tier), uint256(IServiceRegistry.Tier.Permissionless), "tier");
        assertEq(service.settlementWindow, uint32(1 hours), "settlementWindow");
        assertEq(service.bondAccount, proofOperator, "bondAccount");
        assertEq(service.registeredAt, uint64(block.timestamp), "registeredAt");
        assertTrue(service.exists, "exists");

        assertEq(
            uint256(registry.tierOf(PROOF_SERVICE)), uint256(IServiceRegistry.Tier.Permissionless), "tierOf"
        );
        assertEq(registry.settlementWindowOf(PROOF_SERVICE), uint32(1 hours), "settlementWindowOf");
    }

    /// @notice One emitter address authorised on chainKey 1 and chainKey 3 reads back as two records
    /// and one mask carrying both bits. (R5.2)
    function test_registerServiceAuthorisesEmitterOnBothChainKeys() public view {
        IServiceRegistry.EmitterRecord memory sepolia = registry.emitterFor(CHAIN_KEY_SEPOLIA, usdc);
        assertTrue(sepolia.authorised, "sepolia authorised");
        assertEq(uint256(sepolia.kind), uint256(IServiceRegistry.EmitterKind.Asset), "sepolia kind");
        assertEq(sepolia.asset, usdc, "sepolia asset");

        IServiceRegistry.EmitterRecord memory mainnet = registry.emitterFor(CHAIN_KEY_MAINNET, usdc);
        assertTrue(mainnet.authorised, "mainnet authorised");
        assertEq(uint256(mainnet.kind), uint256(IServiceRegistry.EmitterKind.Asset), "mainnet kind");
        assertEq(mainnet.asset, usdc, "mainnet asset");

        // Bit 1 and bit 3 set, and nothing else.
        uint64 expectedMask = (uint64(1) << CHAIN_KEY_SEPOLIA) | (uint64(1) << CHAIN_KEY_MAINNET);
        assertEq(registry.emitterChainMask(usdc), expectedMask, "mask");

        // A chain nobody authorised this address on stays unauthorised, and an address nobody
        // registered anywhere reports a mask of zero.
        assertFalse(registry.emitterFor(2, usdc).authorised, "unauthorised chain");
        assertEq(registry.emitterChainMask(dai), uint64(0), "unregistered mask");
    }

    /// @notice Each Collection Address resolves to the Service and Asset that claimed it, per chain.
    /// (R2.2, R2.3)
    function test_collectionForResolvesServiceAndAssetPerChain() public view {
        IServiceRegistry.CollectionRecord memory sepolia =
            registry.collectionFor(CHAIN_KEY_SEPOLIA, collectionSepolia);
        assertTrue(sepolia.exists, "sepolia exists");
        assertEq(sepolia.serviceId, PROOF_SERVICE, "sepolia serviceId");
        assertEq(sepolia.asset, usdc, "sepolia asset");
        assertEq(sepolia.chainKey, CHAIN_KEY_SEPOLIA, "sepolia chainKey");

        IServiceRegistry.CollectionRecord memory mainnet =
            registry.collectionFor(CHAIN_KEY_MAINNET, collectionMainnet);
        assertTrue(mainnet.exists, "mainnet exists");
        assertEq(mainnet.serviceId, PROOF_SERVICE, "mainnet serviceId");
        assertEq(mainnet.asset, usdc, "mainnet asset");

        // The same address on the other chain was never claimed, which is the whole point of keying
        // the collection table by chain as well.
        assertFalse(registry.collectionFor(CHAIN_KEY_MAINNET, collectionSepolia).exists, "cross-chain");
    }

    /// @notice Prices read back as the exact integers registered, and an unpriced tool is not free.
    /// (R18.3)
    function test_priceOfReturnsRegisteredBaseUnits() public {
        assertEq(registry.priceOf(PROOF_SERVICE, usdc, TOOL_MERKLE), PRICE_MERKLE, "merkle price");
        assertEq(registry.priceOf(PROOF_SERVICE, usdc, TOOL_CONTINUITY), PRICE_CONTINUITY, "continuity price");

        bytes32 unsold = keccak256("proof.unsold");
        vm.expectRevert(
            abi.encodeWithSelector(IServiceRegistry.UnknownTool.selector, PROOF_SERVICE, usdc, unsold)
        );
        registry.priceOf(PROOF_SERVICE, usdc, unsold);
    }

    /// @notice A settlement contract is authorised on exactly the one chain named, by the operator.
    /// (R5.2)
    function test_registerSettlementEmitterAuthorisesOneChainOnly() public {
        vm.prank(proofOperator);
        registry.registerSettlementEmitter(PROOF_SERVICE, CHAIN_KEY_SEPOLIA, tabSettlement, usdc);

        IServiceRegistry.EmitterRecord memory record = registry.emitterFor(CHAIN_KEY_SEPOLIA, tabSettlement);
        assertTrue(record.authorised, "authorised");
        assertEq(uint256(record.kind), uint256(IServiceRegistry.EmitterKind.SettlementContract), "kind");
        assertEq(record.asset, usdc, "asset");

        assertFalse(registry.emitterFor(CHAIN_KEY_MAINNET, tabSettlement).authorised, "mainnet");
        assertEq(registry.emitterChainMask(tabSettlement), uint64(1) << CHAIN_KEY_SEPOLIA, "mask");

        // Somebody who does not operate the Service cannot bind an emitter to an Asset.
        vm.prank(gatewayOperator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IServiceRegistry.NotServiceOperator.selector, PROOF_SERVICE, gatewayOperator
            )
        );
        registry.registerSettlementEmitter(PROOF_SERVICE, CHAIN_KEY_MAINNET, tabSettlement, usdc);
    }

    /// @notice The registry is walkable from public reads alone, and a zero window takes the default.
    /// (R16.4)
    function test_enumerationAndDefaultWindow() public {
        assertEq(registry.serviceCount(), 1, "count before");
        assertEq(registry.serviceIdAt(0), PROOF_SERVICE, "first id");

        _registerGateway(collectionGateway, 0);

        assertEq(registry.serviceCount(), 2, "count after");
        assertEq(registry.serviceIdAt(1), GATEWAY_SERVICE, "second id");
        assertEq(registry.settlementWindowOf(GATEWAY_SERVICE), uint32(6 hours), "default window");

        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.ServiceIndexOutOfBounds.selector, 2, 2));
        registry.serviceIdAt(2);
    }

    // ------------------------------------------------------------------ rejections

    /// @notice A second Service cannot claim a Collection Address another Service already holds on the
    /// same chain, because crediting resolves through that address. (R2.2)
    function test_duplicateCollectionClaimReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IServiceRegistry.CollectionAddressTaken.selector,
                CHAIN_KEY_SEPOLIA,
                collectionSepolia,
                PROOF_SERVICE
            )
        );
        _registerGateway(collectionSepolia, 1 hours);

        // The rejected registration left nothing behind.
        assertEq(registry.serviceCount(), 1, "count unchanged");
        assertEq(
            registry.collectionFor(CHAIN_KEY_SEPOLIA, collectionSepolia).serviceId, PROOF_SERVICE, "holder"
        );
    }

    /// @notice A Settlement Window longer than 24 hours is rejected, and 24 hours exactly is accepted.
    /// (R16.4)
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

    // ------------------------------------------------------------------ helpers

    /// @notice Registers the second Service, accepting DAI on Ethereum Mainnet at one collection.
    /// @param collection Collection Address to claim, so a collision can be aimed deliberately.
    /// @param settlementWindow Requested window in seconds, or zero to take the registry default.
    function _registerGateway(address collection, uint32 settlementWindow) internal {
        uint64[] memory chainKeys = new uint64[](1);
        chainKeys[0] = CHAIN_KEY_SEPOLIA;

        address[] memory assets = new address[](1);
        assets[0] = dai;

        address[] memory collections = new address[](1);
        collections[0] = collection;

        bytes32[] memory tools = new bytes32[](1);
        tools[0] = TOOL_MERKLE;

        uint256[] memory prices = new uint256[](1);
        prices[0] = 1;

        vm.prank(gatewayOperator);
        registry.registerService(
            GATEWAY_SERVICE, chainKeys, assets, collections, tools, prices, settlementWindow
        );
    }
}
