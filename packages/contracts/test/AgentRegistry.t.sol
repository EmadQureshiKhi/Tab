// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

/// @title AgentRegistryBindingTest
/// @notice Tests for binding nonce issuance, the amount encoding, and nonce reclamation.
/// @dev The encoding is a security primitive, not a formatting choice, so these tests aim at the
/// ways it could be wrong rather than at coverage of the setters:
///
///  1. **The round trip.** A nonce must survive being turned into an amount and read back out. The
///     fuzz case sweeps the whole 9000-value window, because a single value where the recovery
///     disagrees with the encoder is a value where one payment could answer the wrong request.
///  2. **Uniqueness and exhaustion.** No two open requests may share an amount, and the space
///     running out has to be a clean revert rather than a reissued live nonce. Uniqueness is
///     asserted across Agents as well as across addresses, since the pending ledger is keyed on the
///     Agent too and a per-Agent nonce space would break the resolver's constant-time lookup. The
///     exhaustion test fills a real 9000-slot space with real requests instead of reaching into
///     storage, because a mocked count would prove only that the guard reads a variable.
///  3. **No claim on somebody else's address.** A request is open to any caller, so two Agents must
///     be able to hold concurrent requests against one address, each with its own amount. Anything
///     else would let the first caller to name an address hold it against its real controller.
///
/// The 24-hour boundary is asserted at one second before, exactly at, and one second after, since
/// "within 24 hours" and "reaches 24 hours" are adjacent clauses and an off-by-one between them is
/// the whole difference between a valid nonce and an expired one.
///
/// Requirements: 10.1, 10.4, 10.5, 10.6
contract AgentRegistryBindingTest is Test {
    /// @notice The contract under test.
    AgentRegistry internal registry;

    /// @notice An Agent identity, being a plain Creditcoin account.
    address internal agent = address(0xA1);

    /// @notice A second Agent, used where two parties must be told apart.
    address internal otherAgent = address(0xA2);

    /// @notice A third Agent, used where uniqueness is asserted across more than two parties.
    address internal thirdAgent = address(0xA3);

    /// @notice A party with no stake in any binding, used to show the crank needs no authority.
    address internal stranger = address(0xBEEF);

    /// @notice The deployer, and the only account permitted to wire the `SettlementVerifier`.
    address internal wiringAuthority = address(0xC0DE);

    /// @notice A Source Chain address to be proven.
    address internal payer = address(0x1111111111111111111111111111111111111111);

    /// @notice Ethereum Mainnet, as identified on the attested-chain side.
    uint64 internal constant CHAIN_MAINNET = 3;

    /// @notice Ethereum Sepolia, used to show nonce spaces do not interfere across chains.
    uint64 internal constant CHAIN_SEPOLIA = 1;

    /// @notice Mirror of the event under test, so emission can be asserted by value.
    event BindingRequested(
        address indexed agent,
        uint64 chainKey,
        address ethAddress,
        uint16 nonce,
        uint256 requiredAmount,
        uint64 expiresAt
    );

    /// @notice Mirror of the reclamation event under test.
    event BindingExpired(address indexed agent, uint64 chainKey, address ethAddress, uint16 nonce);

    /// @notice Deploys the registry and moves off the zero timestamp.
    /// @dev A non-zero start matters: at `block.timestamp == 0` an unissued record and a record issued
    /// in the same block are indistinguishable by `issuedAt`, which would let a test pass for the
    /// wrong reason.
    function setUp() public {
        registry = new AgentRegistry(wiringAuthority);
        vm.warp(1_700_000_000);
    }

    // ------------------------------------------------------------------ issuance

    /// @notice A request issues a four-digit nonce, the matching amount, and a 24-hour expiry.
    function test_requestBindingIssuesFourDigitNonceAndTwentyFourHourExpiry() public {
        vm.prank(agent);
        (uint16 nonce, uint256 requiredAmount, uint64 expiresAt) =
            registry.requestBinding(CHAIN_MAINNET, payer);

        assertGe(nonce, registry.NONCE_MIN(), "nonce below the four-digit window");
        assertLe(nonce, registry.NONCE_MAX(), "nonce above the four-digit window");
        assertEq(requiredAmount, registry.BINDING_BASE_UNITS() + nonce, "amount does not carry the nonce");
        assertEq(requiredAmount % registry.NONCE_MODULUS(), nonce, "low four digits are not the nonce");
        assertEq(expiresAt, uint64(block.timestamp) + 24 hours, "expiry is not 24 hours out");

        (AgentRegistry.PendingBinding memory pending, uint64 storedExpiry, bool alive) =
            registry.pendingBinding(CHAIN_MAINNET, payer, agent);
        assertEq(pending.agent, agent, "request records the wrong Agent");
        assertEq(pending.requiredAmount, requiredAmount, "record disagrees with the returned amount");
        assertEq(storedExpiry, expiresAt, "record disagrees with the returned expiry");
        assertTrue(alive, "a fresh request is not alive");
        assertEq(registry.openNonceCount(CHAIN_MAINNET), 1, "open count did not move");
    }

    /// @notice The issuance event carries every field a client needs to pay the binding.
    function test_requestBindingEmitsTheInstructionToPay() public {
        uint16 expectedNonce = registry.NONCE_MIN();
        uint256 expectedAmount = registry.requiredAmountForNonce(expectedNonce);
        uint64 expectedExpiry = uint64(block.timestamp) + 24 hours;

        vm.expectEmit(true, false, false, true);
        emit BindingRequested(agent, CHAIN_MAINNET, payer, expectedNonce, expectedAmount, expectedExpiry);
        vm.prank(agent);
        registry.requestBinding(CHAIN_MAINNET, payer);
    }

    /// @notice One Agent cannot hold two live requests against the same address on one chainKey.
    /// @dev Scoped to the caller: the single Settlement this Agent is about to make already proves the
    /// binding, so a second nonce for the same triple would take a slot out of the shared space to
    /// prove nothing further. What is refused here is the caller's own duplicate, never another
    /// Agent's request, which the concurrency test below asserts is admitted.
    function test_requestBindingRevertsWhenTheSameAgentAlreadyHoldsALiveRequest() public {
        vm.prank(agent);
        (uint16 nonce,, uint64 expiresAt) = registry.requestBinding(CHAIN_MAINNET, payer);

        vm.warp(expiresAt - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentRegistry.BindingAlreadyPending.selector, agent, CHAIN_MAINNET, payer, nonce, expiresAt
            )
        );
        vm.prank(agent);
        registry.requestBinding(CHAIN_MAINNET, payer);
        assertEq(registry.openNonceCount(CHAIN_MAINNET), 1, "a refused duplicate took a second nonce");
    }

    /// @notice Two Agents hold concurrent requests against one address, each with its own amount.
    /// @dev **This is the test that says naming an address is not a claim on it.** With one record per
    /// `(chainKey, ethAddress)` pair the second call here would revert and the first caller would hold
    /// the address against everyone else, including its real controller, for a full 24 hours. With the
    /// Agent in the key both requests stand, and because the amount space is shared the two amounts
    /// differ, so neither Settlement can answer the other's request. The crank is then turned on one
    /// record to show it clears that record only.
    function test_twoAgentsHoldConcurrentRequestsAgainstOneAddressWithDistinctAmounts() public {
        vm.prank(agent);
        (uint16 firstNonce, uint256 firstAmount, uint64 firstExpiry) =
            registry.requestBinding(CHAIN_MAINNET, payer);
        vm.prank(otherAgent);
        (uint16 secondNonce, uint256 secondAmount, uint64 secondExpiry) =
            registry.requestBinding(CHAIN_MAINNET, payer);

        assertTrue(firstNonce != secondNonce, "two live requests on one address share a nonce");
        assertTrue(firstAmount != secondAmount, "two live requests on one address share an amount");
        assertEq(firstExpiry, secondExpiry, "requests opened in one block disagree about the window");
        assertEq(registry.openNonceCount(CHAIN_MAINNET), 2, "the second request took no nonce");

        (AgentRegistry.PendingBinding memory first,, bool firstAlive) =
            registry.pendingBinding(CHAIN_MAINNET, payer, agent);
        (AgentRegistry.PendingBinding memory second,, bool secondAlive) =
            registry.pendingBinding(CHAIN_MAINNET, payer, otherAgent);
        assertEq(first.agent, agent, "the first record lost its Agent");
        assertEq(second.agent, otherAgent, "the second record lost its Agent");
        assertEq(first.requiredAmount, firstAmount, "the first record disagrees with its amount");
        assertEq(second.requiredAmount, secondAmount, "the second record disagrees with its amount");
        assertTrue(firstAlive && secondAlive, "concurrent requests are not both alive");

        // Each amount resolves to the one request it belongs to, which is what lets the resolver
        // finalise the right Agent's request from a Settlement carrying only payer, chain and amount.
        (address firstClaimAddress, address firstClaimAgent) =
            registry.pendingBindingByAmount(CHAIN_MAINNET, firstAmount);
        (address secondClaimAddress, address secondClaimAgent) =
            registry.pendingBindingByAmount(CHAIN_MAINNET, secondAmount);
        assertEq(firstClaimAddress, payer, "the first amount resolves to the wrong address");
        assertEq(secondClaimAddress, payer, "the second amount resolves to the wrong address");
        assertEq(firstClaimAgent, agent, "the first amount resolves to the wrong Agent");
        assertEq(secondClaimAgent, otherAgent, "the second amount resolves to the wrong Agent");

        vm.warp(firstExpiry);
        registry.expireBinding(CHAIN_MAINNET, payer, agent);
        (AgentRegistry.PendingBinding memory survivor,,) =
            registry.pendingBinding(CHAIN_MAINNET, payer, otherAgent);
        assertEq(survivor.agent, otherAgent, "reclaiming one record cleared another Agent's record");
        assertEq(survivor.requiredAmount, secondAmount, "the surviving record lost its amount");
        assertEq(registry.openNonceCount(CHAIN_MAINNET), 1, "reclamation freed the wrong count");
    }

    /// @notice A request past the window reclaims the caller's elapsed record and issues a fresh nonce.
    /// @dev This is what stops an Agent's own abandoned attempt from holding a nonce for longer than
    /// the window even when nobody turns the crank.
    function test_requestBindingReclaimsAnElapsedRecordAndIssuesAfresh() public {
        vm.prank(agent);
        (uint16 firstNonce, uint256 firstAmount, uint64 expiresAt) =
            registry.requestBinding(CHAIN_MAINNET, payer);

        vm.warp(expiresAt);
        vm.expectEmit(true, false, false, true);
        emit BindingExpired(agent, CHAIN_MAINNET, payer, firstNonce);
        vm.prank(agent);
        (uint16 secondNonce,,) = registry.requestBinding(CHAIN_MAINNET, payer);

        assertEq(registry.openNonceCount(CHAIN_MAINNET), 1, "the elapsed nonce was not reclaimed");
        (AgentRegistry.PendingBinding memory pending,, bool alive) =
            registry.pendingBinding(CHAIN_MAINNET, payer, agent);
        assertEq(pending.nonce, secondNonce, "record disagrees with the returned nonce");
        assertTrue(alive, "the fresh request is not alive");
        (address claimedAddress,) = registry.pendingBindingByAmount(CHAIN_MAINNET, firstAmount);
        assertEq(claimedAddress, address(0), "the elapsed amount is still claimed");
    }

    /// @notice The zero address cannot be claimed, since no key controls it.
    function test_requestBindingRejectsTheZeroAddress() public {
        vm.expectRevert(AgentRegistry.ZeroEthAddress.selector);
        vm.prank(agent);
        registry.requestBinding(CHAIN_MAINNET, address(0));
    }

    // ------------------------------------------------------------------ amount encoding

    /// @notice A requested amount reads back as the nonce that was issued.
    function test_requiredAmountRecoversTheIssuedNonce() public {
        vm.prank(agent);
        (uint16 nonce, uint256 requiredAmount,) = registry.requestBinding(CHAIN_MAINNET, payer);

        (bool isBindingAmount, uint16 recovered) = registry.nonceFromAmount(requiredAmount);
        assertTrue(isBindingAmount, "the issued amount is not recognised as a binding amount");
        assertEq(recovered, nonce, "recovery returned a different nonce");

        (address claimedAddress, address claimedAgent) =
            registry.pendingBindingByAmount(CHAIN_MAINNET, requiredAmount);
        assertEq(claimedAddress, payer, "reverse index resolves to the wrong address");
        assertEq(claimedAgent, agent, "reverse index resolves to the wrong Agent");
    }

    /// @notice Encoding then recovering returns the nonce unchanged, across the whole window.
    /// @dev Runs come from the `[profile.default.fuzz]` block in `foundry.toml`, currently 256. The
    /// input is bounded into `[NONCE_MIN, NONCE_MAX]` rather than filtered with an assumption, so
    /// every generated value is a live case and the run count is spent on the window instead of on
    /// rejections. Both directions are pure, so this costs nothing to sweep hard.
    /// @param rawNonce Unconstrained draw, bounded into the four-digit window.
    function testFuzz_nonceSurvivesTheAmountRoundTrip(uint16 rawNonce) public view {
        uint16 nonce = uint16(bound(uint256(rawNonce), registry.NONCE_MIN(), registry.NONCE_MAX()));

        uint256 requiredAmount = registry.requiredAmountForNonce(nonce);
        (bool isBindingAmount, uint16 recovered) = registry.nonceFromAmount(requiredAmount);

        assertTrue(isBindingAmount, "an encoded amount is not recognised");
        assertEq(recovered, nonce, "the round trip changed the nonce");
        assertEq(requiredAmount % registry.NONCE_MODULUS(), nonce, "low four digits are not the nonce");
    }

    /// @notice Every amount outside the window is refused, so no ordinary payment decodes to a nonce.
    /// @dev The rejected region is all but 9000 of `2^256` values, so the generator needs no help to
    /// stay inside it and the assumption below rejects nothing in practice.
    /// @param amount Any Settlement amount in Asset base units.
    function testFuzz_amountsOutsideTheWindowCarryNoNonce(uint256 amount) public view {
        uint256 low = registry.BINDING_BASE_UNITS() + registry.NONCE_MIN();
        uint256 high = registry.BINDING_BASE_UNITS() + registry.NONCE_MAX();
        vm.assume(amount < low || amount > high);

        (bool isBindingAmount, uint16 nonce) = registry.nonceFromAmount(amount);
        assertFalse(isBindingAmount, "an amount outside the window decoded as a binding amount");
        assertEq(nonce, 0, "a refused amount returned a nonce");
    }

    /// @notice The encoder refuses nonces on either side of the four-digit window.
    function test_requiredAmountForNonceRefusesNoncesOutsideTheWindow() public {
        uint16 belowWindow = registry.NONCE_MIN() - 1;
        uint16 aboveWindow = registry.NONCE_MAX() + 1;

        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NonceOutOfRange.selector, belowWindow));
        registry.requiredAmountForNonce(belowWindow);

        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NonceOutOfRange.selector, aboveWindow));
        registry.requiredAmountForNonce(aboveWindow);
    }

    // ------------------------------------------------------------------ collision safety

    /// @notice Concurrent requests on one chainKey never share a required amount, across Agents too.
    /// @dev Uniqueness is what stops one payment from proving two bindings, so it is asserted over a
    /// batch of live requests rather than argued from the allocator's shape. The batch is deliberately
    /// four Agents against sixteen addresses rather than sixty-four addresses: the ledger is keyed per
    /// Agent, so a per-Agent nonce space would still pass an addresses-only sweep while handing two
    /// Agents the same amount on the same chainKey and leaving one payment able to answer either.
    function test_concurrentRequestsNeverShareARequiredAmount() public {
        address[4] memory agents = [agent, otherAgent, thirdAgent, stranger];
        uint256 addresses = 16;
        uint256 batch = addresses * agents.length;
        uint256[] memory amounts = new uint256[](batch);

        for (uint256 i = 0; i < batch; ++i) {
            address candidate = address(uint160(0x2000 + (i / agents.length)));
            address requester = agents[i % agents.length];
            vm.prank(requester);
            (, uint256 requiredAmount,) = registry.requestBinding(CHAIN_MAINNET, candidate);
            amounts[i] = requiredAmount;

            (address claimedAddress, address claimedAgent) =
                registry.pendingBindingByAmount(CHAIN_MAINNET, requiredAmount);
            assertEq(claimedAddress, candidate, "an amount resolves to the wrong address");
            assertEq(claimedAgent, requester, "an amount resolves to the wrong Agent");
        }

        for (uint256 i = 0; i < batch; ++i) {
            for (uint256 j = i + 1; j < batch; ++j) {
                assertTrue(amounts[i] != amounts[j], "two open requests share a required amount");
            }
        }
        assertEq(registry.openNonceCount(CHAIN_MAINNET), batch, "open count disagrees with the batch");
    }

    /// @notice Nonce spaces are per chainKey, so one chain's traffic cannot starve another's.
    function test_nonceSpacesAreIndependentPerChainKey() public {
        vm.prank(agent);
        (uint16 mainnetNonce, uint256 mainnetAmount,) = registry.requestBinding(CHAIN_MAINNET, payer);
        vm.prank(agent);
        (uint16 sepoliaNonce, uint256 sepoliaAmount,) = registry.requestBinding(CHAIN_SEPOLIA, payer);

        assertEq(sepoliaNonce, mainnetNonce, "the two spaces are not independent");
        assertEq(sepoliaAmount, mainnetAmount, "the two spaces are not independent");
        assertEq(registry.openNonceCount(CHAIN_MAINNET), 1, "mainnet count");
        assertEq(registry.openNonceCount(CHAIN_SEPOLIA), 1, "sepolia count");
    }

    /// @notice Filling a real 9000-slot space reverts, and freeing one slot admits exactly one more.
    /// @dev Nothing is mocked: 9000 requests from 9000 distinct addresses take the whole window, the
    /// 9001st is refused, and one reclamation makes room for exactly one further request. Gas
    /// metering is paused because the point is the allocator's behaviour at the boundary, not the
    /// cost of filling a space that would take 9000 real transactions to fill.
    function test_exhaustingTheNonceSpaceRevertsAndOneReclamationAdmitsOneRequest() public {
        vm.pauseGasMetering();
        uint256 space = registry.NONCE_SPACE();

        for (uint256 i = 0; i < space; ++i) {
            vm.prank(agent);
            registry.requestBinding(CHAIN_MAINNET, address(uint160(0x100000 + i)));
        }
        assertEq(registry.openNonceCount(CHAIN_MAINNET), space, "the space did not fill");

        address overflowAddress = address(uint160(0x100000 + space));
        vm.expectRevert(AgentRegistry.NonceSpaceExhausted.selector);
        vm.prank(agent);
        registry.requestBinding(CHAIN_MAINNET, overflowAddress);

        // The space is shared, so a second Agent finds it just as full. Exhaustion is a property of
        // the chainKey rather than of the caller.
        vm.expectRevert(AgentRegistry.NonceSpaceExhausted.selector);
        vm.prank(otherAgent);
        registry.requestBinding(CHAIN_MAINNET, overflowAddress);

        // A neighbouring chainKey still has its whole space, which is the other half of the claim
        // that exhaustion is scoped rather than global.
        vm.prank(agent);
        registry.requestBinding(CHAIN_SEPOLIA, overflowAddress);

        address firstHolder = address(uint160(0x100000));
        vm.warp(block.timestamp + 24 hours);
        registry.expireBinding(CHAIN_MAINNET, firstHolder, agent);
        assertEq(registry.openNonceCount(CHAIN_MAINNET), space - 1, "reclamation freed the wrong count");

        vm.prank(agent);
        (, uint256 requiredAmount,) = registry.requestBinding(CHAIN_MAINNET, overflowAddress);
        assertEq(requiredAmount, registry.requiredAmountForNonce(registry.NONCE_MIN()), "wrong slot reused");

        vm.expectRevert(AgentRegistry.NonceSpaceExhausted.selector);
        vm.prank(agent);
        registry.requestBinding(CHAIN_MAINNET, address(uint160(0x100000 + space + 1)));
        vm.resumeGasMetering();
    }

    // ------------------------------------------------------------------ the 24-hour boundary

    /// @notice One second before the window closes the nonce is still valid and cannot be reclaimed.
    function test_expireBindingRevertsOneSecondBeforeTheWindowCloses() public {
        vm.prank(agent);
        (,, uint64 expiresAt) = registry.requestBinding(CHAIN_MAINNET, payer);
        uint64 issuedAt = expiresAt - 24 hours;

        vm.warp(expiresAt - 1);
        (,, bool alive) = registry.pendingBinding(CHAIN_MAINNET, payer, agent);
        assertTrue(alive, "the nonce is not valid one second before the window closes");

        vm.expectRevert(
            abi.encodeWithSelector(
                AgentRegistry.BindingWindowActive.selector, issuedAt, expiresAt, expiresAt - 1
            )
        );
        registry.expireBinding(CHAIN_MAINNET, payer, agent);
        assertEq(registry.openNonceCount(CHAIN_MAINNET), 1, "a refused reclamation moved the count");
    }

    /// @notice At exactly 24 hours, and one second later, the nonce is expired and reclaimable.
    /// @dev Both sides of the boundary are asserted from independent requests, because "within 24
    /// hours" and "reaches 24 hours" are adjacent clauses and only one of them can own the instant.
    function test_expireBindingSucceedsAtTheBoundaryAndOneSecondAfter() public {
        vm.prank(agent);
        (,, uint64 expiresAt) = registry.requestBinding(CHAIN_MAINNET, payer);

        vm.warp(expiresAt);
        (,, bool alive) = registry.pendingBinding(CHAIN_MAINNET, payer, agent);
        assertFalse(alive, "the nonce is still valid at exactly 24 hours");
        registry.expireBinding(CHAIN_MAINNET, payer, agent);
        assertEq(registry.openNonceCount(CHAIN_MAINNET), 0, "the nonce was not reclaimed at the boundary");

        address second = address(uint160(0x3333));
        vm.prank(agent);
        (uint16 secondNonce,, uint64 secondExpiry) = registry.requestBinding(CHAIN_MAINNET, second);
        vm.warp(secondExpiry + 1);
        vm.expectEmit(true, false, false, true);
        emit BindingExpired(agent, CHAIN_MAINNET, second, secondNonce);
        registry.expireBinding(CHAIN_MAINNET, second, agent);
        assertEq(registry.openNonceCount(CHAIN_MAINNET), 0, "the nonce was not reclaimed after the window");
    }

    /// @notice Reclamation needs no authority, and clears the record and the amount claim together.
    /// @dev Permissionless on purpose: a crank only the requester could turn would let an abandoned
    /// request hold a slot in a shared 9000-value space until that requester chose to return.
    function test_expireBindingIsPermissionlessAndClearsEverySlotItHeld() public {
        vm.prank(agent);
        (, uint256 requiredAmount, uint64 expiresAt) = registry.requestBinding(CHAIN_MAINNET, payer);

        vm.warp(expiresAt);
        vm.prank(stranger);
        registry.expireBinding(CHAIN_MAINNET, payer, agent);

        (AgentRegistry.PendingBinding memory pending, uint64 storedExpiry, bool alive) =
            registry.pendingBinding(CHAIN_MAINNET, payer, agent);
        assertEq(pending.agent, address(0), "the record survived reclamation");
        assertFalse(pending.open, "the record is still open");
        assertEq(storedExpiry, 0, "a cleared record still reports an expiry");
        assertFalse(alive, "a cleared record is still alive");

        (address claimedAddress, address claimedAgent) =
            registry.pendingBindingByAmount(CHAIN_MAINNET, requiredAmount);
        assertEq(claimedAddress, address(0), "the amount claim survived reclamation");
        assertEq(claimedAgent, address(0), "the amount claim still names an Agent");
        assertEq(registry.openNonceCount(CHAIN_MAINNET), 0, "open count");
    }

    /// @notice The crank refuses a triple that holds nothing, rather than reporting a silent success.
    /// @dev Asserted for an unused triple and for the right address under the wrong Agent, because
    /// the Agent is part of the key and naming the wrong one must not clear somebody's live record.
    function test_expireBindingRevertsWhenNothingIsHeld() public {
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.NoOpenBinding.selector, CHAIN_MAINNET, payer, agent)
        );
        registry.expireBinding(CHAIN_MAINNET, payer, agent);

        vm.prank(agent);
        (,, uint64 expiresAt) = registry.requestBinding(CHAIN_MAINNET, payer);
        vm.warp(expiresAt);
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.NoOpenBinding.selector, CHAIN_MAINNET, payer, otherAgent)
        );
        registry.expireBinding(CHAIN_MAINNET, payer, otherAgent);
        assertEq(registry.openNonceCount(CHAIN_MAINNET), 1, "a refused reclamation moved the count");
    }
}

/// @title AgentRegistryProvenBindingTest
/// @notice Tests for the confirmed half of the lifecycle: resolving a payer to an Agent, finalising a
/// request the settled amount matches, and the two ceilings that bound the result.
/// @dev What these aim at, in the order the risks matter:
///
///  1. **The amount decides, and nothing else does.** A Settlement carries a payer, a chainKey, and an
///     amount, so the amount is the only thing that can single out one of several live requests against
///     one address. The squatting test is the sharp version: two Agents race for one address and the
///     payment binds whichever of them the digits name, never the one who asked first.
///  2. **Unbound is a value, not a fault.** The resolver returns the zero address for a payer it
///     cannot place, because the verifier is the component that names that condition. A revert here
///     would make an ordinary unbound payment indistinguishable from a broken one.
///  3. **The ceilings hold from both ends.** One Agent per address per chainKey, and eight addresses
///     per Agent per chainKey, asserted at the ninth attempt rather than argued from the constant.
///  4. **Only the wired verifier may bind.** A binding minted by anybody else is an identity claim
///     with no payment behind it, so the caller gate and the one-shot wiring are tested as carefully
///     as the arithmetic.
///
/// Requirements: 10.2, 10.3, 10.7, 10.8, 8.4
contract AgentRegistryProvenBindingTest is Test {
    /// @notice The contract under test.
    AgentRegistry internal registry;

    /// @notice An Agent identity, being a plain Creditcoin account.
    address internal agent = address(0xA1);

    /// @notice A second Agent, used wherever two parties must be told apart.
    address internal otherAgent = address(0xA2);

    /// @notice The deployer, and the only account permitted to wire the `SettlementVerifier`.
    address internal wiringAuthority = address(0xC0DE);

    /// @notice Stands in for the `SettlementVerifier`, which task 10 builds.
    /// @dev A plain address rather than a mock contract, because the only thing this contract knows
    /// about the verifier is that `msg.sender` equals it. A mock would add a hop and prove nothing
    /// further; the real one is deployed after this registry and wired in afterwards, which is exactly
    /// what happens here.
    address internal verifier = address(0x5E77);

    /// @notice A party with no authority anywhere, used to show every gate refuses it.
    address internal stranger = address(0xBEEF);

    /// @notice A Source Chain address to be proven.
    address internal payer = address(0x1111111111111111111111111111111111111111);

    /// @notice Ethereum Mainnet, as identified on the attested-chain side.
    uint64 internal constant CHAIN_MAINNET = 3;

    /// @notice Ethereum Sepolia, used to show bindings do not carry across chains.
    uint64 internal constant CHAIN_SEPOLIA = 1;

    /// @notice A replay key standing in for a proven Settlement's `(chainKey, height, txIndex, logIndex)`.
    bytes32 internal constant PROVING_KEY = keccak256("settlement-that-proved-it");

    /// @notice Mirror of the event under test, so emission can be asserted by value.
    event AddressBound(
        address indexed agent, uint64 chainKey, address indexed ethAddress, bytes32 provingReplayKey
    );

    /// @notice Mirror of the wiring event under test.
    event SettlementVerifierWired(address indexed verifier);

    /// @notice Deploys the registry, wires the verifier, and moves off the zero timestamp.
    function setUp() public {
        registry = new AgentRegistry(wiringAuthority);
        vm.prank(wiringAuthority);
        registry.setSettlementVerifier(verifier);
        vm.warp(1_700_000_000);
    }

    // ------------------------------------------------------------------ helpers

    /// @notice Opens a request and settles its exact amount, which is one whole binding.
    /// @param chainKey Attested-chain identifier to bind on.
    /// @param ethAddress Source Chain address to bind.
    /// @param who Agent to bind it to.
    /// @param replayKey Replay key of the proving Settlement.
    /// @return requiredAmount The amount that proved the binding.
    function _bind(uint64 chainKey, address ethAddress, address who, bytes32 replayKey)
        internal
        returns (uint256 requiredAmount)
    {
        vm.prank(who);
        (, requiredAmount,) = registry.requestBinding(chainKey, ethAddress);
        vm.prank(verifier);
        address bound = registry.resolveOrBind(chainKey, ethAddress, requiredAmount, replayKey);
        assertEq(bound, who, "the binding resolved to the wrong Agent");
    }

    // ------------------------------------------------------------------ finalisation

    /// @notice A Settlement of the exact required amount binds the address and records its proof.
    /// @dev The whole claim of proof-by-payment lands in one call, so it is asserted end to end: the
    /// returned Agent, the event a stranger would read, the stored record including the replay key that
    /// points back at the Settlement, both directions of the lookup, and the nonce returning to the
    /// shared space because the request it was holding is now satisfied. (R10.2, R10.7)
    function test_resolveOrBindFinalisesTheBindingWhenPayerAndAmountMatch() public {
        vm.prank(agent);
        (, uint256 requiredAmount,) = registry.requestBinding(CHAIN_MAINNET, payer);

        vm.expectEmit(true, true, false, true);
        emit AddressBound(agent, CHAIN_MAINNET, payer, PROVING_KEY);
        vm.prank(verifier);
        address bound = registry.resolveOrBind(CHAIN_MAINNET, payer, requiredAmount, PROVING_KEY);

        assertEq(bound, agent, "the matching Settlement did not return the requesting Agent");
        assertEq(registry.agentOf(CHAIN_MAINNET, payer), agent, "the address is not bound");

        AgentRegistry.Binding memory binding = registry.bindingOf(CHAIN_MAINNET, payer);
        assertEq(binding.agent, agent, "the record names the wrong Agent");
        assertEq(binding.chainKey, CHAIN_MAINNET, "the record names the wrong chainKey");
        assertEq(binding.boundAt, uint64(block.timestamp), "the record has the wrong timestamp");
        assertEq(binding.provingReplayKey, PROVING_KEY, "the record lost the proving replay key");

        address[] memory owned = registry.boundAddresses(agent, CHAIN_MAINNET);
        assertEq(owned.length, 1, "the reverse index did not gain the address");
        assertEq(owned[0], payer, "the reverse index holds the wrong address");

        (AgentRegistry.PendingBinding memory pending,, bool alive) =
            registry.pendingBinding(CHAIN_MAINNET, payer, agent);
        assertFalse(pending.open, "the satisfied request is still open");
        assertFalse(alive, "the satisfied request is still alive");
        assertEq(registry.openNonceCount(CHAIN_MAINNET), 0, "the satisfied nonce was not released");
        (address claimedAddress,) = registry.pendingBindingByAmount(CHAIN_MAINNET, requiredAmount);
        assertEq(claimedAddress, address(0), "the satisfied amount is still claimed");
    }

    /// @notice An amount that matches no request binds nothing and leaves the request pending.
    /// @dev Three near misses and one far one: one base unit either side of the required amount, an
    /// amount outside the encoding window entirely, and the amount charged to a different address. All
    /// four return the zero address, which the verifier turns into `UnboundPayer`, and none of them
    /// touches the open request — the Agent can still settle the right amount afterwards, which the
    /// final lines prove by doing it. (R8.4)
    function test_resolveOrBindLeavesTheRequestPendingWhenTheAmountDoesNotMatch() public {
        vm.prank(agent);
        (, uint256 requiredAmount,) = registry.requestBinding(CHAIN_MAINNET, payer);

        uint256[4] memory misses =
            [requiredAmount - 1, requiredAmount + 1, 25_000_000, registry.BINDING_BASE_UNITS()];
        for (uint256 i = 0; i < misses.length; ++i) {
            vm.prank(verifier);
            assertEq(
                registry.resolveOrBind(CHAIN_MAINNET, payer, misses[i], PROVING_KEY),
                address(0),
                "a non-matching amount resolved to an Agent"
            );
        }

        assertEq(registry.agentOf(CHAIN_MAINNET, payer), address(0), "a non-matching amount bound");
        (AgentRegistry.PendingBinding memory pending,, bool alive) =
            registry.pendingBinding(CHAIN_MAINNET, payer, agent);
        assertTrue(pending.open, "the request was closed by a non-matching amount");
        assertTrue(alive, "the request stopped being alive");
        assertEq(pending.requiredAmount, requiredAmount, "the request lost its amount");
        assertEq(registry.openNonceCount(CHAIN_MAINNET), 1, "the nonce was released by a near miss");

        // The request survived intact, so the right amount still binds.
        vm.prank(verifier);
        assertEq(
            registry.resolveOrBind(CHAIN_MAINNET, payer, requiredAmount, PROVING_KEY),
            agent,
            "the surviving request could not be finalised"
        );
    }

    /// @notice A bound payer resolves to its Agent for any amount, with no pending request in play.
    /// @dev This is the ordinary case for the rest of the system's life: every later Settlement from a
    /// bound address is a tab payment, not a binding attempt, so it must resolve on the confirmed
    /// record alone and must not bind anything a second time.
    function test_resolveOrBindReturnsTheBoundAgentWithoutAPendingRequest() public {
        _bind(CHAIN_MAINNET, payer, agent, PROVING_KEY);

        uint256[3] memory ordinaryAmounts = [uint256(1), 25_000_000, type(uint256).max];
        for (uint256 i = 0; i < ordinaryAmounts.length; ++i) {
            vm.prank(verifier);
            assertEq(
                registry.resolveOrBind(CHAIN_MAINNET, payer, ordinaryAmounts[i], keccak256("later")),
                agent,
                "a bound payer did not resolve to its Agent"
            );
        }

        AgentRegistry.Binding memory binding = registry.bindingOf(CHAIN_MAINNET, payer);
        assertEq(binding.provingReplayKey, PROVING_KEY, "a later Settlement overwrote the proving key");
        assertEq(registry.boundAddresses(agent, CHAIN_MAINNET).length, 1, "the address was bound twice");
    }

    /// @notice An unbound payer resolves to the zero address, which the verifier reads as unbound.
    /// @dev Returning rather than reverting is what lets the verifier own the `UnboundPayer` error,
    /// and it is asserted for the zero payer too, since an unclaimed amount also reads as zero inside
    /// the resolver and the two must not be confused. (R8.4)
    function test_resolveOrBindReturnsTheZeroAddressForAnUnboundPayer() public {
        vm.prank(verifier);
        assertEq(
            registry.resolveOrBind(CHAIN_MAINNET, payer, 25_000_000, PROVING_KEY),
            address(0),
            "an unbound payer resolved to an Agent"
        );

        vm.prank(verifier);
        assertEq(
            registry.resolveOrBind(CHAIN_MAINNET, address(0), 0, PROVING_KEY),
            address(0),
            "the zero payer resolved to an Agent"
        );
        assertEq(registry.openNonceCount(CHAIN_MAINNET), 0, "a resolution with no request took a nonce");
    }

    /// @notice A request whose window closed cannot be finalised, however exact the amount.
    /// @dev The nonce is void the moment the window closes, and it is still holding its amount claim
    /// until somebody turns the crank, so the resolver has to refuse it rather than honour it. The
    /// error names the window so the Watcher knows to ask for a fresh nonce. (R10.6)
    function test_resolveOrBindRefusesARequestWhoseWindowClosed() public {
        vm.prank(agent);
        (, uint256 requiredAmount, uint64 expiresAt) = registry.requestBinding(CHAIN_MAINNET, payer);
        uint64 issuedAt = expiresAt - 24 hours;

        vm.warp(expiresAt);
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.BindingWindowElapsed.selector, issuedAt, expiresAt)
        );
        vm.prank(verifier);
        registry.resolveOrBind(CHAIN_MAINNET, payer, requiredAmount, PROVING_KEY);
        assertEq(registry.agentOf(CHAIN_MAINNET, payer), address(0), "an elapsed request bound anyway");

        // One second before the boundary the same call binds, so the refusal above is the window and
        // not the resolver refusing every request.
        vm.warp(expiresAt - 1);
        vm.prank(verifier);
        assertEq(
            registry.resolveOrBind(CHAIN_MAINNET, payer, requiredAmount, PROVING_KEY),
            agent,
            "a request one second inside its window was refused"
        );
    }

    // ------------------------------------------------------------------ squatting

    /// @notice Two Agents race one address, and the settled amount decides which of them binds.
    /// @dev **This is the test the three-part pending key exists for.** A squatter opens a request
    /// against an address it does not control; the genuine controller opens its own in the next block
    /// and is issued a different amount. The controller then pays its own amount, and the address binds
    /// to the controller — asking first bought the squatter nothing. The mirror is asserted in the same
    /// run: once the address is bound, the squatter's amount resolves to the controller too, because a
    /// confirmed binding answers before any pending request does, so the squatter's record can never be
    /// finalised and only ever returns its nonce to the space. (R10.2, R10.3)
    function test_theSettlementAmountDecidesWhichRacingAgentBinds() public {
        vm.prank(stranger);
        (, uint256 squatterAmount,) = registry.requestBinding(CHAIN_MAINNET, payer);
        vm.prank(agent);
        (, uint256 controllerAmount,) = registry.requestBinding(CHAIN_MAINNET, payer);
        assertTrue(squatterAmount != controllerAmount, "the racing requests share an amount");

        vm.expectEmit(true, true, false, true);
        emit AddressBound(agent, CHAIN_MAINNET, payer, PROVING_KEY);
        vm.prank(verifier);
        address bound = registry.resolveOrBind(CHAIN_MAINNET, payer, controllerAmount, PROVING_KEY);

        assertEq(bound, agent, "the address bound to the wrong Agent");
        assertEq(registry.agentOf(CHAIN_MAINNET, payer), agent, "the squatter took the address");
        assertEq(registry.boundAddresses(stranger, CHAIN_MAINNET).length, 0, "the squatter bound anything");

        // The squatter's own amount now resolves to the Agent that bound, and binds nothing further.
        vm.prank(verifier);
        assertEq(
            registry.resolveOrBind(CHAIN_MAINNET, payer, squatterAmount, keccak256("squatter-payment")),
            agent,
            "the squatter's amount finalised its request after the binding"
        );
        assertEq(registry.agentOf(CHAIN_MAINNET, payer), agent, "the binding changed hands");
        AgentRegistry.Binding memory binding = registry.bindingOf(CHAIN_MAINNET, payer);
        assertEq(binding.provingReplayKey, PROVING_KEY, "the squatter's payment rewrote the proof");

        // The squatter's record is still open, holding one nonce until it is cranked, and that is all
        // the squatting attempt ever achieved.
        (AgentRegistry.PendingBinding memory squatterRecord,, bool alive) =
            registry.pendingBinding(CHAIN_MAINNET, payer, stranger);
        assertTrue(squatterRecord.open && alive, "the squatter's record is not merely left pending");
        assertEq(registry.openNonceCount(CHAIN_MAINNET), 1, "the wrong number of nonces remains held");
    }

    /// @notice Once an address is bound, no Agent may open a request against it. (R10.3)
    /// @dev Asserted for a second Agent and for the bound Agent itself. There is one record per
    /// `(chainKey, ethAddress)` pair, so the second Agent has nowhere to be written and the first has
    /// nothing further to prove; issuing a nonce for either would spend a slot on a request that could
    /// never be finalised.
    function test_requestBindingRefusesAnAddressThatIsAlreadyBound() public {
        _bind(CHAIN_MAINNET, payer, agent, PROVING_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.AddressAlreadyBound.selector, CHAIN_MAINNET, payer, agent)
        );
        vm.prank(otherAgent);
        registry.requestBinding(CHAIN_MAINNET, payer);

        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.AddressAlreadyBound.selector, CHAIN_MAINNET, payer, agent)
        );
        vm.prank(agent);
        registry.requestBinding(CHAIN_MAINNET, payer);

        assertEq(registry.openNonceCount(CHAIN_MAINNET), 0, "a refused request took a nonce");
    }

    // ------------------------------------------------------------------ the eight-address ceiling

    /// @notice The ninth address an Agent tries to bind on one chainKey is refused. (R10.8)
    /// @dev All nine requests are opened before any of them is settled, which is the only way to reach
    /// the resolver's own ceiling check: the request-time check would otherwise refuse the ninth
    /// request before a Settlement for it could exist. The refused request stays open and unbound, the
    /// ceiling is shown to be per Agent by having a second Agent bind the very same ninth address, and
    /// the request-time check is asserted afterwards on an Agent that is already full.
    function test_resolveOrBindRefusesTheNinthAddressOnOneChainKey() public {
        uint256 ceiling = registry.MAX_ADDRESSES_PER_CHAIN();
        uint256[] memory amounts = new uint256[](ceiling + 1);
        for (uint256 i = 0; i <= ceiling; ++i) {
            vm.prank(agent);
            (, amounts[i],) = registry.requestBinding(CHAIN_MAINNET, address(uint160(0x5000 + i)));
        }

        for (uint256 i = 0; i < ceiling; ++i) {
            vm.prank(verifier);
            registry.resolveOrBind(CHAIN_MAINNET, address(uint160(0x5000 + i)), amounts[i], PROVING_KEY);
        }
        assertEq(registry.boundAddresses(agent, CHAIN_MAINNET).length, ceiling, "the ceiling was not filled");

        address ninth = address(uint160(0x5000 + ceiling));
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentRegistry.TooManyBoundAddresses.selector, agent, CHAIN_MAINNET, ceiling
            )
        );
        vm.prank(verifier);
        registry.resolveOrBind(CHAIN_MAINNET, ninth, amounts[ceiling], PROVING_KEY);

        assertEq(registry.agentOf(CHAIN_MAINNET, ninth), address(0), "the ninth address bound anyway");
        assertEq(registry.boundAddresses(agent, CHAIN_MAINNET).length, ceiling, "the ceiling was exceeded");
        (AgentRegistry.PendingBinding memory refused,, bool alive) =
            registry.pendingBinding(CHAIN_MAINNET, ninth, agent);
        assertTrue(refused.open && alive, "the refused request lost its nonce");

        // A full Agent cannot even ask for a tenth, which is the same rule enforced a step earlier.
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentRegistry.TooManyBoundAddresses.selector, agent, CHAIN_MAINNET, ceiling
            )
        );
        vm.prank(agent);
        registry.requestBinding(CHAIN_MAINNET, address(uint160(0x6000)));

        // The ceiling is per Agent, so another Agent binds the address this one could not.
        _bind(CHAIN_MAINNET, ninth, otherAgent, keccak256("other-agent-proof"));
        assertEq(registry.agentOf(CHAIN_MAINNET, ninth), otherAgent, "the second Agent hit a shared ceiling");
    }

    /// @notice The ceiling and the bindings themselves are per chainKey. (R10.3, R10.8)
    /// @dev The same address on two Source Chains is two independent bindings, and they may belong to
    /// different Agents: a key controlling an address on one chain need not control the identically
    /// numbered address on another, and a testnet payment must never authenticate a mainnet identity.
    /// A full Agent on one chain is also shown to have its whole allowance on the other.
    function test_bindingsAndCeilingsAreIndependentPerChainKey() public {
        _bind(CHAIN_MAINNET, payer, agent, PROVING_KEY);
        _bind(CHAIN_SEPOLIA, payer, otherAgent, keccak256("sepolia-proof"));

        assertEq(registry.agentOf(CHAIN_MAINNET, payer), agent, "the mainnet binding moved");
        assertEq(registry.agentOf(CHAIN_SEPOLIA, payer), otherAgent, "the sepolia binding moved");
        assertEq(registry.boundAddresses(agent, CHAIN_SEPOLIA).length, 0, "a binding crossed chains");
        assertEq(registry.boundAddresses(otherAgent, CHAIN_MAINNET).length, 0, "a binding crossed chains");

        uint256 ceiling = registry.MAX_ADDRESSES_PER_CHAIN();
        for (uint256 i = 1; i < ceiling; ++i) {
            _bind(CHAIN_MAINNET, address(uint160(0x7000 + i)), agent, PROVING_KEY);
        }
        assertEq(registry.boundAddresses(agent, CHAIN_MAINNET).length, ceiling, "the ceiling was not filled");

        // Full on one chain, empty on the other: supporting a second Source Chain costs no slots on the
        // first, which is the whole reason the ceiling is scoped this way.
        _bind(CHAIN_SEPOLIA, address(uint160(0x8000)), agent, keccak256("sepolia-second"));
        assertEq(registry.boundAddresses(agent, CHAIN_SEPOLIA).length, 1, "a full Agent could not bind");
    }

    // ------------------------------------------------------------------ the caller gate

    /// @notice Only the wired `SettlementVerifier` may resolve or bind.
    /// @dev The gate is what makes a binding mean anything: this contract never sees a proof, so it
    /// trusts one caller to have checked one, and a resolution accepted from anybody else would be an
    /// identity binding with no payment behind it. Asserted for the requesting Agent itself, for a
    /// stranger, and for the wiring authority, none of which is the verifier.
    function test_resolveOrBindRefusesEveryCallerButTheVerifier() public {
        vm.prank(agent);
        (, uint256 requiredAmount,) = registry.requestBinding(CHAIN_MAINNET, payer);

        address[3] memory rejected = [agent, stranger, wiringAuthority];
        for (uint256 i = 0; i < rejected.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotSettlementVerifier.selector, rejected[i]));
            vm.prank(rejected[i]);
            registry.resolveOrBind(CHAIN_MAINNET, payer, requiredAmount, PROVING_KEY);
        }

        assertEq(registry.agentOf(CHAIN_MAINNET, payer), address(0), "an unauthorised caller bound");
        (AgentRegistry.PendingBinding memory pending,,) = registry.pendingBinding(CHAIN_MAINNET, payer, agent);
        assertTrue(pending.open, "a refused call closed the request");
    }

    /// @notice An unwired registry refuses every caller, so no binding predates the wiring.
    /// @dev The failure direction that matters: `msg.sender` is never the zero address, so an unwired
    /// slot rejects everybody rather than accepting anybody.
    function test_anUnwiredRegistryBindsForNobody() public {
        AgentRegistry unwired = new AgentRegistry(wiringAuthority);
        vm.prank(agent);
        (, uint256 requiredAmount,) = unwired.requestBinding(CHAIN_MAINNET, payer);

        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotSettlementVerifier.selector, verifier));
        vm.prank(verifier);
        unwired.resolveOrBind(CHAIN_MAINNET, payer, requiredAmount, PROVING_KEY);
        assertEq(unwired.settlementVerifier(), address(0), "an unwired registry reports a verifier");
    }

    /// @notice Wiring is authority-gated, refuses the zero address, and happens exactly once.
    /// @dev One-shot is what makes the caller gate a fact rather than a policy: after this transaction
    /// nobody, the authority included, can point the binding path at a different contract.
    function test_setSettlementVerifierIsAuthorityGatedAndOneShot() public {
        AgentRegistry fresh = new AgentRegistry(wiringAuthority);
        assertEq(fresh.WIRING_AUTHORITY(), wiringAuthority, "the authority was not bound at construction");

        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotWiringAuthority.selector, stranger));
        vm.prank(stranger);
        fresh.setSettlementVerifier(verifier);

        vm.expectRevert(AgentRegistry.ZeroWiringTarget.selector);
        vm.prank(wiringAuthority);
        fresh.setSettlementVerifier(address(0));

        vm.expectEmit(true, false, false, false);
        emit SettlementVerifierWired(verifier);
        vm.prank(wiringAuthority);
        fresh.setSettlementVerifier(verifier);
        assertEq(fresh.settlementVerifier(), verifier, "the verifier was not wired");

        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AlreadyWired.selector, verifier));
        vm.prank(wiringAuthority);
        fresh.setSettlementVerifier(address(0xDEAD));
        assertEq(fresh.settlementVerifier(), verifier, "the wired verifier was replaced");
    }

    /// @notice A registry cannot be deployed with no wiring authority, since the slot would be open.
    function test_constructorRefusesTheZeroWiringAuthority() public {
        vm.expectRevert(AgentRegistry.ZeroWiringTarget.selector);
        new AgentRegistry(address(0));
    }
}
