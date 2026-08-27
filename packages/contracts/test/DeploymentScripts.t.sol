// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";

import {DeployDecoder} from "../script/01_DeployDecoder.s.sol";
import {DeployCore} from "../script/02_DeployCore.s.sol";
import {DeployVerifier} from "../script/03_DeployVerifier.s.sol";
import {Wire} from "../script/04_Wire.s.sol";
import {RegisterAssets} from "../script/05_RegisterAssets.s.sol";
import {DeploySepolia} from "../script/06_DeploySepolia.s.sol";
import {VerifyDeployment} from "../script/07_VerifyDeployment.s.sol";
import {DeploymentBase} from "../script/DeploymentBase.sol";

import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Bond, IBond} from "../src/Bond.sol";
import {IServiceRegistry, ServiceRegistry} from "../src/ServiceRegistry.sol";
import {SettlementVerifier} from "../src/SettlementVerifier.sol";
import {ITabBook, TabBook} from "../src/TabBook.sol";

/// @title DeploymentScriptsTest
/// @notice Drives the seven deployment scripts end to end against a fresh in-memory tree, with no key,
/// no endpoint, and no environment, and asserts what the deployment is supposed to leave behind.
/// @dev A deployment is normally run once, which is exactly why it is worth testing: the ordering, the
/// one-shot wiring, and the registration calls would otherwise be the only sequence in the system that
/// nothing exercises before it matters. Each script's parameterised entrypoint is called directly, so
/// the code under test here is the code the deployment runs — only the environment reads and the
/// broadcast, which live in `run()`, are absent.
///
/// Two assertions carry more weight than the rest.
///
///  - **One-shot wiring genuinely closes.** A second `set*` call reverts `AlreadyWired`, and the
///    wiring script refuses to re-point a slot at a different address rather than discovering it in a
///    revert from the contract.
///  - **The Bond Collection Address resolves with `CollectionKind.Bond`.** And the negative case: a
///    deployment that claims the same address through `registerService` instead produces a record that
///    exists, resolves to the right Service, and is wrong, and the read-back script fails on it.
///
/// Requirements: 26.1, 26.2, 26.5, 11.6
contract DeploymentScriptsTest is Test {
    /// @notice The BlockProver Precompile the ASC binds in its constructor.
    address internal constant BLOCK_PROVER = 0x0000000000000000000000000000000000000FD2;

    /// @notice Attested-chain identifier of Ethereum Sepolia.
    uint64 internal constant CHAIN_KEY_SEPOLIA = 1;

    /// @notice Attested-chain identifier of Ethereum Mainnet.
    uint64 internal constant CHAIN_KEY_MAINNET = 3;

    /// @notice Identifier the deployment registers the Proof Service under.
    bytes32 internal constant PROOF_SERVICE_ID = bytes32("tab.proof-service");

    /// @notice Named tool the Proof Service meters.
    bytes32 internal constant PROOF_SERVICE_TOOL = bytes32("proof.generate");

    /// @notice Credit baseline, matching the `.env.example` value: 5.00 USDC at 6 decimals.
    uint256 internal constant BASELINE = 5_000_000;

    /// @notice Growth factor in basis points, matching the `.env.example` value.
    uint256 internal constant GROWTH_FACTOR_BPS = 5_000;

    /// @notice Price of the metered tool in Asset base units, matching the `.env.example` value.
    uint256 internal constant TOOL_PRICE = 10_000;

    /// @notice Settlement Window in seconds, matching the `.env.example` value: 6 hours.
    uint32 internal constant SETTLEMENT_WINDOW = 21_600;

    DeployDecoder internal step1;
    DeployCore internal step2;
    DeployVerifier internal step3;
    Wire internal step4;
    RegisterAssets internal step5;
    DeploySepolia internal step6;
    VerifyDeployment internal step7;

    address internal curationAuthority;
    address internal watcherAddress;
    address internal sepoliaUsdc;
    address internal mainnetUsdc;
    address internal serviceCollection;
    address internal bondCollection;

    function setUp() public {
        step1 = new DeployDecoder();
        step2 = new DeployCore();
        step3 = new DeployVerifier();
        step4 = new Wire();
        step5 = new RegisterAssets();
        step6 = new DeploySepolia();
        step7 = new VerifyDeployment();

        curationAuthority = makeAddr("curationAuthority");
        watcherAddress = makeAddr("watcher");
        sepoliaUsdc = makeAddr("sepoliaUsdc");
        mainnetUsdc = makeAddr("mainnetUsdc");
        serviceCollection = makeAddr("proofServiceCollection");
        bondCollection = makeAddr("bondCollection");
    }

    // ------------------------------------------------------------------ the whole sequence

    /// @notice Steps 1 to 7, in order, ending in the keyless read-back passing.
    function test_wholeSequenceVerifiesKeylessly() public {
        (address decoder, DeploymentBase.CoreAddresses memory core, address verifier) = _deployAndWire();
        address settlement = step6.deploySettlement();

        RegisterAssets.RegistrationReport memory registered =
            step5.registerAll(core.serviceRegistry, _registration(settlement));
        assertTrue(registered.serviceRegistered, "Service registered");
        assertTrue(registered.settlementEmitterAuthorised, "settlement emitter authorised");
        assertTrue(registered.bondCollectionSepolia, "Bond collection on chainKey 1");
        assertTrue(registered.bondCollectionMainnet, "Bond collection on chainKey 3");

        assertTrue(step7.verify(_record(decoder, core, verifier, settlement)), "read-back passes");
    }

    /// @notice Step 1 deploys a library with code in it, which is what step 3 links against.
    function test_decoderLibraryIsDeployed() public {
        address decoder = step1.deployDecoder();
        assertTrue(decoder != address(0), "decoder deployed");
        assertGt(decoder.code.length, 0, "decoder holds code");
    }

    /// @notice Step 3 binds all four collaborators, the Bond among them, plus the precompile.
    function test_verifierBindsFourCollaboratorsAndThePrecompile() public {
        (, DeploymentBase.CoreAddresses memory core, address verifier) = _deployAndWire();
        SettlementVerifier sv = SettlementVerifier(verifier);

        assertEq(address(sv.SERVICES()), core.serviceRegistry, "services");
        assertEq(address(sv.AGENTS()), core.agentRegistry, "agents");
        assertEq(address(sv.TAB_BOOK()), core.tabBook, "tabBook");
        assertEq(address(sv.BOND()), core.bond, "bond");
        assertEq(address(sv.VERIFIER()), BLOCK_PROVER, "BlockProver Precompile");
    }

    // ------------------------------------------------------------------ one-shot wiring

    /// @notice A second `set*` call reverts once the target is non-zero, on all five slots.
    /// @dev Called as the wiring authority, so the revert is the one-shot rule rather than the
    /// authority check. Each expectation names the address already wired, which is what the contracts
    /// report.
    function test_wiringIsOneShotAndRevertsOnASecondCall() public {
        (, DeploymentBase.CoreAddresses memory core, address verifier) = _deployAndWire();
        address other = makeAddr("someOtherContract");

        vm.startPrank(address(step4));

        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AlreadyWired.selector, verifier));
        AgentRegistry(core.agentRegistry).setSettlementVerifier(other);

        vm.expectRevert(abi.encodeWithSelector(ITabBook.AlreadyWired.selector, verifier));
        TabBook(core.tabBook).setSettlementVerifier(other);

        vm.expectRevert(abi.encodeWithSelector(ITabBook.AlreadyWired.selector, watcherAddress));
        TabBook(core.tabBook).setWatcher(other);

        vm.expectRevert(abi.encodeWithSelector(IBond.AlreadyWired.selector, core.tabBook));
        Bond(core.bond).setTabBook(other);

        vm.expectRevert(abi.encodeWithSelector(IBond.AlreadyWired.selector, verifier));
        Bond(core.bond).setSettlementVerifier(other);

        vm.stopPrank();
    }

    /// @notice Re-running step 4 over an already-wired deployment writes nothing and reverts nothing.
    function test_wiringIsResumableWhenTheSlotsAlreadyHoldTheirTargets() public {
        (, DeploymentBase.CoreAddresses memory core, address verifier) = _deployAndWire();

        Wire.WiringReport memory second = step4.wire(core, verifier, watcherAddress);
        assertFalse(second.agentsVerifierWritten, "AgentRegistry not rewritten");
        assertFalse(second.bookVerifierWritten, "TabBook verifier not rewritten");
        assertFalse(second.bookWatcherWritten, "TabBook watcher not rewritten");
        assertFalse(second.bondBookWritten, "Bond book not rewritten");
        assertFalse(second.bondVerifierWritten, "Bond verifier not rewritten");
    }

    /// @notice Step 4 names both addresses when a slot is already pointed somewhere else.
    /// @dev The contract's own `AlreadyWired` reports only the address present. This reports what was
    /// intended too, which is the difference between "already done" and "wired to the wrong thing".
    function test_wiringRefusesToRepointASlotAtADifferentAddress() public {
        (, DeploymentBase.CoreAddresses memory core, address verifier) = _deployAndWire();
        address impostor = makeAddr("impostorVerifier");

        vm.expectRevert(
            abi.encodeWithSelector(
                Wire.WiredElsewhere.selector, "AgentRegistry.settlementVerifier", verifier, impostor
            )
        );
        step4.wire(core, impostor, watcherAddress);
    }

    // ------------------------------------------------------------------ the Bond collection

    /// @notice Both Bond Collection Address records resolve with `CollectionKind.Bond`.
    /// @dev Without this record there is no path by which a proven deposit becomes stake, so every Bond
    /// ledger stays at zero, `bondCap` stays at zero, and every Credit Limit computed from it is zero.
    function test_bondCollectionResolvesWithBondKindOnBothChains() public {
        (, DeploymentBase.CoreAddresses memory core,) = _deployAndWire();
        address settlement = step6.deploySettlement();
        step5.registerAll(core.serviceRegistry, _registration(settlement));

        ServiceRegistry registry = ServiceRegistry(core.serviceRegistry);

        IServiceRegistry.CollectionRecord memory onSepolia =
            registry.collectionFor(CHAIN_KEY_SEPOLIA, bondCollection);
        assertTrue(onSepolia.exists, "Bond record on chainKey 1 exists");
        assertEq(onSepolia.serviceId, PROOF_SERVICE_ID, "Bond record names the Proof Service");
        assertEq(onSepolia.asset, sepoliaUsdc, "Bond record names Sepolia USDC");
        assertEq(
            uint8(onSepolia.kind), uint8(IServiceRegistry.CollectionKind.Bond), "chainKey 1 kind is Bond"
        );

        IServiceRegistry.CollectionRecord memory onMainnet =
            registry.collectionFor(CHAIN_KEY_MAINNET, bondCollection);
        assertTrue(onMainnet.exists, "Bond record on chainKey 3 exists");
        assertEq(onMainnet.asset, mainnetUsdc, "Bond record names Mainnet USDC");
        assertEq(
            uint8(onMainnet.kind), uint8(IServiceRegistry.CollectionKind.Bond), "chainKey 3 kind is Bond"
        );

        // And the tab collections are still ordinary tab collections.
        assertEq(
            uint8(registry.collectionFor(CHAIN_KEY_SEPOLIA, serviceCollection).kind),
            uint8(IServiceRegistry.CollectionKind.Tab),
            "tab collection kind is Tab"
        );
    }

    /// @notice The read-back fails when the Bond address was claimed through `registerService` instead.
    /// @dev The whole defect this task guards against, reproduced. Claiming the address as an accepted
    /// Asset entry gives it `CollectionKind.Tab`, which is the zero value, so the record exists,
    /// resolves to the right Service, names the right Asset, and credits a tab. Nothing downstream
    /// reports a fault. Step 7 is the only place the difference is visible.
    function test_readBackFailsWhenTheBondAddressWasClaimedAsATabCollection() public {
        (address decoder, DeploymentBase.CoreAddresses memory core, address verifier) = _deployAndWire();
        address settlement = step6.deploySettlement();

        _registerWithBondAddressAsTabCollection(ServiceRegistry(core.serviceRegistry), settlement);

        vm.expectRevert(
            abi.encodeWithSelector(
                VerifyDeployment.CollectionKindMismatch.selector,
                CHAIN_KEY_SEPOLIA,
                bondCollection,
                uint8(IServiceRegistry.CollectionKind.Bond),
                uint8(IServiceRegistry.CollectionKind.Tab)
            )
        );
        step7.verify(_record(decoder, core, verifier, settlement));
    }

    /// @notice Step 5 refuses a Bond address equal to the tab address instead of letting the registry.
    function test_registrationRefusesABondAddressCollidingWithTheTabAddress() public {
        (, DeploymentBase.CoreAddresses memory core,) = _deployAndWire();
        address settlement = step6.deploySettlement();

        RegisterAssets.Registration memory input = _registration(settlement);
        input.bondCollection = input.serviceCollection;

        vm.expectRevert(
            abi.encodeWithSelector(
                DeploymentBase.AddressCollision.selector,
                "PROOF_SERVICE_COLLECTION_ADDRESS",
                "BOND_COLLECTION_ADDRESS",
                serviceCollection
            )
        );
        step5.registerAll(core.serviceRegistry, input);
    }

    // ------------------------------------------------------------------ registration shape

    /// @notice Re-running step 5 writes nothing a second time.
    function test_registrationIsResumable() public {
        (, DeploymentBase.CoreAddresses memory core,) = _deployAndWire();
        address settlement = step6.deploySettlement();

        step5.registerAll(core.serviceRegistry, _registration(settlement));
        RegisterAssets.RegistrationReport memory second =
            step5.registerAll(core.serviceRegistry, _registration(settlement));

        assertFalse(second.serviceRegistered, "Service not re-registered");
        assertFalse(second.settlementEmitterAuthorised, "emitter not re-authorised");
        assertFalse(second.bondCollectionSepolia, "chainKey 1 Bond not re-claimed");
        assertFalse(second.bondCollectionMainnet, "chainKey 3 Bond not re-claimed");
    }

    /// @notice `TabSettlement` is authorised on chainKey 1 and demonstrably nowhere else.
    function test_settlementContractIsAuthorisedOnSepoliaAlone() public {
        (, DeploymentBase.CoreAddresses memory core,) = _deployAndWire();
        address settlement = step6.deploySettlement();
        step5.registerAll(core.serviceRegistry, _registration(settlement));

        ServiceRegistry registry = ServiceRegistry(core.serviceRegistry);

        IServiceRegistry.EmitterRecord memory onSepolia = registry.emitterFor(CHAIN_KEY_SEPOLIA, settlement);
        assertTrue(onSepolia.authorised, "authorised on chainKey 1");
        assertEq(
            uint8(onSepolia.kind),
            uint8(IServiceRegistry.EmitterKind.SettlementContract),
            "kind is SettlementContract"
        );

        assertFalse(
            registry.emitterFor(CHAIN_KEY_MAINNET, settlement).authorised, "not authorised on chainKey 3"
        );
        assertEq(registry.emitterChainMask(settlement), uint64(1) << CHAIN_KEY_SEPOLIA, "mask is chain 1");
    }

    /// @notice Registration leaves the Service in the Permissionless Tier and the hold at 48 hours.
    function test_serviceRegistersPermissionlessBehindTheTimelock() public {
        (, DeploymentBase.CoreAddresses memory core,) = _deployAndWire();
        address settlement = step6.deploySettlement();
        step5.registerAll(core.serviceRegistry, _registration(settlement));

        ServiceRegistry registry = ServiceRegistry(core.serviceRegistry);
        IServiceRegistry.Service memory service = registry.serviceOf(PROOF_SERVICE_ID);

        assertTrue(service.exists, "Service exists");
        assertEq(uint8(service.tier), uint8(IServiceRegistry.Tier.Permissionless), "Permissionless Tier");
        assertEq(service.settlementWindow, SETTLEMENT_WINDOW, "Settlement Window");
        assertEq(service.operator, address(step5), "operator is the registering account");
        assertEq(registry.curationAuthority(), curationAuthority, "curation authority from constructor");
        assertEq(registry.timelock(), 48 hours, "48-hour hold");
        assertEq(registry.priceOf(PROOF_SERVICE_ID, sepoliaUsdc, PROOF_SERVICE_TOOL), TOOL_PRICE, "price set");
    }

    // ------------------------------------------------------------------ helpers

    /// @notice Runs steps 1 to 4 and returns what they produced.
    /// @dev The wiring authority is the step 4 script contract, because it is the account that makes
    /// the five one-shot calls when the test drives them directly.
    /// @return decoder Address of the decoding library.
    /// @return core Addresses of the four core contracts.
    /// @return verifier Address of the `SettlementVerifier`.
    function _deployAndWire()
        internal
        returns (address decoder, DeploymentBase.CoreAddresses memory core, address verifier)
    {
        decoder = step1.deployDecoder();
        core = step2.deployCore(address(step4), curationAuthority, BASELINE, GROWTH_FACTOR_BPS);
        verifier = step3.deployVerifier(core);

        Wire.WiringReport memory report = step4.wire(core, verifier, watcherAddress);
        assertTrue(report.agentsVerifierWritten, "AgentRegistry wired");
        assertTrue(report.bookVerifierWritten, "TabBook verifier wired");
        assertTrue(report.bookWatcherWritten, "TabBook watcher wired");
        assertTrue(report.bondBookWritten, "Bond book wired");
        assertTrue(report.bondVerifierWritten, "Bond verifier wired");
    }

    /// @notice The step 5 input this test registers.
    /// @param settlement Address of the deployed `TabSettlement`.
    /// @return input Everything step 5 registers.
    function _registration(address settlement)
        internal
        view
        returns (RegisterAssets.Registration memory input)
    {
        input = RegisterAssets.Registration({
            sepoliaUsdc: sepoliaUsdc,
            mainnetUsdc: mainnetUsdc,
            sepoliaSettlement: settlement,
            serviceCollection: serviceCollection,
            bondCollection: bondCollection,
            price: TOOL_PRICE,
            settlementWindow: SETTLEMENT_WINDOW
        });
    }

    /// @notice The deployment record step 7 asserts against.
    /// @param decoder Address of the decoding library.
    /// @param core Addresses of the four core contracts.
    /// @param verifier Address of the `SettlementVerifier`.
    /// @param settlement Address of the deployed `TabSettlement`.
    /// @return record The record.
    function _record(
        address decoder,
        DeploymentBase.CoreAddresses memory core,
        address verifier,
        address settlement
    ) internal view returns (VerifyDeployment.DeploymentRecord memory record) {
        record.decoder = decoder;
        record.serviceRegistry = core.serviceRegistry;
        record.agentRegistry = core.agentRegistry;
        record.bond = core.bond;
        record.tabBook = core.tabBook;
        record.settlementVerifier = verifier;
        record.blockProver = BLOCK_PROVER;
        record.watcherAddress = watcherAddress;
        record.curationAuthority = curationAuthority;
        record.sepoliaUsdc = sepoliaUsdc;
        record.mainnetUsdc = mainnetUsdc;
        record.sepoliaSettlement = settlement;
        record.serviceCollection = serviceCollection;
        record.bondCollection = bondCollection;
        record.baseline = BASELINE;
        record.growthFactorBps = GROWTH_FACTOR_BPS;
        record.price = TOOL_PRICE;
        // A freshly registered Service is Permissionless: it is the only tier
        // `registerService` writes, and reaching Curated needs a queued change and the
        // registry's 48-hour hold, neither of which this sequence performs.
        record.expectedTier = IServiceRegistry.Tier.Permissionless;
    }

    /// @notice Registers the Proof Service the wrong way: the Bond address as a fourth Asset entry.
    /// @dev Four parallel entries, so both the tab address and the Bond address are claimed on both
    /// chains — all four with `CollectionKind.Tab`, because that is the only kind `registerService`
    /// writes. Prices are Asset-major, so four Assets and one tool give four prices.
    /// @param registry The registry.
    /// @param settlement Address of the deployed `TabSettlement`.
    function _registerWithBondAddressAsTabCollection(ServiceRegistry registry, address settlement) internal {
        uint64[] memory chainKeys = new uint64[](4);
        chainKeys[0] = CHAIN_KEY_SEPOLIA;
        chainKeys[1] = CHAIN_KEY_MAINNET;
        chainKeys[2] = CHAIN_KEY_SEPOLIA;
        chainKeys[3] = CHAIN_KEY_MAINNET;

        address[] memory assets = new address[](4);
        assets[0] = sepoliaUsdc;
        assets[1] = mainnetUsdc;
        assets[2] = sepoliaUsdc;
        assets[3] = mainnetUsdc;

        address[] memory collections = new address[](4);
        collections[0] = serviceCollection;
        collections[1] = serviceCollection;
        collections[2] = bondCollection;
        collections[3] = bondCollection;

        bytes32[] memory tools = new bytes32[](1);
        tools[0] = PROOF_SERVICE_TOOL;

        uint256[] memory prices = new uint256[](4);
        prices[0] = TOOL_PRICE;
        prices[1] = TOOL_PRICE;
        prices[2] = TOOL_PRICE;
        prices[3] = TOOL_PRICE;

        registry.registerService(
            PROOF_SERVICE_ID, chainKeys, assets, collections, tools, prices, SETTLEMENT_WINDOW
        );
        registry.registerSettlementEmitter(PROOF_SERVICE_ID, CHAIN_KEY_SEPOLIA, settlement, sepoliaUsdc);
    }
}
