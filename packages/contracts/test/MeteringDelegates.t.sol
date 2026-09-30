// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {IMeteringDelegates, MeteringDelegates} from "../src/MeteringDelegates.sol";

/// @dev The registry an Agent names its metering session keys in. Every property a gateway relies
/// on is here: only the Agent writes its own entries, an entry lapses at its expiry, the expiry is
/// bounded, and a revocation takes effect in the same block.
contract MeteringDelegatesTest is Test {
    MeteringDelegates internal delegates;
    address internal agent = makeAddr("agent");
    address internal delegate = makeAddr("delegate");
    address internal stranger = makeAddr("stranger");

    uint64 internal constant START = 1_800_000_000;

    function setUp() public {
        vm.warp(START);
        delegates = new MeteringDelegates();
    }

    function test_setRecordsTheExpiryAndEmits() public {
        uint64 expiry = START + 30 days;
        vm.expectEmit(true, true, false, true, address(delegates));
        emit IMeteringDelegates.DelegateSet(agent, delegate, expiry);
        vm.prank(agent);
        delegates.setDelegate(delegate, expiry);

        assertEq(delegates.expiryOf(agent, delegate), expiry, "expiry recorded");
        assertTrue(delegates.isDelegate(agent, delegate), "a delegate now");
    }

    function test_theEntryBelongsToTheCallerAndNobodyElse() public {
        vm.prank(agent);
        delegates.setDelegate(delegate, START + 1 days);

        // The same key is nobody else's delegate, and nobody else can name one for the Agent.
        assertFalse(delegates.isDelegate(stranger, delegate), "not the stranger's delegate");
        assertFalse(delegates.isDelegate(delegate, agent), "the relation is not symmetric");
        vm.prank(stranger);
        delegates.setDelegate(stranger, START + 1 days);
        assertFalse(delegates.isDelegate(agent, stranger), "a stranger cannot name a delegate for the Agent");
        assertTrue(delegates.isDelegate(stranger, stranger), "only for itself");
    }

    function test_theZeroAddressIsRefused() public {
        vm.prank(agent);
        vm.expectRevert(IMeteringDelegates.ZeroAddressDelegate.selector);
        delegates.setDelegate(address(0), START + 1 days);
    }

    function test_anExpiryNotInTheFutureIsRefused() public {
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(IMeteringDelegates.ExpiryNotInFuture.selector, START, START));
        delegates.setDelegate(delegate, START);
        vm.expectRevert(
            abi.encodeWithSelector(IMeteringDelegates.ExpiryNotInFuture.selector, START - 1, START)
        );
        delegates.setDelegate(delegate, START - 1);
        vm.expectRevert(abi.encodeWithSelector(IMeteringDelegates.ExpiryNotInFuture.selector, 0, START));
        delegates.setDelegate(delegate, 0);
        vm.stopPrank();
        assertEq(delegates.expiryOf(agent, delegate), 0, "nothing recorded");
    }

    function test_theExpiryIsBoundedToAYearAhead() public {
        uint64 latest = START + delegates.MAX_DELEGATION();
        assertEq(delegates.MAX_DELEGATION(), 365 days, "a year");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IMeteringDelegates.ExpiryTooFar.selector, latest + 1, latest));
        delegates.setDelegate(delegate, latest + 1);

        // The bound itself is allowed.
        vm.prank(agent);
        delegates.setDelegate(delegate, latest);
        assertEq(delegates.expiryOf(agent, delegate), latest);
    }

    function test_aDelegateLapsesAtItsExpiry() public {
        uint64 expiry = START + 1 hours;
        vm.prank(agent);
        delegates.setDelegate(delegate, expiry);

        vm.warp(expiry - 1);
        assertTrue(delegates.isDelegate(agent, delegate), "valid in the last second before expiry");
        vm.warp(expiry);
        assertFalse(delegates.isDelegate(agent, delegate), "lapsed at the expiry itself");
        vm.warp(expiry + 365 days);
        assertFalse(delegates.isDelegate(agent, delegate), "and stays lapsed");
        assertEq(delegates.expiryOf(agent, delegate), expiry, "the lapsed expiry still reads back");
    }

    function test_settingAgainReplacesTheExpiry() public {
        vm.startPrank(agent);
        delegates.setDelegate(delegate, START + 10 days);
        delegates.setDelegate(delegate, START + 1 days);
        vm.stopPrank();
        assertEq(delegates.expiryOf(agent, delegate), START + 1 days, "shortened");

        vm.warp(START + 2 days);
        assertFalse(delegates.isDelegate(agent, delegate), "the shorter expiry is the one that holds");

        vm.prank(agent);
        delegates.setDelegate(delegate, START + 40 days);
        assertTrue(delegates.isDelegate(agent, delegate), "renewed after lapsing");
    }

    function test_revokeTakesEffectAtOnceAndEmits() public {
        vm.prank(agent);
        delegates.setDelegate(delegate, START + 30 days);

        vm.expectEmit(true, true, false, true, address(delegates));
        emit IMeteringDelegates.DelegateRevoked(agent, delegate);
        vm.prank(agent);
        delegates.revokeDelegate(delegate);

        assertFalse(delegates.isDelegate(agent, delegate), "revoked in the same block");
        assertEq(delegates.expiryOf(agent, delegate), 0, "cleared");
    }

    function test_revokeRefusesADelegateThatWasNeverSet() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IMeteringDelegates.DelegateNotSet.selector, agent, delegate));
        delegates.revokeDelegate(delegate);

        // Revoking twice is the same refusal the second time.
        vm.startPrank(agent);
        delegates.setDelegate(delegate, START + 1 days);
        delegates.revokeDelegate(delegate);
        vm.expectRevert(abi.encodeWithSelector(IMeteringDelegates.DelegateNotSet.selector, agent, delegate));
        delegates.revokeDelegate(delegate);
        vm.stopPrank();
    }

    function test_onlyTheAgentCanRevokeItsDelegate() public {
        vm.prank(agent);
        delegates.setDelegate(delegate, START + 1 days);

        // A stranger's revoke is scoped to the stranger's own entries, where there is nothing.
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IMeteringDelegates.DelegateNotSet.selector, stranger, delegate)
        );
        delegates.revokeDelegate(delegate);
        // The delegate cannot revoke itself out of the Agent's entry either.
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(IMeteringDelegates.DelegateNotSet.selector, delegate, delegate)
        );
        delegates.revokeDelegate(delegate);
        assertTrue(delegates.isDelegate(agent, delegate), "untouched");
    }

    function test_aLapsedDelegateCanStillBeRevoked() public {
        vm.prank(agent);
        delegates.setDelegate(delegate, START + 1 hours);
        vm.warp(START + 2 hours);
        vm.prank(agent);
        delegates.revokeDelegate(delegate);
        assertEq(delegates.expiryOf(agent, delegate), 0, "cleared");
    }

    function test_itHoldsNothing() public {
        vm.deal(address(this), 1 ether);
        (bool sent,) = address(delegates).call{value: 1 wei}("");
        assertFalse(sent, "no receive, no fallback");
        assertEq(address(delegates).balance, 0);
    }

    /// @dev Any expiry inside the bound is recorded exactly and is live until it passes; any outside is
    /// refused and records nothing.
    function testFuzz_expiryWithinTheBoundIsRecordedAndOutsideIsRefused(uint64 expiry, uint32 later) public {
        uint64 latest = START + delegates.MAX_DELEGATION();
        vm.prank(agent);
        if (expiry <= START) {
            vm.expectRevert(
                abi.encodeWithSelector(IMeteringDelegates.ExpiryNotInFuture.selector, expiry, START)
            );
            delegates.setDelegate(delegate, expiry);
            assertEq(delegates.expiryOf(agent, delegate), 0);
            return;
        }
        if (expiry > latest) {
            vm.expectRevert(abi.encodeWithSelector(IMeteringDelegates.ExpiryTooFar.selector, expiry, latest));
            delegates.setDelegate(delegate, expiry);
            assertEq(delegates.expiryOf(agent, delegate), 0);
            return;
        }
        delegates.setDelegate(delegate, expiry);
        assertEq(delegates.expiryOf(agent, delegate), expiry);

        uint256 when = uint256(START) + uint256(later);
        vm.warp(when);
        assertEq(delegates.isDelegate(agent, delegate), expiry > when, "live exactly until the expiry");
    }
}
