// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IBond} from "../src/Bond.sol";
import {ITabBook} from "../src/TabBook.sol";
import {TabBookFixture} from "./TabBook.t.sol";

/// @title TabBookClearingTest
/// @notice Lifecycle tests for the Provisional Clearing state machine.
/// @dev Every transition in the design's table is driven, in both directions where the guard has two
/// outcomes, and the Bond figures are asserted alongside the tab figures at each step. Three things
/// the design calls out are checked directly rather than implied:
///
///  1. **No second reduction.** Confirmation returns the pledge and moves no tab figure, so the
///     reduction that happened at application time is the only one.
///  2. **A decline leaves the Open Tab exactly as it was.** The observation is recorded, an event
///     names the free Bond that fell short, and the tab is untouched until a Verified Settlement lands.
///  3. **Reversal restores what was removed, not what was observed.** Those differ whenever the tab
///     held less than the observation, and restoring the observation would leave the Agent owing money
///     it never owed.
///
/// **The identity of a clearing is the replay key of the Settlement log it clears**, packed as
/// `(chainKey, blockHeight, txIndex, logIndex)`. Three consequences are pinned below: that the
/// `chainKey` field must agree with the one inside the key, that a Settlement in the wrong Asset still
/// finds the clearing and is rejected loudly, and that two logs of one transaction in two Assets are
/// two clearings rather than a collision.
///
/// Requirements: 4.1, 14.4, 14.5, 14.6, 14.7, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.8, 18.4
contract TabBookClearingTest is TabBookFixture {
    /// @notice Source Chain block height every observation in this suite names.
    uint64 internal constant BLOCK_HEIGHT = 21_000_000;

    /// @notice Index of the observed transaction within that block.
    uint64 internal constant TX_INDEX = 7;

    /// @notice Block digest the attested chain carries after a reorganisation.
    bytes32 internal constant REORGED_DIGEST = keccak256("reorged-digest");

    /// @notice Replay key of the observed log: Mainnet, {BLOCK_HEIGHT}, {TX_INDEX}, log ordinal 0.
    /// @dev Written out rather than built by a helper because a `constant` needs a literal expression.
    /// The layout is `TabAscBase`'s: chainKey in bits 255 down to 192, then height, then transaction
    /// index, then log ordinal. It is the same key the confirming proof carries. (R4.1)
    bytes32 internal constant REPLAY_KEY = bytes32(
        (uint256(CHAIN_MAINNET) << 192) | (uint256(BLOCK_HEIGHT) << 128) | (uint256(TX_INDEX) << 64)
            | uint256(0)
    );

    /// @notice The second log of that same transaction, which is a different Settlement.
    bytes32 internal constant REPLAY_KEY_LOG_ONE = bytes32(
        (uint256(CHAIN_MAINNET) << 192) | (uint256(BLOCK_HEIGHT) << 128) | (uint256(TX_INDEX) << 64)
            | uint256(1)
    );

    /// @notice The same coordinates on Sepolia, whose deadline is half Mainnet's.
    bytes32 internal constant REPLAY_KEY_SEPOLIA = bytes32(
        (uint256(CHAIN_SEPOLIA) << 192) | (uint256(BLOCK_HEIGHT) << 128) | (uint256(TX_INDEX) << 64)
            | uint256(0)
    );

    /// @notice A replay key naming a Source Chain that carries no deadline. (D6)
    bytes32 internal constant REPLAY_KEY_UNSUPPORTED_CHAIN = bytes32(
        (uint256(2) << 192) | (uint256(BLOCK_HEIGHT) << 128) | (uint256(TX_INDEX) << 64) | uint256(0)
    );

    /// @notice Open Tab every test opens before clearing it, in launch-Asset base units.
    uint128 internal constant OPEN = 1_000_000;

    /// @notice Units that produce {OPEN} at the registered price.
    uint32 internal constant OPEN_UNITS = 1_000;

    /// @notice Mainnet confirmation deadline. (D6)
    uint64 internal constant DEADLINE_MAINNET = 60 minutes;

    /// @notice Sepolia confirmation deadline. (D6)
    uint64 internal constant DEADLINE_SEPOLIA = 30 minutes;

    // ------------------------------------------------------------------ application

    /// @notice Applying pledges Bond, reduces the tab, and sets the Mainnet deadline. (R15.1, R15.2)
    function test_applyPledgesBondReducesTabAndSetsTheMainnetDeadline() public {
        _deliver(OPEN_UNITS);
        uint128 freeBefore = bond.freeOf(bond.partyOf(OPERATOR), USDC);

        bytes32 clearingId = _apply(REPLAY_KEY, USDC, OPEN);
        assertEq(clearingId, REPLAY_KEY, "the identity is the replay key the Watcher supplied");

        ITabBook.Clearing memory clearing = book.clearingOf(clearingId);
        assertEq(uint8(clearing.state), uint8(ITabBook.ClearingState.Applied), "state Applied");
        assertEq(clearing.agent, AGENT, "agent");
        assertEq(clearing.serviceId, SERVICE, "service");
        assertEq(clearing.asset, USDC, "asset");
        assertEq(clearing.amount, OPEN, "observed amount");
        assertEq(clearing.reduced, OPEN, "reduction applied");
        assertEq(clearing.chainKey, CHAIN_MAINNET, "chain key");
        assertEq(clearing.appliedAt, uint64(block.timestamp), "applied at");
        assertEq(clearing.deadline, uint64(block.timestamp) + DEADLINE_MAINNET, "60 minute deadline");
        assertEq(clearing.sourceTxHash, TX_HASH, "source transaction hash");
        assertEq(clearing.attestedDigestAtApply, OBSERVED_DIGEST, "digest recorded");

        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, 0, "tab reduced");
        assertEq(book.assetOpen(AGENT, USDC), 0, "aggregate reduced");
        assertEq(book.headroom(AGENT, USDC, _witness(USDC)), BASELINE, "headroom restored");

        IBond.Ledger memory ledger = bond.ledgerOf(bond.partyOf(OPERATOR), USDC);
        assertEq(ledger.reserved, OPEN, "bond pledged");
        assertEq(bond.freeOf(bond.partyOf(OPERATOR), USDC), freeBefore - OPEN, "free bond down");

        // The pledge sits under the replay key too, so the proof that releases it names one word.
        assertEq(bond.reservationOf(REPLAY_KEY).amount, OPEN, "reservation keyed on the replay key");
    }

    /// @notice The Sepolia deadline is 30 minutes. (D6)
    function test_sepoliaDeadlineIsThirtyMinutes() public {
        _deliver(OPEN_UNITS);
        bytes32 clearingId = _apply(REPLAY_KEY_SEPOLIA, USDC, OPEN);
        assertEq(
            book.clearingOf(clearingId).deadline,
            uint64(block.timestamp) + DEADLINE_SEPOLIA,
            "30 minute deadline"
        );
    }

    /// @notice The `chainKey` field must agree with the one packed into the replay key. (R4.1, D6)
    /// @dev The identity comes from the replay key and the deadline from the `chainKey` field, so the
    /// two disagreeing is the one way a Watcher could name a deadline belonging to one Source Chain on
    /// an identity that says another. Sepolia's deadline is half Mainnet's, so the disagreement is
    /// worth an entire chain's difference in how long a clearing may sit unconfirmed.
    function test_suppliedChainKeyMustAgreeWithTheReplayKey() public {
        vm.prank(WATCHER);
        vm.expectRevert(
            abi.encodeWithSelector(ITabBook.ReplayKeyChainKeyMismatch.selector, CHAIN_MAINNET, CHAIN_SEPOLIA)
        );
        book.applyProvisionalClearing(_observationOn(REPLAY_KEY, USDC, OPEN, CHAIN_SEPOLIA));

        vm.prank(WATCHER);
        vm.expectRevert(
            abi.encodeWithSelector(ITabBook.ReplayKeyChainKeyMismatch.selector, CHAIN_SEPOLIA, CHAIN_MAINNET)
        );
        book.applyProvisionalClearing(_observationOn(REPLAY_KEY_SEPOLIA, USDC, OPEN, CHAIN_MAINNET));

        // Nothing was written under either identity.
        assertEq(uint8(book.clearingOf(REPLAY_KEY).state), uint8(ITabBook.ClearingState.None), "none");
        assertEq(uint8(book.clearingOf(REPLAY_KEY_SEPOLIA).state), uint8(ITabBook.ClearingState.None), "none");
    }

    /// @notice A chainKey with no deadline, a zero amount, and a zero address are all refused.
    function test_applicationGuards() public {
        vm.prank(WATCHER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.UnsupportedChainKey.selector, uint64(2)));
        book.applyProvisionalClearing(_observation(REPLAY_KEY_UNSUPPORTED_CHAIN, USDC, OPEN));

        vm.prank(WATCHER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.AmountOutOfRange.selector, uint256(0)));
        book.applyProvisionalClearing(_observation(REPLAY_KEY, USDC, 0));

        vm.prank(WATCHER);
        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        book.applyProvisionalClearing(_observation(REPLAY_KEY, address(0), OPEN));

        ITabBook.ProvisionalObservation memory noAgent = _observation(REPLAY_KEY, USDC, OPEN);
        noAgent.agent = address(0);
        vm.prank(WATCHER);
        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        book.applyProvisionalClearing(noAgent);
    }

    /// @notice Only the wired Watcher may apply a clearing or report a reorganisation.
    function test_clearingWritesAreWatcherOnly() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.NotWatcher.selector, STRANGER));
        book.applyProvisionalClearing(_observation(REPLAY_KEY, USDC, OPEN));

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.NotWatcher.selector, STRANGER));
        book.reportReorg(REPLAY_KEY, OBSERVED_DIGEST, REORGED_DIGEST);
    }

    /// @notice The reduction is capped at the Open Tab, and the excess is not banked provisionally.
    /// @dev A Provisional Clearing is revocable for its whole life, so the part of the observation the
    /// tab could not absorb must not become prepaid credit yet. It becomes prepaid only when the
    /// Verified Settlement makes it final. (R15.6)
    function test_reductionIsCappedAtTheOpenTabAndExcessIsNotBankedYet() public {
        _deliver(1);
        bytes32 clearingId = _apply(REPLAY_KEY, USDC, OPEN);

        assertEq(book.clearingOf(clearingId).reduced, PRICE, "reduced only what was open");
        assertEq(book.clearingOf(clearingId).amount, OPEN, "pledged the whole observation");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, 0, "tab emptied");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).prepaid, 0, "nothing banked yet");
    }

    /// @notice One observation is applied once; a repeat is refused whichever way the first went.
    function test_oneObservationAppliesOnce() public {
        _deliver(OPEN_UNITS);
        bytes32 clearingId = _apply(REPLAY_KEY, USDC, OPEN);

        vm.prank(WATCHER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITabBook.ClearingAlreadyExists.selector, clearingId, ITabBook.ClearingState.Applied
            )
        );
        book.applyProvisionalClearing(_observation(REPLAY_KEY, USDC, OPEN));
    }

    /// @notice Two logs of one transaction in two Assets are two clearings, not a collision. (R4.1)
    /// @dev This is the limitation the replay-key identity removes, so it is pinned rather than
    /// described. An identity derived from `(chainKey, sourceTxHash, agent, serviceId, asset)` would
    /// have given these two logs the same Asset-blind locator, and the second observation would have
    /// been refused as a repeat of the first. Their replay keys differ in the log ordinal alone, so
    /// each clears its own tab, pledges against its own Asset's Bond ledger, and confirms on its own
    /// proof.
    function test_twoLogsOfOneTransactionInDifferentAssetsClearIndependently() public {
        _deliver(OPEN_UNITS);
        _deliverAs(OPERATOR, SERVICE, USDT, 1, PRICE_TWO);

        bytes32 launchKey = _apply(REPLAY_KEY, USDC, OPEN);
        bytes32 secondKey = _apply(REPLAY_KEY_LOG_ONE, USDT, uint128(PRICE_TWO));
        assertTrue(launchKey != secondKey, "one transaction, two identities");

        assertEq(book.clearingOf(launchKey).asset, USDC, "first log cleared the launch Asset");
        assertEq(book.clearingOf(secondKey).asset, USDT, "second log cleared the second Asset");
        assertEq(book.clearingOf(launchKey).reduced, OPEN, "first reduction");
        assertEq(book.clearingOf(secondKey).reduced, uint128(PRICE_TWO), "second reduction");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, 0, "launch tab cleared");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDT)).open, 0, "second tab cleared");

        // The pledges are per Asset, so neither ledger paid for the other's clearing. (R18.5)
        assertEq(bond.ledgerOf(bond.partyOf(OPERATOR), USDC).reserved, OPEN, "launch Asset pledge");
        assertEq(bond.ledgerOf(bond.partyOf(OPERATOR), USDT).reserved, uint128(PRICE_TWO), "second pledge");

        // And each confirms against its own proof, with no interference between them.
        _settleFull(REPLAY_KEY, SERVICE, USDC, OPEN, CHAIN_MAINNET);
        assertEq(uint8(book.clearingOf(launchKey).state), uint8(ITabBook.ClearingState.Confirmed), "one");
        assertEq(uint8(book.clearingOf(secondKey).state), uint8(ITabBook.ClearingState.Applied), "other");

        _settleFull(REPLAY_KEY_LOG_ONE, SERVICE, USDT, PRICE_TWO, CHAIN_MAINNET);
        assertEq(uint8(book.clearingOf(secondKey).state), uint8(ITabBook.ClearingState.Confirmed), "two");
        assertEq(bond.ledgerOf(bond.partyOf(OPERATOR), USDC).reserved, 0, "launch pledge returned");
        assertEq(bond.ledgerOf(bond.partyOf(OPERATOR), USDT).reserved, 0, "second pledge returned");
    }

    // ------------------------------------------------------------------ decline

    /// @notice Short free Bond declines the clearing and leaves the Open Tab exactly as it was. (R15.3)
    function test_declineLeavesTheOpenTabUnchanged() public {
        _deliver(OPEN_UNITS);
        uint128 free = bond.freeOf(bond.partyOf(OPERATOR), USDC);
        uint128 tooMuch = free + 1;

        vm.prank(WATCHER);
        vm.expectEmit(true, true, true, true, address(book));
        emit ITabBook.ProvisionalClearingDeclined(AGENT, SERVICE, USDC, tooMuch, TX_HASH, free);
        bool applied = book.applyProvisionalClearing(_observation(REPLAY_KEY, USDC, tooMuch));

        assertFalse(applied, "declined");
        assertEq(uint8(book.clearingOf(REPLAY_KEY).state), uint8(ITabBook.ClearingState.Declined), "state");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, OPEN, "tab untouched");
        assertEq(book.assetOpen(AGENT, USDC), OPEN, "aggregate untouched");
        assertEq(bond.ledgerOf(bond.partyOf(OPERATOR), USDC).reserved, 0, "nothing pledged");
        assertEq(bond.freeOf(bond.partyOf(OPERATOR), USDC), free, "free bond untouched");
    }

    /// @notice A declined observation is not reapplied, and its Settlement takes the ordinary path.
    /// @dev The design's transition table has `Declined → Confirmed` on `applyVerifiedSettlement`, with
    /// an ordinary reduction and no Bond involvement. Both clearing and Settlement now sit under the
    /// same replay key, so the Settlement's own record replaces the declined one and that transition is
    /// visible on chain rather than implied.
    function test_declinedObservationIsTerminalAndSettlesOrdinarily() public {
        _deliver(OPEN_UNITS);
        uint128 tooMuch = bond.freeOf(bond.partyOf(OPERATOR), USDC) + 1;

        vm.prank(WATCHER);
        book.applyProvisionalClearing(_observation(REPLAY_KEY, USDC, tooMuch));

        vm.prank(WATCHER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITabBook.ClearingAlreadyExists.selector, REPLAY_KEY, ITabBook.ClearingState.Declined
            )
        );
        book.applyProvisionalClearing(_observation(REPLAY_KEY, USDC, 1));

        // The Verified Settlement reduces the tab in the ordinary way, with no Bond involvement.
        _settleFull(REPLAY_KEY, SERVICE, USDC, OPEN, CHAIN_MAINNET);

        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, 0, "tab reduced by the proof");
        assertEq(uint8(book.clearingOf(REPLAY_KEY).state), uint8(ITabBook.ClearingState.Confirmed), "st");
        assertEq(bond.ledgerOf(bond.partyOf(OPERATOR), USDC).reserved, 0, "no pledge anywhere");
        assertEq(bond.ledgerOf(bond.partyOf(OPERATOR), USDC).slashed, 0, "no slash anywhere");
    }

    // ------------------------------------------------------------------ confirmation

    /// @notice Confirmation returns the pledge and applies no second reduction. (R15.4, R14.5)
    function test_confirmationReleasesBondAndAppliesNoSecondReduction() public {
        _deliver(OPEN_UNITS);
        bytes32 clearingId = _apply(REPLAY_KEY, USDC, OPEN);

        uint128 openAfterApply = book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open;
        uint256 aggregateAfterApply = book.assetOpen(AGENT, USDC);

        // The transaction hash on the event comes off the clearing record, because the proof carries
        // none. It is the hash the Watcher supplied at observation. (R15.8)
        vm.expectEmit(true, true, true, true, address(book));
        emit ITabBook.ProvisionalClearingConfirmed(clearingId, AGENT, SERVICE, USDC, OPEN, TX_HASH);
        _settleFull(REPLAY_KEY, SERVICE, USDC, OPEN, CHAIN_MAINNET);

        assertEq(uint8(book.clearingOf(clearingId).state), uint8(ITabBook.ClearingState.Confirmed), "st");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, openAfterApply, "no second cut");
        assertEq(book.assetOpen(AGENT, USDC), aggregateAfterApply, "aggregate unchanged");

        IBond.Ledger memory ledger = bond.ledgerOf(bond.partyOf(OPERATOR), USDC);
        assertEq(ledger.reserved, 0, "pledge returned");
        assertEq(ledger.slashed, 0, "nothing slashed");
        assertEq(bond.freeOf(bond.partyOf(OPERATOR), USDC), BOND_STAKE, "free bond whole again");

        // The reservation is terminal, so the same clearing cannot be confirmed twice.
        assertEq(
            uint8(bond.reservationOf(clearingId).state), uint8(IBond.ReservationState.Released), "released"
        );
    }

    /// @notice A confirmed replay key is refused a second time. (R15.4)
    function test_aConfirmedClearingIsNotConfirmedTwice() public {
        _deliver(OPEN_UNITS);
        _apply(REPLAY_KEY, USDC, OPEN);
        _settleFull(REPLAY_KEY, SERVICE, USDC, OPEN, CHAIN_MAINNET);

        vm.prank(VERIFIER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.SettlementAlreadyApplied.selector, REPLAY_KEY));
        book.applyVerifiedSettlement(_settlement(REPLAY_KEY, SERVICE, USDC, OPEN, CHAIN_MAINNET));
    }

    /// @notice Confirmation banks the part of the observation the tab could not absorb. (R12.5)
    function test_confirmationBanksTheExcessAsPrepaidCredit() public {
        _deliver(1);
        _apply(REPLAY_KEY, USDC, OPEN);

        _settleFull(REPLAY_KEY, SERVICE, USDC, OPEN, CHAIN_MAINNET);

        ITabBook.Tab memory tab = book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC));
        assertEq(tab.open, 0, "tab still zero");
        assertEq(tab.prepaid, OPEN - PRICE, "excess banked once the proof made it final");
    }

    /// @notice A Settlement in one Asset presented against a clearing in another is refused. (R18.4)
    /// @dev **This is the test that shows Asset-blindness survived the change of identity.** The replay
    /// key carries no Asset, so a Settlement denominated in the wrong one still resolves the clearing
    /// and is rejected loudly. An identity that folded the Asset in would have derived a different word
    /// and missed the clearing silently, reducing the tab twice.
    function test_assetMismatchAgainstAClearingInAnotherAsset() public {
        _deliverAs(OPERATOR, SERVICE, USDT, 1, PRICE_TWO);

        vm.prank(WATCHER);
        book.applyProvisionalClearing(_observation(REPLAY_KEY, USDT, uint128(PRICE_TWO)));

        vm.prank(VERIFIER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.AssetMismatch.selector, USDT, USDC));
        book.applyVerifiedSettlement(_settlement(REPLAY_KEY, SERVICE, USDC, PRICE_TWO, CHAIN_MAINNET));

        // Nothing moved: the clearing is still live in its own Asset and the wrong-Asset tab is empty.
        assertEq(uint8(book.clearingOf(REPLAY_KEY).state), uint8(ITabBook.ClearingState.Applied), "live");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, 0, "launch Asset untouched");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).prepaid, 0, "nothing banked either");
    }

    // ------------------------------------------------------------------ reversal

    /// @notice Reversal restores the tab, slashes the pledge, and credits the Agent. (R15.5, R14.6)
    function test_reversalRestoresTheTabAndSlashesThePledge() public {
        _deliver(OPEN_UNITS);
        bytes32 clearingId = _apply(REPLAY_KEY, USDC, OPEN);

        vm.warp(book.clearingOf(clearingId).deadline);

        vm.expectEmit(true, true, true, true, address(book));
        emit ITabBook.ProvisionalClearingReversed(clearingId, AGENT, SERVICE, USDC, OPEN, TX_HASH);
        book.reverseExpiredClearing(clearingId);

        assertEq(uint8(book.clearingOf(clearingId).state), uint8(ITabBook.ClearingState.Reversed), "st");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, OPEN, "tab restored");
        assertEq(book.assetOpen(AGENT, USDC), OPEN, "aggregate restored");

        IBond.Ledger memory ledger = bond.ledgerOf(bond.partyOf(OPERATOR), USDC);
        assertEq(ledger.reserved, 0, "pledge consumed");
        assertEq(ledger.slashed, OPEN, "pledge slashed");
        assertEq(bond.prepaidCreditOf(AGENT, USDC), OPEN, "Agent made whole in the same Asset");
        assertEq(bond.prepaidCreditOf(AGENT, USDT), 0, "and in no other Asset");
    }

    /// @notice Reversal restores what the application removed, not what was observed.
    function test_reversalRestoresTheReductionRatherThanTheObservation() public {
        _deliver(1);
        bytes32 clearingId = _apply(REPLAY_KEY, USDC, OPEN);

        vm.warp(book.clearingOf(clearingId).deadline);
        book.reverseExpiredClearing(clearingId);

        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, PRICE, "exactly what was removed");
        assertEq(bond.prepaidCreditOf(AGENT, USDC), OPEN, "slash is still the whole pledge");
    }

    /// @notice A reversed clearing whose proof arrives afterwards reduces the tab again. (R12.4)
    /// @dev A real sequence, not a hypothetical: the Watcher observed a Settlement, could not prove it
    /// inside the deadline, the crank restored the Open Tab and slashed the pledge, and then the proof
    /// landed. The tab is owed again, so the Settlement takes the ordinary path and reduces it. The
    /// slash is not undone, because the Service did fail to prove its claim in time.
    function test_aReversedClearingSettlesOrdinarilyAndReducesTheTabAgain() public {
        _deliver(OPEN_UNITS);
        bytes32 clearingId = _apply(REPLAY_KEY, USDC, OPEN);

        vm.warp(book.clearingOf(clearingId).deadline);
        book.reverseExpiredClearing(clearingId);
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, OPEN, "restored by the reversal");

        vm.expectEmit(true, true, true, true, address(book));
        emit ITabBook.SettlementApplied(REPLAY_KEY, AGENT, SERVICE, USDC, OPEN, 0, 0);
        _settleFull(REPLAY_KEY, SERVICE, USDC, OPEN, CHAIN_MAINNET);

        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, 0, "reduced again by the proof");
        assertEq(book.assetOpen(AGENT, USDC), 0, "aggregate follows");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).prepaid, 0, "no excess to bank");
        assertEq(uint8(book.clearingOf(REPLAY_KEY).state), uint8(ITabBook.ClearingState.Confirmed), "st");

        IBond.Ledger memory ledger = bond.ledgerOf(bond.partyOf(OPERATOR), USDC);
        assertEq(ledger.slashed, OPEN, "the slash stands");
        assertEq(ledger.reserved, 0, "and no new pledge was made or returned");
        assertEq(bond.prepaidCreditOf(AGENT, USDC), OPEN, "the Agent keeps the compensation");
    }

    /// @notice The crank is refused before the deadline and permitted at it, by anybody.
    function test_reversalBoundaryAndPermissionlessness() public {
        _deliver(OPEN_UNITS);
        bytes32 clearingId = _apply(REPLAY_KEY, USDC, OPEN);
        uint64 deadline = book.clearingOf(clearingId).deadline;

        vm.warp(deadline - 1);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.ClearingNotExpired.selector, clearingId, deadline));
        book.reverseExpiredClearing(clearingId);

        vm.warp(deadline);
        vm.prank(STRANGER);
        book.reverseExpiredClearing(clearingId);
        assertEq(uint8(book.clearingOf(clearingId).state), uint8(ITabBook.ClearingState.Reversed), "st");
    }

    /// @notice Reversal refuses an unknown clearing and a clearing that is not live.
    function test_reversalGuards() public {
        bytes32 unknown = keccak256("nothing");
        vm.expectRevert(abi.encodeWithSelector(ITabBook.UnknownClearing.selector, unknown));
        book.reverseExpiredClearing(unknown);

        _deliver(OPEN_UNITS);
        bytes32 clearingId = _apply(REPLAY_KEY, USDC, OPEN);
        _settleFull(REPLAY_KEY, SERVICE, USDC, OPEN, CHAIN_MAINNET);

        vm.warp(block.timestamp + DEADLINE_MAINNET);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITabBook.ClearingNotInState.selector, clearingId, ITabBook.ClearingState.Confirmed
            )
        );
        book.reverseExpiredClearing(clearingId);
    }

    // ------------------------------------------------------------------ reorganisation

    /// @notice A reorganisation supersedes a Confirmed Clearing, restores the tab, and slashes. (R14.7)
    function test_reorgSupersedesAConfirmedClearing() public {
        _deliver(OPEN_UNITS);
        bytes32 clearingId = _apply(REPLAY_KEY, USDC, OPEN);
        _settleFull(REPLAY_KEY, SERVICE, USDC, OPEN, CHAIN_MAINNET);

        vm.prank(WATCHER);
        vm.expectEmit(true, true, true, true, address(book));
        emit ITabBook.SettlementSuperseded(
            REPLAY_KEY, AGENT, SERVICE, USDC, OPEN, OBSERVED_DIGEST, REORGED_DIGEST
        );
        book.reportReorg(REPLAY_KEY, OBSERVED_DIGEST, REORGED_DIGEST);

        assertEq(uint8(book.clearingOf(clearingId).state), uint8(ITabBook.ClearingState.Superseded), "st");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, OPEN, "tab restored");
        assertEq(bond.ledgerOf(bond.partyOf(OPERATOR), USDC).slashed, OPEN, "slashed for the reorg");
        assertEq(bond.prepaidCreditOf(AGENT, USDC), OPEN, "Agent credited");
        assertTrue(bond.reorgSlashedFor(REPLAY_KEY), "single-use guard set");
    }

    /// @notice A Settlement that never had a provisional stage is still supersedable.
    function test_reorgSupersedesASettlementWithNoProvisionalStage() public {
        _deliver(OPEN_UNITS);
        _settleFull(REPLAY_KEY, SERVICE, USDC, OPEN, CHAIN_MAINNET);

        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, 0, "settled");
        // No observation preceded the proof, so neither the digest nor the transaction hash was
        // recorded. Both being zero is the truthful answer rather than a gap.
        assertEq(book.clearingOf(REPLAY_KEY).attestedDigestAtApply, bytes32(0), "no digest recorded");
        assertEq(book.clearingOf(REPLAY_KEY).sourceTxHash, bytes32(0), "no transaction hash either");

        vm.prank(WATCHER);
        book.reportReorg(REPLAY_KEY, OBSERVED_DIGEST, REORGED_DIGEST);

        assertEq(uint8(book.clearingOf(REPLAY_KEY).state), uint8(ITabBook.ClearingState.Superseded), "st");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, OPEN, "tab restored");
        assertEq(bond.ledgerOf(bond.partyOf(OPERATOR), USDC).slashed, OPEN, "slashed for the reorg");
    }

    /// @notice Matching digests, an unknown replay key, a stale state, and a substituted digest fail.
    function test_reorgGuards() public {
        vm.prank(WATCHER);
        vm.expectRevert(
            abi.encodeWithSelector(ITabBook.NoReorgDetected.selector, REPLAY_KEY, OBSERVED_DIGEST)
        );
        book.reportReorg(REPLAY_KEY, OBSERVED_DIGEST, OBSERVED_DIGEST);

        vm.prank(WATCHER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.UnknownSettlement.selector, REPLAY_KEY));
        book.reportReorg(REPLAY_KEY, OBSERVED_DIGEST, REORGED_DIGEST);

        _deliver(OPEN_UNITS);
        bytes32 clearingId = _apply(REPLAY_KEY, USDC, OPEN);

        // A clearing that is live rather than confirmed has nothing to supersede yet.
        vm.prank(WATCHER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITabBook.ClearingNotInState.selector, clearingId, ITabBook.ClearingState.Applied
            )
        );
        book.reportReorg(REPLAY_KEY, OBSERVED_DIGEST, REORGED_DIGEST);

        _settleFull(REPLAY_KEY, SERVICE, USDC, OPEN, CHAIN_MAINNET);

        // The clearing recorded a digest at apply time, so a substituted observation is refused.
        vm.prank(WATCHER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITabBook.ObservedDigestMismatch.selector, OBSERVED_DIGEST, keccak256("something-else")
            )
        );
        book.reportReorg(REPLAY_KEY, keccak256("something-else"), REORGED_DIGEST);

        vm.prank(WATCHER);
        book.reportReorg(REPLAY_KEY, OBSERVED_DIGEST, REORGED_DIGEST);

        // Superseded is terminal.
        vm.prank(WATCHER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITabBook.ClearingNotInState.selector, clearingId, ITabBook.ClearingState.Superseded
            )
        );
        book.reportReorg(REPLAY_KEY, OBSERVED_DIGEST, REORGED_DIGEST);
    }

    /// @notice A superseded replay key is not settled again. (R14.7)
    function test_aSupersededReplayKeyIsNotSettledAgain() public {
        _deliver(OPEN_UNITS);
        _settleFull(REPLAY_KEY, SERVICE, USDC, OPEN, CHAIN_MAINNET);

        vm.prank(WATCHER);
        book.reportReorg(REPLAY_KEY, OBSERVED_DIGEST, REORGED_DIGEST);

        vm.prank(VERIFIER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.SettlementAlreadyApplied.selector, REPLAY_KEY));
        book.applyVerifiedSettlement(_settlement(REPLAY_KEY, SERVICE, USDC, OPEN, CHAIN_MAINNET));
    }

    /// @notice A superseded tab that had nothing to restore still records the supersession.
    function test_reorgOnAPurelyPrepaidSettlement() public {
        _settleFull(REPLAY_KEY, SERVICE, USDC, OPEN, CHAIN_MAINNET);
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).prepaid, OPEN, "all prepaid");

        vm.prank(WATCHER);
        book.reportReorg(REPLAY_KEY, OBSERVED_DIGEST, REORGED_DIGEST);

        assertEq(uint8(book.clearingOf(REPLAY_KEY).state), uint8(ITabBook.ClearingState.Superseded), "st");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, 0, "nothing to restore");
        assertEq(bond.ledgerOf(bond.partyOf(OPERATOR), USDC).slashed, OPEN, "still slashed");
    }

    // ------------------------------------------------------------------ helpers

    /// @notice Applies a Provisional Clearing as the Watcher and asserts it landed.
    /// @param replayKey Replay key of the observed log, which becomes the clearing's identity.
    /// @param asset Asset of the observation.
    /// @param amount Observed Settlement amount.
    /// @return clearingId Identifier of the clearing written, which is `replayKey`.
    function _apply(bytes32 replayKey, address asset, uint128 amount) internal returns (bytes32 clearingId) {
        vm.prank(WATCHER);
        bool applied = book.applyProvisionalClearing(_observation(replayKey, asset, amount));
        assertTrue(applied, "clearing applied");
        return replayKey;
    }
}
