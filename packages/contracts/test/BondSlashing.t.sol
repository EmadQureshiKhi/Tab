// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {Bond, IBond} from "../src/Bond.sol";

/// @title BondSlashingTest
/// @notice Soundness tests for the two slashing transitions and for withdrawal.
/// @dev Scope is everything that moves value out of a Service's cover: the expiry slash, the reorg
/// slash, and the withdrawal cap. Four things are asserted rather than assumed:
///
///  1. where the value went — the slashed amount lands as prepaid credit for the named Agent in the
///     Asset of the slash, and in no other Agent's balance and no other Asset's;
///  2. per-Asset isolation, as a full before-and-after snapshot of the untouched Asset, so a leak
///     between Assets fails a test rather than a review;
///  3. the withdrawal cap at exactly free, one base unit above free, and with a live pledge
///     outstanding;
///  4. that only the wired `TabBook` can slash, and that a withdrawal moves only the stake of the
///     account that asked for it.
///
/// There is no test here for slashing an Agent that failed to settle an Open Tab, because there is no
/// entrypoint to test: `Bond` exposes exactly two slashing functions, both keyed on an artefact the
/// Service's own infrastructure produced, and neither accepts an Agent as the party whose stake moves
/// (R14.8, R14.11). `test_agentAppearsOnlyAsTheBeneficiaryOfASlash` pins that shape down from the
/// outside so a future entrypoint cannot be added quietly.
///
/// Requirements: 14.6, 14.7, 14.9, 14.11
contract BondSlashingTest is Test {
    /// @notice Contract under test.
    Bond internal bond;

    /// @notice The wired `SettlementVerifier`, the only address able to credit stake.
    address internal constant VERIFIER = address(0xA11CE);

    /// @notice The wired `TabBook`, the only address able to pledge, release, or slash.
    address internal constant BOOK = address(0xB00C);

    /// @notice An address wired to nothing, used for the rejection cases.
    address internal constant OUTSIDER = address(0xDEAD);

    /// @notice The Service operator holding the bonded account under test.
    address internal constant OPERATOR = address(0x5E7C1);

    /// @notice A second Service operator, present in the isolation assertions.
    address internal constant OTHER_OPERATOR = address(0x5E7C2);

    /// @notice The Agent a slash compensates.
    address internal constant AGENT = address(0xA6E71);

    /// @notice A second Agent, so a credit landing on the wrong one fails a test.
    address internal constant OTHER_AGENT = address(0xA6E72);

    /// @notice First Asset under test.
    address internal constant ASSET_A = address(0xA55E7A);

    /// @notice Second Asset under test, present in every isolation assertion.
    address internal constant ASSET_B = address(0xA55E7B);

    /// @notice Number of steps the fuzzed operation sequence drives.
    uint256 internal constant STEPS = 12;

    /// @notice Widest per-step amount the fuzzed sequence may credit, pledge, slash, or withdraw.
    uint256 internal constant STEP_AMOUNT_CEILING = 1_000_000_000_000;

    /// @notice Party key of `OPERATOR`, which is what its ledgers sit under.
    bytes32 internal party;

    /// @notice Party key of `OTHER_OPERATOR`.
    bytes32 internal otherParty;

    /// @notice Deploys the Bond, completes its one-shot wiring, and derives the two party keys.
    function setUp() public {
        bond = new Bond(address(this));
        bond.setSettlementVerifier(VERIFIER);
        bond.setTabBook(BOOK);
        party = bond.partyOf(OPERATOR);
        otherParty = bond.partyOf(OTHER_OPERATOR);
    }

    // ------------------------------------------------------------------ party keys

    /// @notice The party key of an account is its address widened, so a withdrawal is verifiably the
    /// stake of the account that asked for it.
    function test_partyKeyIsTheAccountAddressWidened() public view {
        assertEq(party, bytes32(uint256(uint160(OPERATOR))), "party key of the operator");
        assertTrue(party != otherParty, "distinct accounts, distinct keys");
    }

    // ------------------------------------------------------------------ expiry slash (R14.6)

    /// @notice An expired clearing moves its pledge from `reserved` to `slashed` and the value lands
    /// as prepaid credit for the named Agent in the Asset of the clearing.
    function test_slashUnconfirmedCreditsTheAgentInTheSameAsset() public {
        bytes32 clearingId = keccak256("expired");
        _fund(party, ASSET_A, 1_000);
        assertTrue(_reserve(party, ASSET_A, 400, clearingId), "pledge accepted");

        vm.expectEmit(true, true, true, true, address(bond));
        emit IBond.SlashedForUnconfirmedClearing(clearingId, party, ASSET_A, 400, AGENT);
        vm.prank(BOOK);
        assertEq(bond.slashUnconfirmed(clearingId, AGENT), 400, "slashed amount returned");

        // `staked` keeps the record of the loss; the pledge moved sideways into `slashed`, so `free`
        // is what it was before the pledge minus the slash.
        _assertFigures(party, ASSET_A, 1_000, 0, 400, 0, 600);
        assertEq(
            uint256(bond.reservationOf(clearingId).state),
            uint256(IBond.ReservationState.Slashed),
            "pledge slashed"
        );

        // The right Agent, in the right Asset, and nowhere else.
        assertEq(bond.prepaidCreditOf(AGENT, ASSET_A), 400, "Agent credited in the slashed Asset");
        assertEq(bond.prepaidCreditOf(AGENT, ASSET_B), 0, "no credit in the other Asset");
        assertEq(bond.prepaidCreditOf(OTHER_AGENT, ASSET_A), 0, "no credit for the other Agent");
    }

    /// @notice An expiry slash is single-use and terminal in both directions.
    function test_slashUnconfirmedIsSingleUseAndTerminal() public {
        bytes32 clearingId = keccak256("once");
        _fund(party, ASSET_A, 1_000);
        assertTrue(_reserve(party, ASSET_A, 400, clearingId), "pledge accepted");

        vm.prank(BOOK);
        bond.slashUnconfirmed(clearingId, AGENT);

        vm.prank(BOOK);
        vm.expectRevert(abi.encodeWithSelector(IBond.ClearingAlreadyResolved.selector, clearingId));
        bond.slashUnconfirmed(clearingId, AGENT);

        // A slashed clearing cannot be confirmed afterwards, and cannot be pledged again.
        vm.prank(BOOK);
        vm.expectRevert(abi.encodeWithSelector(IBond.ClearingAlreadyResolved.selector, clearingId));
        bond.release(clearingId);

        vm.prank(BOOK);
        vm.expectRevert(abi.encodeWithSelector(IBond.ClearingAlreadyResolved.selector, clearingId));
        bond.reserve(party, ASSET_A, 400, clearingId);

        _assertFigures(party, ASSET_A, 1_000, 0, 400, 0, 600);
        assertEq(bond.prepaidCreditOf(AGENT, ASSET_A), 400, "credited exactly once");
    }

    /// @notice A confirmed clearing cannot then be slashed for expiry.
    function test_slashUnconfirmedRefusesAConfirmedClearing() public {
        bytes32 clearingId = keccak256("confirmed");
        _fund(party, ASSET_A, 1_000);
        assertTrue(_reserve(party, ASSET_A, 400, clearingId), "pledge accepted");

        vm.prank(BOOK);
        bond.release(clearingId);

        vm.prank(BOOK);
        vm.expectRevert(abi.encodeWithSelector(IBond.ClearingAlreadyResolved.selector, clearingId));
        bond.slashUnconfirmed(clearingId, AGENT);

        _assertFigures(party, ASSET_A, 1_000, 0, 0, 0, 1_000);
        assertEq(bond.prepaidCreditOf(AGENT, ASSET_A), 0, "nothing credited");
    }

    /// @notice Only the wired `TabBook` slashes, an unknown clearing is refused, and the zero address
    /// cannot be the Agent credited.
    function test_slashUnconfirmedGuards() public {
        bytes32 clearingId = keccak256("guarded");
        _fund(party, ASSET_A, 1_000);
        assertTrue(_reserve(party, ASSET_A, 400, clearingId), "pledge accepted");

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(IBond.NotTabBook.selector, OUTSIDER));
        bond.slashUnconfirmed(clearingId, AGENT);

        vm.prank(VERIFIER);
        vm.expectRevert(abi.encodeWithSelector(IBond.NotTabBook.selector, VERIFIER));
        bond.slashUnconfirmed(clearingId, AGENT);

        vm.prank(BOOK);
        vm.expectRevert(IBond.ZeroBeneficiary.selector);
        bond.slashUnconfirmed(clearingId, address(0));

        bytes32 unknown = keccak256("never-pledged");
        vm.prank(BOOK);
        vm.expectRevert(abi.encodeWithSelector(IBond.ReservationUnknown.selector, unknown));
        bond.slashUnconfirmed(unknown, AGENT);

        // Every rejection left the pledge pledged and the ledger untouched.
        _assertFigures(party, ASSET_A, 1_000, 400, 0, 0, 600);
    }

    // ------------------------------------------------------------------ reorg slash (R14.7)

    /// @notice A superseded Settlement is slashed out of free Bond, because its pledge was already
    /// returned when the clearing was confirmed.
    function test_slashForReorgTakesFreeBondAndCreditsTheAgent() public {
        bytes32 clearingId = keccak256("confirmed-then-reorged");
        bytes32 replayKey = keccak256("replay-key");

        _fund(party, ASSET_A, 1_000);
        assertTrue(_reserve(party, ASSET_A, 300, clearingId), "pledge accepted");
        vm.prank(BOOK);
        bond.release(clearingId);

        assertFalse(bond.reorgSlashedFor(replayKey), "not yet slashed");

        vm.expectEmit(true, true, true, true, address(bond));
        emit IBond.SlashedForReorg(replayKey, party, ASSET_A, 300, AGENT);
        vm.prank(BOOK);
        assertEq(bond.slashForReorg(replayKey, party, ASSET_A, 300, AGENT), 300, "slashed in full");

        _assertFigures(party, ASSET_A, 1_000, 0, 300, 0, 700);
        assertEq(bond.prepaidCreditOf(AGENT, ASSET_A), 300, "Agent credited in the slashed Asset");
        assertEq(bond.prepaidCreditOf(AGENT, ASSET_B), 0, "no credit in the other Asset");
        assertTrue(bond.reorgSlashedFor(replayKey), "replay key spent");
    }

    /// @notice When free Bond is short, the reorg slash takes what is there and says so on chain.
    /// @dev Reverting instead would take the whole reorg report down with it, leaving a Settlement
    /// that provably no longer exists still crediting a tab.
    function test_slashForReorgCapsAtFreeAndReportsTheShortfall() public {
        bytes32 replayKey = keccak256("short-cover");
        _fund(party, ASSET_A, 500);
        assertTrue(_reserve(party, ASSET_A, 400, keccak256("live")), "pledge accepted");

        vm.expectEmit(true, true, true, true, address(bond));
        emit IBond.ReorgSlashShortfall(replayKey, party, ASSET_A, 400, 100);
        vm.expectEmit(true, true, true, true, address(bond));
        emit IBond.SlashedForReorg(replayKey, party, ASSET_A, 100, AGENT);
        vm.prank(BOOK);
        assertEq(bond.slashForReorg(replayKey, party, ASSET_A, 400, AGENT), 100, "capped at free");

        _assertFigures(party, ASSET_A, 500, 400, 100, 0, 0);
        assertEq(bond.prepaidCreditOf(AGENT, ASSET_A), 100, "credited what was covered");

        // With nothing free at all the slash is a no-op that still records the reorg.
        bytes32 secondKey = keccak256("no-cover");
        vm.expectEmit(true, true, true, true, address(bond));
        emit IBond.ReorgSlashShortfall(secondKey, party, ASSET_A, 50, 0);
        vm.prank(BOOK);
        assertEq(bond.slashForReorg(secondKey, party, ASSET_A, 50, AGENT), 0, "nothing to take");

        _assertFigures(party, ASSET_A, 500, 400, 100, 0, 0);
        assertEq(bond.prepaidCreditOf(AGENT, ASSET_A), 100, "credit unchanged");
        assertTrue(bond.reorgSlashedFor(secondKey), "replay key spent even at zero");
    }

    /// @notice One reorganised Settlement is slashed once, by the `TabBook`, for a real amount, in a
    /// real Asset, towards a real Agent.
    function test_slashForReorgGuards() public {
        bytes32 replayKey = keccak256("guarded-replay");
        _fund(party, ASSET_A, 1_000);

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(IBond.NotTabBook.selector, OUTSIDER));
        bond.slashForReorg(replayKey, party, ASSET_A, 100, AGENT);

        vm.prank(BOOK);
        vm.expectRevert(abi.encodeWithSelector(IBond.AssetNotRegistered.selector, address(0)));
        bond.slashForReorg(replayKey, party, address(0), 100, AGENT);

        vm.prank(BOOK);
        vm.expectRevert(IBond.ZeroAmount.selector);
        bond.slashForReorg(replayKey, party, ASSET_A, 0, AGENT);

        vm.prank(BOOK);
        vm.expectRevert(IBond.ZeroBeneficiary.selector);
        bond.slashForReorg(replayKey, party, ASSET_A, 100, address(0));

        vm.prank(BOOK);
        bond.slashForReorg(replayKey, party, ASSET_A, 100, AGENT);

        vm.prank(BOOK);
        vm.expectRevert(abi.encodeWithSelector(IBond.ReorgAlreadySlashed.selector, replayKey));
        bond.slashForReorg(replayKey, party, ASSET_A, 100, AGENT);

        _assertFigures(party, ASSET_A, 1_000, 0, 100, 0, 900);
        assertEq(bond.prepaidCreditOf(AGENT, ASSET_A), 100, "slashed once");
    }

    // ------------------------------------------------------------------ per-Asset isolation

    /// @notice Both slashes on Asset A leave every figure of Asset B, and every prepaid credit in
    /// Asset B, exactly as they were.
    function test_slashingOneAssetLeavesTheOtherUntouched() public {
        _fund(party, ASSET_A, 1_000);
        _fund(party, ASSET_B, 700);
        _fund(otherParty, ASSET_B, 900);
        assertTrue(_reserve(party, ASSET_B, 200, keccak256("b-live")), "pledge accepted on B");

        // A slash on Asset B first, so the untouched snapshot carries non-zero values in every field
        // that the Asset A slashes could plausibly leak into.
        assertTrue(_reserve(party, ASSET_B, 100, keccak256("b-expired")), "second pledge on B");
        vm.prank(BOOK);
        bond.slashUnconfirmed(keccak256("b-expired"), OTHER_AGENT);
        vm.prank(OPERATOR);
        bond.requestWithdrawal(ASSET_B, 50);

        IBond.Ledger memory beforeB = bond.ledgerOf(party, ASSET_B);
        IBond.Ledger memory beforeOtherB = bond.ledgerOf(otherParty, ASSET_B);
        uint128 beforeFreeB = bond.freeOf(party, ASSET_B);
        uint128 beforeCreditB = bond.prepaidCreditOf(OTHER_AGENT, ASSET_B);

        assertTrue(_reserve(party, ASSET_A, 400, keccak256("a-expired")), "pledge accepted on A");
        vm.prank(BOOK);
        bond.slashUnconfirmed(keccak256("a-expired"), AGENT);
        vm.prank(BOOK);
        bond.slashForReorg(keccak256("a-reorg"), party, ASSET_A, 250, AGENT);

        _assertFigures(party, ASSET_A, 1_000, 0, 650, 0, 350);
        _assertLedgerEq(beforeB, bond.ledgerOf(party, ASSET_B), "Asset B of the slashed party");
        _assertLedgerEq(beforeOtherB, bond.ledgerOf(otherParty, ASSET_B), "Asset B of the other party");
        assertEq(bond.freeOf(party, ASSET_B), beforeFreeB, "free in Asset B");
        assertEq(bond.prepaidCreditOf(OTHER_AGENT, ASSET_B), beforeCreditB, "credit in Asset B");
        assertEq(bond.prepaidCreditOf(AGENT, ASSET_B), 0, "the Asset A Agent has no Asset B credit");
    }

    /// @notice Prepaid credit is per Agent and per Asset, so four slashes make four balances.
    function test_prepaidCreditIsPerAgentAndPerAsset() public {
        _fund(party, ASSET_A, 1_000);
        _fund(party, ASSET_B, 1_000);

        vm.startPrank(BOOK);
        bond.slashForReorg(keccak256("k1"), party, ASSET_A, 10, AGENT);
        bond.slashForReorg(keccak256("k2"), party, ASSET_B, 20, AGENT);
        bond.slashForReorg(keccak256("k3"), party, ASSET_A, 30, OTHER_AGENT);
        bond.slashForReorg(keccak256("k4"), party, ASSET_B, 40, OTHER_AGENT);
        vm.stopPrank();

        assertEq(bond.prepaidCreditOf(AGENT, ASSET_A), 10, "agent one, Asset A");
        assertEq(bond.prepaidCreditOf(AGENT, ASSET_B), 20, "agent one, Asset B");
        assertEq(bond.prepaidCreditOf(OTHER_AGENT, ASSET_A), 30, "agent two, Asset A");
        assertEq(bond.prepaidCreditOf(OTHER_AGENT, ASSET_B), 40, "agent two, Asset B");
    }

    // ------------------------------------------------------------------ no Agent-default slash

    /// @notice An Agent can only ever be the beneficiary of a slash, never its subject. (R14.11)
    /// @dev The two slashing entrypoints are keyed on a pledge this contract wrote and on the replay
    /// key of a superseded Verified Settlement. Neither takes an Open Tab, a Settlement Window, or an
    /// elapsed-without-payment condition, so an Agent that simply did not pay presents nothing either
    /// one accepts. Here that is checked from the outside: an Agent address used in the party position
    /// slashes nothing, because an Agent has no stake, and the ledger it names stays empty.
    function test_agentAppearsOnlyAsTheBeneficiaryOfASlash() public {
        bytes32 agentAsParty = bond.partyOf(AGENT);

        // The Agent has no pledge, so the expiry path has nothing to name.
        vm.prank(BOOK);
        vm.expectRevert(
            abi.encodeWithSelector(IBond.ReservationUnknown.selector, keccak256("agent-open-tab"))
        );
        bond.slashUnconfirmed(keccak256("agent-open-tab"), AGENT);

        // The reorg path accepts a party key, and an Agent's key addresses an empty ledger: the slash
        // caps at a free amount of zero and takes nothing. There is no stake to reach.
        vm.prank(BOOK);
        assertEq(
            bond.slashForReorg(keccak256("unsettled-tab"), agentAsParty, ASSET_A, 5_000, AGENT),
            0,
            "an Agent has no stake to slash"
        );

        _assertFigures(agentAsParty, ASSET_A, 0, 0, 0, 0, 0);
        assertEq(bond.prepaidCreditOf(AGENT, ASSET_A), 0, "nothing moved anywhere");
    }

    // ------------------------------------------------------------------ withdrawal (R14.9)

    /// @notice A request for exactly the free amount releases all of it.
    function test_withdrawalAtExactlyFreeReleasesEverything() public {
        _fund(party, ASSET_A, 1_000);

        vm.expectEmit(true, true, false, true, address(bond));
        emit IBond.WithdrawalReleased(party, ASSET_A, 1_000);
        vm.prank(OPERATOR);
        assertEq(bond.requestWithdrawal(ASSET_A, 1_000), 1_000, "released in full");

        _assertFigures(party, ASSET_A, 1_000, 0, 0, 1_000, 0);
    }

    /// @notice A request one base unit above free releases the free amount and does not revert.
    function test_withdrawalOneBaseUnitAboveFreeCapsAtFree() public {
        _fund(party, ASSET_A, 1_000);

        vm.prank(OPERATOR);
        assertEq(bond.requestWithdrawal(ASSET_A, 1_001), 1_000, "capped at free");
        _assertFigures(party, ASSET_A, 1_000, 0, 0, 1_000, 0);

        // Released stake is no longer cover, so nothing further can be withdrawn or pledged against.
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBond.InsufficientFreeBond.selector, party, ASSET_A, uint128(1), uint128(0)
            )
        );
        bond.requestWithdrawal(ASSET_A, 1);
        assertFalse(_reserve(party, ASSET_A, 1, keccak256("after-withdrawal")), "no cover left");
    }

    /// @notice A live pledge is not withdrawable, and becomes withdrawable once its clearing resolves.
    function test_withdrawalWithALivePledgeTakesOnlyTheUnpledgedPart() public {
        bytes32 clearingId = keccak256("live-pledge");
        _fund(party, ASSET_A, 1_000);
        assertTrue(_reserve(party, ASSET_A, 600, clearingId), "pledge accepted");

        vm.prank(OPERATOR);
        assertEq(bond.requestWithdrawal(ASSET_A, 1_000), 400, "only the unpledged part");
        _assertFigures(party, ASSET_A, 1_000, 600, 0, 400, 0);

        vm.prank(BOOK);
        bond.release(clearingId);
        _assertFigures(party, ASSET_A, 1_000, 0, 0, 400, 600);

        vm.prank(OPERATOR);
        assertEq(bond.requestWithdrawal(ASSET_A, 600), 600, "the returned pledge is withdrawable");
        _assertFigures(party, ASSET_A, 1_000, 0, 0, 1_000, 0);
    }

    /// @notice Slashed stake is not withdrawable, so a slash and a withdrawal cannot both take it.
    function test_slashedStakeIsNotWithdrawable() public {
        bytes32 clearingId = keccak256("slashed-then-withdrawn");
        _fund(party, ASSET_A, 1_000);
        assertTrue(_reserve(party, ASSET_A, 600, clearingId), "pledge accepted");

        vm.prank(BOOK);
        bond.slashUnconfirmed(clearingId, AGENT);

        vm.prank(OPERATOR);
        assertEq(bond.requestWithdrawal(ASSET_A, 1_000), 400, "the slashed part is gone");
        _assertFigures(party, ASSET_A, 1_000, 0, 600, 400, 0);
    }

    /// @notice A withdrawal names no party: it moves the stake of the account that called, and only a
    /// non-empty Asset can be withdrawn from.
    function test_withdrawalGuardsAndAuthenticatesTheCaller() public {
        _fund(party, ASSET_A, 1_000);

        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(IBond.AssetNotRegistered.selector, address(0)));
        bond.requestWithdrawal(address(0), 100);

        vm.prank(OPERATOR);
        vm.expectRevert(IBond.ZeroAmount.selector);
        bond.requestWithdrawal(ASSET_A, 0);

        // Another account's request reaches its own empty ledger, never the operator's stake.
        bytes32 outsiderParty = bond.partyOf(OUTSIDER);
        vm.prank(OUTSIDER);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBond.InsufficientFreeBond.selector, outsiderParty, ASSET_A, uint128(100), uint128(0)
            )
        );
        bond.requestWithdrawal(ASSET_A, 100);

        // An Asset the party never funded is empty too, even while another Asset holds stake.
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBond.InsufficientFreeBond.selector, party, ASSET_B, uint128(100), uint128(0)
            )
        );
        bond.requestWithdrawal(ASSET_B, 100);

        _assertFigures(party, ASSET_A, 1_000, 0, 0, 0, 1_000);
    }

    // ------------------------------------------------------------------ the identity, fuzzed

    /// @notice The accounting identity and the slash-to-credit conservation survive arbitrary
    /// interleavings of pledging, confirming, both slashes, and withdrawal, across two Assets.
    /// @dev After every single step, for both Assets: `staked == reserved + slashed + released + free`,
    /// `staked` equals the total credited into that Asset alone, `reserved` equals the pledges still
    /// outstanding in that Asset alone, and the prepaid credit the Agent holds in that Asset equals
    /// the cumulative slashed figure of that Asset. The last of those is the conservation claim — every
    /// base unit that left the Service's cover through a slash arrived as credit for the Agent, in the
    /// Asset it was slashed in, and none arrived twice.
    /// @param opSeed Byte per step: the low bit picks the Asset, the next bits pick the operation.
    /// @param amountSeed Seed the per-step amount is derived from.
    function testFuzz_identityAndSlashConservationHoldAcrossSequences(uint96 opSeed, uint256 amountSeed)
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

            uint256 action = (selector >> 1) % 5;
            if (action == 0) {
                _fund(party, asset, amount);
                funded[slot] += amount;
            } else if (action == 1) {
                bytes32 clearingId = keccak256(abi.encode("step", i));
                if (_reserve(party, asset, amount, clearingId)) {
                    pledged[pledgedCount] = clearingId;
                    pledgedCount += 1;
                    outstanding[slot] += amount;
                }
            } else if (action == 2) {
                bytes32 replayKey = keccak256(abi.encode("reorg", i));
                vm.prank(BOOK);
                bond.slashForReorg(replayKey, party, asset, amount, AGENT);
            } else if (action == 3) {
                // The free read comes first: a request against an empty Asset is a caller fault, and
                // the sequence is exercising the accounting rather than that guard.
                if (bond.freeOf(party, asset) > 0) {
                    vm.prank(OPERATOR);
                    bond.requestWithdrawal(asset, amount);
                }
            } else if (pledgedCount > 0) {
                // Resolve the newest pledge, half by confirmation and half by expiry slash.
                pledgedCount -= 1;
                bytes32 clearingId = pledged[pledgedCount];
                IBond.Reservation memory pledge = bond.reservationOf(clearingId);
                vm.prank(BOOK);
                if (selector & 0x80 == 0) {
                    bond.release(clearingId);
                } else {
                    bond.slashUnconfirmed(clearingId, AGENT);
                }
                outstanding[pledge.asset == ASSET_A ? 0 : 1] -= pledge.amount;
            }

            _assertLedgerConsistent(ASSET_A, funded[0], outstanding[0]);
            _assertLedgerConsistent(ASSET_B, funded[1], outstanding[1]);
        }
    }

    // ------------------------------------------------------------------ helpers

    /// @notice Credits proven stake as the wired verifier would.
    /// @param stakeParty Bonded party to credit.
    /// @param asset Asset of the deposit.
    /// @param amount Amount in Asset base units.
    function _fund(bytes32 stakeParty, address asset, uint128 amount) internal {
        vm.prank(VERIFIER);
        bond.fundFromVerifiedSettlement(
            stakeParty, asset, amount, keccak256(abi.encode(stakeParty, asset, amount))
        );
    }

    /// @notice Pledges Bond as the wired `TabBook` would.
    /// @param stakeParty Bonded party whose stake is pledged.
    /// @param asset Asset of the clearing.
    /// @param amount Provisionally cleared amount.
    /// @param clearingId Identifier of the clearing.
    /// @return accepted Whether free Bond covered the amount.
    function _reserve(bytes32 stakeParty, address asset, uint128 amount, bytes32 clearingId)
        internal
        returns (bool accepted)
    {
        vm.prank(BOOK);
        return bond.reserve(stakeParty, asset, amount, clearingId);
    }

    /// @notice Asserts all five figures, plus the identity, for one party and Asset.
    /// @param stakeParty Bonded party.
    /// @param asset Asset queried.
    /// @param staked Expected staked amount.
    /// @param reserved Expected reserved amount.
    /// @param slashed Expected slashed amount.
    /// @param released Expected released amount.
    /// @param free Expected free amount.
    function _assertFigures(
        bytes32 stakeParty,
        address asset,
        uint128 staked,
        uint128 reserved,
        uint128 slashed,
        uint128 released,
        uint128 free
    ) internal view {
        IBond.Ledger memory ledger = bond.ledgerOf(stakeParty, asset);
        assertEq(ledger.staked, staked, "staked");
        assertEq(ledger.reserved, reserved, "reserved");
        assertEq(ledger.slashed, slashed, "slashed");
        assertEq(ledger.released, released, "released");
        assertEq(bond.freeOf(stakeParty, asset), free, "free");
        assertEq(
            uint256(ledger.staked),
            uint256(ledger.reserved) + ledger.slashed + ledger.released + bond.freeOf(stakeParty, asset),
            "identity"
        );
    }

    /// @notice Asserts two ledger snapshots are identical field by field.
    /// @param expected Snapshot taken before the operations under test.
    /// @param actual Snapshot taken after them.
    /// @param label Which ledger is being compared.
    function _assertLedgerEq(IBond.Ledger memory expected, IBond.Ledger memory actual, string memory label)
        internal
        pure
    {
        assertEq(actual.staked, expected.staked, string.concat(label, ": staked"));
        assertEq(actual.reserved, expected.reserved, string.concat(label, ": reserved"));
        assertEq(actual.slashed, expected.slashed, string.concat(label, ": slashed"));
        assertEq(actual.released, expected.released, string.concat(label, ": released"));
    }

    /// @notice Asserts the identity, the two per-Asset totals, and slash-to-credit conservation.
    /// @param asset Asset queried.
    /// @param funded Total credited into that Asset by the sequence so far.
    /// @param outstanding Sum of the pledges still outstanding in that Asset.
    function _assertLedgerConsistent(address asset, uint256 funded, uint256 outstanding) internal view {
        IBond.Ledger memory ledger = bond.ledgerOf(party, asset);
        assertEq(uint256(ledger.staked), funded, "staked equals what this Asset was credited");
        assertEq(uint256(ledger.reserved), outstanding, "reserved equals this Asset's live pledges");
        assertEq(
            uint256(ledger.staked),
            uint256(ledger.reserved) + ledger.slashed + ledger.released + bond.freeOf(party, asset),
            "identity"
        );
        assertEq(
            bond.prepaidCreditOf(AGENT, asset),
            ledger.slashed,
            "every slashed base unit reached the Agent in the Asset it left"
        );
    }
}
