// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title IServiceRegistry
/// @notice Who may meter, what they charge, where they are paid, and how long an Agent has to settle.
interface IServiceRegistry {
    /// @notice Whether a Service's Settlement history carries Credit Limit weight.
    enum Tier {
        Permissionless,
        Curated
    }

    /// @notice The kinds of change a Service can queue behind the timelock.
    enum ChangeKind {
        Tier,
        Price,
        Collection,
        AcceptedAsset,
        SettlementWindow
    }

    struct Service {
        /// @dev The account permitted to record deliveries and queue changes.
        address operator;
        /// @dev Set by the curation authority only.
        Tier tier;
        /// @dev Seconds an Agent has, from its oldest unsettled delivery, before a tab is delinquent.
        uint32 settlementWindow;
        /// @dev The account whose `Bond` stake backs this Service.
        address bondAccount;
        /// @dev Block timestamp of registration.
        uint64 registeredAt;
        bool exists;
    }

    struct PendingChange {
        bytes32 serviceId;
        ChangeKind kind;
        bytes payload;
        uint64 eta;
        bool open;
    }

    event ServiceRegistered(
        bytes32 indexed serviceId, address indexed operator, Tier tier, uint32 settlementWindow
    );
    event CollectionRegistered(bytes32 indexed serviceId, address indexed asset, address indexed collection);
    event CollectionReleased(bytes32 indexed serviceId, address indexed asset, address indexed collection);
    event ToolPriceSet(
        bytes32 indexed serviceId, address indexed asset, bytes32 indexed tool, uint256 baseUnits
    );
    event RegistryChangeQueued(
        bytes32 indexed changeId, bytes32 indexed serviceId, ChangeKind kind, bytes payload, uint64 eta
    );
    event RegistryChangeApplied(
        bytes32 indexed changeId, bytes32 indexed serviceId, ChangeKind kind, bytes payload
    );
    event RegistryChangeCancelled(bytes32 indexed changeId, bytes32 indexed serviceId);

    error ServiceExists(bytes32 serviceId);
    error UnknownService(bytes32 serviceId);
    error NotServiceOperator(bytes32 serviceId, address caller);
    error NotCurationAuthority(address caller);
    error TimelockPending(bytes32 changeId, uint64 eta);
    error SettlementWindowOutOfRange(uint32 seconds_, uint32 maximum);
    error UnknownTool(bytes32 serviceId, address asset, bytes32 tool);
    error ArrayLengthMismatch(uint256 expected, uint256 provided);
    error ZeroToolPrice(bytes32 serviceId, address asset, bytes32 tool);
    error NoAcceptedAsset(bytes32 serviceId);
    error AssetNotAccepted(bytes32 serviceId, address asset);
    error AssetAlreadyAccepted(bytes32 serviceId, address asset);
    error ZeroAddressField();
    error ServiceIndexOutOfBounds(uint256 index, uint256 count);
    error UnknownChange(bytes32 changeId);
    error InvalidChangePayload(ChangeKind kind, uint256 length);
    error InvalidTier(uint256 tier);

    function registerService(
        bytes32 serviceId,
        address[] calldata assets,
        address[] calldata collections,
        bytes32[] calldata tools,
        uint256[] calldata prices,
        uint32 settlementWindow
    ) external;
    function queueChange(bytes32 serviceId, ChangeKind kind, bytes calldata payload)
        external
        returns (bytes32 changeId, uint64 eta);
    function applyChange(bytes32 changeId) external;
    function cancelChange(bytes32 changeId) external;

    function pendingChangeOf(bytes32 changeId) external view returns (PendingChange memory change);
    function timelock() external view returns (uint64 seconds_);
    function collectionOf(bytes32 serviceId, address asset) external view returns (address collection);
    function acceptsAsset(bytes32 serviceId, address asset) external view returns (bool accepted);
    function tierOf(bytes32 serviceId) external view returns (Tier tier);
    function settlementWindowOf(bytes32 serviceId) external view returns (uint32 seconds_);
    function priceOf(bytes32 serviceId, address asset, bytes32 tool) external view returns (uint256 baseUnits);
    function serviceOf(bytes32 serviceId) external view returns (Service memory service);
    function serviceCount() external view returns (uint256 count);
    function serviceIdAt(uint256 index) external view returns (bytes32 serviceId);
}

/// @title ServiceRegistry
/// @notice The directory of Services on Monad: operator, tier, prices, payout addresses, and
/// Settlement Window.
///
/// Registration is permissionless and a Service starts in the Permissionless Tier, where its history
/// carries no Credit Limit weight. Only the curation authority moves a Service to the Curated Tier.
/// Every change after registration, including the curation authority's own, sits behind a 48-hour
/// timelock, so an Agent that read a price or a Settlement Window has that long before either can
/// move under it.
///
/// A Service is paid directly: each accepted Asset has a Collection address that `TabSettlement`
/// transfers to. The registry stores no URL, deliberately. The chain is the billing rail, not a
/// directory of hosts.
contract ServiceRegistry is IServiceRegistry {
    // ------------------------------------------------------------------ constants

    uint64 internal constant TIMELOCK = 48 hours;
    uint256 internal constant PAYLOAD_ONE_WORD = 32;
    uint256 internal constant PAYLOAD_TWO_WORDS = 64;
    uint256 internal constant PAYLOAD_THREE_WORDS = 96;
    uint32 internal constant MAX_SETTLEMENT_WINDOW = 24 hours;
    uint32 internal constant DEFAULT_SETTLEMENT_WINDOW = 6 hours;

    // ------------------------------------------------------------------ storage

    address public curationAuthority;
    mapping(bytes32 => Service) internal _services;
    /// @dev serviceId => asset => Collection address. Zero means the Asset is not accepted.
    mapping(bytes32 => mapping(address => address)) internal _collections;
    mapping(bytes32 => mapping(address => mapping(bytes32 => uint256))) internal _prices;
    mapping(bytes32 => PendingChange) internal _changes;
    uint256 internal _changeNonce;
    bytes32[] internal _serviceIds;

    constructor(address curationAuthority_) {
        if (curationAuthority_ == address(0)) revert ZeroAddressField();
        curationAuthority = curationAuthority_;
    }

    // ------------------------------------------------------------------ registration

    /// @notice Register a Service with its accepted Assets, their Collection addresses, and a price for
    /// every tool in every Asset.
    /// @param prices Row-major: `prices[i * tools.length + j]` is the price of `tools[j]` in `assets[i]`.
    function registerService(
        bytes32 serviceId,
        address[] calldata assets,
        address[] calldata collections,
        bytes32[] calldata tools,
        uint256[] calldata prices,
        uint32 settlementWindow
    ) external {
        if (_services[serviceId].exists) revert ServiceExists(serviceId);
        if (assets.length == 0) revert NoAcceptedAsset(serviceId);
        if (collections.length != assets.length) {
            revert ArrayLengthMismatch(assets.length, collections.length);
        }
        uint256 expectedPrices = assets.length * tools.length;
        if (prices.length != expectedPrices) revert ArrayLengthMismatch(expectedPrices, prices.length);

        _writeService(serviceId, settlementWindow);
        for (uint256 i = 0; i < assets.length; ++i) {
            _acceptAsset(serviceId, assets[i], collections[i]);
        }
        uint256 toolCount = tools.length;
        for (uint256 i = 0; i < assets.length; ++i) {
            for (uint256 j = 0; j < toolCount; ++j) {
                _setToolPrice(serviceId, assets[i], tools[j], prices[i * toolCount + j]);
            }
        }
    }

    // ------------------------------------------------------------------ timelocked changes

    function queueChange(bytes32 serviceId, ChangeKind kind, bytes calldata payload)
        external
        returns (bytes32 changeId, uint64 eta)
    {
        _authoriseChange(serviceId, kind);
        _previewChange(serviceId, kind, payload);
        // casting to 'uint64' is safe because a block timestamp in seconds stays far below 2^64.
        // forge-lint: disable-next-line(unsafe-typecast)
        eta = uint64(block.timestamp) + TIMELOCK;
        changeId = keccak256(abi.encode(serviceId, kind, payload, eta, _changeNonce++));
        _changes[changeId] =
            PendingChange({serviceId: serviceId, kind: kind, payload: payload, eta: eta, open: true});
        emit RegistryChangeQueued(changeId, serviceId, kind, payload, eta);
    }

    function applyChange(bytes32 changeId) external {
        PendingChange memory change = _changes[changeId];
        if (!change.open) revert UnknownChange(changeId);
        if (block.timestamp < change.eta) revert TimelockPending(changeId, change.eta);
        _authoriseChange(change.serviceId, change.kind);
        delete _changes[changeId];
        _writeChange(change.serviceId, change.kind, change.payload);
        emit RegistryChangeApplied(changeId, change.serviceId, change.kind, change.payload);
    }

    function cancelChange(bytes32 changeId) external {
        PendingChange memory change = _changes[changeId];
        if (!change.open) revert UnknownChange(changeId);
        _authoriseChange(change.serviceId, change.kind);
        delete _changes[changeId];
        emit RegistryChangeCancelled(changeId, change.serviceId);
    }

    function _authoriseChange(bytes32 serviceId, ChangeKind kind) internal view {
        Service storage service = _services[serviceId];
        if (!service.exists) revert UnknownService(serviceId);
        if (kind == ChangeKind.Tier) {
            if (msg.sender != curationAuthority) revert NotCurationAuthority(msg.sender);
        } else if (service.operator != msg.sender) {
            revert NotServiceOperator(serviceId, msg.sender);
        }
    }

    /// @dev Decodes the payload exactly as `_writeChange` will, so a change that cannot apply is
    /// refused at queue time rather than 48 hours later.
    function _previewChange(bytes32 serviceId, ChangeKind kind, bytes memory payload) internal view {
        if (kind == ChangeKind.Tier) {
            _expectLength(kind, payload.length, PAYLOAD_ONE_WORD);
            _decodeTier(payload);
        } else if (kind == ChangeKind.Price) {
            _expectLength(kind, payload.length, PAYLOAD_THREE_WORDS);
            _decodePrice(serviceId, payload);
        } else if (kind == ChangeKind.Collection) {
            _expectLength(kind, payload.length, PAYLOAD_TWO_WORDS);
            _decodeMove(serviceId, payload);
        } else if (kind == ChangeKind.AcceptedAsset) {
            _expectLength(kind, payload.length, PAYLOAD_TWO_WORDS);
            _decodeEntry(serviceId, payload);
        } else {
            _expectLength(kind, payload.length, PAYLOAD_ONE_WORD);
            _decodeWindow(payload);
        }
    }

    function _writeChange(bytes32 serviceId, ChangeKind kind, bytes memory payload) internal {
        if (kind == ChangeKind.Tier) {
            _services[serviceId].tier = _decodeTier(payload);
        } else if (kind == ChangeKind.Price) {
            (address asset, bytes32 tool, uint256 baseUnits) = _decodePrice(serviceId, payload);
            _setToolPrice(serviceId, asset, tool, baseUnits);
        } else if (kind == ChangeKind.Collection) {
            (address asset, address to) = _decodeMove(serviceId, payload);
            address from = _collections[serviceId][asset];
            _collections[serviceId][asset] = to;
            emit CollectionReleased(serviceId, asset, from);
            emit CollectionRegistered(serviceId, asset, to);
        } else if (kind == ChangeKind.AcceptedAsset) {
            (address asset, address collection) = _decodeEntry(serviceId, payload);
            _acceptAsset(serviceId, asset, collection);
        } else {
            _services[serviceId].settlementWindow = _decodeWindow(payload);
        }
    }

    // ------------------------------------------------------------------ payload codecs

    function _expectLength(ChangeKind kind, uint256 actual, uint256 expected) internal pure {
        if (actual != expected) revert InvalidChangePayload(kind, actual);
    }

    function _decodeTier(bytes memory payload) internal pure returns (Tier tier) {
        uint256 raw = abi.decode(payload, (uint256));
        if (raw > uint256(Tier.Curated)) revert InvalidTier(raw);
        tier = Tier(raw);
    }

    function _decodeWindow(bytes memory payload) internal pure returns (uint32 window) {
        uint256 raw = abi.decode(payload, (uint256));
        // casting to 'uint32' is safe because the branch bounds `raw` to the type's range first.
        // forge-lint: disable-next-line(unsafe-typecast)
        window = raw > type(uint32).max ? type(uint32).max : uint32(raw);
        if (window == 0) window = DEFAULT_SETTLEMENT_WINDOW;
        if (window > MAX_SETTLEMENT_WINDOW) revert SettlementWindowOutOfRange(window, MAX_SETTLEMENT_WINDOW);
    }

    function _decodePrice(bytes32 serviceId, bytes memory payload)
        internal
        pure
        returns (address asset, bytes32 tool, uint256 baseUnits)
    {
        (asset, tool, baseUnits) = abi.decode(payload, (address, bytes32, uint256));
        if (asset == address(0)) revert ZeroAddressField();
        if (baseUnits == 0) revert ZeroToolPrice(serviceId, asset, tool);
    }

    /// @dev `(asset, collection)`: a new accepted Asset paid at `collection`.
    function _decodeEntry(bytes32 serviceId, bytes memory payload)
        internal
        view
        returns (address asset, address collection)
    {
        (asset, collection) = abi.decode(payload, (address, address));
        if (asset == address(0) || collection == address(0)) revert ZeroAddressField();
        if (_collections[serviceId][asset] != address(0)) revert AssetAlreadyAccepted(serviceId, asset);
    }

    /// @dev `(asset, to)`: move an already accepted Asset's Collection address to `to`.
    function _decodeMove(bytes32 serviceId, bytes memory payload)
        internal
        view
        returns (address asset, address to)
    {
        (asset, to) = abi.decode(payload, (address, address));
        if (to == address(0)) revert ZeroAddressField();
        if (_collections[serviceId][asset] == address(0)) revert AssetNotAccepted(serviceId, asset);
    }

    // ------------------------------------------------------------------ writes

    function _writeService(bytes32 serviceId, uint32 settlementWindow) internal {
        uint32 window = settlementWindow == 0 ? DEFAULT_SETTLEMENT_WINDOW : settlementWindow;
        if (window > MAX_SETTLEMENT_WINDOW) revert SettlementWindowOutOfRange(window, MAX_SETTLEMENT_WINDOW);
        _services[serviceId] = Service({
            operator: msg.sender,
            tier: Tier.Permissionless,
            settlementWindow: window,
            bondAccount: msg.sender,
            // casting to 'uint64' is safe because a block timestamp in seconds stays far below 2^64.
            // forge-lint: disable-next-line(unsafe-typecast)
            registeredAt: uint64(block.timestamp),
            exists: true
        });
        _serviceIds.push(serviceId);
        emit ServiceRegistered(serviceId, msg.sender, Tier.Permissionless, window);
    }

    function _acceptAsset(bytes32 serviceId, address asset, address collection) internal {
        if (asset == address(0) || collection == address(0)) revert ZeroAddressField();
        if (_collections[serviceId][asset] != address(0)) revert AssetAlreadyAccepted(serviceId, asset);
        _collections[serviceId][asset] = collection;
        emit CollectionRegistered(serviceId, asset, collection);
    }

    function _setToolPrice(bytes32 serviceId, address asset, bytes32 tool, uint256 baseUnits) internal {
        if (baseUnits == 0) revert ZeroToolPrice(serviceId, asset, tool);
        if (_collections[serviceId][asset] == address(0)) revert AssetNotAccepted(serviceId, asset);
        _prices[serviceId][asset][tool] = baseUnits;
        emit ToolPriceSet(serviceId, asset, tool, baseUnits);
    }

    // ------------------------------------------------------------------ views

    function collectionOf(bytes32 serviceId, address asset) external view returns (address collection) {
        if (!_services[serviceId].exists) revert UnknownService(serviceId);
        collection = _collections[serviceId][asset];
        if (collection == address(0)) revert AssetNotAccepted(serviceId, asset);
    }

    function acceptsAsset(bytes32 serviceId, address asset) external view returns (bool accepted) {
        return _collections[serviceId][asset] != address(0);
    }

    function tierOf(bytes32 serviceId) external view returns (Tier tier) {
        Service storage service = _services[serviceId];
        if (!service.exists) revert UnknownService(serviceId);
        tier = service.tier;
    }

    function settlementWindowOf(bytes32 serviceId) external view returns (uint32 seconds_) {
        Service storage service = _services[serviceId];
        if (!service.exists) revert UnknownService(serviceId);
        seconds_ = service.settlementWindow;
    }

    function priceOf(bytes32 serviceId, address asset, bytes32 tool)
        external
        view
        returns (uint256 baseUnits)
    {
        if (!_services[serviceId].exists) revert UnknownService(serviceId);
        baseUnits = _prices[serviceId][asset][tool];
        if (baseUnits == 0) revert UnknownTool(serviceId, asset, tool);
    }

    function serviceOf(bytes32 serviceId) external view returns (Service memory service) {
        service = _services[serviceId];
        if (!service.exists) revert UnknownService(serviceId);
    }

    function serviceCount() external view returns (uint256 count) {
        count = _serviceIds.length;
    }

    function pendingChangeOf(bytes32 changeId) external view returns (PendingChange memory change) {
        change = _changes[changeId];
    }

    function timelock() external pure returns (uint64 seconds_) {
        seconds_ = TIMELOCK;
    }

    function serviceIdAt(uint256 index) external view returns (bytes32 serviceId) {
        uint256 count = _serviceIds.length;
        if (index >= count) revert ServiceIndexOutOfBounds(index, count);
        serviceId = _serviceIds[index];
    }
}
