// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test, console} from "forge-std/Test.sol";
import {LimitLib} from "../../src/LimitLib.sol";

// Feature: tab, Property 6: Credit is strictly under the counterparty bond sum
//
// **Validates: Requirements 13.5, 17.1**
//
// For any Verified Settlement history over any counterparty Service set, and for any per-counterparty
// Bond amounts in the same Asset, the Credit Limit `LimitLib.creditLimit` returns is strictly less than
// the sum of those Bonds whenever that sum is non-zero, and is exactly zero when that sum is zero.
//
// **Why the zero case is the sharp one, and why it is named first.** A ceiling that only trimmed large
// answers would be a discount on credit rather than a bound on it. The statement that makes the bond
// sum a cap is the degenerate one: with no stake posted in the Asset the Credit Limit is exactly zero,
// however long the history, however well aged, however well spread across counterparties, and the
// configured baseline does not survive it either. `LimitLib` earns that by ending every return path in
// a `min` against the cap — including step 3, the branch that returns the baseline — so
// {testFuzz_zeroBondSumYieldsZeroCreditForAnyHistory} drives histories up to the full 512-record bound
// at parity weight, against a baseline forced non-zero so the comparison run cannot pass vacuously.
//
// **The generators.** Three, named by task 8.4 and implemented as the functions below.
//
//   - `genCounterpartySet(1..8)` is {_genCounterpartySet}: a count in `[1, 8]`, and identifiers that are
//     distinct and nothing else. Distinctness is the only property of a `serviceId` this computation
//     can observe — it buckets on equality and never on ordering or magnitude — so a set of small
//     distinct words is the whole input space rather than a sample of it. The count reaches below the
//     three-counterparty threshold on a quarter of the draws, which is how the baseline branch of step
//     3 is reached at all.
//   - `genHistory()` is {_genHistory}: a length drawn as whole rounds over the counterparty set and
//     reaching 64 records, each record routed to a drawn member of that set, amounts drawn over
//     `[0, 2^96)`, ages over `[0, 60]` whole days so both ends of the age ramp and the clamp past it are
//     exercised, and roughly one record in eight deliberately failing one of the four filters — another
//     Asset, uncurated, unbonded, or a Metered Delivery that is not strictly earlier. Those failures
//     matter here rather than being decoration: a filtered
//     record leaves its counterparty bonded but not contributing, so the bonded set becomes a strict
//     superset of the contributing set, which is the shape in which a cap computed over the wrong set
//     would show up. A skew flag, drawn independently of the stake regime, decides whether one
//     counterparty draws an order of magnitude above the others; skewed histories are what make the
//     concentration term bind, and balanced ones over a wide counterparty set are what leave the growth
//     term binding.
//   - `genBondAmounts(0..2^96)` is {_genBondAmounts}: one entry per drawn counterparty, amounts over
//     `[0, 2^96)`, under four regimes that decide the magnitude relative to the history — deep stake,
//     shallow stake, no stake at all, and unshaped over the full range. On part of the draws a second
//     entry per counterparty is added in another Asset carrying a full-range amount, which must never
//     raise the cap, because this system holds no price feed and converts nothing (R18.5).
//
// **The regimes exist so that the campaign is not silently only ever testing one branch.** With stake
// and history amounts drawn over the same range, the bond cap binds on nearly every draw and the run
// establishes almost nothing about the answer when the cap is slack. So each draw picks a regime, and
// {test_theSweepReachesEveryBindingTermAndTheInvariantHoldsOnEveryDraw} walks 256 draws deterministically
// and tallies which of the four terms the returned figure actually came out of. The sweep is
// deterministic, so those tallies are figures rather than estimates: **bond cap 136 draws, concentration
// cap 59, baseline 41, growth 20**, summing to 256. Every term is reached, and the sweep asserts that
// rather than merely printing it, so a later change that collapsed the campaign onto one branch fails
// here instead of passing quietly. The growth term is the scarcest of the four and that is a fact about
// the computation rather than about the generators: the concentration cap binds the moment any single
// counterparty contributes more than a quarter of the answer, which a randomly drawn bucket set usually
// does, so growth binds only over a wide balanced counterparty set or under a baseline that dominates
// the earned growth. Both arrangements are drawn here, and the growth term is additionally pinned
// deterministically by two rows of
// {test_theBondCapBindsByOneBaseUnitAndOneUnitOfStakeReleasesIt}.
//
// **Reaching the boundary from below.** {test_theBondCapBindsByOneBaseUnitAndOneUnitOfStakeReleasesIt}
// pins the crossing at single-base-unit resolution on a hand-built history whose growth term is exactly
// 17.000000 USDC: a bond sum of 17_894_736 gives a cap of 16_999_999 and binds by one base unit, and
// 17_894_737 — one base unit more stake — gives a cap of exactly 17_000_000, which touches the answer
// without reducing it, so the growth term binds instead. A third row leaves the cap plainly slack and a
// fourth drops to two counterparties so the baseline is the binding term. Adjacent bond sums either
// side of the crossing are what distinguish a cap applied in the right place from one applied a rounding
// step early or late.
//
// **On non-vacuity, and which mutation was available.** The usual demonstration is to break the
// constant in the library and watch the campaign fail. `LimitLib.BOND_CAP_BPS` is in `src/`, which this
// task does not own and which four concurrent tasks are building against, so mutating it even briefly is
// not available. What stands in its place is
// {test_theStrictMarginIsTheConstantRatherThanARoundingAccident}: a case where the cap binds at
// 9_500_000 against a bond sum of 10_000_000, so the answer a 10_000-basis-point cap would return is
// exactly the bond sum, and the strict comparison this campaign makes on every draw is the assertion
// that rejects it. The sweep's bond-cap tally is the other half of the argument — 136 of 256 draws
// returned the cap itself, and on each of those the strict inequality is the only thing standing
// between the returned figure and the stake behind it, since every other term was larger.
//
// The one mutation that was available was run and reverted: tightening this file's own expectation from
// 9_500 to 9_000 basis points, which is a claim `LimitLib` does not satisfy. The fuzz campaign failed on
// its first run with the counterexample `937_280_073_907 > 887_949_543_701`, and all three deterministic
// cases failed — the boundary case at `16_999_999 > 16_105_262`, the margin case at
// `9_500_000 > 9_000_000`, and the sweep at `510_299_713_643 > 483_441_833_978`. So the comparisons here
// are reached on generated input and are sensitive to the cap constant in the last base unit rather than
// merely to its order of magnitude. {testFuzz_zeroBondSumYieldsZeroCreditForAnyHistory} went on passing
// under the mutation, which is correct and worth saying: a zero stake sum takes the equality branch and
// never evaluates the inequality at all, so that case is deliberately insensitive to how tight the cap
// is and sensitive only to whether it exists.
//
// **What this establishes.** Over generated histories and bond sets, for every counterparty count from
// 1 to 8, at every point of the age ramp, with contributing and bonded counterparty sets that agree and
// that deliberately disagree, and across all four binding terms: the returned Credit Limit is at most
// `sum(stake in the Asset) * 9500 / 10000`, is strictly less than that stake sum whenever it is
// non-zero, and is exactly zero whenever it is zero. The cross-asset entries establish that stake in
// another Asset raises neither the cap nor the limit. The bound is checked against a sum this test
// totals itself from the generated entries, not against a figure read back from the library.
//
// **What it does not establish.** Nothing about where the bond figures come from on chain. `LimitLib`
// takes the bond set as an argument and does not check it against the history, so the invariant it can
// state is over the set it was handed; the correspondence — no duplicate counterparty, every in-scope
// entry a real counterparty of this Agent, and every amount read from the ledger rather than supplied
// by the caller — is enforced by `TabBook._resolveBonds` and belongs to that contract's tests. Nothing
// about the concentration cap or the three-counterparty threshold as claims in their own right, which
// are Property 7 in `test/property/Concentration.t.sol`; the term classification here reports which of
// them bound and never judges the answer. Nothing about the numeric value of the limit in general: this
// campaign bounds it, and the worked example in `test/LimitLib.t.sol` pins it. And nothing about the
// bond ledger itself, since no `Bond` contract is involved — the library is pure, reads no storage, and
// makes no external call, so this campaign needs no tree, no registry, and no precompile.
contract BondInvariantTest is Test {
    // ------------------------------------------------------------------ fixtures

    /// @notice The Asset every computation here is scoped to.
    address internal constant USDC = address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);

    /// @notice A second Asset, carried only to establish that stake outside the scope is not coverage.
    address internal constant OTHER_ASSET = address(0xdAC17F958D2ee523a2206206994597C13D831ec7);

    /// @notice Evaluation timestamp. High enough that a 60-day age stays positive.
    uint64 internal constant EVALUATED_AT = 1_800_000_000;

    /// @notice Growth factor the hand-built cases use, in basis points.
    uint256 internal constant GROWTH_BPS = 5_000;

    /// @notice Baseline the hand-built cases use, in Asset base units.
    uint256 internal constant BASELINE = 5_000_000;

    /// @notice Largest counterparty set the generators draw, per task 8.4.
    uint256 internal constant MAX_PARTIES = 8;

    /// @notice Largest generated amount, exclusive. `2^96`, per task 8.4.
    uint256 internal constant AMOUNT_CEILING = 2 ** 96;

    /// @notice Draws in the deterministic sweep, matched to `[profile.default.fuzz] runs`.
    uint256 internal constant SWEEP_DRAWS = 256;

    /// @notice The growth term of {_threeCounterpartyHistory} at {BASELINE} and {GROWTH_BPS}.
    /// @dev Three fully aged Settlements of 8.00 USDC weigh 8_000_000 each at parity, contribute
    /// 4_000_000 each at a 5_000-basis-point growth factor, and land 12_000_000 on a 5_000_000
    /// baseline. The `k = 0` concentration candidate is `4 * 17_000_000 / 4` and is feasible, since
    /// `4_000_000 * 4 <= 17_000_000`, so the concentration term is inert and the bond cap is the only
    /// term the boundary cases below move.
    uint256 internal constant UNCAPPED = 17_000_000;

    /// @notice Which term the returned Credit Limit came out of.
    /// @dev Diagnostic only, and deliberately so: every assertion in this file compares the returned
    /// figure against a bond sum this test totalled itself, so a misclassification here can lose a
    /// tally but cannot pass a violation. `BondCap` absorbs the ties, where the cap equals the
    /// concentration-capped value and both are below the uncapped one.
    enum Term {
        Baseline,
        Growth,
        Concentration,
        BondCap
    }

    /// @notice Magnitude of the generated stake relative to the generated history.
    /// @dev The four regimes, crossed with the independent skew flag of {_genHistory}, are what make
    /// each of the four terms reachable. `DeepBonds` lifts the cap clear of any growth term a 64-record
    /// history can reach, so whichever of growth or concentration is larger is what binds; `ShallowBonds`
    /// puts the cap far below the growth term; `NoBonds` is the all-zero case task 8.4 names; `Unshaped`
    /// draws both sides over the full range and takes whatever relation falls out.
    enum Regime {
        DeepBonds,
        ShallowBonds,
        NoBonds,
        Unshaped
    }

    // ------------------------------------------------------------------ the property

    /// @notice Property 6: the returned Credit Limit is strictly under the counterparty bond sum, and
    /// exactly zero when that sum is zero. (R13.5, R17.1)
    /// @dev The whole statement in one campaign. Every draw picks a counterparty set, a history over
    /// it, a bond set keyed on the same counterparties, a regime deciding their relative magnitude, and
    /// governance inputs; {_assertBondInvariant} then makes the three comparisons that are the property
    /// and returns which term bound so that the sweep below can tally it.
    ///
    /// The generators stay inside the input space by construction, so there is no `vm.assume` anywhere
    /// and no draw is rejected: lengths sit under `MAX_HISTORY`, counterparty counts under
    /// `MAX_COUNTERPARTIES`, and amounts under `2^96`, which keeps the widest intermediate — four times
    /// a 64-record bucket scaled by a 65_535-basis-point growth factor — five orders of magnitude below
    /// where `uint256` stops being able to hold it. Runs come from `[profile.default.fuzz]`, currently
    /// 256.
    /// @param historySeed Seeds the history length, and each record's counterparty, amount, age, and
    /// whether it is built to fail a filter.
    /// @param bondSeed Seeds each counterparty's stake and the cross-asset entries.
    /// @param shapeSeed Seeds the counterparty count and the regime.
    /// @param baseline Baseline Credit Limit in Asset base units.
    /// @param growthFactorBps Growth factor in basis points.
    function testFuzz_creditIsStrictlyUnderTheCounterpartyBondSum(
        uint256 historySeed,
        uint256 bondSeed,
        uint256 shapeSeed,
        uint96 baseline,
        uint16 growthFactorBps
    ) public pure {
        uint256 parties = _genCounterpartySet(shapeSeed);
        Regime regime = Regime(_bound(shapeSeed >> 8, 0, 3));
        bool skew = (shapeSeed >> 16) % 2 == 0;

        LimitLib.SettlementRecord[] memory history = _genHistory(historySeed, parties, regime, skew);
        (LimitLib.BondEntry[] memory bonds, uint256 stake) = _genBondAmounts(bondSeed, parties, regime);
        LimitLib.Params memory p = _paramsWith(baseline, growthFactorBps);

        _assertBondInvariant(history, bonds, p, stake);
    }

    /// @notice Property 6, the zero case: no stake in the Asset means a Credit Limit of exactly zero,
    /// for any history. (R13.5, R17.1)
    /// @dev The case task 8.4 names explicitly, and the one that makes the bond sum a cap rather than a
    /// discount. Three shapes of zero are drawn, because they fail differently if the cap is computed
    /// carelessly: no bond entries at all, entries in the Asset carrying zero, and entries in another
    /// Asset carrying full-range amounts — the last being the one where a system with a conversion
    /// anywhere in it would read coverage at some rate rather than no coverage.
    ///
    /// The history is drawn favourable on purpose and up to the full 512-record bound: every record
    /// passes every filter, every amount is at least 1_000_000 base units, and every record is fully
    /// aged so it weighs at parity. The baseline is forced odd, therefore non-zero, so the comparison
    /// run against deep stake is guaranteed to return something above zero — asserted, not assumed,
    /// because without it a history that happened to earn nothing would let the zero-stake assertion
    /// pass while establishing nothing at all.
    /// @param historySeed Seeds the history length, counterparties, amounts, and ages.
    /// @param shapeSeed Seeds the counterparty count and which shape of zero the bond set takes.
    /// @param baseline Baseline Credit Limit in Asset base units, forced non-zero below.
    function testFuzz_zeroBondSumYieldsZeroCreditForAnyHistory(
        uint256 historySeed,
        uint256 shapeSeed,
        uint96 baseline
    ) public pure {
        uint256 parties = _genCounterpartySet(shapeSeed);
        uint256 length = _bound(historySeed, 1, LimitLib.MAX_HISTORY);
        LimitLib.SettlementRecord[] memory history = _genFavourableHistory(historySeed, parties, length);
        LimitLib.Params memory p = _paramsWith(uint256(baseline) | 1, GROWTH_BPS);

        LimitLib.BondEntry[] memory zeroed = _genZeroStakeShape(shapeSeed, parties);
        assertEq(_stakeInAsset(zeroed), 0, "the generated shape must carry no stake in the Asset");
        assertEq(LimitLib.bondCap(zeroed, USDC), 0, "no stake in the Asset is a cap of zero");
        assertEq(LimitLib.creditLimit(history, zeroed, p), 0, "zero stake must mean zero credit");

        // Non-vacuity: the same history against deep stake returns something, so the zero above is the
        // cap acting and not an inert history.
        (LimitLib.BondEntry[] memory deep,) = _genBondAmounts(historySeed, parties, Regime.DeepBonds);
        assertGt(LimitLib.creditLimit(history, deep, p), 0, "the history must be able to earn credit");
    }

    // ------------------------------------------------------------------ the boundary, from below

    /// @notice The bond cap binds by exactly one base unit, and one further base unit of stake releases
    /// it. (R13.5, R17.1)
    /// @dev Four rows over one fixed history whose growth term is {UNCAPPED}, walking the crossing at
    /// the resolution the arithmetic actually has. A cap applied one rounding step early or late, or
    /// applied before the concentration term rather than after it, changes the answer on exactly these
    /// rows and nowhere in the middle of the range.
    ///
    ///  - Stake 17_894_736 gives `floor(17_894_736 * 9500 / 10000) = 16_999_999`, one base unit under
    ///    the growth term, so the cap binds by one unit and the answer is the cap.
    ///  - Stake 17_894_737, one base unit more, gives a cap of exactly 17_000_000: the cap sits on the
    ///    answer and reduces nothing, so the growth term binds. That the two adjacent stake figures
    ///    straddle the crossing is the point of the pair.
    ///  - Stake 20_000_000 leaves the cap plainly slack at 19_000_000 and the growth term binds with
    ///    room.
    ///  - Two counterparties instead of three, with the same slack stake, drops to step 3 and the
    ///    baseline binds.
    ///
    /// Every row also asserts the strict relation, which stays true on the row where the cap binds by
    /// one unit: 16_999_999 against a stake sum of 17_894_736 is 894_737 clear of it, because the gap
    /// the 9_500-basis-point constant opens does not depend on how tight the cap is against the term it
    /// caps.
    function test_theBondCapBindsByOneBaseUnitAndOneUnitOfStakeReleasesIt() public pure {
        LimitLib.SettlementRecord[] memory three = _threeCounterpartyHistory();
        LimitLib.Params memory p = _paramsWith(BASELINE, GROWTH_BPS);

        (uint256 limit, Term term) = _assertRow(three, _bondsSummingTo(17_894_736, 3), p);
        assertEq(limit, UNCAPPED - 1, "the cap must bind by exactly one base unit");
        assertEq(term == Term.BondCap, true, "the bond cap must be the binding term");
        assertEq(17_894_736 - limit, 894_737, "the strict gap the 9500 constant opens");

        (limit, term) = _assertRow(three, _bondsSummingTo(17_894_737, 3), p);
        assertEq(limit, UNCAPPED, "one more base unit of stake must release the cap");
        assertEq(term == Term.Growth, true, "the growth term must bind once the cap reaches the answer");

        (limit, term) = _assertRow(three, _bondsSummingTo(20_000_000, 3), p);
        assertEq(limit, UNCAPPED, "a slack cap must not move the answer");
        assertEq(LimitLib.bondCap(_bondsSummingTo(20_000_000, 3), USDC), 19_000_000, "slack cap");
        assertEq(term == Term.Growth, true, "the growth term must bind under a slack cap");

        (limit, term) = _assertRow(_twoCounterpartyHistory(), _bondsSummingTo(20_000_000, 2), p);
        assertEq(limit, BASELINE, "below three counterparties the baseline must bind");
        assertEq(term == Term.Baseline, true, "the baseline must be the binding term");
    }

    /// @notice The gap between the Credit Limit and the stake behind it is the 9_500-basis-point
    /// constant, not a rounding accident. (R13.5, R17.1)
    /// @dev This is the case a cap set at 10_000 basis points would fail, and it is here because
    /// mutating `LimitLib.BOND_CAP_BPS` to demonstrate the same thing is not available to this task:
    /// `src/` is owned elsewhere and is being built against concurrently. The growth term is 17.00 USDC
    /// against a stake sum of 10.00 USDC, so the cap binds hard; at 9_500 basis points the answer is
    /// 9_500_000 and clears the stake sum by 500_000, and at 10_000 it would be exactly 10_000_000,
    /// which satisfies "not more than the stake" and violates the strict inequality R13.5 and R17.1
    /// both state. The comparison below is `assertLt` against the stake sum for that reason, on every
    /// draw of every campaign in this file and not only here.
    function test_theStrictMarginIsTheConstantRatherThanARoundingAccident() public pure {
        LimitLib.BondEntry[] memory bonds = _bondsSummingTo(10_000_000, 3);
        LimitLib.Params memory p = _paramsWith(BASELINE, GROWTH_BPS);

        (uint256 limit,) = _assertRow(_threeCounterpartyHistory(), bonds, p);

        assertEq(limit, 9_500_000, "the cap binds hard here");
        assertEq(10_000_000 - limit, 500_000, "the margin is five percent of the stake");
        assertLt(LimitLib.BOND_CAP_BPS, LimitLib.BPS, "the constant is what makes the relation strict");
        assertEq(limit, (10_000_000 * LimitLib.BOND_CAP_BPS) / LimitLib.BPS, "the cap is the answer");
    }

    // ------------------------------------------------------------------ the sweep

    /// @notice Every binding term is reached, and the invariant holds on all 256 draws. (R13.5, R17.1)
    /// @dev The campaign's own coverage statement, deterministic so the tallies in the header can be
    /// quoted rather than described. Regime cycles every draw and the counterparty count every four, so
    /// the 32 combinations of the two are all walked inside the first 32 draws and each is then revisited
    /// with fresh amounts, ages, baselines, and growth factors.
    ///
    /// The four assertions at the end are what stop this campaign from silently narrowing later. A
    /// change that made the bond cap bind on every draw would leave the growth and concentration
    /// tallies at zero, and the property would still pass on all 256 draws while establishing nothing
    /// about the cap being slack — so the tallies are asserted, and the counts are logged for a reader
    /// who wants to see the distribution rather than take the assertion's word for it.
    function test_theSweepReachesEveryBindingTermAndTheInvariantHoldsOnEveryDraw() public pure {
        uint256[4] memory tally;

        for (uint256 i = 0; i < SWEEP_DRAWS; ++i) {
            uint256 seed = uint256(keccak256(abi.encode("Property 6 sweep", i)));
            Regime regime = Regime(i % 4);
            uint256 parties = 1 + ((i / 4) % MAX_PARTIES);
            bool skew = (i / 32) % 2 == 0;

            LimitLib.SettlementRecord[] memory history = _genHistory(seed, parties, regime, skew);
            (LimitLib.BondEntry[] memory bonds, uint256 stake) = _genBondAmounts(seed, parties, regime);
            // The baseline is drawn across three magnitudes, cycling every draw, because its size next
            // to the earned growth decides which of the two growth-side terms binds: a negligible
            // baseline leaves the concentration term deciding, and a dominant one holds every
            // contribution well under a quarter of the answer and leaves the growth term binding. It is
            // a governance input, so both ends are shapes the deployed system can be configured into.
            LimitLib.Params memory p = _paramsWith(
                _draw(seed, 90) % (2 ** (24 + 24 * (i % 3))), _draw(seed, 91) % (2 * LimitLib.BPS + 1)
            );

            (, Term term) = _assertBondInvariant(history, bonds, p, stake);
            tally[uint256(term)] += 1;
        }

        console.log("Property 6 sweep: which term bound, over", SWEEP_DRAWS, "draws");
        console.log("  bond cap         ", tally[uint256(Term.BondCap)]);
        console.log("  baseline         ", tally[uint256(Term.Baseline)]);
        console.log("  growth           ", tally[uint256(Term.Growth)]);
        console.log("  concentration cap", tally[uint256(Term.Concentration)]);

        assertGt(tally[uint256(Term.BondCap)], 0, "the bond cap never bound");
        assertGt(tally[uint256(Term.Baseline)], 0, "the baseline never bound");
        assertGt(tally[uint256(Term.Growth)], 0, "the growth term never bound");
        assertGt(tally[uint256(Term.Concentration)], 0, "the concentration cap never bound");
        assertEq(tally[0] + tally[1] + tally[2] + tally[3], SWEEP_DRAWS, "every draw must be classified");
    }

    // ------------------------------------------------------------------ the assertion

    /// @notice Assert Property 6 on one history and bond set, and report which term bound.
    /// @dev The three comparisons that are the property, and nothing else:
    ///
    ///  1. The library's cap agrees with `stake * 9500 / 10000` computed here from the generated
    ///     entries. Checked rather than assumed, because every other comparison rests on the stake sum
    ///     being the figure this test thinks it is; the sum is totalled from the entries by
    ///     {_stakeInAsset} and the caller passes it in independently.
    ///  2. Zero stake, exactly zero credit. Not "at most", because a cap that returned the baseline
    ///     when no stake exists would satisfy an inequality and still hand out uncollateralised credit.
    ///  3. Non-zero stake, strictly under the stake sum and at or under the cap. Both, because they
    ///     fail differently: an implementation that dropped the cap from one return path would break
    ///     the second while a loose bound might still hold, and one that set the cap at parity would
    ///     break the first while the second held exactly.
    /// @param history The generated Verified Settlement history.
    /// @param bonds The generated bond set, in both Assets.
    /// @param p Asset scope, baseline, growth factor, and evaluation timestamp.
    /// @param stake Stake in the scoped Asset, totalled by the caller from the same entries.
    /// @return limit The Credit Limit the library returned.
    /// @return term Which term that figure came out of.
    function _assertBondInvariant(
        LimitLib.SettlementRecord[] memory history,
        LimitLib.BondEntry[] memory bonds,
        LimitLib.Params memory p,
        uint256 stake
    ) private pure returns (uint256 limit, Term term) {
        assertEq(stake, _stakeInAsset(bonds), "the generator and the total disagree about the stake");

        uint256 cap = LimitLib.bondCap(bonds, p.asset);
        assertEq(cap, (stake * LimitLib.BOND_CAP_BPS) / LimitLib.BPS, "the cap is 9500 bps of the stake");

        limit = LimitLib.creditLimit(history, bonds, p);

        if (stake == 0) {
            assertEq(limit, 0, "a zero stake sum must yield a Credit Limit of exactly zero");
        } else {
            assertLt(limit, stake, "the Credit Limit must be strictly under the counterparty bond sum");
            assertLe(limit, cap, "the Credit Limit must not exceed the bond cap");
        }

        (uint256 n, uint256 total) = _growthTerms(history, p);
        term = _classify(limit, cap, n, total, p.baseline);
    }

    /// @notice {_assertBondInvariant} for a hand-built row, totalling the stake from the entries.
    /// @param history The history.
    /// @param bonds The bond set.
    /// @param p Asset scope, baseline, growth factor, and evaluation timestamp.
    /// @return limit The Credit Limit the library returned.
    /// @return term Which term that figure came out of.
    function _assertRow(
        LimitLib.SettlementRecord[] memory history,
        LimitLib.BondEntry[] memory bonds,
        LimitLib.Params memory p
    ) private pure returns (uint256 limit, Term term) {
        (limit, term) = _assertBondInvariant(history, bonds, p, _stakeInAsset(bonds));
    }

    // ------------------------------------------------------------------ generators

    /// @notice `genCounterpartySet(1..8)`: how many distinct counterparties this draw uses.
    /// @dev Only the count is drawn. The identifiers themselves are `1` upward, because equality is
    /// the only thing the computation can observe about a `serviceId` — it buckets on it and never
    /// orders or scales it — so distinct small words are the input space rather than a sample of it.
    /// Counts of 1 and 2 arrive on a quarter of the draws and are the only way step 3's baseline branch
    /// is reached.
    /// @param seed The draw.
    /// @return parties Number of distinct counterparties, in `[1, 8]`.
    function _genCounterpartySet(uint256 seed) private pure returns (uint256 parties) {
        parties = _bound(seed, 1, MAX_PARTIES);
    }

    /// @notice `genHistory()`: a Verified Settlement history over the drawn counterparty set.
    /// @dev Length in `[1, 64]`, which is well inside `MAX_HISTORY` and long enough for several records
    /// to land in one bucket; the 512-record end of the range is exercised by
    /// {testFuzz_zeroBondSumYieldsZeroCreditForAnyHistory}, where length is the interesting dimension.
    ///
    /// Amounts run over `[0, 2^96)` and ages over `[0, 60]` whole days, so the draw reaches day 0 at the
    /// bottom of the ramp, the interior, day 30 at parity, and well past the clamp. When `skew` is set,
    /// counterparty 0 draws over the full range while every other counterparty is held eight bits below
    /// it, which pushes one contribution above 25 percent of the answer and makes the concentration term
    /// bind whenever the cap is slack. When it is clear, the counterparties draw over the same range and
    /// a wide enough set keeps every contribution under a quarter, which is what leaves the growth term
    /// binding. The flag is drawn independently of the stake regime for exactly that reason: skew
    /// crossed with deep stake is the concentration branch, and balance crossed with deep stake is the
    /// growth branch, and a campaign that tied the two together would reach only one of them.
    ///
    /// Roughly one record in eight is built to fail one of the four filters, cycling through another
    /// Asset, uncurated, unbonded, and a Metered Delivery that is not strictly earlier. Those records
    /// are the reason the bonded set can be a strict superset of the contributing set on a generated
    /// draw, which is the arrangement where a cap totalled over the wrong set would show up.
    /// Length is drawn as a whole number of rounds over the counterparty set rather than uniformly over
    /// `[1, 64]`, and the round count is drawn wider on a skewed draw than on a balanced one: `[1, 8]`
    /// against `[4, 8]`. Both departures earn their place by what they reach. A uniform length leaves a
    /// short history over a wide counterparty set with one or two buckets holding everything, so the
    /// concentration term binds and the growth branch is reached by accident at best; and a balanced
    /// draw only reads as balanced once every counterparty has a few records, since the concentration
    /// term binds the moment any single contribution passes a quarter of the answer. Short balanced
    /// histories are not lost by this — they arrive under the skew flag whenever the drawn counterparty
    /// count is 1, where skew has nothing to skew.
    /// @param seed The draw.
    /// @param parties Number of distinct counterparties available.
    /// @param regime Stake regime, which sets the amounts' magnitude relative to the stake.
    /// @param skew Whether one counterparty draws an order of magnitude above the others.
    /// @return history The generated history.
    function _genHistory(uint256 seed, uint256 parties, Regime regime, bool skew)
        private
        pure
        returns (LimitLib.SettlementRecord[] memory history)
    {
        uint256 rounds = skew ? 1 + (_draw(seed, 0) % 8) : 4 + (_draw(seed, 0) % 5);
        uint256 length = parties * rounds;
        // Under deep stake the amounts are held 32 bits below the range the stake is drawn from, so the
        // cap sits above anything a 64-record history can reach and one of the two growth-side terms is
        // what binds. Without that the cap would bind here too — eight counterparties can stake at most
        // eight times `2^96`, and sixty-four records can settle sixty-four times it.
        uint256 top = regime == Regime.DeepBonds ? AMOUNT_CEILING >> 32 : AMOUNT_CEILING;
        history = new LimitLib.SettlementRecord[](length);

        for (uint256 i = 0; i < length; ++i) {
            uint256 d = _draw(seed, 1 + i);
            uint256 party = d % parties;
            uint256 ceiling = (skew && party != 0) ? top >> 8 : top;

            history[i] = _record(bytes32(party + 1), uint128((d >> 8) % ceiling), uint64((d >> 136) % 61));

            if ((d >> 200) % 8 != 0) continue;
            uint256 which = (d >> 208) % 4;
            if (which == 0) history[i].asset = OTHER_ASSET;
            else if (which == 1) history[i].curated = false;
            else if (which == 2) history[i].bonded = false;
            else history[i].firstDeliveryAt = history[i].settledAt;
        }
    }

    /// @notice A history in which every record counts, drawn to a chosen length.
    /// @dev The favourable end of the input space, for the zero-stake case: every filter passed, every
    /// amount at least 1_000_000 base units so nothing floors to a zero weight, and every record fully
    /// aged so it weighs at parity. If any history can earn credit this one can, which is what makes
    /// "and yet the Credit Limit is zero" a statement about the cap.
    /// @param seed The draw.
    /// @param parties Number of distinct counterparties available.
    /// @param length Number of records.
    /// @return history The generated history.
    function _genFavourableHistory(uint256 seed, uint256 parties, uint256 length)
        private
        pure
        returns (LimitLib.SettlementRecord[] memory history)
    {
        history = new LimitLib.SettlementRecord[](length);
        for (uint256 i = 0; i < length; ++i) {
            uint256 d = _draw(seed, 1 + i);
            uint128 amount = uint128(1_000_000 + ((d >> 8) % (AMOUNT_CEILING - 1_000_000)));
            history[i] = _record(bytes32((d % parties) + 1), amount, 30 + uint64((d >> 136) % 31));
        }
    }

    /// @notice `genBondAmounts(0..2^96)`: stake for each drawn counterparty, including the all-zero case.
    /// @dev One entry per counterparty in the scoped Asset, with the magnitude set by the regime:
    /// `DeepBonds` draws in the top sixteen bits of the range so the cap sits far above any growth term
    /// a 64-record history can reach; `ShallowBonds` draws in the bottom forty bits so the cap binds
    /// hard; `NoBonds` is the all-zero case, which task 8.4 names and which
    /// {testFuzz_zeroBondSumYieldsZeroCreditForAnyHistory} then drives on its own; `Unshaped` draws over
    /// the full `[0, 2^96)` range and takes whatever relation falls out, including the zero sum that
    /// arrives when every draw lands low.
    ///
    /// On half the draws a second entry per counterparty is added in another Asset, carrying a
    /// full-range amount. It must change neither the cap nor the limit: there is no price feed anywhere
    /// in this system and no conversion at any rate, so stake denominated elsewhere is not coverage
    /// here (R18.5). Adding it on only half the draws keeps the all-zero sum genuinely reachable with
    /// no entries at all as well as with entries that total zero.
    /// @param seed The draw.
    /// @param parties Number of distinct counterparties.
    /// @param regime Magnitude regime.
    /// @return bonds The generated entries, in both Assets.
    /// @return stake Total stake in the scoped Asset.
    function _genBondAmounts(uint256 seed, uint256 parties, Regime regime)
        private
        pure
        returns (LimitLib.BondEntry[] memory bonds, uint256 stake)
    {
        bool crossAsset = _draw(seed, 70) % 2 == 0;
        bonds = new LimitLib.BondEntry[](crossAsset ? parties * 2 : parties);

        for (uint256 i = 0; i < parties; ++i) {
            uint256 d = _draw(seed, 71 + i);
            uint128 amount;
            if (regime == Regime.DeepBonds) amount = uint128(AMOUNT_CEILING - 1 - (d % (2 ** 80)));
            else if (regime == Regime.ShallowBonds) amount = uint128(d % (2 ** 40));
            else if (regime == Regime.Unshaped) amount = uint128(d % AMOUNT_CEILING);

            bonds[i] = LimitLib.BondEntry({serviceId: bytes32(i + 1), asset: USDC, amount: amount});
            stake += amount;

            if (!crossAsset) continue;
            bonds[parties + i] = LimitLib.BondEntry({
                serviceId: bytes32(i + 1),
                asset: OTHER_ASSET,
                amount: uint128(_draw(seed, 171 + i) % AMOUNT_CEILING)
            });
        }
    }

    /// @notice One of the three shapes a zero stake sum can take in the scoped Asset.
    /// @dev They fail differently under a careless cap. No entries at all is the empty-loop case;
    /// entries carrying zero is the case where a cap that counted entries rather than amounts would go
    /// wrong; and full-range amounts in another Asset is the case where a conversion at any rate, or a
    /// missing Asset comparison, would read coverage where there is none.
    /// @param seed The draw.
    /// @param parties Number of distinct counterparties.
    /// @return bonds Entries totalling zero in the scoped Asset.
    function _genZeroStakeShape(uint256 seed, uint256 parties)
        private
        pure
        returns (LimitLib.BondEntry[] memory bonds)
    {
        uint256 shape = (seed >> 16) % 3;
        if (shape == 0) return new LimitLib.BondEntry[](0);

        bonds = new LimitLib.BondEntry[](parties);
        for (uint256 i = 0; i < parties; ++i) {
            bonds[i] = LimitLib.BondEntry({
                serviceId: bytes32(i + 1),
                asset: shape == 1 ? USDC : OTHER_ASSET,
                amount: shape == 1 ? 0 : uint128(_draw(seed, 200 + i) % AMOUNT_CEILING)
            });
        }
    }

    // ------------------------------------------------------------------ term classification

    /// @notice Which term the returned Credit Limit came out of.
    /// @dev Diagnostic, and scoped to stay diagnostic. It reproduces the filters, the weighting, and
    /// the growth factor — {_growthTerms} — but deliberately not the concentration cap's closed form,
    /// which is the subtle part and the part Property 7 owns. So the concentration term is identified by
    /// elimination: below three counterparties the answer is `min(baseline, cap)` and the two cases are
    /// told apart by which is smaller; at or above three, an answer equal to the uncapped value means
    /// neither cap bound, an answer equal to the cap means the cap bound, and anything else is the
    /// concentration term. Ties where the cap and the concentration-capped value coincide are counted
    /// as the cap.
    /// @param limit The Credit Limit the library returned.
    /// @param cap The bond cap.
    /// @param n Distinct contributing counterparties.
    /// @param total Sum of the growth contributions.
    /// @param baseline Baseline Credit Limit in Asset base units.
    /// @return term The classification.
    function _classify(uint256 limit, uint256 cap, uint256 n, uint256 total, uint256 baseline)
        private
        pure
        returns (Term term)
    {
        if (n < LimitLib.MIN_COUNTERPARTIES) return cap < baseline ? Term.BondCap : Term.Baseline;
        if (limit == baseline + total) return Term.Growth;
        if (limit == cap) return Term.BondCap;
        return Term.Concentration;
    }

    /// @notice The contributing counterparty count and the summed growth contributions.
    /// @dev The library's steps 1 and 4, reproduced for classification only. Nothing in this file
    /// asserts against the figures it returns, so a drift between this and `LimitLib` can lose a tally
    /// but cannot let a violation through — the property is stated entirely against the stake sum and
    /// the returned limit.
    /// @param history The generated history.
    /// @param p Asset scope, baseline, growth factor, and evaluation timestamp.
    /// @return n Distinct contributing counterparties.
    /// @return total Sum of the growth contributions.
    function _growthTerms(LimitLib.SettlementRecord[] memory history, LimitLib.Params memory p)
        private
        pure
        returns (uint256 n, uint256 total)
    {
        bytes32[MAX_PARTIES] memory ids;
        uint256[MAX_PARTIES] memory buckets;

        for (uint256 i = 0; i < history.length; ++i) {
            LimitLib.SettlementRecord memory s = history[i];
            if (s.asset != p.asset) continue;
            if (!s.curated || !s.bonded) continue;
            if (s.firstDeliveryAt == 0 || s.firstDeliveryAt >= s.settledAt) continue;

            uint256 weighted =
                (uint256(s.amount) * LimitLib.ageWeightBps(s.settledAt, p.evaluatedAt)) / LimitLib.BPS;
            if (weighted == 0) continue;

            uint256 slot = type(uint256).max;
            for (uint256 j = 0; j < n; ++j) {
                if (ids[j] == s.serviceId) {
                    slot = j;
                    break;
                }
            }
            if (slot == type(uint256).max) {
                slot = n++;
                ids[slot] = s.serviceId;
            }
            buckets[slot] += weighted;
        }

        for (uint256 j = 0; j < n; ++j) {
            total += (buckets[j] * p.growthFactorBps) / LimitLib.BPS;
        }
    }

    // ------------------------------------------------------------------ builders

    /// @notice One Verified Settlement that passes every filter, aged a whole number of days.
    /// @dev The same builder the `LimitLib` unit suite uses, kept identical so a record here and a
    /// record there mean the same thing: fully inside the scoped Asset, curated, bonded, and carrying a
    /// Metered Delivery one second earlier so the strict precedence rule of R17.3 is satisfied rather
    /// than skirted.
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

    /// @notice Three fully aged Settlements of 8.00 USDC, one counterparty each.
    /// @dev The history the boundary cases are built on. Balanced and fully aged so the growth term is
    /// exactly {UNCAPPED} and the concentration term is inert, which leaves the bond cap as the only
    /// term the stake figure can move. Both facts are asserted at the rows rather than trusted here.
    /// @return h The history.
    function _threeCounterpartyHistory() private pure returns (LimitLib.SettlementRecord[] memory h) {
        h = new LimitLib.SettlementRecord[](3);
        h[0] = _record(bytes32(uint256(1)), 8_000_000, 30);
        h[1] = _record(bytes32(uint256(2)), 8_000_000, 30);
        h[2] = _record(bytes32(uint256(3)), 8_000_000, 30);
    }

    /// @notice The same history one counterparty short, so step 3 returns the capped baseline.
    /// @return h The history.
    function _twoCounterpartyHistory() private pure returns (LimitLib.SettlementRecord[] memory h) {
        h = new LimitLib.SettlementRecord[](2);
        h[0] = _record(bytes32(uint256(1)), 8_000_000, 30);
        h[1] = _record(bytes32(uint256(2)), 8_000_000, 30);
    }

    /// @notice Bond entries in the scoped Asset totalling exactly `total` across `parties` entries.
    /// @dev Split unevenly on purpose, with the remainder on the last entry. The cap is one division
    /// over the whole sum rather than a division per entry, so the split must not change the answer,
    /// and an uneven one is the split that would expose a per-entry division.
    /// @param total Stake to distribute, in Asset base units.
    /// @param parties Number of entries to spread it over.
    /// @return b The entries.
    function _bondsSummingTo(uint256 total, uint256 parties)
        private
        pure
        returns (LimitLib.BondEntry[] memory b)
    {
        b = new LimitLib.BondEntry[](parties);
        uint256 each = total / parties;
        uint256 assigned;
        for (uint256 i = 0; i < parties; ++i) {
            uint256 amount = i + 1 == parties ? total - assigned : each;
            assigned += amount;
            b[i] = LimitLib.BondEntry({serviceId: bytes32(i + 1), asset: USDC, amount: uint128(amount)});
        }
    }

    /// @notice Governance inputs at a chosen baseline and growth factor.
    /// @param baseline Baseline Credit Limit in Asset base units.
    /// @param growthFactorBps Growth factor in basis points.
    /// @return p The parameters.
    function _paramsWith(uint256 baseline, uint256 growthFactorBps)
        private
        pure
        returns (LimitLib.Params memory p)
    {
        p = LimitLib.Params({
            asset: USDC, baseline: baseline, growthFactorBps: growthFactorBps, evaluatedAt: EVALUATED_AT
        });
    }

    /// @notice Total stake in the scoped Asset, summed from the entries.
    /// @dev The property's right-hand side, computed here rather than read back from the library, so
    /// the comparison is against a figure this test owns. Entries in another Asset are skipped, which is
    /// the same exclusion `LimitLib.bondCap` makes and the reason the two agree.
    /// @param bonds The entries.
    /// @return stake The total.
    function _stakeInAsset(LimitLib.BondEntry[] memory bonds) private pure returns (uint256 stake) {
        for (uint256 i = 0; i < bonds.length; ++i) {
            if (bonds[i].asset != USDC) continue;
            stake += bonds[i].amount;
        }
    }

    /// @notice Expands one seed into an independent draw per index.
    /// @param seed The generated seed.
    /// @param index Position the draw is for.
    /// @return value The draw.
    function _draw(uint256 seed, uint256 index) private pure returns (uint256 value) {
        value = uint256(keccak256(abi.encode(seed, index)));
    }
}
