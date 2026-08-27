// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeploymentBase} from "./DeploymentBase.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Bond} from "../src/Bond.sol";
import {IServiceRegistry, ServiceRegistry} from "../src/ServiceRegistry.sol";
import {SettlementVerifier} from "../src/SettlementVerifier.sol";
import {TabBook} from "../src/TabBook.sol";
import {console} from "forge-std/console.sol";

/// @title VerifyDeployment
/// @notice Step 7. Reads every wired address, every registered signature, and the registry snapshot back
/// off the chain and asserts each one against the recorded deployment. Holds no key and sends nothing.
/// @dev **Keylessness is the requirement, not a convenience.** Every function this script calls is a
/// view, so it runs with no private key, no funded account, and no signer of any kind — which is what
/// makes the deployment checkable by a stranger who has only the repository and an endpoint, rather than
/// demonstrable only by whoever holds the deploying key. (R28.2, R28.3)
///
/// What it asserts, in three groups:
///
///  1. **Wiring.** All four of the verifier's constructor immutables, and all five one-shot slots. Read
///     from both ends: the verifier names the book, and the book names the verifier. A half-wired
///     deployment satisfies one direction and fails the other.
///  2. **Signatures and bounds.** The two Settlement signature topics, the two accepted chainKeys, and
///     the BlockProver Precompile address the ASC actually holds. The signature topics are a
///     cross-chain ABI agreement with a contract on another chain, so reading them back off the
///     deployed bytecode is how the agreement is confirmed rather than assumed.
///  3. **Registry snapshot.** The Service record and its tier, both USDC emitters, the settlement
///     contract authorised on chainKey 1 and demonstrably not on chainKey 3, the tab collections, and —
///     the assertion this step exists for — **both Bond Collection Addresses resolving with
///     `CollectionKind.Bond`**.
///
/// That last one is worth stating plainly. `CollectionKind.Tab` is the zero value, so a Bond address
/// claimed through the wrong path still exists, still resolves to the right Service, and still credits
/// a Settlement — as a tab reduction. Nothing downstream reports a fault; stake simply never comes into
/// existence, `bondCap` stays at zero, and every Credit Limit computed from it is zero. Reading the kind
/// back is the only place that distinction is visible, so it is asserted here and the script fails on it.
///
/// Run, from `packages/contracts`, with no key:
///
/// ```
/// forge script script/07_VerifyDeployment.s.sol:VerifyDeployment --rpc-url creditcoin --sig "run()"
/// ```
///
/// Requirements: 26.3, 28.2, 28.3
contract VerifyDeployment is DeploymentBase {
    /// @notice The recorded deployment, as the environment describes it.
    struct DeploymentRecord {
        /// @dev `EvmV1Decoder` from step 1.
        address decoder;
        /// @dev `ServiceRegistry` from step 2.
        address serviceRegistry;
        /// @dev `AgentRegistry` from step 2.
        address agentRegistry;
        /// @dev `Bond` from step 2.
        address bond;
        /// @dev `TabBook` from step 2.
        address tabBook;
        /// @dev `SettlementVerifier` from step 3.
        address settlementVerifier;
        /// @dev BlockProver Precompile the ASC must hold.
        address blockProver;
        /// @dev Watcher account wired in step 4.
        address watcherAddress;
        /// @dev Curation authority passed to the registry's constructor in step 2.
        address curationAuthority;
        /// @dev USDC on Ethereum Sepolia.
        address sepoliaUsdc;
        /// @dev USDC on Ethereum Mainnet.
        address mainnetUsdc;
        /// @dev Tier the Proof Service is expected to hold.
        ///
        /// Not a constant, because this script verifies two different deployments. A fresh one is
        /// `Permissionless`, which is the only tier `registerService` can write. The live registry
        /// is `Curated`, because the curation authority queued a promotion and the registry applied
        /// it after its 48-hour hold. Asserting either value globally would make the check pass
        /// vacuously on one of the two.
        IServiceRegistry.Tier expectedTier;
        /// @dev `TabSettlement` from step 6.
        address sepoliaSettlement;
        /// @dev Tab Collection Address of the Proof Service.
        address serviceCollection;
        /// @dev Bond Collection Address of the Proof Service.
        address bondCollection;
        /// @dev Credit baseline the book was constructed with.
        uint256 baseline;
        /// @dev Growth factor the book was constructed with.
        uint256 growthFactorBps;
        /// @dev Price of the metered tool, in Asset base units.
        uint256 price;
    }

    /// @notice An address read back off the chain is not the recorded one.
    /// @param what Name of the slot that was read.
    /// @param expected Address the deployment record names.
    /// @param actual Address the chain answered with.
    error AddressMismatch(string what, address expected, address actual);

    /// @notice A number read back off the chain is not the recorded one.
    /// @param what Name of the value that was read.
    /// @param expected Value the deployment record names.
    /// @param actual Value the chain answered with.
    error ValueMismatch(string what, uint256 expected, uint256 actual);

    /// @notice A signature topic or identifier read back off the chain is not the expected one.
    /// @param what Name of the constant that was read.
    /// @param expected Value this repository computes.
    /// @param actual Value the deployed bytecode holds.
    error WordMismatch(string what, bytes32 expected, bytes32 actual);

    /// @notice An emitter that must be authorised is not.
    /// @param chainKey Attested-chain identifier that was queried.
    /// @param emitter Address that was queried.
    error EmitterNotAuthorised(uint64 chainKey, address emitter);

    /// @notice An emitter that must not be authorised on this chain is.
    /// @dev The chainKey 3 query against the Sepolia settlement contract. Authorising it there would let
    /// a `TabSettled` log be believed on a chain where Tab deploys nothing.
    /// @param chainKey Attested-chain identifier that was queried.
    /// @param emitter Address that was queried.
    error EmitterAuthorisedOnWrongChain(uint64 chainKey, address emitter);

    /// @notice An emitter is authorised with a kind other than the expected one.
    /// @param chainKey Attested-chain identifier of the record.
    /// @param emitter Address of the record.
    /// @param expected Expected kind, as its raw enumeration value.
    /// @param actual Recorded kind, as its raw enumeration value.
    error EmitterKindMismatch(uint64 chainKey, address emitter, uint8 expected, uint8 actual);

    /// @notice A Collection Address does not resolve, or resolves to the wrong Service or Asset.
    /// @param chainKey Attested-chain identifier of the record.
    /// @param collection Address of the record.
    error CollectionUnresolved(uint64 chainKey, address collection);

    /// @notice A Collection Address resolves with a kind other than the expected one.
    /// @dev The Bond assertion this whole step exists for reports through here.
    /// @param chainKey Attested-chain identifier of the record.
    /// @param collection Address of the record.
    /// @param expected Expected kind, as its raw enumeration value.
    /// @param actual Recorded kind, as its raw enumeration value.
    error CollectionKindMismatch(uint64 chainKey, address collection, uint8 expected, uint8 actual);

    /// @notice The registry holds no Service, so nothing was registered.
    error NoServiceRegistered();

    /// @notice The Service is in a tier other than the one registration assigns.
    /// @param expected Expected tier, as its raw enumeration value.
    /// @param actual Recorded tier, as its raw enumeration value.
    error TierMismatch(uint8 expected, uint8 actual);

    /// @notice Reads the whole deployment back and asserts it, with no key and no transaction.
    /// @return verified True when every assertion held. Any failure reverts instead of returning false.
    function run() external view returns (bool verified) {
        _requireCreditcoinChain(vm.envUint("CREDITCOIN_CHAIN_ID"));

        // Field by field rather than one struct literal, which keeps every frame shallow enough for the
        // unoptimised legacy code generator the coverage profile uses.
        DeploymentRecord memory record;
        record.decoder = _requireCode("DECODER_LIBRARY_ADDRESS", vm.envAddress("DECODER_LIBRARY_ADDRESS"));
        record.serviceRegistry =
            _requireCode("SERVICE_REGISTRY_ADDRESS", vm.envAddress("SERVICE_REGISTRY_ADDRESS"));
        record.agentRegistry = _requireCode("AGENT_REGISTRY_ADDRESS", vm.envAddress("AGENT_REGISTRY_ADDRESS"));
        record.bond = _requireCode("BOND_ADDRESS", vm.envAddress("BOND_ADDRESS"));
        record.tabBook = _requireCode("TAB_BOOK_ADDRESS", vm.envAddress("TAB_BOOK_ADDRESS"));
        record.settlementVerifier =
            _requireCode("SETTLEMENT_VERIFIER_ADDRESS", vm.envAddress("SETTLEMENT_VERIFIER_ADDRESS"));
        record.blockProver =
            _requireAddress("BLOCKPROVER_PRECOMPILE", vm.envAddress("BLOCKPROVER_PRECOMPILE"));
        record.watcherAddress = _requireAddress("WATCHER_ADDRESS", vm.envAddress("WATCHER_ADDRESS"));
        record.curationAuthority =
            _requireAddress("CURATION_AUTHORITY_ADDRESS", vm.envAddress("CURATION_AUTHORITY_ADDRESS"));
        record.sepoliaUsdc = _requireAddress("SEPOLIA_USDC_ADDRESS", vm.envAddress("SEPOLIA_USDC_ADDRESS"));
        record.mainnetUsdc = _requireAddress("MAINNET_USDC_ADDRESS", vm.envAddress("MAINNET_USDC_ADDRESS"));
        record.sepoliaSettlement =
            _requireAddress("SEPOLIA_SETTLEMENT_ADDRESS", vm.envAddress("SEPOLIA_SETTLEMENT_ADDRESS"));
        record.serviceCollection = _requireAddress(
            "PROOF_SERVICE_COLLECTION_ADDRESS", vm.envAddress("PROOF_SERVICE_COLLECTION_ADDRESS")
        );
        record.bondCollection =
            _requireAddress("BOND_COLLECTION_ADDRESS", vm.envAddress("BOND_COLLECTION_ADDRESS"));
        record.baseline = vm.envUint("CREDIT_BASELINE_BASE_UNITS");
        record.growthFactorBps = vm.envUint("GROWTH_FACTOR_BPS");
        record.price = vm.envUint("PROOF_SERVICE_PRICE_BASE_UNITS");
        // Curated since the queued promotion applied on 2026-09-08 in transaction
        // 0x514640c52e00775a7de6ef29404000e3848d70a3094e73d811d209d725cb528e, which
        // `deployments.json` records with its change id, block and hold.
        record.expectedTier = IServiceRegistry.Tier.Curated;

        verified = verify(record);
    }

    /// @notice Asserts a deployment record against the chain.
    /// @dev Reads no environment and holds no key, so the test suite drives it against an in-memory tree.
    /// @param record The deployment as recorded.
    /// @return verified Always true. Every failure reverts with the mismatch named.
    function verify(DeploymentRecord memory record) public view returns (bool verified) {
        _verifyWiring(record);
        _verifyConstants(record);
        _verifyRegistrySnapshot(record);
        verified = true;
    }

    // ------------------------------------------------------------------ wiring

    /// @notice Asserts the four constructor immutables and the five one-shot slots, from both ends.
    /// @param record The deployment as recorded.
    function _verifyWiring(DeploymentRecord memory record) internal view {
        SettlementVerifier verifier = SettlementVerifier(record.settlementVerifier);
        AgentRegistry agents = AgentRegistry(record.agentRegistry);
        TabBook book = TabBook(record.tabBook);
        Bond bond = Bond(record.bond);

        _sameAddress("SettlementVerifier.SERVICES", record.serviceRegistry, address(verifier.SERVICES()));
        _sameAddress("SettlementVerifier.AGENTS", record.agentRegistry, address(verifier.AGENTS()));
        _sameAddress("SettlementVerifier.TAB_BOOK", record.tabBook, address(verifier.TAB_BOOK()));
        _sameAddress("SettlementVerifier.BOND", record.bond, address(verifier.BOND()));

        _sameAddress(
            "AgentRegistry.settlementVerifier", record.settlementVerifier, agents.settlementVerifier()
        );
        _sameAddress("TabBook.settlementVerifier", record.settlementVerifier, book.settlementVerifier());
        _sameAddress("TabBook.watcher", record.watcherAddress, book.watcher());
        _sameAddress("Bond.tabBook", record.tabBook, bond.tabBook());
        _sameAddress("Bond.settlementVerifier", record.settlementVerifier, bond.settlementVerifier());

        _sameAddress("TabBook.REGISTRY", record.serviceRegistry, address(book.REGISTRY()));
        _sameAddress("TabBook.BOND", record.bond, address(book.BOND()));
        _sameValue("TabBook.BASELINE", record.baseline, book.BASELINE());
        _sameValue("TabBook.GROWTH_FACTOR_BPS", record.growthFactorBps, book.GROWTH_FACTOR_BPS());

        // The wiring authority is one account across all three, which is what makes step 4 a single
        // signer's single opportunity rather than three independent ones.
        address authority = agents.WIRING_AUTHORITY();
        _sameAddress("TabBook.WIRING_AUTHORITY", authority, book.WIRING_AUTHORITY());
        _sameAddress("Bond.WIRING_AUTHORITY", authority, bond.WIRING_AUTHORITY());

        _heading("Wiring");
        _report("wiringAuthority", authority);
        _report("Watcher        ", record.watcherAddress);
        console.log("all nine wired slots agree from both ends");
    }

    // ------------------------------------------------------------------ constants

    /// @notice Asserts the Settlement signatures, the accepted chainKeys, the precompile, and the hold.
    /// @param record The deployment as recorded.
    function _verifyConstants(DeploymentRecord memory record) internal view {
        SettlementVerifier verifier = SettlementVerifier(record.settlementVerifier);
        ServiceRegistry registry = ServiceRegistry(record.serviceRegistry);

        _sameWord(
            "ERC20_TRANSFER_SIG",
            keccak256("Transfer(address,address,uint256)"),
            verifier.ERC20_TRANSFER_SIG()
        );
        _sameWord(
            "TAB_SETTLED_SIG",
            keccak256("TabSettled(address,address,uint256,bytes32)"),
            verifier.TAB_SETTLED_SIG()
        );
        _sameValue("CHAIN_KEY_SEPOLIA", CHAIN_KEY_SEPOLIA, verifier.CHAIN_KEY_SEPOLIA());
        _sameValue("CHAIN_KEY_MAINNET", CHAIN_KEY_MAINNET, verifier.CHAIN_KEY_MAINNET());
        _sameAddress("SettlementVerifier.VERIFIER", record.blockProver, address(verifier.VERIFIER()));

        _sameAddress(
            "ServiceRegistry.curationAuthority", record.curationAuthority, registry.curationAuthority()
        );
        // 48 hours, in seconds. Every change to an applied registry fact waits it out. (R11.6)
        _sameValue("ServiceRegistry.timelock", 48 hours, registry.timelock());

        _heading("Signatures and bounds");
        console.log("Transfer(address,address,uint256)          topic matches");
        console.log("TabSettled(address,address,uint256,bytes32) topic matches");
        _report("BlockProver Precompile", record.blockProver);
        console.log("registry timelock (seconds)", registry.timelock());
    }

    // ------------------------------------------------------------------ registry snapshot

    /// @notice Asserts the Service record, the emitters, and every collection including the Bond ones.
    /// @param record The deployment as recorded.
    function _verifyRegistrySnapshot(DeploymentRecord memory record) internal view {
        ServiceRegistry registry = ServiceRegistry(record.serviceRegistry);

        if (registry.serviceCount() == 0) revert NoServiceRegistered();

        // `serviceOf` reverts `UnknownService` when the identifier holds no record, which is already a
        // legible failure, so there is no `exists` branch below it to write.
        IServiceRegistry.Service memory service = registry.serviceOf(PROOF_SERVICE_ID);
        if (service.tier != record.expectedTier) {
            revert TierMismatch(uint8(record.expectedTier), uint8(service.tier));
        }
        _sameValue(
            "priceOf(sepoliaUsdc)",
            record.price,
            registry.priceOf(PROOF_SERVICE_ID, record.sepoliaUsdc, PROOF_SERVICE_TOOL)
        );
        _sameValue(
            "priceOf(mainnetUsdc)",
            record.price,
            registry.priceOf(PROOF_SERVICE_ID, record.mainnetUsdc, PROOF_SERVICE_TOOL)
        );

        _verifyEmitters(registry, record);
        _verifyCollections(registry, record);

        _heading("Registry snapshot");
        _report("Service operator ", service.operator);
        _report("Bond account     ", service.bondAccount);
        console.log(
            "tier                       ",
            service.tier == IServiceRegistry.Tier.Curated ? "Curated" : "Permissionless"
        );
        console.log("Settlement Window (seconds)", service.settlementWindow);
        console.log("registered Services        ", registry.serviceCount());
    }

    /// @notice Asserts both USDC emitters, and the settlement contract on chainKey 1 alone.
    /// @param registry The registry.
    /// @param record The deployment as recorded.
    function _verifyEmitters(ServiceRegistry registry, DeploymentRecord memory record) internal view {
        _expectEmitter(registry, CHAIN_KEY_SEPOLIA, record.sepoliaUsdc, IServiceRegistry.EmitterKind.Asset);
        _expectEmitter(registry, CHAIN_KEY_MAINNET, record.mainnetUsdc, IServiceRegistry.EmitterKind.Asset);
        _expectEmitter(
            registry,
            CHAIN_KEY_SEPOLIA,
            record.sepoliaSettlement,
            IServiceRegistry.EmitterKind.SettlementContract
        );

        // And not on Mainnet. The pair is the unit of authorisation, so this query is the one that
        // demonstrates it: the same address, one chain over, is a stranger.
        if (registry.emitterFor(CHAIN_KEY_MAINNET, record.sepoliaSettlement).authorised) {
            revert EmitterAuthorisedOnWrongChain(CHAIN_KEY_MAINNET, record.sepoliaSettlement);
        }
        _sameValue(
            "emitterChainMask(TabSettlement)",
            uint256(1) << CHAIN_KEY_SEPOLIA,
            registry.emitterChainMask(record.sepoliaSettlement)
        );
    }

    /// @notice Asserts the two tab collections and the two Bond collections, kind included.
    /// @dev The Bond pair is the assertion task 12.1 names explicitly, and it is the reason this
    /// function reads `kind` rather than only `exists`.
    /// @param registry The registry.
    /// @param record The deployment as recorded.
    function _verifyCollections(ServiceRegistry registry, DeploymentRecord memory record) internal view {
        _expectCollection(
            registry,
            CHAIN_KEY_SEPOLIA,
            record.serviceCollection,
            record.sepoliaUsdc,
            IServiceRegistry.CollectionKind.Tab
        );
        _expectCollection(
            registry,
            CHAIN_KEY_MAINNET,
            record.serviceCollection,
            record.mainnetUsdc,
            IServiceRegistry.CollectionKind.Tab
        );
        _expectCollection(
            registry,
            CHAIN_KEY_SEPOLIA,
            record.bondCollection,
            record.sepoliaUsdc,
            IServiceRegistry.CollectionKind.Bond
        );
        _expectCollection(
            registry,
            CHAIN_KEY_MAINNET,
            record.bondCollection,
            record.mainnetUsdc,
            IServiceRegistry.CollectionKind.Bond
        );

        _heading("Collections");
        _report("tab, chainKey 1 and 3 ", record.serviceCollection);
        _report("Bond, chainKey 1 and 3", record.bondCollection);
        console.log("both Bond records resolve with CollectionKind.Bond");
    }

    // ------------------------------------------------------------------ assertions

    /// @notice Asserts one emitter is authorised on one chain with one kind.
    /// @param registry The registry.
    /// @param chainKey Attested-chain identifier to query.
    /// @param emitter Address to query.
    /// @param expected Kind the record must carry.
    function _expectEmitter(
        ServiceRegistry registry,
        uint64 chainKey,
        address emitter,
        IServiceRegistry.EmitterKind expected
    ) internal view {
        IServiceRegistry.EmitterRecord memory found = registry.emitterFor(chainKey, emitter);
        if (!found.authorised) revert EmitterNotAuthorised(chainKey, emitter);
        if (found.kind != expected) {
            revert EmitterKindMismatch(chainKey, emitter, uint8(expected), uint8(found.kind));
        }
    }

    /// @notice Asserts one Collection Address resolves to the Proof Service, one Asset, and one kind.
    /// @param registry The registry.
    /// @param chainKey Attested-chain identifier to query.
    /// @param collection Address to query.
    /// @param asset Asset the record must name.
    /// @param expected Kind the record must carry.
    function _expectCollection(
        ServiceRegistry registry,
        uint64 chainKey,
        address collection,
        address asset,
        IServiceRegistry.CollectionKind expected
    ) internal view {
        IServiceRegistry.CollectionRecord memory found = registry.collectionFor(chainKey, collection);
        if (!found.exists || found.serviceId != PROOF_SERVICE_ID || found.asset != asset) {
            revert CollectionUnresolved(chainKey, collection);
        }
        if (found.kind != expected) {
            revert CollectionKindMismatch(chainKey, collection, uint8(expected), uint8(found.kind));
        }
    }

    /// @notice Asserts two addresses are the same, naming the slot when they are not.
    /// @param what Name of the slot.
    /// @param expected Recorded address.
    /// @param actual Address the chain answered with.
    function _sameAddress(string memory what, address expected, address actual) internal pure {
        if (expected != actual) revert AddressMismatch(what, expected, actual);
    }

    /// @notice Asserts two numbers are the same, naming the value when they are not.
    /// @param what Name of the value.
    /// @param expected Recorded value.
    /// @param actual Value the chain answered with.
    function _sameValue(string memory what, uint256 expected, uint256 actual) internal pure {
        if (expected != actual) revert ValueMismatch(what, expected, actual);
    }

    /// @notice Asserts two words are the same, naming the constant when they are not.
    /// @param what Name of the constant.
    /// @param expected Value this repository computes.
    /// @param actual Value the deployed bytecode holds.
    function _sameWord(string memory what, bytes32 expected, bytes32 actual) internal pure {
        if (expected != actual) revert WordMismatch(what, expected, actual);
    }
}
