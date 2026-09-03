// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";

import {CurationMultisig} from "../src/CurationMultisig.sol";

/// @dev A target that records what it was called with, and can be made to revert with a named error.
contract Target {
    error Refused(string why);

    uint256 public calls;
    bytes public lastData;
    bool public shouldRevert;

    function record(uint256 value) external returns (uint256) {
        if (shouldRevert) revert Refused("target said no");
        calls += 1;
        lastData = msg.data;
        return value * 2;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }
}

/// @notice The 2-of-3 multisig that stands in for the curation authority.
/// @dev The interesting assertions are the two sides of the threshold. A multisig that executed at
/// the threshold and refused above it would pass a test that only checked the happy path, and one
/// that executed below it is the failure that matters, so both edges are pinned exactly.
contract CurationMultisigTest is Test {
    CurationMultisig internal multisig;
    Target internal target;

    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA401);
    address internal constant STRANGER = address(0x5152);

    function setUp() public {
        address[] memory owners = new address[](3);
        owners[0] = ALICE;
        owners[1] = BOB;
        owners[2] = CAROL;
        multisig = new CurationMultisig(owners, 2);
        target = new Target();
    }

    function _call(uint256 value) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Target.record.selector, value);
    }

    // ------------------------------------------------------------ construction

    function test_theOwnerSetAndThresholdAreWhatWasConstructed() public view {
        assertEq(multisig.ownerCount(), 3, "three owners");
        assertEq(multisig.THRESHOLD(), 2, "two of them");
        assertTrue(multisig.isOwner(ALICE), "alice owns");
        assertTrue(multisig.isOwner(BOB), "bob owns");
        assertTrue(multisig.isOwner(CAROL), "carol owns");
        assertFalse(multisig.isOwner(STRANGER), "a stranger does not");
    }

    function test_constructionRefusesAThresholdOfZeroOrAboveTheOwnerCount() public {
        address[] memory owners = new address[](2);
        owners[0] = ALICE;
        owners[1] = BOB;

        vm.expectRevert(abi.encodeWithSelector(CurationMultisig.InvalidThreshold.selector, 0, 2));
        new CurationMultisig(owners, 0);

        vm.expectRevert(abi.encodeWithSelector(CurationMultisig.InvalidThreshold.selector, 3, 2));
        new CurationMultisig(owners, 3);
    }

    /// @notice A threshold equal to the owner count is legal, which is the unanimous case.
    function test_aThresholdEqualToTheOwnerCountIsAccepted() public {
        address[] memory owners = new address[](2);
        owners[0] = ALICE;
        owners[1] = BOB;
        CurationMultisig unanimous = new CurationMultisig(owners, 2);
        assertEq(unanimous.THRESHOLD(), 2, "two of two");
    }

    function test_constructionRefusesAZeroAddressOrADuplicate() public {
        address[] memory withZero = new address[](2);
        withZero[0] = ALICE;
        withZero[1] = address(0);
        vm.expectRevert(CurationMultisig.ZeroAddressOwner.selector);
        new CurationMultisig(withZero, 1);

        address[] memory withDuplicate = new address[](2);
        withDuplicate[0] = ALICE;
        withDuplicate[1] = ALICE;
        vm.expectRevert(abi.encodeWithSelector(CurationMultisig.DuplicateOwner.selector, ALICE));
        new CurationMultisig(withDuplicate, 1);
    }

    // --------------------------------------------------------------- threshold

    /// @notice One confirmation short of the threshold does not execute. (the edge that matters)
    function test_oneConfirmationShortOfTheThresholdIsRefused() public {
        vm.prank(ALICE);
        bytes32 id = multisig.propose(address(target), _call(21));

        assertEq(multisig.proposalOf(id).confirmations, 1, "one short of two");
        vm.expectRevert(
            abi.encodeWithSelector(CurationMultisig.ThresholdNotMet.selector, id, uint8(1), uint8(2))
        );
        multisig.execute(id);
        assertEq(target.calls(), 0, "the target was never called");
    }

    /// @notice Exactly the threshold executes, and the target's return value comes back.
    function test_exactlyTheThresholdExecutes() public {
        vm.prank(ALICE);
        bytes32 id = multisig.propose(address(target), _call(21));
        vm.prank(BOB);
        multisig.confirm(id);

        assertEq(multisig.proposalOf(id).confirmations, 2, "at the threshold");
        bytes memory returned = multisig.execute(id);
        assertEq(abi.decode(returned, (uint256)), 42, "the target's own return value");
        assertEq(target.calls(), 1, "called exactly once");
        assertTrue(multisig.proposalOf(id).executed, "terminal");
    }

    // ------------------------------------------------------------ authorisation

    function test_aStrangerCanNeitherProposeNorConfirmNorRevoke() public {
        vm.prank(ALICE);
        bytes32 id = multisig.propose(address(target), _call(1));

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(CurationMultisig.NotAnOwner.selector, STRANGER));
        multisig.propose(address(target), _call(2));

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(CurationMultisig.NotAnOwner.selector, STRANGER));
        multisig.confirm(id);

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(CurationMultisig.NotAnOwner.selector, STRANGER));
        multisig.revoke(id);
    }

    /// @notice Execution is permissionless once the owners have authorised it.
    /// @dev The confirmations are the authorisation. Requiring an owner to press execute would add a
    /// role without adding a check, and would strand a confirmed proposal if that owner went away.
    function test_anyoneMayExecuteAFullyConfirmedProposal() public {
        vm.prank(ALICE);
        bytes32 id = multisig.propose(address(target), _call(5));
        vm.prank(BOB);
        multisig.confirm(id);

        vm.prank(STRANGER);
        multisig.execute(id);
        assertEq(target.calls(), 1, "a stranger may press it, having authorised nothing");
    }

    function test_oneOwnerCannotConfirmTwice() public {
        vm.prank(ALICE);
        bytes32 id = multisig.propose(address(target), _call(1));

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(CurationMultisig.AlreadyConfirmed.selector, id, ALICE));
        multisig.confirm(id);
        assertEq(multisig.proposalOf(id).confirmations, 1, "still one");
    }

    /// @notice Proposing the same call twice is the same proposal, and confirmations accumulate.
    function test_aDuplicateProposalIsTheSameProposal() public {
        vm.prank(ALICE);
        bytes32 first = multisig.propose(address(target), _call(7));
        vm.prank(BOB);
        bytes32 second = multisig.propose(address(target), _call(7));

        assertEq(first, second, "one identifier");
        assertEq(multisig.proposalOf(first).confirmations, 2, "both owners counted");
    }

    // --------------------------------------------------------------- lifecycle

    function test_aRevokedConfirmationDropsBelowTheThresholdAgain() public {
        vm.prank(ALICE);
        bytes32 id = multisig.propose(address(target), _call(3));
        vm.prank(BOB);
        multisig.confirm(id);
        assertEq(multisig.proposalOf(id).confirmations, 2, "at the threshold");

        vm.prank(BOB);
        multisig.revoke(id);
        assertEq(multisig.proposalOf(id).confirmations, 1, "back below it");

        vm.expectRevert(
            abi.encodeWithSelector(CurationMultisig.ThresholdNotMet.selector, id, uint8(1), uint8(2))
        );
        multisig.execute(id);
    }

    function test_executionIsTerminalAndCannotBeRepeated() public {
        vm.prank(ALICE);
        bytes32 id = multisig.propose(address(target), _call(9));
        vm.prank(CAROL);
        multisig.confirm(id);
        multisig.execute(id);

        vm.expectRevert(abi.encodeWithSelector(CurationMultisig.AlreadyExecuted.selector, id));
        multisig.execute(id);

        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(CurationMultisig.AlreadyExecuted.selector, id));
        multisig.confirm(id);

        assertEq(target.calls(), 1, "the target saw one call");
    }

    function test_anUnknownProposalIsRejectedRatherThanTreatedAsEmpty() public {
        bytes32 ghost = keccak256("nothing was proposed under this");
        vm.expectRevert(abi.encodeWithSelector(CurationMultisig.UnknownProposal.selector, ghost));
        multisig.execute(ghost);

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(CurationMultisig.UnknownProposal.selector, ghost));
        multisig.confirm(ghost);
    }

    function test_proposingToTheZeroAddressIsRefused() public {
        vm.prank(ALICE);
        vm.expectRevert(CurationMultisig.EmptyTarget.selector);
        multisig.propose(address(0), _call(1));
    }

    /// @notice A reverting target carries its own reason out, and the proposal stays spent.
    /// @dev Spent rather than retryable is the safe direction: a call that reverted for a reason the
    /// owners did not anticipate should be re-authorised, not re-pressed.
    function test_aRevertingTargetIsReportedWithItsOwnReason() public {
        target.setShouldRevert(true);
        vm.prank(ALICE);
        bytes32 id = multisig.propose(address(target), _call(1));
        vm.prank(BOB);
        multisig.confirm(id);

        vm.expectRevert(
            abi.encodeWithSelector(
                CurationMultisig.CallReverted.selector,
                id,
                abi.encodeWithSelector(Target.Refused.selector, "target said no")
            )
        );
        multisig.execute(id);
    }

    // ------------------------------------------------------------------- funds

    /// @notice It cannot take custody of anything, so a mistake here cannot cost money.
    function test_theMultisigCannotReceiveValue() public {
        vm.deal(ALICE, 1 ether);
        vm.prank(ALICE);
        (bool sent,) = address(multisig).call{value: 1 ether}("");
        assertFalse(sent, "there is no receive and no payable fallback");
        assertEq(address(multisig).balance, 0, "and no balance");
    }
}
