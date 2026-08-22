// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {Bond, IBond} from "../src/Bond.sol";

/// @title BondLedgerTest
/// @notice Soundness tests for the Bond ledger operations: proven funding, pledging against a
/// Provisional Clearing, and returning a pledge when that clearing is confirmed.
/// @dev Scope is the ledger itself. Three things are asserted rather than assumed:
///
///  1. the five figures after every step, so the consistency identity is checked and not trusted;
///  2. per-Asset isolation, field by field, so a leak between Assets fails a test rather than a review;
///  3. the shortfall outcome, which is a return value rather than a revert.
///
/// The fuzz case at the end drives interleaved funding, pledging, and releasing across two Assets and
/// re-checks the identity after every single step, so the identity is proved against sequences rather
/// than against the hand-written orderings above it.
///
/// Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 18.5
contract BondLedgerTest is Test {
    /// @notice Contract under test.
    Bond internal bond;

    /// @notice The wired `SettlementVerifier`, the only address able to credit stake.
    address internal constant VERIFIER = address(0xA11CE);

    /// @notice The wired `TabBook`, the only address able to pledge or release.
    address internal constant BOOK = address(0xB00C);

    /// @notice An address wired to nothing, used for the rejection cases.
    address internal constant OUTSIDER = address(0xDEAD);

    /// @notice Bonded party key, standing in for a Service's `bondAccount`.
    bytes32 internal constant PARTY = keccak256("service-one");

    /// @notice A second bonded party, used to show ledgers are per party as well as per Asset.
    bytes32 internal constant OTHER_PARTY = keccak256("service-two");

    /// @notice First Asset under test.
    address internal constant ASSET_A = address(0xA55E7A);

    /// @notice Second Asset under test, present in every isolation assertion.
    address internal constant ASSET_B = address(0xA55E7B);

    /// @notice Number of steps the fuzzed operation sequence drives.
    uint256 internal constant STEPS = 12;

    /// @notice Widest per-step amount the fuzzed sequence may credit or pledge.
    /// @dev Twelve steps at this ceiling stay far below the `uint128` range, so the sequence exercises
    /// the ledger rather than the overflow guard.
    uint256 internal constant STEP_AMOUNT_CEILING = 1_000_000_000_000;

    /// @notice Deploys the Bond and completes its one-shot wiring.
    function setUp() public {
        bond = new Bond(address(this));
        bond.setSettlementVerifier(VERIFIER);
        bond.setTabBook(BOOK);
    }

    // ------------------------------------------------------------------ wiring

    /// @notice Wiring is one-shot in both slots and refuses the zero address.
    function test_wiringIsOneShotAndRefusesZero() public {
        vm.expectRevert(abi.encodeWithSelector(IBond.AlreadyWired.selector, VERIFIER));
        bond.setSettlementVerifier(OUTSIDER);

        vm.expectRevert(abi.encodeWithSelector(IBond.AlreadyWired.selector, BOOK));
        bond.setTabBook(OUTSIDER);

        Bond fresh = new Bond(address(this));
        vm.expectRevert(IBond.ZeroWiringTarget.selector);
        fresh.setTabBook(address(0));
        vm.expectRevert(IBond.ZeroWiringTarget.selector);
        fresh.setSettlementVerifier(address(0));
    }

    /// @notice Only the wiring authority may wire, and the authority itself may not be zero.
    function test_wiringIsRestrictedToTheAuthority() public {
        Bond fresh = new Bond(address(this));

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(IBond.NotWiringAuthority.selector, OUTSIDER));
        fresh.setTabBook(BOOK);

        vm.expectRevert(IBond.ZeroWiringTarget.selector);
        new Bond(address(0));
    }

    /// @notice An unwired Bond accepts nothing, because `msg.sender` is never the zero address.
    function test_unwiredBondAcceptsNothing() public {
        Bond fresh = new Bond(address(this));

        vm.expectRevert(abi.encodeWithSelector(IBond.NotSettlementVerifier.selector, address(this)));
        fresh.fundFromVerifiedSettlement(PARTY, ASSET_A, 1, bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(IBond.NotTabBook.selector, address(this)));
        fresh.reserve(PARTY, ASSET_A, 1, keccak256("c"));
    }

    // ------------------------------------------------------------------ access control

    /// @notice Funding is gated on the verifier; pledging and releasing are gated on the `TabBook`.
    function test_accessControlOnEveryMutatingPath() public {
        vm.prank(BOOK);
        vm.expectRevert(abi.encodeWithSelector(IBond.NotSettlementVerifier.selector, BOOK));
        bond.fundFromVerifiedSettlement(PARTY, ASSET_A, 100, bytes32(0));

        vm.prank(VERIFIER);
        vm.expectRevert(abi.encodeWithSelector(IBond.NotTabBook.selector, VERIFIER));
        bond.reserve(PARTY, ASSET_A, 1, keccak256("c"));

        vm.prank(VERIFIER);
        vm.expectRevert(abi.encodeWithSelector(IBond.NotTabBook.selector, VERIFIER));
        bond.release(keccak256("c"));
    }

    /// @notice Neither the zero Asset nor a zero amount may enter a ledger.
    function test_zeroAssetAndZeroAmountAreRejected() public {
        vm.prank(VERIFIER);
        vm.expectRevert(abi.encodeWithSelector(IBond.AssetNotRegistered.selector, address(0)));
        bond.fundFromVerifiedSettlement(PARTY, address(0), 100, bytes32(0));

        vm.prank(VERIFIER);
        vm.expectRevert(IBond.ZeroAmount.selector);
        bond.fundFromVerifiedSettlement(PARTY, ASSET_A, 0, bytes32(0));

        vm.prank(BOOK);
        vm.expectRevert(abi.encodeWithSelector(IBond.AssetNotRegistered.selector, address(0)));
        bond.reserve(PARTY, address(0), 100, keccak256("c"));

        vm.prank(BOOK);
        vm.expectRevert(IBond.ZeroAmount.selector);
        bond.reserve(PARTY, ASSET_A, 0, keccak256("c"));
    }

    // ------------------------------------------------------------------ the five figures

    /// @notice Fund, pledge, release: all five figures are asserted after each step.
    function test_fundReserveReleaseWalksTheFiveFigures() public {
        bytes32 clearingId = keccak256("clearing-1");

        _assertFigures(PARTY, ASSET_A, 0, 0, 0, 0, 0);

        _fund(PARTY, ASSET_A, 1_000_000);
        _assertFigures(PARTY, ASSET_A, 1_000_000, 0, 0, 0, 1_000_000);

        vm.expectEmit(true, true, true, true, address(bond));
        emit IBond.BondReserved(clearingId, PARTY, ASSET_A, 400_000);
        assertTrue(_reserve(PARTY, ASSET_A, 400_000, clearingId), "pledge accepted");
        _assertFigures(PARTY, ASSET_A, 1_000_000, 400_000, 0, 0, 600_000);

        IBond.Reservation memory pledge = bond.reservationOf(clearingId);
        assertEq(pledge.party, PARTY, "pledge party");
        assertEq(pledge.asset, ASSET_A, "pledge asset");
        assertEq(pledge.amount, 400_000, "pledge amount");
        assertEq(uint256(pledge.state), uint256(IBond.ReservationState.Reserved), "pledge state");

        vm.expectEmit(true, true, true, true, address(bond));
        emit IBond.BondReleased(clearingId, PARTY, ASSET_A, 400_000);
        vm.prank(BOOK);
        bond.release(clearingId);

        // Confirming returns the pledge to free Bond. It does not make stake withdrawable, so the
        // `released` figure stays at zero: that figure is withdrawal-eligible value, not this.
        _assertFigures(PARTY, ASSET_A, 1_000_000, 0, 0, 0, 1_000_000);
        assertEq(
            uint256(bond.reservationOf(clearingId).state),
            uint256(IBond.ReservationState.Released),
            "pledge resolved"
        );
    }

    /// @notice Proven funding is credited to the named Asset and announced with its replay key.
    function test_fundingEmitsTheProvenDeposit() public {
        bytes32 key = keccak256(abi.encode(PARTY, ASSET_A, uint128(250)));

        vm.expectEmit(true, true, false, true, address(bond));
        emit IBond.BondFunded(PARTY, ASSET_A, 250, key);
        _fund(PARTY, ASSET_A, 250);

        _assertFigures(PARTY, ASSET_A, 250, 0, 0, 0, 250);
    }

    /// @notice A pledge for exactly the free amount is accepted and takes free Bond to zero.
    function test_pledgeForExactlyFreeBondIsAccepted() public {
        _fund(PARTY, ASSET_A, 500);
        assertTrue(_reserve(PARTY, ASSET_A, 500, keccak256("exact")), "exact pledge accepted");
        _assertFigures(PARTY, ASSET_A, 500, 500, 0, 0, 0);
    }

    /// @notice A shortfall returns `false`, writes nothing, and emits nothing.
    /// @dev This is the outcome `TabBook` needs in order to emit `ProvisionalClearingDeclined` and
    /// leave the Open Tab unchanged, so it must not revert and must not half-apply.
    function test_pledgeShortByOneBaseUnitDeclinesWithoutWriting() public {
        _fund(PARTY, ASSET_A, 1_000);
        bytes32 clearingId = keccak256("short");

        vm.recordLogs();
        assertFalse(_reserve(PARTY, ASSET_A, 1_001, clearingId), "pledge declined");
        assertEq(vm.getRecordedLogs().length, 0, "declined pledge is silent");

        _assertFigures(PARTY, ASSET_A, 1_000, 0, 0, 0, 1_000);
        assertEq(
            uint256(bond.reservationOf(clearingId).state),
            uint256(IBond.ReservationState.None),
            "no pledge recorded"
        );

        // The identifier stays usable, so the same clearing can be pledged once the Bond is topped up.
        _fund(PARTY, ASSET_A, 1);
        assertTrue(_reserve(PARTY, ASSET_A, 1_001, clearingId), "pledge accepted after top-up");
        _assertFigures(PARTY, ASSET_A, 1_001, 1_001, 0, 0, 0);
    }

    /// @notice Free Bond is not pledgeable twice: the second clearing is declined.
    function test_pledgedBondIsNotPledgeableTwice() public {
        _fund(PARTY, ASSET_A, 1_000);
        assertTrue(_reserve(PARTY, ASSET_A, 1_000, keccak256("first")), "first pledge accepted");
        assertFalse(_reserve(PARTY, ASSET_A, 1, keccak256("second")), "second pledge declined");
        _assertFigures(PARTY, ASSET_A, 1_000, 1_000, 0, 0, 0);
    }

    /// @notice A clearing identifier carries at most one pledge, and only a pledged one releases.
    function test_clearingIdentifierLifecycleIsSingleUse() public {
        _fund(PARTY, ASSET_A, 1_000);
        bytes32 clearingId = keccak256("once");
        assertTrue(_reserve(PARTY, ASSET_A, 100, clearingId), "pledge accepted");

        vm.prank(BOOK);
        vm.expectRevert(abi.encodeWithSelector(IBond.ClearingAlreadyResolved.selector, clearingId));
        bond.reserve(PARTY, ASSET_A, 100, clearingId);

        vm.prank(BOOK);
        bond.release(clearingId);

        vm.prank(BOOK);
        vm.expectRevert(abi.encodeWithSelector(IBond.ClearingAlreadyResolved.selector, clearingId));
        bond.release(clearingId);

        bytes32 unknown = keccak256("never-pledged");
        vm.prank(BOOK);
        vm.expectRevert(abi.encodeWithSelector(IBond.ReservationUnknown.selector, unknown));
        bond.release(unknown);
    }

    // ------------------------------------------------------------------ per-Asset isolation

    /// @notice Every operation on Asset A leaves every figure of Asset B untouched, field by field.
    function test_operationsOnOneAssetLeaveTheOtherUntouched() public {
        _fund(PARTY, ASSET_A, 1_000);
        _fund(PARTY, ASSET_B, 700);
        _fund(OTHER_PARTY, ASSET_A, 900);

        bytes32 clearingId = keccak256("isolation");
        assertTrue(_reserve(PARTY, ASSET_A, 1_000, clearingId), "pledge accepted on A");

        // Asset A is fully pledged. Asset B is untouched, so a clearing on B still fits, which it
        // could not if coverage were checked against a figure spanning both Assets.
        _assertFigures(PARTY, ASSET_A, 1_000, 1_000, 0, 0, 0);
        _assertFigures(PARTY, ASSET_B, 700, 0, 0, 0, 700);
        _assertFigures(OTHER_PARTY, ASSET_A, 900, 0, 0, 0, 900);
        assertTrue(_reserve(PARTY, ASSET_B, 700, keccak256("on-b")), "pledge accepted on B");

        vm.prank(BOOK);
        bond.release(clearingId);

        // Releasing on A returns A's pledge and leaves B pledged.
        _assertFigures(PARTY, ASSET_A, 1_000, 0, 0, 0, 1_000);
        _assertFigures(PARTY, ASSET_B, 700, 700, 0, 0, 0);
        _assertFigures(OTHER_PARTY, ASSET_A, 900, 0, 0, 0, 900);
    }

    /// @notice A pledge on one Asset is declined even when another Asset holds ample free Bond.
    function test_freeBondInAnotherAssetDoesNotCoverThisOne() public {
        _fund(PARTY, ASSET_B, 1_000_000);
        assertFalse(_reserve(PARTY, ASSET_A, 1, keccak256("cross")), "cross-Asset cover refused");
        _assertFigures(PARTY, ASSET_A, 0, 0, 0, 0, 0);
        _assertFigures(PARTY, ASSET_B, 1_000_000, 0, 0, 0, 1_000_000);
    }

    // ------------------------------------------------------------------ the identity, fuzzed

    /// @notice The consistency identity survives arbitrary interleavings across two Assets.
    /// @dev After every single step, for both Assets: `staked == reserved + slashed + released + free`,
    /// `staked` equals the total credited into that Asset alone, and `reserved` equals the sum of the
    /// pledges outstanding in that Asset alone. The second and third assertions are what would catch a
    /// write that landed in the wrong Asset's ledger; the first is the identity itself.
    ///
    /// The two seeds are sliced rather than taken as arrays so the generated sequence is dense: every
    /// draw yields a well-formed step, and the fuzzer spends its runs on orderings instead of on
    /// rejected inputs.
    /// @param opSeed Byte per step: the low bit picks the Asset, the next bits pick the operation.
    /// @param amountSeed Seed the per-step amount is derived from.
    function testFuzz_identityAndIsolationHoldAcrossOperationSequences(uint96 opSeed, uint256 amountSeed)
        public
    {
        bytes32[STEPS] memory pledged;
        uint256 pledgedCount;
        uint256[2] memory funded;
        uint256[2] memory outstanding;

        for (uint256 i = 0; i < STEPS; ++i) {
            uint256 selector = (uint256(opSeed) >> (i * 8)) & 0xff;
            uint256 slot = selector & 1;
            address asset = slot == 0 ? ASSET_A : ASSET_B;
            uint128 amount = uint128(uint256(keccak256(abi.encode(amountSeed, i))) % STEP_AMOUNT_CEILING + 1);

            uint256 action = (selector >> 1) % 3;
            if (action == 0) {
                _fund(PARTY, asset, amount);
                funded[slot] += amount;
            } else if (action == 1) {
                bytes32 clearingId = keccak256(abi.encode("step", i));
                if (_reserve(PARTY, asset, amount, clearingId)) {
                    pledged[pledgedCount] = clearingId;
                    pledgedCount += 1;
                    outstanding[slot] += amount;
                }
            } else if (pledgedCount > 0) {
                pledgedCount -= 1;
                bytes32 clearingId = pledged[pledgedCount];
                IBond.Reservation memory pledge = bond.reservationOf(clearingId);
                vm.prank(BOOK);
                bond.release(clearingId);
                outstanding[pledge.asset == ASSET_A ? 0 : 1] -= pledge.amount;
            }

            _assertLedgerConsistent(ASSET_A, funded[0], outstanding[0]);
            _assertLedgerConsistent(ASSET_B, funded[1], outstanding[1]);
        }
    }

    // ------------------------------------------------------------------ helpers

    /// @notice Credits proven stake as the wired verifier would.
    /// @param party Bonded party to credit.
    /// @param asset Asset of the deposit.
    /// @param amount Amount in Asset base units.
    function _fund(bytes32 party, address asset, uint128 amount) internal {
        vm.prank(VERIFIER);
        bond.fundFromVerifiedSettlement(party, asset, amount, keccak256(abi.encode(party, asset, amount)));
    }

    /// @notice Pledges Bond as the wired `TabBook` would.
    /// @param party Bonded party whose stake is pledged.
    /// @param asset Asset of the clearing.
    /// @param amount Provisionally cleared amount.
    /// @param clearingId Identifier of the clearing.
    /// @return accepted Whether free Bond covered the amount.
    function _reserve(bytes32 party, address asset, uint128 amount, bytes32 clearingId)
        internal
        returns (bool accepted)
    {
        vm.prank(BOOK);
        return bond.reserve(party, asset, amount, clearingId);
    }

    /// @notice Asserts all five figures, plus the identity, for one party and Asset.
    /// @param party Bonded party.
    /// @param asset Asset queried.
    /// @param staked Expected staked amount.
    /// @param reserved Expected reserved amount.
    /// @param slashed Expected slashed amount.
    /// @param released Expected released amount.
    /// @param free Expected free amount.
    function _assertFigures(
        bytes32 party,
        address asset,
        uint128 staked,
        uint128 reserved,
        uint128 slashed,
        uint128 released,
        uint128 free
    ) internal view {
        IBond.Ledger memory ledger = bond.ledgerOf(party, asset);
        assertEq(ledger.staked, staked, "staked");
        assertEq(ledger.reserved, reserved, "reserved");
        assertEq(ledger.slashed, slashed, "slashed");
        assertEq(ledger.released, released, "released");
        assertEq(bond.freeOf(party, asset), free, "free");
        assertEq(
            uint256(ledger.staked),
            uint256(ledger.reserved) + ledger.slashed + ledger.released + bond.freeOf(party, asset),
            "identity"
        );
    }

    /// @notice Asserts the identity plus the two per-Asset totals for one Asset of the fuzzed party.
    /// @param asset Asset queried.
    /// @param funded Total credited into that Asset by the sequence so far.
    /// @param outstanding Sum of the pledges still outstanding in that Asset.
    function _assertLedgerConsistent(address asset, uint256 funded, uint256 outstanding) internal view {
        _assertFigures(
            PARTY, asset, uint128(funded), uint128(outstanding), 0, 0, uint128(funded - outstanding)
        );
    }
}
