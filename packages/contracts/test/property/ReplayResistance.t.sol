// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test, Vm} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {Bond, IBond} from "../../src/Bond.sol";
import {IAgentRegistry, SettlementVerifier} from "../../src/SettlementVerifier.sol";
import {IServiceRegistry, ServiceRegistry} from "../../src/ServiceRegistry.sol";
import {ITabBook, TabBook} from "../../src/TabBook.sol";
import {TabAscBase} from "../../src/asc/TabAscBase.sol";
import {INativeQueryVerifier} from "../../src/interfaces/INativeQueryVerifier.sol";
import {MockBlockProver} from "../mocks/MockBlockProver.sol";
import {SourceTxFixture} from "../mocks/SourceTxFixture.sol";

// Feature: tab, Property 1: Replay resistance is exact and log-scoped
//
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7**
//
// The canonical replay key is the tuple `(chainKey, blockHeight, txIndex, logIndex)`, and this
// campaign holds it to being exactly that — no wider, so a second recognised Settlement log in the
// same transaction is still claimable, and no narrower, so a resubmission of one log is refused.
// For any generated receipt and any submission order, the campaign establishes:
//
//   1. every recognised Settlement log in a verified transaction is ingested, under its own replay
//      key, and those keys are pairwise distinct (R4.1, R4.3);
//   2. exactly one `SettlementRecorded` event is emitted per ingested log (R4.7);
//   3. a log with zero topics is skipped and the logs beside it still land (R4.4);
//   4. a log whose emitter is authorised nowhere is skipped and the logs beside it still land (R4.5);
//   5. a receipt holding no recognised Settlement reverts `NoRecognisedSettlement`, and leaves no
//      key claimed and no tab moved (R4.6);
//   6. resubmitting an already ingested log reverts `AlreadyClaimed` and changes nothing (R4.2),
//      while the identical transaction bytes presented at fresh coordinates still credit — so the
//      refusal is scoped to the tuple and not to the content;
//   7. each of the four coordinates is load-bearing: two submissions differing only in `blockHeight`,
//      only in `txIndex`, or only in `chainKey` are both claimable;
//   8. any shuffled, duplicated submission order reaches the same terminal state as the canonical
//      order, with as many successes as there are distinct submissions and every refusal an
//      `AlreadyClaimed`.
//
// Shuffling and duplication are always exercised, in two places and for two different reasons. The
// logs inside a receipt are interleaved by a shuffle over kinds, so recognised, zero-topic, and
// unknown-emitter logs land at generated ordinals rather than in tidy blocks — an off-by-one in the
// ordinal sweep survives a receipt whose Settlements sit first and dies here. The submissions
// themselves are then shuffled and each one duplicated, so the order-independence clause is asserted
// against genuine replays interleaved with first attempts.
//
// **Terminal state means the claimed set, the per-key ingestion record, and the value totals** — the
// Open Tab and prepaid credit for both launch Assets. It deliberately excludes `TabBook`'s rolling
// history commitment, which chains each applied record into a hash and is therefore order-dependent
// by construction: two orders that credit the same Agent the same amounts commit to different
// digests, and that is what a commitment to a *sequence* means. Order-independence of the credited
// value is the claim; order-independence of the audit chain is not, and would be the wrong claim.
//
// **What this campaign does not establish.**
//
// Nothing about proof validity. The BlockProver Precompile does not exist locally, so a
// `MockBlockProver` is etched at its address and answers `true`. Every submission below is therefore
// a transaction the chain has agreed was included; whether an unproven transaction can be submitted
// at all is settled by `TabAscBase`'s own gate and by the live negative-path suite, and nothing here
// speaks to it. The etch is not a stub of convenience either: the mock implements the real interface,
// so a `SourceTx` layout that disagreed with the precompile ABI would fail to decode inside it.
//
// Nothing about the batch entrypoint. Every submission here goes through `submitSettlement`, one
// transaction at a time, because the subject is the replay key rather than the batch bounds. That
// the batch path ingests the identical set is a sibling campaign's business.
//
// Nothing about the authorised-elsewhere emitter. The unknown-emitter logs generated here are
// authorised on no chain at all, which is the case Requirement 4.5 asks to be skipped. An emitter
// authorised on a *different* chain is a different outcome by design — it reverts — and pinning that
// distinction belongs to the pair-authentication campaign.
//
// Nothing about who submits. The Watcher records replay keys before broadcasting, so it does not
// produce these duplicates in normal operation; the point of generating them is that the contract
// must not depend on that.

/// @title ReplayResistanceTest
/// @notice Property campaign for the exactness and log scope of the replay key.
/// @dev The whole tree is deployed for real — a `ServiceRegistry` carrying a Service on both Source
/// Chains, an `AgentRegistry` whose bindings are established by paying the amounts it issues, a
/// `Bond`, and a `TabBook` — so every claimed key and every credited base unit below is produced by
/// the code that would run on chain. The one exception is the precompile, argued in the header.
///
/// The generators are shaped to the contract's own vocabulary rather than to a fuzzer's convenience.
/// A receipt is described by three counts and a shuffle, all bounded, so no run is spent rejecting
/// inputs and every run is a receipt the decoder genuinely reads: `SourceTxFixture` builds the
/// prover's chunked composite, and each submission passes through `getTransactionType`,
/// `decodeReceiptFields`, and `getLogsByEventSignature` unmodified.
contract ReplayResistanceTest is Test {
    // ------------------------------------------------------------------ deployed tree

    /// @notice Registry of emitters, Collection Addresses, prices, and tiers.
    ServiceRegistry internal registry;

    /// @notice Registry that binds Source Chain payer addresses to Agents.
    AgentRegistry internal agents;

    /// @notice Bond the book reads stake presence from, so a Credit Limit exists at all.
    Bond internal bond;

    /// @notice Book the verifier applies Verified Settlements to.
    TabBook internal book;

    /// @notice Contract under test, through which every submission below is made.
    SettlementVerifier internal verifier;

    /// @notice The etched stand-in for the BlockProver Precompile.
    MockBlockProver internal prover;

    // ------------------------------------------------------------------ constants

    /// @notice Address the BlockProver Precompile lives at, which is where the mock is etched.
    address internal constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;

    /// @notice Attested-chain identifier of Ethereum Sepolia, the chain carrying `TabSettlement`.
    uint64 internal constant CHAIN_SEPOLIA = 1;

    /// @notice Attested-chain identifier of Ethereum Mainnet, where Tab deploys nothing.
    uint64 internal constant CHAIN_MAINNET = 3;

    /// @notice The Agent every credited base unit below is credited to.
    address internal constant AGENT = address(0xA6E7);

    /// @notice Creditcoin address that operates the Service and holds its Bond party key.
    address internal constant OPERATOR = address(0x0FE1);

    /// @notice The wired Watcher. Present only because the book takes one; never called here.
    address internal constant WATCHER = address(0x3A7C);

    /// @notice Source Chain address bound to {AGENT} on both chains, so every generated log resolves.
    address internal constant PAYER = address(0x9A7E);

    /// @notice The launch Asset on Ethereum Mainnet.
    address internal constant USDC = address(0x05DC);

    /// @notice The Asset accepted on Ethereum Sepolia, authorised on chainKey 1 alone.
    address internal constant SEPOLIA_ASSET = address(0x05D1);

    /// @notice An Asset contract authorised on no chain at all, which is what the skipped logs carry.
    /// @dev Authorised *nowhere*, not merely elsewhere. The two are different outcomes: this one is
    /// skipped, an emitter authorised on another chain reverts, and only the first is Requirement 4.5.
    address internal constant UNKNOWN_ASSET = address(0x05FF);

    /// @notice Collection Address for {USDC} on Ethereum Mainnet.
    address internal constant COLLECTION_MAINNET = address(0xC011);

    /// @notice Collection Address for {SEPOLIA_ASSET} on Ethereum Sepolia.
    address internal constant COLLECTION_SEPOLIA = address(0xC013);

    /// @notice The Source Chain settlement contract authorised on chainKey 1.
    address internal constant SETTLEMENT_SEPOLIA = address(0x5E71);

    /// @notice The one registered Service, so one tab per Asset and one Bond party.
    bytes32 internal constant SERVICE = keccak256("replay-resistance-service");

    /// @notice The one named priced tool.
    bytes32 internal constant TOOL = keccak256("proof");

    /// @notice Price of one unit of {TOOL} in Asset base units.
    uint256 internal constant PRICE = 1_000;

    /// @notice Baseline Credit Limit in Asset base units.
    uint256 internal constant BASELINE = 5_000_000;

    /// @notice Growth factor in basis points. Never engaged: no delivery is metered here.
    uint256 internal constant GROWTH_BPS = 5_000;

    /// @notice Settlement Window the Service registers, in seconds.
    uint32 internal constant WINDOW = 6 hours;

    /// @notice Stake the Service holds in each Asset, which is what makes a Credit Limit non-zero.
    uint128 internal constant BOND_STAKE = 10_000_000;

    /// @notice Wall clock the campaign starts from.
    uint64 internal constant START = 1_700_000_000;

    /// @notice Largest number of recognised Settlement logs one generated receipt carries.
    /// @dev Five, from the task's `recognisedLogs: 0..5`. The interesting cases are at the low end —
    /// zero drives Requirement 4.6 and two drives the batching case Requirement 4.3 exists for — and a
    /// wider receipt buys nothing the ordinal sweep does not already exercise at five.
    uint256 internal constant MAX_RECOGNISED = 5;

    /// @notice Largest number of zero-topic logs one generated receipt carries, from `0..3`.
    uint256 internal constant MAX_ZERO_TOPIC = 3;

    /// @notice Largest number of unknown-emitter logs one generated receipt carries, from `0..3`.
    uint256 internal constant MAX_UNKNOWN = 3;

    /// @notice Largest settled amount one generated Settlement log carries, in Asset base units.
    /// @dev Bounded so the totals a whole campaign run credits stay far inside the `uint128` figures a
    /// tab is kept in. The property under test is indifferent to magnitude; an amount that overflowed
    /// would fail on `AmountOutOfRange` and say nothing about replay keys.
    uint256 internal constant MAX_AMOUNT = 100_000;

    /// @notice Signature topic of `SettlementVerifier.SettlementRecorded`, used to count emissions.
    /// @dev Counted by topic rather than matched with `expectEmit`, because the clause is *how many*
    /// events a submission emitted, and a generated receipt fixes that number only at run time.
    bytes32 internal constant SETTLEMENT_RECORDED_SIG = keccak256(
        "SettlementRecorded(bytes32,uint64,uint64,uint64,uint64,address,bytes32,address,uint256,address,bytes32)"
    );

    /// @notice Source Chain block height of the next submission, so coordinates never collide by luck.
    uint64 internal nextHeight = 21_000_000;

    // ------------------------------------------------------------------ generated shapes

    /// @notice A generated receipt, together with what the contract must do with each of its logs.
    /// @dev The mask is the expectation, and it is built by the generator rather than derived from the
    /// contract afterwards. Asking the verifier which logs it recognised and then asserting it claimed
    /// those would assert nothing at all.
    /// @param entries Receipt logs in receipt order, recognised and skipped kinds interleaved.
    /// @param recognised Per ordinal, whether that log must be ingested under its own replay key.
    /// @param recognisedCount Number of `true` entries in the mask.
    /// @param creditedTotal Sum of the amounts the recognised logs carry, in Asset base units.
    struct GeneratedReceipt {
        EvmV1Decoder.LogEntryTuple[] entries;
        bool[] recognised;
        uint256 recognisedCount;
        uint256 creditedTotal;
    }

    /// @notice One generated submission: a receipt, and the three proven coordinates it arrives under.
    /// @param chainKey Attested-chain identifier the proof establishes.
    /// @param height Source Chain block height of the transaction.
    /// @param txIndex Index of the transaction within its block, which the precompile reports.
    /// @param encoded The prover's chunked composite of the transaction.
    /// @param receipt The generated receipt and its expectation.
    struct Submission {
        uint64 chainKey;
        uint64 height;
        uint64 txIndex;
        bytes encoded;
        GeneratedReceipt receipt;
    }

    // ------------------------------------------------------------------ setup

    /// @notice Deploys and wires the tree, etches the precompile, registers the Service, and binds.
    /// @dev The payer is bound on both chains before any case runs, because an unbound payer reverts
    /// `UnboundPayer` and every run would then measure that instead of the replay key.
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
        _fundBond();
        _bind(CHAIN_MAINNET);
        _bind(CHAIN_SEPOLIA);
    }

    /// @notice Registers the Service with an Asset on each chain and a Sepolia settlement contract.
    /// @dev Two accepted Assets and one settlement emitter are the minimum that makes both Settlement
    /// shapes and both chainKeys expressible from one registry, which the `chainKey` clause needs.
    function _registerService() private {
        uint64[] memory chainKeys = new uint64[](2);
        chainKeys[0] = CHAIN_MAINNET;
        chainKeys[1] = CHAIN_SEPOLIA;

        address[] memory assets = new address[](2);
        assets[0] = USDC;
        assets[1] = SEPOLIA_ASSET;

        address[] memory collections = new address[](2);
        collections[0] = COLLECTION_MAINNET;
        collections[1] = COLLECTION_SEPOLIA;

        bytes32[] memory tools = new bytes32[](1);
        tools[0] = TOOL;

        uint256[] memory prices = new uint256[](2);
        prices[0] = PRICE;
        prices[1] = PRICE;

        vm.prank(OPERATOR);
        registry.registerService(SERVICE, chainKeys, assets, collections, tools, prices, WINDOW);

        vm.prank(OPERATOR);
        registry.registerSettlementEmitter(SERVICE, CHAIN_SEPOLIA, SETTLEMENT_SEPOLIA, SEPOLIA_ASSET);
    }

    /// @notice Credits the Service's stake in both Assets, so a Credit Limit exists at all.
    /// @dev The prank is a fixture shortcut. Stake is created only by a proven deposit, and that path
    /// is proven end to end elsewhere; what this campaign needs is for the stake to already be there,
    /// so that a run measures replay behaviour rather than how the Bond got funded.
    function _fundBond() private {
        address bondAccount = registry.serviceOf(SERVICE).bondAccount;
        bytes32 party = bond.partyOf(bondAccount);

        vm.prank(address(verifier));
        bond.fundFromVerifiedSettlement(party, USDC, BOND_STAKE, keccak256("bond-deposit-usdc"));

        vm.prank(address(verifier));
        bond.fundFromVerifiedSettlement(party, SEPOLIA_ASSET, BOND_STAKE, keccak256("bond-deposit-sepolia"));
    }

    /// @notice Bind {PAYER} to {AGENT} on one chain by paying the amount the registry issues.
    /// @dev The honest path and the only one there is: the registry hands out an exact amount and a
    /// Verified Settlement of that amount from that address is what proves control of it.
    /// @param chainKey Attested-chain identifier to bind on.
    function _bind(uint64 chainKey) private {
        vm.prank(AGENT);
        (, uint256 amount,) = agents.requestBinding(chainKey, PAYER);

        EvmV1Decoder.LogEntryTuple[] memory entries = SourceTxFixture.one(
            SourceTxFixture.transferLog(_assetOf(chainKey), PAYER, _collectionOf(chainKey), amount)
        );

        prover.setTxIndex(0);
        verifier.submitSettlement(_sourceTx(chainKey, nextHeight++, SourceTxFixture.encode(PAYER, entries)));
    }

    // ------------------------------------------------------------------ generators

    /// @notice `genChainKey`: one of the two attested chains Tab settles from.
    /// @dev Both, and nothing else, because an unsupported chainKey is rejected before any proof call
    /// and so never reaches the ingestion path this campaign is about.
    /// @param seed Fuzzed word.
    /// @return chainKey Either chainKey 1 or chainKey 3.
    function _genChainKey(uint256 seed) internal pure returns (uint64 chainKey) {
        chainKey = seed % 2 == 0 ? CHAIN_SEPOLIA : CHAIN_MAINNET;
    }

    /// @notice `genReceipt`: a receipt of recognised, zero-topic, and unknown-emitter logs, shuffled.
    /// @dev Three independent counts within the task's bounds, then a Fisher-Yates interleave, so a
    /// recognised log can sit at any ordinal and a skipped log can sit before, between, or after the
    /// Settlements. The three kinds are exactly the three cases the sweep distinguishes: ingest, skip
    /// on zero topics (R4.4), and skip on an emitter authorised nowhere (R4.5).
    ///
    /// Two details are deliberate rather than incidental. The unknown-emitter logs carry a *recognised*
    /// signature topic, so `getLogsByEventSignature` returns them and the cross-check has to reject
    /// them on the emitter alone — a recognition rule that matched on signature would fail here rather
    /// than pass quietly. And half the zero-topic logs are emitted by the chain's own authorised Asset,
    /// so the zero-topic skip is shown to happen before recognition and not because the emitter was
    /// unknown as well.
    /// @param chainKey Attested-chain identifier the receipt will be submitted under.
    /// @param seed Fuzzed word, consumed in disjoint bit ranges.
    /// @param minRecognised Floor on recognised logs: zero to allow the empty case, one to exclude it.
    /// @return receipt The generated receipt and its expectation.
    function _genReceipt(uint64 chainKey, uint256 seed, uint256 minRecognised)
        internal
        pure
        returns (GeneratedReceipt memory receipt)
    {
        uint256 recognisedLogs = minRecognised + (seed % (MAX_RECOGNISED + 1 - minRecognised));
        uint256 zeroTopicLogs = (seed >> 32) % (MAX_ZERO_TOPIC + 1);
        uint256 unknownLogs = (seed >> 64) % (MAX_UNKNOWN + 1);
        uint256 total = recognisedLogs + zeroTopicLogs + unknownLogs;

        uint256[] memory kinds = new uint256[](total);
        for (uint256 i = 0; i < total; ++i) {
            kinds[i] = i < recognisedLogs ? 0 : (i < recognisedLogs + zeroTopicLogs ? 1 : 2);
        }
        _shuffle(kinds, seed >> 96);

        receipt.entries = new EvmV1Decoder.LogEntryTuple[](total);
        receipt.recognised = new bool[](total);

        for (uint256 i = 0; i < total; ++i) {
            uint256 draw = uint256(keccak256(abi.encode(seed, i)));
            uint256 amount = 1 + (draw % MAX_AMOUNT);

            if (kinds[i] == 0) {
                receipt.entries[i] = _settlementLog(chainKey, amount, draw);
                receipt.recognised[i] = true;
                receipt.creditedTotal += amount;
                ++receipt.recognisedCount;
            } else if (kinds[i] == 1) {
                receipt.entries[i] =
                    SourceTxFixture.zeroTopicLog(draw % 2 == 0 ? _assetOf(chainKey) : UNKNOWN_ASSET);
            } else {
                receipt.entries[i] =
                    SourceTxFixture.transferLog(UNKNOWN_ASSET, PAYER, _collectionOf(chainKey), amount);
            }
        }
    }

    /// @notice `genSubmissionOrder`: a permutation of the submissions, optionally with every one twice.
    /// @dev Duplication is total rather than sampled — the doubled index list is shuffled as one, so a
    /// replay can land before, immediately after, or many steps after its first attempt, and every
    /// submission is replayed in every run. Sampling duplicates would leave the clause untested on
    /// whichever members the sampler missed.
    /// @param seed Fuzzed word driving the shuffle.
    /// @param count Number of distinct submissions.
    /// @param withDuplicates True to include each submission twice.
    /// @return order Indices into the submission array, in the order they will be submitted.
    function _genSubmissionOrder(uint256 seed, uint256 count, bool withDuplicates)
        internal
        pure
        returns (uint256[] memory order)
    {
        uint256 length = withDuplicates ? count * 2 : count;
        order = new uint256[](length);
        for (uint256 i = 0; i < length; ++i) {
            order[i] = i % count;
        }
        _shuffle(order, seed);
    }

    /// @notice One recognised Settlement log, in whichever shape the chain recognises.
    /// @dev On chainKey 1 both shapes exist, so the draw picks between a plain `Transfer` from the
    /// Asset and a `TabSettled` from the settlement contract; on chainKey 3 Tab deploys nothing and a
    /// `Transfer` is the only Settlement there is. Both put the payer in `topics[1]`, so both credit
    /// the same Agent, which is what lets one expectation cover the pair.
    /// @param chainKey Attested-chain identifier the log will be submitted under.
    /// @param amount Settled amount in Asset base units.
    /// @param draw Fuzz-derived word choosing the shape and the `tabId`.
    /// @return entry The log entry.
    function _settlementLog(uint64 chainKey, uint256 amount, uint256 draw)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple memory entry)
    {
        if (chainKey == CHAIN_SEPOLIA && draw % 2 == 0) {
            entry = SourceTxFixture.tabSettledLog(
                SETTLEMENT_SEPOLIA, PAYER, COLLECTION_SEPOLIA, amount, bytes32(draw)
            );
        } else {
            entry = SourceTxFixture.transferLog(_assetOf(chainKey), PAYER, _collectionOf(chainKey), amount);
        }
    }

    /// @notice Fisher-Yates shuffle in place, so an order is a genuine permutation of its input.
    /// @dev In place and unbiased, which matters for the receipt interleave: a sort by hash would
    /// correlate a log's kind with its ordinal and quietly stop generating some arrangements.
    /// @param items The array to permute.
    /// @param seed Fuzzed word driving the swaps.
    function _shuffle(uint256[] memory items, uint256 seed) internal pure {
        for (uint256 i = items.length; i > 1; --i) {
            uint256 j = uint256(keccak256(abi.encode(seed, i))) % i;
            (items[i - 1], items[j]) = (items[j], items[i - 1]);
        }
    }

    // ------------------------------------------------------------------ submission helpers

    /// @notice One Source Chain transaction with its proof material, ready to submit.
    /// @dev The proof material is inert, because the etched precompile is what decides whether a proof
    /// holds. What matters is that the struct is populated exactly as a real submission would be, so
    /// the mock decodes real fields rather than accepting anything at all.
    /// @param chainKey Attested-chain identifier to submit under.
    /// @param height Source Chain block height to submit at.
    /// @param encoded The prover's chunked composite of the transaction.
    /// @return sourceTx The submission.
    function _sourceTx(uint64 chainKey, uint64 height, bytes memory encoded)
        internal
        pure
        returns (TabAscBase.SourceTx memory sourceTx)
    {
        sourceTx.chainKey = chainKey;
        sourceTx.blockHeight = height;
        sourceTx.encodedTransaction = encoded;
        sourceTx.merkleProof = INativeQueryVerifier.MerkleProof({
            root: keccak256(abi.encode(chainKey, height)),
            siblings: new INativeQueryVerifier.MerkleProofEntry[](0)
        });
        sourceTx.continuityProof = INativeQueryVerifier.ContinuityProof({
            lowerEndpointDigest: keccak256(abi.encode("endpoint", height)), roots: new bytes32[](0)
        });
    }

    /// @notice Assemble a submission from a generated receipt at the next unused height.
    /// @dev The transaction sender is {PAYER} here, which is incidental: payer resolution reads
    /// `topics[1]` and never the transaction's `from` field, and that is a different campaign's claim.
    /// @param chainKey Attested-chain identifier to submit under.
    /// @param txIndex Index the precompile will report for this transaction.
    /// @param receipt The generated receipt.
    /// @return submission The assembled submission.
    function _submissionOf(uint64 chainKey, uint64 txIndex, GeneratedReceipt memory receipt)
        internal
        returns (Submission memory submission)
    {
        submission.chainKey = chainKey;
        submission.height = nextHeight++;
        submission.txIndex = txIndex;
        submission.encoded = SourceTxFixture.encode(PAYER, receipt.entries);
        submission.receipt = receipt;
    }

    /// @notice Submit one assembled submission, reporting the coordinates it arrived under.
    /// @param submission The submission.
    /// @return ingested Number of Settlement logs the submission ingested.
    function _submit(Submission memory submission) internal returns (uint256 ingested) {
        prover.setTxIndex(submission.txIndex);
        ingested =
            verifier.submitSettlement(_sourceTx(submission.chainKey, submission.height, submission.encoded));
    }

    /// @notice Submit an order of submissions, tolerating replays and nothing else.
    /// @dev A replay must be refused with `AlreadyClaimed` and a first attempt must succeed, so the
    /// two counters this returns are themselves an assertion: any other revert fails on the selector
    /// check inside the loop rather than being swallowed as a tolerated failure.
    /// @param submissions The distinct submissions.
    /// @param order Indices into `submissions`, in submission order.
    /// @return successes Number of calls that ingested logs.
    /// @return refusals Number of calls refused as replays.
    function _runOrder(Submission[] memory submissions, uint256[] memory order)
        internal
        returns (uint256 successes, uint256 refusals)
    {
        for (uint256 i = 0; i < order.length; ++i) {
            Submission memory submission = submissions[order[i]];
            prover.setTxIndex(submission.txIndex);

            try verifier.submitSettlement(
                _sourceTx(submission.chainKey, submission.height, submission.encoded)
            ) returns (
                uint256 ingested
            ) {
                assertEq(ingested, submission.receipt.recognisedCount, "ingested every recognised log");
                ++successes;
            } catch (bytes memory reason) {
                // casting to 'bytes4' is the standard selector read: a custom-error revert carries its
                // four-byte selector first, and the argument that follows it is asserted separately.
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes4 selector = bytes4(reason);
                assertEq(selector, TabAscBase.AlreadyClaimed.selector, "only a replay may be refused");
                ++refusals;
            }
        }
    }

    // ------------------------------------------------------------------ observation helpers

    /// @notice The launch Asset of one chain.
    /// @param chainKey Attested-chain identifier.
    /// @return asset The Asset every Settlement on that chain is denominated in.
    function _assetOf(uint64 chainKey) internal pure returns (address asset) {
        asset = chainKey == CHAIN_SEPOLIA ? SEPOLIA_ASSET : USDC;
    }

    /// @notice The Collection Address of the one Service on one chain.
    /// @param chainKey Attested-chain identifier.
    /// @return collection The address Settlements on that chain are paid to.
    function _collectionOf(uint64 chainKey) internal pure returns (address collection) {
        collection = chainKey == CHAIN_SEPOLIA ? COLLECTION_SEPOLIA : COLLECTION_MAINNET;
    }

    /// @notice Open Tab and prepaid credit of {AGENT} for one Asset.
    /// @param asset Asset to read.
    /// @return open Open Tab in Asset base units.
    /// @return prepaid Prepaid credit in Asset base units.
    function _tab(address asset) internal view returns (uint128 open, uint128 prepaid) {
        ITabBook.Tab memory tab = book.tabOf(book.tabIdOf(AGENT, SERVICE, asset));
        open = tab.open;
        prepaid = tab.prepaid;
    }

    /// @notice Total credited value of {AGENT} across both launch Assets.
    /// @dev Prepaid credit rather than the Open Tab, because no delivery is metered in this campaign,
    /// so every settled base unit lands as prepaid credit and the sum is the amount that was credited.
    /// @return total Credited base units, summed over the two Assets.
    function _creditedTotal() internal view returns (uint256 total) {
        (uint128 openMainnet, uint128 prepaidMainnet) = _tab(USDC);
        (uint128 openSepolia, uint128 prepaidSepolia) = _tab(SEPOLIA_ASSET);
        assertEq(openMainnet, 0, "no Open Tab exists on Mainnet");
        assertEq(openSepolia, 0, "no Open Tab exists on Sepolia");
        total = uint256(prepaidMainnet) + uint256(prepaidSepolia);
    }

    /// @notice Digest of the terminal state the header defines, over one set of submissions.
    /// @dev The claimed bit and the ingestion record of every coordinate the submissions could touch,
    /// then the value totals. Deliberately excludes the rolling history commitment, which chains
    /// applied records in order and so cannot be order-independent; the header argues why that is the
    /// right exclusion rather than a convenient one.
    /// @param submissions The submissions whose coordinate space is digested.
    /// @return digest One word standing for the whole terminal state.
    function _terminalDigest(Submission[] memory submissions) internal view returns (bytes32 digest) {
        bytes memory accumulated;

        for (uint256 i = 0; i < submissions.length; ++i) {
            Submission memory submission = submissions[i];
            for (uint256 j = 0; j < submission.receipt.entries.length; ++j) {
                // casting to 'uint64' is safe because a receipt here holds at most eleven logs.
                // forge-lint: disable-next-line(unsafe-typecast)
                uint64 logIndex = uint64(j);
                bytes32 key =
                    verifier.replayKey(submission.chainKey, submission.height, submission.txIndex, logIndex);
                accumulated =
                    abi.encodePacked(accumulated, key, verifier.claimedLog(key), verifier.ingestedAt(key));
            }
        }

        (uint128 openMainnet, uint128 prepaidMainnet) = _tab(USDC);
        (uint128 openSepolia, uint128 prepaidSepolia) = _tab(SEPOLIA_ASSET);
        digest = keccak256(
            abi.encodePacked(accumulated, openMainnet, prepaidMainnet, openSepolia, prepaidSepolia)
        );
    }

    /// @notice Count the `SettlementRecorded` events the verifier emitted since recording started.
    /// @param expected Number of events the caller expects.
    function _assertRecordedEvents(uint256 expected) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(verifier) && logs[i].topics[0] == SETTLEMENT_RECORDED_SIG) {
                ++seen;
            }
        }
        assertEq(seen, expected, "one SettlementRecorded event per ingested log");
    }
}

/// @title ReplayResistanceIngestionTest
/// @notice Clauses 1 to 5: which logs of a generated receipt are ingested, under which keys, and what
/// happens to a receipt that holds no Settlement at all.
/// @dev Separated from the ordering clauses because these cases are about one submission and those are
/// about a sequence of them, and a campaign that mixed the two would report a failing step rather than
/// a failing clause.
contract ReplayResistanceIngestionTest is ReplayResistanceTest {
    /// @notice Every recognised log is ingested under its own distinct key; every skipped log is not.
    /// @dev The single densest clause of the property, and each half of it is load-bearing. Ingesting
    /// *every* recognised log is Requirement 4.3, which a transaction-scoped replay key would fail by
    /// crediting the first Settlement of a batched payment and dropping the rest. Ingesting *only*
    /// those is Requirements 4.4 and 4.5, which a sweep that reverted on an unrelated log would fail by
    /// stranding real payments beside somebody else's event.
    ///
    /// The keys are asserted pairwise distinct rather than trusted to be, because `logIndex` is the
    /// only field that separates two Settlements in one transaction, and a key that dropped it would
    /// still look correct on a single-log receipt.
    /// @param receiptSeed Drives the three log counts, the interleave, the shapes, and the amounts.
    /// @param chainSeed Drives the chainKey.
    /// @param txIndexSeed Drives the transaction index the precompile reports.
    function testFuzz_everyRecognisedLogIsClaimedUnderItsOwnKey(
        uint256 receiptSeed,
        uint256 chainSeed,
        uint64 txIndexSeed
    ) public {
        uint64 chainKey = _genChainKey(chainSeed);
        uint64 txIndex = txIndexSeed % 4096;
        GeneratedReceipt memory receipt = _genReceipt(chainKey, receiptSeed, 0);
        Submission memory submission = _submissionOf(chainKey, txIndex, receipt);

        uint256 creditedBefore = _creditedTotal();

        if (receipt.recognisedCount == 0) {
            _assertNothingRecognisedReverts(submission, creditedBefore);
            return;
        }

        vm.recordLogs();
        uint256 ingested = _submit(submission);

        assertEq(ingested, receipt.recognisedCount, "every recognised log was ingested and no other");
        _assertRecordedEvents(receipt.recognisedCount);

        bytes32[] memory keys = new bytes32[](receipt.recognisedCount);
        uint256 found;

        for (uint256 j = 0; j < receipt.entries.length; ++j) {
            // casting to 'uint64' is safe because a generated receipt holds at most eleven logs.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 logIndex = uint64(j);
            bytes32 key = verifier.replayKey(chainKey, submission.height, txIndex, logIndex);

            if (receipt.recognised[j]) {
                assertTrue(verifier.claimedLog(key), "recognised log claimed under its own key");
                // casting to 'uint64' is safe because a Creditcoin block number stays far below 2^64,
                // which is the same bound the contract narrows under when it records the ingestion.
                // forge-lint: disable-next-line(unsafe-typecast)
                uint64 ingestedIn = uint64(block.number);
                assertEq(verifier.ingestedAt(key), ingestedIn, "ingestion recorded");
                keys[found++] = key;
            } else {
                assertFalse(verifier.claimedLog(key), "skipped log claims no key");
                assertEq(verifier.ingestedAt(key), 0, "skipped log records no ingestion");
            }
        }

        for (uint256 a = 0; a < keys.length; ++a) {
            for (uint256 b = a + 1; b < keys.length; ++b) {
                assertTrue(keys[a] != keys[b], "each ingested log claims a distinct replay key");
            }
        }

        assertEq(
            _creditedTotal() - creditedBefore, receipt.creditedTotal, "exactly the settled amounts landed"
        );
    }

    /// @notice A receipt with nothing recognised reverts, claims no key, and credits nothing.
    /// @dev Factored out of the clause above so the empty case is asserted in full rather than by an
    /// early return. Zero recognised Settlements is not a no-op submission: it is a submission that
    /// establishes nothing, so Requirement 4.6 makes it a revert rather than a silent success.
    /// @param submission The submission whose receipt holds no recognised Settlement.
    /// @param creditedBefore Credited total measured before the attempt.
    function _assertNothingRecognisedReverts(Submission memory submission, uint256 creditedBefore) private {
        prover.setTxIndex(submission.txIndex);

        vm.expectRevert(
            abi.encodeWithSelector(
                TabAscBase.NoRecognisedSettlement.selector,
                submission.chainKey,
                submission.height,
                submission.txIndex
            )
        );
        verifier.submitSettlement(_sourceTx(submission.chainKey, submission.height, submission.encoded));

        for (uint256 j = 0; j < submission.receipt.entries.length; ++j) {
            // casting to 'uint64' is safe because a generated receipt holds at most eleven logs.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 logIndex = uint64(j);
            bytes32 key =
                verifier.replayKey(submission.chainKey, submission.height, submission.txIndex, logIndex);
            assertFalse(verifier.claimedLog(key), "a rejected submission claims nothing");
        }

        assertEq(_creditedTotal(), creditedBefore, "a rejected submission credits nothing");
    }

    /// @notice Repeated identical Settlement logs in one transaction are each claimable.
    /// @dev The case that decides whether the key is log-scoped, put as sharply as it can be put: the
    /// logs are byte-identical, same emitter, same payer, same recipient, same amount, so `logIndex` is
    /// the only thing that distinguishes them. An Agent that pays a Service twice in one transaction
    /// has moved money twice and must be credited twice, which is exactly what a transaction-scoped or
    /// content-scoped guard would refuse.
    /// @param amountSeed Drives the amount and the Settlement shape.
    /// @param chainSeed Drives the chainKey.
    /// @param countSeed Drives how many identical logs the transaction carries.
    function testFuzz_repeatedIdenticalLogsInOneTransactionAreEachClaimable(
        uint256 amountSeed,
        uint256 chainSeed,
        uint256 countSeed
    ) public {
        uint64 chainKey = _genChainKey(chainSeed);
        uint256 count = bound(countSeed, 2, MAX_RECOGNISED);
        uint256 amount = 1 + (amountSeed % MAX_AMOUNT);

        GeneratedReceipt memory receipt;
        receipt.entries = new EvmV1Decoder.LogEntryTuple[](count);
        receipt.recognised = new bool[](count);
        receipt.recognisedCount = count;
        receipt.creditedTotal = count * amount;

        EvmV1Decoder.LogEntryTuple memory entry = _settlementLog(chainKey, amount, amountSeed);
        for (uint256 i = 0; i < count; ++i) {
            receipt.entries[i] = entry;
            receipt.recognised[i] = true;
        }

        Submission memory submission = _submissionOf(chainKey, 0, receipt);
        uint256 creditedBefore = _creditedTotal();

        vm.recordLogs();
        assertEq(_submit(submission), count, "every identical log was ingested");
        _assertRecordedEvents(count);

        for (uint256 j = 0; j < count; ++j) {
            // casting to 'uint64' is safe because `count` is at most five.
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes32 key = verifier.replayKey(chainKey, submission.height, 0, uint64(j));
            assertTrue(verifier.claimedLog(key), "each ordinal claimed its own key");
        }

        assertEq(_creditedTotal() - creditedBefore, count * amount, "every identical log was credited");
    }

    /// @notice Each of the four coordinates separates two otherwise identical submissions.
    /// @dev Four submissions of the same Settlement, differing in one coordinate each, all of which
    /// must be claimable, followed by the exact repeat that must not be. That pairing is what makes the
    /// clause an exactness claim rather than a permissiveness one: a key missing a coordinate would
    /// wrongly refuse one of the first four, and a key that recorded nothing would wrongly accept the
    /// fifth.
    ///
    /// The chainKey arm carries each chain's own Settlement shape, because a Mainnet Asset is not
    /// authorised on Sepolia and pretending otherwise would test the registry instead. The coordinates
    /// are what is held equal.
    /// @param amountSeed Drives the settled amount.
    function testFuzz_eachCoordinateOfTheReplayKeyIsLoadBearing(uint256 amountSeed) public {
        uint256 amount = 1 + (amountSeed % MAX_AMOUNT);
        uint64 height = nextHeight;
        uint64 txIndex = 4;
        nextHeight += 4;

        bytes memory mainnet = SourceTxFixture.encode(
            PAYER, SourceTxFixture.one(SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_MAINNET, amount))
        );
        bytes memory sepolia = SourceTxFixture.encode(
            PAYER,
            SourceTxFixture.one(SourceTxFixture.transferLog(SEPOLIA_ASSET, PAYER, COLLECTION_SEPOLIA, amount))
        );

        prover.setTxIndex(txIndex);
        assertEq(
            verifier.submitSettlement(_sourceTx(CHAIN_MAINNET, height, mainnet)), 1, "the first submission"
        );
        assertEq(
            verifier.submitSettlement(_sourceTx(CHAIN_SEPOLIA, height, sepolia)),
            1,
            "a different chainKey is a different key"
        );
        assertEq(
            verifier.submitSettlement(_sourceTx(CHAIN_MAINNET, height + 1, mainnet)),
            1,
            "a different blockHeight is a different key"
        );

        prover.setTxIndex(txIndex + 1);
        assertEq(
            verifier.submitSettlement(_sourceTx(CHAIN_MAINNET, height, mainnet)),
            1,
            "a different txIndex is a different key"
        );

        EvmV1Decoder.LogEntryTuple[] memory pair = new EvmV1Decoder.LogEntryTuple[](2);
        pair[0] = SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_MAINNET, amount);
        pair[1] = pair[0];
        prover.setTxIndex(txIndex);
        assertEq(
            verifier.submitSettlement(
                _sourceTx(CHAIN_MAINNET, height + 2, SourceTxFixture.encode(PAYER, pair))
            ),
            2,
            "a different logIndex is a different key"
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                TabAscBase.AlreadyClaimed.selector, verifier.replayKey(CHAIN_MAINNET, height, txIndex, 0)
            )
        );
        verifier.submitSettlement(_sourceTx(CHAIN_MAINNET, height, mainnet));
    }
}

/// @title ReplayResistanceOrderTest
/// @notice Clauses 6 and 8: what a resubmission does, and what a shuffled, duplicated order reaches.
/// @dev The refusal clause and the ordering clause share a subject — a replay key already recorded —
/// and differ in scale. One submission twice pins the error and the state; several submissions in an
/// arbitrary order with every one replayed pins that the outcome does not depend on the sequence.
contract ReplayResistanceOrderTest is ReplayResistanceTest {
    /// @notice A resubmitted log is refused, moves nothing, and does not poison fresh coordinates.
    /// @dev Three assertions in one case, because the third is what stops the second from being
    /// satisfiable the wrong way. A guard keyed on the transaction bytes would also refuse the replay
    /// and also leave state untouched, and would then wrongly refuse the identical Settlement shape at
    /// a different height — which is an ordinary thing for an Agent to do, since the same payment made
    /// twice on different days produces identical bytes. Requirement 4.2 is a claim about the tuple.
    /// @param receiptSeed Drives the receipt, which is forced to hold at least one Settlement.
    /// @param chainSeed Drives the chainKey.
    function testFuzz_aResubmittedLogIsRefusedAndNothingMoves(uint256 receiptSeed, uint256 chainSeed) public {
        uint64 chainKey = _genChainKey(chainSeed);
        GeneratedReceipt memory receipt = _genReceipt(chainKey, receiptSeed, 1);
        Submission memory submission = _submissionOf(chainKey, 0, receipt);

        assertEq(_submit(submission), receipt.recognisedCount, "the first submission ingested");

        Submission[] memory only = new Submission[](1);
        only[0] = submission;
        bytes32 settled = _terminalDigest(only);
        uint256 creditedAfterFirst = _creditedTotal();

        uint64 firstRecognised;
        while (!receipt.recognised[firstRecognised]) {
            ++firstRecognised;
        }

        prover.setTxIndex(submission.txIndex);
        vm.expectRevert(
            abi.encodeWithSelector(
                TabAscBase.AlreadyClaimed.selector,
                verifier.replayKey(chainKey, submission.height, submission.txIndex, firstRecognised)
            )
        );
        verifier.submitSettlement(_sourceTx(chainKey, submission.height, submission.encoded));

        assertEq(_terminalDigest(only), settled, "the refused replay changed no claimed key");
        assertEq(_creditedTotal(), creditedAfterFirst, "the refused replay credited nothing");

        Submission memory fresh = _submissionOf(chainKey, submission.txIndex, receipt);
        assertEq(
            _submit(fresh), receipt.recognisedCount, "identical content at fresh coordinates still credits"
        );
        assertEq(
            _creditedTotal() - creditedAfterFirst,
            receipt.creditedTotal,
            "the fresh submission credited its own amounts"
        );
    }

    /// @notice Two shuffled orders, one of them replaying every submission, reach the same state.
    /// @dev Both orders are shuffled and the second replays every member, so the comparison is between
    /// two arbitrary sequences rather than between a tidy sequence and a messy one. The state is
    /// captured, reverted, and rebuilt, which is what makes this an equality between two runs of the
    /// same contract rather than an equality against a figure this test computed for itself.
    ///
    /// The two counters are part of the claim: as many successes as there are distinct submissions, so
    /// no submission was lost to an earlier one's replay, and as many refusals as there are duplicates,
    /// so no duplicate was quietly ingested twice. Any revert that is not `AlreadyClaimed` fails inside
    /// the runner rather than being counted.
    /// @param receiptSeed Drives every receipt, every chainKey, and every transaction index.
    /// @param orderSeed Drives both submission orders.
    /// @param countSeed Drives how many distinct submissions the run carries.
    function testFuzz_shuffledAndDuplicatedOrdersReachTheSameTerminalState(
        uint256 receiptSeed,
        uint256 orderSeed,
        uint256 countSeed
    ) public {
        uint256 count = bound(countSeed, 2, 4);
        Submission[] memory submissions = new Submission[](count);

        for (uint256 i = 0; i < count; ++i) {
            uint256 seed = uint256(keccak256(abi.encode(receiptSeed, i)));
            uint64 chainKey = _genChainKey(seed);
            // casting to 'uint64' is safe because the modulus is eight.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 txIndex = uint64(seed % 8);
            submissions[i] = _submissionOf(chainKey, txIndex, _genReceipt(chainKey, seed, 1));
        }

        uint256 snapshot = vm.snapshotState();

        (uint256 firstSuccesses, uint256 firstRefusals) =
            _runOrder(submissions, _genSubmissionOrder(orderSeed, count, false));
        assertEq(firstSuccesses, count, "every distinct submission ingested once");
        assertEq(firstRefusals, 0, "an order without duplicates refuses nothing");

        bytes32 firstDigest = _terminalDigest(submissions);
        uint256 firstCredited = _creditedTotal();

        assertTrue(vm.revertToState(snapshot), "state restored before the second order");

        (uint256 secondSuccesses, uint256 secondRefusals) =
            _runOrder(submissions, _genSubmissionOrder(orderSeed ^ 1, count, true));
        assertEq(secondSuccesses, count, "each submission succeeded exactly once");
        assertEq(secondRefusals, count, "each duplicate was refused exactly once");

        assertEq(_terminalDigest(submissions), firstDigest, "both orders reached the same terminal state");
        assertEq(_creditedTotal(), firstCredited, "both orders credited the same value");
    }
}
