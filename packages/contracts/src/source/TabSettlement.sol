// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TabSettlement
/// @notice The Ethereum Sepolia settlement surface. Transfer and event emission only: it holds zero
/// Agent balances and zero tab state, and it knows nothing about tabs, credit, Bonds, or Creditcoin.
/// Its entire job is to move an Asset amount from the paying Agent to a Service Collection Address and
/// leave behind exactly one `TabSettled` log per Settlement that a Creditcoin contract can later verify
/// by proof.
///
/// @dev The two Source Chain surfaces are deliberately asymmetric.
///
///  - **Ethereum Sepolia, chainKey `1`.** This contract is deployed, and a Settlement is a `TabSettled`
///    log emitted by it. The event carries explicit intent — Agent, Service, amount, and tab
///    identifier — so the Creditcoin side reads a Settlement rather than inferring one. (R1.1)
///  - **Ethereum Mainnet, chainKey `3`.** Tab deploys nothing at all. A plain USDC `Transfer` to a
///    registered Collection Address *is* the Settlement, so Agents pay with real USDC through the
///    ordinary token contract and no Tab-authored code sits on Mainnet. (R2.1)
///
/// Nothing in this file imports from `src/` outside `src/source/`, because this contract runs on a
/// different chain from the rest of the system and shares no state with it. The coupling is the event
/// ABI and nothing else.
///
/// **The event signature is a cross-chain ABI contract.** The Creditcoin-side `SettlementVerifier`
/// recognises this log by `keccak256("TabSettled(address,address,uint256,bytes32)")` and resolves the
/// payer from `topics[1]`. The parameter count, order, and types below are therefore fixed, and so is
/// the choice of which parameters are indexed: `agent` must be the first parameter and must be indexed
/// for the payer to land in `topics[1]`. (R1.5, R8.1)
///
/// **The Asset is a parameter, never a constant.** The contract takes no constructor arguments and
/// hardcodes no token address, so the same deployment serves every registered Asset. USDC on Sepolia
/// is `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` with 6 decimals; that address belongs to the
/// registry and the deployment record, not to this code. Every amount here is an integer count of
/// Asset base units — there are no rates and no conversions.
///
/// **Reentrancy.** No guard is used, and the reason is structural rather than optimistic. The contract
/// holds no balances, keeps no storage at all, and reads no state that a callee could observe as stale.
/// Each `_settle` step is a pull-then-log pair over its own calldata, so a token that reenters
/// `settleBatch` mid-transfer can only spend allowance the caller has already granted and can only
/// produce additional well-formed `TabSettled` logs, each of which the Creditcoin side replay-keys
/// independently by `(chainKey, blockHeight, txIndex, logIndex)`. The move happens before the log, so
/// no log can ever describe a transfer that did not settle. There is no invariant across iterations for
/// reentrancy to break.
contract TabSettlement {
    using SafeERC20 for IERC20;

    /// @notice One Settlement: which Asset, which Service Collection Address, how much, and which tab.
    /// @param asset Asset contract address on this chain. Amounts are that Asset's base units.
    /// @param serviceCollection Collection Address the Service registered for this Asset.
    /// @param amount Settlement amount in Asset base units.
    /// @param tabId Tab identifier, recorded for audit. It is surfaced but never gates crediting.
    struct SettlementInstruction {
        address asset;
        address serviceCollection;
        uint256 amount;
        bytes32 tabId;
    }

    /// @notice Emitted once per accepted Settlement. (R1.1, R1.2)
    /// @dev `agent`, `service`, and `tabId` are indexed, so `topics[1]` carries the Agent address,
    /// `topics[2]` the Collection Address, and `topics[3]` the tab identifier, leaving `amount` as the
    /// sole 32-byte data word. Do not reorder the parameters, retype them, or move `amount` into the
    /// topics: the signature hash and the topic layout are both read by the Creditcoin-side verifier.
    /// (R1.5)
    /// @param agent The paying Agent's own Ethereum address — the account the Asset moves out of.
    /// @param service Collection Address the Asset moved to.
    /// @param amount Settlement amount in Asset base units.
    /// @param tabId Tab identifier supplied by the Agent.
    event TabSettled(address indexed agent, address indexed service, uint256 amount, bytes32 indexed tabId);

    /// @notice A Settlement named a zero amount.
    error ZeroAmount();

    /// @notice `settleBatch` was called with no instructions.
    error EmptyBatch();

    /// @notice Settles one charge: pulls the Asset to the Collection Address and logs it.
    /// @param instruction The Settlement to perform.
    function settle(SettlementInstruction calldata instruction) external {
        _settle(instruction);
    }

    /// @notice Settles many charges in one Sepolia transaction, emitting one `TabSettled` per
    /// Settlement. (R1.4)
    /// @dev No upper bound is imposed on the batch length. The block gas limit already bounds it, and a
    /// contract-level cap would only add a second, tighter, and less honest limit. The loop is
    /// all-or-nothing: a single failing transfer reverts the whole transaction, so the emitted logs
    /// always agree with the Asset movements.
    /// @param instructions The Settlements to perform, in order.
    function settleBatch(SettlementInstruction[] calldata instructions) external {
        if (instructions.length == 0) revert EmptyBatch();
        for (uint256 i = 0; i < instructions.length; ++i) {
            _settle(instructions[i]);
        }
    }

    /// @notice Performs one Settlement: pull first, log second.
    /// @dev **`msg.sender` is the payer, which is why `agent` is `msg.sender`.** The Creditcoin side
    /// resolves the payer from `topics[1]` and never from the transaction `from` field, and this is the
    /// contract that has to make `topics[1]` true. Funds are pulled with `safeTransferFrom(msg.sender,
    /// ...)`, so the account whose balance and allowance authorise the move is exactly `msg.sender` —
    /// emitting anything else would put an address in `topics[1]` that did not pay, and the Creditcoin
    /// side would credit the wrong Agent.
    ///
    /// That holds for the cases where `from` and the payer diverge, which is the whole point of
    /// resolving from a topic:
    ///
    ///  - **Relayer or sponsored gas.** The relayer is `tx.origin` and pays gas; the Agent's own
    ///    account is `msg.sender` here and is what the allowance was granted from. `topics[1]` gets the
    ///    Agent, `from` gets the relayer, and the two differ — correctly.
    ///  - **Smart account, multisig, or ERC-4337.** The account contract is `msg.sender` and holds the
    ///    USDC, so `topics[1]` is the smart account, which is the address the Agent binds in the
    ///    `AgentRegistry`. The bundler or an owner key appears as `from` and is ignored.
    ///  - **A contract calling on an Agent's behalf.** Whoever is `msg.sender` is who the Asset is
    ///    pulled from, so `topics[1]` still names the account that actually paid. An intermediary
    ///    cannot cause a Settlement to be credited to a third party without that party's allowance.
    ///
    /// No `agent` parameter is accepted, deliberately. An Agent-supplied payer field would be
    /// caller-controlled data that the Creditcoin side then treats as authenticated, letting anyone
    /// credit their own payment to another identity. Deriving it from `msg.sender` makes `topics[1]`
    /// unforgeable by construction.
    /// @param instruction The Settlement to perform.
    function _settle(SettlementInstruction calldata instruction) private {
        if (instruction.amount == 0) revert ZeroAmount();
        IERC20(instruction.asset)
            .safeTransferFrom(msg.sender, instruction.serviceCollection, instruction.amount);
        emit TabSettled(msg.sender, instruction.serviceCollection, instruction.amount, instruction.tabId);
    }
}
