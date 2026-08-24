// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {Bond, IBond} from "../../src/Bond.sol";
import {LimitLib} from "../../src/LimitLib.sol";
import {IAgentRegistry, SettlementVerifier} from "../../src/SettlementVerifier.sol";
import {IServiceRegistry, ServiceRegistry} from "../../src/ServiceRegistry.sol";
import {ITabBook, TabBook} from "../../src/TabBook.sol";
import {TabAscBase} from "../../src/asc/TabAscBase.sol";
import {INativeQueryVerifier} from "../../src/interfaces/INativeQueryVerifier.sol";
import {MockBlockProver} from "../mocks/MockBlockProver.sol";
import {SourceTxFixture} from "../mocks/SourceTxFixture.sol";

// Feature: tab, Property 4: Receipt status and proof result gate all state change

/// @notice Every mutable storage location a submission could plausibly reach, read at one instant.
/// @dev One memory struct rather than thirty locals, and passed by reference everywhere below,
/// because `via_ir` is false here as it is in production and a wide snapshot spread across the stack
/// is the classic way to exhaust the legacy code generator.
///
/// The whole point of the struct is its width. "Nothing changed" is a claim about *every* location,
/// and a state change hiding in the claim set, in a Bond ledger, or in the pending-binding ledger is
/// exactly what a campaign that watched the Open Tab alone would wave through. The header on
/// {ReceiptGateTest} enumerates what is here, what is deliberately absent, and why.
struct Snapshot {
    /// @dev Open Tab record for the Agent, Service, Asset triple under test.
    ITabBook.Tab agentTab;
    /// @dev Open Tab record of the Service operator identity, where a misrouted Bond deposit lands.
    ITabBook.Tab operatorTab;
    /// @dev Per-Asset open aggregate the Credit Limit is checked against.
    uint256 assetOpen;
    /// @dev Rolling Verified Settlement commitment for the Agent and Asset.
    bytes32 historyRoot;
    /// @dev Number of records folded into that commitment.
    uint32 historyCount;
    /// @dev Creditcoin timestamp of the Agent's first Metered Delivery on the triple.
    uint64 firstDeliveryAt;
    /// @dev The Agent's own spending authorisation, whose `spent` figure metering moves.
    ITabBook.Authorisation authorisation;
    /// @dev Count of the Agent's delinquent tabs in the Asset.
    uint32 delinquentTabs;
    /// @dev Credit Limit, computed through the witness path against the commitment above.
    uint256 creditLimit;
    /// @dev Clearing record keyed on the replay key of this submission's own tab Settlement log.
    ITabBook.Clearing observedClearing;
    /// @dev Clearing record on a key no submission in this campaign ever names.
    ITabBook.Clearing standingClearing;
    /// @dev Bond ledger for the Service's party in the Asset.
    IBond.Ledger ledger;
    /// @dev Derived free figure, read rather than recomputed.
    uint128 freeBond;
    /// @dev Prepaid credit `Bond` holds for the Agent, which slashing creates.
    uint128 bondPrepaid;
    /// @dev Pledge covering {observedClearing}.
    IBond.Reservation observedReservation;
    /// @dev Pledge covering {standingClearing}.
    IBond.Reservation standingReservation;
    /// @dev Whether the reorg path has slashed against this submission's own replay key.
    bool reorgSlashed;
    /// @dev Binding record for the address the open request claims.
    AgentRegistry.Binding binding;
    /// @dev The open pending-binding request itself.
    AgentRegistry.PendingBinding pending;
    /// @dev Whether that request's 24-hour window is still open.
    bool pendingAlive;
    /// @dev Creditcoin timestamp at which its nonce stops being valid.
    uint64 pendingExpiresAt;
    /// @dev Address held by the amount claim for that request's required amount.
    address amountClaimAddress;
    /// @dev Agent held by that same amount claim.
    address amountClaimAgent;
    /// @dev Nonces held open on the chainKey, which a finalised binding returns to the space.
    uint256 openNonces;
    /// @dev Number of Source Chain addresses the Agent has bound on the chainKey.
    uint256 boundAddressCount;
    /// @dev Whether an earlier, already-ingested replay key still reads as claimed.
    bool priorClaimed;
    /// @dev Creditcoin block that earlier key was ingested in.
    uint64 priorIngestedAt;
    /// @dev `claimedLog` for every prospective replay key of this submission, by log ordinal.
    bool[] claimed;
    /// @dev `ingestedAt` for those same keys, by log ordinal.
    uint64[] ingestedAt;
}

/// @title ReceiptGateTest
/// @notice Property 4: a failed Source Chain receipt and a rejected proof change nothing at all.
///
/// ## The statement
///
/// For any submission whose decoded `receiptStatus` differs from `1`, or whose proof verification
/// returns `false`, every mutable location the submission could have written holds exactly the value
/// it held before the call.
///
/// **Validates: Requirements 3.2, 3.7, 7.1, 7.2, 7.3**
///
/// ## What is snapshotted
///
/// `genPreState` reads all of the following, and {_assertUnchanged} compares every field of every one
/// of them after a gated submission:
///
///  1. `TabBook` Open Tab for the Agent triple — `open`, `prepaid`, `oldestUnsettledAt`,
///     `lastDeliveryAt`, `deliveryCount`, `delinquent`.
///  2. `TabBook` per-Asset open aggregate.
///  3. `TabBook` rolling history commitment, both root and record count.
///  4. `TabBook` `firstDeliveryAt` for the triple, which metered-delivery precedence rests on.
///  5. `TabBook` Agent authorisation record, whose `spent` figure metering moves.
///  6. `TabBook` delinquent-tab count for the Agent and Asset.
///  7. Credit Limit, computed through the witness path so the commitment is checked on the way.
///  8. `TabBook` clearing record on this submission's own observed replay key, and on a second
///     standing clearing no submission here names.
///  9. `TabBook` Open Tab of the Service operator identity, where a misrouted Bond deposit lands.
/// 10. `TabAscBase` claim set — `claimedLog` and `ingestedAt` for every prospective replay key of the
///     submission, plus one key an earlier submission already claimed.
/// 11. `Bond` ledger for the Service's party in the Asset — `staked`, `reserved`, `slashed`,
///     `released` — and the derived free figure.
/// 12. `Bond` prepaid credit held for the Agent in the Asset.
/// 13. `Bond` reservation records for both clearings — party, asset, state, amount.
/// 14. `Bond` reorg-slash flag for the submission's own replay key.
/// 15. `AgentRegistry` pending-binding record, its expiry, and its liveness.
/// 16. `AgentRegistry` amount claim for that request's required amount.
/// 17. `AgentRegistry` binding record for the claimed address, the Agent's bound-address count, and
///     the open-nonce count for the chainKey.
///
/// ## What could not be reached, stated plainly
///
/// - **`ServiceRegistry` storage.** The verifier holds it as a read-only collaborator and calls only
///   view functions on it, so no submission has a write path into it. Named rather than snapshotted,
///   because there is nothing a submission could move there to catch.
/// - **Raw storage slots.** This compares named read surfaces, not every slot in the tree. A mutable
///   location with no public read at all would be invisible here. Every location above is one the
///   read surface exposes, which is also every location an indexer, a Dashboard, or a reviewer can
///   see, so the gap is a gap in the contracts' own observability rather than in the campaign.
/// - **The Credit Limit once a Settlement has landed.** It is answered only against a witness that
///   folds to the stored commitment, and a Verified Settlement advances that commitment, so the
///   control's post-state read leaves it out. The gated comparison, which is the property itself,
///   reads it on both sides. See {_readState}.
/// - **The batch entrypoint.** `submitSettlementBatch` is Property 12's subject. This campaign
///   submits one transaction at a time, so it says nothing about all-or-nothing batch semantics.
/// - **The reorg and delinquency cranks.** `reportReorg` and `markDelinquent` are not reachable from
///   a submission; their locations are snapshotted, and a submission moving one would be caught, but
///   the campaign never drives them.
///
/// ## What the campaign establishes, and what it cannot
///
/// Both gates revert, so the EVM would restore state even from a contract that wrote before checking.
/// The discriminating power therefore rests on two things, and both are asserted on every run.
///
/// First, the submission must **fail at all, with the exact gate error**, proof result before receipt
/// status, in the order `_verifyAndIngest` fixes. An implementation that skipped a reverted receipt
/// and carried on, or that swallowed a `false` proof result and returned zero ingested logs, would
/// leave the snapshot moved and this campaign red. That is the shape R3.2 and R7.2 exist to forbid.
///
/// Second, each run pairs the gated submission with a **control**: the identical transaction, same
/// logs, same height, resubmitted with `receiptStatus` `1` and the proof accepted. The control must
/// succeed and must move eleven of the snapshotted locations — the claim set, the Open Tab, prepaid
/// credit, the history commitment, the Bond ledger, the observed clearing, its pledge, the pending
/// request, the amount claim, the binding record, and the open-nonce count. Without it the property
/// would hold vacuously of a contract that does nothing, and the wide snapshot would prove nothing
/// about width. With it, every location named above is demonstrably live.
///
/// What no Solidity-level campaign can reach: a defect that writes and then reverts in the same call
/// frame is indistinguishable from correct behaviour to every on-chain observer, so "no write
/// happened" is out of scope and "no write survived" is what is proven.
///
/// ## On the two stand-ins
///
/// The BlockProver Precompile is etched at the address its library names, because `TabAscBase` binds
/// it as an immutable and there is deliberately no constructor seam to inject a double through. It is
/// compiled against the real interface, so a `SourceTx` layout that did not match would fail to
/// decode inside it. Everything else is the real tree: a real `ServiceRegistry` with a registered
/// Service, real bindings proven by paying the amounts the registry issues, a real `Bond` funded by a
/// real proven deposit, and a real `TabBook`. The transaction fixtures go through
/// `getTransactionType`, `decodeReceiptFields`, and `getLogsByEventSignature` unmodified, which is
/// what makes the receipt-status gate worth testing here at all: the status this campaign varies is
/// the status the decoder reads.
contract ReceiptGateTest is Test {
    // ------------------------------------------------------------------ the tree

    /// @notice Registry of emitters, Collection Addresses, prices, and tiers.
    ServiceRegistry internal registry;

    /// @notice Registry that binds Source Chain payer addresses to Creditcoin identities.
    AgentRegistry internal agents;

    /// @notice Bond the proven deposit credits stake in, and the clearing pledges against.
    Bond internal bond;

    /// @notice Book the Verified Settlement is applied to.
    TabBook internal book;

    /// @notice Contract under test.
    SettlementVerifier internal verifier;

    /// @notice The etched stand-in for the BlockProver Precompile.
    MockBlockProver internal prover;

    // ------------------------------------------------------------------ constants

    /// @notice Address the BlockProver Precompile lives at, which is where the mock is etched.
    address internal constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;

    /// @notice Attested-chain identifier of Ethereum Mainnet, which is the launch demo path.
    uint64 internal constant CHAIN_MAINNET = 3;

    /// @notice The Agent whose tab, credit, and bindings the property is stated over.
    address internal constant AGENT = address(0xA6E7);

    /// @notice Creditcoin address that operates the Service, and therefore its Bond party.
    address internal constant OPERATOR = address(0x0FE1);

    /// @notice The wired Watcher, which applies the two Provisional Clearings.
    address internal constant WATCHER = address(0x3A7C);

    /// @notice Source Chain address bound to {AGENT}, from which tab Settlements arrive.
    address internal constant PAYER = address(0x9A7E);

    /// @notice Source Chain address bound to {OPERATOR}, from which the Bond is funded.
    address internal constant FUNDER = address(0x9A7F);

    /// @notice Source Chain address {AGENT} holds an open, unproven binding request against.
    address internal constant BINDING_PAYER = address(0x9A80);

    /// @notice Gas payer of every generated transaction, bound to nobody and read by nothing. (R8.2)
    address internal constant TX_FROM = address(0x9A81);

    /// @notice Launch Asset on Ethereum Mainnet.
    address internal constant USDC = address(0x05DC);

    /// @notice An Asset contract authorised on no chain, used for the unrecognised noise logs.
    address internal constant UNKNOWN_ASSET = address(0x05FF);

    /// @notice The Service's ordinary Collection Address, whose Settlements reduce an Open Tab.
    address internal constant TAB_COLLECTION = address(0xC011);

    /// @notice The Service's Bond Collection Address, whose Settlements credit stake.
    address internal constant BOND_COLLECTION = address(0xC0B0);

    /// @notice The Service under test.
    bytes32 internal constant SERVICE = keccak256("receipt-gate-service");

    /// @notice The named priced tool.
    bytes32 internal constant TOOL = keccak256("proof.merkle");

    /// @notice Price of one unit of {TOOL} in Asset base units.
    uint256 internal constant PRICE = 1_000;

    /// @notice Units the setUp delivery buys, so an Open Tab exists before anything is submitted.
    uint32 internal constant UNITS = 200;

    /// @notice Baseline Credit Limit in Asset base units.
    uint256 internal constant BASELINE = 5_000_000;

    /// @notice Growth factor in basis points.
    uint256 internal constant GROWTH_BPS = 5_000;

    /// @notice Settlement Window the Service registers, in seconds.
    uint32 internal constant WINDOW = 6 hours;

    /// @notice Stake the one proven deposit in setUp creates, in Asset base units.
    uint128 internal constant DEPOSIT = 10_000_000;

    /// @notice Amount of the standing Provisional Clearing that no submission here ever names.
    uint128 internal constant STANDING_AMOUNT = 20_000;

    /// @notice Smallest generated Settlement amount, chosen clear of the binding-amount window.
    uint256 internal constant MIN_AMOUNT = 1_000_000;

    /// @notice Largest generated Settlement amount, comfortably inside the free Bond figure.
    uint256 internal constant MAX_AMOUNT = 2_000_000;

    /// @notice Recognised Settlement logs every generated transaction carries: tab, Bond, binding.
    uint256 internal constant RECOGNISED_LOGS = 3;

    /// @notice Source Chain block height of the standing clearing, outside the submission range.
    uint64 internal constant STANDING_HEIGHT = 20_000_000;

    /// @notice Wall clock the campaign starts from.
    uint64 internal constant START = 1_700_000_000;

    // ------------------------------------------------------------------ mutable fixture state

    /// @notice Source Chain block height of the next submission, so replay keys never collide.
    uint64 internal nextHeight = 21_000_000;

    /// @notice Exact Settlement amount that would prove {AGENT}'s open request on {BINDING_PAYER}.
    uint256 internal bindingAmount;

    /// @notice Replay key of the standing clearing, which stays `Applied` throughout.
    bytes32 internal standingKey;

    /// @notice Replay key of the current submission's own tab Settlement log.
    /// @dev Set by {_observe} once the receipt has been shuffled, because the ordinal a log lands on is
    /// generated rather than fixed. The clearing and its Bond pledge both hang off this key.
    bytes32 internal observedKey;

    /// @notice Replay key of a Verified Settlement already ingested during setUp.
    bytes32 internal priorKey;

    /// @notice Verified Settlement history, mirroring what `TabBook`'s commitment folds.
    /// @dev Every Credit Limit read is driven through this, so the snapshot's limit is self-checking:
    /// one disagreeing field and `TabBook` reverts `HistoryCommitmentMismatch` rather than answering.
    LimitLib.SettlementRecord[] internal history;

    // ------------------------------------------------------------------ setup

    /// @notice Deploys and wires the tree, then puts every snapshotted location into a non-zero state.
    /// @dev A pre-state of all zeroes would make "nothing changed" cheap to satisfy and impossible to
    /// distinguish from "nothing exists", so setUp deliberately leaves: an Open Tab with a metered
    /// charge on it, prepaid credit banked by an excess Settlement, a non-empty history commitment, a
    /// `firstDeliveryAt`, a live authorisation with a spent figure, one already-claimed replay key, a
    /// funded Bond ledger with part of it pledged, a standing Provisional Clearing and its
    /// reservation, and one open pending-binding request holding a nonce and an amount claim.
    ///
    /// Every one of those is created through the path a real deployment uses. The Bond is funded by a
    /// proven deposit rather than by impersonating the verifier, and both bindings are proven by
    /// paying the exact amount the registry issued.
    function setUp() public {
        vm.warp(START);

        MockBlockProver implementation = new MockBlockProver();
        vm.etch(PRECOMPILE, address(implementation).code);
        prover = MockBlockProver(PRECOMPILE);

        registry = new ServiceRegistry(address(this));
        agents = new AgentRegistry(address(this));
        bond = new Bond(address(this));
        book = new TabBook(address(this), address(registry), address(bond), BASELINE, GROWTH_BPS);

        verifier = new SettlementVerifier(
            IServiceRegistry(address(registry)),
            IAgentRegistry(address(agents)),
            ITabBook(address(book)),
            IBond(address(bond))
        );

        agents.setSettlementVerifier(address(verifier));
        book.setSettlementVerifier(address(verifier));
        book.setWatcher(WATCHER);
        bond.setSettlementVerifier(address(verifier));
        bond.setTabBook(address(book));

        _registerService();
        _bindFunder();
        _fundBondByProof();
        _authorise();
        _deliver();
        _bindAgentPayer();
        _openStandingClearing();
        _openPendingRequest();
    }

    // ------------------------------------------------------------------ the property

    /// @notice A failed receipt or a rejected proof leaves every mutable location exactly as it was.
    /// @dev The gated case and the control run inside one test rather than in two, because the control
    /// is what makes the gated case mean anything: it resubmits the identical transaction at the
    /// identical height with the gates open, and asserts that eleven of the snapshotted locations
    /// move. So the equality assertions above it are equalities the submission had the power to break.
    ///
    /// The height is reused deliberately. A gated submission must not burn its own replay keys, and
    /// the control landing at the same coordinates is the observable form of that claim.
    /// @param statusSeed Seed for the receipt status, over `{0, 1}`.
    /// @param proofSeed Seed for the proof result, over `{rejected, accepted}`.
    /// @param logSeed Seed for the noise-log count and for the receipt ordering.
    /// @param amountSeed Seed for the two generated Settlement amounts.
    function testFuzz_aFailedReceiptOrRejectedProofGatesEveryStateChange(
        uint256 statusSeed,
        uint256 proofSeed,
        uint256 logSeed,
        uint256 amountSeed
    ) public {
        uint8 receiptStatus = genReceiptStatus(statusSeed);
        bool proofHolds = genProofResult(proofSeed);
        EvmV1Decoder.LogEntryTuple[] memory entries = genRecognisedLogs(logSeed, amountSeed);

        uint64 height = nextHeight++;
        _observe(height, entries);
        prover.setRejectProofs(!proofHolds);

        Snapshot memory before = genPreState(height, entries.length);

        (bool ok, bytes memory returned) = _submit(height, receiptStatus, entries);

        if (proofHolds && receiptStatus == SourceTxFixture.STATUS_SUCCESS) {
            // Not a gated submission at all, so the property says nothing about it. Asserted anyway,
            // because a run that generated the open gates and then failed would mean the campaign was
            // measuring something other than the gates.
            assertTrue(ok, "an accepted proof over a successful receipt must be ingested");
            _assertStateMoved(before, height, entries.length, returned);
            return;
        }

        assertFalse(ok, "a gated submission must not succeed");
        assertEq(returned, _expectedGateError(proofHolds, height), "gate error");
        _assertUnchanged(before, height, entries.length);

        // The control. Same logs, same height, gates open.
        prover.setRejectProofs(false);
        (bool controlOk, bytes memory controlReturn) =
            _submit(height, SourceTxFixture.STATUS_SUCCESS, entries);
        assertTrue(controlOk, "the gated submission is ingestable once the gates open");
        _assertStateMoved(before, height, entries.length, controlReturn);
    }

    // ------------------------------------------------------------------ generators

    /// @notice The decoded receipt status a submission carries, over `{0, 1}`.
    /// @dev Both values, not just the failing one. `1` is what makes the control reachable from the
    /// same generator, and it is the only value R7.2 treats as a success.
    /// @param seed Seed to map.
    /// @return receiptStatus `0` for a reverted Source Chain transaction, `1` for a successful one.
    function genReceiptStatus(uint256 seed) internal pure returns (uint8 receiptStatus) {
        // `_bound` rather than `bound`, which logs its result: at 256 runs times several draws the
        // logging is pure noise, and the mapping is the same.
        receiptStatus = uint8(_bound(seed, 0, 1));
    }

    /// @notice What the precompile answers for the submitted proof.
    /// @dev A `false` return rather than a revert, because `false` is the branch R3.2 covers and the
    /// two must be indistinguishable as far as state is concerned.
    /// @param seed Seed to map.
    /// @return proofHolds True when `verifyAndEmit` answers `true`.
    function genProofResult(uint256 seed) internal pure returns (bool proofHolds) {
        proofHolds = _bound(seed, 0, 1) == 1;
    }

    /// @notice A receipt carrying three recognised Settlement logs plus generated noise, shuffled.
    /// @dev The three recognised logs are always present and are always the same three kinds, and that
    /// is the point rather than a shortcut. Each one is the *only* way to reach a different family of
    /// snapshotted locations, so their presence is what makes the width of the snapshot testable:
    ///
    ///  - a tab `Transfer` from the bound payer moves the Open Tab, prepaid credit, the history
    ///    commitment, and — because the observation below is keyed on it — the clearing record and its
    ///    Bond pledge;
    ///  - a `Transfer` to the Bond Collection Address moves the Bond ledger and nothing else;
    ///  - a `Transfer` from the address holding an open request, for that request's exact amount,
    ///    moves the pending-binding ledger, the amount claim, the binding record, the bound-address
    ///    list, and the open-nonce count.
    ///
    /// The noise logs are the two skip cases of R4.4 and R4.5: a zero-topic log and a log from an
    /// emitter authorised nowhere. They are here because a skipped log must not shift the ordinals of
    /// the logs beside it, and shuffling puts them on both sides of every recognised log.
    /// @param seed Seed for the noise count and the ordering.
    /// @param amountSeed Seed for the two generated amounts.
    /// @return entries Receipt logs, in receipt order.
    function genRecognisedLogs(uint256 seed, uint256 amountSeed)
        internal
        view
        returns (EvmV1Decoder.LogEntryTuple[] memory entries)
    {
        uint256 noise = _bound(seed, 0, 3);
        entries = new EvmV1Decoder.LogEntryTuple[](RECOGNISED_LOGS + noise);

        entries[0] = SourceTxFixture.transferLog(USDC, PAYER, TAB_COLLECTION, _genAmount(amountSeed));
        entries[1] = SourceTxFixture.transferLog(USDC, FUNDER, BOND_COLLECTION, _genAmount(amountSeed >> 128));
        entries[2] = SourceTxFixture.transferLog(USDC, BINDING_PAYER, TAB_COLLECTION, bindingAmount);

        for (uint256 i = 0; i < noise; ++i) {
            entries[RECOGNISED_LOGS + i] = (seed >> (8 + i)) & 1 == 0
                ? SourceTxFixture.zeroTopicLog(UNKNOWN_ASSET)
                : SourceTxFixture.transferLog(UNKNOWN_ASSET, PAYER, TAB_COLLECTION, MIN_AMOUNT);
        }

        _shuffle(entries, seed);
    }

    /// @notice Every mutable storage location the submission could plausibly reach, at one instant.
    /// @dev Read through the public surface rather than through storage slots, for the reason the
    /// header gives. The Credit Limit is read last and through the witness path on purpose: it folds
    /// the mirrored history against the stored commitment, so a snapshot taken over a tree whose
    /// commitment had moved would revert here instead of quietly reporting a stale figure.
    /// @param height Source Chain block height the submission will be made at.
    /// @param logCount Number of logs the submission carries, and so of prospective replay keys.
    /// @return snap The snapshot.
    function genPreState(uint64 height, uint256 logCount) internal view returns (Snapshot memory snap) {
        snap = _readState(height, logCount);
        snap.creditLimit = book.creditLimit(AGENT, USDC, _witness());
    }

    /// @notice Every location {genPreState} reads except the Credit Limit.
    /// @dev Separate because the Credit Limit is the one figure that cannot be read after a submission
    /// has landed. It is answered only against a witness that folds to the stored commitment, and a
    /// Verified Settlement advances that commitment, so the mirrored history this campaign carries is
    /// deliberately stale the instant a submission succeeds and the witness path reverts
    /// `HistoryLengthMismatch` rather than reporting a figure. That revert is exactly the behaviour
    /// {_assertStateMoved} asserts positively through `historyCount`, so nothing is lost by leaving
    /// {Snapshot.creditLimit} at zero in the post-control read: the gated comparison, which is the one
    /// the property is about, goes through {genPreState} on both sides and does compare the limit.
    /// @param height Source Chain block height the submission will be made at.
    /// @param logCount Number of logs the submission carries, and so of prospective replay keys.
    /// @return snap The snapshot, with {Snapshot.creditLimit} left at zero.
    function _readState(uint64 height, uint256 logCount) internal view returns (Snapshot memory snap) {
        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        bytes32 party = _party();

        snap.agentTab = book.tabOf(tabId);
        snap.operatorTab = book.tabOf(book.tabIdOf(OPERATOR, SERVICE, USDC));
        snap.assetOpen = book.assetOpen(AGENT, USDC);
        (snap.historyRoot, snap.historyCount) = book.historyCommitment(AGENT, USDC);
        snap.firstDeliveryAt = book.firstDeliveryAtOf(AGENT, SERVICE, USDC);
        snap.authorisation = book.authorisationOf(AGENT, SERVICE, USDC);
        snap.delinquentTabs = book.delinquentTabCount(AGENT, USDC);
        snap.observedClearing = book.clearingOf(observedKey);
        snap.standingClearing = book.clearingOf(standingKey);

        snap.ledger = bond.ledgerOf(party, USDC);
        snap.freeBond = bond.freeOf(party, USDC);
        snap.bondPrepaid = bond.prepaidCreditOf(AGENT, USDC);
        snap.observedReservation = bond.reservationOf(observedKey);
        snap.standingReservation = bond.reservationOf(standingKey);
        snap.reorgSlashed = bond.reorgSlashedFor(observedKey);

        snap.binding = agents.bindingOf(CHAIN_MAINNET, BINDING_PAYER);
        (snap.pending, snap.pendingExpiresAt, snap.pendingAlive) =
            agents.pendingBinding(CHAIN_MAINNET, BINDING_PAYER, AGENT);
        (snap.amountClaimAddress, snap.amountClaimAgent) =
            agents.pendingBindingByAmount(CHAIN_MAINNET, bindingAmount);
        snap.openNonces = agents.openNonceCount(CHAIN_MAINNET);
        snap.boundAddressCount = agents.boundAddresses(AGENT, CHAIN_MAINNET).length;

        snap.priorClaimed = verifier.claimedLog(priorKey);
        snap.priorIngestedAt = verifier.ingestedAt(priorKey);

        snap.claimed = new bool[](logCount);
        snap.ingestedAt = new uint64[](logCount);
        for (uint256 i = 0; i < logCount; ++i) {
            bytes32 key = _keyAt(height, i);
            snap.claimed[i] = verifier.claimedLog(key);
            snap.ingestedAt[i] = verifier.ingestedAt(key);
        }
    }

    // ------------------------------------------------------------------ the equality assertions

    /// @notice Every field of every snapshotted location holds the value it held before the call.
    /// @dev Split across four helpers, each taking two memory pointers, because one function holding
    /// the whole comparison exhausts the legacy code generator's stack at `via_ir = false`.
    /// @param before The snapshot taken before the gated submission.
    /// @param height Source Chain block height the submission was made at.
    /// @param logCount Number of logs the submission carried.
    function _assertUnchanged(Snapshot memory before, uint64 height, uint256 logCount) internal view {
        Snapshot memory post = genPreState(height, logCount);
        _assertBookUnchanged(before, post);
        _assertClearingsUnchanged(before, post);
        _assertBondUnchanged(before, post);
        _assertRegistryUnchanged(before, post);
        _assertClaimSetUnchanged(before, post);
    }

    /// @notice Tab, aggregate, commitment, precedence, authorisation, delinquency, and Credit Limit.
    /// @param before Pre-submission snapshot.
    /// @param post Post-submission snapshot.
    function _assertBookUnchanged(Snapshot memory before, Snapshot memory post) internal pure {
        assertEq(post.agentTab.open, before.agentTab.open, "open tab moved");
        assertEq(post.agentTab.prepaid, before.agentTab.prepaid, "prepaid credit moved");
        assertEq(post.agentTab.oldestUnsettledAt, before.agentTab.oldestUnsettledAt, "oldest unsettled");
        assertEq(post.agentTab.lastDeliveryAt, before.agentTab.lastDeliveryAt, "last delivery");
        assertEq(post.agentTab.deliveryCount, before.agentTab.deliveryCount, "delivery count");
        assertEq(post.agentTab.delinquent, before.agentTab.delinquent, "delinquent flag");

        assertEq(post.operatorTab.open, before.operatorTab.open, "operator open tab moved");
        assertEq(post.operatorTab.prepaid, before.operatorTab.prepaid, "operator prepaid moved");

        assertEq(post.assetOpen, before.assetOpen, "per-asset aggregate moved");
        assertEq(post.historyRoot, before.historyRoot, "history commitment moved");
        assertEq(post.historyCount, before.historyCount, "history count moved");
        assertEq(post.firstDeliveryAt, before.firstDeliveryAt, "firstDeliveryAt moved");
        assertEq(post.authorisation.maxCumulative, before.authorisation.maxCumulative, "auth ceiling");
        assertEq(post.authorisation.spent, before.authorisation.spent, "auth spent moved");
        assertEq(post.authorisation.expiry, before.authorisation.expiry, "auth expiry moved");
        assertEq(post.authorisation.exists, before.authorisation.exists, "auth existence moved");
        assertEq(post.delinquentTabs, before.delinquentTabs, "delinquent tab count moved");
        assertEq(post.creditLimit, before.creditLimit, "credit limit moved");
    }

    /// @notice Both clearing records, field by field, including the one the submission names.
    /// @param before Pre-submission snapshot.
    /// @param post Post-submission snapshot.
    function _assertClearingsUnchanged(Snapshot memory before, Snapshot memory post) internal pure {
        assertEq(uint256(post.observedClearing.state), uint256(before.observedClearing.state), "obs state");
        assertEq(post.observedClearing.amount, before.observedClearing.amount, "observed amount");
        assertEq(post.observedClearing.reduced, before.observedClearing.reduced, "observed reduced");
        assertEq(post.observedClearing.deadline, before.observedClearing.deadline, "observed deadline");
        assertEq(post.observedClearing.agent, before.observedClearing.agent, "observed agent");
        assertEq(post.observedClearing.asset, before.observedClearing.asset, "observed asset");

        assertEq(uint256(post.standingClearing.state), uint256(before.standingClearing.state), "std state");
        assertEq(post.standingClearing.amount, before.standingClearing.amount, "standing amount");
        assertEq(post.standingClearing.reduced, before.standingClearing.reduced, "standing reduced");
    }

    /// @notice Ledger, free figure, both pledges, the Agent's Bond-held credit, and the reorg flag.
    /// @param before Pre-submission snapshot.
    /// @param post Post-submission snapshot.
    function _assertBondUnchanged(Snapshot memory before, Snapshot memory post) internal pure {
        assertEq(post.ledger.staked, before.ledger.staked, "staked moved");
        assertEq(post.ledger.reserved, before.ledger.reserved, "reserved moved");
        assertEq(post.ledger.slashed, before.ledger.slashed, "slashed moved");
        assertEq(post.ledger.released, before.ledger.released, "released moved");
        assertEq(post.freeBond, before.freeBond, "free bond moved");
        assertEq(post.bondPrepaid, before.bondPrepaid, "bond-held prepaid credit moved");

        assertEq(
            uint256(post.observedReservation.state),
            uint256(before.observedReservation.state),
            "observed pledge state"
        );
        assertEq(post.observedReservation.amount, before.observedReservation.amount, "observed pledge");
        assertEq(
            uint256(post.standingReservation.state),
            uint256(before.standingReservation.state),
            "standing pledge state"
        );
        assertEq(post.standingReservation.amount, before.standingReservation.amount, "standing pledge");
        assertEq(post.reorgSlashed, before.reorgSlashed, "reorg slash flag moved");
    }

    /// @notice The pending-binding ledger, the amount claim, the binding record, and the nonce space.
    /// @dev The location the task named as the one a narrow campaign would miss. A submission that
    /// bound an address, consumed a nonce, or released an amount claim on the way to a rejection would
    /// have handed out an identity on the strength of a proof that did not hold.
    /// @param before Pre-submission snapshot.
    /// @param post Post-submission snapshot.
    function _assertRegistryUnchanged(Snapshot memory before, Snapshot memory post) internal pure {
        assertEq(post.binding.agent, before.binding.agent, "binding agent moved");
        assertEq(post.binding.boundAt, before.binding.boundAt, "binding timestamp moved");
        assertEq(post.binding.provingReplayKey, before.binding.provingReplayKey, "proving key moved");

        assertEq(post.pending.agent, before.pending.agent, "pending agent moved");
        assertEq(post.pending.ethAddress, before.pending.ethAddress, "pending address moved");
        assertEq(post.pending.requiredAmount, before.pending.requiredAmount, "required amount moved");
        assertEq(post.pending.nonce, before.pending.nonce, "pending nonce moved");
        assertEq(post.pending.issuedAt, before.pending.issuedAt, "pending issuance moved");
        assertEq(post.pending.open, before.pending.open, "pending request closed");
        assertEq(post.pendingAlive, before.pendingAlive, "pending liveness moved");
        assertEq(post.pendingExpiresAt, before.pendingExpiresAt, "pending expiry moved");

        assertEq(post.amountClaimAddress, before.amountClaimAddress, "amount claim address moved");
        assertEq(post.amountClaimAgent, before.amountClaimAgent, "amount claim agent moved");
        assertEq(post.openNonces, before.openNonces, "open nonce count moved");
        assertEq(post.boundAddressCount, before.boundAddressCount, "bound address count moved");
    }

    /// @notice Not one replay key is claimed, and no earlier claim is disturbed.
    /// @dev The other location a narrow campaign would miss. A gated submission that recorded its keys
    /// would make the Settlement permanently unclaimable, which is a lost payment rather than a
    /// rejected one — the failure mode R4.3 exists to keep out of batching.
    /// @param before Pre-submission snapshot.
    /// @param post Post-submission snapshot.
    function _assertClaimSetUnchanged(Snapshot memory before, Snapshot memory post) internal pure {
        assertEq(post.priorClaimed, before.priorClaimed, "an earlier claim was disturbed");
        assertEq(post.priorIngestedAt, before.priorIngestedAt, "an earlier ingestion block moved");
        assertEq(post.claimed.length, before.claimed.length, "claim vector width");

        for (uint256 i = 0; i < post.claimed.length; ++i) {
            assertEq(post.claimed[i], before.claimed[i], "replay key claimed by a gated submission");
            assertEq(post.ingestedAt[i], before.ingestedAt[i], "ingestion block written by a gated call");
        }
    }

    // ------------------------------------------------------------------ the control

    /// @notice The same submission with the gates open moves eleven of the snapshotted locations.
    /// @dev Without this the property would hold of a contract that does nothing, and the width of the
    /// snapshot would establish nothing about width. Each assertion below names one location and
    /// proves it is reachable from a submission, which is what makes the corresponding equality in
    /// {_assertUnchanged} an equality that had to be enforced rather than one that came for free.
    /// @param before The snapshot taken before the gated submission.
    /// @param height Source Chain block height the submission was made at.
    /// @param logCount Number of logs the submission carried.
    /// @param returned Raw return data of the successful submission.
    function _assertStateMoved(Snapshot memory before, uint64 height, uint256 logCount, bytes memory returned)
        internal
        view
    {
        assertEq(abi.decode(returned, (uint256)), RECOGNISED_LOGS, "recognised logs ingested");

        // The pre-state the control is measured against was genuinely non-trivial.
        assertTrue(before.pending.open, "the pre-state held an open binding request");
        assertEq(uint256(before.observedClearing.state), 1, "the pre-state held an applied clearing");
        assertEq(uint256(before.observedReservation.state), 1, "and its pledge was reserved");
        assertGt(before.ledger.staked, 0, "the pre-state held stake");
        assertGt(before.historyCount, 0, "the pre-state held settlement history");

        // {_readState} rather than {genPreState}: a landed Settlement has already advanced the history
        // commitment, so the witness this campaign mirrors no longer folds to it. See {_readState}.
        Snapshot memory post = _readState(height, logCount);

        //  1, 2. The claim set grew by exactly the recognised logs, and none was claimed before.
        uint256 claimedNow;
        for (uint256 i = 0; i < logCount; ++i) {
            assertFalse(before.claimed[i], "no key was claimed before the control");
            if (post.claimed[i]) claimedNow += 1;
        }
        assertEq(claimedNow, RECOGNISED_LOGS, "the control claimed one key per recognised log");

        //  3. The Open Tab or its prepaid credit moved.
        assertTrue(
            post.agentTab.open != before.agentTab.open || post.agentTab.prepaid != before.agentTab.prepaid,
            "the control moved neither the Open Tab nor prepaid credit"
        );

        //  4. The history commitment advanced.
        assertGt(post.historyCount, before.historyCount, "history commitment did not advance");

        //  5. The Bond ledger gained the proven deposit.
        assertGt(post.ledger.staked, before.ledger.staked, "the proven deposit created no stake");

        //  6, 7. The observed clearing was confirmed and its pledge released.
        assertEq(uint256(post.observedClearing.state), 2, "the clearing was not confirmed");
        assertEq(uint256(post.observedReservation.state), 2, "the pledge was not released");

        //  8, 9, 10, 11. The binding was finalised, closing the request, the claim, and the nonce.
        assertEq(post.binding.agent, AGENT, "the binding was not written");
        assertFalse(post.pending.open, "the request was not closed");
        assertEq(post.amountClaimAddress, address(0), "the amount claim was not released");
        assertLt(post.openNonces, before.openNonces, "the nonce did not return to the space");
        assertGt(post.boundAddressCount, before.boundAddressCount, "the address list did not grow");
    }

    /// @notice The revert the gate must raise, and in the order `_verifyAndIngest` fixes.
    /// @dev Proof result first. A rejected proof is decided before the transaction is decoded at all,
    /// so a submission that is bad on both counts must report the proof, and a campaign that accepted
    /// either error would not notice the gates being reordered. (R3.2, R3.7, R7.3)
    /// @param proofHolds Whether the precompile answered `true`.
    /// @param height Source Chain block height of the submission.
    /// @return expected ABI-encoded revert data.
    function _expectedGateError(bool proofHolds, uint64 height)
        internal
        pure
        returns (bytes memory expected)
    {
        if (!proofHolds) {
            expected = abi.encodeWithSelector(
                TabAscBase.ProofRejected.selector, CHAIN_MAINNET, height, _root(height)
            );
        } else {
            expected = abi.encodeWithSelector(
                TabAscBase.SourceTransactionReverted.selector, CHAIN_MAINNET, height, uint64(0)
            );
        }
    }

    // ------------------------------------------------------------------ submission plumbing

    /// @notice Submit one transaction and report whether it landed, without unwinding the test.
    /// @dev A low-level call rather than `expectRevert`, for two reasons. The generator produces both
    /// gated and ungated cases from the same seeds, so the call site cannot know in advance whether to
    /// expect a revert; and comparing the raw return data is what pins *which* gate answered rather
    /// than merely that something did.
    /// @param height Source Chain block height to submit at.
    /// @param receiptStatus Receipt status the fixture encodes.
    /// @param entries Receipt logs, in receipt order.
    /// @return ok Whether the submission succeeded.
    /// @return returned Raw return or revert data.
    function _submit(uint64 height, uint8 receiptStatus, EvmV1Decoder.LogEntryTuple[] memory entries)
        internal
        returns (bool ok, bytes memory returned)
    {
        TabAscBase.SourceTx memory sourceTx =
            _sourceTx(height, SourceTxFixture.encodeWithStatus(TX_FROM, receiptStatus, entries));
        (ok, returned) = address(verifier).call(abi.encodeCall(verifier.submitSettlement, (sourceTx)));
    }

    /// @notice One Source Chain transaction with its proof material, ready to submit.
    /// @dev The proof material is inert, because the etched precompile is what decides whether a proof
    /// holds. What matters is that the struct is populated exactly as a real submission populates it,
    /// so the mock decodes real fields and the Merkle root the `ProofRejected` error reports is one
    /// this test can predict.
    /// @param height Source Chain block height to submit at.
    /// @param encoded The prover's chunked composite of the transaction.
    /// @return sourceTx The submission.
    function _sourceTx(uint64 height, bytes memory encoded)
        internal
        pure
        returns (TabAscBase.SourceTx memory sourceTx)
    {
        sourceTx.chainKey = CHAIN_MAINNET;
        sourceTx.blockHeight = height;
        sourceTx.encodedTransaction = encoded;
        sourceTx.merkleProof = INativeQueryVerifier.MerkleProof({
            root: _root(height), siblings: new INativeQueryVerifier.MerkleProofEntry[](0)
        });
        sourceTx.continuityProof = INativeQueryVerifier.ContinuityProof({
            lowerEndpointDigest: keccak256(abi.encode("endpoint", height)), roots: new bytes32[](0)
        });
    }

    /// @notice Claimed transaction-trie root of the submission at one height.
    /// @param height Source Chain block height.
    /// @return root The root the Merkle Proof carries.
    function _root(uint64 height) internal pure returns (bytes32 root) {
        root = keccak256(abi.encode(CHAIN_MAINNET, height));
    }

    /// @notice Replay key of one log ordinal at one height, as the contract packs it.
    /// @dev Read from the contract's own `public pure` packer rather than repacked here, so the test
    /// cannot agree with a layout the contract does not use.
    /// @param height Source Chain block height.
    /// @param logIndex Ordinal of the log within the transaction's own receipt logs.
    /// @return key The packed key.
    function _keyAt(uint64 height, uint256 logIndex) internal view returns (bytes32 key) {
        // casting to 'uint64' is safe because a generated receipt carries at most six logs.
        // forge-lint: disable-next-line(unsafe-typecast)
        key = verifier.replayKey(CHAIN_MAINNET, height, prover.txIndex(), uint64(logIndex));
    }

    /// @notice Observe the submission's own tab Settlement and apply a Provisional Clearing for it.
    /// @dev Run before the snapshot, so the clearing record and its Bond pledge are part of the
    /// pre-state. This is what makes those two locations live rather than merely watched: the control's
    /// Verified Settlement for the very same replay key confirms the clearing and releases the pledge,
    /// so a gated submission that had touched either would be caught by the equality assertions.
    /// @param height Source Chain block height the submission will be made at.
    /// @param entries Receipt logs, in receipt order, already shuffled.
    function _observe(uint64 height, EvmV1Decoder.LogEntryTuple[] memory entries) internal {
        uint256 index = _indexOfTabSettlement(entries);
        observedKey = _keyAt(height, index);

        // casting to 'uint128' is safe because `_genAmount` bounds every amount below 2^31.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 amount = uint128(abi.decode(entries[index].data, (uint256)));

        vm.prank(WATCHER);
        bool applied = book.applyProvisionalClearing(
            ITabBook.ProvisionalObservation({
                replayKey: observedKey,
                agent: AGENT,
                serviceId: SERVICE,
                asset: USDC,
                amount: amount,
                chainKey: CHAIN_MAINNET,
                sourceTxHash: keccak256(abi.encode("observed", height)),
                attestedDigestAtApply: keccak256(abi.encode("digest", height))
            })
        );
        assertTrue(applied, "the free Bond figure must cover every generated observation");
    }

    /// @notice Ordinal of the one recognised tab Settlement inside a generated receipt.
    /// @dev Matched on the emitter as well as the topics, because the noise `Transfer` carries the same
    /// payer and the same recipient from an emitter authorised nowhere. Exactly one log can match.
    /// @param entries Receipt logs, in receipt order.
    /// @return index The ordinal.
    function _indexOfTabSettlement(EvmV1Decoder.LogEntryTuple[] memory entries)
        internal
        pure
        returns (uint256 index)
    {
        for (uint256 i = 0; i < entries.length; ++i) {
            if (entries[i].address_ != USDC || entries[i].topics.length != 3) continue;
            if (entries[i].topics[1] != bytes32(uint256(uint160(PAYER)))) continue;
            if (entries[i].topics[2] != bytes32(uint256(uint160(TAB_COLLECTION)))) continue;
            return i;
        }
        revert("the generator must emit exactly one tab Settlement");
    }

    /// @notice One generated Settlement amount, clear of the binding-amount encoding window.
    /// @dev Bounded above the four-digit encoding window that `AgentRegistry` reserves, so a generated
    /// tab Settlement can never be mistaken for the proof of the open binding request. It is also
    /// bounded below the free Bond figure, so every observation applies rather than being declined.
    /// @param seed Seed to map.
    /// @return amount The amount in Asset base units.
    function _genAmount(uint256 seed) internal pure returns (uint256 amount) {
        amount = _bound(seed, MIN_AMOUNT, MAX_AMOUNT);
    }

    /// @notice Shuffle the receipt so no recognised log sits at a fixed ordinal.
    /// @dev Ordering is the reason the sweep is indexed. A skipped log must not shift the ordinals of
    /// the logs beside it, and a campaign that always put the noise last would never test that.
    /// @param entries Receipt logs, shuffled in place.
    /// @param seed Seed to shuffle with.
    function _shuffle(EvmV1Decoder.LogEntryTuple[] memory entries, uint256 seed) internal pure {
        for (uint256 i = entries.length; i > 1; --i) {
            uint256 j = _bound(uint256(keccak256(abi.encode(seed, i))), 0, i - 1);
            EvmV1Decoder.LogEntryTuple memory held = entries[i - 1];
            entries[i - 1] = entries[j];
            entries[j] = held;
        }
    }

    // ------------------------------------------------------------------ fixture

    /// @notice Register the Service, accepting the launch Asset on the launch chain.
    function _registerService() internal {
        uint64[] memory chainKeys = new uint64[](1);
        chainKeys[0] = CHAIN_MAINNET;

        address[] memory assets = new address[](1);
        assets[0] = USDC;

        address[] memory collections = new address[](1);
        collections[0] = TAB_COLLECTION;

        bytes32[] memory tools = new bytes32[](1);
        tools[0] = TOOL;

        uint256[] memory prices = new uint256[](1);
        prices[0] = PRICE;

        vm.prank(OPERATOR);
        registry.registerService(SERVICE, chainKeys, assets, collections, tools, prices, WINDOW);

        vm.prank(OPERATOR);
        registry.registerBondCollection(SERVICE, CHAIN_MAINNET, USDC, BOND_COLLECTION);
    }

    /// @notice Bind the Service's funding address by paying the exact amount the registry issues.
    /// @dev The honest path and the only one there is. The payment lands on the operator's own tab as
    /// prepaid credit, which is why {Snapshot.operatorTab} is non-zero and therefore worth watching:
    /// it is where a Bond deposit would land if the collection kind were ever misread.
    function _bindFunder() internal {
        vm.prank(OPERATOR);
        (, uint256 amount,) = agents.requestBinding(CHAIN_MAINNET, FUNDER);

        _submitTransfer(FUNDER, TAB_COLLECTION, amount);
        assertEq(agents.agentOf(CHAIN_MAINNET, FUNDER), OPERATOR, "funder bound by payment");
    }

    /// @notice Create the Service's stake the only way stake can be created: by proven deposit.
    function _fundBondByProof() internal {
        _submitTransfer(FUNDER, BOND_COLLECTION, DEPOSIT);
        assertEq(bond.ledgerOf(_party(), USDC).staked, DEPOSIT, "stake credited from the proof");
    }

    /// @notice Grant a spending authorisation as the Agent, so a delivery may be metered at all.
    function _authorise() internal {
        vm.prank(AGENT);
        // casting to 'uint64' is safe because the campaign's clock is a constant far below 2^64.
        // forge-lint: disable-next-line(unsafe-typecast)
        book.authorise(SERVICE, USDC, type(uint128).max, uint64(block.timestamp) + 365 days);
    }

    /// @notice Meter one delivery, so an Open Tab and a `firstDeliveryAt` exist before any submission.
    function _deliver() internal {
        vm.prank(OPERATOR);
        (uint256 charged,,) = book.recordDelivery(AGENT, SERVICE, USDC, TOOL, UNITS, PRICE, _witness());
        assertEq(charged, uint256(UNITS) * PRICE, "metered charge");
    }

    /// @notice Bind the Agent's payer address, and keep the replay key that proved it.
    /// @dev That key is the already-claimed entry the snapshot watches. A gated submission that
    /// disturbed an earlier claim would be unclaiming a Settlement that was genuinely proven.
    function _bindAgentPayer() internal {
        vm.prank(AGENT);
        (, uint256 amount,) = agents.requestBinding(CHAIN_MAINNET, PAYER);

        uint64 height = _submitTransfer(PAYER, TAB_COLLECTION, amount);
        assertEq(agents.agentOf(CHAIN_MAINNET, PAYER), AGENT, "payer bound by payment");

        priorKey = verifier.replayKey(CHAIN_MAINNET, height, 0, 0);
        assertTrue(verifier.claimedLog(priorKey), "the proving key is claimed");
        _appendHistory(amount);
    }

    /// @notice Apply a Provisional Clearing on a key no submission in this campaign ever names.
    /// @dev The control for the clearing snapshot. The observed clearing moves when the gates open, so
    /// something has to establish that a submission does not disturb clearings it did not name.
    function _openStandingClearing() internal {
        standingKey = verifier.replayKey(CHAIN_MAINNET, STANDING_HEIGHT, 0, 0);

        vm.prank(WATCHER);
        bool applied = book.applyProvisionalClearing(
            ITabBook.ProvisionalObservation({
                replayKey: standingKey,
                agent: AGENT,
                serviceId: SERVICE,
                asset: USDC,
                amount: STANDING_AMOUNT,
                chainKey: CHAIN_MAINNET,
                sourceTxHash: keccak256("standing"),
                attestedDigestAtApply: keccak256("standing-digest")
            })
        );
        assertTrue(applied, "the standing clearing is covered by free Bond");
    }

    /// @notice Open one binding request the campaign never proves outside the control.
    /// @dev The pending-binding ledger, the amount claim, and one held nonce all exist because of this
    /// call, and all three are locations a gated submission must leave exactly alone.
    function _openPendingRequest() internal {
        vm.prank(AGENT);
        (, bindingAmount,) = agents.requestBinding(CHAIN_MAINNET, BINDING_PAYER);
    }

    /// @notice Submit one ERC-20 `Transfer` Settlement at the next unused height.
    /// @param payer Sender, which lands in `topics[1]`, and is the payer. (R8.1)
    /// @param recipient Recipient, which lands in `topics[2]`.
    /// @param amount Transferred amount in Asset base units.
    /// @return height The height the submission was made at.
    function _submitTransfer(address payer, address recipient, uint256 amount)
        internal
        returns (uint64 height)
    {
        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, payer, recipient, amount));

        height = nextHeight++;
        verifier.submitSettlement(_sourceTx(height, SourceTxFixture.encode(TX_FROM, entries)));
    }

    /// @notice Append the record `TabBook` just committed, so the next witness folds to the same root.
    /// @dev Every field is read back from chain state rather than assumed. None of the four figures
    /// `TabBook` authors moves during a Settlement, so reading them immediately afterwards gives the
    /// same values the commitment saw.
    /// @param amount Settled amount that was committed.
    function _appendHistory(uint256 amount) internal {
        history.push(
            LimitLib.SettlementRecord({
                serviceId: SERVICE,
                asset: USDC,
                // casting to 'uint128' is safe because every amount this campaign settles is either a
                // registry-issued binding amount or a `_genAmount` draw, both far below 2^128.
                // forge-lint: disable-next-line(unsafe-typecast)
                amount: uint128(amount),
                // casting to 'uint64' is safe because the campaign's clock is a constant far below 2^64.
                // forge-lint: disable-next-line(unsafe-typecast)
                settledAt: uint64(block.timestamp),
                firstDeliveryAt: book.firstDeliveryAtOf(AGENT, SERVICE, USDC),
                chainKey: CHAIN_MAINNET,
                curated: registry.tierOf(SERVICE) == IServiceRegistry.Tier.Curated,
                bonded: bond.ledgerOf(_party(), USDC).staked > 0
            })
        );
    }

    /// @notice The Bond party key the Service's stake sits under.
    /// @dev Read the way `TabBook` reads it, through the registry's `bondAccount` and the Bond's own
    /// embedding, so the test cannot agree with a derivation the contracts do not share.
    /// @return party Key the ledgers are held under.
    function _party() internal view returns (bytes32 party) {
        party = bond.partyOf(registry.serviceOf(SERVICE).bondAccount);
    }

    /// @notice The witness every Credit Limit read is driven through. (D20)
    /// @dev The Bond amount is left at zero deliberately: `TabBook` discards whatever a caller writes
    /// there and substitutes the figure `Bond` actually holds.
    /// @return witness Mirrored history plus the one counterparty entry.
    function _witness() internal view returns (ITabBook.LimitWitness memory witness) {
        LimitLib.BondEntry[] memory bonds = new LimitLib.BondEntry[](1);
        bonds[0] = LimitLib.BondEntry({serviceId: SERVICE, asset: USDC, amount: 0});
        witness = ITabBook.LimitWitness({history: history, bonds: bonds});
    }
}
