// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title LimitLib
/// @notice Pure credit arithmetic. Given a Verified Settlement history, the Bond posted by each
/// counterparty Service, and an evaluation timestamp, this library returns the Credit Limit an Agent
/// has earned in one Asset. It reads zero contract storage, makes zero external calls, and takes the
/// evaluation timestamp as an argument rather than reading the block clock. (R13.1, R13.2)
/// @dev Three shapes in here are load-bearing and each is justified at its declaration:
///
///  1. **Purity is the verification story, not a style preference.** Every input arrives in calldata
///     or memory, so a third party can recompute the same number off chain from published history
///     and compare it against the on-chain read. A single storage read would make that comparison
///     unreproducible, so `internal pure` is the whole point rather than an optimisation.
///  2. **Integer basis points throughout, with one documented rounding convention.** There is no
///     fixed-point library and no floating point. Section "Rounding convention" below fixes the
///     division order so the off-chain reimplementation matches bit for bit.
///  3. **The bond cap always applies.** Every return path ends in a `min` against
///     `sum(counterparty bonds) * 9500 / 10000`, including the branch that returns the baseline, so
///     the Credit Limit is strictly below the capital the counterparties have at risk for every
///     input rather than by runtime assertion. (R13.5, R17.1)
///
/// ### Rounding convention
///
/// Every division is unsigned integer division, which truncates toward zero, so every rounding step
/// rounds the Credit Limit **down**. The order of operations is fixed and multiply-before-divide at
/// each step:
///
///  - `ageDays          = (evaluatedAt - settledAt) / 86400`
///  - `weightBps        = 2500 + (7500 * min(ageDays, 30)) / 30`
///  - `weighted_r       = (amount_r * weightBps_r) / 10000`          per settlement record
///  - `bucket_j         = Σ weighted_r` over the records of counterparty `j`   (sum of floored terms)
///  - `contribution_j   = (bucket_j * growthFactorBps) / 10000`      one division per counterparty
///  - `bondSum          = Σ bond amounts in the Asset`               summed before any scaling
///  - `bondCap          = (bondSum * 9500) / 10000`                  one division over the sum
///  - `candidate_k      = (4 * (baseline + tail_k)) / (4 - k)`       multiply by 4 before dividing
///
/// Two of those are easy to get wrong when reimplementing. The per-record weighted value is floored
/// **before** bucketing, so the bucket is a sum of floored terms and not the floor of a sum. The
/// growth factor and the bond cap are applied **once per counterparty and once over the whole bond
/// sum** respectively, not per record and not per bond, so a reimplementation that divides inside
/// either loop will disagree in the last base unit.
///
/// Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 17.2, 17.3, 17.4, 17.5, 17.6, 18.2
library LimitLib {
    // ------------------------------------------------------------------ constants

    /// @notice One hundred percent in basis points. Every ratio in this library is expressed against
    /// this denominator, so no percentage or fraction appears anywhere.
    uint256 internal constant BPS = 10_000;

    /// @notice Share of the counterparty Bond sum a Credit Limit may reach, in basis points. (D5)
    /// @dev 9500 rather than 10000 so the inequality of R13.5 and R17.1 is strict for every non-zero
    /// bond sum, with no dependence on a rounding accident: `floor(B * 9500 / 10000) <= 0.95B < B`.
    uint256 internal constant BOND_CAP_BPS = 9_500;

    /// @notice Largest share of the returned Credit Limit any single counterparty may contribute, in
    /// basis points. (R13.6, R17.4)
    uint256 internal constant CONCENTRATION_BPS = 2_500;

    /// @notice Weight a Verified Settlement carries on the day it settled, in basis points. (D4)
    uint256 internal constant MIN_WEIGHT_BPS = 2_500;

    /// @notice Weight a Verified Settlement carries once it has aged the full ramp, in basis points.
    uint256 internal constant MAX_WEIGHT_BPS = 10_000;

    /// @notice Span of the age ramp in whole days. (D4)
    uint256 internal constant RAMP_DAYS = 30;

    /// @notice Growth in basis points earned across the whole ramp, `MAX_WEIGHT_BPS - MIN_WEIGHT_BPS`.
    uint256 internal constant RAMP_SPAN_BPS = 7_500;

    /// @notice Distinct contributing counterparty Services required before any growth is granted.
    /// @dev Below this count the Agent receives the configured baseline and nothing more, so a
    /// two-party ring cannot grow a limit at all. (R13.7, R17.5)
    uint256 internal constant MIN_COUNTERPARTIES = 3;

    /// @notice Largest number of distinct contributing counterparties one computation may carry.
    /// @dev Bounds the pure loops. The bucketing scan is `O(history * counterparties)`, so an
    /// unbounded counterparty set would let a caller supply a witness that cannot be evaluated
    /// inside the block gas limit. Exceeding it reverts rather than truncating: dropping records
    /// silently would return a different number under the same name. (R13.1)
    uint256 internal constant MAX_COUNTERPARTIES = 32;

    /// @notice Largest number of Verified Settlement records one computation may carry.
    /// @dev Same reasoning as {MAX_COUNTERPARTIES}, and likewise a revert rather than a truncation.
    uint256 internal constant MAX_HISTORY = 512;

    /// @notice Reciprocal of {CONCENTRATION_BPS} as a whole number, `10000 / 2500`.
    /// @dev Named because it appears in the closed form of the concentration cap as both the
    /// multiplier `4` and the ceiling on how many counterparties can sit at the cap at once. Keeping
    /// the two uses tied to one constant is what makes the derivation in {_concentrationCapped}
    /// checkable against {CONCENTRATION_BPS} rather than a coincidence of two literals.
    uint256 internal constant CONCENTRATION_DIVISOR = BPS / CONCENTRATION_BPS;

    // ------------------------------------------------------------------ inputs

    /// @notice One Verified Settlement, as recorded by the `SettlementVerifier`.
    /// @dev `curated` and `bonded` are snapshots taken at settlement time rather than looked up here,
    /// because a lookup would be a storage read and this library performs none. `firstDeliveryAt` is
    /// carried for the same reason: the precedence rule of R17.3 is a comparison between two recorded
    /// Creditcoin timestamps, so both must travel with the record.
    struct SettlementRecord {
        /// @dev Counterparty Service this Settlement paid.
        bytes32 serviceId;
        /// @dev Asset the Settlement is denominated in. (R18.2)
        address asset;
        /// @dev Settled amount in Asset base units.
        uint128 amount;
        /// @dev Creditcoin timestamp at which the Verified Settlement was recorded.
        uint64 settledAt;
        /// @dev Creditcoin timestamp of the earliest Metered Delivery recorded for this Agent,
        /// Service, and Asset. Zero means no delivery was ever recorded. (R17.3)
        uint64 firstDeliveryAt;
        /// @dev Attested-chain identifier the Settlement was proven on. Carried for auditability;
        /// this library does not branch on it, because the `SettlementVerifier` has already resolved
        /// the Service from the chain-scoped Collection Address by the time a record exists.
        uint64 chainKey;
        /// @dev Whether the counterparty held the Curated Tier at settlement time. (R11.5, R17.2)
        bool curated;
        /// @dev Whether the counterparty held a Bond in this Asset at settlement time. (R17.2)
        bool bonded;
    }

    /// @notice Bond posted by one counterparty Service in one Asset.
    struct BondEntry {
        /// @dev The bonded counterparty.
        bytes32 serviceId;
        /// @dev Asset the stake is denominated in. Entries in another Asset are ignored. (R18.5)
        address asset;
        /// @dev Staked amount in Asset base units.
        uint128 amount;
    }

    /// @notice Governance-configured inputs and the evaluation clock.
    struct Params {
        /// @dev Asset the computation is scoped to. Every other Asset is excluded. (R13.3, R18.2)
        address asset;
        /// @dev Credit granted before any history exists, in Asset base units. (D3)
        uint256 baseline;
        /// @dev Share of weighted history converted into growth, in basis points. (D5)
        uint256 growthFactorBps;
        /// @dev Creditcoin timestamp the ages are measured against. Supplied rather than read from
        /// the block clock, so the whole computation is reproducible off chain. (R13.2)
        uint64 evaluatedAt;
    }

    // ------------------------------------------------------------------ errors

    /// @notice The supplied history carries more records than one computation may evaluate.
    /// @param length Number of records supplied.
    /// @param maximum Largest number accepted.
    error HistoryTooLong(uint256 length, uint256 maximum);

    /// @notice The supplied history contributes more distinct counterparties than one computation may
    /// evaluate.
    /// @param count Number of distinct contributing counterparties the scan reached.
    /// @param maximum Largest number accepted.
    error TooManyCounterparties(uint256 count, uint256 maximum);

    // ------------------------------------------------------------------ credit limit

    /// @notice The Credit Limit an Agent has earned in one Asset.
    /// @dev Six steps, in a fixed order:
    ///
    ///  1. Filter and bucket weighted value per counterparty. Four independent filters apply, and
    ///     each closes a distinct way of manufacturing credit: a Settlement in another Asset would
    ///     import value across a denomination this system never converts (R13.3, R18.2); an
    ///     uncurated counterparty would let anyone self-register and vouch for themselves (R11.4,
    ///     R17.2); an unbonded counterparty would extend credit it has not collateralised (R17.2);
    ///     and a Settlement whose Metered Delivery is not strictly earlier would let an Agent settle
    ///     against a delivery recorded in the same instant, which is history with no service behind
    ///     it (R17.3).
    ///  2. Compute the bond cap. It is computed on every path, including the baseline path.
    ///  3. Below three distinct counterparties, return the bond-capped baseline and stop. (R13.7)
    ///  4. Convert each bucket into a growth contribution at `growthFactorBps`.
    ///  5. Solve the concentration cap in closed form. (R13.6, R17.4)
    ///  6. Return the smallest of the uncapped value, the concentration-capped value, and the bond
    ///     cap.
    ///
    /// Monotonicity under append (R13.8) follows from the shape rather than from a check. Appending a
    /// record either fails a filter, in which case nothing changes; or adds weighted value to an
    /// existing bucket, which raises that contribution and therefore raises both the uncapped value
    /// and the concentration fixed point; or introduces a new counterparty, which likewise only adds
    /// a non-negative contribution. The baseline path is the one crossing worth checking, and it
    /// holds because every concentration candidate is at least the baseline: the smallest of the four
    /// is `k = 0`, which evaluates to `baseline + total`. Floor division is non-decreasing, so the
    /// integer result inherits the property.
    /// @param history Verified Settlement history for one Agent, in any order and any Asset.
    /// @param bonds Bond posted by each counterparty Service, in any Asset.
    /// @param p Asset scope, baseline, growth factor, and evaluation timestamp.
    /// @return limit The Credit Limit in Asset base units.
    function creditLimit(SettlementRecord[] memory history, BondEntry[] memory bonds, Params memory p)
        internal
        pure
        returns (uint256 limit)
    {
        if (history.length > MAX_HISTORY) revert HistoryTooLong(history.length, MAX_HISTORY);

        // --- Step 1: filter and bucket weighted value per counterparty ---------------------------
        bytes32[MAX_COUNTERPARTIES] memory ids;
        uint256[MAX_COUNTERPARTIES] memory buckets;
        uint256 n;

        for (uint256 i = 0; i < history.length; ++i) {
            SettlementRecord memory s = history[i];
            if (s.asset != p.asset) continue; // R13.3, R18.2
            if (!s.curated) continue; // R11.4, R17.2
            if (!s.bonded) continue; // R17.2
            // Zero is the sentinel for "no Metered Delivery was ever recorded", and it is checked
            // separately because it is not ordered against `settledAt` in a useful way: a zero
            // sentinel is trivially earlier than any real timestamp, so the comparison below would
            // admit it.
            if (s.firstDeliveryAt == 0) continue;
            // Strictly earlier, so equality is excluded. R17.3.
            if (s.firstDeliveryAt >= s.settledAt) continue;

            uint256 weighted = (uint256(s.amount) * ageWeightBps(s.settledAt, p.evaluatedAt)) / BPS;
            // A record that weighs nothing must not create a counterparty slot either, or a dust
            // Settlement would count toward the three-counterparty threshold while contributing no
            // value. The threshold counts counterparties that actually contribute. (R13.7, R17.5)
            if (weighted == 0) continue;

            uint256 slot = type(uint256).max;
            for (uint256 j = 0; j < n; ++j) {
                if (ids[j] == s.serviceId) {
                    slot = j;
                    break;
                }
            }
            if (slot == type(uint256).max) {
                if (n == MAX_COUNTERPARTIES) revert TooManyCounterparties(n + 1, MAX_COUNTERPARTIES);
                slot = n++;
                ids[slot] = s.serviceId;
            }
            buckets[slot] += weighted;
        }

        // --- Step 2: the bond cap applies on every path ------------------------------------------
        uint256 cap = bondCap(bonds, p.asset);

        // --- Step 3: fewer than three counterparties, so baseline only ---------------------------
        // Capped rather than returned bare: an Agent whose counterparties hold no Bond in this Asset
        // gets a cap of zero and therefore a Credit Limit of zero, and must prepay. Curation tier
        // gates history weight; the Bond gates credit existence. (R13.5, R13.7, R17.1, R17.5)
        if (n < MIN_COUNTERPARTIES) {
            return p.baseline < cap ? p.baseline : cap;
        }

        // --- Step 4: growth contributions --------------------------------------------------------
        uint256[MAX_COUNTERPARTIES] memory contributions;
        uint256 total;
        for (uint256 j = 0; j < n; ++j) {
            contributions[j] = (buckets[j] * p.growthFactorBps) / BPS; // D5
            total += contributions[j];
        }
        uint256 uncapped = p.baseline + total;

        // --- Step 5: concentration-capped value --------------------------------------------------
        uint256 concentrationCapped = _concentrationCapped(contributions, n, p.baseline, total);

        // --- Step 6: the smallest of the three ---------------------------------------------------
        limit = uncapped;
        if (concentrationCapped < limit) limit = concentrationCapped;
        if (cap < limit) limit = cap;
    }

    // ------------------------------------------------------------------ age weighting

    /// @notice Weight one Verified Settlement carries at an evaluation time, in basis points. (D4)
    /// @dev `weightBps = 2500 + 7500 * min(ageDays, 30) / 30`. Day 0 weighs 0.25x, day 15 weighs
    /// 0.625x, and day 30 onward weighs 1.00x, so a Settlement contributes strictly more weight after
    /// 30 days of Open Tab discipline than on the day it settled (R13.4). Floor division on the day
    /// count makes this a monotone non-decreasing step ramp, which is what R13.8 and the
    /// burst-versus-spread rule of R17.6 rely on: compressing the same settled value into a shorter
    /// window can only lower every weight, so it can only lower the weighted total.
    ///
    /// An evaluation time at or before the settlement time returns the day-0 weight rather than
    /// reverting. A Params timestamp behind a record's timestamp is a caller error, not an attack
    /// surface, and the day-0 weight is the conservative answer.
    /// @param settledAt Creditcoin timestamp at which the Verified Settlement was recorded.
    /// @param evaluatedAt Creditcoin timestamp the age is measured against.
    /// @return weightBps The weight in basis points, between {MIN_WEIGHT_BPS} and {MAX_WEIGHT_BPS}.
    function ageWeightBps(uint64 settledAt, uint64 evaluatedAt) internal pure returns (uint256 weightBps) {
        if (evaluatedAt <= settledAt) return MIN_WEIGHT_BPS;
        uint256 ageDays = (uint256(evaluatedAt) - uint256(settledAt)) / 1 days;
        if (ageDays >= RAMP_DAYS) return MAX_WEIGHT_BPS;
        // The multiplication does precede the division here; the lint reads the leading addition as
        // an operand of the quotient. Reordering would change the documented rounding convention.
        // forge-lint: disable-next-line(divide-before-multiply)
        weightBps = MIN_WEIGHT_BPS + (RAMP_SPAN_BPS * ageDays) / RAMP_DAYS;
    }

    // ------------------------------------------------------------------ bond cap

    /// @notice Ceiling the counterparty Bonds place on any Credit Limit in one Asset.
    /// @dev `bondCap = sum(bonds in the Asset) * 9500 / 10000`, so for any non-zero bond sum `B` the
    /// returned Credit Limit satisfies `limit <= floor(B * 9500 / 10000) <= 0.95B < B`, and for
    /// `B = 0` the cap is `0` and the limit is `0`, which is not greater than `B`. R13.5 and R17.1
    /// therefore hold for every input by construction. A self-dealing ring locks strictly more value
    /// in Bonds than the credit it can draw.
    ///
    /// Entries in another Asset are skipped rather than converted, because this system holds no price
    /// feed and performs no conversion anywhere (R18.5, R18.6). The sum is taken across the whole set
    /// before the single scaling division, so the result does not depend on how the same total is
    /// split across entries.
    /// @param bonds Bond posted by each counterparty Service, in any Asset.
    /// @param asset Asset to total over.
    /// @return cap The ceiling in Asset base units.
    function bondCap(BondEntry[] memory bonds, address asset) internal pure returns (uint256 cap) {
        uint256 sum;
        for (uint256 i = 0; i < bonds.length; ++i) {
            if (bonds[i].asset != asset) continue; // R18.5
            sum += bonds[i].amount;
        }
        cap = (sum * BOND_CAP_BPS) / BPS; // D5
    }

    // ------------------------------------------------------------------ concentration cap

    /// @notice The Credit Limit at which no single counterparty contributes more than 25 percent.
    /// @dev **The derivation, because the closed form is not obvious.** The rule of R13.6 and R17.4
    /// is a self-reference: the cap on each contribution is a share of the answer, and value above
    /// that cap is discarded rather than redistributed. So the capped value is the fixed point of
    ///
    /// ```
    /// L = baseline + Σ_i min(c_i, L / 4)              where 4 = 10000 / 2500
    /// ```
    ///
    /// Let `k` be the number of counterparties sitting at the cap at the fixed point. If `k >= 4`
    /// then `L = baseline + Σ min(...) >= baseline + 4 * (L / 4) > L`, a contradiction, so
    /// `k ∈ {0, 1, 2, 3}`. With the contributions sorted descending, the top `k` are the capped ones
    /// and the rest count in full, so
    ///
    /// ```
    /// L = baseline + k * L / 4 + tail_k       =>      L_k = 4 * (baseline + tail_k) / (4 - k)
    /// ```
    ///
    /// where `tail_k` is the sum of contributions ranked `k+1` and below. That is four candidates and
    /// no iteration. The fixed point is unique: `capped(L)` is non-decreasing, is `baseline > 0` at
    /// `L = 0`, and is constant at `baseline + total` once every contribution is under the cap, while
    /// the feasibility windows `4 * c_{k+1} <= L <= 4 * c_k` for successive `k` are disjoint except at
    /// their endpoints, where the candidates coincide in value.
    ///
    /// Feasibility of candidate `k` is exactly that the top `k` are at or above the cap and entry
    /// `k+1` is at or below it. The scan returns the first feasible candidate; the smallest candidate
    /// is the fallback, reachable only when integer flooring lands a tie between two adjacent
    /// windows, and taking the smallest keeps the rounding in the direction that never over-grants.
    ///
    /// Sorting is an insertion sort over at most 32 entries. It is descending, in place, and mutates
    /// the array the caller passed, which is safe only because {creditLimit} does not read the
    /// contributions again afterward. Insertion sort rather than anything cleverer because 32 entries
    /// is small, the code is short enough to audit by eye, and it needs no scratch allocation.
    /// @param c Per-counterparty growth contributions. Sorted in place, descending.
    /// @param n Number of live entries at the front of `c`.
    /// @param baseline Credit granted before any history, in Asset base units.
    /// @param total Sum of the first `n` entries of `c`.
    /// @return capped The concentration-capped Credit Limit in Asset base units.
    function _concentrationCapped(
        uint256[MAX_COUNTERPARTIES] memory c,
        uint256 n,
        uint256 baseline,
        uint256 total
    ) private pure returns (uint256 capped) {
        for (uint256 i = 1; i < n; ++i) {
            uint256 v = c[i];
            uint256 j = i;
            while (j > 0 && c[j - 1] < v) {
                c[j] = c[j - 1];
                --j;
            }
            c[j] = v;
        }

        uint256 prefix; // sum of the top k contributions
        uint256 best = type(uint256).max;
        uint256 maxCapped = CONCENTRATION_DIVISOR - 1; // k can be at most 3
        for (uint256 k = 0; k <= maxCapped && k <= n; ++k) {
            if (k > 0) prefix += c[k - 1];
            uint256 tail = total - prefix;
            uint256 candidate = (CONCENTRATION_DIVISOR * (baseline + tail)) / (CONCENTRATION_DIVISOR - k);
            if (candidate < best) best = candidate;

            bool topAtCap = (k == 0) || (c[k - 1] * CONCENTRATION_DIVISOR >= candidate);
            bool restUnderCap = (k == n) || (c[k] * CONCENTRATION_DIVISOR <= candidate);
            if (topAtCap && restUnderCap) return candidate;
        }
        capped = best;
    }
}
