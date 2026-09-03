// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title CurationMultisig
/// @notice An m-of-n owner set that holds the curation role and nothing else.
/// @dev **Scope is the security argument.** `ServiceRegistry.curationAuthority` is a single address,
/// fixed at construction with no setter, and the role it grants is bounded: it can promote a Service
/// into the Curated Tier and queue changes to prices, Collection Addresses, accepted Assets and
/// Settlement Windows, every one of them behind a 48-hour public hold. It cannot move an Agent's
/// funds, cannot touch a tab, and cannot forge a Settlement. A contract standing in for that address
/// therefore needs to do exactly one thing well: require m of n before it makes a call.
///
/// So this holds no value, has no upgrade path, no owner rotation, no pause, and no fallback. There
/// is no `receive` and no `payable` anywhere, so it cannot take custody of anything, and a mistake
/// here cannot cost money it does not have. Every function it can reach on the registry is already
/// visible for 48 hours before it takes effect.
///
/// **The owner set is immutable.** Rotating owners is the feature most likely to be got wrong, and
/// the registry's own authority cannot be reassigned either, so a mutable owner set here would offer
/// a flexibility the thing it controls does not have. Changing the signers means deploying a new
/// multisig and a new registry, which is the same ceremony the role already demands.
///
/// The proposal identifier is the hash of the call, so proposing the same call twice is the same
/// proposal and confirmations accumulate against it rather than splitting across duplicates.
contract CurationMultisig {
    /// @notice A call the owners have proposed.
    struct Proposal {
        /// @dev Contract the call is made against.
        address target;
        /// @dev Calldata, verbatim.
        bytes data;
        /// @dev How many distinct owners have confirmed.
        uint8 confirmations;
        /// @dev True once the call has been made, which is terminal.
        bool executed;
        /// @dev True once proposed, so a zeroed record is distinguishable from a real one.
        bool exists;
    }

    /// @notice An owner proposed a call.
    event Proposed(bytes32 indexed proposalId, address indexed owner, address target, bytes data);
    /// @notice An owner confirmed a proposal.
    event Confirmed(bytes32 indexed proposalId, address indexed owner, uint8 confirmations);
    /// @notice An owner withdrew a confirmation before execution.
    event Revoked(bytes32 indexed proposalId, address indexed owner, uint8 confirmations);
    /// @notice The threshold was met and the call was made.
    event Executed(bytes32 indexed proposalId, address indexed target, bytes returnData);

    error NotAnOwner(address caller);
    error UnknownProposal(bytes32 proposalId);
    error AlreadyConfirmed(bytes32 proposalId, address owner);
    error NotConfirmed(bytes32 proposalId, address owner);
    error AlreadyExecuted(bytes32 proposalId);
    error ThresholdNotMet(bytes32 proposalId, uint8 confirmations, uint8 threshold);
    error CallReverted(bytes32 proposalId, bytes reason);
    error ZeroAddressOwner();
    error DuplicateOwner(address owner);
    error InvalidThreshold(uint8 threshold, uint256 owners);
    error EmptyTarget();

    /// @notice The owner set, fixed at construction.
    address[] private _owners;
    /// @notice Membership, for a constant-time check.
    mapping(address => bool) public isOwner;
    /// @notice Confirmations required before a proposal may execute.
    uint8 public immutable THRESHOLD;

    mapping(bytes32 => Proposal) private _proposals;
    /// @notice Which owners have confirmed which proposal.
    mapping(bytes32 => mapping(address => bool)) public hasConfirmed;

    /// @param owners_ The signer set. At least one, all distinct, none the zero address.
    /// @param threshold_ Confirmations required. At least one, and no more than the owner count.
    constructor(address[] memory owners_, uint8 threshold_) {
        if (threshold_ == 0 || threshold_ > owners_.length) {
            revert InvalidThreshold(threshold_, owners_.length);
        }
        for (uint256 i = 0; i < owners_.length; ++i) {
            address owner = owners_[i];
            if (owner == address(0)) revert ZeroAddressOwner();
            if (isOwner[owner]) revert DuplicateOwner(owner);
            isOwner[owner] = true;
            _owners.push(owner);
        }
        THRESHOLD = threshold_;
    }

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotAnOwner(msg.sender);
        _;
    }

    /// @notice The signer set.
    function owners() external view returns (address[] memory) {
        return _owners;
    }

    /// @notice How many signers there are.
    function ownerCount() external view returns (uint256) {
        return _owners.length;
    }

    /// @notice The identifier a call is proposed under.
    /// @dev The hash of the call itself, so the same call is the same proposal however many owners
    /// submit it, and confirmations accumulate rather than splitting across duplicate records.
    function proposalIdOf(address target, bytes memory data) public pure returns (bytes32) {
        return keccak256(abi.encode(target, data));
    }

    /// @notice The proposal under an identifier, all-zero when there is none.
    function proposalOf(bytes32 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    /// @notice Proposes a call, and counts the proposer as its first confirmation.
    /// @dev Proposing is confirming. An owner who put a call forward and then had to confirm it
    /// separately would be a step that exists only to be forgotten.
    function propose(address target, bytes calldata data) external onlyOwner returns (bytes32) {
        if (target == address(0)) revert EmptyTarget();
        bytes32 proposalId = proposalIdOf(target, data);
        Proposal storage proposal = _proposals[proposalId];

        if (proposal.executed) revert AlreadyExecuted(proposalId);
        if (!proposal.exists) {
            proposal.target = target;
            proposal.data = data;
            proposal.exists = true;
            emit Proposed(proposalId, msg.sender, target, data);
        }
        _confirm(proposalId, proposal);
        return proposalId;
    }

    /// @notice Confirms an existing proposal.
    function confirm(bytes32 proposalId) external onlyOwner {
        Proposal storage proposal = _proposals[proposalId];
        if (!proposal.exists) revert UnknownProposal(proposalId);
        if (proposal.executed) revert AlreadyExecuted(proposalId);
        _confirm(proposalId, proposal);
    }

    /// @notice Withdraws a confirmation, which is only meaningful before execution.
    function revoke(bytes32 proposalId) external onlyOwner {
        Proposal storage proposal = _proposals[proposalId];
        if (!proposal.exists) revert UnknownProposal(proposalId);
        if (proposal.executed) revert AlreadyExecuted(proposalId);
        if (!hasConfirmed[proposalId][msg.sender]) revert NotConfirmed(proposalId, msg.sender);

        hasConfirmed[proposalId][msg.sender] = false;
        proposal.confirmations -= 1;
        emit Revoked(proposalId, msg.sender, proposal.confirmations);
    }

    /// @notice Makes the call, once the threshold is met.
    /// @dev Permissionless on purpose. The authorisation is the confirmations, which are already
    /// recorded; requiring an owner to be the one who presses execute would add a role without
    /// adding a check, and would strand a fully confirmed proposal if that owner went away.
    ///
    /// Marked executed before the call, so a target that re-entered would find a terminal record
    /// rather than a second execution. The registry does not call back, and this does not depend on
    /// that being true.
    function execute(bytes32 proposalId) external returns (bytes memory) {
        Proposal storage proposal = _proposals[proposalId];
        if (!proposal.exists) revert UnknownProposal(proposalId);
        if (proposal.executed) revert AlreadyExecuted(proposalId);
        if (proposal.confirmations < THRESHOLD) {
            revert ThresholdNotMet(proposalId, proposal.confirmations, THRESHOLD);
        }

        proposal.executed = true;

        (bool ok, bytes memory returned) = proposal.target.call(proposal.data);
        // The target's own revert data is carried out rather than replaced, so a refusal from the
        // registry reads as that refusal and not as a failure of this contract.
        if (!ok) revert CallReverted(proposalId, returned);

        emit Executed(proposalId, proposal.target, returned);
        return returned;
    }

    function _confirm(bytes32 proposalId, Proposal storage proposal) private {
        if (hasConfirmed[proposalId][msg.sender]) revert AlreadyConfirmed(proposalId, msg.sender);
        hasConfirmed[proposalId][msg.sender] = true;
        proposal.confirmations += 1;
        emit Confirmed(proposalId, msg.sender, proposal.confirmations);
    }
}
