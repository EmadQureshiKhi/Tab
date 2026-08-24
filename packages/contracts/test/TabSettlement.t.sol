// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TabSettlement} from "../src/source/TabSettlement.sol";
import {MockUsdc} from "./mocks/MockUsdc.sol";

/// @title CallingAccount
/// @notice Stands in for a smart account or multisig that holds the Asset and calls the settlement
/// contract itself, so the payer is a contract address rather than an externally owned account.
/// @dev Deliberately holds no logic beyond approving and forwarding, because the only thing under test
/// is which address ends up in `topics[1]` when `msg.sender` is not an EOA.
contract CallingAccount {
    /// @notice Grants the settlement contract an allowance over this account's balance.
    /// @param asset Asset to approve.
    /// @param spender Settlement contract.
    /// @param amount Allowance in base units.
    function approve(address asset, address spender, uint256 amount) external {
        IERC20(asset).approve(spender, amount);
    }

    /// @notice Settles one charge as this account.
    /// @param settlement Settlement contract.
    /// @param instruction The Settlement to perform.
    function settle(TabSettlement settlement, TabSettlement.SettlementInstruction calldata instruction)
        external
    {
        settlement.settle(instruction);
    }
}

/// @title TabSettlementTest
/// @notice Tests for the Ethereum Sepolia settlement surface.
/// @dev Two things are pinned here that a comment cannot pin.
///
///  1. **The cross-chain event ABI.** The Creditcoin-side verifier recognises this log by
///     `keccak256("TabSettled(address,address,uint256,bytes32)")` and reads the payer from `topics[1]`.
///     Both are asserted against raw recorded logs rather than through `vm.expectEmit`, because
///     `expectEmit` would happily pass on a differently indexed event with the same field values and
///     would tell us nothing about the topic layout. `vm.recordLogs` shows the topics themselves.
///  2. **The payer is the account the Asset left, never the gas payer.** Every payer assertion below is
///     driven with `tx.origin` set to a different address, and one case has a contract as `msg.sender`,
///     so a change that emitted `tx.origin` — or accepted an Agent parameter — fails a test.
///
/// Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 8.1, 8.3
contract TabSettlementTest is Test {
    /// @notice Contract under test.
    TabSettlement internal settlement;

    /// @notice 6-decimal Asset double standing in for USDC on Sepolia.
    MockUsdc internal usdc;

    /// @notice A second Asset, so batches spanning Assets are covered.
    MockUsdc internal other;

    /// @notice The paying Agent's own Ethereum address.
    address internal constant AGENT = address(0xA6E7);

    /// @notice Whoever paid gas. Never the payer, and different from `AGENT` in every case below.
    address internal constant RELAYER = address(0x9A5);

    /// @notice A Service Collection Address.
    address internal constant COLLECTION = address(0xC0113C);

    /// @notice A second Service Collection Address.
    address internal constant OTHER_COLLECTION = address(0xC0114C);

    /// @notice The signature hash the Creditcoin-side verifier matches on. Written out in full rather
    /// than derived from the contract, so a change to the event breaks this test.
    bytes32 internal constant TAB_SETTLED_SIG = keccak256("TabSettled(address,address,uint256,bytes32)");

    /// @notice Starting Asset balance of the Agent, in base units.
    uint256 internal constant FUNDING = 1_000_000_000;

    /// @notice Deploys the surface and the Assets, and funds and approves the Agent.
    function setUp() public {
        settlement = new TabSettlement();
        usdc = new MockUsdc();
        other = new MockUsdc();

        usdc.mint(AGENT, FUNDING);
        other.mint(AGENT, FUNDING);
        vm.startPrank(AGENT);
        usdc.approve(address(settlement), type(uint256).max);
        other.approve(address(settlement), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ the cross-chain event ABI

    /// @notice The emitted log's `topics[0]` is the signature hash the Creditcoin side matches on, and
    /// the topic layout is exactly Agent, Service, tabId with `amount` as the sole data word.
    function test_emittedTopicLayoutIsTheCrossChainContract() public {
        bytes32 tabId = keccak256("tab-1");

        vm.recordLogs();
        vm.prank(AGENT, RELAYER);
        settlement.settle(_instruction(address(usdc), COLLECTION, 250_000, tabId));

        Vm.Log memory log = _onlyTabSettled(vm.getRecordedLogs());

        assertEq(log.emitter, address(settlement), "emitter is the settlement contract");
        assertEq(log.topics.length, 4, "one signature topic plus three indexed parameters");
        assertEq(log.topics[0], TAB_SETTLED_SIG, "topics[0] is the TabSettled signature hash");
        assertEq(_addressOf(log.topics[1]), AGENT, "topics[1] carries the Agent");
        assertEq(_addressOf(log.topics[2]), COLLECTION, "topics[2] carries the Collection Address");
        assertEq(log.topics[3], tabId, "topics[3] carries the tab identifier");
        assertEq(log.data.length, 32, "amount is the only unindexed field");
        assertEq(abi.decode(log.data, (uint256)), 250_000, "amount in Asset base units");
    }

    /// @notice The declared event is byte-for-byte the one the verifier expects, checked through the ABI
    /// rather than through an emitted instance.
    /// @dev `TabSettlement.TabSettled.selector` is the compiler's own view of the event signature, so
    /// this fails if a parameter is retyped, reordered, added, or removed — including changes that leave
    /// a single emitted log looking identical.
    function test_declaredEventSignatureMatchesTheVerifierConstant() public pure {
        assertEq(TabSettlement.TabSettled.selector, TAB_SETTLED_SIG, "declared signature hash");
    }

    // ------------------------------------------------------------------ payer resolution

    /// @notice The payer in `topics[1]` is the account the Asset left, not the account that paid gas.
    function test_payerIsTheAssetSourceAndNotTheGasPayer() public {
        vm.recordLogs();
        vm.prank(AGENT, RELAYER);
        settlement.settle(_instruction(address(usdc), COLLECTION, 1, keccak256("tab-gas")));

        Vm.Log memory log = _onlyTabSettled(vm.getRecordedLogs());
        assertEq(_addressOf(log.topics[1]), AGENT, "topics[1] is the Agent");
        assertTrue(_addressOf(log.topics[1]) != RELAYER, "topics[1] is not the gas payer");
        assertEq(usdc.balanceOf(RELAYER), 0, "the gas payer's balance never moved");
    }

    /// @notice A smart account or multisig that holds the Asset appears in `topics[1]` itself.
    function test_payerIsTheSmartAccountWhenAContractSettles() public {
        CallingAccount account = new CallingAccount();
        usdc.mint(address(account), 500_000);
        account.approve(address(usdc), address(settlement), 500_000);

        vm.recordLogs();
        vm.prank(RELAYER, RELAYER);
        account.settle(settlement, _instruction(address(usdc), COLLECTION, 500_000, keccak256("tab-sa")));

        Vm.Log memory log = _onlyTabSettled(vm.getRecordedLogs());
        assertEq(_addressOf(log.topics[1]), address(account), "topics[1] is the smart account");
        assertEq(usdc.balanceOf(address(account)), 0, "the smart account paid");
        assertEq(usdc.balanceOf(COLLECTION), 500_000, "the Collection Address received");
    }

    /// @notice Whatever address ends up in `topics[1]` is the address the Asset was pulled from, for any
    /// caller and any gas payer.
    /// @param caller Fuzzed paying account.
    /// @param origin Fuzzed gas payer.
    /// @param amount Fuzzed Settlement amount in base units.
    function testFuzz_topicOnePayerAlwaysEqualsTheDebitedAccount(
        address caller,
        address origin,
        uint96 amount
    ) public {
        // The payer must be a plain account that is neither a fixture contract nor a precompile, so the
        // fuzzer spends its runs on payer identity rather than on transfers into the test rig itself.
        vm.assume(amount > 0);
        vm.assume(uint160(caller) > 0xffff && caller != COLLECTION && caller.code.length == 0);
        vm.assume(origin != address(0));

        usdc.mint(caller, amount);
        vm.prank(caller);
        usdc.approve(address(settlement), amount);

        uint256 callerBefore = usdc.balanceOf(caller);
        uint256 collectionBefore = usdc.balanceOf(COLLECTION);

        vm.recordLogs();
        vm.prank(caller, origin);
        settlement.settle(_instruction(address(usdc), COLLECTION, amount, keccak256("tab-fuzz")));

        Vm.Log memory log = _onlyTabSettled(vm.getRecordedLogs());
        assertEq(_addressOf(log.topics[1]), caller, "topics[1] is the debited account");
        assertEq(usdc.balanceOf(caller), callerBefore - amount, "payer was debited by the amount");
        assertEq(usdc.balanceOf(COLLECTION), collectionBefore + amount, "collection was credited");
    }

    // ------------------------------------------------------------------ transfer behaviour

    /// @notice One Settlement moves the declared amount to the declared Collection Address and leaves the
    /// settlement contract holding nothing.
    function test_settleMovesTheAmountAndHoldsNoBalance() public {
        vm.prank(AGENT, RELAYER);
        settlement.settle(_instruction(address(usdc), COLLECTION, 400_000, keccak256("tab-move")));

        assertEq(usdc.balanceOf(COLLECTION), 400_000, "collection credited");
        assertEq(usdc.balanceOf(AGENT), FUNDING - 400_000, "agent debited");
        assertEq(usdc.balanceOf(address(settlement)), 0, "settlement contract holds nothing");
    }

    /// @notice Without an allowance the Settlement reverts and nothing moves, because the Agent's own
    /// authorisation is what permits the pull.
    function test_settleRevertsWithoutTheAgentsAuthorisation() public {
        address stranger = address(0x57A11);
        usdc.mint(stranger, 100);

        vm.prank(stranger, RELAYER);
        vm.expectRevert();
        settlement.settle(_instruction(address(usdc), COLLECTION, 100, keccak256("tab-noallow")));

        assertEq(usdc.balanceOf(stranger), 100, "nothing moved");
        assertEq(usdc.balanceOf(COLLECTION), 0, "collection credited nothing");
    }

    /// @notice An Asset address that is not a token contract reverts rather than emitting a log.
    function test_settleRevertsWhenTheAssetIsNotAToken() public {
        vm.prank(AGENT, RELAYER);
        vm.expectRevert();
        settlement.settle(_instruction(address(0xBAD), COLLECTION, 1, keccak256("tab-notoken")));
    }

    // ------------------------------------------------------------------ batches

    /// @notice A batch emits exactly one `TabSettled` per instruction, in order, and the settlement
    /// contract holds a zero balance in every Asset afterwards.
    function test_batchEmitsOneEventPerInstructionAndHoldsNoBalance() public {
        TabSettlement.SettlementInstruction[] memory batch = new TabSettlement.SettlementInstruction[](3);
        batch[0] = _instruction(address(usdc), COLLECTION, 100_000, keccak256("tab-a"));
        batch[1] = _instruction(address(other), OTHER_COLLECTION, 25, keccak256("tab-b"));
        batch[2] = _instruction(address(usdc), OTHER_COLLECTION, 7, keccak256("tab-c"));

        vm.recordLogs();
        vm.prank(AGENT, RELAYER);
        settlement.settleBatch(batch);

        Vm.Log[] memory settled = _tabSettledLogs(vm.getRecordedLogs());
        assertEq(settled.length, batch.length, "one event per instruction");

        for (uint256 i = 0; i < batch.length; ++i) {
            assertEq(settled[i].topics[0], TAB_SETTLED_SIG, "signature hash");
            assertEq(_addressOf(settled[i].topics[1]), AGENT, "topics[1] is the Agent");
            assertEq(_addressOf(settled[i].topics[2]), batch[i].serviceCollection, "collection");
            assertEq(settled[i].topics[3], batch[i].tabId, "tab identifier");
            assertEq(abi.decode(settled[i].data, (uint256)), batch[i].amount, "amount");
        }

        assertEq(usdc.balanceOf(COLLECTION), 100_000, "first collection credited");
        assertEq(other.balanceOf(OTHER_COLLECTION), 25, "second collection credited");
        assertEq(usdc.balanceOf(OTHER_COLLECTION), 7, "third collection credited");
        assertEq(usdc.balanceOf(address(settlement)), 0, "no USDC held after the batch");
        assertEq(other.balanceOf(address(settlement)), 0, "no second Asset held after the batch");
    }

    /// @notice A single-member batch is accepted and behaves as one Settlement.
    function test_singleMemberBatchIsAccepted() public {
        TabSettlement.SettlementInstruction[] memory batch = new TabSettlement.SettlementInstruction[](1);
        batch[0] = _instruction(address(usdc), COLLECTION, 9, keccak256("tab-one"));

        vm.recordLogs();
        vm.prank(AGENT, RELAYER);
        settlement.settleBatch(batch);

        assertEq(_tabSettledLogs(vm.getRecordedLogs()).length, 1, "one event");
        assertEq(usdc.balanceOf(COLLECTION), 9, "collection credited");
    }

    /// @notice A batch is all-or-nothing: one bad member reverts the whole transaction, so the emitted
    /// logs can never disagree with the Asset movements.
    /// @dev Asserted on state rather than on recorded logs. `vm.recordLogs` keeps what a reverted call
    /// emitted before it reverted, which is a property of the harness and not of the chain — a real node
    /// discards the whole receipt. Balances are the honest witness here: the first member's transfer had
    /// already run when the second reverted, and it is the revert that undoes it.
    function test_batchIsAllOrNothing() public {
        TabSettlement.SettlementInstruction[] memory batch = new TabSettlement.SettlementInstruction[](3);
        batch[0] = _instruction(address(usdc), COLLECTION, 10, keccak256("tab-ok"));
        batch[1] = _instruction(address(usdc), COLLECTION, 0, keccak256("tab-zero"));
        batch[2] = _instruction(address(usdc), COLLECTION, 20, keccak256("tab-never"));

        vm.prank(AGENT, RELAYER);
        vm.expectRevert(TabSettlement.ZeroAmount.selector);
        settlement.settleBatch(batch);

        assertEq(usdc.balanceOf(COLLECTION), 0, "nothing moved");
        assertEq(usdc.balanceOf(AGENT), FUNDING, "the Agent kept every base unit");
        assertEq(usdc.balanceOf(address(settlement)), 0, "settlement contract holds nothing");
    }

    // ------------------------------------------------------------------ rejections

    /// @notice A zero amount is rejected on both entrypoints.
    function test_zeroAmountIsRejected() public {
        vm.prank(AGENT, RELAYER);
        vm.expectRevert(TabSettlement.ZeroAmount.selector);
        settlement.settle(_instruction(address(usdc), COLLECTION, 0, keccak256("tab-zero")));

        TabSettlement.SettlementInstruction[] memory batch = new TabSettlement.SettlementInstruction[](1);
        batch[0] = _instruction(address(usdc), COLLECTION, 0, keccak256("tab-zero"));

        vm.prank(AGENT, RELAYER);
        vm.expectRevert(TabSettlement.ZeroAmount.selector);
        settlement.settleBatch(batch);
    }

    /// @notice An empty batch is rejected rather than silently succeeding with no Settlement.
    function test_emptyBatchIsRejected() public {
        TabSettlement.SettlementInstruction[] memory batch = new TabSettlement.SettlementInstruction[](0);

        vm.prank(AGENT, RELAYER);
        vm.expectRevert(TabSettlement.EmptyBatch.selector);
        settlement.settleBatch(batch);
    }

    // ------------------------------------------------------------------ zero state

    /// @notice The contract keeps no tab state: nothing about a Settlement is readable afterwards, and
    /// the same instruction may be submitted twice without the contract objecting.
    /// @dev Replay is the Creditcoin side's business, keyed on `(chainKey, blockHeight, txIndex,
    /// logIndex)`. A guard here would be a second, weaker authority over the same question.
    function test_contractKeepsNoTabState() public {
        TabSettlement.SettlementInstruction memory instruction =
            _instruction(address(usdc), COLLECTION, 5, keccak256("tab-repeat"));

        vm.recordLogs();
        vm.startPrank(AGENT, RELAYER);
        settlement.settle(instruction);
        settlement.settle(instruction);
        vm.stopPrank();

        Vm.Log[] memory settled = _tabSettledLogs(vm.getRecordedLogs());
        assertEq(settled.length, 2, "both Settlements logged");
        assertEq(settled[0].topics[3], settled[1].topics[3], "same tab identifier accepted twice");
        assertEq(usdc.balanceOf(COLLECTION), 10, "both amounts moved");
        assertEq(vm.load(address(settlement), bytes32(0)), bytes32(0), "no storage written");
    }

    // ------------------------------------------------------------------ helpers

    /// @notice Builds one Settlement instruction.
    /// @param asset Asset contract address.
    /// @param collection Service Collection Address.
    /// @param amount Amount in Asset base units.
    /// @param tabId Tab identifier.
    /// @return instruction The assembled instruction.
    function _instruction(address asset, address collection, uint256 amount, bytes32 tabId)
        internal
        pure
        returns (TabSettlement.SettlementInstruction memory instruction)
    {
        instruction = TabSettlement.SettlementInstruction({
            asset: asset, serviceCollection: collection, amount: amount, tabId: tabId
        });
    }

    /// @notice Filters recorded logs down to `TabSettled` logs emitted by the contract under test.
    /// @dev The Asset's own `Transfer` logs are recorded too, so filtering on `topics[0]` is what makes
    /// the per-instruction count meaningful.
    /// @param logs All recorded logs.
    /// @return settled The `TabSettled` logs, in emission order.
    function _tabSettledLogs(Vm.Log[] memory logs) internal view returns (Vm.Log[] memory settled) {
        uint256 count;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (_isTabSettled(logs[i])) ++count;
        }
        settled = new Vm.Log[](count);
        uint256 next;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (_isTabSettled(logs[i])) {
                settled[next] = logs[i];
                ++next;
            }
        }
    }

    /// @notice Asserts exactly one `TabSettled` log was recorded and returns it.
    /// @param logs All recorded logs.
    /// @return log The single `TabSettled` log.
    function _onlyTabSettled(Vm.Log[] memory logs) internal view returns (Vm.Log memory log) {
        Vm.Log[] memory settled = _tabSettledLogs(logs);
        assertEq(settled.length, 1, "exactly one TabSettled log");
        log = settled[0];
    }

    /// @notice Whether a recorded log is a `TabSettled` log from the contract under test.
    /// @param log Recorded log.
    /// @return Whether it matches.
    function _isTabSettled(Vm.Log memory log) internal view returns (bool) {
        return log.emitter == address(settlement) && log.topics.length > 0 && log.topics[0] == TAB_SETTLED_SIG;
    }

    /// @notice Reads an address out of a 32-byte topic the way the Creditcoin side does.
    /// @param topic Topic word.
    /// @return The low 20 bytes as an address.
    function _addressOf(bytes32 topic) internal pure returns (address) {
        return address(uint160(uint256(topic)));
    }
}
