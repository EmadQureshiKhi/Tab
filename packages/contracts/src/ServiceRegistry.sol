// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title IServiceRegistry
/// @notice Read and write surface of the Service registry: which Services exist, which
/// `(chainKey, emitterAddress)` pairs are authorised to produce Settlements, which Collection Address
/// resolves to which Service and Asset, what each named tool costs in Asset base units, which curation
/// tier a Service holds, and how long its Settlement Window is.
/// @dev Declared here beside the implementation rather than under `src/interfaces/`, because that
/// directory holds the two precompile ABIs that were confirmed against the live chain and is frozen.
/// Consumers depend on this type by ABI, not by import path.
///
/// The timelock half of the surface — `queueChange`, `applyChange`, `cancelChange` — sits below the
/// registration writes. Every mutation of an already-applied fact goes through it, and the reads are
/// untouched by it: a queued change lives in its own record and reaches the tables the reads answer
/// from only when it is applied, so the previously applied value is what every read serves for the
/// whole hold. (R11.6, R11.7)
///
/// Requirements: 2.2, 5.2, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 16.4, 18.3
interface IServiceRegistry {
    // ------------------------------------------------------------------ types

    /// @notice Curation tier of a Service. (R11.2, R11.3)
    /// @dev `Permissionless` is the zero value, so an unwritten record cannot read as `Curated`: the
    /// tier that carries Credit Limit weight is never the default of uninitialised storage.
    enum Tier {
        Permissionless,
        Curated
    }

    /// @notice What kind of Source Chain contract an authorised emitter is.
    /// @dev `None` is the zero value, so an unauthorised pair decodes as a kind that matches no
    /// Settlement signature. `Asset` is an ERC-20 whose own `Transfer` event is the Settlement.
    /// `SettlementContract` is a Tab-authored contract whose `TabSettled` event is the Settlement.
    enum EmitterKind {
        None,
        Asset,
        SettlementContract
    }

    /// @notice What a Collection Address collects for. (R14.1, R18.6)
    /// @dev `Tab` is the zero value, so every record written before this enumeration existed reads as
    /// what it was: an ordinary Service Collection Address whose Settlements reduce an Open Tab. `Bond`
    /// marks the protocol Bond Collection Address of one Service, and a proven deposit to it credits
    /// stake instead of a tab.
    ///
    /// The distinction lives on the collection record rather than in a second mapping because the
    /// settlement path has exactly one place where a recipient becomes a meaning. A Bond deposit and a
    /// tab payment are the same shape of `Transfer` to a registered address, so without a field here
    /// the crediting step has nothing to branch on and a Bond deposit would land on whichever Service
    /// claimed that address as prepaid credit on its own tab. Keeping the kind on the one record also
    /// keeps per-chain uniqueness doing the work it already did: an address is claimed once, so it is
    /// never both kinds at once.
    enum CollectionKind {
        Tab,
        Bond
    }

    /// @notice The registry facts that may only change behind the timelock. (R11.6)
    enum ChangeKind {
        Tier,
        Price,
        Collection,
        AcceptedAsset,
        SettlementWindow
    }

    /// @notice One registered Service.
    /// @dev Field order is the wire order for every consumer that decodes this struct, so it matches
    /// the design's declaration exactly and is not rearranged for packing.
    struct Service {
        /// @dev Creditcoin address that registered the Service and may queue its changes.
        address operator;
        /// @dev Curation tier. `Permissionless` on registration; `Curated` only behind the timelock.
        Tier tier;
        /// @dev Settlement Window in seconds, in the range 1 to 86400 inclusive. (R16.4)
        uint32 settlementWindow;
        /// @dev Party key this Service's stake sits under inside `Bond`. (R11.1)
        address bondAccount;
        /// @dev Creditcoin timestamp of registration.
        uint64 registeredAt;
        /// @dev True once the record has been written, so a zeroed record is distinguishable.
        bool exists;
    }

    /// @notice Authorisation record of one `(chainKey, emitterAddress)` pair.
    /// @dev Not per Service. An Asset contract is shared by every Service that accepts that Asset on
    /// that chain, so the emitter table answers "may this contract on this chain produce Settlements
    /// at all", and the collection table answers "which Service does this particular Settlement
    /// belong to". Splitting the two is what lets many Services accept one Asset without any of them
    /// owning the Asset contract. (R5.2)
    struct EmitterRecord {
        /// @dev Which Settlement signature this emitter is allowed to produce.
        EmitterKind kind;
        /// @dev Asset the Settlement is denominated in. For `kind == Asset` this equals the emitter.
        address asset;
        /// @dev True when this exact `(chainKey, emitterAddress)` pair is authorised.
        bool authorised;
    }

    /// @notice Resolution record of one Collection Address on one chain.
    /// @dev This is the map an incoming Settlement is credited through: a `Transfer` or `TabSettled`
    /// log names a recipient, and this record turns that recipient into a Service and an Asset. (R2.3)
    struct CollectionRecord {
        /// @dev Service that receives credit for Settlements paid to this address.
        bytes32 serviceId;
        /// @dev Asset this address collects. Exactly one Asset per address per chain.
        address asset;
        /// @dev Attested-chain identifier this record applies to.
        uint64 chainKey;
        /// @dev True once the record has been written.
        bool exists;
        /// @dev Whether Settlements to this address reduce an Open Tab or credit Bond stake. Appended
        /// after `exists` so a reader decoding the prefix of an older record still reads it correctly,
        /// and zero-valued at `Tab` so an older record's absent field means what that record meant.
        CollectionKind kind;
    }

    /// @notice A registry change waiting out its hold. (R11.6)
    /// @dev The reason every read function in the implementation reads applied state only: a queued
    /// change lives here as an opaque payload and is copied into the live tables at application time,
    /// never before. (R11.7)
    struct PendingChange {
        /// @dev Service the change applies to.
        bytes32 serviceId;
        /// @dev Which registry fact the payload rewrites.
        ChangeKind kind;
        /// @dev Kind-specific arguments, abi-encoded.
        bytes payload;
        /// @dev Creditcoin timestamp from which the change may be applied.
        uint64 eta;
        /// @dev True while the change is neither applied nor cancelled.
        bool open;
    }

    // ------------------------------------------------------------------ events

    /// @notice A Service was registered. (R11.1, R11.2)
    /// @param serviceId Identifier of the new Service.
    /// @param operator Creditcoin address that registered it.
    /// @param tier Curation tier assigned at registration, always `Permissionless`.
    /// @param settlementWindow Stored Settlement Window in seconds.
    event ServiceRegistered(
        bytes32 indexed serviceId, address indexed operator, Tier tier, uint32 settlementWindow
    );

    /// @notice A `(chainKey, emitterAddress)` pair became authorised. (R5.2)
    /// @dev Emitted so the emitter table is reconstructable from logs alone. `emitterFor` is keyed by
    /// an address a reader must already know, so without this event a stranger could not enumerate
    /// what is authorised, and the keyless reproduction path would need an indexer to exist.
    /// @param chainKey Attested-chain identifier the authorisation applies to.
    /// @param emitter Source Chain contract address that is now authorised on that chain.
    /// @param kind Which Settlement signature the emitter may produce.
    /// @param asset Asset its Settlements are denominated in.
    event EmitterAuthorised(
        uint64 indexed chainKey, address indexed emitter, EmitterKind kind, address asset
    );

    /// @notice A Collection Address was claimed by a Service for one Asset on one chain. (R2.2)
    /// @dev Emitted for the same reason as {EmitterAuthorised}: it makes the collection table
    /// enumerable off chain without an indexer.
    /// @param serviceId Service that owns the address.
    /// @param chainKey Attested-chain identifier the claim applies to.
    /// @param collection The Collection Address claimed.
    /// @param asset Asset that address collects.
    /// @param kind Whether the address collects for a tab or for the Service's Bond. (R14.1)
    event CollectionRegistered(
        bytes32 indexed serviceId,
        uint64 indexed chainKey,
        address indexed collection,
        address asset,
        CollectionKind kind
    );

    /// @notice A price was recorded for one Service, Asset, and named tool, in Asset base units. (R18.3)
    /// @param serviceId Service the price belongs to.
    /// @param asset Asset the price is denominated in.
    /// @param tool Named tool the price applies to.
    /// @param baseUnits Price as an integer count of that Asset's smallest unit.
    event ToolPriceSet(
        bytes32 indexed serviceId, address indexed asset, bytes32 indexed tool, uint256 baseUnits
    );

    /// @notice A registry change entered its hold. (R11.6)
    /// @param changeId Identifier of the queued change.
    /// @param serviceId Service the change applies to.
    /// @param kind Which registry fact the payload rewrites.
    /// @param payload Kind-specific arguments, abi-encoded.
    /// @param eta Creditcoin timestamp from which the change may be applied.
    event RegistryChangeQueued(
        bytes32 indexed changeId, bytes32 indexed serviceId, ChangeKind kind, bytes payload, uint64 eta
    );

    /// @notice A queued registry change was applied. (R11.6)
    /// @param changeId Identifier of the applied change.
    /// @param serviceId Service the change applied to.
    /// @param kind Which registry fact the payload rewrote.
    /// @param payload Kind-specific arguments, abi-encoded.
    event RegistryChangeApplied(
        bytes32 indexed changeId, bytes32 indexed serviceId, ChangeKind kind, bytes payload
    );

    /// @notice A queued registry change was withdrawn before application.
    /// @param changeId Identifier of the cancelled change.
    /// @param serviceId Service the change would have applied to.
    event RegistryChangeCancelled(bytes32 indexed changeId, bytes32 indexed serviceId);

    /// @notice A Collection Address stopped resolving to a Service. (R11.6)
    /// @dev The counterpart of {CollectionRegistered}, emitted when an applied `Collection` change
    /// moves a Service off one address and onto another. Without it the collection table would stop
    /// being reconstructable from logs the first time an address moved, since a reader replaying
    /// {CollectionRegistered} alone would still believe the old address resolves.
    /// @param serviceId Service that held the address.
    /// @param chainKey Attested-chain identifier the record applied to.
    /// @param collection The Collection Address that no longer resolves.
    event CollectionReleased(bytes32 indexed serviceId, uint64 indexed chainKey, address indexed collection);

    // ------------------------------------------------------------------ errors

    /// @notice This `serviceId` is already registered.
    /// @param serviceId The identifier already in use.
    error ServiceExists(bytes32 serviceId);

    /// @notice No Service is registered under this identifier.
    /// @param serviceId The identifier with no record.
    error UnknownService(bytes32 serviceId);

    /// @notice The caller does not operate this Service.
    /// @param serviceId Service whose operator was required.
    /// @param caller The rejected caller.
    error NotServiceOperator(bytes32 serviceId, address caller);

    /// @notice The caller is not the curation authority.
    /// @param caller The rejected caller.
    error NotCurationAuthority(address caller);

    /// @notice This Collection Address is already claimed on this chain. (R2.2)
    /// @param chainKey Attested-chain identifier of the claim.
    /// @param collection The contested address.
    /// @param heldBy Service that already holds it.
    error CollectionAddressTaken(uint64 chainKey, address collection, bytes32 heldBy);

    /// @notice This `(chainKey, emitterAddress)` pair is already authorised for a different kind or a
    /// different Asset, so the two claims cannot both be true.
    /// @param emitter The contested Source Chain address.
    /// @param chainKey Attested-chain identifier of the contested authorisation.
    error EmitterChainConflict(address emitter, uint64 chainKey);

    /// @notice The queued change is still inside its hold. (R11.6)
    /// @param changeId Identifier of the queued change.
    /// @param eta Creditcoin timestamp from which it may be applied.
    error TimelockPending(bytes32 changeId, uint64 eta);

    /// @notice The requested Settlement Window is longer than the registry permits. (R16.4)
    /// @param seconds_ The rejected duration in seconds. Trailing underscore because `seconds` is a
    /// reserved unit denomination.
    /// @param maximum Longest duration accepted.
    error SettlementWindowOutOfRange(uint32 seconds_, uint32 maximum);

    /// @notice This Service has no price registered for this Asset and tool.
    /// @param serviceId Service that was queried.
    /// @param asset Asset that was queried.
    /// @param tool Named tool that was queried.
    error UnknownTool(bytes32 serviceId, address asset, bytes32 tool);

    /// @notice Two parallel registration arrays disagree on length.
    /// @param expected Length implied by the arrays already read.
    /// @param provided Length actually supplied.
    error ArrayLengthMismatch(uint256 expected, uint256 provided);

    /// @notice A tool was offered at zero base units.
    /// @dev Rejected so that a registered price is always non-zero, which is what makes an absent
    /// entry in the price table distinguishable from a free tool and lets {UnknownTool} mean exactly
    /// one thing. A tool that costs nothing is not metered and belongs outside the price list.
    /// @param serviceId Service the price would have belonged to.
    /// @param asset Asset the price would have been denominated in.
    /// @param tool The named tool.
    error ZeroToolPrice(bytes32 serviceId, address asset, bytes32 tool);

    /// @notice A registration supplied no accepted Asset. (R11.1)
    /// @param serviceId Service that would have had no Collection Address at all.
    error NoAcceptedAsset(bytes32 serviceId);

    /// @notice An Asset or Collection Address field was the zero address.
    /// @dev A zero Collection Address would make a burn transfer creditable, and a zero Asset would
    /// denominate a tab in nothing.
    error ZeroAddressField();

    /// @notice The `chainKey` is too large to be represented in the authorisation bitmask.
    /// @param chainKey The rejected attested-chain identifier.
    /// @param maximum Largest identifier the bitmask can carry.
    error ChainKeyOutOfMaskRange(uint64 chainKey, uint64 maximum);

    /// @notice Enumeration ran past the end of the Service list.
    /// @param index The requested position.
    /// @param count Number of registered Services.
    error ServiceIndexOutOfBounds(uint256 index, uint256 count);

    /// @notice No open change is queued under this identifier. (R11.6)
    /// @dev Also what an already-applied or already-cancelled identifier reports, because a change
    /// record is deleted the moment it stops being pending: there is exactly one state in which a
    /// change is actionable, and every other state answers the same way.
    /// @param changeId The identifier with no open change.
    error UnknownChange(bytes32 changeId);

    /// @notice The payload is not the length this change kind requires. (R11.6)
    /// @dev Checked at queue time, so a malformed payload is rejected immediately rather than 48
    /// hours later.
    /// @param kind Change kind the payload was offered for.
    /// @param length Length actually supplied, in bytes.
    error InvalidChangePayload(ChangeKind kind, uint256 length);

    /// @notice The payload named a tier outside the enumeration. (R11.3)
    /// @param tier The rejected raw value.
    error InvalidTier(uint256 tier);

    /// @notice This Service does not hold this Collection Address on this chain.
    /// @dev Raised by a `Collection` change, which moves a Service from an address it holds to a new
    /// one. A Service cannot move an address it never claimed, and cannot move another Service's.
    /// @param chainKey Attested-chain identifier of the record.
    /// @param collection The address the change tried to move away from.
    /// @param serviceId Service that claimed to hold it.
    error CollectionNotHeld(uint64 chainKey, address collection, bytes32 serviceId);

    // ------------------------------------------------------------------ writes

    /// @notice Register a Service, permissionlessly, in the Permissionless Tier. (R11.1, R11.2)
    /// @param serviceId Identifier the caller claims for the Service.
    /// @param chainKeys Attested-chain identifier of each accepted Asset entry.
    /// @param assets Asset contract address of each entry, on the chain at the same position.
    /// @param collections Collection Address that receives that Asset, on that chain.
    /// @param tools Named tools this Service meters.
    /// @param prices Price of each tool in each Asset's base units, Asset-major.
    /// @param settlementWindow Settlement Window in seconds, or zero to take the registry default.
    function registerService(
        bytes32 serviceId,
        uint64[] calldata chainKeys,
        address[] calldata assets,
        address[] calldata collections,
        bytes32[] calldata tools,
        uint256[] calldata prices,
        uint32 settlementWindow
    ) external;

    /// @notice Authorise a Tab-authored settlement contract as an emitter on exactly one chain. (R5.2)
    /// @param serviceId Service whose operator is making the authorisation.
    /// @param chainKey Attested-chain identifier the authorisation applies to, and only that one.
    /// @param emitter Address of the settlement contract on that chain.
    /// @param asset Asset the contract transfers when it emits a Settlement.
    function registerSettlementEmitter(bytes32 serviceId, uint64 chainKey, address emitter, address asset)
        external;

    /// @notice Claim the address this Service's Bond is funded at, on one chain, for one Asset. (R14.1)
    /// @param serviceId Service whose operator is making the claim.
    /// @param chainKey Attested-chain identifier the Bond deposit will be paid on.
    /// @param asset Asset the stake is denominated in, which is the Asset the deposit transfers.
    /// @param collection Address the deposit is paid to.
    function registerBondCollection(bytes32 serviceId, uint64 chainKey, address asset, address collection)
        external;

    // ------------------------------------------------------------------ timelock

    /// @notice Put a change to an applied registry fact into its 48-hour hold. (R11.6)
    /// @dev Nothing about the live tables moves here. The payload is stored as supplied and the reads
    /// keep answering with the previously applied values until {applyChange} lands. (R11.7)
    ///
    /// Payload encodings, one per kind:
    ///  - `Tier`: `abi.encode(uint256 tier)`, `0` Permissionless or `1` Curated. (R11.3)
    ///  - `Price`: `abi.encode(address asset, bytes32 tool, uint256 baseUnits)`. (R18.3)
    ///  - `Collection`: `abi.encode(uint256 chainKey, address from, address to)`, moving the Service
    ///    from an address it already holds to an unclaimed one, carrying the same Asset. (R2.2)
    ///  - `AcceptedAsset`: `abi.encode(uint256 chainKey, address asset, address collection)`, adding
    ///    an accepted Asset with the address that collects it. (R5.2)
    ///  - `SettlementWindow`: `abi.encode(uint256 seconds_)`, zero taking the registry default. (R16.4)
    /// @param serviceId Service the change applies to.
    /// @param kind Which registry fact the payload rewrites.
    /// @param payload Kind-specific arguments, abi-encoded as above.
    /// @return changeId Identifier to apply or cancel the change under.
    /// @return eta Creditcoin timestamp from which the change may be applied.
    function queueChange(bytes32 serviceId, ChangeKind kind, bytes calldata payload)
        external
        returns (bytes32 changeId, uint64 eta);

    /// @notice Write a queued change into the applied tables, once its hold has elapsed. (R11.6, R11.7)
    /// @param changeId Identifier the change was queued under.
    function applyChange(bytes32 changeId) external;

    /// @notice Withdraw a queued change, leaving every applied value as it was.
    /// @param changeId Identifier the change was queued under.
    function cancelChange(bytes32 changeId) external;

    /// @notice The change queued under an identifier, if one is still pending. (R11.6)
    /// @param changeId Identifier to read.
    /// @return change The pending change, all-zero once it is applied or cancelled.
    function pendingChangeOf(bytes32 changeId) external view returns (PendingChange memory change);

    /// @notice How long every queued change is held before it may be applied. (R11.6)
    /// @return seconds_ The hold in seconds.
    function timelock() external view returns (uint64 seconds_);

    // ------------------------------------------------------------------ reads

    /// @notice Authorisation record of one `(chainKey, emitterAddress)` pair. (R5.2)
    /// @param chainKey Attested-chain identifier of the Settlement being authenticated.
    /// @param emitter Address that emitted the Settlement log.
    /// @return record The pair's record, all-zero when the pair is not authorised.
    function emitterFor(uint64 chainKey, address emitter) external view returns (EmitterRecord memory record);

    /// @notice Which chains an emitter address is authorised on, as a bitmask.
    /// @param emitter Address that emitted the Settlement log.
    /// @return mask Bit `i` set means the pair `(i, emitter)` is authorised. Zero means nowhere.
    function emitterChainMask(address emitter) external view returns (uint64 mask);

    /// @notice Resolution record of one Collection Address on one chain. (R2.3)
    /// @param chainKey Attested-chain identifier of the Settlement being credited.
    /// @param collection Recipient address named by the Settlement log.
    /// @return record The address's record, all-zero when no Service has claimed it.
    function collectionFor(uint64 chainKey, address collection)
        external
        view
        returns (CollectionRecord memory record);

    /// @notice Curation tier of a Service. (R11.3)
    /// @param serviceId Service to read.
    /// @return tier The applied tier.
    function tierOf(bytes32 serviceId) external view returns (Tier tier);

    /// @notice Settlement Window of a Service, in seconds. (R16.4)
    /// @param serviceId Service to read.
    /// @return seconds_ The applied window.
    function settlementWindowOf(bytes32 serviceId) external view returns (uint32 seconds_);

    /// @notice Price of one named tool, in base units of one Asset. (R18.3)
    /// @param serviceId Service to read.
    /// @param asset Asset the price is denominated in.
    /// @param tool Named tool to price.
    /// @return baseUnits Integer count of that Asset's smallest unit.
    function priceOf(bytes32 serviceId, address asset, bytes32 tool) external view returns (uint256 baseUnits);

    /// @notice Full record of a Service.
    /// @param serviceId Service to read.
    /// @return service The applied record.
    function serviceOf(bytes32 serviceId) external view returns (Service memory service);

    /// @notice How many Services are registered.
    /// @return count Number of registered Services.
    function serviceCount() external view returns (uint256 count);

    /// @notice The identifier at one position in registration order.
    /// @param index Position to read, from zero.
    /// @return serviceId Identifier at that position.
    function serviceIdAt(uint256 index) external view returns (bytes32 serviceId);
}

/// @title ServiceRegistry
/// @notice The registry of Services, of the Source Chain emitters authorised to produce their
/// Settlements, of the Collection Addresses those Settlements are paid to, of the integer price of
/// every metered tool, and of each Service's curation tier and Settlement Window.
/// @dev Registration is permissionless and immediate. Every mutation of an already-applied fact —
/// tier, price list, Collection Address, accepted Asset, Settlement Window — goes through the 48-hour
/// hold instead, and there is no second path to any of them. (R11.6)
///
/// Two shapes in here carry the weight of the whole file, and each is argued at its declaration:
///
///  1. `_emitters` is keyed by the **pair** `(chainKey, emitterAddress)`, never by the address alone.
///  2. `_collections` makes a Collection Address globally unique per chain, so crediting an incoming
///     Settlement is never ambiguous.
///
/// Storage is shaped so that the timelock touches no read: every read below answers from an applied
/// table and consults no pending state, and a queued change is held out of band in `_changes` as an
/// opaque payload. Serving previously applied values during a hold therefore requires no branch in
/// the readers — it is what they already do, because a change inside its hold has not been written to
/// the tables they read. The invariant is structural rather than defended by a condition, which is
/// what makes it hard to regress. (R11.7)
///
/// Requirements: 2.2, 5.2, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 16.4, 18.3
contract ServiceRegistry is IServiceRegistry {
    // ------------------------------------------------------------------ constants

    /// @notice Hold every queued registry change must sit out before it may be applied. (R11.6)
    /// @dev Declared here because it is a property of the registry rather than of the function that
    /// reads it, and because an Agent reasoning about a Service it depends on needs the number to be
    /// readable from the same place the tier is.
    uint64 internal constant TIMELOCK = 48 hours;

    /// @notice Length of a change payload carrying one abi-encoded argument, in bytes.
    /// @dev The `Tier` and `SettlementWindow` kinds. Exact rather than minimum, so a payload with
    /// trailing bytes is rejected instead of silently decoded from its prefix.
    uint256 internal constant PAYLOAD_ONE_WORD = 32;

    /// @notice Length of a change payload carrying three abi-encoded arguments, in bytes.
    /// @dev The `Price`, `Collection`, and `AcceptedAsset` kinds.
    uint256 internal constant PAYLOAD_THREE_WORDS = 96;

    /// @notice Longest Settlement Window the registry accepts. (R16.4)
    /// @dev A window at or under 24 hours keeps the proof material for a Settlement inside the
    /// dense-attestation regime, where proving costs run at roughly a tenth of the sparse-checkpoint
    /// regime. A longer window would let a Service quietly push its own Agents' Settlements into the
    /// expensive regime, so the bound is a registry rule rather than a recommendation.
    uint32 internal constant MAX_SETTLEMENT_WINDOW = 24 hours;

    /// @notice Settlement Window applied when a registration supplies zero.
    /// @dev Zero is read as "no preference" rather than rejected, so the common registration carries
    /// one fewer decision. Six hours sits an order of magnitude above the worst observed attestation
    /// wait and well inside the 24-hour bound.
    uint32 internal constant DEFAULT_SETTLEMENT_WINDOW = 6 hours;

    /// @notice Largest `chainKey` the authorisation bitmask can represent.
    /// @dev {emitterChainMask} answers in a single `uint64`, so bit positions run 0 to 63. A larger
    /// identifier is rejected at registration rather than silently shifted out, because a shift past
    /// the width would leave an authorised emitter reporting a mask of zero — that is, reporting
    /// "authorised nowhere", which is exactly the answer that turns a cross-chain attack into a
    /// harmless skip.
    uint64 internal constant MAX_CHAIN_KEY = 63;

    // ------------------------------------------------------------------ storage

    /// @notice Address permitted to promote a Service into the Curated Tier. (D14)
    /// @dev A single address, which a multisig satisfies. It holds no power over metering, tabs, or
    /// Bonds: curation gates Credit Limit weight only. (R11.4, R11.5)
    address public curationAuthority;

    /// @notice serviceId => the applied Service record.
    mapping(bytes32 => Service) internal _services;

    /// @notice chainKey => emitter address => authorisation record.
    /// @dev **The `(chainKey, emitterAddress)` pair is the unit of authorisation, and the address
    /// alone is never enough.** The network attests two chains, and the same address can hold a
    /// different contract on each: an ERC-20 deployed from the same account with the same nonce lands
    /// at the same address on both, and a deployer can place whatever it likes at an address of its
    /// choosing on a testnet, because it controls that testnet deployment entirely.
    ///
    /// The failure mode this nested mapping prevents is concrete. Authorise on the emitter alone, and
    /// a party that wants credit it has not paid for deploys its own token to the address of the real
    /// Asset on a chain whose blocks are cheap to fill, mints itself any balance, transfers to a
    /// registered Collection Address, and submits the proof. The proof is genuine — the transaction
    /// really is in an attested block of a really attested chain — so nothing downstream of
    /// verification can tell the difference. The Settlement is then credited as if real money had
    /// moved on the chain where the Asset has value, and the Agent's Credit Limit grows on it.
    ///
    /// Keying by the pair closes that path at the only point where it can be closed: the registry
    /// says that this contract is a Settlement emitter *on this chain*, and a proof carrying any other
    /// `chainKey` fails to match the record, no matter which address it names. (R5.1, R5.2)
    mapping(uint64 => mapping(address => EmitterRecord)) internal _emitters;

    /// @notice emitter address => bitmask of the chains that address is authorised on.
    /// @dev The companion read to `_emitters`, and the reason a cross-chain attempt is distinguishable
    /// from an unrelated log: see {emitterChainMask}.
    mapping(address => uint64) internal _emitterChainMask;

    /// @notice chainKey => Collection Address => resolution record.
    /// @dev **A Collection Address resolves to exactly one Service and one Asset per chain, across
    /// every Service in the registry.** This map is how an incoming `Transfer` becomes a credit: the
    /// log names a recipient, and this record names who to credit and in what. If two Services could
    /// claim one address for one Asset, an arriving Settlement would resolve to two possible Services
    /// and the registry would have no principled way to choose, so the tab that got reduced would
    /// depend on iteration order rather than on what the payer paid for. Registration therefore
    /// rejects the second claim outright with {CollectionAddressTaken}. Uniqueness holds per chain and
    /// per address, which is strictly stronger than the per-Asset rule it implements, and the extra
    /// strength is what lets the `TabSettled` handler recover the Asset from the recipient alone.
    /// (R2.2, R2.3)
    mapping(uint64 => mapping(address => CollectionRecord)) internal _collections;

    /// @notice serviceId => asset => tool => price in that Asset's base units.
    /// @dev Integer base units per named tool, and nothing else: no percentage, no rate, no decimal,
    /// no conversion. USDC carries six decimals, so `10_000` here is one cent. Metering multiplies
    /// this by a unit count, which keeps every amount in the system an exact integer of the Asset the
    /// Settlement will arrive in and leaves no place for a price feed to be needed. (R18.1, R18.3)
    ///
    /// A registered price is always non-zero, enforced at write time, so absence from this map is
    /// distinguishable from a tool that costs nothing.
    mapping(bytes32 => mapping(address => mapping(bytes32 => uint256))) internal _prices;

    /// @notice changeId => the queued change.
    /// @dev The only place a queued change lives. It is copied into the applied tables when it is
    /// applied and nowhere else, so the reads below keep answering with previously applied values for
    /// the whole hold without knowing the timelock exists. (R11.7)
    mapping(bytes32 => PendingChange) internal _changes;

    /// @notice Count of changes ever queued, used to make each `changeId` distinct.
    /// @dev Without it, queueing the identical payload for the identical Service twice in one block
    /// would hash to one identifier and the second call would silently overwrite the first. Mixing a
    /// monotonic count into the hash makes two identical requests two changes, which is what a caller
    /// correcting a mistake by re-queueing expects.
    uint256 internal _changeNonce;

    /// @notice Every registered identifier, in registration order.
    /// @dev Present so the registry is enumerable by a stranger holding no key and running no
    /// indexer: {serviceCount} and {serviceIdAt} together walk the whole set from public reads.
    bytes32[] internal _serviceIds;

    // ------------------------------------------------------------------ construction

    /// @notice Binds the curation authority.
    /// @param curationAuthority_ Address permitted to promote a Service into the Curated Tier.
    constructor(address curationAuthority_) {
        if (curationAuthority_ == address(0)) revert ZeroAddressField();
        curationAuthority = curationAuthority_;
    }

    // ------------------------------------------------------------------ registration

    /// @notice Register a Service, permissionlessly, in the Permissionless Tier. (R11.1, R11.2)
    /// @dev Open to any Creditcoin address, with no allowlist and no fee, because the tier system is
    /// what makes that safe: a newly registered Service may meter and hold tabs immediately, and its
    /// Verified Settlements carry a Credit Limit weight of zero until the curation authority promotes
    /// it behind the hold. Registration therefore grants the ability to be paid, never the ability to
    /// manufacture credit. (R11.2, R11.4)
    ///
    /// The three chain-keyed arrays are parallel: entry `i` says that on chain `chainKeys[i]`, this
    /// Service accepts `assets[i]` and collects it at `collections[i]`. Each entry authorises the
    /// Asset contract as an `EmitterKind.Asset` emitter on that chain and claims that Collection
    /// Address, which is exactly the pair-plus-collection record the settlement path reads back.
    ///
    /// Prices are Asset-major and flattened: `prices[i * tools.length + j]` is the price of
    /// `tools[j]` in `assets[i]`. A single flat array with one price per tool could not express
    /// per-Asset pricing, and per-Asset pricing is not optional — two Assets have two different
    /// smallest units, and the system converts between Assets nowhere. (R18.1, R18.2)
    ///
    /// Repeated tools resolve to the last price given. A repeated `(chainKey, asset)` entry is
    /// idempotent in the emitter table and needs its own Collection Address, since a second claim on
    /// one address reverts.
    /// @param serviceId Identifier the caller claims for the Service.
    /// @param chainKeys Attested-chain identifier of each accepted Asset entry.
    /// @param assets Asset contract address of each entry, on the chain at the same position.
    /// @param collections Collection Address that receives that Asset, on that chain.
    /// @param tools Named tools this Service meters.
    /// @param prices Price of each tool in each Asset's base units, Asset-major.
    /// @param settlementWindow Settlement Window in seconds, or zero to take the registry default.
    function registerService(
        bytes32 serviceId,
        uint64[] calldata chainKeys,
        address[] calldata assets,
        address[] calldata collections,
        bytes32[] calldata tools,
        uint256[] calldata prices,
        uint32 settlementWindow
    ) external {
        // The body is four calls rather than one block on purpose. Seven parameters, four of them
        // dynamic arrays, leave very little of the stack for locals, and the arity checks, the Service
        // record, the emitter and collection claims, and the price rows each need their own working
        // set. Splitting them keeps every frame shallow enough to compile without the alternative
        // code generator, which the project does not turn on for a registration path.
        _checkArity(
            serviceId, chainKeys.length, assets.length, collections.length, tools.length, prices.length
        );
        _writeService(serviceId, settlementWindow);
        _claimEntries(serviceId, chainKeys, assets, collections);
        _writePrices(serviceId, assets, tools, prices);
    }

    /// @notice Authorise a Tab-authored settlement contract as an emitter on exactly one chain. (R5.2)
    /// @dev Separate from {registerService} for two reasons. A settlement contract is deployed after
    /// the Service that will read its events, so its address is not known at registration time; and
    /// its record is not self-describing, because the Asset it transfers is a different contract from
    /// the emitter itself. The second point is why this call is gated on the Service operator while
    /// registration is not: an unauthenticated writer could otherwise bind an emitter address to an
    /// Asset it does not transfer.
    ///
    /// One call authorises one chain. Authorising the same address on a second chain takes a second
    /// call, deliberately, so a settlement contract on a testnet cannot ride in on a registration
    /// intended for the chain where the Asset has value.
    /// @param serviceId Service whose operator is making the authorisation.
    /// @param chainKey Attested-chain identifier the authorisation applies to, and only that one.
    /// @param emitter Address of the settlement contract on that chain.
    /// @param asset Asset the contract transfers when it emits a Settlement.
    function registerSettlementEmitter(bytes32 serviceId, uint64 chainKey, address emitter, address asset)
        external
    {
        Service storage service = _services[serviceId];
        if (!service.exists) revert UnknownService(serviceId);
        if (service.operator != msg.sender) revert NotServiceOperator(serviceId, msg.sender);

        _authoriseEmitter(chainKey, emitter, EmitterKind.SettlementContract, asset);
    }

    /// @notice Claim the address this Service's Bond is funded at, on one chain, for one Asset. (R14.1)
    /// @dev A separate write rather than a fourth array on {registerService}, for two reasons that both
    /// point the same way. Accepting an Asset for tabs and nominating the address stake is paid to are
    /// different acts — the first says what an Agent may be charged in, the second says where the
    /// Service's own collateral arrives — and a Service that has been registered for months may post a
    /// Bond for the first time today, so the address is frequently not known at registration.
    ///
    /// Gated on the Service operator, unlike registration's own collection claims, because this record
    /// decides where stake credited under this Service's party key comes from. Registration's claims
    /// are safe unauthenticated only because an unclaimed address plus a self-describing Asset emitter
    /// can only record the truth; a Bond claim additionally names whose ledger grows.
    ///
    /// The claim goes through the same {_claimCollection} path every other collection uses, so the
    /// per-chain uniqueness rule covers it unchanged: an address already claimed for a tab cannot be
    /// re-claimed as a Bond address, and the reverse holds too. The Asset is authorised as an emitter
    /// here as well, idempotently, so a Service may fund its Bond in an Asset on a chain it does not
    /// otherwise accept.
    /// @param serviceId Service whose operator is making the claim.
    /// @param chainKey Attested-chain identifier the Bond deposit will be paid on.
    /// @param asset Asset the stake is denominated in, which is the Asset the deposit transfers.
    /// @param collection Address the deposit is paid to.
    function registerBondCollection(bytes32 serviceId, uint64 chainKey, address asset, address collection)
        external
    {
        Service storage service = _services[serviceId];
        if (!service.exists) revert UnknownService(serviceId);
        if (service.operator != msg.sender) revert NotServiceOperator(serviceId, msg.sender);

        _authoriseEmitter(chainKey, asset, EmitterKind.Asset, asset);
        _claimCollection(serviceId, chainKey, collection, asset, CollectionKind.Bond);
    }

    // ------------------------------------------------------------------ timelock

    /// @inheritdoc IServiceRegistry
    /// @dev Writes the payload and the deadline, and nothing else. No applied table is touched here,
    /// which is the whole of R11.7: there is no live value to restore on cancellation and no window in
    /// which a reader could observe a half-applied change, because the change is not in the tables the
    /// readers read until {applyChange} puts it there.
    ///
    /// The payload is validated now rather than at application time, so a caller learns that its
    /// arguments are malformed immediately instead of two days later. What is checked here is only
    /// what cannot drift: lengths, the tier enumeration, the window bound, the chain-key bound, and
    /// the zero-address and zero-price rules. Whether a Collection Address is still unclaimed is not
    /// among them, so that check belongs to application, where the answer is the current one.
    function queueChange(bytes32 serviceId, ChangeKind kind, bytes calldata payload)
        external
        returns (bytes32 changeId, uint64 eta)
    {
        _authoriseChange(serviceId, kind);
        _previewChange(serviceId, kind, payload);

        // casting to 'uint64' is safe because a Creditcoin timestamp in seconds plus two days stays
        // far below 2^64 for the lifetime of the chain.
        // forge-lint: disable-next-line(unsafe-typecast)
        eta = uint64(block.timestamp) + TIMELOCK;
        changeId = keccak256(abi.encode(serviceId, kind, payload, eta, _changeNonce++));

        _changes[changeId] =
            PendingChange({serviceId: serviceId, kind: kind, payload: payload, eta: eta, open: true});

        emit RegistryChangeQueued(changeId, serviceId, kind, payload, eta);
    }

    /// @inheritdoc IServiceRegistry
    /// @dev The boundary is `block.timestamp >= eta`, so a change queued at `t` is applicable from
    /// `t + 48 hours` exactly and reverts at every second before it. `at least 48 hours` in R11.6 is a
    /// floor on the wait, not a window: a change left queued past its `eta` stays applicable, because
    /// an expiring change would hand anyone who could delay one transaction the power to cancel it.
    ///
    /// The record is deleted before the write, so a handler that reverts takes the deletion with it
    /// and the change stays queued. That matters for the two kinds whose application can fail on
    /// state that moved during the hold: a Collection Address claimed by somebody else in the interim
    /// leaves the change re-appliable once the conflict clears, rather than burning it.
    function applyChange(bytes32 changeId) external {
        PendingChange memory change = _changes[changeId];
        if (!change.open) revert UnknownChange(changeId);

        // Reading `block.timestamp` is sound here for the reason it is sound for any multi-day hold:
        // validator drift is seconds against 48 hours, so it cannot move a change across the boundary
        // by an amount that means anything, and there is no shorter clock on Creditcoin to prefer.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < change.eta) revert TimelockPending(changeId, change.eta);

        _authoriseChange(change.serviceId, change.kind);

        delete _changes[changeId];
        _writeChange(change.serviceId, change.kind, change.payload);

        emit RegistryChangeApplied(changeId, change.serviceId, change.kind, change.payload);
    }

    /// @inheritdoc IServiceRegistry
    /// @dev Callable at any point in the hold and after it, by whoever could have queued the change.
    /// Cancellation restores nothing because it undoes nothing: the applied tables were never written.
    function cancelChange(bytes32 changeId) external {
        PendingChange memory change = _changes[changeId];
        if (!change.open) revert UnknownChange(changeId);

        _authoriseChange(change.serviceId, change.kind);

        delete _changes[changeId];

        emit RegistryChangeCancelled(changeId, change.serviceId);
    }

    /// @notice Check that the caller may queue, apply, or cancel a change of this kind. (R11.4, R11.5)
    /// @dev Two authorities, split on exactly one line. A tier is the curation authority's to set and
    /// no operator's, because tier is what gives a Service's Verified Settlements Credit Limit weight,
    /// and a Service able to promote itself could mint its own Agents' credit. Everything else is the
    /// operator's own business — its prices, its addresses, its window — and the curation authority
    /// holds no power over any of it.
    ///
    /// The same gate guards application and cancellation, not only queueing. Applying is not merely
    /// mechanical: the payload was fixed at queue time, but *when* it lands is a decision, and for a
    /// Collection Address move the moment of landing is when Settlements to the old address stop being
    /// creditable.
    /// @param serviceId Service the change applies to.
    /// @param kind Which registry fact the change rewrites.
    function _authoriseChange(bytes32 serviceId, ChangeKind kind) internal view {
        Service storage service = _services[serviceId];
        if (!service.exists) revert UnknownService(serviceId);

        if (kind == ChangeKind.Tier) {
            if (msg.sender != curationAuthority) revert NotCurationAuthority(msg.sender);
        } else if (service.operator != msg.sender) {
            revert NotServiceOperator(serviceId, msg.sender);
        }
    }

    /// @notice Decode a payload and check everything about it that cannot change during the hold.
    /// @dev Shares its decoders with {_writeChange}, so the rules a queue-time rejection enforces are
    /// the same rules, in the same lines, that application enforces. Two copies would let the two
    /// drift, and a payload accepted at queue time but rejected 48 hours later is the worst failure
    /// this path could have.
    /// @param serviceId Service the change applies to.
    /// @param kind Which registry fact the payload rewrites.
    /// @param payload Kind-specific arguments, abi-encoded.
    function _previewChange(bytes32 serviceId, ChangeKind kind, bytes memory payload) internal view {
        if (kind == ChangeKind.Tier) {
            _expectLength(kind, payload.length, PAYLOAD_ONE_WORD);
            _decodeTier(payload);
        } else if (kind == ChangeKind.Price) {
            _expectLength(kind, payload.length, PAYLOAD_THREE_WORDS);
            _decodePrice(serviceId, payload);
        } else if (kind == ChangeKind.Collection) {
            _expectLength(kind, payload.length, PAYLOAD_THREE_WORDS);
            _decodeMove(serviceId, payload);
        } else if (kind == ChangeKind.AcceptedAsset) {
            _expectLength(kind, payload.length, PAYLOAD_THREE_WORDS);
            _decodeEntry(payload);
        } else {
            _expectLength(kind, payload.length, PAYLOAD_ONE_WORD);
            _decodeWindow(payload);
        }
    }

    /// @notice Write an applied change into the live tables. (R11.6)
    /// @dev Reached only from {applyChange}, only after the hold, and only after the same decoders
    /// {_previewChange} ran have accepted the payload once already.
    /// @param serviceId Service the change applies to.
    /// @param kind Which registry fact the payload rewrites.
    /// @param payload Kind-specific arguments, abi-encoded.
    function _writeChange(bytes32 serviceId, ChangeKind kind, bytes memory payload) internal {
        if (kind == ChangeKind.Tier) {
            _services[serviceId].tier = _decodeTier(payload);
        } else if (kind == ChangeKind.Price) {
            (address asset, bytes32 tool, uint256 baseUnits) = _decodePrice(serviceId, payload);
            _setToolPrice(serviceId, asset, tool, baseUnits);
        } else if (kind == ChangeKind.Collection) {
            _moveCollection(serviceId, payload);
        } else if (kind == ChangeKind.AcceptedAsset) {
            _addAcceptedAsset(serviceId, payload);
        } else {
            _services[serviceId].settlementWindow = _decodeWindow(payload);
        }
    }

    /// @notice Move a Service from one Collection Address to another on one chain. (R2.2, R11.6)
    /// @dev The old record is released and the new one claimed in one step, carrying the Asset the old
    /// record named, so a move cannot quietly redenominate what an address collects. The release is
    /// what keeps the per-chain uniqueness rule intact: leaving the old record in place would give one
    /// Service two addresses for one Asset and a stranger no way to tell which one is current.
    ///
    /// The kind travels with the Asset, and for the same reason. A move that reset the kind to its zero
    /// value would turn a Service's Bond Collection Address into an ordinary tab collection the moment
    /// its operator rotated the address, so the next proven deposit would arrive as prepaid credit on
    /// that Service's own tab instead of as stake. Carrying it across is what keeps a move a move.
    /// (R14.1)
    /// @param serviceId Service being moved.
    /// @param payload `abi.encode(uint256 chainKey, address from, address to)`.
    function _moveCollection(bytes32 serviceId, bytes memory payload) internal {
        (uint64 chainKey, address from, address to, address asset, CollectionKind kind) =
            _decodeMove(serviceId, payload);

        delete _collections[chainKey][from];
        emit CollectionReleased(serviceId, chainKey, from);

        _claimCollection(serviceId, chainKey, to, asset, kind);
    }

    /// @notice Accept one more Asset on one chain, with the address that collects it. (R5.2, R11.6)
    /// @param serviceId Service accepting the Asset.
    /// @param payload `abi.encode(uint256 chainKey, address asset, address collection)`.
    function _addAcceptedAsset(bytes32 serviceId, bytes memory payload) internal {
        (uint64 chainKey, address asset, address collection) = _decodeEntry(payload);

        _authoriseEmitter(chainKey, asset, EmitterKind.Asset, asset);
        // Accepting an Asset is a statement about what an Agent may be charged in, so the address it
        // names collects for a tab. Nominating a Bond Collection Address is {registerBondCollection}.
        _claimCollection(serviceId, chainKey, collection, asset, CollectionKind.Tab);
    }

    // ------------------------------------------------------------------ payload decoding

    /// @notice Reject a payload that is not the exact length its kind requires.
    /// @param kind Change kind the payload was offered for.
    /// @param actual Length supplied, in bytes.
    /// @param expected Length required, in bytes.
    function _expectLength(ChangeKind kind, uint256 actual, uint256 expected) internal pure {
        if (actual != expected) revert InvalidChangePayload(kind, actual);
    }

    /// @notice Decode a `Tier` payload. (R11.3)
    /// @param payload `abi.encode(uint256 tier)`.
    /// @return tier The requested tier.
    function _decodeTier(bytes memory payload) internal pure returns (Tier tier) {
        uint256 raw = abi.decode(payload, (uint256));
        if (raw > uint256(Tier.Curated)) revert InvalidTier(raw);
        tier = Tier(raw);
    }

    /// @notice Decode a `SettlementWindow` payload. (R16.4)
    /// @dev Zero takes the registry default, exactly as registration does, so the meaning of zero is
    /// one thing across the whole contract rather than two.
    /// @param payload `abi.encode(uint256 seconds_)`.
    /// @return window The window to apply, in seconds.
    function _decodeWindow(bytes memory payload) internal pure returns (uint32 window) {
        uint256 raw = abi.decode(payload, (uint256));
        // Clamped rather than truncated, so an absurd request is reported as out of range instead of
        // wrapping into a plausible one.
        // casting to 'uint32' is safe because the ternary reaches the cast only on the branch where
        // `raw` is already within the 32-bit range.
        // forge-lint: disable-next-line(unsafe-typecast)
        window = raw > type(uint32).max ? type(uint32).max : uint32(raw);
        if (window == 0) window = DEFAULT_SETTLEMENT_WINDOW;
        if (window > MAX_SETTLEMENT_WINDOW) revert SettlementWindowOutOfRange(window, MAX_SETTLEMENT_WINDOW);
    }

    /// @notice Decode a `Price` payload. (R18.3)
    /// @param serviceId Service the price belongs to, carried only so a rejection can name it.
    /// @param payload `abi.encode(address asset, bytes32 tool, uint256 baseUnits)`.
    /// @return asset Asset the price is denominated in.
    /// @return tool Named tool being priced.
    /// @return baseUnits Integer count of that Asset's smallest unit.
    function _decodePrice(bytes32 serviceId, bytes memory payload)
        internal
        pure
        returns (address asset, bytes32 tool, uint256 baseUnits)
    {
        (asset, tool, baseUnits) = abi.decode(payload, (address, bytes32, uint256));
        if (asset == address(0)) revert ZeroAddressField();
        if (baseUnits == 0) revert ZeroToolPrice(serviceId, asset, tool);
    }

    /// @notice Decode an `AcceptedAsset` payload. (R5.2)
    /// @param payload `abi.encode(uint256 chainKey, address asset, address collection)`.
    /// @return chainKey Attested-chain identifier the entry applies to.
    /// @return asset Asset being accepted.
    /// @return collection Address that collects it.
    function _decodeEntry(bytes memory payload)
        internal
        pure
        returns (uint64 chainKey, address asset, address collection)
    {
        uint256 rawChainKey;
        (rawChainKey, asset, collection) = abi.decode(payload, (uint256, address, address));
        chainKey = _decodeChainKey(rawChainKey);
        if (asset == address(0) || collection == address(0)) revert ZeroAddressField();
    }

    /// @notice Decode a `Collection` payload and resolve the Asset the move carries. (R2.2)
    /// @param serviceId Service the move applies to.
    /// @param payload `abi.encode(uint256 chainKey, address from, address to)`.
    /// @return chainKey Attested-chain identifier the move applies to.
    /// @return from Address the Service holds today.
    /// @return to Address it will hold instead.
    /// @return asset Asset the held record names, carried across unchanged.
    /// @return kind Whether the held record collects for a tab or a Bond, carried across unchanged.
    function _decodeMove(bytes32 serviceId, bytes memory payload)
        internal
        view
        returns (uint64 chainKey, address from, address to, address asset, CollectionKind kind)
    {
        uint256 rawChainKey;
        (rawChainKey, from, to) = abi.decode(payload, (uint256, address, address));
        chainKey = _decodeChainKey(rawChainKey);
        if (to == address(0)) revert ZeroAddressField();

        CollectionRecord storage held = _collections[chainKey][from];
        if (!held.exists || held.serviceId != serviceId) {
            revert CollectionNotHeld(chainKey, from, serviceId);
        }
        asset = held.asset;
        kind = held.kind;
    }

    /// @notice Narrow a raw payload word to a chain identifier the emitter bitmask can carry.
    /// @param raw The decoded word.
    /// @return chainKey The identifier, guaranteed at or below {MAX_CHAIN_KEY}.
    function _decodeChainKey(uint256 raw) internal pure returns (uint64 chainKey) {
        // casting to 'uint64' is safe because the ternary reaches the cast only on the branch where
        // `raw` is already within the 64-bit range, and the clamped branch reverts immediately below.
        // forge-lint: disable-next-line(unsafe-typecast)
        chainKey = raw > type(uint64).max ? type(uint64).max : uint64(raw);
        if (chainKey > MAX_CHAIN_KEY) revert ChainKeyOutOfMaskRange(chainKey, MAX_CHAIN_KEY);
    }

    // ------------------------------------------------------------------ internal writes

    /// @notice Check that a registration is unclaimed and that its parallel arrays line up.
    /// @dev Lengths only, taken as plain integers rather than as the arrays themselves, so this check
    /// costs nothing in calldata pointers. The price arity is the product, because prices are
    /// Asset-major: one row of `toolCount` prices per accepted Asset entry.
    /// @param serviceId Identifier the caller claims.
    /// @param entryCount Number of accepted Asset entries.
    /// @param assetCount Length of the Asset array.
    /// @param collectionCount Length of the Collection Address array.
    /// @param toolCount Number of named tools.
    /// @param priceCount Length of the price array.
    function _checkArity(
        bytes32 serviceId,
        uint256 entryCount,
        uint256 assetCount,
        uint256 collectionCount,
        uint256 toolCount,
        uint256 priceCount
    ) internal view {
        if (_services[serviceId].exists) revert ServiceExists(serviceId);
        if (entryCount == 0) revert NoAcceptedAsset(serviceId);
        if (assetCount != entryCount) revert ArrayLengthMismatch(entryCount, assetCount);
        if (collectionCount != entryCount) revert ArrayLengthMismatch(entryCount, collectionCount);

        uint256 expectedPrices = entryCount * toolCount;
        if (priceCount != expectedPrices) revert ArrayLengthMismatch(expectedPrices, priceCount);
    }

    /// @notice Write the Service record and add it to the enumeration. (R11.1, R11.2, R16.4)
    /// @param serviceId Identifier the caller claims.
    /// @param settlementWindow Requested window in seconds, or zero to take the registry default.
    function _writeService(bytes32 serviceId, uint32 settlementWindow) internal {
        uint32 window = settlementWindow == 0 ? DEFAULT_SETTLEMENT_WINDOW : settlementWindow;
        if (window > MAX_SETTLEMENT_WINDOW) revert SettlementWindowOutOfRange(window, MAX_SETTLEMENT_WINDOW);

        _services[serviceId] = Service({
            operator: msg.sender,
            // Every registration lands in the Permissionless Tier. Promotion is a curation action
            // behind the hold, so no caller can register itself into credit weight. (R11.2)
            tier: Tier.Permissionless,
            settlementWindow: window,
            // The registrant is the party key its stake sits under inside `Bond`, which keeps the Bond
            // reference and the authority to change the Service in one place. (R11.1)
            bondAccount: msg.sender,
            // casting to 'uint64' is safe because a Creditcoin timestamp in seconds stays far below
            // 2^64 for the lifetime of the chain.
            // forge-lint: disable-next-line(unsafe-typecast)
            registeredAt: uint64(block.timestamp),
            exists: true
        });
        _serviceIds.push(serviceId);

        emit ServiceRegistered(serviceId, msg.sender, Tier.Permissionless, window);
    }

    /// @notice Authorise each accepted Asset as an emitter and claim its Collection Address.
    /// @dev An Asset emitter is self-describing: the contract that emits the `Transfer` *is* the Asset,
    /// so a permissionless claim here can only ever record the truth about that pair. That is why this
    /// path needs no authority while {registerSettlementEmitter} does.
    /// @param serviceId Service being registered.
    /// @param chainKeys Attested-chain identifier of each entry.
    /// @param assets Asset contract address of each entry.
    /// @param collections Collection Address of each entry.
    function _claimEntries(
        bytes32 serviceId,
        uint64[] calldata chainKeys,
        address[] calldata assets,
        address[] calldata collections
    ) internal {
        for (uint256 i = 0; i < chainKeys.length; ++i) {
            _authoriseEmitter(chainKeys[i], assets[i], EmitterKind.Asset, assets[i]);
            // Every registration entry is a tab collection. A Bond Collection Address is claimed by
            // {registerBondCollection} instead, so registration cannot nominate one by accident.
            _claimCollection(serviceId, chainKeys[i], collections[i], assets[i], CollectionKind.Tab);
        }
    }

    /// @notice Write the price of every named tool in every accepted Asset. (R18.3)
    /// @dev Asset-major indexing: the price of `tools[j]` in `assets[i]` is `prices[i * toolCount + j]`.
    /// @param serviceId Service being registered.
    /// @param assets Asset contract address of each entry.
    /// @param tools Named tools this Service meters.
    /// @param prices Prices in Asset base units, Asset-major.
    function _writePrices(
        bytes32 serviceId,
        address[] calldata assets,
        bytes32[] calldata tools,
        uint256[] calldata prices
    ) internal {
        uint256 toolCount = tools.length;
        for (uint256 i = 0; i < assets.length; ++i) {
            for (uint256 j = 0; j < toolCount; ++j) {
                _setToolPrice(serviceId, assets[i], tools[j], prices[i * toolCount + j]);
            }
        }
    }

    /// @notice Record that one `(chainKey, emitterAddress)` pair may produce Settlements.
    /// @dev Idempotent when the pair is already authorised for the same kind and Asset, because the
    /// emitter table is shared: every Service accepting USDC on one chain names the same emitter, and
    /// the second of them to register is making the same true statement as the first. A repeat that
    /// disagrees about the kind or the Asset is a different statement, and both cannot hold, so it
    /// reverts rather than overwriting — an overwrite would let a later registration redirect the
    /// interpretation of an emitter every earlier Service already depends on.
    /// @param chainKey Attested-chain identifier the authorisation applies to.
    /// @param emitter Source Chain address being authorised.
    /// @param kind Which Settlement signature the emitter may produce.
    /// @param asset Asset its Settlements are denominated in.
    function _authoriseEmitter(uint64 chainKey, address emitter, EmitterKind kind, address asset) internal {
        if (emitter == address(0) || asset == address(0)) revert ZeroAddressField();
        if (chainKey > MAX_CHAIN_KEY) revert ChainKeyOutOfMaskRange(chainKey, MAX_CHAIN_KEY);

        EmitterRecord storage record = _emitters[chainKey][emitter];
        if (record.authorised) {
            if (record.kind != kind || record.asset != asset) revert EmitterChainConflict(emitter, chainKey);
            return;
        }

        _emitters[chainKey][emitter] = EmitterRecord({kind: kind, asset: asset, authorised: true});
        // Set the bit for this chain and leave every other bit alone, so the mask accumulates the set
        // of chains the address is authorised on rather than the most recent one.
        _emitterChainMask[emitter] |= uint64(1) << chainKey;

        emit EmitterAuthorised(chainKey, emitter, kind, asset);
    }

    /// @notice Claim one Collection Address for one Service and Asset on one chain. (R2.2)
    /// @dev The claim is exclusive and permanent for the life of the record: a second claim on the
    /// same address and chain reverts with {CollectionAddressTaken}, naming the Service that already
    /// holds it, whether or not the two claims agree about the Asset. Crediting resolves through this
    /// address, so an address held by two Services would make the credited Service ambiguous.
    /// @param serviceId Service claiming the address.
    /// @param chainKey Attested-chain identifier the claim applies to.
    /// @param collection The Collection Address being claimed.
    /// @param asset Asset that address collects.
    /// @param kind Whether Settlements here reduce an Open Tab or credit the Service's Bond. (R14.1)
    function _claimCollection(
        bytes32 serviceId,
        uint64 chainKey,
        address collection,
        address asset,
        CollectionKind kind
    ) internal {
        if (collection == address(0) || asset == address(0)) revert ZeroAddressField();

        CollectionRecord storage held = _collections[chainKey][collection];
        if (held.exists) revert CollectionAddressTaken(chainKey, collection, held.serviceId);

        _collections[chainKey][collection] = CollectionRecord({
            serviceId: serviceId, asset: asset, chainKey: chainKey, exists: true, kind: kind
        });

        emit CollectionRegistered(serviceId, chainKey, collection, asset, kind);
    }

    /// @notice Record the price of one named tool in one Asset's base units. (R18.3)
    /// @param serviceId Service the price belongs to.
    /// @param asset Asset the price is denominated in.
    /// @param tool Named tool being priced.
    /// @param baseUnits Integer count of that Asset's smallest unit. Zero is rejected.
    function _setToolPrice(bytes32 serviceId, address asset, bytes32 tool, uint256 baseUnits) internal {
        if (baseUnits == 0) revert ZeroToolPrice(serviceId, asset, tool);

        _prices[serviceId][asset][tool] = baseUnits;

        emit ToolPriceSet(serviceId, asset, tool, baseUnits);
    }

    // ------------------------------------------------------------------ reads

    /// @inheritdoc IServiceRegistry
    /// @dev Takes the chain and the address together, because either one on its own answers a
    /// different question than the settlement path is asking. An unauthorised pair returns an all-zero
    /// record rather than reverting: a log from an unrelated contract is an ordinary event that the
    /// ingestion sweep must skip and carry on past, not a fault.
    function emitterFor(uint64 chainKey, address emitter)
        external
        view
        returns (EmitterRecord memory record)
    {
        record = _emitters[chainKey][emitter];
    }

    /// @inheritdoc IServiceRegistry
    /// @dev A bitmask, in one word, on purpose. The consumer is the recognition step of the settlement
    /// path, which reaches this function only after {emitterFor} has come back unauthorised, and which
    /// then needs two things at once: whether the address is authorised anywhere at all, and which
    /// chains those are. A zero mask says "nowhere", which makes the log somebody else's event, to be
    /// skipped so the Settlements beside it in the same receipt still land. A non-zero mask says the
    /// address is a known Settlement emitter presented under the wrong chain, which is an attempt to
    /// pass an event from one chain off as an event from another, and the mask is carried into the
    /// revert so the rejection names the chains the address really is authorised on.
    ///
    /// A list of chain identifiers would answer the same question at the cost of an array allocation
    /// and a loop on that path; a count would answer "authorised anywhere" but could not name the
    /// chains for the revert. Bit `i` standing for `chainKey` `i` needs no ordering convention and no
    /// second lookup, and the registry rejects any identifier above 63 at write time so the mask can
    /// never be a lossy summary of the emitter table.
    function emitterChainMask(address emitter) external view returns (uint64 mask) {
        mask = _emitterChainMask[emitter];
    }

    /// @inheritdoc IServiceRegistry
    /// @dev Returns an all-zero record for an unclaimed address, leaving the caller to raise its own
    /// distinct error, because the settlement path treats an unknown recipient as a rejected
    /// submission while other readers treat it as an ordinary absence.
    function collectionFor(uint64 chainKey, address collection)
        external
        view
        returns (CollectionRecord memory record)
    {
        record = _collections[chainKey][collection];
    }

    /// @inheritdoc IServiceRegistry
    /// @dev Reverts for an unregistered Service rather than returning the zero tier, because
    /// `Permissionless` is a real answer about a real Service and must not double as "no such
    /// Service".
    function tierOf(bytes32 serviceId) external view returns (Tier tier) {
        Service storage service = _services[serviceId];
        if (!service.exists) revert UnknownService(serviceId);
        tier = service.tier;
    }

    /// @inheritdoc IServiceRegistry
    /// @dev Always between 1 and 86400 for a registered Service, since registration rejects anything
    /// longer and substitutes the default for zero. (R16.4)
    function settlementWindowOf(bytes32 serviceId) external view returns (uint32 seconds_) {
        Service storage service = _services[serviceId];
        if (!service.exists) revert UnknownService(serviceId);
        seconds_ = service.settlementWindow;
    }

    /// @inheritdoc IServiceRegistry
    /// @dev Reverts with {UnknownTool} rather than returning zero, so a tool this Service does not
    /// sell can never be metered as free. The distinction is available because a registered price is
    /// non-zero by construction. (R18.3)
    function priceOf(bytes32 serviceId, address asset, bytes32 tool)
        external
        view
        returns (uint256 baseUnits)
    {
        if (!_services[serviceId].exists) revert UnknownService(serviceId);
        baseUnits = _prices[serviceId][asset][tool];
        if (baseUnits == 0) revert UnknownTool(serviceId, asset, tool);
    }

    /// @inheritdoc IServiceRegistry
    /// @dev The whole applied record in one read, which is what an off-chain reader walking the
    /// registry needs: the tier, the window, the Bond reference, and the registration timestamp are
    /// otherwise four calls.
    function serviceOf(bytes32 serviceId) external view returns (Service memory service) {
        service = _services[serviceId];
        if (!service.exists) revert UnknownService(serviceId);
    }

    /// @inheritdoc IServiceRegistry
    function serviceCount() external view returns (uint256 count) {
        count = _serviceIds.length;
    }

    /// @inheritdoc IServiceRegistry
    /// @dev Returns an all-zero record rather than reverting for an identifier with nothing pending,
    /// so `open == false` is the one answer covering never-queued, applied, and cancelled alike. This
    /// is the read a Dashboard needs to show what is coming and when, and it is deliberately the only
    /// place pending state is visible: no other read consults it. (R11.7)
    function pendingChangeOf(bytes32 changeId) external view returns (PendingChange memory change) {
        change = _changes[changeId];
    }

    /// @inheritdoc IServiceRegistry
    /// @dev Published because an Agent deciding whether to keep running a tab against a Service needs
    /// to know how much notice it is guaranteed before that Service's terms can move, and reading the
    /// number off a source file is not the same as reading it off the chain. (R11.6)
    function timelock() external pure returns (uint64 seconds_) {
        seconds_ = TIMELOCK;
    }

    /// @inheritdoc IServiceRegistry
    /// @dev Paired with {serviceCount} this makes the registry enumerable from public reads alone, so
    /// reproducing what is registered takes an RPC endpoint and nothing else — no key, no indexer, and
    /// no cooperation from whoever deployed it. Out-of-range reads carry a named error rather than a
    /// bare panic, since enumeration is a normal thing for a stranger to be doing.
    function serviceIdAt(uint256 index) external view returns (bytes32 serviceId) {
        uint256 count = _serviceIds.length;
        if (index >= count) revert ServiceIndexOutOfBounds(index, count);
        serviceId = _serviceIds[index];
    }
}
