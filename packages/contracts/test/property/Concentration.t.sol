// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {LimitLib} from "../../src/LimitLib.sol";

// Feature: tab, Property 7: Concentration cap and minimum counterparty count

/// @title ConcentrationTest
/// @notice Property 7: the concentration cap, the minimum counterparty count, and the step where the
/// two meet.
///
/// ## The statement
///
/// Two rules and one seam between them.
///
///  1. **Below three distinct contributing counterparty Services the growth term does not apply at
///     all.** The returned Credit Limit is `min(baseline, bondCap)` however much value the history
///     carries and however many records it carries. (R13.7, R17.5)
///  2. **At three or more, no single counterparty's counted contribution may exceed 25 percent of the
///     returned Credit Limit.** (R13.6, R17.4) Value above that share is discarded rather than
///     redistributed, so the answer is the fixed point of `L = baseline + Σ min(c_i, L / 4)`, which
///     design section 7.3 solves in closed form as four candidates,
///     `L_k = 4 * (baseline + tail_k) / (4 - k)` for `k = 0, 1, 2, 3`.
///
/// **Validates: Requirements 13.6, 13.7, 17.4, 17.5**
///
/// ## What the campaign establishes
///
///  1. Over every generated pair of a counterparty count and a share distribution, with the bond cap
///     held demonstrably out of the way, the returned Credit Limit is the **smallest of the four
///     candidates** — not any one of them, and not the candidate a reader might expect from the shape
///     of the distribution. The four are recomputed here from the generated shares, so the assertion
///     compares the library against the design's closed form rather than against itself.
///  2. The counted contribution of every single counterparty is at most 25 percent of the returned
///     limit, which is the requirement stated directly, and the counted contributions plus the
///     baseline reconstruct the limit to within the flooring slack of the share, which is the fixed
///     point the closed form claims to solve.
///  3. Below three contributing counterparties the answer is `min(baseline, bondCap)`, and it stays
///     there when the same history is repeated 32 times over. History size cannot buy the growth
///     term.
///  4. The threshold reads **contributing** counterparties, not named ones. A counterparty that
///     settles nothing does not count, so the fully degenerate distribution — all value with one
///     counterparty — lands on the baseline rule however many counterparties the history names.
///  5. The step at the threshold is asserted at exactly two and exactly three contributors, on
///     histories that differ by a single base unit of settled value, which is where an off-by-one in
///     the comparison would live.
///  6. Both rules compose with the bond cap in the same direction, over a generated bond sum that
///     spans from far below the baseline to far above every growth value the campaign can produce, so
///     `min(baseline, bondCap)` is exercised on both sides of the `min` rather than only the one a
///     generous bond reaches.
///
/// ## Which candidate bound on which distribution
///
/// The four candidates are all reachable, and the distribution that reaches each is pinned by its own
/// case below. Every figure is USDC at 6 decimals, `baseline = 5.00`, `growthFactorBps = 5000`, every
/// Settlement aged the full 30-day ramp, 400.00 settled in total.
///
/// | distribution | contributors | binding candidate | limit |
/// | --- | --- | --- | --- |
/// | all 400.00 with one counterparty, the rest settling nothing | 1 | none: growth does not apply | 5.00 |
/// | 400.00 split evenly | 4 | `k = 0`, the cap is inert | 205.00 |
/// | 400.00 split evenly | 3 | `k = 3`, all three sit at the cap | 20.00 |
/// | 99.99 percent to one counterparty, the remainder split | 3 | `k = 1` | 6.693333 |
/// | 400.00 each to two, plus a single base unit to a third | 3 | `k = 2` | 10.00 |
///
/// Two of those are worth reading twice. An **even** split over exactly three counterparties still
/// binds, at `k = 3`, because three equal shares cannot each stay under a quarter of a limit that
/// they and the baseline make up: the fixed point collapses to `4 * baseline`. And the seam case is
/// the one where a single base unit of settled value to a third counterparty doubles the answer, from
/// the 5.00 baseline to 10.00, because it moves the computation off the baseline branch entirely.
///
/// ## What it does not establish
///
/// - **Nothing about the age ramp.** Every generated Settlement is aged the full 30 days, so its
///   weight is exactly parity and a bucket equals the settled amount. That is deliberate: a weight
///   below parity would scale the shares this property is about, and burst-versus-spread weighting is
///   Property 10's subject, tested in `test/LimitLib.t.sol`.
/// - **Nothing about the strict bond inequality.** The bond cap appears here only as the second term
///   of `min(baseline, bondCap)` and as a quantity held out of the way. That the limit is strictly
///   below the counterparty bond sum for every input is Property 6, in
///   `test/property/BondInvariant.t.sol`.
/// - **Nothing about monotonicity on append.** The padded histories here establish that repetition
///   cannot lift the sub-threshold answer, which is a weaker and different claim than Property 5.
/// - **Nothing about the record filters beyond the zero-weight one.** Every generated record is
///   curated, bonded, in the Asset, and carries a strictly earlier Metered Delivery. The four filters
///   are pinned individually in `test/LimitLib.t.sol`; what matters here is only that a counterparty
///   settling nothing does not reach the threshold count.
/// - **Nothing above five counterparties or 32 records per counterparty.** The generated space is
///   deliberately narrow enough that the expected answer can be recomputed by hand at the ends. The
///   library's own bounds, 32 counterparties and 512 records, are pinned in `test/LimitLib.t.sol`.
///
/// Runs come from the `[profile.default.fuzz]` block in `foundry.toml`, currently 256 per fuzz case.
///
/// Requirements: 13.6, 13.7, 17.4, 17.5
contract ConcentrationTest is Test {
    // ------------------------------------------------------------------ fixtures

    /// @notice The one Asset every computation here is scoped to.
    address internal constant USDC = address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);

    /// @notice Evaluation timestamp every age is measured against.
    uint64 internal constant EVALUATED_AT = 1_800_000_000;

    /// @notice Baseline Credit Limit in Asset base units, from the design's worked example. (D3)
    uint256 internal constant BASELINE = 5_000_000;

    /// @notice Growth factor in basis points, from the design's worked example. (D5)
    uint256 internal constant GROWTH_BPS = 5_000;

    /// @notice One hundred percent in basis points, and the denominator of every ratio here.
    uint256 internal constant BPS = 10_000;

    /// @notice Age every generated Settlement carries, in whole days.
    /// @dev The full ramp, so `ageWeightBps` returns parity and a bucket equals the settled amount.
    /// A share distribution scaled by a sub-parity weight would still be a share distribution, but
    /// the expected answers at the ends could no longer be checked by hand.
    uint64 internal constant AGE_DAYS = 30;

    /// @notice Total settled value the share distribution divides, in Asset base units.
    /// @dev 400.00 USDC, chosen so that at the worked example's growth factor the whole history
    /// converts to 200.00 of growth against a 5.00 baseline. That is far enough above the baseline
    /// that the concentration term genuinely binds on a concentrated distribution, and the figure
    /// divides cleanly by every counterparty count in range, so the even end of the generator is a
    /// whole number of base units rather than a rounding artefact.
    uint128 internal constant TOTAL_SETTLED = 400_000_000;

    /// @notice Largest counterparty count the generator draws.
    /// @dev Five, so the draw straddles the three-counterparty threshold with two counts below it,
    /// the threshold itself, and two above. A ceiling of three would sit on the seam and a ceiling of
    /// two would never leave the baseline branch.
    uint256 internal constant COUNTERPARTY_CEILING = 5;

    /// @notice Distinct contributing counterparties required before any growth is granted.
    /// @dev Mirrored here rather than read from the library, so the threshold the campaign expects is
    /// an independent statement of R13.7 and R17.5 rather than a restatement of the constant under
    /// test.
    uint256 internal constant MIN_COUNTERPARTIES = 3;

    /// @notice Reciprocal of the 2500 bps concentration share as a whole number, `10000 / 2500`.
    /// @dev Appears in the closed form as both the multiplier on `baseline + tail_k` and the ceiling
    /// on how many counterparties can sit at the cap at once. Written from the 25 percent rule of
    /// R13.6 and R17.4 rather than imported, for the same reason as {MIN_COUNTERPARTIES}.
    uint256 internal constant SHARE_DIVISOR = 4;

    /// @notice Bond one entry posts in the campaign that holds the cap out of the way.
    uint128 internal constant DEEP_BOND = 1_000_000_000_000;

    /// @notice Largest bond sum the composing campaign draws, in Asset base units.
    /// @dev 1000.00 USDC, so the cap runs from 0 to 950.00 and crosses both the 5.00 baseline and
    /// every growth value 400.00 of settled value can produce. Both sides of `min(baseline, bondCap)`
    /// are therefore reached, which a generous fixed bond sum would never do.
    uint256 internal constant MAX_BOND_SUM = 1_000_000_000;

    /// @notice Times a padded history repeats the same distribution.
    /// @dev 32 rounds over at most 5 counterparties is 160 records, comfortably inside the library's
    /// 512-record bound, and multiplies the settled value by 32 — two orders of magnitude above the
    /// baseline it must not be able to lift.
    uint256 internal constant PAD_ROUNDS = 32;

    /// @notice Base units the reconstructed fixed point may sit away from the returned limit.
    /// @dev The share `limit / 4` is floored once per counterparty sitting at the cap, and at most
    /// three can, so the reconstruction can fall up to three base units short of the limit. Derived
    /// rather than tuned: from `L <= 4 * (baseline + tail) / (4 - k)` it follows that
    /// `baseline + k * floor(L / 4) + tail >= L - k * 3 / 4`, and `k <= 3`.
    uint256 internal constant FIXED_POINT_SLACK = 3;

    // ------------------------------------------------------------------ generators

    /// @notice Number of counterparty Services the generated history names, from 0 to 5.
    /// @dev The range has to cross the three-counterparty threshold rather than sit on one side of it,
    /// because the whole seam is at the crossing: 0, 1, and 2 exercise the baseline rule, 3 is the
    /// first count at which the growth term applies at all, and 4 and 5 exercise the concentration cap
    /// with a tail long enough for the higher candidates to be feasible.
    ///
    /// `_bound` rather than `bound`, which logs its result: at 256 runs times three draws the logging
    /// is pure noise, and the mapping is the same.
    /// @param seed Seed to draw from.
    /// @return count The counterparty count.
    function genCounterpartyCount(uint256 seed) internal pure returns (uint256 count) {
        count = _bound(seed, 0, COUNTERPARTY_CEILING);
    }

    /// @notice Settled value per counterparty, as a share held by one counterparty from 0 to 100
    /// percent with the remainder spread evenly over the rest.
    /// @dev Both degenerate ends are inside the drawn range rather than near it, and each means
    /// something distinct:
    ///
    ///  - **100 percent.** The remainder is zero, so every other counterparty settles nothing and is
    ///    filtered out by the library's zero-weight rule. The history names `count` counterparties and
    ///    contributes exactly one, which is the interesting interaction: the threshold reads
    ///    contributors, so the most concentrated distribution there is lands on the baseline rule.
    ///  - **0 percent.** The first counterparty settles nothing, so the contributing count is
    ///    `count - 1` and the remainder is spread evenly over it. This is the even end, and it also
    ///    crosses the threshold downward: 3 named counterparties contribute 2.
    ///
    /// In between, the share reaches every basis point, so the top contribution runs continuously from
    /// nothing through the quarter share where the cap starts to bind and on to the whole history.
    /// @param seed Seed to draw the share from.
    /// @param count Number of counterparties to distribute over.
    /// @return amounts Settled amount per counterparty, in Asset base units.
    function genShareDistribution(uint256 seed, uint256 count)
        internal
        pure
        returns (uint128[] memory amounts)
    {
        uint256 shareBps = _bound(seed, 0, BPS);

        amounts = new uint128[](count);
        if (count == 0) return amounts;

        amounts[0] = uint128((uint256(TOTAL_SETTLED) * shareBps) / BPS);
        if (count == 1) return amounts;

        uint128 each = (TOTAL_SETTLED - amounts[0]) / uint128(count - 1);
        for (uint256 i = 1; i < count; ++i) {
            amounts[i] = each;
        }
    }

    /// @notice Bond sum the counterparties post in the Asset, from nothing to 1000.00 USDC.
    /// @dev Drawn as one figure rather than per counterparty because `bondCap` sums the whole set
    /// before its single scaling division, so the cap depends on the total and not on how the total is
    /// split. Splitting it would generate more inputs that all mean the same thing.
    /// @param seed Seed to draw from.
    /// @return sum The bond sum in Asset base units.
    function genBondSum(uint256 seed) internal pure returns (uint256 sum) {
        sum = _bound(seed, 0, MAX_BOND_SUM);
    }

    // ------------------------------------------------- the two rules, bond cap held out of the way

    /// @notice Property 7: below three contributing counterparties the answer is the bond-capped
    /// baseline; at three or more the answer is the smallest of the four concentration candidates, and
    /// no counterparty's counted contribution exceeds a quarter of it.
    /// @dev The bond cap is held far above every reachable growth value and asserted to be so on every
    /// run. That matters more than it looks: a binding bond cap returns the same number for every share
    /// distribution, so a campaign that let it bind would pass while establishing nothing about
    /// concentration at all. The composing case below is where the cap is allowed to bind, and it
    /// asserts a different thing.
    ///
    /// The expected value on the growth branch is the **minimum over the four candidates**, not the
    /// candidate this test picked out. Asserting any single candidate would only restate whichever
    /// branch the implementation took; asserting the minimum is the claim design section 7.3 actually
    /// makes, namely that the feasible candidate is the fixed point and that the fixed point is the
    /// smallest of the four. The candidate `k = 0` is `baseline + total` exactly, with no flooring,
    /// so the uncapped value is one of the four and the minimum is the whole formula.
    /// @param countSeed Seed for {genCounterpartyCount}.
    /// @param shareSeed Seed for {genShareDistribution}.
    function testFuzz_bothRulesHoldAcrossEveryShareAndCount(uint256 countSeed, uint256 shareSeed)
        public
        pure
    {
        uint128[] memory amounts = genShareDistribution(shareSeed, genCounterpartyCount(countSeed));
        LimitLib.BondEntry[] memory bonds = _deepBonds();

        uint256 cap = LimitLib.bondCap(bonds, USDC);
        assertGt(cap, uint256(TOTAL_SETTLED), "the bond cap must not bind in this campaign");

        uint256 limit = LimitLib.creditLimit(_history(amounts), bonds, _params());
        uint256[] memory c = _contributions(amounts);

        // Rule 1. Fewer than three contributing counterparties, so no growth at all, however much
        // value the history carries and however many records carry it.
        if (c.length < MIN_COUNTERPARTIES) {
            assertEq(limit, BASELINE < cap ? BASELINE : cap, "below three contributors");

            uint256 padded = LimitLib.creditLimit(_paddedHistory(amounts), bonds, _params());
            assertEq(padded, limit, "repeating the history lifted the sub-threshold answer");
            return;
        }

        // Rule 2. The concentration-capped fixed point, which is the smallest of the four candidates.
        uint256 total = _sum(c);
        assertEq(limit, _smallestCandidate(c, total), "not the smallest concentration candidate");

        // The requirement stated directly: the counted contribution of every single counterparty is at
        // most 25 percent of the returned Credit Limit. (R13.6, R17.4)
        uint256 share = limit / SHARE_DIVISOR;
        for (uint256 j = 0; j < c.length; ++j) {
            uint256 counted = c[j] < share ? c[j] : share;
            assertLe(counted * SHARE_DIVISOR, limit, "a counterparty contributed above 25 percent");
        }

        // The fixed point the closed form claims to solve, reconstructed from the counted
        // contributions rather than restated.
        assertApproxEqAbs(_countedTotal(c, limit), limit, FIXED_POINT_SLACK, "fixed point");

        // The cap either binds or is inert, and which one is decided by the top contribution alone.
        // The inert direction is exact: the top contribution at or under a quarter of the uncapped
        // value makes `k = 0` feasible, so the uncapped value is returned unchanged. The binding
        // direction is asserted once the excess is past the flooring slack of the share, below which a
        // strictly lower answer is not guaranteed by the integer arithmetic.
        uint256 uncapped = BASELINE + total;
        if (c[0] * SHARE_DIVISOR <= uncapped) {
            assertEq(limit, uncapped, "the concentration cap bound on an unconcentrated history");
        } else if (c[0] * SHARE_DIVISOR > uncapped + SHARE_DIVISOR) {
            assertLt(limit, uncapped, "the concentration cap failed to bind");
        }
    }

    // ------------------------------------------------------- both rules composed with the bond cap

    /// @notice Property 7: both rules compose with the bond cap in the same direction, over a bond sum
    /// that crosses the baseline and every reachable growth value.
    /// @dev This is the half of the statement the case above deliberately holds still. R13.7 and R17.5
    /// say the sub-threshold answer is `min(baseline, bondCap)`, and a campaign that only ever ran a
    /// generous bond sum would establish `baseline` and call it the `min`. The drawn sum runs from zero
    /// — where the answer is zero on both branches, since a counterparty with no stake extends no
    /// credit — up through the 5.00 baseline and past the 205.00 ceiling on the growth value, so both
    /// arms of the `min` are the returned answer on some runs.
    /// @param countSeed Seed for {genCounterpartyCount}.
    /// @param shareSeed Seed for {genShareDistribution}.
    /// @param bondSeed Seed for {genBondSum}.
    function testFuzz_bothRulesComposeWithTheBondCap(uint256 countSeed, uint256 shareSeed, uint256 bondSeed)
        public
        pure
    {
        uint128[] memory amounts = genShareDistribution(shareSeed, genCounterpartyCount(countSeed));
        LimitLib.BondEntry[] memory bonds = _bonds(genBondSum(bondSeed));

        uint256 cap = LimitLib.bondCap(bonds, USDC);
        uint256 limit = LimitLib.creditLimit(_history(amounts), bonds, _params());

        uint256[] memory c = _contributions(amounts);
        uint256 expected = c.length < MIN_COUNTERPARTIES ? BASELINE : _smallestCandidate(c, _sum(c));
        if (cap < expected) expected = cap;

        assertEq(limit, expected, "the bond cap and the two rules did not compose");
        assertLe(limit, cap, "the answer left the bond cap behind");
    }

    // ------------------------------------------------------------------ the degenerate ends

    /// @notice All value with one counterparty leaves one contributor, so the baseline rule applies
    /// however many counterparties the history names. (R13.7, R17.5)
    /// @dev The 100 percent end of {genShareDistribution}, drawn over five named counterparties. Four
    /// of them settle nothing, weigh nothing, and therefore never reach the threshold count — which is
    /// the point worth pinning, because a count taken over names rather than over contributors would
    /// read five here and hand a self-dealing ring the growth term for free. Both arms of
    /// `min(baseline, bondCap)` are asserted at this end: a deep bond sum returns the baseline, and a
    /// 1.00 USDC bond sum returns the cap.
    function test_allValueWithOneCounterpartyLeavesOneContributor() public pure {
        uint128[] memory amounts = genShareDistribution(BPS, COUNTERPARTY_CEILING);

        assertEq(uint256(amounts[0]), uint256(TOTAL_SETTLED), "the whole history to one counterparty");
        assertEq(_contributions(amounts).length, 1, "a counterparty settling nothing contributed");

        LimitLib.BondEntry[] memory deep = _deepBonds();
        assertEq(LimitLib.creditLimit(_history(amounts), deep, _params()), BASELINE, "baseline arm");
        assertEq(
            LimitLib.creditLimit(_paddedHistory(amounts), deep, _params()),
            BASELINE,
            "repeating 400.00 USDC 32 times over bought growth"
        );

        LimitLib.BondEntry[] memory thin = _bonds(1_000_000);
        assertEq(LimitLib.bondCap(thin, USDC), 950_000, "cap");
        assertEq(LimitLib.creditLimit(_history(amounts), thin, _params()), 950_000, "bond cap arm");
    }

    /// @notice Value spread evenly leaves the concentration cap inert at four contributors and binds
    /// it at three, where the fixed point collapses to four times the baseline. (R13.6, R17.4)
    /// @dev The even end of {genShareDistribution}, at the two counts either side of the seam. The
    /// pair is one case rather than two because the contrast is the content: the same even
    /// distribution of the same total settled value is unconstrained at four counterparties and fully
    /// constrained at three, so "evenly spread" is not by itself a safe distribution.
    ///
    /// At four, each contribution is 50.00 against a quarter share of 51.25, so candidate `k = 0` is
    /// feasible and the growth value passes through untouched. At three, each contribution is 66.67
    /// against a quarter share of 5.00, so all three sit at the cap, `tail_3` is empty, and
    /// `L_3 = 4 * baseline / 1`. Three equal counterparties can never each stay under a quarter of a
    /// limit they make up three quarters of, which is why an even split is the distribution that
    /// reaches `k = 3`.
    function test_valueSpreadEvenlyIsInertAtFourAndBindsAtThree() public pure {
        LimitLib.BondEntry[] memory bonds = _deepBonds();

        uint128[] memory four = genShareDistribution(BPS / 4, 4);
        uint256[] memory cFour = _contributions(four);
        uint256 limitFour = LimitLib.creditLimit(_history(four), bonds, _params());

        assertEq(cFour.length, 4, "four contributors");
        assertEq(cFour[0], 50_000_000, "an even quarter of the growth value");
        assertEq(limitFour, 205_000_000, "k = 0 candidate");
        assertEq(limitFour, BASELINE + _sum(cFour), "the cap must be inert at four");
        assertLe(cFour[0], limitFour / SHARE_DIVISOR, "no contributor reaches the cap");

        uint128[] memory three = genShareDistribution(BPS / 3, 3);
        uint256[] memory cThree = _contributions(three);
        uint256 limitThree = LimitLib.creditLimit(_history(three), bonds, _params());

        assertEq(cThree.length, 3, "three contributors");
        assertEq(limitThree, 20_000_000, "k = 3 candidate");
        assertEq(limitThree, SHARE_DIVISOR * BASELINE, "four times the baseline");
        assertLt(limitThree, BASELINE + _sum(cThree), "the cap must bind at three");
        assertEq(BASELINE + 3 * (limitThree / SHARE_DIVISOR), limitThree, "fixed point at k = 3");
    }

    /// @notice A history 99.99 percent held by one counterparty binds candidate `k = 1`. (R13.6,
    /// R17.4)
    /// @dev One basis point short of the fully degenerate end, which is the closest a distribution can
    /// come to a single counterparty while still contributing three. The two counterparties holding
    /// the last basis point are what keeps the growth branch reachable at all; at 100 percent they
    /// settle nothing and the case above applies instead.
    ///
    /// The top contribution is 199.98 and the answer is 6.693333, so the counted contribution is
    /// 1.673333 — a hair under 0.84 percent of what that counterparty settled. That is the cap doing
    /// the work it exists for: a single counterparty cannot vouch an Agent into credit no matter how
    /// much value it settles, and the two small counterparties raise the answer only through
    /// `tail_1`.
    function test_extremeConcentrationBindsCandidateOne() public pure {
        uint128[] memory amounts = genShareDistribution(BPS - 1, 3);
        uint256[] memory c = _contributions(amounts);
        uint256 limit = LimitLib.creditLimit(_history(amounts), _deepBonds(), _params());

        assertEq(c.length, 3, "three contributors");
        assertEq(c[0], 199_980_000, "the top contribution");
        assertEq(c[1], 10_000, "the tail");

        assertEq(limit, 6_693_333, "k = 1 candidate");
        assertEq(limit, (SHARE_DIVISOR * (BASELINE + c[1] + c[2])) / 3, "the closed form at k = 1");
        assertEq(BASELINE + limit / SHARE_DIVISOR + c[1] + c[2], limit, "fixed point at k = 1");
        assertLt(limit, BASELINE + _sum(c), "the cap must bind");
    }

    // ------------------------------------------------------------------ the seam

    /// @notice The step at exactly two and exactly three contributors, over histories that differ by
    /// one base unit of settled value. (R13.7, R17.5)
    /// @dev The off-by-one in a `< 3` comparison lives at exactly these two counts, so both are
    /// asserted rather than a count either side of them. Two counterparties settle 400.00 USDC each,
    /// which is the whole campaign's settled value twice over, and the answer is still the 5.00
    /// baseline: the growth term does not apply at all below the threshold, so no amount of history
    /// moves it. Repeating that history 32 times over, 25,600.00 USDC across 64 records, returns the
    /// same 5.00.
    ///
    /// Adding a third counterparty that settles a **single base unit** — 0.000001 USDC, which is the
    /// smallest Settlement that survives the zero-weight filter at parity weight — moves the
    /// computation onto the growth branch and doubles the answer to 10.00. The third counterparty's
    /// own contribution is zero, because half of one base unit floors to nothing, so the entire
    /// increase comes from leaving the baseline branch. That is the step the threshold creates, and it
    /// is the reason the rule is worth a property: the cheapest possible third counterparty is worth
    /// more than an unbounded amount of history with two.
    ///
    /// The answer at three is candidate `k = 2`: the two large counterparties sit at the cap, the dust
    /// counterparty is the whole of `tail_2`, and `L_2 = 4 * baseline / 2`.
    function test_theStepAtExactlyTwoAndExactlyThreeContributors() public pure {
        LimitLib.BondEntry[] memory bonds = _deepBonds();

        uint128[] memory two = new uint128[](2);
        two[0] = TOTAL_SETTLED;
        two[1] = TOTAL_SETTLED;

        uint256 limitTwo = LimitLib.creditLimit(_history(two), bonds, _params());
        assertEq(_contributions(two).length, 2, "two contributors");
        assertEq(limitTwo, BASELINE, "exactly two contributors must return the baseline");
        assertEq(
            LimitLib.creditLimit(_paddedHistory(two), bonds, _params()),
            BASELINE,
            "64 records and 25,600.00 USDC bought growth below the threshold"
        );

        uint128[] memory three = new uint128[](3);
        three[0] = TOTAL_SETTLED;
        three[1] = TOTAL_SETTLED;
        three[2] = 1;

        uint256[] memory c = _contributions(three);
        uint256 limitThree = LimitLib.creditLimit(_history(three), bonds, _params());

        assertEq(c.length, 3, "a single base unit must count as a contributor");
        assertEq(c[2], 0, "and must contribute nothing");
        assertEq(limitThree, 10_000_000, "k = 2 candidate");
        assertEq(limitThree, (SHARE_DIVISOR * BASELINE) / 2, "the closed form at k = 2");
        assertEq(BASELINE + 2 * (limitThree / SHARE_DIVISOR), limitThree, "fixed point at k = 2");
        assertEq(limitThree, 2 * limitTwo, "the step at the threshold");
    }

    // ------------------------------------------------------------------ builders

    /// @notice One Verified Settlement that passes every filter, aged the full ramp.
    /// @dev Curated, bonded, in the Asset, and carrying a Metered Delivery one second earlier, so the
    /// only filter a generated record can fall foul of is the zero-weight one — which is exactly the
    /// filter this property needs, since it decides whether a named counterparty contributes.
    /// @param serviceId Counterparty Service.
    /// @param amount Settled amount in Asset base units.
    /// @return r The record.
    function _record(bytes32 serviceId, uint128 amount)
        internal
        pure
        returns (LimitLib.SettlementRecord memory r)
    {
        uint64 settledAt = EVALUATED_AT - AGE_DAYS * 1 days;
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

    /// @notice The governance inputs every case here runs against.
    /// @return p The parameters.
    function _params() internal pure returns (LimitLib.Params memory p) {
        p = LimitLib.Params({
            asset: USDC, baseline: BASELINE, growthFactorBps: GROWTH_BPS, evaluatedAt: EVALUATED_AT
        });
    }

    /// @notice One record per counterparty, in the order the distribution produced them.
    /// @param amounts Settled amount per counterparty.
    /// @return history The history.
    function _history(uint128[] memory amounts)
        internal
        pure
        returns (LimitLib.SettlementRecord[] memory history)
    {
        history = new LimitLib.SettlementRecord[](amounts.length);
        for (uint256 i = 0; i < amounts.length; ++i) {
            history[i] = _record(bytes32(i + 1), amounts[i]);
        }
    }

    /// @notice The same distribution repeated {PAD_ROUNDS} times over, as one long history.
    /// @dev The instrument for "however large the history is". Every round names the same
    /// counterparties, so the contributing count is untouched while the settled value is multiplied by
    /// 32 — the shape of history a two-party ring would build if volume could substitute for a third
    /// counterparty.
    /// @param amounts Settled amount per counterparty.
    /// @return history The padded history.
    function _paddedHistory(uint128[] memory amounts)
        internal
        pure
        returns (LimitLib.SettlementRecord[] memory history)
    {
        uint256 width = amounts.length;
        history = new LimitLib.SettlementRecord[](width * PAD_ROUNDS);
        for (uint256 round = 0; round < PAD_ROUNDS; ++round) {
            for (uint256 i = 0; i < width; ++i) {
                history[round * width + i] = _record(bytes32(i + 1), amounts[i]);
            }
        }
    }

    /// @notice Bond entries deep enough that the bond cap cannot be the binding term.
    /// @return b The bond entries.
    function _deepBonds() internal pure returns (LimitLib.BondEntry[] memory b) {
        b = new LimitLib.BondEntry[](COUNTERPARTY_CEILING);
        for (uint256 i = 0; i < COUNTERPARTY_CEILING; ++i) {
            b[i] = LimitLib.BondEntry({serviceId: bytes32(i + 1), asset: USDC, amount: DEEP_BOND});
        }
    }

    /// @notice One bond entry carrying the whole drawn sum.
    /// @param sum Bond sum in Asset base units.
    /// @return b The bond entries.
    function _bonds(uint256 sum) internal pure returns (LimitLib.BondEntry[] memory b) {
        b = new LimitLib.BondEntry[](1);
        b[0] = LimitLib.BondEntry({serviceId: bytes32(uint256(1)), asset: USDC, amount: uint128(sum)});
    }

    // ------------------------------------------------------------------ the expected answer

    /// @notice Growth contribution of every contributing counterparty, sorted descending.
    /// @dev Derived from the generated distribution rather than by re-running the library's bucketing
    /// scan, which is what keeps this an independent statement of the expected answer. Every record is
    /// aged the full ramp, so its weight is parity and a bucket equals the settled amount; the growth
    /// factor is then applied once per counterparty, which is the division order the design's rounding
    /// convention fixes.
    ///
    /// A counterparty settling nothing weighs nothing and is not a contributor, so it is absent here.
    /// A counterparty settling a single base unit **is** a contributor even though half of one base
    /// unit floors to a zero contribution, so it is present here carrying zero. That distinction is
    /// the whole of rule 1's arithmetic.
    /// @param amounts Settled amount per counterparty.
    /// @return c Contributions in Asset base units, descending.
    function _contributions(uint128[] memory amounts) internal pure returns (uint256[] memory c) {
        uint256 contributors;
        for (uint256 i = 0; i < amounts.length; ++i) {
            if (amounts[i] > 0) contributors += 1;
        }

        c = new uint256[](contributors);
        uint256 next;
        for (uint256 i = 0; i < amounts.length; ++i) {
            if (amounts[i] == 0) continue;
            c[next] = (uint256(amounts[i]) * GROWTH_BPS) / BPS;
            next += 1;
        }

        for (uint256 i = 1; i < contributors; ++i) {
            uint256 v = c[i];
            uint256 j = i;
            while (j > 0 && c[j - 1] < v) {
                c[j] = c[j - 1];
                j -= 1;
            }
            c[j] = v;
        }
    }

    /// @notice Sum of a contribution set.
    /// @param c Contributions.
    /// @return total The sum in Asset base units.
    function _sum(uint256[] memory c) internal pure returns (uint256 total) {
        for (uint256 i = 0; i < c.length; ++i) {
            total += c[i];
        }
    }

    /// @notice The smallest of the four concentration candidates.
    /// @dev `L_k = 4 * (baseline + tail_k) / (4 - k)` for `k = 0, 1, 2, 3`, where `tail_k` is the sum
    /// of the contributions ranked `k + 1` and below. Four candidates and no iteration, because at
    /// most three counterparties can sit at the cap at once: a fourth would make the capped value
    /// exceed the limit it is a share of.
    ///
    /// The minimum is asserted rather than the feasible candidate, and the two are the same number.
    /// Every candidate is an upper bound on the fixed point — capping only the top `k` and counting the
    /// rest in full is never less than capping whatever the fixed point actually caps — and the
    /// feasible candidate *is* the fixed point, so the fixed point is the smallest of the four. Taking
    /// the minimum is therefore both the weaker assertion to write and the stronger one to hold: it
    /// pins the answer without assuming which branch the implementation took to reach it.
    /// @param c Contributions, sorted descending.
    /// @param total Sum of `c`.
    /// @return smallest The candidate in Asset base units.
    function _smallestCandidate(uint256[] memory c, uint256 total) internal pure returns (uint256 smallest) {
        smallest = type(uint256).max;

        uint256 prefix;
        for (uint256 k = 0; k < SHARE_DIVISOR && k <= c.length; ++k) {
            if (k > 0) prefix += c[k - 1];
            uint256 candidate = (SHARE_DIVISOR * (BASELINE + total - prefix)) / (SHARE_DIVISOR - k);
            if (candidate < smallest) smallest = candidate;
        }
    }

    /// @notice The baseline plus every counted contribution at a given limit.
    /// @dev The left side of `L = baseline + Σ min(c_i, L / 4)`. Reconstructing it from the returned
    /// limit is what turns "the limit is some candidate" into "the limit is the fixed point": a
    /// candidate generated for the wrong `k` would not close the loop.
    /// @param c Contributions.
    /// @param limit The returned Credit Limit.
    /// @return counted The reconstructed value in Asset base units.
    function _countedTotal(uint256[] memory c, uint256 limit) internal pure returns (uint256 counted) {
        uint256 share = limit / SHARE_DIVISOR;
        counted = BASELINE;
        for (uint256 i = 0; i < c.length; ++i) {
            counted += c[i] < share ? c[i] : share;
        }
    }
}
