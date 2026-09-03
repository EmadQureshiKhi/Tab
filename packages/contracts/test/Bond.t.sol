// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {Bond, IBond} from "../src/Bond.sol";
import {MockUsdc} from "../src/test/MockUsdc.sol";

contract BondTest is Test {
    Bond internal bond;
    MockUsdc internal usdc;
    MockUsdc internal ausd;

    address internal operator = makeAddr("operator");
    address internal treasury = makeAddr("treasury");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        bond = new Bond();
        usdc = new MockUsdc();
        ausd = new MockUsdc();
    }

    // ------------------------------------------------------------------ deposits

    function test_depositMovesTheStakeIntoEscrowAndCreditsTheCallersParty() public {
        _mintAndApprove(operator, usdc, 1_000_000);
        bytes32 party = bond.partyOf(operator);
        vm.expectEmit(true, true, false, true, address(bond));
        emit IBond.BondFunded(party, address(usdc), 1_000_000, operator);
        vm.prank(operator);
        bond.deposit(address(usdc), 1_000_000);
        assertEq(usdc.balanceOf(address(bond)), 1_000_000, "escrow holds the stake");
        assertEq(usdc.balanceOf(operator), 0, "operator paid it");
        IBond.Ledger memory ledger = bond.ledgerOf(party, address(usdc));
        assertEq(ledger.staked, 1_000_000, "staked");
        assertEq(ledger.withdrawn, 0, "nothing withdrawn");
        assertEq(bond.freeOf(party, address(usdc)), 1_000_000, "all free");
    }

    function test_depositForCreditsAnotherPartyPaidByTheCaller() public {
        _mintAndApprove(treasury, usdc, 500_000);
        vm.prank(treasury);
        bond.depositFor(operator, address(usdc), 500_000);
        assertEq(bond.freeOf(bond.partyOf(operator), address(usdc)), 500_000, "operator credited");
        bytes32 treasuryParty = bond.partyOf(treasury);
        assertEq(bond.freeOf(treasuryParty, address(usdc)), 0, "treasury not credited");
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(IBond.InsufficientFreeBond.selector, treasuryParty, address(usdc), 1, 0)
        );
        bond.withdraw(address(usdc), 1);
    }

    function test_depositsAccumulateAndStayPerAssetAndPerParty() public {
        _deposit(operator, usdc, 100);
        _deposit(operator, usdc, 250);
        _deposit(operator, ausd, 900);
        _deposit(treasury, usdc, 7);
        assertEq(bond.freeOf(bond.partyOf(operator), address(usdc)), 350, "usdc accumulated");
        assertEq(bond.freeOf(bond.partyOf(operator), address(ausd)), 900, "ausd separate");
        assertEq(bond.freeOf(bond.partyOf(treasury), address(usdc)), 7, "party separate");
        assertEq(bond.freeOf(bond.partyOf(stranger), address(usdc)), 0, "stranger has none");
    }

    function test_depositGuards() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(IBond.AssetNotRegistered.selector, address(0)));
        bond.deposit(address(0), 1);
        vm.expectRevert(IBond.ZeroAmount.selector);
        bond.deposit(address(usdc), 0);
        vm.expectRevert(abi.encodeWithSelector(IBond.AssetNotRegistered.selector, address(usdc)));
        bond.depositFor(address(0), address(usdc), 1);
        // No approval: the token refuses, and no ledger entry survives the revert.
        usdc.mint(operator, 10);
        vm.expectRevert();
        bond.deposit(address(usdc), 10);
        vm.stopPrank();
        assertEq(bond.freeOf(bond.partyOf(operator), address(usdc)), 0, "nothing credited");
    }

    // ------------------------------------------------------------------ withdrawals

    function test_withdrawPaysOutAndReducesFreeStake() public {
        _deposit(operator, usdc, 1_000);
        bytes32 party = bond.partyOf(operator);
        vm.expectEmit(true, true, false, true, address(bond));
        emit IBond.BondWithdrawn(party, address(usdc), 400, operator);
        vm.prank(operator);
        uint128 released = bond.withdraw(address(usdc), 400);
        assertEq(released, 400, "released what was asked");
        assertEq(usdc.balanceOf(operator), 400, "paid out");
        assertEq(usdc.balanceOf(address(bond)), 600, "escrow reduced");
        assertEq(bond.freeOf(party, address(usdc)), 600, "free reduced");
        assertEq(bond.ledgerOf(party, address(usdc)).withdrawn, 400, "withdrawn recorded");
        assertEq(bond.ledgerOf(party, address(usdc)).staked, 1_000, "staked is the running total");
    }

    function test_withdrawIsCappedAtFreeStake() public {
        _deposit(operator, usdc, 1_000);
        vm.prank(operator);
        uint128 released = bond.withdraw(address(usdc), 5_000);
        assertEq(released, 1_000, "capped at free");
        assertEq(usdc.balanceOf(operator), 1_000, "everything paid out");
        bytes32 party = bond.partyOf(operator);
        assertEq(bond.freeOf(party, address(usdc)), 0, "nothing left");
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IBond.InsufficientFreeBond.selector, party, address(usdc), 1, 0)
        );
        bond.withdraw(address(usdc), 1);
    }

    function test_withdrawGuardsAndIsolation() public {
        _deposit(operator, usdc, 1_000);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IBond.AssetNotRegistered.selector, address(0)));
        bond.withdraw(address(0), 1);
        vm.prank(operator);
        vm.expectRevert(IBond.ZeroAmount.selector);
        bond.withdraw(address(usdc), 0);
        bytes32 strangerParty = bond.partyOf(stranger);
        bytes32 operatorParty = bond.partyOf(operator);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IBond.InsufficientFreeBond.selector, strangerParty, address(usdc), 1, 0)
        );
        bond.withdraw(address(usdc), 1);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IBond.InsufficientFreeBond.selector, operatorParty, address(ausd), 1, 0)
        );
        bond.withdraw(address(ausd), 1);
        assertEq(usdc.balanceOf(address(bond)), 1_000, "escrow untouched by refused withdrawals");
    }

    // ------------------------------------------------------------------ conservation

    /// @dev Whatever sequence of deposits and withdrawals two parties perform, the escrow's token
    /// balance equals the sum of their free stake, and nobody's free stake ever exceeds what they put in.
    function testFuzz_escrowBalanceEqualsTheSumOfFreeStake(uint64[6] memory moves) public {
        address[2] memory parties = [operator, treasury];
        uint256[2] memory deposited;
        for (uint256 i = 0; i < moves.length; ++i) {
            address who = parties[i % 2];
            uint128 amount = uint128(bound(uint256(moves[i]), 1, 1e12));
            if (i % 3 == 2) {
                uint128 free = bond.freeOf(bond.partyOf(who), address(usdc));
                if (free == 0) continue;
                vm.prank(who);
                bond.withdraw(address(usdc), amount);
            } else {
                _deposit(who, usdc, amount);
                deposited[i % 2] += amount;
            }
        }
        uint256 freeSum;
        for (uint256 p = 0; p < 2; ++p) {
            uint128 free = bond.freeOf(bond.partyOf(parties[p]), address(usdc));
            assertLe(free, deposited[p], "free never exceeds what was put in");
            freeSum += free;
        }
        assertEq(usdc.balanceOf(address(bond)), freeSum, "escrow balance is exactly the free stake");
    }

    // ------------------------------------------------------------------ helpers

    function _mintAndApprove(address who, MockUsdc token, uint128 amount) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(bond), amount);
    }

    function _deposit(address who, MockUsdc token, uint128 amount) internal {
        _mintAndApprove(who, token, amount);
        vm.prank(who);
        bond.deposit(address(token), amount);
    }
}
