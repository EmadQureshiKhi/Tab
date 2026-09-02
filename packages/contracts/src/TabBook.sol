// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IBond} from "./Bond.sol";
import {IServiceRegistry} from "./ServiceRegistry.sol";
import {LimitLib} from "./LimitLib.sol";

/// @title ITabBook
/// @notice The ledger of Open Tabs, Settlements, and the history a Credit Limit is computed from.
interface ITabBook {
    /// @notice One Agent's account with one Service in one Asset.
    struct Tab {
        /// @dev Metered and not yet settled, in Asset base units.
        uint128 open;
        /// @dev Settled ahead of any delivery, spent before the tab is raised again.
        uint128 prepaid;
        /// @dev Timestamp of the oldest delivery still unsettled; zero when nothing is open.
        uint64 oldestUnsettledAt;
        uint64 lastDeliveryAt;
        uint32 deliveryCount;
        /// @dev Set by `markDelinquent`, cleared by the Settlement that closes the tab.
        bool delinquent;
    }

    /// @notice Reverse lookup from a tab identifier to the triple it was derived from.
    struct TabRef {
        address agent;
        bytes32 serviceId;
        address asset;
        bool exists;
    }

    /// @notice One Settlement, as applied. Recorded for audit; the history commitment is what the
    /// Credit Limit reads.
    struct Settlement {
        address agent;
        bytes32 serviceId;
        address asset;
        /// @dev Amount paid.
        uint128 amount;
        /// @dev Amount the Open Tab fell by, which is `min(amount, open)`; the rest became prepaid.
        uint128 applied;
        uint64 settledAt;
    }

    /// @notice Agent-set ceiling on what one Service may charge one tab.
    struct Authorisation {
        uint128 maxCumulative;
        uint128 spent;
        uint64 expiry;
        bool exists;
    }

    /// @notice History and Bond figures a caller supplies so `LimitLib` can stay pure.
    /// @dev Neither array is trusted. The history is folded into the same rolling hash the Settlement
    /// path writes and compared against the stored commitment, and every Bond amount is replaced with
    /// the figure read from `Bond` rather than used as supplied.
    struct LimitWitness {
        LimitLib.SettlementRecord[] history;
        LimitLib.BondEntry[] bonds;
    }

    event DeliveryRecorded(
        address indexed agent,
        bytes32 indexed serviceId,
        address indexed asset,
        bytes32 tool,
        uint32 units,
        uint256 amount,
        uint64 timestamp
    );
    event SettlementApplied(
        bytes32 indexed settlementId,
        address indexed agent,
        bytes32 indexed serviceId,
        address asset,
        uint256 applied,
        uint256 toPrepaid,
        uint128 openAfter
    );
    event HistoryExtended(
        address indexed agent,
        address indexed asset,
        bytes32 root,
        uint32 count,
        LimitLib.SettlementRecord record
    );
    event PrepaidConsumed(
        address indexed agent,
        bytes32 indexed serviceId,
        address indexed asset,
        uint128 consumed,
        uint128 prepaidAfter,
        uint128 openAdded
    );
    event TabDelinquent(
        bytes32 indexed tabId,
        address indexed agent,
        bytes32 indexed serviceId,
        address asset,
        uint128 unsettled,
        uint64 windowEnd
    );
    event TabDelinquencyCleared(bytes32 indexed tabId, address indexed agent, address indexed asset);
    event AuthorisationSet(
        address indexed agent,
        bytes32 indexed serviceId,
        address indexed asset,
        uint128 maxCumulative,
        uint64 expiry
    );
    event CreditLimitZeroed(address indexed agent, address indexed asset, bytes32 reasonTabId);
    event SettlementSurfaceWired(address indexed settlement);

    error LimitExceeded(address agent, address asset, uint256 requested, uint256 headroom);
    error AuthorisationMissing(address agent, bytes32 serviceId, address asset);
    error AuthorisationExpired(uint64 expiry, uint64 nowTs);
    error AuthorisationExceeded(uint128 maxCumulative, uint128 spent, uint256 requested);
    error TabIsDelinquent(bytes32 tabId);
    error HistoryCommitmentMismatch(bytes32 expected, bytes32 provided);
    error HistoryLengthMismatch(uint32 expected, uint256 provided);
    error NotSettlementSurface(address caller);
    error NotServiceOperator(bytes32 serviceId, address caller);
    error NotWiringAuthority(address caller);
    error AlreadyWired(address current);
    error ZeroAddressField();
    error PriceListChangedMidCall(
        bytes32 serviceId, address asset, bytes32 tool, uint256 quoted, uint256 applied
    );
    error ZeroUnits();
    error ZeroAmount();
    error AmountOutOfRange(uint256 amount);
    error UnknownTab(bytes32 tabId);
    error AlreadyDelinquent(bytes32 tabId);
    error NothingUnsettled(bytes32 tabId);
    error SettlementWindowOpen(bytes32 tabId, uint64 windowEnd);
    error DuplicateBondEntry(bytes32 serviceId);
    error IneligibleBondEntry(bytes32 serviceId, address asset);
    error TooManyBondEntries(uint256 count, uint256 maximum);

    function authorise(bytes32 serviceId, address asset, uint128 maxCumulative, uint64 expiry) external;
    function recordDelivery(
        address agent,
        bytes32 serviceId,
        address asset,
        bytes32 tool,
        uint32 units,
        uint256 expectedUnitPrice,
        LimitWitness calldata witness
    ) external returns (uint256 charged, uint128 openAfter, uint256 headroomAfter);
    function applySettlement(address agent, bytes32 serviceId, address asset, uint128 amount)
        external
        returns (bytes32 settlementId, uint128 applied, uint128 toPrepaid);
    function markDelinquent(bytes32 tabId) external;

    function tabIdOf(address agent, bytes32 serviceId, address asset) external pure returns (bytes32 tabId);
    function tabOf(bytes32 tabId) external view returns (Tab memory tab);
    function tabRefOf(bytes32 tabId) external view returns (TabRef memory ref);
    function settlementOf(bytes32 settlementId) external view returns (Settlement memory settlement);
    function settlementCount() external view returns (uint256 count);
    function assetOpen(address agent, address asset) external view returns (uint256 open);
    function historyCommitment(address agent, address asset)
        external
        view
        returns (bytes32 root, uint32 count);
    function firstDeliveryAtOf(address agent, bytes32 serviceId, address asset)
        external
        view
        returns (uint64 timestamp);
    function authorisationOf(address agent, bytes32 serviceId, address asset)
        external
        view
        returns (Authorisation memory authorisation);
    function creditLimit(address agent, address asset, LimitWitness calldata witness)
        external
        view
        returns (uint256 limit);
    function headroom(address agent, address asset, LimitWitness calldata witness)
        external
        view
        returns (uint256 available);
    function delinquentTabCount(address agent, address asset) external view returns (uint32 count);
}

/// @title TabBook
/// @notice Post-paid billing on Monad. A Service meters usage into an Agent's Open Tab, the Agent
/// settles whenever it likes, and the Credit Limit that bounds the Open Tab is a pure function of
/// the Settlements already applied here.
///
/// The book records three things and computes one. It records Metered Deliveries, which raise an Open
/// Tab; Settlements, which lower it and extend the Agent's history; and delinquency, which a
/// Settlement Window that closed with the tab still open makes anyone able to declare. It computes the
/// Credit Limit, by handing the recorded history and the counterparties' Bond stake to `LimitLib`.
///
/// The payment and the ledger entry are one transaction: `TabSettlement` moves the Asset from the
/// Agent to the Service and calls `applySettlement` in the same call, so no facilitator, oracle, or
/// off-chain process sits between the money moving and the tab falling.
///
/// Nothing in here is owned, pausable, or upgradeable. The one privileged act is a one-shot wiring
/// of the settlement surface at deployment.
contract TabBook is ITabBook {
    // ------------------------------------------------------------------ immutables

    address public immutable WIRING_AUTHORITY;
    IServiceRegistry public immutable REGISTRY;
    IBond public immutable BOND;
    /// @notice Credit extended to an Agent with no history, in Asset base units. See `LimitLib`.
    uint256 public immutable BASELINE;
    /// @notice Per-counterparty growth factor, in basis points. See `LimitLib`.
    uint256 public immutable GROWTH_FACTOR_BPS;

    // ------------------------------------------------------------------ storage

    /// @notice The one contract permitted to apply Settlements.
    address public settlementSurface;

    mapping(address => mapping(address => bytes32)) internal _historyRoot;
    mapping(address => mapping(address => uint32)) internal _historyCount;
    mapping(bytes32 => Tab) internal _tabs;
    mapping(bytes32 => TabRef) internal _tabRefs;
    mapping(address => mapping(address => uint256)) internal _assetOpen;
    mapping(address => mapping(address => uint32)) internal _delinquentTabs;
    mapping(bytes32 => Authorisation) internal _auths;
    mapping(bytes32 => uint64) internal _firstDeliveryAt;
    mapping(bytes32 => Settlement) internal _settlements;
    uint256 internal _settlementNonce;

    constructor(
        address wiringAuthority,
        address serviceRegistry,
        address bond,
        uint256 baseline,
        uint256 growthFactorBps
    ) {
        if (wiringAuthority == address(0)) revert ZeroAddressField();
        if (serviceRegistry == address(0)) revert ZeroAddressField();
        if (bond == address(0)) revert ZeroAddressField();
        WIRING_AUTHORITY = wiringAuthority;
        REGISTRY = IServiceRegistry(serviceRegistry);
        BOND = IBond(bond);
        BASELINE = baseline;
        GROWTH_FACTOR_BPS = growthFactorBps;
    }

    // ------------------------------------------------------------------ wiring

    /// @notice Wire the settlement surface. Once, at deployment, and never again.
    function setSettlementSurface(address settlement) external {
        if (msg.sender != WIRING_AUTHORITY) revert NotWiringAuthority(msg.sender);
        if (settlementSurface != address(0)) revert AlreadyWired(settlementSurface);
        if (settlement == address(0)) revert ZeroAddressField();
        settlementSurface = settlement;
        emit SettlementSurfaceWired(settlement);
    }

    // ------------------------------------------------------------------ metering

    /// @notice Cap what `serviceId` may meter to the caller's tab in `asset`, until `expiry`.
    function authorise(bytes32 serviceId, address asset, uint128 maxCumulative, uint64 expiry) external {
        if (asset == address(0)) revert ZeroAddressField();
        uint64 nowTs = _now();
        if (expiry <= nowTs) revert AuthorisationExpired(expiry, nowTs);
        _auths[tabIdOf(msg.sender, serviceId, asset)] =
            Authorisation({maxCumulative: maxCumulative, spent: 0, expiry: expiry, exists: true});
        emit AuthorisationSet(msg.sender, serviceId, asset, maxCumulative, expiry);
    }

    /// @notice A Service records that it delivered `units` of `tool` to `agent`, at the price the
    /// Agent was quoted. Prepaid credit is spent first; what remains raises the Open Tab, and only
    /// that part is tested against the Credit Limit.
    function recordDelivery(
        address agent,
        bytes32 serviceId,
        address asset,
        bytes32 tool,
        uint32 units,
        uint256 expectedUnitPrice,
        LimitWitness calldata witness
    ) external returns (uint256 charged, uint128 openAfter, uint256 headroomAfter) {
        _requireOperator(serviceId);
        _requireNotDelinquent(agent, serviceId, asset);
        charged = _charge(serviceId, asset, tool, units, expectedUnitPrice);
        _consumeAuthorisation(agent, serviceId, asset, charged);
        headroomAfter =
            _requireHeadroom(agent, asset, _openShareOf(agent, serviceId, asset, charged), witness);
        openAfter = _recordOnTab(agent, serviceId, asset, tool, units, charged);
    }

    // ------------------------------------------------------------------ settlement

    /// @notice Apply a Settlement the wired surface has already collected. Lowers the Open Tab by
    /// `min(amount, open)`, banks any excess as prepaid credit, and extends the Agent's history.
    function applySettlement(address agent, bytes32 serviceId, address asset, uint128 amount)
        external
        returns (bytes32 settlementId, uint128 applied, uint128 toPrepaid)
    {
        if (msg.sender != settlementSurface) revert NotSettlementSurface(msg.sender);
        if (agent == address(0) || asset == address(0)) revert ZeroAddressField();
        if (amount == 0) revert ZeroAmount();

        bytes32 tabId = tabIdOf(agent, serviceId, asset);
        _touchTab(tabId, agent, serviceId, asset);
        Tab storage tab = _tabs[tabId];

        applied = amount < tab.open ? amount : tab.open;
        if (applied > 0) {
            tab.open -= applied;
            _assetOpen[agent][asset] -= applied;
            if (tab.open == 0) tab.oldestUnsettledAt = 0;
        }
        toPrepaid = amount - applied;
        if (toPrepaid > 0) tab.prepaid += toPrepaid;

        settlementId = keccak256(abi.encode(block.chainid, address(this), ++_settlementNonce));
        uint64 nowTs = _now();
        _settlements[settlementId] = Settlement({
            agent: agent,
            serviceId: serviceId,
            asset: asset,
            amount: amount,
            applied: applied,
            settledAt: nowTs
        });
        emit SettlementApplied(settlementId, agent, serviceId, asset, applied, toPrepaid, tab.open);
        _clearDelinquencyIfSettled(tabId);
        _extendHistory(agent, serviceId, asset, amount, nowTs);
    }

    // ------------------------------------------------------------------ delinquency

    /// @notice Declare a tab delinquent once its Settlement Window has closed with the tab still
    /// open. Callable by anyone. Zeroes the Agent's Credit Limit in that Asset until the tab settles.
    function markDelinquent(bytes32 tabId) external {
        TabRef memory ref = _tabRefs[tabId];
        if (!ref.exists) revert UnknownTab(tabId);
        Tab storage tab = _tabs[tabId];
        if (tab.delinquent) revert AlreadyDelinquent(tabId);
        if (tab.open == 0 || tab.oldestUnsettledAt == 0) revert NothingUnsettled(tabId);
        uint64 windowEnd = tab.oldestUnsettledAt + REGISTRY.settlementWindowOf(ref.serviceId);
        if (block.timestamp < windowEnd) revert SettlementWindowOpen(tabId, windowEnd);
        tab.delinquent = true;
        _delinquentTabs[ref.agent][ref.asset] += 1;
        emit TabDelinquent(tabId, ref.agent, ref.serviceId, ref.asset, tab.open, windowEnd);
        emit CreditLimitZeroed(ref.agent, ref.asset, tabId);
    }

    // ------------------------------------------------------------------ views

    function tabIdOf(address agent, bytes32 serviceId, address asset) public pure returns (bytes32 tabId) {
        return keccak256(abi.encode(agent, serviceId, asset));
    }

    function tabOf(bytes32 tabId) external view returns (Tab memory tab) {
        return _tabs[tabId];
    }

    function tabRefOf(bytes32 tabId) external view returns (TabRef memory ref) {
        return _tabRefs[tabId];
    }

    function settlementOf(bytes32 settlementId) external view returns (Settlement memory settlement) {
        return _settlements[settlementId];
    }

    function settlementCount() external view returns (uint256 count) {
        return _settlementNonce;
    }

    function assetOpen(address agent, address asset) external view returns (uint256 open) {
        return _assetOpen[agent][asset];
    }

    function historyCommitment(address agent, address asset)
        external
        view
        returns (bytes32 root, uint32 count)
    {
        return (_historyRoot[agent][asset], _historyCount[agent][asset]);
    }

    function firstDeliveryAtOf(address agent, bytes32 serviceId, address asset)
        external
        view
        returns (uint64 timestamp)
    {
        return _firstDeliveryAt[tabIdOf(agent, serviceId, asset)];
    }

    function authorisationOf(address agent, bytes32 serviceId, address asset)
        external
        view
        returns (Authorisation memory authorisation)
    {
        return _auths[tabIdOf(agent, serviceId, asset)];
    }

    function creditLimit(address agent, address asset, LimitWitness calldata witness)
        external
        view
        returns (uint256 limit)
    {
        return _limitOf(agent, asset, witness);
    }

    function headroom(address agent, address asset, LimitWitness calldata witness)
        external
        view
        returns (uint256 available)
    {
        uint256 limit = _limitOf(agent, asset, witness);
        uint256 open = _assetOpen[agent][asset];
        return limit > open ? limit - open : 0;
    }

    function delinquentTabCount(address agent, address asset) external view returns (uint32 count) {
        return _delinquentTabs[agent][asset];
    }

    // ------------------------------------------------------------------ metering internals

    function _requireOperator(bytes32 serviceId) internal view {
        address operator = REGISTRY.serviceOf(serviceId).operator;
        if (operator != msg.sender) revert NotServiceOperator(serviceId, msg.sender);
    }

    function _requireNotDelinquent(address agent, bytes32 serviceId, address asset) internal view {
        bytes32 tabId = tabIdOf(agent, serviceId, asset);
        if (_tabs[tabId].delinquent) revert TabIsDelinquent(tabId);
    }

    /// @dev The price the Agent was quoted must be the price on chain now, so a Service cannot quote
    /// one number and meter another inside the same call.
    function _charge(bytes32 serviceId, address asset, bytes32 tool, uint32 units, uint256 expectedUnitPrice)
        internal
        view
        returns (uint256 charged)
    {
        if (units == 0) revert ZeroUnits();
        uint256 applied = REGISTRY.priceOf(serviceId, asset, tool);
        if (applied != expectedUnitPrice) {
            revert PriceListChangedMidCall(serviceId, asset, tool, expectedUnitPrice, applied);
        }
        charged = uint256(units) * applied;
        if (charged > type(uint128).max) revert AmountOutOfRange(charged);
    }

    function _consumeAuthorisation(address agent, bytes32 serviceId, address asset, uint256 charged)
        internal
    {
        Authorisation storage auth = _auths[tabIdOf(agent, serviceId, asset)];
        if (!auth.exists) revert AuthorisationMissing(agent, serviceId, asset);
        uint64 nowTs = _now();
        if (auth.expiry < nowTs) revert AuthorisationExpired(auth.expiry, nowTs);
        uint256 projected = uint256(auth.spent) + charged;
        if (projected > auth.maxCumulative) {
            revert AuthorisationExceeded(auth.maxCumulative, auth.spent, charged);
        }
        // casting to 'uint128' is safe because `projected <= maxCumulative`, a uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        auth.spent = uint128(projected);
    }

    function _requireHeadroom(address agent, address asset, uint256 charged, LimitWitness calldata witness)
        internal
        view
        returns (uint256 headroomAfter)
    {
        uint256 limit = _limitOf(agent, asset, witness);
        uint256 open = _assetOpen[agent][asset];
        uint256 projected = open + charged;
        if (projected > limit) {
            revert LimitExceeded(agent, asset, charged, limit > open ? limit - open : 0);
        }
        headroomAfter = limit - projected;
    }

    function _openShareOf(address agent, bytes32 serviceId, address asset, uint256 charged)
        internal
        view
        returns (uint256 toOpen)
    {
        uint128 prepaid = _tabs[tabIdOf(agent, serviceId, asset)].prepaid;
        toOpen = charged > prepaid ? charged - prepaid : 0;
    }

    function _recordOnTab(
        address agent,
        bytes32 serviceId,
        address asset,
        bytes32 tool,
        uint32 units,
        uint256 charged
    ) internal returns (uint128 openAfter) {
        bytes32 tabId = tabIdOf(agent, serviceId, asset);
        _touchTab(tabId, agent, serviceId, asset);
        uint64 nowTs = _now();
        Tab storage tab = _tabs[tabId];
        // casting to 'uint128' is safe because `_charge` rejected anything wider.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 chargedAmount = uint128(charged);
        uint128 fromPrepaid = tab.prepaid >= chargedAmount ? chargedAmount : tab.prepaid;
        uint128 toOpen = chargedAmount - fromPrepaid;
        if (fromPrepaid > 0) {
            tab.prepaid -= fromPrepaid;
            emit PrepaidConsumed(agent, serviceId, asset, fromPrepaid, tab.prepaid, toOpen);
        }
        tab.open += toOpen;
        if (toOpen > 0 && tab.oldestUnsettledAt == 0) tab.oldestUnsettledAt = nowTs;
        tab.lastDeliveryAt = nowTs;
        tab.deliveryCount += 1;
        _assetOpen[agent][asset] += toOpen;
        if (_firstDeliveryAt[tabId] == 0) _firstDeliveryAt[tabId] = nowTs;
        emit DeliveryRecorded(agent, serviceId, asset, tool, units, charged, nowTs);
        openAfter = tab.open;
    }

    // ------------------------------------------------------------------ history internals

    function _extendHistory(address agent, bytes32 serviceId, address asset, uint128 amount, uint64 nowTs)
        internal
    {
        IServiceRegistry.Service memory service = REGISTRY.serviceOf(serviceId);
        LimitLib.SettlementRecord memory record = LimitLib.SettlementRecord({
            serviceId: serviceId,
            asset: asset,
            amount: amount,
            settledAt: nowTs,
            firstDeliveryAt: _firstDeliveryAt[tabIdOf(agent, serviceId, asset)],
            curated: service.tier == IServiceRegistry.Tier.Curated,
            bonded: BOND.freeOf(BOND.partyOf(service.bondAccount), asset) > 0
        });
        bytes32 root = _fold(_historyRoot[agent][asset], record);
        _historyRoot[agent][asset] = root;
        uint32 count = _historyCount[agent][asset] + 1;
        _historyCount[agent][asset] = count;
        emit HistoryExtended(agent, asset, root, count, record);
    }

    /// @dev The rolling commitment. A witness is accepted only if folding its records in order from
    /// zero reproduces the stored root, so every field of every record is authenticated.
    function _fold(bytes32 previousRoot, LimitLib.SettlementRecord memory record)
        internal
        pure
        returns (bytes32 root)
    {
        return keccak256(
            abi.encode(
                previousRoot,
                record.serviceId,
                record.asset,
                record.amount,
                record.settledAt,
                record.firstDeliveryAt,
                record.curated,
                record.bonded
            )
        );
    }

    function _touchTab(bytes32 tabId, address agent, bytes32 serviceId, address asset) internal {
        if (_tabRefs[tabId].exists) return;
        _tabRefs[tabId] = TabRef({agent: agent, serviceId: serviceId, asset: asset, exists: true});
    }

    function _clearDelinquencyIfSettled(bytes32 tabId) internal {
        Tab storage tab = _tabs[tabId];
        if (!tab.delinquent || tab.open != 0) return;
        tab.delinquent = false;
        TabRef memory ref = _tabRefs[tabId];
        uint32 outstanding = _delinquentTabs[ref.agent][ref.asset];
        if (outstanding > 0) _delinquentTabs[ref.agent][ref.asset] = outstanding - 1;
        emit TabDelinquencyCleared(tabId, ref.agent, ref.asset);
    }

    // ------------------------------------------------------------------ limit internals

    function _limitOf(address agent, address asset, LimitWitness calldata witness)
        internal
        view
        returns (uint256 limit)
    {
        _requireWitness(agent, asset, witness);
        if (_delinquentTabs[agent][asset] > 0) return 0;
        LimitLib.Params memory params = LimitLib.Params({
            asset: asset, baseline: BASELINE, growthFactorBps: GROWTH_FACTOR_BPS, evaluatedAt: _now()
        });
        return LimitLib.creditLimit(witness.history, _resolveBonds(agent, witness, asset), params);
    }

    function _requireWitness(address agent, address asset, LimitWitness calldata witness) internal view {
        uint32 count = _historyCount[agent][asset];
        if (witness.history.length != count) {
            revert HistoryLengthMismatch(count, witness.history.length);
        }
        bytes32 root;
        for (uint256 i = 0; i < witness.history.length; ++i) {
            root = _fold(root, witness.history[i]);
        }
        bytes32 stored = _historyRoot[agent][asset];
        if (root != stored) revert HistoryCommitmentMismatch(stored, root);
    }

    /// @dev Bond amounts are never taken from the witness. Each entry names a counterparty and the
    /// stake is read from `Bond` here, so the witness can only choose which counterparties to cite,
    /// and only ones the Agent actually has a tab or history with.
    function _resolveBonds(address agent, LimitWitness calldata witness, address asset)
        internal
        view
        returns (LimitLib.BondEntry[] memory resolved)
    {
        uint256 n = witness.bonds.length;
        if (n > LimitLib.MAX_COUNTERPARTIES) revert TooManyBondEntries(n, LimitLib.MAX_COUNTERPARTIES);
        resolved = new LimitLib.BondEntry[](n);
        for (uint256 i = 0; i < n; ++i) {
            bytes32 serviceId = witness.bonds[i].serviceId;
            address entryAsset = witness.bonds[i].asset;
            for (uint256 j = 0; j < i; ++j) {
                if (resolved[j].serviceId == serviceId && resolved[j].asset == entryAsset) {
                    revert DuplicateBondEntry(serviceId);
                }
            }
            if (entryAsset == asset && !_isCounterparty(agent, witness, serviceId, asset)) {
                revert IneligibleBondEntry(serviceId, asset);
            }
            resolved[i] = LimitLib.BondEntry({
                serviceId: serviceId, asset: entryAsset, amount: _stakedOf(serviceId, entryAsset)
            });
        }
    }

    function _isCounterparty(address agent, LimitWitness calldata witness, bytes32 serviceId, address asset)
        internal
        view
        returns (bool present)
    {
        if (_auths[tabIdOf(agent, serviceId, asset)].exists) return true;
        for (uint256 i = 0; i < witness.history.length; ++i) {
            if (witness.history[i].serviceId == serviceId && witness.history[i].asset == asset) {
                return true;
            }
        }
        return false;
    }

    function _stakedOf(bytes32 serviceId, address asset) internal view returns (uint128 staked) {
        address bondAccount = REGISTRY.serviceOf(serviceId).bondAccount;
        return BOND.freeOf(BOND.partyOf(bondAccount), asset);
    }

    function _now() internal view returns (uint64 nowTs) {
        // casting to 'uint64' is safe because a block timestamp in seconds stays far below 2^64.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp);
    }
}
