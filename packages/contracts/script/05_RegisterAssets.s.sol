// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeploymentBase} from "./DeploymentBase.sol";
import {IServiceRegistry, ServiceRegistry} from "../src/ServiceRegistry.sol";
import {console} from "forge-std/console.sol";

/// @title RegisterAssets
/// @notice Step 5. Registers the Proof Service, the USDC emitters for chainKey 1 and 3, the Sepolia
/// settlement contract as an emitter on chainKey 1 only, and the Bond Collection Address on both
/// chains.
/// @dev **The Bond Collection Address is the line this step exists for.** A Verified Settlement paid to
/// a registered address is credited according to that address's `CollectionKind`: a `Tab` address
/// reduces an Open Tab, and a `Bond` address routes the amount to `Bond.fundFromVerifiedSettlement`
/// instead. `registerService` claims every address it is given as `CollectionKind.Tab`, and there is no
/// other way to obtain a `Bond` address than `registerBondCollection`. So a deployment that registers
/// only the tab collections has no path by which stake can ever be created: every Bond ledger stays at
/// zero, `bondCap` stays at zero, every Credit Limit computed against it is zero, and no Metered
/// Delivery can be recorded against any Agent. The rail is inert, and it is inert quietly — every
/// contract is deployed, wired, and readable, and nothing reports a fault. This is the same defect
/// found live once before, at the contract layer; it is refused here at the deployment layer.
///
/// Step 7 reads the two Bond records back and asserts their kind, so the claim above is checked rather
/// than trusted.
///
/// Three further shapes are deliberate:
///
///  - **The settlement contract is authorised on chainKey 1 and only chainKey 1.** Authorising the same
///    address on a second chain takes a second call, which this script never makes. `TabSettled` is
///    then unrecognisable on Mainnet, where Tab deploys nothing and a plain `Transfer` is the only
///    Settlement shape. (R5.2, R5.3, R6.5)
///  - **One collection address serves both chains for tabs.** The collection table is keyed by
///    `(chainKey, address)`, so the same account collecting USDC on Sepolia and on Mainnet is two
///    records, not a contested one. The Bond address must nonetheless differ from the tab address,
///    because within one chain a collection claim is exclusive, and the script refuses the collision
///    by name rather than letting `CollectionAddressTaken` explain it later.
///  - **Every write here is checked for having already happened.** A registration run that halts part
///    way is resumable, which matters because `registerService` reverts `ServiceExists` on a second
///    call and would otherwise make the whole step un-rerunnable.
///
/// The Service is registered in the Permissionless Tier, which is the only tier registration can
/// assign. Promotion to the Curated Tier is a `queueChange` by the curation authority followed by an
/// `applyChange` 48 hours later, and it is not part of deployment. (R11.2, R11.6)
///
/// Run, from `packages/contracts`:
///
/// ```
/// forge script script/05_RegisterAssets.s.sol:RegisterAssets --rpc-url creditcoin --sig "run()"
/// ```
///
/// Requirements: 26.1, 26.2, 11.6
contract RegisterAssets is DeploymentBase {
    /// @notice Everything step 5 registers, in one value.
    struct Registration {
        /// @dev USDC on Ethereum Sepolia, 6 decimals.
        address sepoliaUsdc;
        /// @dev USDC on Ethereum Mainnet, 6 decimals.
        address mainnetUsdc;
        /// @dev `TabSettlement` on Ethereum Sepolia, authorised for chainKey 1 alone.
        address sepoliaSettlement;
        /// @dev Address the Proof Service collects tab Settlements at, on both chains.
        address serviceCollection;
        /// @dev Address the Proof Service's Bond is funded at, on both chains.
        address bondCollection;
        /// @dev Price of the metered tool, in Asset base units.
        uint256 price;
        /// @dev Settlement Window in seconds, or zero to take the registry default.
        uint32 settlementWindow;
    }

    /// @notice Which of step 5's writes this run made.
    struct RegistrationReport {
        /// @dev True when the Proof Service was registered by this run.
        bool serviceRegistered;
        /// @dev True when the Sepolia settlement emitter was authorised by this run.
        bool settlementEmitterAuthorised;
        /// @dev True when the chainKey 1 Bond collection was claimed by this run.
        bool bondCollectionSepolia;
        /// @dev True when the chainKey 3 Bond collection was claimed by this run.
        bool bondCollectionMainnet;
    }

    /// @notice A Bond Collection Address read back with a kind other than `Bond`.
    /// @dev Asserted immediately after the claim, in the same call, so a registry that recorded the
    /// wrong kind cannot be discovered two steps later.
    /// @param chainKey Attested-chain identifier of the record.
    /// @param collection Address that resolved wrongly.
    /// @param kind Kind actually recorded, as its raw enumeration value.
    error BondCollectionKindWrong(uint64 chainKey, address collection, uint8 kind);

    /// @notice A Collection Address is already claimed on this chain by a different Service.
    /// @param chainKey Attested-chain identifier of the record.
    /// @param collection The contested address.
    /// @param heldBy Service that holds it.
    error CollectionHeldElsewhere(uint64 chainKey, address collection, bytes32 heldBy);

    /// @notice The configured Settlement Window does not fit the registry's `uint32` field.
    /// @param seconds_ The rejected duration.
    error SettlementWindowTooLarge(uint256 seconds_);

    /// @notice Registers everything the deployment named by the environment needs.
    /// @return report Which of step 5's writes this run made.
    function run() external returns (RegistrationReport memory report) {
        _requireCreditcoinChain(vm.envUint("CREDITCOIN_CHAIN_ID"));

        address serviceRegistry =
            _requireCode("SERVICE_REGISTRY_ADDRESS", vm.envAddress("SERVICE_REGISTRY_ADDRESS"));

        Registration memory input = Registration({
            sepoliaUsdc: _requireAddress("SEPOLIA_USDC_ADDRESS", vm.envAddress("SEPOLIA_USDC_ADDRESS")),
            mainnetUsdc: _requireAddress("MAINNET_USDC_ADDRESS", vm.envAddress("MAINNET_USDC_ADDRESS")),
            sepoliaSettlement: _requireAddress(
                "SEPOLIA_SETTLEMENT_ADDRESS", vm.envAddress("SEPOLIA_SETTLEMENT_ADDRESS")
            ),
            serviceCollection: _requireAddress(
                "PROOF_SERVICE_COLLECTION_ADDRESS", vm.envAddress("PROOF_SERVICE_COLLECTION_ADDRESS")
            ),
            bondCollection: _requireAddress(
                "BOND_COLLECTION_ADDRESS", vm.envAddress("BOND_COLLECTION_ADDRESS")
            ),
            price: vm.envUint("PROOF_SERVICE_PRICE_BASE_UNITS"),
            settlementWindow: _toWindow(vm.envUint("DEFAULT_SETTLEMENT_WINDOW_S"))
        });

        vm.startBroadcast();
        report = registerAll(serviceRegistry, input);
        vm.stopBroadcast();

        _heading("Step 5 of 7 - registry");
        console.log("serviceId (short string) tab.proof-service");
        _report("tab collection ", input.serviceCollection);
        _report("Bond collection", input.bondCollection);
        _reportWrite("Proof Service registered        ", report.serviceRegistered);
        _reportWrite("Sepolia settlement emitter      ", report.settlementEmitterAuthorised);
        _reportWrite("Bond collection, chainKey 1     ", report.bondCollectionSepolia);
        _reportWrite("Bond collection, chainKey 3     ", report.bondCollectionMainnet);
    }

    /// @notice Registers the Service, the emitters, the tab collections, and the Bond collections.
    /// @dev Reads no environment and opens no broadcast. `msg.sender` becomes the Service operator and
    /// the Bond party account, and both later calls are gated on being that same account.
    /// @param serviceRegistry Address produced by step 2.
    /// @param input Everything to register.
    /// @return report Which writes this call made.
    function registerAll(address serviceRegistry, Registration memory input)
        public
        returns (RegistrationReport memory report)
    {
        _requireDistinct(
            "PROOF_SERVICE_COLLECTION_ADDRESS",
            input.serviceCollection,
            "BOND_COLLECTION_ADDRESS",
            input.bondCollection
        );
        _requireDistinct(
            "SEPOLIA_SETTLEMENT_ADDRESS", input.sepoliaSettlement, "SEPOLIA_USDC_ADDRESS", input.sepoliaUsdc
        );

        ServiceRegistry registry = ServiceRegistry(serviceRegistry);

        report.serviceRegistered = _registerProofService(registry, input);
        report.settlementEmitterAuthorised = _authoriseSettlementEmitter(registry, input);
        report.bondCollectionSepolia =
            _claimBondCollection(registry, CHAIN_KEY_SEPOLIA, input.sepoliaUsdc, input.bondCollection);
        report.bondCollectionMainnet =
            _claimBondCollection(registry, CHAIN_KEY_MAINNET, input.mainnetUsdc, input.bondCollection);
    }

    /// @notice Registers the Proof Service with its two accepted Assets and its priced tool.
    /// @dev The three chain-keyed arrays are parallel and the price array is Asset-major, so with two
    /// Assets and one tool the prices are `[price in Sepolia USDC, price in Mainnet USDC]`. Both are the
    /// same number because both Assets are USDC with 6 decimals.
    /// The already-registered probe reads the collection table rather than `serviceOf`, because
    /// `serviceOf` reverts `UnknownService` for a Service that does not exist and so cannot answer the
    /// question "does it exist". The chainKey 1 tab record is written by `registerService` and by nothing
    /// else, so its presence is the same fact, and reading it also catches an unrelated Service having
    /// claimed the address first, which is a different problem deserving its own error.
    /// @param registry The registry.
    /// @param input Everything to register.
    /// @return registered True when this call registered the Service.
    function _registerProofService(ServiceRegistry registry, Registration memory input)
        internal
        returns (bool registered)
    {
        IServiceRegistry.CollectionRecord memory tab =
            registry.collectionFor(CHAIN_KEY_SEPOLIA, input.serviceCollection);
        if (tab.exists) {
            if (tab.serviceId != PROOF_SERVICE_ID) {
                revert CollectionHeldElsewhere(CHAIN_KEY_SEPOLIA, input.serviceCollection, tab.serviceId);
            }
            return false;
        }

        uint64[] memory chainKeys = new uint64[](2);
        chainKeys[0] = CHAIN_KEY_SEPOLIA;
        chainKeys[1] = CHAIN_KEY_MAINNET;

        address[] memory assets = new address[](2);
        assets[0] = input.sepoliaUsdc;
        assets[1] = input.mainnetUsdc;

        // One account collecting on both chains. Two records, because the table is keyed by the pair.
        address[] memory collections = new address[](2);
        collections[0] = input.serviceCollection;
        collections[1] = input.serviceCollection;

        bytes32[] memory tools = new bytes32[](1);
        tools[0] = PROOF_SERVICE_TOOL;

        uint256[] memory prices = new uint256[](2);
        prices[0] = input.price;
        prices[1] = input.price;

        registry.registerService(
            PROOF_SERVICE_ID, chainKeys, assets, collections, tools, prices, input.settlementWindow
        );
        registered = true;
    }

    /// @notice Authorises `TabSettlement` as a settlement-contract emitter on chainKey 1 alone.
    /// @param registry The registry.
    /// @param input Everything to register.
    /// @return authorised True when this call authorised the emitter.
    function _authoriseSettlementEmitter(ServiceRegistry registry, Registration memory input)
        internal
        returns (bool authorised)
    {
        IServiceRegistry.EmitterRecord memory record =
            registry.emitterFor(CHAIN_KEY_SEPOLIA, input.sepoliaSettlement);
        if (record.authorised) return false;

        registry.registerSettlementEmitter(
            PROOF_SERVICE_ID, CHAIN_KEY_SEPOLIA, input.sepoliaSettlement, input.sepoliaUsdc
        );
        authorised = true;
    }

    /// @notice Claims the Bond Collection Address on one chain, then reads its kind back.
    /// @dev The read-back is not decoration. `CollectionKind.Tab` is the zero value, so a claim written
    /// through the wrong path produces a record that exists, resolves, and credits a tab — which is
    /// indistinguishable from success at every layer except this one.
    /// @param registry The registry.
    /// @param chainKey Attested-chain identifier the deposit will be paid on.
    /// @param asset Asset the stake is denominated in.
    /// @param collection Address the deposit is paid to.
    /// @return claimed True when this call claimed the address.
    function _claimBondCollection(
        ServiceRegistry registry,
        uint64 chainKey,
        address asset,
        address collection
    ) internal returns (bool claimed) {
        IServiceRegistry.CollectionRecord memory held = registry.collectionFor(chainKey, collection);
        if (held.exists) {
            if (held.serviceId != PROOF_SERVICE_ID) {
                revert CollectionHeldElsewhere(chainKey, collection, held.serviceId);
            }
            _assertBondKind(chainKey, collection, held.kind);
            return false;
        }

        registry.registerBondCollection(PROOF_SERVICE_ID, chainKey, asset, collection);
        _assertBondKind(chainKey, collection, registry.collectionFor(chainKey, collection).kind);
        claimed = true;
    }

    /// @notice Refuses a Bond Collection Address whose recorded kind is not `Bond`.
    /// @param chainKey Attested-chain identifier of the record.
    /// @param collection Address the record belongs to.
    /// @param kind Kind read back.
    function _assertBondKind(uint64 chainKey, address collection, IServiceRegistry.CollectionKind kind)
        internal
        pure
    {
        if (kind != IServiceRegistry.CollectionKind.Bond) {
            revert BondCollectionKindWrong(chainKey, collection, uint8(kind));
        }
    }

    /// @notice Narrows a configured Settlement Window to the registry's field width.
    /// @param seconds_ Duration read from the environment.
    /// @return window The same duration as a `uint32`.
    function _toWindow(uint256 seconds_) internal pure returns (uint32 window) {
        if (seconds_ > type(uint32).max) revert SettlementWindowTooLarge(seconds_);
        window = uint32(seconds_);
    }

    /// @notice Prints one write's outcome.
    /// @param label Name of the write.
    /// @param written True when this run made it.
    function _reportWrite(string memory label, bool written) internal pure {
        if (written) console.log(label, "written now");
        else console.log(label, "already present");
    }
}
