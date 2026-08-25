// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {Bond, IBond} from "../../src/Bond.sol";
import {LimitLib} from "../../src/LimitLib.sol";
import {IServiceRegistry, ServiceRegistry} from "../../src/ServiceRegistry.sol";
import {ITabBook, TabBook} from "../../src/TabBook.sol";

// Feature: tab, Property 8: Provisional-clearing solvency and lifecycle
//
// **Validates: Requirements 14.3, 14.4, 14.5, 14.6, 14.9, 15.2, 15.3, 15.4, 15.5, 15.6, 15.8**
//
// For any interleaving of Metered Delivery, Provisional Clearing application, Confirmed Clearing,
// Provisional Clearing reversal, Slashing, and Bond withdrawal, at every intermediate step:
//
//   1. the sum of active provisionally cleared amounts per Asset is at most the reserved unslashed
//      Bond balance for that Asset;
//   2. `free == staked - reserved - slashed - released` holds;
//   3. no withdrawal reduces the free amount below zero;
//   4. a Provisional Clearing is applied exactly when free Bond covers it, and declined otherwise
//      with the Open Tab unchanged;
//   5. the total reduction attributable to one Settlement is applied exactly once, whether the
//      clearing path or the direct path resolves it.
//
// All five are asserted per Asset, in `invariant_` functions, so the campaign's shrinker reports a
// failing clause rather than a failing handler step. The two clauses that are only observable across
// one step — 4 and 5 — are measured in the handler, where the before-and-after figures exist, and
// surfaced to the invariant functions as counters that must remain zero.
//
// **On impersonating the gated callers, and exactly what that does and does not establish.** The
// `SettlementVerifier` and the Watcher are wired here as plain externally owned accounts and pranked
// from the handler. That is the right trade for this test and it is stated rather than hidden: the
// property under test is the *accounting* `TabBook` and `Bond` keep across interleavings, not the
// wiring and not the proof path. Driving these interleavings through the real `SettlementVerifier`
// would need a decodable transaction fixture per action, and the campaign would become a test of the
// decoder rather than of the ledger.
//
// What that establishes: for every interleaving the fuzzer reaches, the five clauses hold over real
// `ServiceRegistry`, `Bond`, and `TabBook` storage, with no mock anywhere in the tree and no figure
// asserted against anything but contract state or an independently accumulated ghost.
//
// What it does not establish: that any of these calls is reachable on chain. This project has
// already been bitten by precisely that gap. `Bond.fundFromVerifiedSettlement` had no caller in
// `src/` at all, which would have left every ledger at `staked == 0` on a fresh deployment and the
// whole rail inert, and nothing caught it because every test funded the Bond by impersonating the
// verifier — exactly as this file does. Reachability is the business of the `SettlementVerifier`
// suites and of the live negative-path suite; nothing below speaks to it.

/// @dev The Agent whose tabs most of the interleavings move.
address constant AGENT_ONE = address(0xA6E1);

/// @dev A second Agent, so no clause is asserted over a single tab.
address constant AGENT_TWO = address(0xA6E2);

/// @dev Creditcoin address that operates the Service, and the party its Bond ledgers sit under.
address constant OPERATOR = address(0x0FE1);

/// @dev Externally owned account wired into the `SettlementVerifier` slot. See the header note.
address constant VERIFIER = address(0x5EF1);

/// @dev Externally owned account wired into the Watcher slot. See the header note.
address constant WATCHER = address(0x3A7C);

/// @dev First Asset. Every figure asserted below is asserted for this Asset and for {ASSET_TWO}
/// separately, and never summed across the two.
address constant ASSET_ONE = address(0x05DC);

/// @dev Second Asset.
address constant ASSET_TWO = address(0x05D7);

/// @dev Collection Address of the Service in the first Asset.
address constant COLLECTION_ONE = address(0xC011);

/// @dev Collection Address of the Service in the second Asset.
address constant COLLECTION_TWO = address(0xC012);

/// @dev The one registered Service, so one tab per Agent and Asset and one Bond party.
bytes32 constant SERVICE = keccak256("clearing-solvency-service");

/// @dev The one named priced tool.
bytes32 constant TOOL = keccak256("proof");

/// @dev Price of one unit of {TOOL} in first-Asset base units.
uint256 constant PRICE_ONE = 1_000;

/// @dev Price of one unit of {TOOL} in second-Asset base units.
uint256 constant PRICE_TWO = 2_000;

/// @dev Baseline Credit Limit. (D3)
uint256 constant BASELINE = 1_000_000_000_000;

/// @dev Growth factor in basis points. (D5) Never engaged here: one counterparty is below the
/// three-counterparty floor, so the limit is `min(baseline, bondCap)` on every evaluation.
uint256 constant GROWTH_BPS = 5_000;

/// @dev Stake the Service posts in each Asset before the campaign starts.
uint128 constant INITIAL_STAKE = 2_000_000_000_000;

/// @dev Largest unit count one Metered Delivery may carry, so a single charge cannot eat the limit.
uint256 constant MAX_UNITS = 100_000;

/// @dev Largest single proven deposit the staking action may credit.
uint128 constant MAX_STAKE_STEP = 1_000_000_000_000;

/// @dev Settlement Window the Service registers, in seconds.
uint32 constant WINDOW = 6 hours;

/// @dev Attested-chain identifier of Ethereum Sepolia, whose clearing deadline is 30 minutes. (D6)
uint64 constant CHAIN_SEPOLIA = 1;

/// @dev Attested-chain identifier of Ethereum Mainnet, whose clearing deadline is 60 minutes. (D6)
uint64 constant CHAIN_MAINNET = 3;

/// @dev Transaction index the Provisional Clearing replay keys carry. Audit data only.
uint64 constant PROVISIONAL_TX_INDEX = 7;

/// @dev Transaction index the direct-path replay keys carry, so the two key spaces cannot collide.
uint64 constant DIRECT_TX_INDEX = 9;

/// @dev Block digest the Watcher records at apply time. (D8)
bytes32 constant OBSERVED_DIGEST = keccak256("observed-digest");

/// @dev Source Chain transaction hash every observation carries. (R15.8)
bytes32 constant TX_HASH = keccak256("source-tx");

/// @dev Wall clock the campaign starts from.
uint64 constant START = 1_700_000_000;

/// @title ClearingSolvencyHandler
/// @notice Actor handler for Property 8. Drives Metered Delivery, Provisional Clearing application,
/// Confirmed Clearing on both the clearing path and the direct path, Provisional Clearing reversal,
/// reorganisation slashing, proven staking, and Bond withdrawal, across two Assets and two Agents.
/// @dev Three things about the shape are deliberate.
///
/// **Inputs are bounded, never assumed away.** `vm.assume` would spend runs rejecting inputs; every
/// action instead squeezes its fuzzed word into a live range read off the current state — a unit count
/// that fits the remaining headroom, a pledge that straddles the free Bond figure so both branches of
/// R15.2 and R15.3 are reached, a withdrawal that straddles the free figure so the cap of R14.9 is
/// exercised from both sides.
///
/// **Every action satisfies its own preconditions.** `fail_on_revert = false` means a handler that
/// reverted on every call would pass the campaign vacuously, so `reverse` opens a clearing when none
/// is live, `slash` produces a Confirmed Clearing when none exists, and `withdraw` funds stake when
/// the Asset holds none. What is skipped instead of forced is counted in {skips}, and the per-action
/// counters below are asserted from `afterInvariant`.
///
/// **The Credit Limit witness is mirrored, not guessed.** `_mirror` reproduces the record
/// `TabBook._recordOf` folds into the rolling commitment, field for field. If the two ever disagree,
/// the commitment check rejects the witness, `recordDelivery` stops landing, and the non-vacuity
/// assertion goes red rather than the campaign quietly metering nothing.
contract ClearingSolvencyHandler is Test {
    // ------------------------------------------------------------------ collaborators

    /// @notice Registry the price list, the Service record, and the Bond account come from.
    ServiceRegistry internal immutable REGISTRY;

    /// @notice Bond the clearing lifecycle pledges against.
    Bond internal immutable BOND;

    /// @notice Contract under test.
    TabBook internal immutable BOOK;

    // ------------------------------------------------------------------ action counters

    /// @notice Metered Deliveries recorded.
    uint256 public deliveries;

    /// @notice Provisional Clearings that free Bond covered.
    uint256 public provisionalsApplied;

    /// @notice Provisional Clearings declined for want of free Bond. (R15.3)
    uint256 public provisionalsDeclined;

    /// @notice Verified Settlements that converted a live Provisional Clearing. (R15.4)
    uint256 public confirmations;

    /// @notice Verified Settlements that arrived with no observation to convert.
    uint256 public directSettlements;

    /// @notice Verified Settlements that resolved an observation the Bond had declined. (R15.3)
    uint256 public declinedSettlements;

    /// @notice Provisional Clearings reversed past their deadline. (R15.5)
    uint256 public reversals;

    /// @notice Confirmed Clearings superseded by a reported reorganisation. (R14.7)
    uint256 public reorgSlashes;

    /// @notice Proven deposits credited to a Bond ledger. (R14.1)
    uint256 public stakings;

    /// @notice Withdrawal requests served. (R14.9)
    uint256 public withdrawals;

    /// @notice Calls that found no live case and did nothing.
    uint256 public skips;

    // ------------------------------------------------------------------ violation counters

    /// @notice Applications whose outcome disagreed with the free Bond figure. (R15.2, R15.3)
    uint256 public coverageMisjudgements;

    /// @notice Declined applications that moved the Open Tab. (R15.3)
    uint256 public declinesThatTouchedTheTab;

    /// @notice Settlements that reduced a tab a second time for the same replay key. (R15.4)
    uint256 public secondReductions;

    /// @notice Withdrawals that released more than the free amount. (R14.9)
    uint256 public withdrawalOverdraws;

    // ------------------------------------------------------------------ ghost state

    /// @notice Expected Open Tab per Agent and Asset, accumulated from the documented semantics.
    mapping(address => mapping(address => uint256)) public ghostOpen;

    /// @notice Expected `staked` per Asset.
    mapping(address => uint256) public ghostStaked;

    /// @notice Expected `reserved` per Asset, which is the sum of live pledges.
    mapping(address => uint256) public ghostReserved;

    /// @notice Expected `slashed` per Asset.
    mapping(address => uint256) public ghostSlashed;

    /// @notice Expected `released` per Asset.
    mapping(address => uint256) public ghostReleased;

    /// @notice Tab reduction attributable to one replay key.
    mapping(bytes32 => uint128) public reductionOf;

    /// @notice Whether a reduction has already been attributed to one replay key.
    mapping(bytes32 => bool) internal _reduced;

    /// @notice The committed Verified Settlement history, mirrored per Agent and Asset.
    mapping(address => mapping(address => LimitLib.SettlementRecord[])) internal _mirror;

    /// @notice Replay keys of clearings the handler believes are in `Applied`.
    bytes32[] internal _activeIds;

    /// @notice Replay keys of clearings the handler believes are in `Confirmed`.
    bytes32[] internal _confirmedIds;

    /// @notice Replay keys of observations the Bond declined, awaiting their Verified Settlement.
    bytes32[] internal _declinedIds;

    /// @notice Monotonic source of distinct replay keys.
    uint64 internal _nonce;

    // ------------------------------------------------------------------ construction

    /// @notice Binds the deployed tree.
    /// @param registry The `ServiceRegistry`.
    /// @param bond The `Bond`.
    /// @param book The `TabBook`.
    constructor(ServiceRegistry registry, Bond bond, TabBook book) {
        REGISTRY = registry;
        BOND = bond;
        BOOK = book;
    }

    /// @notice Posts the opening stake in both Assets, through the proven-deposit path.
    /// @dev Called once from `setUp` and deliberately not among the targeted selectors, so the
    /// opening balance is part of the fixture rather than part of the measured action mix.
    function bootstrap() external {
        _fund(ASSET_ONE, INITIAL_STAKE);
        _fund(ASSET_TWO, INITIAL_STAKE);
    }

    // ------------------------------------------------------------------ actions

    /// @notice Meter one delivery into an Open Tab, sized to the remaining headroom. (R12.1)
    /// @param actorSeed Chooses the Agent.
    /// @param assetSeed Chooses the Asset.
    /// @param unitsSeed Chooses the unit count.
    function recordDelivery(uint256 actorSeed, uint256 assetSeed, uint256 unitsSeed) external {
        address agent = _actor(actorSeed);
        address asset = _asset(assetSeed);
        uint256 price = asset == ASSET_ONE ? PRICE_ONE : PRICE_TWO;

        ITabBook.LimitWitness memory witness = _witness(agent, asset);
        uint256 room = BOOK.headroom(agent, asset, witness);
        if (room < price) {
            skips += 1;
            return;
        }

        uint256 ceiling = room / price;
        if (ceiling > MAX_UNITS) ceiling = MAX_UNITS;
        uint32 units = uint32(_bound(unitsSeed, 1, ceiling));

        // Read across the call rather than assuming the charge lands whole on the Open Tab. Since task
        // 12.6 a delivery spends the tab's prepaid credit first and borrows only the shortfall, so the
        // mirror has to follow what actually moved. Taking `units * price` here would drift the moment
        // a tab carried banked credit.
        bytes32 tabId = BOOK.tabIdOf(agent, SERVICE, asset);
        uint128 prepaidBefore = BOOK.tabOf(tabId).prepaid;

        vm.prank(OPERATOR);
        BOOK.recordDelivery(agent, SERVICE, asset, TOOL, units, price, witness);

        uint256 fromPrepaid = prepaidBefore - BOOK.tabOf(tabId).prepaid;
        ghostOpen[agent][asset] += uint256(units) * price - fromPrepaid;
        deliveries += 1;
    }

    /// @notice Apply one Provisional Clearing against the Service's Bond. (R15.1, R15.2, R15.3)
    /// @param actorSeed Chooses the Agent.
    /// @param assetSeed Chooses the Asset.
    /// @param amountSeed Chooses the observed amount, either around the tab or around the free Bond.
    /// @param chainSeed Chooses the Source Chain, and with it the 30- or 60-minute deadline.
    function applyProvisional(uint256 actorSeed, uint256 assetSeed, uint256 amountSeed, uint256 chainSeed)
        external
    {
        address agent = _actor(actorSeed);
        address asset = _asset(assetSeed);
        uint128 amount = _pledgeAmount(agent, asset, amountSeed);
        _applyProvisional(agent, asset, amount, _chainKey(chainSeed));
    }

    /// @notice Record a Verified Settlement, converting a live clearing where one exists. (R15.4)
    /// @param pickSeed Chooses which live clearing to convert.
    /// @param actorSeed Chooses the Agent for the direct path.
    /// @param assetSeed Chooses the Asset for the direct path.
    /// @param amountSeed Chooses the settled amount for the direct path.
    function confirm(uint256 pickSeed, uint256 actorSeed, uint256 assetSeed, uint256 amountSeed) external {
        // A declined observation is the third resolvable shape, beside a live clearing and a proof
        // that arrived first: R15.3 leaves the Open Tab alone *until a Verified Settlement arrives*,
        // so the Settlement that eventually arrives still has its whole reduction to make, on the
        // direct path and with no Bond involvement.
        if (pickSeed % 3 == 0) {
            bytes32 declined = _pickDeclined(pickSeed);
            if (declined != bytes32(0)) {
                _settleDeclined(declined);
                return;
            }
        }

        bytes32 id = _pickActive(pickSeed);
        if (id != bytes32(0)) {
            _confirmClearing(id);
            return;
        }
        _settleDirectly(_actor(actorSeed), _asset(assetSeed), amountSeed);
    }

    /// @notice Reverse a Provisional Clearing that reached its deadline unconfirmed. (R15.5, R14.6)
    /// @dev Opens one first where none is live, so the reversal path is reached on every call rather
    /// than only when an earlier call happened to leave a clearing behind.
    /// @param pickSeed Chooses which live clearing to reverse, or seeds the one it opens.
    function reverse(uint256 pickSeed) external {
        bytes32 id = _pickActive(pickSeed);
        if (id == bytes32(0)) id = _openOneToReverse(pickSeed);
        if (id == bytes32(0)) {
            skips += 1;
            return;
        }

        ITabBook.Clearing memory clearing = BOOK.clearingOf(id);
        if (block.timestamp < clearing.deadline) vm.warp(clearing.deadline);

        BOOK.reverseExpiredClearing(id);

        ghostOpen[clearing.agent][clearing.asset] += clearing.reduced;
        ghostReserved[clearing.asset] -= clearing.amount;
        ghostSlashed[clearing.asset] += clearing.amount;
        _dropActive(id);
        reversals += 1;
    }

    /// @notice Report a reorganisation against a Confirmed Clearing, which slashes stake. (R14.7)
    /// @param pickSeed Chooses which Confirmed Clearing to supersede.
    function slash(uint256 pickSeed) external {
        bytes32 id = _pickConfirmed(pickSeed);
        if (id == bytes32(0)) id = _settleDirectly(_actor(pickSeed), _asset(pickSeed >> 8), pickSeed >> 16);
        if (id == bytes32(0)) {
            skips += 1;
            return;
        }

        ITabBook.Clearing memory clearing = BOOK.clearingOf(id);
        uint128 free = BOND.freeOf(BOND.partyOf(OPERATOR), clearing.asset);

        vm.prank(WATCHER);
        BOOK.reportReorg(id, clearing.attestedDigestAtApply, keccak256(abi.encode(id, "reorged")));

        ghostOpen[clearing.agent][clearing.asset] += reductionOf[id];
        ghostSlashed[clearing.asset] += clearing.amount < free ? clearing.amount : free;
        _dropConfirmed(id);
        reorgSlashes += 1;
    }

    /// @notice Credit one proven deposit to a Bond ledger. (R14.1)
    /// @param assetSeed Chooses the Asset.
    /// @param amountSeed Chooses the amount.
    function stake(uint256 assetSeed, uint256 amountSeed) external {
        _fund(_asset(assetSeed), uint128(_bound(amountSeed, 1, MAX_STAKE_STEP)));
        stakings += 1;
    }

    /// @notice Request a withdrawal, from either side of the free amount. (R14.9)
    /// @param assetSeed Chooses the Asset.
    /// @param amountSeed Chooses the requested amount.
    function withdraw(uint256 assetSeed, uint256 amountSeed) external {
        address asset = _asset(assetSeed);
        bytes32 party = BOND.partyOf(OPERATOR);
        uint128 free = BOND.freeOf(party, asset);
        if (free == 0) {
            _fund(asset, uint128(_bound(amountSeed, 1, MAX_STAKE_STEP)));
            free = BOND.freeOf(party, asset);
        }

        uint128 requested = uint128(_bound(amountSeed, 1, uint256(free) + uint256(free) / 2 + 1));

        vm.prank(OPERATOR);
        uint128 released = BOND.requestWithdrawal(asset, requested);

        if (released > free || released != (requested < free ? requested : free)) {
            withdrawalOverdraws += 1;
        }
        ghostReleased[asset] += released;
        withdrawals += 1;
    }

    // ------------------------------------------------------------------ reads for the invariants

    /// @notice Sum of the amounts of every clearing the handler believes is live, per Asset.
    /// @dev Read from the contract's own records rather than from a ghost, so the figure the coverage
    /// clause is asserted against comes from `TabBook` storage. `stale` counts entries the contract no
    /// longer reports as `Applied`, which must be zero for the sum to mean what it says.
    /// @param asset Asset to total over.
    /// @return total Sum of live provisionally cleared amounts in that Asset.
    /// @return stale Entries the handler tracked as live that the contract does not.
    function activeProvisionalTotal(address asset) external view returns (uint256 total, uint256 stale) {
        for (uint256 i = 0; i < _activeIds.length; ++i) {
            ITabBook.Clearing memory clearing = BOOK.clearingOf(_activeIds[i]);
            if (clearing.state != ITabBook.ClearingState.Applied) {
                stale += 1;
                continue;
            }
            if (clearing.asset == asset) total += clearing.amount;
        }
    }

    /// @notice Every action counter, in one call.
    /// @dev A fixed-size array rather than ten reads, so `afterInvariant` costs one call and one
    /// stack slot.
    /// @return counters `deliveries`, `provisionalsApplied`, `provisionalsDeclined`, `confirmations`,
    /// `directSettlements`, `declinedSettlements`, `reversals`, `reorgSlashes`, `stakings`,
    /// `withdrawals`, `skips`.
    function actionCounters() external view returns (uint256[11] memory counters) {
        counters[0] = deliveries;
        counters[1] = provisionalsApplied;
        counters[2] = provisionalsDeclined;
        counters[3] = confirmations;
        counters[4] = directSettlements;
        counters[5] = declinedSettlements;
        counters[6] = reversals;
        counters[7] = reorgSlashes;
        counters[8] = stakings;
        counters[9] = withdrawals;
        counters[10] = skips;
    }

    // ------------------------------------------------------------------ clearing internals

    /// @notice Apply one observation and record every consequence the documented semantics call for.
    /// @dev The two step-local clauses of Property 8 are checked here, where the before-and-after
    /// figures exist, and reported to the invariant functions through counters that must stay zero:
    /// the outcome must equal the coverage test `free >= amount` (R15.2, R15.3), and a decline must
    /// leave the Open Tab exactly as it was (R15.3).
    /// @param agent Agent whose headroom the observation would restore.
    /// @param asset Asset of the observation.
    /// @param amount Observed Settlement amount, and the pledge.
    /// @param chainKey Source Chain of the observation.
    /// @return id Replay key of the clearing, or zero where it was declined.
    function _applyProvisional(address agent, address asset, uint128 amount, uint64 chainKey)
        internal
        returns (bytes32 id)
    {
        uint128 free = BOND.freeOf(BOND.partyOf(OPERATOR), asset);
        uint128 openBefore = _openOf(agent, asset);
        id = _nextKey(chainKey, PROVISIONAL_TX_INDEX);

        vm.prank(WATCHER);
        bool applied = BOOK.applyProvisionalClearing(_observation(id, agent, asset, amount, chainKey));

        if (applied != (free >= amount)) coverageMisjudgements += 1;

        if (!applied) {
            if (_openOf(agent, asset) != openBefore) declinesThatTouchedTheTab += 1;
            _declinedIds.push(id);
            provisionalsDeclined += 1;
            return bytes32(0);
        }

        uint128 reduced = amount < openBefore ? amount : openBefore;
        ghostOpen[agent][asset] -= reduced;
        ghostReserved[asset] += amount;
        _attributeReduction(id, reduced);
        _activeIds.push(id);
        provisionalsApplied += 1;
    }

    /// @notice Convert one live Provisional Clearing with the Verified Settlement that matches it.
    /// @dev The Open Tab must not move: the reduction happened when the clearing was applied, and a
    /// second one here would be the same Settlement paying twice. (R15.4)
    /// @param id Replay key of the clearing, which is also the Settlement's identity.
    function _confirmClearing(bytes32 id) internal {
        ITabBook.Clearing memory clearing = BOOK.clearingOf(id);
        uint128 openBefore = _openOf(clearing.agent, clearing.asset);

        _mirrorAppend(clearing.agent, clearing.asset, clearing.amount, clearing.chainKey);
        vm.prank(VERIFIER);
        BOOK.applyVerifiedSettlement(
            _settlement(id, clearing.agent, clearing.asset, clearing.amount, clearing.chainKey)
        );

        if (_openOf(clearing.agent, clearing.asset) != openBefore) secondReductions += 1;

        ghostReserved[clearing.asset] -= clearing.amount;
        _dropActive(id);
        _confirmedIds.push(id);
        confirmations += 1;
    }

    /// @notice Settle an observation the Bond declined, which the direct path resolves. (R15.3)
    /// @dev The declined record carries the Agent, the Service, the Asset, and the observed amount, so
    /// the Settlement that arrives later is the same Settlement the Watcher saw. No pledge was ever
    /// taken, so no Bond figure moves here, and the whole reduction is still outstanding.
    /// @param id Replay key of the declined observation.
    function _settleDeclined(bytes32 id) internal {
        ITabBook.Clearing memory clearing = BOOK.clearingOf(id);
        uint128 openBefore = _openOf(clearing.agent, clearing.asset);

        _mirrorAppend(clearing.agent, clearing.asset, clearing.amount, clearing.chainKey);
        vm.prank(VERIFIER);
        BOOK.applyVerifiedSettlement(
            _settlement(id, clearing.agent, clearing.asset, clearing.amount, clearing.chainKey)
        );

        uint128 applied = clearing.amount < openBefore ? clearing.amount : openBefore;
        ghostOpen[clearing.agent][clearing.asset] -= applied;
        _attributeReduction(id, applied);
        _dropDeclined(id);
        _confirmedIds.push(id);
        declinedSettlements += 1;
    }

    /// @notice Record a Verified Settlement that no observation preceded. (R12.4, R12.5)
    /// @param agent Agent to credit.
    /// @param asset Asset settled in.
    /// @param amountSeed Chooses the settled amount, which may exceed the Open Tab.
    /// @return id Replay key of the Settlement.
    function _settleDirectly(address agent, address asset, uint256 amountSeed) internal returns (bytes32 id) {
        uint128 openBefore = _openOf(agent, asset);
        uint128 amount = uint128(_bound(amountSeed, 1, uint256(openBefore) + uint256(openBefore) / 2 + 1));
        id = _nextKey(CHAIN_MAINNET, DIRECT_TX_INDEX);

        _mirrorAppend(agent, asset, amount, CHAIN_MAINNET);
        vm.prank(VERIFIER);
        BOOK.applyVerifiedSettlement(_settlement(id, agent, asset, amount, CHAIN_MAINNET));

        uint128 applied = amount < openBefore ? amount : openBefore;
        ghostOpen[agent][asset] -= applied;
        _attributeReduction(id, applied);
        _confirmedIds.push(id);
        directSettlements += 1;
    }

    /// @notice Open one Provisional Clearing that free Bond is certain to cover.
    /// @dev What `reverse` calls when nothing is live. It funds stake first where the Asset holds
    /// none, so the reversal path is never skipped for want of an earlier lucky ordering.
    /// @param seed Chooses the Agent, the Asset, the amount, and the Source Chain.
    /// @return id Replay key of the opened clearing, or zero if it was somehow declined.
    function _openOneToReverse(uint256 seed) internal returns (bytes32 id) {
        address asset = _asset(seed >> 8);
        uint128 free = BOND.freeOf(BOND.partyOf(OPERATOR), asset);
        if (free == 0) {
            _fund(asset, uint128(_bound(seed, 1, MAX_STAKE_STEP)));
            free = BOND.freeOf(BOND.partyOf(OPERATOR), asset);
        }
        return
            _applyProvisional(
                _actor(seed), asset, uint128(_bound(seed >> 16, 1, free)), _chainKey(seed >> 24)
            );
    }

    /// @notice Attribute a tab reduction to one replay key, and flag a second attribution.
    /// @param id Replay key the reduction belongs to.
    /// @param amount Amount the Open Tab fell by.
    function _attributeReduction(bytes32 id, uint128 amount) internal {
        if (_reduced[id]) {
            secondReductions += 1;
            return;
        }
        _reduced[id] = true;
        reductionOf[id] = amount;
    }

    /// @notice Credit one proven deposit and mirror it in the ghost ledger.
    /// @param asset Asset to credit.
    /// @param amount Amount to credit.
    function _fund(address asset, uint128 amount) internal {
        bytes32 party = BOND.partyOf(OPERATOR);
        vm.prank(VERIFIER);
        BOND.fundFromVerifiedSettlement(party, asset, amount, _nextKey(CHAIN_MAINNET, DIRECT_TX_INDEX));
        ghostStaked[asset] += amount;
    }

    // ------------------------------------------------------------------ witness bookkeeping

    /// @notice The witness for one Agent and Asset, mirroring the on-chain commitment. (D20)
    /// @dev The Bond amount is deliberately zero: `TabBook` replaces every supplied figure with the
    /// one it reads from `Bond`, and the Service qualifies as a counterparty through the spending
    /// authorisation the Agent granted in `setUp`.
    /// @param agent Agent the history belongs to.
    /// @param asset Asset the history is scoped to.
    /// @return witness History and Bond entries.
    function _witness(address agent, address asset)
        internal
        view
        returns (ITabBook.LimitWitness memory witness)
    {
        LimitLib.BondEntry[] memory bonds = new LimitLib.BondEntry[](1);
        bonds[0] = LimitLib.BondEntry({serviceId: SERVICE, asset: asset, amount: 0});
        witness = ITabBook.LimitWitness({history: _mirror[agent][asset], bonds: bonds});
    }

    /// @notice Append the record `TabBook._recordOf` is about to fold in, so the witness stays valid.
    /// @param agent Agent the history belongs to.
    /// @param asset Asset settled in.
    /// @param amount Settled amount.
    /// @param chainKey Source Chain of the proof.
    function _mirrorAppend(address agent, address asset, uint128 amount, uint64 chainKey) internal {
        address bondAccount = REGISTRY.serviceOf(SERVICE).bondAccount;
        _mirror[agent][asset].push(
            LimitLib.SettlementRecord({
                serviceId: SERVICE,
                asset: asset,
                amount: amount,
                settledAt: uint64(block.timestamp),
                firstDeliveryAt: BOOK.firstDeliveryAtOf(agent, SERVICE, asset),
                chainKey: chainKey,
                curated: REGISTRY.tierOf(SERVICE) == IServiceRegistry.Tier.Curated,
                bonded: BOND.ledgerOf(BOND.partyOf(bondAccount), asset).staked > 0
            })
        );
    }

    // ------------------------------------------------------------------ small helpers

    /// @notice Open Tab of one Agent in one Asset, which is also the aggregate: one Service, one tab.
    /// @param agent Agent to read.
    /// @param asset Asset to read.
    /// @return open The Open Tab.
    function _openOf(address agent, address asset) internal view returns (uint128 open) {
        return BOOK.tabOf(BOOK.tabIdOf(agent, SERVICE, asset)).open;
    }

    /// @notice The pledge one application offers, drawn from one of two ranges.
    /// @dev Half the calls size the observation against the Open Tab, which exercises partial and
    /// exact reductions; the other half size it against the free Bond figure, which straddles the
    /// coverage test so both R15.2 and R15.3 are reached rather than only the covered branch.
    /// @param agent Agent of the observation.
    /// @param asset Asset of the observation.
    /// @param seed Fuzzed word.
    /// @return amount The pledge.
    function _pledgeAmount(address agent, address asset, uint256 seed)
        internal
        view
        returns (uint128 amount)
    {
        if (seed % 2 == 0) {
            uint256 open = _openOf(agent, asset);
            return uint128(_bound(seed, 1, open + open / 2 + 1));
        }
        uint256 free = BOND.freeOf(BOND.partyOf(OPERATOR), asset);
        return uint128(_bound(seed, 1, free + free / 4 + 1));
    }

    /// @notice One observed Settlement, honest in every field.
    /// @param id Replay key, and the clearing identity.
    /// @param agent Agent whose headroom it would restore.
    /// @param asset Asset of the observation.
    /// @param amount Observed amount.
    /// @param chainKey Source Chain, which must agree with the replay key's top 64 bits.
    /// @return o The observation.
    function _observation(bytes32 id, address agent, address asset, uint128 amount, uint64 chainKey)
        internal
        pure
        returns (ITabBook.ProvisionalObservation memory o)
    {
        o = ITabBook.ProvisionalObservation({
            replayKey: id,
            agent: agent,
            serviceId: SERVICE,
            asset: asset,
            amount: amount,
            chainKey: chainKey,
            sourceTxHash: TX_HASH,
            attestedDigestAtApply: OBSERVED_DIGEST
        });
    }

    /// @notice One Verified Settlement entry.
    /// @param id Replay key of the settling log.
    /// @param agent Agent credited.
    /// @param asset Asset settled in.
    /// @param amount Settled amount.
    /// @param chainKey Source Chain of the proof.
    /// @return s The entry.
    function _settlement(bytes32 id, address agent, address asset, uint128 amount, uint64 chainKey)
        internal
        pure
        returns (ITabBook.VerifiedSettlement memory s)
    {
        s = ITabBook.VerifiedSettlement({
            replayKey: id,
            chainKey: chainKey,
            blockHeight: uint64(uint256(id) >> 128),
            txIndex: uint64(uint256(id) >> 64),
            logIndex: 0,
            agent: agent,
            payerAddress: agent,
            serviceId: SERVICE,
            asset: asset,
            amount: amount,
            sourceTabId: bytes32(0)
        });
    }

    /// @notice A replay key no earlier call has used, in `TabAscBase`'s packing. (R4.1)
    /// @param chainKey Source Chain, packed into bits 255 down to 192.
    /// @param txIndex Transaction index, packed into bits 127 down to 64.
    /// @return key The packed key.
    function _nextKey(uint64 chainKey, uint64 txIndex) internal returns (bytes32 key) {
        _nonce += 1;
        return bytes32((uint256(chainKey) << 192) | (uint256(_nonce) << 128) | (uint256(txIndex) << 64));
    }

    /// @notice The Agent one seed names.
    /// @param seed Fuzzed word.
    /// @return agent One of the two Agents.
    function _actor(uint256 seed) internal pure returns (address agent) {
        return seed % 2 == 0 ? AGENT_ONE : AGENT_TWO;
    }

    /// @notice The Asset one seed names.
    /// @param seed Fuzzed word.
    /// @return asset One of the two Assets.
    function _asset(uint256 seed) internal pure returns (address asset) {
        return seed % 2 == 0 ? ASSET_ONE : ASSET_TWO;
    }

    /// @notice The Source Chain one seed names, so both clearing deadlines are exercised. (D6)
    /// @param seed Fuzzed word.
    /// @return chainKey Sepolia or Mainnet.
    function _chainKey(uint256 seed) internal pure returns (uint64 chainKey) {
        return seed % 2 == 0 ? CHAIN_MAINNET : CHAIN_SEPOLIA;
    }

    /// @notice One live clearing, or zero where none is live.
    /// @param seed Fuzzed word.
    /// @return id Replay key.
    function _pickActive(uint256 seed) internal view returns (bytes32 id) {
        if (_activeIds.length == 0) return bytes32(0);
        return _activeIds[seed % _activeIds.length];
    }

    /// @notice One Confirmed Clearing, or zero where none exists.
    /// @param seed Fuzzed word.
    /// @return id Replay key.
    function _pickConfirmed(uint256 seed) internal view returns (bytes32 id) {
        if (_confirmedIds.length == 0) return bytes32(0);
        return _confirmedIds[seed % _confirmedIds.length];
    }

    /// @notice Forget one live clearing.
    /// @param id Replay key to drop.
    function _dropActive(bytes32 id) internal {
        for (uint256 i = 0; i < _activeIds.length; ++i) {
            if (_activeIds[i] != id) continue;
            _activeIds[i] = _activeIds[_activeIds.length - 1];
            _activeIds.pop();
            return;
        }
    }

    /// @notice One declined observation, or zero where none is waiting.
    /// @param seed Fuzzed word.
    /// @return id Replay key.
    function _pickDeclined(uint256 seed) internal view returns (bytes32 id) {
        if (_declinedIds.length == 0) return bytes32(0);
        return _declinedIds[seed % _declinedIds.length];
    }

    /// @notice Forget one Confirmed Clearing.
    /// @param id Replay key to drop.
    function _dropConfirmed(bytes32 id) internal {
        for (uint256 i = 0; i < _confirmedIds.length; ++i) {
            if (_confirmedIds[i] != id) continue;
            _confirmedIds[i] = _confirmedIds[_confirmedIds.length - 1];
            _confirmedIds.pop();
            return;
        }
    }

    /// @notice Forget one declined observation.
    /// @param id Replay key to drop.
    function _dropDeclined(bytes32 id) internal {
        for (uint256 i = 0; i < _declinedIds.length; ++i) {
            if (_declinedIds[i] != id) continue;
            _declinedIds[i] = _declinedIds[_declinedIds.length - 1];
            _declinedIds.pop();
            return;
        }
    }
}

/// @title ClearingSolvencyTest
/// @notice The Property 8 campaign: one real `ServiceRegistry`, `Bond`, and `TabBook`, two Assets,
/// two Agents, and one actor handler the fuzzer drives over the seven lifecycle actions.
/// @dev Weighting is expressed by how many times each action's selector appears in the targeted set,
/// so the mix leans on the actions that move money — metering, application, and confirmation — while
/// still reaching reversal, reorganisation slashing, staking, and withdrawal on every run. The
/// `afterInvariant` hook asserts that lean did not become starvation: a campaign where an action never
/// fired would satisfy every clause vacuously, and `fail_on_revert = false` would not say a word about
/// it.
///
/// Requirements: 14.3, 14.4, 14.5, 14.6, 14.9, 15.2, 15.3, 15.4, 15.5, 15.6, 15.8
contract ClearingSolvencyTest is Test {
    /// @notice Registry the Service, its price list, and its Bond account come from.
    ServiceRegistry internal registry;

    /// @notice Bond every coverage clause is asserted over.
    Bond internal bond;

    /// @notice Contract under test.
    TabBook internal book;

    /// @notice The actor handler the campaign drives.
    ClearingSolvencyHandler internal handler;

    /// @notice Deploys and wires the tree, registers and funds the Service, and targets the handler.
    function setUp() public {
        vm.warp(START);

        registry = new ServiceRegistry(address(this));
        bond = new Bond(address(this));
        book = new TabBook(address(this), address(registry), address(bond), BASELINE, GROWTH_BPS);

        bond.setSettlementVerifier(VERIFIER);
        bond.setTabBook(address(book));
        book.setSettlementVerifier(VERIFIER);
        book.setWatcher(WATCHER);

        _registerService();

        handler = new ClearingSolvencyHandler(registry, bond, book);
        handler.bootstrap();

        _authorise(AGENT_ONE);
        _authorise(AGENT_TWO);

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: _weightedActions()}));
    }

    // ------------------------------------------------------------------ clause 1

    /// @notice Live Provisional Clearings never exceed the reserved unslashed Bond, per Asset.
    /// @dev R14.3, R14.4, R14.5, R15.2. The sum is taken from `TabBook`'s own clearing records and
    /// compared against `Bond`'s `reserved` for the same Asset, and `reserved + slashed + released`
    /// against `staked`, which is what makes "unslashed" part of the claim rather than a word.
    function invariant_liveClearingsAreCoveredByReservedBond() public view {
        _assertCoverage(ASSET_ONE);
        _assertCoverage(ASSET_TWO);
    }

    // ------------------------------------------------------------------ clause 2

    /// @notice `free == staked - reserved - slashed - released` in every Asset, at every step.
    /// @dev R14.2, R14.3, R18.5. Each of the four stored figures is also compared against a ghost the
    /// handler accumulated from the documented effect of each action, so the identity cannot be
    /// satisfied by two figures drifting together.
    function invariant_bondIdentityHolds() public view {
        _assertIdentity(ASSET_ONE);
        _assertIdentity(ASSET_TWO);
    }

    // ------------------------------------------------------------------ clause 3

    /// @notice No withdrawal ever takes the free amount below zero, in either Asset.
    /// @dev R14.9. Two halves. `released` plus what is pledged and slashed never exceeds `staked`, so
    /// the derived free amount cannot underflow; and every served withdrawal released exactly
    /// `min(requested, free)`, which the handler checked against the figures it read before the call.
    function invariant_withdrawalsNeverOverdrawFreeBond() public view {
        assertEq(handler.withdrawalOverdraws(), 0, "a withdrawal released more than the free amount");
        _assertWithdrawalHeadroom(ASSET_ONE);
        _assertWithdrawalHeadroom(ASSET_TWO);
    }

    // ------------------------------------------------------------------ clause 4

    /// @notice An application lands exactly when free Bond covers it, and declines change no tab.
    /// @dev R15.2, R15.3. Measured per application in the handler against the free Bond figure read
    /// immediately before the call, and the Open Tab read either side of a decline.
    function invariant_provisionalAppliedExactlyWhenBondCovers() public view {
        assertEq(
            handler.coverageMisjudgements(), 0, "an application's outcome disagreed with the free Bond figure"
        );
        assertEq(handler.declinesThatTouchedTheTab(), 0, "a declined application moved the Open Tab");
    }

    // ------------------------------------------------------------------ clause 5

    /// @notice One Settlement reduces one tab exactly once, on either path.
    /// @dev R15.4, R15.6, R12.4. The ghost Open Tab is accumulated from charges, reductions, and
    /// restorations independently of the contract, so a second reduction shows up as a divergence
    /// whichever path took it; `secondReductions` catches the two direct shapes — a confirmation that
    /// moved the tab, and a replay key credited with a reduction twice.
    function invariant_settlementReducesTheTabExactlyOnce() public view {
        assertEq(handler.secondReductions(), 0, "one Settlement reduced an Open Tab twice");
        _assertOpen(AGENT_ONE, ASSET_ONE);
        _assertOpen(AGENT_ONE, ASSET_TWO);
        _assertOpen(AGENT_TWO, ASSET_ONE);
        _assertOpen(AGENT_TWO, ASSET_TWO);
    }

    // ------------------------------------------------------------------ non-vacuity

    /// @notice Every run must have exercised the action set, not merely failed to break it.
    /// @dev `fail_on_revert = false` means a handler that reverted on every call would pass this
    /// campaign in silence, so the run's own action counters are the last assertion. Six of the seven
    /// actions are required rather than all seven: each run draws 64 calls from a weighted selector
    /// set, so one thin action missing from one run is ordinary sampling, while two missing at once is
    /// not something a healthy handler produces.
    function afterInvariant() public {
        uint256[11] memory counters = handler.actionCounters();
        console.log("Property 8 action counters for this run");
        console.log("  recordDelivery   ", counters[0]);
        console.log("  applyProvisional ", counters[1] + counters[2]);
        console.log("    applied        ", counters[1]);
        console.log("    declined       ", counters[2]);
        console.log("  confirm          ", counters[3] + counters[4] + counters[5]);
        console.log("    clearing path  ", counters[3]);
        console.log("    direct path    ", counters[4]);
        console.log("    after decline  ", counters[5]);
        console.log("  reverse          ", counters[6]);
        console.log("  slash            ", counters[7]);
        console.log("  stake            ", counters[8]);
        console.log("  withdraw         ", counters[9]);
        console.log("  skipped          ", counters[10]);

        uint256 fired;
        uint256 total;
        uint256[7] memory kinds = [
            counters[0],
            counters[1] + counters[2],
            counters[3] + counters[4] + counters[5],
            counters[6],
            counters[7],
            counters[8],
            counters[9]
        ];
        for (uint256 i = 0; i < kinds.length; ++i) {
            total += kinds[i];
            if (kinds[i] > 0) fired += 1;
        }

        assertGe(fired, 6, "the run exercised fewer than six of the seven actions");
        assertGe(total, 32, "the run landed too few actions to have tested anything");
    }

    // ------------------------------------------------------------------ clause helpers

    /// @notice Asserts clause 1 for one Asset.
    /// @param asset Asset to check.
    function _assertCoverage(address asset) internal view {
        IBond.Ledger memory ledger = bond.ledgerOf(bond.partyOf(OPERATOR), asset);
        (uint256 live, uint256 stale) = handler.activeProvisionalTotal(asset);

        assertEq(stale, 0, "a clearing left the Applied state without the handler noticing");
        assertLe(live, uint256(ledger.reserved), "live clearings exceed the reserved Bond");
        assertEq(live, uint256(ledger.reserved), "reserved Bond is not exactly the live clearings");
        assertEq(handler.ghostReserved(asset), uint256(ledger.reserved), "reserved diverged from ghost");
        assertLe(
            uint256(ledger.reserved) + ledger.slashed + ledger.released,
            uint256(ledger.staked),
            "pledged, slashed, and withdrawn Bond exceeds the stake behind it"
        );
    }

    /// @notice Asserts clause 2 for one Asset.
    /// @param asset Asset to check.
    function _assertIdentity(address asset) internal view {
        bytes32 party = bond.partyOf(OPERATOR);
        IBond.Ledger memory ledger = bond.ledgerOf(party, asset);
        uint256 committed = uint256(ledger.reserved) + ledger.slashed + ledger.released;

        assertLe(committed, uint256(ledger.staked), "the free amount would be negative");
        assertEq(
            uint256(bond.freeOf(party, asset)),
            uint256(ledger.staked) - committed,
            "free is not staked minus reserved, slashed, and released"
        );
        assertEq(uint256(ledger.staked), handler.ghostStaked(asset), "staked diverged from ghost");
        assertEq(uint256(ledger.slashed), handler.ghostSlashed(asset), "slashed diverged from ghost");
        assertEq(uint256(ledger.released), handler.ghostReleased(asset), "released diverged from ghost");
    }

    /// @notice Asserts the withdrawal half of clause 3 for one Asset.
    /// @param asset Asset to check.
    function _assertWithdrawalHeadroom(address asset) internal view {
        IBond.Ledger memory ledger = bond.ledgerOf(bond.partyOf(OPERATOR), asset);
        uint256 pledged = uint256(ledger.reserved) + ledger.slashed;

        assertLe(pledged, uint256(ledger.staked), "pledged and slashed Bond exceeds the stake");
        assertLe(
            uint256(ledger.released),
            uint256(ledger.staked) - pledged,
            "withdrawals released more than was ever free"
        );
    }

    /// @notice Asserts clause 5 for one Agent and Asset.
    /// @param agent Agent to check.
    /// @param asset Asset to check.
    function _assertOpen(address agent, address asset) internal view {
        uint256 expected = handler.ghostOpen(agent, asset);
        assertEq(book.assetOpen(agent, asset), expected, "the aggregate Open Tab diverged");
        assertEq(
            uint256(book.tabOf(book.tabIdOf(agent, SERVICE, asset)).open), expected, "the Open Tab diverged"
        );
    }

    // ------------------------------------------------------------------ fixture helpers

    /// @notice Registers the one Service, accepting both Assets on Ethereum Mainnet.
    /// @dev Left in the Permissionless Tier deliberately. Curation only matters to the growth branch
    /// of `LimitLib`, which one counterparty can never reach, so promoting it would add a 48-hour warp
    /// to the fixture and change no figure this campaign asserts.
    function _registerService() internal {
        uint64[] memory chainKeys = new uint64[](2);
        chainKeys[0] = CHAIN_MAINNET;
        chainKeys[1] = CHAIN_MAINNET;

        address[] memory assets = new address[](2);
        assets[0] = ASSET_ONE;
        assets[1] = ASSET_TWO;

        address[] memory collections = new address[](2);
        collections[0] = COLLECTION_ONE;
        collections[1] = COLLECTION_TWO;

        bytes32[] memory tools = new bytes32[](1);
        tools[0] = TOOL;

        uint256[] memory prices = new uint256[](2);
        prices[0] = PRICE_ONE;
        prices[1] = PRICE_TWO;

        vm.prank(OPERATOR);
        registry.registerService(SERVICE, chainKeys, assets, collections, tools, prices, WINDOW);
    }

    /// @notice Grants the Service an open-ended spending authorisation in both Assets, as the Agent.
    /// @dev The ceiling is the widest a `uint128` expresses and the expiry sits far past anything the
    /// reversal cranks can warp to, so no run ends early on an authorisation rather than on the
    /// accounting this campaign is about. (D10)
    /// @param agent Agent granting it.
    function _authorise(address agent) internal {
        vm.startPrank(agent);
        book.authorise(SERVICE, ASSET_ONE, type(uint128).max, START + 3650 days);
        book.authorise(SERVICE, ASSET_TWO, type(uint128).max, START + 3650 days);
        vm.stopPrank();
    }

    /// @notice The targeted selector set, with the action mix expressed as repetition.
    /// @return selectors Eleven entries over the seven actions.
    function _weightedActions() internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](11);
        selectors[0] = ClearingSolvencyHandler.recordDelivery.selector;
        selectors[1] = ClearingSolvencyHandler.recordDelivery.selector;
        selectors[2] = ClearingSolvencyHandler.applyProvisional.selector;
        selectors[3] = ClearingSolvencyHandler.applyProvisional.selector;
        selectors[4] = ClearingSolvencyHandler.applyProvisional.selector;
        selectors[5] = ClearingSolvencyHandler.confirm.selector;
        selectors[6] = ClearingSolvencyHandler.confirm.selector;
        selectors[7] = ClearingSolvencyHandler.reverse.selector;
        selectors[8] = ClearingSolvencyHandler.slash.selector;
        selectors[9] = ClearingSolvencyHandler.stake.selector;
        selectors[10] = ClearingSolvencyHandler.withdraw.selector;
    }
}
