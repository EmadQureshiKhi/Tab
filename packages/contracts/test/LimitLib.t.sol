// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {LimitLib} from "../src/LimitLib.sol";

/// @title LimitLibHarness
/// @notice External wrapper over the library, so a revert can be asserted.
/// @dev Every function on `LimitLib` is `internal`, which means a call site compiles into a jump
/// rather than a call and `vm.expectRevert` has no call frame to attach to. This harness gives the
/// two bound checks a real call frame and nothing else; it holds no storage and adds no logic, so it
/// cannot change an answer the library returns.
contract LimitLibHarness {
    /// @notice Forwards to the library under test.
    /// @param history Verified Settlement history.
    /// @param bonds Bond posted by each counterparty Service.
    /// @param p Asset scope, baseline, growth factor, and evaluation timestamp.
    /// @return limit The Credit Limit in Asset base units.
    function creditLimit(
        LimitLib.SettlementRecord[] memory history,
        LimitLib.BondEntry[] memory bonds,
        LimitLib.Params memory p
    ) external pure returns (uint256 limit) {
        limit = LimitLib.creditLimit(history, bonds, p);
    }
}

/// @title LimitLibTest
/// @notice Unit and fuzz coverage for the pure credit computation.
/// @dev What this suite establishes, in the order the tests appear:
///
///  1. The worked example from the design reproduces exactly, in all three of its stated shapes:
///     concentration-bound, bond-bound, and below the three-counterparty threshold.
///  2. All four concentration candidates `k = 0, 1, 2, 3` are reachable, and each returned value is
///     verified against the fixed point it claims to solve rather than only against a literal.
///  3. The age ramp evaluates correctly at the six named day counts and outside both ends of them.
///  4. Each of the four record filters excludes what it is meant to exclude, including the strict
///     Metered Delivery precedence across the before, equal, and after relations.
///  5. A zero bond sum yields a Credit Limit of zero on both the growth path and the baseline path.
///  6. Both bounds revert rather than truncating, at 513 records and at the 33rd counterparty.
///  7. Appending a Verified Settlement never lowers the returned Credit Limit, across the append that
///     crosses the three-counterparty threshold, the append that newly makes the concentration cap
///     bind, the appends that fail a filter, and the whole chain under a binding bond cap.
///     (Property 5)
///  8. The age ramp reproduces through the whole computation at the six named day counts, and the
///     same total settled value compressed inside 24 hours returns a strictly lower Credit Limit than
///     when it is spread across 30 days, with both caps held demonstrably non-binding. (Property 10)
///  9. A Settlement counts only where its Metered Delivery timestamp is strictly earlier, asserted
///     over a table of offsets either side of the Settlement timestamp. (Property 11)
/// 10. Over generated histories and bond sets, the returned limit never exceeds the bond cap.
///
/// Items 7 through 9 are the three property statements the design demotes from property-based tests
/// to targeted unit tests: Property 5, Property 10, and Property 11. Each is universally quantified
/// in the design, so each case below is chosen to be one that would catch a real implementation
/// error, and every one says at its declaration why those inputs and not others. The record-filter
/// precedence case in the filters section is the plain unit assertion on one record; item 9 is the
/// property.
///
/// Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 17.2, 17.3, 17.4, 17.5, 17.6, 18.2
contract LimitLibTest is Test {
    // ------------------------------------------------------------------ fixtures

    /// @notice The Asset every computation here is scoped to.
    address internal constant USDC = address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);

    /// @notice A second Asset, used only to prove exclusion. No conversion exists between the two.
    address internal constant OTHER_ASSET = address(0xdAC17F958D2ee523a2206206994597C13D831ec7);

    /// @notice Counterparty Service identifiers.
    bytes32 internal constant S1 = bytes32(uint256(1));
    bytes32 internal constant S2 = bytes32(uint256(2));
    bytes32 internal constant S3 = bytes32(uint256(3));
    bytes32 internal constant S4 = bytes32(uint256(4));

    /// @notice Evaluation timestamp. Far enough above the ramp that a 60-day age stays positive.
    uint64 internal constant EVALUATED_AT = 1_800_000_000;

    /// @notice Baseline from the design's worked example, in USDC base units.
    uint256 internal constant BASELINE = 5_000_000;

    /// @notice Growth factor from the design's worked example, in basis points.
    uint256 internal constant GROWTH_BPS = 5_000;

    /// @notice External wrapper, for the two bound checks.
    LimitLibHarness internal harness;

    /// @notice Deploys the harness.
    function setUp() public {
        harness = new LimitLibHarness();
    }

    // ------------------------------------------------------------------ worked example

    /// @notice The design's worked example returns 15.00 USDC, and it is the concentration cap that
    /// binds.
    /// @dev Buckets `S1 = 85_000_000`, `S2 = 50_000_000`, `S3 = 5_000_000`; contributions
    /// `42_500_000 / 25_000_000 / 2_500_000`; uncapped `75_000_000`; concentration `15_000_000`; bond
    /// cap `950_000_000`. The final assertion checks the largest counted contribution is exactly 25
    /// percent of the answer, which is the concentration rule stated directly. (R13.6, R17.4)
    function test_workedExampleIsConcentrationBound() public view {
        uint256 limit = LimitLib.creditLimit(_workedHistory(), _workedBonds(), _params(BASELINE));

        assertEq(limit, 15_000_000, "worked example");
        // Fixed point: 5_000_000 + min(42_500_000, L/4) + min(25_000_000, L/4) + min(2_500_000, L/4).
        uint256 share = limit / 4;
        assertEq(BASELINE + share + share + 2_500_000, limit, "fixed point");
        assertEq(share, 3_750_000, "largest counted contribution");
    }

    /// @notice With counterparty bonds summing to 10.00 USDC the bond cap binds instead, strictly.
    /// @dev The design's bond-bound variant. (R13.5, R17.1)
    function test_workedExampleWithSmallBondsIsBondBound() public view {
        LimitLib.BondEntry[] memory bonds = new LimitLib.BondEntry[](3);
        bonds[0] = LimitLib.BondEntry({serviceId: S1, asset: USDC, amount: 4_000_000});
        bonds[1] = LimitLib.BondEntry({serviceId: S2, asset: USDC, amount: 3_000_000});
        bonds[2] = LimitLib.BondEntry({serviceId: S3, asset: USDC, amount: 3_000_000});

        uint256 limit = LimitLib.creditLimit(_workedHistory(), bonds, _params(BASELINE));

        assertEq(limit, 9_500_000, "bond-bound variant");
        assertLt(limit, 10_000_000, "strictly under the bond sum");
    }

    /// @notice Dropping the third counterparty returns the bond-capped baseline. (R13.7, R17.5)
    function test_workedExampleWithTwoCounterpartiesReturnsBaseline() public view {
        LimitLib.SettlementRecord[] memory history = new LimitLib.SettlementRecord[](3);
        history[0] = _record(S1, 60_000_000, 30);
        history[1] = _record(S1, 40_000_000, 15);
        history[2] = _record(S2, 50_000_000, 30);

        LimitLib.BondEntry[] memory bonds = new LimitLib.BondEntry[](2);
        bonds[0] = LimitLib.BondEntry({serviceId: S1, asset: USDC, amount: 400_000_000});
        bonds[1] = LimitLib.BondEntry({serviceId: S2, asset: USDC, amount: 300_000_000});

        assertEq(LimitLib.creditLimit(history, bonds, _params(BASELINE)), BASELINE, "baseline path");
        assertEq(LimitLib.bondCap(bonds, USDC), 665_000_000, "cap does not bind here");
    }

    // ------------------------------------------------------------------ concentration candidates

    /// @notice Candidate `k = 0`: no counterparty reaches the cap, so the concentration term is inert.
    /// @dev Four balanced contributions of 1.00 USDC against a 5.00 USDC baseline. `L = 9_000_000` and
    /// `L / 4 = 2_250_000`, which is above every contribution, so the growth value passes through.
    function test_concentrationCandidateZeroLeavesGrowthIntact() public view {
        uint256 limit = LimitLib.creditLimit(
            _balancedHistory(2_000_000, 2_000_000, 2_000_000, 2_000_000), _deepBonds(), _params(BASELINE)
        );

        assertEq(limit, 9_000_000, "k = 0 candidate");
        assertEq(limit, BASELINE + 4_000_000, "equals the uncapped value");
    }

    /// @notice Candidate `k = 1`: exactly one counterparty sits at the cap.
    /// @dev Contributions `20_000_000 / 1_000_000 / 1_000_000 / 1_000_000`, so
    /// `L = 4 * (5_000_000 + 3_000_000) / 3 = 10_666_666` after flooring.
    function test_concentrationCandidateOneCapsTheLargestCounterparty() public view {
        uint256 limit = LimitLib.creditLimit(
            _balancedHistory(40_000_000, 2_000_000, 2_000_000, 2_000_000), _deepBonds(), _params(BASELINE)
        );

        assertEq(limit, 10_666_666, "k = 1 candidate");
        assertEq(BASELINE + limit / 4 + 3_000_000, limit, "fixed point");

        // The same four contributions arriving in a different order return the same answer, which is
        // the claim that the ranking is established inside the computation rather than assumed of the
        // caller's history. Nothing upstream orders a witness by counterparty size.
        uint256 reordered = LimitLib.creditLimit(
            _balancedHistory(2_000_000, 2_000_000, 40_000_000, 2_000_000), _deepBonds(), _params(BASELINE)
        );
        assertEq(reordered, limit, "the answer depends on the order records arrive in");
    }

    /// @notice Candidate `k = 3`: three counterparties sit at the cap and the fourth does not.
    /// @dev Contributions `10_000_000 / 10_000_000 / 10_000_000 / 100_000`, so
    /// `L = 4 * (5_000_000 + 100_000) / 1 = 20_400_000`.
    function test_concentrationCandidateThreeCapsThreeCounterparties() public view {
        uint256 limit = LimitLib.creditLimit(
            _balancedHistory(20_000_000, 20_000_000, 20_000_000, 200_000), _deepBonds(), _params(BASELINE)
        );

        assertEq(limit, 20_400_000, "k = 3 candidate");
        uint256 share = limit / 4;
        assertEq(BASELINE + share + share + share + 100_000, limit, "fixed point");
    }

    // ------------------------------------------------------------------ age ramp

    /// @notice The age ramp at the six named day counts, and outside both ends of the ramp.
    /// @dev `2500 + 7500 * min(ageDays, 30) / 30`, floored. Task 8.3 asserts the same ramp through
    /// `creditLimit`; this case pins the weighting function itself. (R13.4)
    function test_ageWeightBpsRamp() public pure {
        uint64[6] memory ageDays = [uint64(0), 1, 15, 29, 30, 31];
        uint256[6] memory expected = [uint256(2_500), 2_750, 6_250, 9_750, 10_000, 10_000];

        for (uint256 i = 0; i < ageDays.length; ++i) {
            uint64 settledAt = EVALUATED_AT - ageDays[i] * 1 days;
            assertEq(LimitLib.ageWeightBps(settledAt, EVALUATED_AT), expected[i], "ramp");
        }

        // Anything short of a whole day still weighs day 0, because the day count floors.
        assertEq(LimitLib.ageWeightBps(EVALUATED_AT - 86_399, EVALUATED_AT), 2_500, "under one day");
        // An evaluation time at or behind the settlement time returns the day-0 weight, not a revert.
        assertEq(LimitLib.ageWeightBps(EVALUATED_AT, EVALUATED_AT), 2_500, "equal timestamps");
        assertEq(LimitLib.ageWeightBps(EVALUATED_AT + 1 days, EVALUATED_AT), 2_500, "behind");
        // Well past the ramp the weight stays at parity rather than continuing to grow.
        assertEq(LimitLib.ageWeightBps(EVALUATED_AT - 365 days, EVALUATED_AT), 10_000, "one year");
    }

    // ------------------------------------------------------------------ record filters

    /// @notice A Settlement in another Asset contributes nothing. (R13.3, R18.2)
    function test_recordInAnotherAssetIsExcluded() public view {
        LimitLib.SettlementRecord[] memory history = _workedHistory();
        history[3].asset = OTHER_ASSET;

        assertEq(LimitLib.creditLimit(history, _workedBonds(), _params(BASELINE)), BASELINE, "excluded");
    }

    /// @notice An uncurated counterparty contributes nothing. (R11.4, R17.2)
    function test_uncuratedCounterpartyIsExcluded() public view {
        LimitLib.SettlementRecord[] memory history = _workedHistory();
        history[3].curated = false;

        assertEq(LimitLib.creditLimit(history, _workedBonds(), _params(BASELINE)), BASELINE, "excluded");
    }

    /// @notice An unbonded counterparty contributes nothing. (R17.2)
    function test_unbondedCounterpartyIsExcluded() public view {
        LimitLib.SettlementRecord[] memory history = _workedHistory();
        history[3].bonded = false;

        assertEq(LimitLib.creditLimit(history, _workedBonds(), _params(BASELINE)), BASELINE, "excluded");
    }

    /// @notice A record that weighs zero does not create a counterparty slot.
    /// @dev A dust Settlement must not count toward the three-counterparty threshold while
    /// contributing no value, or the threshold could be reached for free. (R13.7, R17.5)
    function test_zeroWeightRecordDoesNotCountAsACounterparty() public view {
        LimitLib.SettlementRecord[] memory history = _workedHistory();
        history[3].amount = 0;

        assertEq(LimitLib.creditLimit(history, _workedBonds(), _params(BASELINE)), BASELINE, "excluded");
    }

    /// @notice The Metered Delivery timestamp must be strictly earlier than the Settlement timestamp.
    /// @dev Four relations, one per branch of the filter: strictly before counts; equal does not,
    /// which is what stops an Agent settling against a delivery recorded in the same instant; after
    /// does not; and the zero sentinel, meaning no delivery was ever recorded, does not. (R17.3)
    function test_firstDeliveryAtMustBeStrictlyEarlier() public view {
        LimitLib.BondEntry[] memory bonds = _workedBonds();
        LimitLib.Params memory p = _params(BASELINE);

        LimitLib.SettlementRecord[] memory before = _workedHistory();
        before[3].firstDeliveryAt = before[3].settledAt - 1;
        assertEq(LimitLib.creditLimit(before, bonds, p), 15_000_000, "before counts");

        LimitLib.SettlementRecord[] memory equal = _workedHistory();
        equal[3].firstDeliveryAt = equal[3].settledAt;
        assertEq(LimitLib.creditLimit(equal, bonds, p), BASELINE, "equal does not count");

        LimitLib.SettlementRecord[] memory later = _workedHistory();
        later[3].firstDeliveryAt = later[3].settledAt + 1;
        assertEq(LimitLib.creditLimit(later, bonds, p), BASELINE, "after does not count");

        LimitLib.SettlementRecord[] memory absent = _workedHistory();
        absent[3].firstDeliveryAt = 0;
        assertEq(LimitLib.creditLimit(absent, bonds, p), BASELINE, "no delivery does not count");
    }

    // ------------------------------------------------------------------ bond cap

    /// @notice A zero bond sum yields a Credit Limit of zero on both return paths. (R13.5, R17.1)
    /// @dev Three shapes of zero: no bond entries at all, entries carrying zero, and entries in
    /// another Asset. The last one matters because there is no conversion anywhere in this system, so
    /// stake in a different Asset must read as no coverage rather than as coverage at some rate.
    function test_zeroBondSumYieldsZeroLimit() public view {
        LimitLib.SettlementRecord[] memory history = _workedHistory();
        LimitLib.Params memory p = _params(BASELINE);

        LimitLib.BondEntry[] memory none = new LimitLib.BondEntry[](0);
        assertEq(LimitLib.bondCap(none, USDC), 0, "cap with no entries");
        assertEq(LimitLib.creditLimit(history, none, p), 0, "growth path");

        LimitLib.BondEntry[] memory zeroed = new LimitLib.BondEntry[](2);
        zeroed[0] = LimitLib.BondEntry({serviceId: S1, asset: USDC, amount: 0});
        zeroed[1] = LimitLib.BondEntry({serviceId: S2, asset: USDC, amount: 0});
        assertEq(LimitLib.creditLimit(history, zeroed, p), 0, "zero amounts");

        LimitLib.BondEntry[] memory elsewhere = new LimitLib.BondEntry[](1);
        elsewhere[0] = LimitLib.BondEntry({serviceId: S1, asset: OTHER_ASSET, amount: 900_000_000});
        assertEq(LimitLib.bondCap(elsewhere, USDC), 0, "another Asset is not coverage");
        assertEq(LimitLib.creditLimit(history, elsewhere, p), 0, "growth path, another Asset");

        // The baseline path is capped too, so an unbonded Agent gets zero rather than the baseline.
        LimitLib.SettlementRecord[] memory thin = new LimitLib.SettlementRecord[](1);
        thin[0] = _record(S1, 60_000_000, 30);
        assertEq(LimitLib.creditLimit(thin, none, p), 0, "baseline path");
    }

    // ------------------------------------------------------------------ bounds

    /// @notice 512 records evaluate; the 513th reverts rather than being dropped.
    /// @dev Truncating would answer a different question under the same name, so the bound is a
    /// revert. (R13.1)
    function test_historyBoundRevertsAt513Records() public {
        LimitLib.BondEntry[] memory bonds = _deepBonds();
        LimitLib.Params memory p = _params(BASELINE);

        assertGt(harness.creditLimit(_uniformHistory(512), bonds, p), 0, "512 records evaluate");

        LimitLib.SettlementRecord[] memory tooLong = _uniformHistory(513);
        vm.expectRevert(abi.encodeWithSelector(LimitLib.HistoryTooLong.selector, 513, 512));
        harness.creditLimit(tooLong, bonds, p);
    }

    /// @notice 32 distinct counterparties evaluate; the 33rd reverts rather than being dropped.
    function test_counterpartyBoundRevertsAt33Counterparties() public {
        LimitLib.BondEntry[] memory bonds = _deepBonds();
        LimitLib.Params memory p = _params(BASELINE);

        assertGt(harness.creditLimit(_distinctCounterparties(32), bonds, p), 0, "32 evaluate");

        LimitLib.SettlementRecord[] memory tooMany = _distinctCounterparties(33);
        vm.expectRevert(abi.encodeWithSelector(LimitLib.TooManyCounterparties.selector, 33, 32));
        harness.creditLimit(tooMany, bonds, p);
    }

    // ------------------------------------------------- Property 5: monotonicity on append

    /// @notice Property 5: appending a Verified Settlement never lowers the returned Credit Limit,
    /// holding bonds, baseline, growth factor, and evaluation timestamp constant. (R13.8)
    /// @dev The property is universally quantified over histories and over the appended record, and
    /// this is a unit test, so the chain below is built to walk every regime the computation has and
    /// to cross between them one append at a time. A history that stayed inside one regime would
    /// assert almost nothing: monotonicity is trivially true while the same branch keeps returning the
    /// same shape of number, and the two places it could actually break are the crossings.
    ///
    /// The chain is nine appends and the limit is read over every prefix, so the assertion is nine
    /// pairwise comparisons rather than one. The two crossings the design calls out both appear:
    ///
    ///  - **Prefix 3 crosses the three-counterparty threshold.** Prefixes 1 and 2 return the baseline
    ///    from step 3; prefix 3 leaves that branch for the growth branch. The branch change is where a
    ///    naive implementation could return less than the baseline it was returning a record earlier,
    ///    and it does not, because the smallest concentration candidate `k = 0` is `baseline + total`.
    ///  - **Prefix 5 newly makes the concentration cap bind.** A 100.00 USDC Settlement to a
    ///    counterparty that already has history pushes that one contribution far above 25 percent, so
    ///    the feasible candidate moves from `k = 0` to `k = 1` and the returned limit stops tracking
    ///    the uncapped value. The uncapped value jumps from 17.00 to 67.00 USDC while the returned
    ///    limit moves from 17.000000 to 17.333333, which is the case where a cap applied in the wrong
    ///    direction would show up as a decrease.
    ///
    /// Three appends fail a filter — another Asset, zero weight, and a Metered Delivery that is not
    /// strictly earlier — and each must leave the answer bit-identical, which is the equality half of
    /// a non-strict relation and the half an implementation that recomputed something on every append
    /// could get wrong. The last append is partially aged rather than fully aged, so the chain also
    /// covers an append that adds weight at less than parity.
    ///
    /// Bonds are deep here so the cap never binds and the crossings are visible; the companion case
    /// below runs the same chain with the cap binding.
    function test_appendNeverLowersTheCreditLimit() public pure {
        LimitLib.BondEntry[] memory bonds = _deepBonds();
        LimitLib.Params memory p = _params(BASELINE);
        LimitLib.SettlementRecord[] memory full = _appendChain();

        uint256[10] memory limits;
        for (uint256 len = 0; len <= full.length; ++len) {
            limits[len] = LimitLib.creditLimit(_prefix(full, len), bonds, p);
            if (len > 0) assertGe(limits[len], limits[len - 1], "an append lowered the Credit Limit");
        }

        // Below the threshold: the baseline branch, uncapped because the bonds are deep.
        assertEq(limits[0], BASELINE, "empty history");
        assertEq(limits[1], BASELINE, "one counterparty");
        assertEq(limits[2], BASELINE, "two counterparties");

        // Crossing into the growth branch. Contributions 4_000_000 each, so the uncapped value is
        // 17_000_000 and the `k = 0` candidate equals it: the concentration cap does not bind yet.
        assertEq(limits[3], 17_000_000, "third counterparty crosses the threshold");
        assertEq(limits[3], BASELINE + 12_000_000, "concentration cap does not bind at prefix 3");
        assertGt(limits[3], limits[2], "crossing the threshold raised the limit");

        // A record in another Asset is filtered, so the answer must not move at all.
        assertEq(limits[4], limits[3], "a Settlement in another Asset changed the answer");

        // The concentration cap newly binds: uncapped is 67_000_000, the answer is the `k = 1`
        // candidate `4 * (5_000_000 + 8_000_000) / 3`, and the fixed point checks out below.
        assertEq(limits[5], 17_333_333, "concentration cap binds from prefix 5");
        assertLt(limits[5], 67_000_000, "the cap is binding, not inert");
        assertEq(BASELINE + limits[5] / 4 + 4_000_000 + 4_000_000, limits[5], "fixed point");
        assertGe(limits[5], limits[3], "the newly binding cap lowered the limit");

        // A fourth counterparty, still with the cap binding.
        assertEq(limits[6], 22_666_666, "fourth counterparty");

        // Two more filtered appends: zero weight, then a delivery that is not strictly earlier.
        assertEq(limits[7], limits[6], "a zero-weight Settlement changed the answer");
        assertEq(limits[8], limits[7], "a Settlement with no strictly earlier delivery counted");

        // A partially aged append adds weight at 0.25x and still raises the limit.
        assertEq(limits[9], 24_000_000, "a day-0 append into an existing bucket");
        assertGt(limits[9], limits[8], "a partially aged append raised the limit");
    }

    /// @notice Property 5: the same append chain stays monotone while the bond cap is the binding
    /// term. (R13.8, R13.5)
    /// @dev Worth a second case because the bond cap is the one term appending cannot move: bonds are
    /// held constant, so the cap is constant, and the answer is `min(growth, cap)` over a rising
    /// growth value. That saturates, and saturation is where a strict comparison would be the wrong
    /// assertion and where an implementation that applied the cap before rather than after the
    /// concentration term could go backwards. Bonds sum to 10.00 USDC, so the cap is 9.50 USDC and
    /// binds from the first prefix that leaves the baseline branch.
    function test_appendStaysMonotoneUnderABindingBondCap() public pure {
        LimitLib.BondEntry[] memory bonds = new LimitLib.BondEntry[](3);
        bonds[0] = LimitLib.BondEntry({serviceId: S1, asset: USDC, amount: 4_000_000});
        bonds[1] = LimitLib.BondEntry({serviceId: S2, asset: USDC, amount: 3_000_000});
        bonds[2] = LimitLib.BondEntry({serviceId: S3, asset: USDC, amount: 3_000_000});
        assertEq(LimitLib.bondCap(bonds, USDC), 9_500_000, "cap");

        LimitLib.Params memory p = _params(BASELINE);
        LimitLib.SettlementRecord[] memory full = _appendChain();

        uint256 previous;
        for (uint256 len = 0; len <= full.length; ++len) {
            uint256 limit = LimitLib.creditLimit(_prefix(full, len), bonds, p);
            assertGe(limit, previous, "an append lowered the Credit Limit under a binding cap");
            assertLe(limit, 9_500_000, "the cap holds on every prefix");
            // Below the threshold the baseline is under the cap, so the baseline is returned; from
            // the third counterparty onward the growth value is above the cap, so it saturates.
            assertEq(limit, len < 3 ? BASELINE : 9_500_000, "saturates at the cap");
            previous = limit;
        }
    }

    // ------------------------------------------- Property 10: time weighting penalises bursts

    /// @notice Property 10: the age ramp read through the whole computation, at the six named day
    /// counts. (R13.4)
    /// @dev `test_ageWeightBpsRamp` pins the weighting function; this pins the ramp as it reaches the
    /// returned Credit Limit, which is the number a caller sees. The six day counts are the ones that
    /// separate a correct ramp from the ways it is usually got wrong: day 0 is the floor, day 1 is the
    /// smallest step above it and catches a ramp that starts at zero, day 15 is the midpoint and
    /// catches an inverted or half-scaled slope, day 29 is the last day below parity and catches an
    /// off-by-one clamp, day 30 is parity, and day 31 catches a ramp that keeps growing past the
    /// clamp.
    ///
    /// Both caps are held non-binding on purpose and both are asserted to be non-binding on every
    /// row, because a capped answer is the same number at every age and the comparison would pass
    /// while establishing nothing. Three counterparties settle 8.00 USDC each, so at parity a
    /// contribution is 4.00 USDC against a 5.00 USDC baseline, which keeps the `k = 0` concentration
    /// candidate feasible for the whole ramp, and the bonds are deep.
    function test_ageRampThroughCreditLimit() public pure {
        uint64[6] memory ageDays = [uint64(0), 1, 15, 29, 30, 31];
        uint256[6] memory expected =
            [uint256(8_000_000), 8_300_000, 12_500_000, 16_700_000, 17_000_000, 17_000_000];

        LimitLib.BondEntry[] memory bonds = _deepBonds();
        LimitLib.Params memory p = _params(BASELINE);
        uint256 cap = LimitLib.bondCap(bonds, USDC);

        uint256 previous;
        for (uint256 i = 0; i < ageDays.length; ++i) {
            LimitLib.SettlementRecord[] memory history = new LimitLib.SettlementRecord[](3);
            history[0] = _record(S1, 8_000_000, ageDays[i]);
            history[1] = _record(S2, 8_000_000, ageDays[i]);
            history[2] = _record(S3, 8_000_000, ageDays[i]);

            uint256 limit = LimitLib.creditLimit(history, bonds, p);
            assertEq(limit, expected[i], "ramp through creditLimit");

            // Neither cap may be the binding term, or the row would pass vacuously. The uncapped
            // value is recomputed from the weighting function rather than restated as a literal.
            uint256 weighted =
                (8_000_000 * LimitLib.ageWeightBps(history[0].settledAt, EVALUATED_AT)) / LimitLib.BPS;
            uint256 uncapped = BASELINE + 3 * ((weighted * GROWTH_BPS) / LimitLib.BPS);
            assertEq(limit, uncapped, "the concentration cap must not bind on this row");
            assertLt(limit, cap, "the bond cap must not bind on this row");

            // Strictly rising up to the clamp, flat across it. Day 31 must equal day 30.
            if (i > 0 && ageDays[i] <= 30) assertGt(limit, previous, "the ramp must rise");
            if (ageDays[i] == 31) assertEq(limit, previous, "the ramp must clamp at 30 days");
            previous = limit;
        }
    }

    /// @notice Property 10: the same total settled value compressed inside 24 hours returns a strictly
    /// lower Credit Limit than when it is spread across 30 days. (R13.4, R17.6)
    /// @dev The wash-settlement statement of the ramp. Both histories carry twelve Settlements of 2.00
    /// USDC over the same three counterparties, 24.00 USDC in total either way; the spread one sits at
    /// 30, 20, 10, and 0 days, and the compressed one puts all twelve inside one day at 0, 1, 12, and
    /// 23 hours, which all floor to age 0.
    ///
    /// The trap this case is shaped around is the one the design's worked example runs into: move that
    /// example's four Settlements to age 0 and the returned limit does not change at all, because the
    /// concentration cap binds in both shapes and hands back the same capped number. So the
    /// counterparties are balanced and the bonds are deep, and the test asserts both facts rather than
    /// assuming them — each limit is checked equal to its own uncapped value and strictly under the
    /// bond cap, so the strict inequality that follows can only be about the age ramp.
    function test_burstReturnsAStrictlyLowerLimitThanSpread() public pure {
        LimitLib.BondEntry[] memory bonds = _deepBonds();
        LimitLib.Params memory p = _params(BASELINE);
        uint256 cap = LimitLib.bondCap(bonds, USDC);

        uint64[4] memory spreadOffsets = [uint64(30 days), 20 days, 10 days, 0];
        uint64[4] memory burstOffsets = [uint64(0), 1 hours, 12 hours, 23 hours];

        LimitLib.SettlementRecord[] memory spread = _spanHistory(spreadOffsets, 2_000_000);
        LimitLib.SettlementRecord[] memory burst = _spanHistory(burstOffsets, 2_000_000);

        // Equal total settled value is the premise, so it is asserted rather than trusted.
        assertEq(_totalSettled(spread), 24_000_000, "spread total");
        assertEq(_totalSettled(burst), 24_000_000, "compressed total");
        assertEq(_totalSettled(spread), _totalSettled(burst), "the two totals must be equal");

        uint256 spreadLimit = LimitLib.creditLimit(spread, bonds, p);
        uint256 burstLimit = LimitLib.creditLimit(burst, bonds, p);

        // Spread buckets are 5_000_000 each, contributions 2_500_000, so the answer is the uncapped
        // value. Compressed buckets are 2_000_000 each at the day-0 weight of 2500 bps.
        assertEq(spreadLimit, BASELINE + 7_500_000, "spread limit equals its uncapped value");
        assertEq(burstLimit, BASELINE + 3_000_000, "compressed limit equals its uncapped value");
        assertLt(spreadLimit, cap, "the bond cap must not bind on the spread history");
        assertLt(burstLimit, cap, "the bond cap must not bind on the compressed history");

        assertLt(burstLimit, spreadLimit, "compressing the same value must lower the Credit Limit");
    }

    // ------------------------------------------ Property 11: metered-delivery precedence

    /// @notice Property 11: a Settlement counts toward the Credit Limit only where its Metered
    /// Delivery record carries a strictly earlier Creditcoin timestamp. (R17.3)
    /// @dev The property quantifies the delivery timestamp arbitrarily before, at, or after the
    /// Settlement timestamp, so the table walks ten offsets on both sides of the boundary and asserts
    /// the outcome flips exactly at it: an ancient delivery, then 1_000_000 seconds, one day, two
    /// seconds, and one second earlier all count; the same instant does not; and one second, two
    /// seconds, one day, and 1_000_000 seconds later do not. The two entries either side of zero are
    /// the ones that matter, because a `>` written where `>=` belongs admits the equal case and
    /// nothing else, and the equal case is precisely the wash-settlement shape: an Agent that settles
    /// in the same instant a delivery is recorded has manufactured history with no service behind it.
    ///
    /// The record under test is the fourth counterparty against three that always count, so both
    /// outcomes land on the growth branch and are distinct numbers — 21.00 USDC counted against 17.00
    /// USDC not counted — rather than one of them collapsing to the baseline. Collapsing to the
    /// baseline is what the filters section already asserts on the third counterparty, and it is the
    /// weaker signal: the baseline is also what a computation that discarded the whole history would
    /// return.
    ///
    /// The zero sentinel is asserted separately, at the end. Zero is the absence of a Metered
    /// Delivery, not a timestamp arbitrarily earlier than the Settlement, so it is outside the
    /// property's quantifier and inside the same filter.
    function test_settlementCountsOnlyWithAStrictlyEarlierDelivery() public pure {
        LimitLib.BondEntry[] memory bonds = _deepBonds();
        LimitLib.Params memory p = _params(BASELINE);
        uint64 settledAt = EVALUATED_AT - 30 days;

        uint64[10] memory deliveryAt = [
            uint64(1),
            settledAt - 1_000_000,
            settledAt - 1 days,
            settledAt - 2,
            settledAt - 1,
            settledAt,
            settledAt + 1,
            settledAt + 2,
            settledAt + 1 days,
            settledAt + 1_000_000
        ];
        bool[10] memory counts = [true, true, true, true, true, false, false, false, false, false];

        for (uint256 i = 0; i < deliveryAt.length; ++i) {
            LimitLib.SettlementRecord[] memory history = _precedenceHistory(deliveryAt[i]);
            assertEq(history[3].settledAt, settledAt, "the record under test is fully aged");

            uint256 limit = LimitLib.creditLimit(history, bonds, p);
            assertEq(
                limit,
                counts[i] ? 21_000_000 : 17_000_000,
                counts[i] ? "a strictly earlier delivery must count" : "must not count"
            );
            // The relation and the outcome, stated together: counted exactly when strictly earlier.
            assertEq(deliveryAt[i] < settledAt, counts[i], "the table and the relation disagree");
        }

        // No Metered Delivery was ever recorded, which is the zero sentinel rather than an earlier
        // timestamp, and it does not count either.
        assertEq(LimitLib.creditLimit(_precedenceHistory(0), bonds, p), 17_000_000, "no delivery");
    }

    // ------------------------------------------------------------------ fuzz

    /// @notice Over generated histories and bond sets, the Credit Limit never exceeds the bond cap.
    /// @dev The cheapest statement of the invariant that matters most: whatever the history, the
    /// growth factor, or the baseline, the returned limit is at most
    /// `sum(counterparty bonds in the Asset) * 9500 / 10000`. Property 6 in `test/property` states the
    /// strict form of this against generated counterparty sets; this case is the direct arithmetic
    /// bound, run on every build rather than only in the property job.
    ///
    /// The generators stay inside the input space by construction, so there are no rejections. Eight
    /// records are spread over at most eight counterparties, amounts and bond amounts sit in
    /// `[0, 2^96)`, ages in `[0, 60]` days, and roughly one bond entry in four lands in a second Asset
    /// so that cross-asset entries are exercised without ever raising the cap. The all-zero bond sum
    /// is reachable on one seed in eight, which is the case where the cap must force a zero limit.
    ///
    /// Runs come from the `[profile.default.fuzz]` block in `foundry.toml`, currently 256.
    /// @param amountSeed Seeds the settled amounts.
    /// @param bondSeed Seeds the bond amounts and their Assets.
    /// @param ageSeed Seeds the age of each record in whole days.
    /// @param partySeed Seeds the counterparty each record belongs to.
    /// @param growthFactorBps Growth factor in basis points.
    /// @param baseline Baseline Credit Limit in Asset base units.
    function testFuzz_limitNeverExceedsBondCap(
        uint96 amountSeed,
        uint96 bondSeed,
        uint96 ageSeed,
        uint96 partySeed,
        uint16 growthFactorBps,
        uint96 baseline
    ) public pure {
        LimitLib.SettlementRecord[] memory history = new LimitLib.SettlementRecord[](8);
        for (uint256 i = 0; i < 8; ++i) {
            uint128 amount = uint128(_draw(amountSeed, i) % (2 ** 96));
            uint64 ageDays = uint64(_draw(ageSeed, i) % 61);
            bytes32 serviceId = bytes32(1 + (_draw(partySeed, i) % 8));
            history[i] = _record(serviceId, amount, ageDays);
        }

        bool zeroBonds = bondSeed % 8 == 0;
        LimitLib.BondEntry[] memory bonds = new LimitLib.BondEntry[](8);
        uint256 sumInAsset;
        for (uint256 i = 0; i < 8; ++i) {
            uint256 drawn = _draw(bondSeed, i);
            uint128 amount = zeroBonds ? 0 : uint128(drawn % (2 ** 96));
            address asset = drawn % 4 == 0 ? OTHER_ASSET : USDC;
            bonds[i] = LimitLib.BondEntry({serviceId: bytes32(1 + i), asset: asset, amount: amount});
            if (asset == USDC) sumInAsset += amount;
        }

        LimitLib.Params memory p = LimitLib.Params({
            asset: USDC, baseline: baseline, growthFactorBps: growthFactorBps, evaluatedAt: EVALUATED_AT
        });

        uint256 cap = (sumInAsset * 9_500) / 10_000;
        assertEq(LimitLib.bondCap(bonds, USDC), cap, "cap totals the Asset's entries only");
        assertLe(LimitLib.creditLimit(history, bonds, p), cap, "limit never exceeds the bond cap");
    }

    // ------------------------------------------------------------------ builders

    /// @notice One Verified Settlement that passes every filter, aged a whole number of days.
    /// @param serviceId Counterparty Service.
    /// @param amount Settled amount in Asset base units.
    /// @param ageDays Whole days between settlement and evaluation.
    /// @return r The record.
    function _record(bytes32 serviceId, uint128 amount, uint64 ageDays)
        private
        pure
        returns (LimitLib.SettlementRecord memory r)
    {
        uint64 settledAt = EVALUATED_AT - ageDays * 1 days;
        r = LimitLib.SettlementRecord({
            serviceId: serviceId,
            asset: USDC,
            amount: amount,
            settledAt: settledAt,
            firstDeliveryAt: settledAt - 1,
            chainKey: 3,
            curated: true,
            bonded: true
        });
    }

    /// @notice The worked example's governance inputs, at a chosen baseline.
    /// @param baseline Baseline Credit Limit in Asset base units.
    /// @return p The parameters.
    function _params(uint256 baseline) private pure returns (LimitLib.Params memory p) {
        p = LimitLib.Params({
            asset: USDC, baseline: baseline, growthFactorBps: GROWTH_BPS, evaluatedAt: EVALUATED_AT
        });
    }

    /// @notice The four-record history from the design's worked example.
    /// @return h The history.
    function _workedHistory() private pure returns (LimitLib.SettlementRecord[] memory h) {
        h = new LimitLib.SettlementRecord[](4);
        h[0] = _record(S1, 60_000_000, 30);
        h[1] = _record(S1, 40_000_000, 15);
        h[2] = _record(S2, 50_000_000, 30);
        h[3] = _record(S3, 20_000_000, 0);
    }

    /// @notice The three bond entries from the design's worked example, summing to 1000.00 USDC.
    /// @return b The bond entries.
    function _workedBonds() private pure returns (LimitLib.BondEntry[] memory b) {
        b = new LimitLib.BondEntry[](3);
        b[0] = LimitLib.BondEntry({serviceId: S1, asset: USDC, amount: 400_000_000});
        b[1] = LimitLib.BondEntry({serviceId: S2, asset: USDC, amount: 300_000_000});
        b[2] = LimitLib.BondEntry({serviceId: S3, asset: USDC, amount: 300_000_000});
    }

    /// @notice Four counterparties, one fully aged record each, so contributions are controllable.
    /// @dev At 30 days every weight is 10_000, so a bucket equals the settled amount and a
    /// contribution is exactly half of it at the worked example's growth factor. That is what lets
    /// each concentration candidate be targeted by choosing four amounts.
    /// @param a1 Amount settled to the first counterparty.
    /// @param a2 Amount settled to the second.
    /// @param a3 Amount settled to the third.
    /// @param a4 Amount settled to the fourth.
    /// @return h The history.
    function _balancedHistory(uint128 a1, uint128 a2, uint128 a3, uint128 a4)
        private
        pure
        returns (LimitLib.SettlementRecord[] memory h)
    {
        h = new LimitLib.SettlementRecord[](4);
        h[0] = _record(S1, a1, 30);
        h[1] = _record(S2, a2, 30);
        h[2] = _record(S3, a3, 30);
        h[3] = _record(S4, a4, 30);
    }

    /// @notice Bond entries deep enough that the bond cap never binds, across 32 counterparties.
    /// @return b The bond entries.
    function _deepBonds() private pure returns (LimitLib.BondEntry[] memory b) {
        b = new LimitLib.BondEntry[](32);
        for (uint256 i = 0; i < 32; ++i) {
            b[i] = LimitLib.BondEntry({serviceId: bytes32(i + 1), asset: USDC, amount: 1_000_000_000_000});
        }
    }

    /// @notice `count` records spread evenly over three counterparties, all fully aged.
    /// @param count Number of records.
    /// @return h The history.
    function _uniformHistory(uint256 count) private pure returns (LimitLib.SettlementRecord[] memory h) {
        h = new LimitLib.SettlementRecord[](count);
        bytes32[3] memory parties = [S1, S2, S3];
        for (uint256 i = 0; i < count; ++i) {
            h[i] = _record(parties[i % 3], 1_000_000, 30);
        }
    }

    /// @notice One fully aged record for each of `count` distinct counterparties.
    /// @param count Number of distinct counterparties.
    /// @return h The history.
    function _distinctCounterparties(uint256 count)
        private
        pure
        returns (LimitLib.SettlementRecord[] memory h)
    {
        h = new LimitLib.SettlementRecord[](count);
        for (uint256 i = 0; i < count; ++i) {
            h[i] = _record(bytes32(i + 1), 1_000_000, 30);
        }
    }

    /// @notice One Verified Settlement that passes every filter, aged a whole number of seconds.
    /// @dev The seconds-resolution sibling of {_record}. The compressed history of Property 10 needs
    /// several distinct settlement instants inside one day, which whole days cannot express.
    /// @param serviceId Counterparty Service.
    /// @param amount Settled amount in Asset base units.
    /// @param secondsAgo Seconds between settlement and evaluation.
    /// @return r The record.
    function _recordAt(bytes32 serviceId, uint128 amount, uint64 secondsAgo)
        private
        pure
        returns (LimitLib.SettlementRecord memory r)
    {
        uint64 settledAt = EVALUATED_AT - secondsAgo;
        r = LimitLib.SettlementRecord({
            serviceId: serviceId,
            asset: USDC,
            amount: amount,
            settledAt: settledAt,
            firstDeliveryAt: settledAt - 1,
            chainKey: 3,
            curated: true,
            bonded: true
        });
    }

    /// @notice The nine-record append chain Property 5 walks, in append order.
    /// @dev Each entry is chosen for the regime crossing it causes, documented at the test.
    /// @return h The chain.
    function _appendChain() private pure returns (LimitLib.SettlementRecord[] memory h) {
        h = new LimitLib.SettlementRecord[](9);
        h[0] = _record(S1, 8_000_000, 30); // one counterparty, baseline branch
        h[1] = _record(S2, 8_000_000, 30); // two counterparties, still the baseline branch
        h[2] = _record(S3, 8_000_000, 30); // crosses into the growth branch
        h[3] = _record(S4, 8_000_000, 30); // filtered on Asset, below
        h[3].asset = OTHER_ASSET;
        h[4] = _record(S1, 100_000_000, 30); // makes the concentration cap bind
        h[5] = _record(S4, 8_000_000, 30); // a fourth counterparty, cap still binding
        h[6] = _record(S1, 0, 30); // filtered on zero weight
        h[7] = _record(S1, 8_000_000, 30); // filtered on delivery precedence, below
        h[7].firstDeliveryAt = h[7].settledAt;
        h[8] = _record(S2, 8_000_000, 0); // a partially aged append into an existing bucket
    }

    /// @notice The first `len` records of `full`, as a fresh array.
    /// @param full The full history.
    /// @param len Number of leading records to keep.
    /// @return h The prefix.
    function _prefix(LimitLib.SettlementRecord[] memory full, uint256 len)
        private
        pure
        returns (LimitLib.SettlementRecord[] memory h)
    {
        h = new LimitLib.SettlementRecord[](len);
        for (uint256 i = 0; i < len; ++i) {
            h[i] = full[i];
        }
    }

    /// @notice Three counterparties settling `amount` at each of four ages, twelve records in all.
    /// @dev Balanced by construction: every counterparty carries the same amounts at the same ages, so
    /// the buckets are equal and the concentration term is inert as long as one contribution stays at
    /// or below the baseline. That is what lets Property 10 vary only the span.
    /// @param secondsAgo The four settlement offsets from the evaluation timestamp.
    /// @param amount Amount settled per record, in Asset base units.
    /// @return h The history.
    function _spanHistory(uint64[4] memory secondsAgo, uint128 amount)
        private
        pure
        returns (LimitLib.SettlementRecord[] memory h)
    {
        bytes32[3] memory parties = [S1, S2, S3];
        h = new LimitLib.SettlementRecord[](12);
        for (uint256 party = 0; party < 3; ++party) {
            for (uint256 k = 0; k < 4; ++k) {
                h[party * 4 + k] = _recordAt(parties[party], amount, secondsAgo[k]);
            }
        }
    }

    /// @notice Total settled value across a history, unweighted and unfiltered.
    /// @param h The history.
    /// @return total The sum of the settled amounts.
    function _totalSettled(LimitLib.SettlementRecord[] memory h) private pure returns (uint256 total) {
        for (uint256 i = 0; i < h.length; ++i) {
            total += h[i].amount;
        }
    }

    /// @notice Three counterparties that always count, plus a fourth whose delivery timestamp varies.
    /// @dev Every record settles 8.00 USDC fully aged, so each counted contribution is 4.00 USDC and
    /// the `k = 0` concentration candidate stays feasible at either counterparty count. The two
    /// outcomes are therefore 21.00 USDC with the fourth counted and 17.00 USDC without it.
    /// @param firstDeliveryAt Metered Delivery timestamp carried by the fourth record.
    /// @return h The history.
    function _precedenceHistory(uint64 firstDeliveryAt)
        private
        pure
        returns (LimitLib.SettlementRecord[] memory h)
    {
        h = new LimitLib.SettlementRecord[](4);
        h[0] = _record(S1, 8_000_000, 30);
        h[1] = _record(S2, 8_000_000, 30);
        h[2] = _record(S3, 8_000_000, 30);
        h[3] = _record(S4, 8_000_000, 30);
        h[3].firstDeliveryAt = firstDeliveryAt;
    }

    /// @notice Expands one fuzz seed into an independent draw per index.
    /// @param seed The generated seed.
    /// @param index Position the draw is for.
    /// @return value The draw.
    function _draw(uint96 seed, uint256 index) private pure returns (uint256 value) {
        value = uint256(keccak256(abi.encode(seed, index)));
    }
}
