// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Test, console} from "forge-std/Test.sol";
import {Bond, IBond} from "../../src/Bond.sol";
import {LimitLib} from "../../src/LimitLib.sol";
import {IServiceRegistry, ServiceRegistry} from "../../src/ServiceRegistry.sol";
import {ITabBook, TabBook} from "../../src/TabBook.sol";

// Feature: tab, Property 15: Value conservation across metering, settlement, and clearing

// ---------------------------------------------------------------- shared constants
//
// File-level rather than inherited from a base, so the actor and the invariant suite below name the
// same triple by construction instead of by two agreeing copies. Plain comments rather than natspec
// because solc rejects documentation tags on file-level variables.

// The one Agent in scope.
address constant AGENT = address(0xA6E7);

// Creditcoin address that operates the one Service in scope.
address constant OPERATOR = address(0x0FE1);

// Plain address wired into `TabBook`'s `settlementVerifier` slot. See the note on impersonation in
// `ValueConservationInvariant`.
address constant VERIFIER = address(0x5EF1);

// Plain address wired into `TabBook`'s `watcher` slot.
address constant WATCHER = address(0x3A7C);

// Ethereum address recorded as the payer on every Verified Settlement.
address constant PAYER = address(0x9A7E);

// The one Asset in scope.
address constant ASSET = address(0x05DC);

// Collection Address the Service registers for the Asset.
address constant COLLECTION = address(0xC011);

// The one Service in scope.
bytes32 constant SERVICE = bytes32("value-conservation-service");

// The one named priced tool in scope.
bytes32 constant TOOL = bytes32("value-conservation-tool");

// Source Chain transaction hash every observation carries. Audit data only. (R15.8)
bytes32 constant TX_HASH = bytes32("value-conservation-source-tx");

// Block digest the Watcher claims to have observed at apply time. (D8)
bytes32 constant OBSERVED_DIGEST = bytes32("value-conservation-digest");

// Price of one unit of the tool in Asset base units.
uint256 constant PRICE = 1_000_000;

// Largest unit count one Metered Delivery may carry, so a charge stays at or below 2e7.
uint256 constant MAX_UNITS = 20;

// Largest observed or settled amount, chosen so a Settlement can be smaller than, equal to, or larger
// than the Open Tab it lands against. Truncation to `min(open, amount)` is the whole point of the
// property, so the generator has to reach both sides of it.
uint256 constant MAX_AMOUNT = 30_000_000;

// Baseline Credit Limit in Asset base units. (D3)
uint256 constant BASELINE = 1_000_000_000_000;

// Growth factor in basis points. (D5)
uint256 constant GROWTH_BPS = 5_000;

// Stake the Service posts in the Asset. Deliberately finite, and tuned rather than picked: reversals
// move stake into `slashed` permanently, so free Bond drains as a sequence runs and later observations
// are declined for want of cover. At this figure a single 64-call sequence reaches both outcomes, and
// therefore reaches the declined-then-settled ordering too. A generous stake reached neither, which
// left a documented transition of the state machine outside every generated sequence.
//
// It also fixes the Credit Limit at `floor(0.95 · STAKE)`, since `LimitLib` caps every path against
// the counterparty bond sum and there is one counterparty here. So this figure is the ceiling the Open
// Tab moves under as well as the cover a clearing draws on.
uint128 constant STAKE = 100_000_000;

// Ceiling on cumulative charges under the Agent's authorisation. Set wide so the authorisation never
// becomes the binding constraint; the Credit Limit is the interesting one.
uint128 constant AUTH_MAX = type(uint128).max;

// Attested-chain identifier of Ethereum Sepolia, whose Provisional Clearing deadline is the shorter of
// the two. (D6)
uint64 constant CHAIN_KEY = 1;

// Settlement Window the Service registers, in seconds.
uint32 constant WINDOW = 6 hours;

// Wall clock the suite starts from.
uint64 constant START = 1_700_000_000;

// `invariant.depth` from `foundry.toml`, which is the length of one generated sequence.
uint256 constant DEPTH = 64;

// Length of the scripted drive. Bounded by memory rather than by taste: the scripted drive is one
// transaction, Solidity never frees memory, and each step re-reads every clearing record, so the
// memory the assertions allocate grows with the square of the step count and the quadratic memory
// price reaches the block gas limit shortly past this figure. The generated sequences have no such
// ceiling, because each of their calls is its own transaction.
uint256 constant DRIVE_STEPS = 150;

/// @notice Lifecycle position the actor last observed for one clearing, mirrored locally.
/// @dev Only ever used to *choose* which clearing an action aims at, never to judge an outcome. Every
/// figure the invariant asserts on is read back from the chain, and the invariant additionally checks
/// this mirror against `TabBook`'s own state so a drifting actor cannot quietly stop reaching the
/// transitions it is supposed to reach.
enum Mirrored {
    Unknown,
    Applied,
    Confirmed,
    Reversed,
    Declined
}

/// @notice How many times each action was invoked and how many times it actually moved state.
/// @dev A struct rather than fourteen public getters, so the invariant reads the whole set in one call
/// and one stack slot. `fail_on_revert = false` means an actor that reverted on every call would let
/// every identity below hold vacuously, so these counters are load-bearing rather than diagnostic.
struct ActorCounters {
    /// @dev Every entry into the actor, successful or not.
    uint256 calls;
    /// @dev Metering attempts.
    uint256 deliveryCalls;
    /// @dev Metering attempts that charged the tab.
    uint256 deliveries;
    /// @dev Verified Settlement attempts against a replay key nothing had observed.
    uint256 directCalls;
    /// @dev Those that landed.
    uint256 directSettlements;
    /// @dev Provisional Clearing attempts.
    uint256 provisionalCalls;
    /// @dev Those that pledged Bond and reduced the tab.
    uint256 provisionalsApplied;
    /// @dev Those declined for want of free Bond. (R15.3)
    uint256 provisionalsDeclined;
    /// @dev Verified Settlement attempts against a replay key an observation already wrote.
    uint256 observedSettleCalls;
    /// @dev `Applied -> Confirmed`, which moves no tab figure. (R15.4)
    uint256 confirmations;
    /// @dev `Reversed -> Confirmed`, which reduces the restored tab a second time. See design 5.5.
    uint256 ordinaryAfterReversal;
    /// @dev `Declined -> Confirmed`, the ordinary path with no Bond involvement.
    uint256 ordinaryAfterDecline;
    /// @dev Reversal crank attempts against a clearing that was live.
    uint256 reverseCalls;
    /// @dev Those that restored the tab and slashed the pledge. (R15.5)
    uint256 reversals;
}

/// @title ValueConservationActor
/// @notice The actor handler behind Property 15: metering, Verified Settlements on both paths,
/// Provisional Clearings, confirmations, and reversals, for one Agent, Service, and Asset triple.
/// @dev Three shapes here are deliberate.
///
/// **Every call is wrapped in `try`/`catch`, and nothing is recorded before the call returns.** With
/// `fail_on_revert = false` a bare reverting call is silently dropped by the fuzzer, which would leave
/// the actor's own bookkeeping ahead of the chain. Recording only on success keeps `ghostCharged`,
/// `ghostSettled`, the witness history, and the clearing mirror exactly in step with `TabBook`.
///
/// **Inputs are bounded, never assumed away.** `bound` maps every seed into a range the call can
/// actually accept, and the two actions that need an existing clearing pick one from the mirror rather
/// than guessing a replay key and rejecting the miss. So the sequence length the fuzzer paid for is
/// the sequence length that reaches the contract.
///
/// **The Verified Settlement for an observed clearing carries the observed amount.** A Verified
/// Settlement is the proof of the very log the Watcher saw, so the two amounts are equal by
/// construction; the actor does not generate a divergent pair. A Watcher that reports an amount its
/// proof will not support is a Bond-coverage question, which is Property 8's subject, and it would make
/// this property ill-posed: `TabBook` reduces the tab by the *observed* amount at apply time, so a
/// smaller proven amount would leave a reduction with no settled value behind it.
contract ValueConservationActor is CommonBase, StdUtils {
    /// @notice Registry the applied price list, tier, and Bond account come from.
    ServiceRegistry internal immutable REGISTRY;

    /// @notice Bond the clearing lifecycle pledges against and slashes.
    Bond internal immutable BOND;

    /// @notice Contract under test.
    TabBook internal immutable BOOK;

    /// @notice Total charged into the Open Tab by every landed Metered Delivery.
    /// @dev One of the two figures the identities are stated against that cannot be read off the
    /// chain: `TabBook` keeps no cumulative metering total, only the live tab.
    uint256 public ghostCharged;

    /// @notice Total settled by every landed Verified Settlement, on either path.
    uint256 public ghostSettled;

    /// @notice Total prepaid credit spent by Metered Deliveries. (D11, task 12.6)
    /// @dev The third figure the identities need and the chain does not keep. A charge funded out of
    /// prepaid credit never reaches the Open Tab and is never reduced by a Settlement, so without this
    /// term identity (I) would report it as value that vanished. It is read as the fall in the tab's
    /// prepaid balance across the call rather than derived from the charge, so the ghost follows what
    /// the contract actually did.
    uint256 public ghostPrepaidSpent;

    /// @notice Every replay key that carries a clearing record, in creation order.
    bytes32[] internal _keys;

    /// @notice Locally mirrored lifecycle position of each entry in {_keys}.
    Mirrored[] internal _mirror;

    /// @notice Verified Settlement history, reproducing the record `TabBook._recordOf` commits.
    /// @dev Every Credit Limit read is driven through this, so the rolling commitment is
    /// self-checking: one disagreeing field and `recordDelivery` reverts
    /// `HistoryCommitmentMismatch`, which the delivery counter would then show as a stalled action.
    LimitLib.SettlementRecord[] internal _history;

    /// @notice Source of distinct replay keys.
    uint256 internal _nonce;

    /// @notice Counters proving the sequence is not vacuous.
    ActorCounters internal _counters;

    /// @notice Binds the deployed tree.
    /// @param registry The `ServiceRegistry`.
    /// @param bond The `Bond`.
    /// @param book The `TabBook`.
    constructor(ServiceRegistry registry, Bond bond, TabBook book) {
        REGISTRY = registry;
        BOND = bond;
        BOOK = book;
    }

    // ------------------------------------------------------------------ actions

    /// @notice Meter one delivery, raising the Open Tab and the per-Asset aggregate. (R12.1, R12.2)
    /// @param unitsSeed Seed for the unit count.
    function recordDelivery(uint32 unitsSeed) external {
        _counters.calls += 1;
        _counters.deliveryCalls += 1;

        uint32 units = uint32(bound(uint256(unitsSeed), 1, MAX_UNITS));

        uint128 prepaidBefore = BOOK.tabOf(BOOK.tabIdOf(AGENT, SERVICE, ASSET)).prepaid;

        vm.prank(OPERATOR);
        try BOOK.recordDelivery(AGENT, SERVICE, ASSET, TOOL, units, PRICE, _witness()) returns (
            uint256 charged, uint128, uint256
        ) {
            ghostCharged += charged;
            ghostPrepaidSpent += prepaidBefore - BOOK.tabOf(BOOK.tabIdOf(AGENT, SERVICE, ASSET)).prepaid;
            _counters.deliveries += 1;
        } catch {}
    }

    /// @notice Apply a Verified Settlement for a log nothing observed provisionally. (R12.4, R12.5)
    /// @param amountSeed Seed for the settled amount.
    function verifiedSettlement(uint128 amountSeed) external {
        _counters.calls += 1;
        _counters.directCalls += 1;

        uint128 amount = uint128(bound(uint256(amountSeed), 1, MAX_AMOUNT));
        bytes32 key = _freshKey();

        vm.prank(VERIFIER);
        try BOOK.applyVerifiedSettlement(_settlement(key, amount)) {
            _keys.push(key);
            _mirror.push(Mirrored.Confirmed);
            ghostSettled += amount;
            _appendHistory(amount);
            _counters.directSettlements += 1;
        } catch {}
    }

    /// @notice Observe an unfinalized Settlement and apply a Provisional Clearing. (R15.1, R15.2)
    /// @param amountSeed Seed for the observed amount.
    function provisional(uint128 amountSeed) external {
        _counters.calls += 1;
        _counters.provisionalCalls += 1;

        uint128 amount = uint128(bound(uint256(amountSeed), 1, MAX_AMOUNT));
        bytes32 key = _freshKey();

        vm.prank(WATCHER);
        try BOOK.applyProvisionalClearing(_observation(key, amount)) returns (bool applied) {
            _keys.push(key);
            _mirror.push(applied ? Mirrored.Applied : Mirrored.Declined);
            if (applied) _counters.provisionalsApplied += 1;
            else _counters.provisionalsDeclined += 1;
        } catch {}
    }

    /// @notice Apply the Verified Settlement for a replay key an observation already wrote.
    /// @dev Reaches three transitions depending on where the record sits: `Applied -> Confirmed`,
    /// which moves no tab figure and banks the excess; and `Reversed -> Confirmed` or
    /// `Declined -> Confirmed`, both of which take the ordinary reducing path.
    /// @param keySeed Seed selecting among the clearings a Settlement can still resolve.
    function confirm(uint256 keySeed) external {
        _counters.calls += 1;

        (bool found, uint256 index) = _pick(keySeed, false);
        if (!found) return;
        _counters.observedSettleCalls += 1;

        bytes32 key = _keys[index];
        Mirrored was = _mirror[index];
        uint128 amount = BOOK.clearingOf(key).amount;

        vm.prank(VERIFIER);
        try BOOK.applyVerifiedSettlement(_settlement(key, amount)) {
            _mirror[index] = Mirrored.Confirmed;
            ghostSettled += amount;
            _appendHistory(amount);
            if (was == Mirrored.Applied) _counters.confirmations += 1;
            else if (was == Mirrored.Reversed) _counters.ordinaryAfterReversal += 1;
            else _counters.ordinaryAfterDecline += 1;
        } catch {}
    }

    /// @notice Crank a live Provisional Clearing past its deadline, restoring the tab. (R15.5)
    /// @dev The clock is advanced to the deadline when the chosen clearing has not reached it, so the
    /// crank fires rather than bouncing off `ClearingNotExpired`. A reversal is the transition the
    /// property most needs reached, and leaving it to chance would leave the whole restoration branch
    /// of the identity untested.
    /// @param keySeed Seed selecting among the live clearings.
    function reverse(uint256 keySeed) external {
        _counters.calls += 1;

        (bool found, uint256 index) = _pick(keySeed, true);
        if (!found) return;
        _counters.reverseCalls += 1;

        bytes32 key = _keys[index];
        uint64 deadline = BOOK.clearingOf(key).deadline;
        if (block.timestamp < deadline) vm.warp(deadline);

        try BOOK.reverseExpiredClearing(key) {
            _mirror[index] = Mirrored.Reversed;
            _counters.reversals += 1;
        } catch {}
    }

    // ------------------------------------------------------------------ reads

    /// @notice Every replay key the actor has created a clearing record under.
    /// @return keys_ The keys, in creation order.
    function keys() external view returns (bytes32[] memory keys_) {
        return _keys;
    }

    /// @notice The locally mirrored lifecycle position of each key.
    /// @return mirror_ One entry per entry of {keys}, in the same order.
    function mirror() external view returns (Mirrored[] memory mirror_) {
        return _mirror;
    }

    /// @notice Invocation and success counts for all five actions.
    /// @return counters_ The counters.
    function counters() external view returns (ActorCounters memory counters_) {
        return _counters;
    }

    // ------------------------------------------------------------------ internals

    /// @notice Select one mirrored clearing an action can still act on.
    /// @dev Two passes over the mirror and a `bound` into the eligible count, rather than a guessed
    /// index that usually misses. No `vm.assume`, so no generated sequence is thrown away.
    /// @param seed Seed to select with.
    /// @param liveOnly True to consider only clearings in `Applied`.
    /// @return found Whether anything was eligible.
    /// @return index Index into {_keys} of the selection.
    function _pick(uint256 seed, bool liveOnly) internal view returns (bool found, uint256 index) {
        uint256 n = _mirror.length;

        uint256 eligible;
        for (uint256 i = 0; i < n; ++i) {
            if (_eligible(_mirror[i], liveOnly)) eligible += 1;
        }
        if (eligible == 0) return (false, 0);

        uint256 target = bound(seed, 0, eligible - 1);
        for (uint256 i = 0; i < n; ++i) {
            if (!_eligible(_mirror[i], liveOnly)) continue;
            if (target == 0) return (true, i);
            target -= 1;
        }
        return (false, 0);
    }

    /// @notice Whether one mirrored position admits the action being aimed.
    /// @dev `Confirmed` is excluded from both: a Settlement has already consumed that proof, and the
    /// reversal crank only accepts `Applied`. `Reversed` and `Declined` still admit a Settlement,
    /// which is exactly what `TabBook._guardSettlement` lets fall through to the ordinary path.
    /// @param position The mirrored position.
    /// @param liveOnly True to accept only `Applied`.
    /// @return admitted Whether the action can act on it.
    function _eligible(Mirrored position, bool liveOnly) internal pure returns (bool admitted) {
        if (liveOnly) return position == Mirrored.Applied;
        return position == Mirrored.Applied || position == Mirrored.Reversed || position == Mirrored.Declined;
    }

    /// @notice A replay key no earlier action has used.
    /// @dev The layout is `TabAscBase`'s: bits 255 down to 192 hold the chainKey, then the block
    /// height, then the transaction index, then the log ordinal. `applyProvisionalClearing` checks the
    /// supplied chainKey against the top 64 bits, so the packing has to be right or every observation
    /// bounces.
    /// @return key The packed key.
    function _freshKey() internal returns (bytes32 key) {
        uint256 height = 21_000_000 + _nonce;
        _nonce += 1;
        return bytes32((uint256(CHAIN_KEY) << 192) | (height << 128));
    }

    /// @notice One Verified Settlement entry.
    /// @dev No `sourceTxHash` field, because the struct carries none: the `SettlementVerifier` holds
    /// the Proof Builder's chunked composite and has no honest way to produce the hash the Watcher
    /// observed. The hash lives on the clearing record instead. See design section 5.5.
    /// @param replayKey Replay key of the settling log, which is the clearing identity.
    /// @param amount Settled amount in {ASSET} base units.
    /// @return s The entry.
    function _settlement(bytes32 replayKey, uint128 amount)
        internal
        pure
        returns (ITabBook.VerifiedSettlement memory s)
    {
        s = ITabBook.VerifiedSettlement({
            replayKey: replayKey,
            chainKey: CHAIN_KEY,
            blockHeight: uint64(uint256(replayKey) >> 128),
            txIndex: 0,
            logIndex: 0,
            agent: AGENT,
            payerAddress: PAYER,
            serviceId: SERVICE,
            asset: ASSET,
            amount: amount,
            sourceTabId: bytes32(0)
        });
    }

    /// @notice One observed, unfinalized Settlement.
    /// @param replayKey Replay key of the observed log.
    /// @param amount Observed amount in {ASSET} base units.
    /// @return o The observation.
    function _observation(bytes32 replayKey, uint128 amount)
        internal
        pure
        returns (ITabBook.ProvisionalObservation memory o)
    {
        o = ITabBook.ProvisionalObservation({
            replayKey: replayKey,
            agent: AGENT,
            serviceId: SERVICE,
            asset: ASSET,
            amount: amount,
            chainKey: CHAIN_KEY,
            sourceTxHash: TX_HASH,
            attestedDigestAtApply: OBSERVED_DIGEST
        });
    }

    /// @notice The witness every Credit Limit read is driven through. (D20)
    /// @dev The Bond amount is left at zero deliberately. `TabBook._resolveBonds` discards whatever
    /// the caller wrote and substitutes the figure `Bond` actually holds.
    /// @return witness Mirrored history plus the one counterparty entry.
    function _witness() internal view returns (ITabBook.LimitWitness memory witness) {
        LimitLib.BondEntry[] memory bonds = new LimitLib.BondEntry[](1);
        bonds[0] = LimitLib.BondEntry({serviceId: SERVICE, asset: ASSET, amount: 0});
        witness = ITabBook.LimitWitness({history: _history, bonds: bonds});
    }

    /// @notice Append the record `TabBook` just committed, so the next witness folds to the same root.
    /// @dev Every field is read back from chain state rather than assumed. None of the four figures
    /// `TabBook` authors moves during a Settlement, so reading them immediately afterwards gives the
    /// same values `_recordOf` saw.
    /// @param amount Settled amount that was committed.
    function _appendHistory(uint128 amount) internal {
        address bondAccount = REGISTRY.serviceOf(SERVICE).bondAccount;
        bool bonded = BOND.ledgerOf(BOND.partyOf(bondAccount), ASSET).staked > 0;

        _history.push(
            LimitLib.SettlementRecord({
                serviceId: SERVICE,
                asset: ASSET,
                amount: amount,
                settledAt: uint64(block.timestamp),
                firstDeliveryAt: BOOK.firstDeliveryAtOf(AGENT, SERVICE, ASSET),
                chainKey: CHAIN_KEY,
                curated: REGISTRY.tierOf(SERVICE) == IServiceRegistry.Tier.Curated,
                bonded: bonded
            })
        );
    }
}

/// @notice Everything the conservation identity is stated over, at one instant.
/// @dev Collapsed into one memory struct because seven separate locals plus the assertion arguments
/// exhaust the legacy code generator's stack, and `via_ir` stays false here as it does in production.
struct Position {
    /// @dev Open Tab for the triple.
    uint256 open;
    /// @dev Prepaid credit held inside `TabBook`, from excess settlement. (R12.5, D11)
    uint256 tabPrepaid;
    /// @dev Prepaid credit held inside `Bond`, from slashed pledges. (R14.6)
    uint256 bondPrepaid;
    /// @dev Reduction standing on the strength of a pledge, over clearings in `Applied`.
    uint256 standingProvisional;
    /// @dev Reduction standing on the strength of a proof, over clearings in `Confirmed`.
    uint256 standingSettled;
    /// @dev Settled amount recorded on the clearings in `Confirmed`.
    uint256 settledOnRecord;
    /// @dev Full pledges slashed to the Agent, over pledges in `Bond`'s `Slashed` state.
    uint256 slashedPledges;
}

/// @title ValueConservationInvariant
/// @notice Property 15: value conservation across metering, settlement, and clearing, for one Agent,
/// Service, and Asset triple.
///
/// ## The identity, stated before it is asserted
///
/// Value enters this triple through three doors and leaves through four, and the whole property is
/// that the two sides agree after **every** intermediate step rather than only at the end of a
/// sequence. Writing it as a double-entry ledger is what makes the two prepaid pots impossible to
/// confuse, so that is how it is written.
///
/// Let, over every replay key the actor has ever touched:
///
/// ```text
/// standingProvisional = Σ TabBook.clearing.reduced   where clearing.state == Applied
/// standingSettled     = Σ TabBook.clearing.reduced   where clearing.state == Confirmed
/// slashedPledges      = Σ Bond.reservation.amount    where reservation.state == Slashed
/// ```
///
/// `clearing.reduced` is the figure `TabBook` actually removed from the tab, which is
/// `min(open, amount)` and not `amount`. A `Reversed` record contributes nothing to either standing
/// total because the reversal put its reduction back.
///
/// **`slashedPledges` is read from `Bond`'s pledge record and not from `TabBook`'s clearing record,
/// and that correction came out of a failing run rather than out of reasoning.** The first version of
/// this suite summed `clearing.amount` over records in `Reversed`, which is right until a reversed
/// clearing's Verified Settlement turns up: the ordinary path then overwrites the record in place, so
/// `state` becomes `Confirmed` and every trace of the reversal disappears from `TabBook`. The slash
/// stands regardless, so identity (III) broke by exactly the slashed amount on the first sequence that
/// reached that ordering. `Bond`'s pledge record is the durable one — `Slashed` is terminal there, and
/// nothing on the settlement path touches it — so it is the right source. The contract was not at
/// fault; the reading of it was.
///
/// Then three identities hold at every step, and each is asserted separately rather than only in
/// aggregate, because a single summed equation lets two errors cancel:
///
/// ```text
/// (I)   ghostCharged  ==  open + standingProvisional + standingSettled + ghostPrepaidSpent
/// (II)  ghostSettled  ==  standingSettled + tab.prepaid + ghostPrepaidSpent
/// (III) Bond.prepaidCreditOf(agent, asset)  ==  slashedPledges
/// ```
///
/// **`ghostPrepaidSpent` entered both identities with task 12.6**, which made prepaid credit spendable
/// against a later Metered Delivery as D11 always said it was. Before that fix the term was
/// structurally zero, because nothing in the contract ever decremented `prepaid`. It appears on both
/// sides for the same base unit seen from two directions: in (I) a charge discharged by prepaid credit
/// left the tab without ever being open or reduced, and in (II) a settled unit that became prepaid
/// credit and was later spent is no longer standing in `tab.prepaid`. Omitting it from either would
/// report value as lost.
///
/// **(I) is the metering identity.** Every base unit metered in is either still outstanding in `open`
/// or has been discharged by exactly one currently-standing reduction. The four movements that can
/// touch `open` are metering, an ordinary Settlement's `applied`, a Provisional Clearing's `reduced`,
/// and a reversal's restoration of that same `reduced`, so the reductions net to the two standing
/// sums by construction. This is the design's "the total reduction attributable to one Settlement is
/// applied exactly once whether the clearing path or the direct path resolves it", made checkable.
///
/// **(II) is the settlement identity, and it is where `Tab.prepaid` belongs.** Each landed Verified
/// Settlement splits its amount into the reduction it is responsible for and the excess it banks.
/// The confirming path banks `amount - reduced` and moves no tab figure, because the reduction
/// already happened and only a proof makes the excess final; the ordinary path reduces
/// `min(open, amount)` and banks the rest. Both leave the record in `Confirmed`, so summing over
/// `Confirmed` counts each Settlement exactly once. This is the property's "excess settlement above
/// the Open Tab appears entirely in prepaid".
///
/// **(III) is the slash identity, and it is where `Bond.prepaidCreditOf` belongs.** A reversal
/// restores exactly `reduced` to the tab but slashes the **full** `amount` that was pledged, and that
/// slashed value becomes prepaid credit for the Agent inside `Bond` — a different pot from
/// `Tab.prepaid`, in a different contract, holding value that came from the Service's stake rather
/// than from a Settlement. Adding the two pots together into one term is the mistake this separation
/// exists to prevent: it would let a missing slash be masked by an excess settlement, and it would
/// make the reversed-then-settled sequence below look like a leak when it is not.
///
/// The three compose into the running ledger, asserted as {invariant_theRunningLedgerBalances}:
///
/// ```text
/// metered + settled + slashedPledges
///   ==  open + standingProvisional + 2·standingSettled + tab.prepaid + bondPrepaid
/// ```
///
/// `standingSettled` appears on the right twice, and that is the honest statement rather than a
/// fudge: a proven reduction is a *transfer*, discharging a metered obligation on one side of the
/// ledger while consuming settled value on the other, so double-entry counts it once in each column.
///
/// ### The sequence the identity has to tolerate
///
/// A clearing that was reversed and whose Verified Settlement arrives afterwards takes the ordinary
/// path and reduces the restored tab a second time, while the slash stands. The Agent ends up holding
/// both the reduction and the slashed pledge, which design section 5.5 records as intended: the
/// Service's own Watcher made a claim it could not prove inside a deadline the Service accepted, and
/// the slash is the price of the claim rather than a refund of the Settlement. The identity
/// accommodates it without a special case, because the ordinary path overwrites the clearing record —
/// `state` becomes `Confirmed` and `reduced` becomes the second reduction — so the first reduction
/// leaves the standing sums exactly as the reversal that undid it should. The actor reaches this
/// sequence on purpose; {ValueConservationActor.counters} reports how often.
///
/// ### One correction to the design's formula, recorded rather than silently absorbed
///
/// The design states Property 15 as `totalCharged == open + prepaid + totalCleared`. That does not
/// balance: charge 1,000 and settle 1,500, and the left side is 1,000 while the right side is
/// `0 + 500 + 1,000`. Prepaid credit is settled value in excess of what was metered, so it cannot
/// appear in a sum of what *was* metered. Identity (I) is the same claim with the term in its correct
/// column, and identity (II) is what the stray `prepaid` term was reaching for. The design document
/// is not this task's to edit; the discrepancy is reported instead.
///
/// ## On impersonating the gated callers, and what that does not establish
///
/// Plain addresses are wired into `TabBook`'s `settlementVerifier` and `watcher` slots and pranked
/// from the actor. That is the right instrument for **this** property and the wrong one for a
/// different question, so it is worth being exact about the boundary.
///
/// What it establishes: `TabBook`'s accounting is conserved across arbitrary interleavings of the
/// five state-moving calls, including orderings no honest Watcher would produce.
///
/// What it does not establish: that the real `SettlementVerifier` ever makes these calls, makes them
/// with these arguments, or makes them at all. Driving the property through the real verifier would
/// need a decodable transaction fixture per generated action, which would turn a money-safety
/// invariant into a test of the receipt decoder and would cap the reachable sequence length at
/// whatever fixtures exist. **This project has already been bitten by exactly that blind spot: a
/// missing `Bond` funding call went unnoticed because the suites credited stake by pranking the
/// verifier instead of arriving through it.** So nothing here should be read as covering the wiring
/// or the proof path. Those belong to the `SettlementVerifier` suite and to the live negative-path
/// suite, and the gap this one leaves open is named here so it is not mistaken for covered ground.
contract ValueConservationInvariant is Test {
    /// @notice Registry the applied price list, tier, and Bond account come from.
    ServiceRegistry internal registry;

    /// @notice Bond the clearing lifecycle pledges against and slashes.
    Bond internal bond;

    /// @notice Contract under test.
    TabBook internal book;

    /// @notice The actor driving the five state-moving calls.
    ValueConservationActor internal actor;

    /// @notice Identifier of the one tab in scope.
    bytes32 internal tabId;

    /// @notice Deploys the tree for real, completes the wiring, registers and funds the Service, and
    /// points the fuzzer at the actor's five actions and at nothing else.
    /// @dev Nothing is mocked. The Service is left in the Permissionless Tier, which pins the Credit
    /// Limit at `min(baseline, 0.95 · stake)` for the whole run: `LimitLib` grants growth only above
    /// three distinct Curated counterparties, and there is one counterparty here by construction. A
    /// fixed limit is what lets the generator's bounds be chosen so that metering mostly lands while
    /// still reaching `LimitExceeded` in delivery-heavy sequences.
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
        _fundBond();

        vm.prank(AGENT);
        book.authorise(SERVICE, ASSET, AUTH_MAX, START + 3650 days);

        tabId = book.tabIdOf(AGENT, SERVICE, ASSET);
        actor = new ValueConservationActor(registry, bond, book);

        targetContract(address(actor));

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = ValueConservationActor.recordDelivery.selector;
        selectors[1] = ValueConservationActor.verifiedSettlement.selector;
        selectors[2] = ValueConservationActor.provisional.selector;
        selectors[3] = ValueConservationActor.confirm.selector;
        selectors[4] = ValueConservationActor.reverse.selector;
        targetSelector(FuzzSelector({addr: address(actor), selectors: selectors}));
    }

    // ------------------------------------------------------------------ invariants

    /// @notice The three ledger identities and the running ledger they compose into.
    /// @dev All of them are asserted from one snapshot pass, so the whole property costs one scan of
    /// the clearing records per step rather than one per claim.
    ///
    /// The last assertion guards the snapshot itself. Identities (I) and (II) both read
    /// `Clearing.reduced`, so a record that lost track of its own `amount` could satisfy them while
    /// value went missing; comparing the recorded amounts against a total kept independently of the
    /// records closes that.
    function invariant_theRunningLedgerBalances() public view {
        Position memory p = _snapshot();

        assertEq(
            actor.ghostCharged(),
            p.open + p.standingProvisional + p.standingSettled + actor.ghostPrepaidSpent(),
            "(I) metered value is neither open, reduced, nor paid from prepaid credit exactly once"
        );
        assertEq(
            actor.ghostSettled(),
            p.standingSettled + p.tabPrepaid + actor.ghostPrepaidSpent(),
            "(II) settled value is neither a reduction, standing prepaid credit, nor spent prepaid credit"
        );
        assertEq(p.bondPrepaid, p.slashedPledges, "(III) slashed pledges did not land as Bond prepaid credit");
        assertEq(
            actor.ghostCharged() + actor.ghostSettled() + p.slashedPledges,
            p.open + p.standingProvisional + 2 * p.standingSettled + p.tabPrepaid + p.bondPrepaid + 2
                * actor.ghostPrepaidSpent(),
            "the running ledger does not balance"
        );
        assertEq(actor.ghostSettled(), p.settledOnRecord, "recorded settled amounts drifted");
    }

    /// @notice The Open Tab never exceeds what was metered into it, and the aggregate agrees with it.
    /// @dev The first is the property's "`open` never falls below zero", read in the direction a
    /// `uint128` can actually be wrong in: it cannot go negative, it can only come back too large,
    /// which is precisely the asymmetry `Clearing.reduced` was added to close. The second checks the
    /// per-Asset aggregate the Credit Limit is enforced against, which is a second figure that has to
    /// move in step with the tab and could silently drift.
    function invariant_theOpenTabStaysWithinWhatWasMetered() public view {
        assertLe(uint256(book.tabOf(tabId).open), actor.ghostCharged(), "the tab exceeds total charges");
        assertEq(
            book.assetOpen(AGENT, ASSET),
            uint256(book.tabOf(tabId).open),
            "the per-Asset aggregate drifted from the tab"
        );
    }

    /// @notice Every action fired often enough for the identities above to mean something.
    /// @dev `fail_on_revert = false` makes a vacuous pass the failure mode to fear: an actor whose
    /// every call reverted would satisfy every identity while establishing nothing. So this is
    /// asserted rather than inspected. It is evaluated once a sequence has run its full depth, because
    /// a counter cannot be expected to be non-zero at the first call, and each claim is guarded by the
    /// matching invocation count so that a sequence which never selected an action is not blamed for
    /// not landing it. The two actions needing an existing clearing count an invocation only where one
    /// was available.
    function invariant_everyActionFiresMeaningfully() public view {
        ActorCounters memory c = actor.counters();
        if (c.calls < DEPTH) return;

        if (c.deliveryCalls > 0) assertGt(c.deliveries, 0, "no Metered Delivery ever landed");
        if (c.directCalls > 0) assertGt(c.directSettlements, 0, "no direct Settlement ever landed");
        if (c.provisionalCalls > 0) {
            assertGt(c.provisionalsApplied + c.provisionalsDeclined, 0, "no observation was ever resolved");
        }
        if (c.observedSettleCalls > 0) {
            assertGt(
                c.confirmations + c.ordinaryAfterReversal + c.ordinaryAfterDecline,
                0,
                "no observed clearing was ever settled"
            );
        }
        if (c.reverseCalls > 0) assertGt(c.reversals, 0, "the reversal crank never fired");

        assertGe(_landed(c), DEPTH / 4, "the actor reverted its way through the sequence");
    }

    // ------------------------------------------------------------------ scripted drive

    /// @notice Drives the same actor through a long deterministic interleaving.
    /// @dev Complements the fuzzer rather than duplicating it, for two reasons.
    ///
    /// A generated sequence is 64 calls long and its state resets between runs, so no single one of
    /// them can carry a threshold assertion without risking a flake on an unlucky selection; the
    /// non-vacuity invariant above therefore has to guard every claim by an invocation count. This
    /// drive has a fixed seed, so it can assert hard floors on all five actions and on both of the
    /// orderings that only arise from interleaving, and its printed counters are quotable evidence
    /// rather than a claim about a distribution.
    ///
    /// It also opens with the reversed-then-settled ordering pinned by hand — deliver, observe, crank
    /// past the deadline, then settle — so the one sequence the design has a note about is reached in a
    /// named place rather than incidentally.
    function test_theActorReachesEveryActionAndConservesValueThroughout() public {
        actor.recordDelivery(5);
        _assertAll();
        actor.provisional(uint128(MAX_AMOUNT));
        _assertAll();
        actor.reverse(0);
        _assertAll();
        actor.confirm(0);
        _assertAll();

        uint256 seed = uint256(keccak256("value-conservation-drive"));
        for (uint256 i = 0; i < DRIVE_STEPS; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            _dispatch(seed);
            _assertAll();
        }

        ActorCounters memory c = actor.counters();
        console.log("calls", c.calls);
        console.log("deliveries", c.deliveries, "of", c.deliveryCalls);
        console.log("directSettlements", c.directSettlements, "of", c.directCalls);
        console.log("provisionalsApplied", c.provisionalsApplied);
        console.log("provisionalsDeclined", c.provisionalsDeclined);
        console.log("confirmations", c.confirmations);
        console.log("ordinaryAfterReversal", c.ordinaryAfterReversal);
        console.log("ordinaryAfterDecline", c.ordinaryAfterDecline);
        console.log("reversals", c.reversals, "of", c.reverseCalls);

        assertGt(c.deliveries, 15, "metering did not reach a meaningful count");
        assertGt(c.directSettlements, 15, "direct settlement did not reach a meaningful count");
        assertGt(c.provisionalsApplied, 8, "applied clearings did not reach a meaningful count");
        assertGt(c.provisionalsDeclined, 0, "no observation was ever declined for want of Bond");
        assertGt(c.confirmations, 3, "confirmations did not reach a meaningful count");
        assertGt(c.ordinaryAfterReversal, 0, "the reversed-then-settled ordering was never reached");
        assertGt(c.ordinaryAfterDecline, 0, "the declined-then-settled ordering was never reached");
        assertGt(c.reversals, 3, "reversals did not reach a meaningful count");

        // Both prepaid pots and the standing reduction have to be non-zero, or identities (II) and
        // (III) would have been satisfied by three zeroes. This is the second half of the non-vacuity
        // claim: the counters show the actions fired, and these show the figures they were supposed to
        // move actually moved.
        Position memory p = _snapshot();
        assertGt(p.tabPrepaid, 0, "no excess settlement ever landed as prepaid credit");
        assertGt(p.bondPrepaid, 0, "no slashed pledge ever landed as Bond prepaid credit");
        assertGt(p.standingSettled, 0, "no proven reduction was standing at the end");
    }

    // ------------------------------------------------------------------ internals

    /// @notice Read every figure the identities are stated over, from the chain.
    /// @dev The standing sums are recomputed from `TabBook`'s own clearing records on every call
    /// rather than accumulated as the actor goes, so the assertions compare two independently
    /// maintained views. The actor's mirror is checked against the records in the same pass, which is
    /// what keeps its action selection honest: a mirror that drifted would quietly stop reaching the
    /// transitions the property needs.
    /// @return p The position.
    function _snapshot() internal view returns (Position memory p) {
        ITabBook.Tab memory tab = book.tabOf(tabId);
        p.open = tab.open;
        p.tabPrepaid = tab.prepaid;
        p.bondPrepaid = bond.prepaidCreditOf(AGENT, ASSET);

        bytes32[] memory keys = actor.keys();
        Mirrored[] memory mirror = actor.mirror();

        for (uint256 i = 0; i < keys.length; ++i) {
            ITabBook.Clearing memory c = book.clearingOf(keys[i]);
            assertEq(uint256(_mirroredOf(c.state)), uint256(mirror[i]), "the actor's mirror drifted");

            if (c.state == ITabBook.ClearingState.Applied) {
                p.standingProvisional += c.reduced;
            } else if (c.state == ITabBook.ClearingState.Confirmed) {
                p.standingSettled += c.reduced;
                p.settledOnRecord += c.amount;
            }

            p.slashedPledges += _slashedUnder(keys[i]);
        }
    }

    /// @notice The pledge slashed under one clearing identifier, or zero.
    /// @dev Read from `Bond` rather than inferred from `TabBook`, for the reason given in this
    /// contract's note on identity (III): a reversed clearing whose Settlement arrives later has its
    /// `TabBook` record overwritten, while the pledge record stays `Slashed` forever.
    /// @param clearingId Replay key to read.
    /// @return amount The slashed pledge, or zero where none was slashed.
    function _slashedUnder(bytes32 clearingId) internal view returns (uint256 amount) {
        IBond.Reservation memory pledge = bond.reservationOf(clearingId);
        return pledge.state == IBond.ReservationState.Slashed ? pledge.amount : 0;
    }

    /// @notice The mirror position corresponding to one on-chain lifecycle state.
    /// @dev `Superseded` maps to `Unknown` and therefore fails the mirror comparison, which is the
    /// intent: `reportReorg` is not one of this property's five actions, so reaching that state would
    /// mean the actor did something it was not written to do.
    /// @param state The on-chain state.
    /// @return position The mirror position.
    function _mirroredOf(ITabBook.ClearingState state) internal pure returns (Mirrored position) {
        if (state == ITabBook.ClearingState.Applied) return Mirrored.Applied;
        if (state == ITabBook.ClearingState.Confirmed) return Mirrored.Confirmed;
        if (state == ITabBook.ClearingState.Reversed) return Mirrored.Reversed;
        if (state == ITabBook.ClearingState.Declined) return Mirrored.Declined;
        return Mirrored.Unknown;
    }

    /// @notice Total number of actions that moved state.
    /// @param c The counters.
    /// @return landed The sum.
    function _landed(ActorCounters memory c) internal pure returns (uint256 landed) {
        landed = c.deliveries + c.directSettlements + c.provisionalsApplied + c.provisionalsDeclined
            + c.confirmations + c.ordinaryAfterReversal + c.ordinaryAfterDecline + c.reversals;
    }

    /// @notice Select and invoke one action from a seed, the way the fuzzer would.
    /// @param seed Pseudorandom word.
    function _dispatch(uint256 seed) internal {
        uint256 action = seed % 5;
        if (action == 0) actor.recordDelivery(uint32(seed >> 8));
        else if (action == 1) actor.verifiedSettlement(uint128(seed >> 16));
        else if (action == 2) actor.provisional(uint128(seed >> 24));
        else if (action == 3) actor.confirm(seed >> 32);
        else actor.reverse(seed >> 40);
    }

    /// @notice Every invariant in this suite, for the scripted drive to check after each step.
    function _assertAll() internal view {
        invariant_theRunningLedgerBalances();
        invariant_theOpenTabStaysWithinWhatWasMetered();
        invariant_everyActionFiresMeaningfully();
    }

    /// @notice Registers the one Service, accepting {ASSET} on one Source Chain.
    function _registerService() internal {
        uint64[] memory chainKeys = new uint64[](1);
        chainKeys[0] = CHAIN_KEY;

        address[] memory assets = new address[](1);
        assets[0] = ASSET;

        address[] memory collections = new address[](1);
        collections[0] = COLLECTION;

        bytes32[] memory tools = new bytes32[](1);
        tools[0] = TOOL;

        uint256[] memory prices = new uint256[](1);
        prices[0] = PRICE;

        vm.prank(OPERATOR);
        registry.registerService(SERVICE, chainKeys, assets, collections, tools, prices, WINDOW);
    }

    /// @notice Credits the Service's stake through the proven-deposit path.
    /// @dev The party key is resolved before the prank, deliberately: an external call inside the
    /// argument list would consume it before the funding call reached the Bond.
    function _fundBond() internal {
        bytes32 party = bond.partyOf(OPERATOR);
        vm.prank(VERIFIER);
        bond.fundFromVerifiedSettlement(party, ASSET, STAKE, bytes32("value-conservation-stake"));
    }
}
