// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
import {IServiceRegistry} from "./ServiceRegistry.sol";
import {ITabBook} from "./TabBook.sol";

/// @title TabSettlement
/// @notice The one way an Open Tab is paid down on Monad.
///
/// An Agent calls `settle` with its own key. The Asset moves from the Agent straight to the Service's
/// registered Collection address, and `TabBook` applies the Settlement, in the same transaction. This
/// contract holds no balances and keeps no state: it is a transfer and a ledger entry welded together
/// so that neither can happen without the other.
///
/// An Agent that would rather not spend gas signs instead. `settleWithPermit2` takes a Permit2
/// signature over the same four facts (Agent, Service, Asset, amount) and lets anyone submit it: a
/// relayer, a gateway, an x402 facilitator. The signature is the authority; the submitter only pays
/// for the block space. The Asset still moves from the Agent to the Collection address and the tab
/// still falls in the same transaction, so a relayed Settlement is indistinguishable in the book from
/// one the Agent sent itself.
///
/// There is no oracle and no off-chain process. If the transfer fails the tab does not fall; if the
/// book refuses the Settlement the transfer does not happen. An overpayment is not lost: `TabBook`
/// banks whatever exceeds the Open Tab as prepaid credit against the same Service.
contract TabSettlement {
    using SafeERC20 for IERC20;

    /// @notice One Settlement in a batch.
    struct Instruction {
        bytes32 serviceId;
        address asset;
        uint128 amount;
    }

    /// @dev What a Permit2 Settlement signature covers, minus the signature itself. Carried in memory
    /// through the gasless path so the Permit2 call fits the stack without the Yul pipeline.
    struct Permit2Settlement {
        address agent;
        bytes32 serviceId;
        address asset;
        uint128 amount;
        uint256 nonce;
        uint256 deadline;
    }

    IServiceRegistry public immutable REGISTRY;
    ITabBook public immutable BOOK;
    /// @notice The canonical Permit2, `0x000000000022D473030F116dDEE9F6B43aC78BA3` on every Monad network.
    ISignatureTransfer public immutable PERMIT2;

    /// @notice The witness struct a Permit2 Settlement signature carries, as an EIP-712 type.
    /// @dev `surface` is this contract and `chainId` the chain it lives on. Both are already bound by
    /// Permit2 (as `spender` and through its domain separator); they are repeated in the witness so a
    /// signed payload names the exact deployment it settles on without a reader having to know that.
    string public constant WITNESS_TYPE =
        "TabSettlement(bytes32 serviceId,address asset,uint128 amount,address surface,uint256 chainId)";

    /// @notice `keccak256(WITNESS_TYPE)`, the first word of every witness hash.
    bytes32 public constant WITNESS_TYPEHASH = keccak256(bytes(WITNESS_TYPE));

    /// @notice What this contract hands Permit2 as `witnessTypeString`.
    /// @dev Permit2 appends it to its stub `PermitWitnessTransferFrom(TokenPermissions permitted,address
    /// spender,uint256 nonce,uint256 deadline,`, so the string opens with the witness field and closes
    /// with the referenced struct types in EIP-712 order (alphabetical: `TabSettlement` before
    /// `TokenPermissions`). The full primary type a signer's wallet sees is therefore:
    ///
    ///   PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,
    ///   TabSettlement witness)TabSettlement(bytes32 serviceId,address asset,uint128 amount,address surface,
    ///   uint256 chainId)TokenPermissions(address token,uint256 amount)
    ///
    /// with `spender` equal to this contract, signed under Permit2's domain (`name` "Permit2", the chain
    /// id, and Permit2's address; no version).
    string public constant WITNESS_TYPE_STRING =
        "TabSettlement witness)TabSettlement(bytes32 serviceId,address asset,uint128 amount,address surface,uint256 chainId)TokenPermissions(address token,uint256 amount)";

    /// @notice Emitted once per Settlement, alongside `TabBook.SettlementApplied`.
    /// @param collection Where the Asset went: the Service's registered Collection address.
    event Settled(
        bytes32 indexed settlementId,
        address indexed agent,
        bytes32 indexed serviceId,
        address asset,
        uint128 amount,
        uint128 applied,
        uint128 toPrepaid,
        address collection
    );

    /// @notice Emitted after `Settled` when the Settlement arrived on a Permit2 signature rather than
    /// from the Agent's own key.
    /// @param relayer Whoever submitted the transaction and paid for it.
    event SettledGasless(bytes32 indexed settlementId, address indexed relayer);

    error ZeroAddressField();
    error EmptyBatch();

    constructor(address registry, address book, address permit2) {
        if (registry == address(0) || book == address(0) || permit2 == address(0)) revert ZeroAddressField();
        REGISTRY = IServiceRegistry(registry);
        BOOK = ITabBook(book);
        PERMIT2 = ISignatureTransfer(permit2);
    }

    /// @notice Pay `amount` of `asset` towards the caller's tab with `serviceId`.
    /// @dev The caller must have approved this contract for at least `amount`.
    function settle(bytes32 serviceId, address asset, uint128 amount)
        external
        returns (bytes32 settlementId, uint128 applied, uint128 toPrepaid)
    {
        address collection;
        (settlementId, applied, toPrepaid, collection) = _apply(msg.sender, serviceId, asset, amount);
        IERC20(asset).safeTransferFrom(msg.sender, collection, amount);
    }

    /// @notice Pay several tabs in one transaction.
    function settleBatch(Instruction[] calldata instructions)
        external
        returns (bytes32[] memory settlementIds)
    {
        uint256 n = instructions.length;
        if (n == 0) revert EmptyBatch();
        settlementIds = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            address collection;
            (settlementIds[i],,, collection) =
                _apply(msg.sender, instructions[i].serviceId, instructions[i].asset, instructions[i].amount);
            IERC20(instructions[i].asset).safeTransferFrom(msg.sender, collection, instructions[i].amount);
        }
    }

    /// @notice Pay `amount` of `asset` towards `agent`'s tab with `serviceId` on the Agent's Permit2
    /// signature. Anyone may submit it; the signature decides everything else.
    /// @dev The Agent must have approved Permit2 for the Asset (once, ever), and signed
    /// `PermitWitnessTransferFrom` with `permitted = {asset, amount}`, `spender` this contract, the
    /// `nonce` and `deadline` given here, and `witness = witnessHash(serviceId, asset, amount)`. Permit2
    /// refuses a used nonce, a passed deadline, and any signature that does not recover to `agent` over
    /// exactly these fields, so a submitter can neither resize, redirect, nor replay a Settlement.
    /// @param nonce A Permit2 unordered nonce of the Agent's choosing, spent by this call.
    /// @param deadline Unix time after which the signature is refused.
    /// @param signature The Agent's EIP-712 signature under Permit2's domain.
    function settleWithPermit2(
        address agent,
        bytes32 serviceId,
        address asset,
        uint128 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (bytes32 settlementId, uint128 applied, uint128 toPrepaid) {
        Permit2Settlement memory signed = Permit2Settlement({
            agent: agent, serviceId: serviceId, asset: asset, amount: amount, nonce: nonce, deadline: deadline
        });
        address collection;
        (settlementId, applied, toPrepaid, collection) = _apply(agent, serviceId, asset, amount);
        emit SettledGasless(settlementId, msg.sender);
        _pullWithPermit2(signed, collection, signature);
    }

    /// @notice The witness a Permit2 Settlement signature must carry for these three facts, bound to
    /// this contract and this chain.
    function witnessHash(bytes32 serviceId, address asset, uint128 amount) public view returns (bytes32) {
        return keccak256(abi.encode(WITNESS_TYPEHASH, serviceId, asset, amount, address(this), block.chainid));
    }

    /// @dev Permit2 verifies `signature` over `signed` plus the witness, spends the nonce, and moves the
    /// Asset from the Agent to the Collection address. Any failure reverts the whole Settlement.
    function _pullWithPermit2(Permit2Settlement memory signed, address collection, bytes calldata signature)
        internal
    {
        PERMIT2.permitWitnessTransferFrom(
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({token: signed.asset, amount: signed.amount}),
                nonce: signed.nonce,
                deadline: signed.deadline
            }),
            ISignatureTransfer.SignatureTransferDetails({to: collection, requestedAmount: signed.amount}),
            signed.agent,
            witnessHash(signed.serviceId, signed.asset, signed.amount),
            WITNESS_TYPE_STRING,
            signature
        );
    }

    /// @dev Effects before interaction: the book is updated here, then the caller moves the Asset. A
    /// transfer that reverts unwinds the ledger entry with it, so the two are atomic in both
    /// directions.
    function _apply(address agent, bytes32 serviceId, address asset, uint128 amount)
        internal
        returns (bytes32 settlementId, uint128 applied, uint128 toPrepaid, address collection)
    {
        collection = REGISTRY.collectionOf(serviceId, asset);
        (settlementId, applied, toPrepaid) = BOOK.applySettlement(agent, serviceId, asset, amount);
        emit Settled(settlementId, agent, serviceId, asset, amount, applied, toPrepaid, collection);
    }
}
