// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
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

// Feature: tab, Property 3: Source-chain authentication requires the pair
//
// **Validates: Requirements 2.3, 2.4, 2.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.4, 6.5**
//
// For any set of authorised `(chainKey, emitter)` pairs, and for any submission that varies chainKey
// over {1, 3} and emitter over the registered, cross-chain, and unregistered emitter sets
// independently, acceptance occurs exactly where the submitted pair is authorised and the log's
// `topics[0]` is the signature that pair's emitter kind may produce. A matching emitter under the
// wrong chainKey reverts `UnauthorizedSourceChain`, a matching chainKey with an emitter authorised
// nowhere is skipped rather than reverting, and a signature no emitter kind may produce resolves
// nothing.
//
// **The generators.** Three, named by task 10.7 and implemented as the functions the comments below
// point at.
//
//   - `genRegistry(emitters, chainKeys)` is {_registerService} plus {_registerEmitters}: seven emitter
//     addresses crossed with the two attested chains, covering every cell the property quantifies
//     over — an Asset on chainKey 1 alone, an Asset on chainKey 3 alone, one Asset address authorised
//     on both, a settlement contract on each chain, one address that is an Asset on chainKey 1 and a
//     settlement contract on chainKey 3, and one address authorised nowhere. The registry is fixed
//     rather than fuzzed because the property varies the *submission* against a set of authorised
//     pairs, and a fixed set makes every one of those cells reachable instead of merely likely.
//   - `genSubmission(chainKey, emitter)` is {_submission}: chainKey over {1, 3} and emitter over all
//     seven addresses, chosen independently, so the cross-chain and unregistered arms arise from the
//     product rather than from a hand-picked pairing. The recipient is drawn independently too, over
//     the Collection Address the emitter's Asset resolves to, a Collection Address on the same chain
//     collecting a different Asset, and an address no Service has claimed — which is what reaches
//     R2.3, R2.4, and R2.5.
//   - `genSignature` is {_signatureTopic}: the `Transfer` topic, the `TabSettled` topic, and a
//     signature no emitter kind may produce, shaped like a `Transfer` in topic and data arity so that
//     nothing but the signature word distinguishes it.
//
// **The oracle is written from the requirements, not read off the contract.** {_resolveOracle} takes
// the registry facts as inputs — which pair is authorised, for which kind, and what each Collection
// Address collects — and decides the outcome from the criteria: pair authorisation first (R5.1, R5.3),
// then the signature against the emitter kind and, for `TabSettled`, against chainKey 1 (R6.1, R6.4,
// R6.5), then the recipient resolution (R2.3, R2.4) and the emitting Asset's agreement with the Asset
// that recipient collects (R2.5). The registry is an input to the property; the decision is not.
//
// **Where the code is tighter than the design snippet, and why the code is right.** Section 3.3 of
// the design sketches `_isRecognised` with a `TabSettled` arm reading
// `sig == TAB_SETTLED_SIG && e.kind == SettlementContract` — kind-scoped only. `src/SettlementVerifier.sol`
// additionally requires `chainKey == CHAIN_KEY_SEPOLIA`, and that third conjunct is what R6.5 asks
// for in as many words. The code is right and the snippet is the stale one: Tab deploys no contract on
// chainKey 3, where a plain `Transfer` is the only Settlement shape, so a settlement contract
// authorised there would otherwise have its `TabSettled` credited on a chain that has no such
// contract. An oracle written from the snippet alone would expect the `(3, settlement contract,
// TabSettled)` cell to be accepted, the contract would legitimately skip it, and the failure would be
// the oracle's. This campaign's oracle carries the conjunct, and the cell it decides is exercised by
// emitter index 4 and by emitter index 5 under chainKey 3.
//
// **Every Collection Address in the matrix is `CollectionKind.Tab`, deliberately.** The `Bond` kind
// decides what an accepted Settlement *means* one step after this property ends — `_credit` routes a
// `Bond`-kind recipient to `Bond.fundFromVerifiedSettlement` instead of to `TabBook` — and it has no
// bearing on whether the `(chainKey, emitter)` pair authenticates. Mixing it in would change the
// acceptance witness from Asset to Asset without adding a cell to the pair table. The Bond branch is
// established by `test/BondFunding.t.sol`.
//
// **What this establishes.** For every cell of the generated space, over a real `ServiceRegistry`,
// `AgentRegistry`, `Bond`, and `TabBook`, with real `EvmV1Decoder` decoding of transaction fixtures:
// acceptance happens exactly on the pair-plus-signature cells the criteria name; each of the three
// refusals is the specific one the criteria name, with `UnauthorizedSourceChain` carrying the mask of
// the chains the emitter really is authorised on; an emitter authorised nowhere is skipped and the
// Settlement beside it in the same receipt still lands; and every accepted entry reaches `TabBook`
// carrying the chainKey the proof established (R5.4, R5.5). Identical addresses on two chains are
// distinguishable in both directions — emitter index 5 is an Asset on chainKey 1 and a settlement
// contract on chainKey 3, so one address accepts a `Transfer` on one chain and skips it on the other.
//
// **What it does not establish.** That a proof holds: the BlockProver Precompile does not exist
// locally and the etched stand-in answers `true`, so nothing here speaks to verification itself.
// Nothing about receipt status, replay-key exactness, batch shapes, or payer resolution, each of which
// is a property of its own. Nothing about the arity checks inside the two handlers, which are unit
// cases in `test/SettlementVerifier.t.sol`. And nothing about reachability on chain, since the
// registry is written by this test rather than by an operator against a deployed tree.
contract PairAuthenticationTest is Test {
    // ------------------------------------------------------------------ generated dimensions

    /// @notice The three signature words a generated log may carry in `topics[0]`.
    /// @dev `Random` is a word no emitter kind may produce. It is shaped like a `Transfer` in topic and
    /// data arity, so a cell that accepted it would be accepting on emitter authorisation alone.
    enum Sig {
        Transfer,
        TabSettled,
        Random
    }

    /// @notice What the criteria say becomes of one generated submission.
    /// @dev `Skipped` is the outcome for a log the sweep passes over. With that log alone in the
    /// receipt the submission carries no Settlement at all and `NoRecognisedSettlement` follows, which
    /// is why the same outcome means a revert in the single-log clause and a survivor in the
    /// companion clause.
    enum Outcome {
        Accepted,
        Skipped,
        WrongChain,
        NoCollection,
        WrongAsset
    }

    /// @notice One generated submission and the outcome the criteria give it.
    struct Submission {
        /// @dev Attested-chain identifier the submission is made under.
        uint64 chainKey;
        /// @dev Address that emits the generated log.
        address emitter;
        /// @dev Which signature the log carries.
        Sig signature;
        /// @dev The signature word itself, so the unregistered case is inspectable.
        bytes32 signatureTopic;
        /// @dev Recipient named by the log, in `topics[2]`.
        address recipient;
        /// @dev Settled amount in Asset base units.
        uint256 amount;
        /// @dev What the criteria say happens.
        Outcome outcome;
        /// @dev Asset the acceptance credits, and the zero address on every other outcome.
        address creditedAsset;
        /// @dev Asset the recipient collects, and the zero address where it collects nothing.
        address collectionAsset;
        /// @dev Chains the emitter is authorised on, as the registry's bitmask.
        uint64 mask;
    }

    // ------------------------------------------------------------------ addresses under test

    /// @notice Registry the emitter authorisations and Collection Address resolutions come from.
    ServiceRegistry internal registry;

    /// @notice Registry that binds Source Chain payer addresses to Agents.
    AgentRegistry internal agents;

    /// @notice Bond the tree needs to exist. No accepted cell below reaches it.
    Bond internal bond;

    /// @notice Book an accepted Settlement is applied to.
    TabBook internal book;

    /// @notice Contract under test.
    SettlementVerifier internal verifier;

    /// @notice The etched stand-in for the BlockProver Precompile.
    MockBlockProver internal prover;

    // ------------------------------------------------------------------ constants

    /// @notice Address the BlockProver Precompile lives at, which is where the mock is etched.
    address internal constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;

    /// @notice Attested-chain identifier of Ethereum Sepolia.
    uint64 internal constant CHAIN_SEPOLIA = 1;

    /// @notice Attested-chain identifier of Ethereum Mainnet.
    uint64 internal constant CHAIN_MAINNET = 3;

    /// @notice How many emitter addresses the generated space walks.
    uint256 internal constant EMITTER_COUNT = 7;

    /// @notice How many recipients the generated space walks.
    uint256 internal constant RECIPIENT_COUNT = 3;

    /// @notice The Agent every accepted cell credits.
    address internal constant AGENT = address(0xA6E7);

    /// @notice Creditcoin address that operates the Service.
    address internal constant OPERATOR = address(0x0FE1);

    /// @notice Source Chain address bound to {AGENT} on both chains.
    address internal constant PAYER = address(0x9A7E);

    /// @notice An Asset authorised on chainKey 1 alone.
    address internal constant ASSET_SEPOLIA = address(0x05D1);

    /// @notice An Asset authorised on chainKey 3 alone.
    address internal constant ASSET_MAINNET = address(0x05DC);

    /// @notice One Asset address authorised on both chains, each with its own Collection Address.
    address internal constant ASSET_BOTH = address(0x05D8);

    /// @notice A settlement contract authorised on chainKey 1, where `TabSettled` is a Settlement.
    address internal constant SETTLEMENT_SEPOLIA = address(0x5E71);

    /// @notice A settlement contract authorised on chainKey 3, where `TabSettled` is not a Settlement.
    address internal constant SETTLEMENT_MAINNET = address(0x5E73);

    /// @notice One address that is an Asset on chainKey 1 and a settlement contract on chainKey 3.
    /// @dev The strongest distinguishability cell in the matrix. The pair decides the kind, so the same
    /// word means two different things on two chains and neither reading leaks into the other.
    address internal constant DUAL_ROLE = address(0x5EA5);

    /// @notice An address authorised on no chain at all.
    address internal constant UNKNOWN_EMITTER = address(0x05FF);

    /// @notice Collection Address for {ASSET_SEPOLIA} on chainKey 1.
    address internal constant COLLECTION_SEPOLIA = address(0xC011);

    /// @notice Collection Address for {ASSET_BOTH} on chainKey 1.
    address internal constant COLLECTION_BOTH_SEPOLIA = address(0xC012);

    /// @notice Collection Address for {DUAL_ROLE} on chainKey 1, where that address is an Asset.
    address internal constant COLLECTION_DUAL_SEPOLIA = address(0xC013);

    /// @notice Collection Address for {ASSET_MAINNET} on chainKey 3.
    address internal constant COLLECTION_MAINNET = address(0xC021);

    /// @notice Collection Address for {ASSET_BOTH} on chainKey 3.
    address internal constant COLLECTION_BOTH_MAINNET = address(0xC022);

    /// @notice An address no Service has claimed on either chain.
    address internal constant UNCLAIMED_COLLECTION = address(0xC0FF);

    /// @notice The one registered Service, so every acceptance resolves to one Service identity.
    bytes32 internal constant SERVICE = keccak256("pair-authentication-service");

    /// @notice The one named priced tool. Present because registration takes a price list.
    bytes32 internal constant TOOL = keccak256("proof");

    /// @notice Price of one unit of {TOOL} in Asset base units.
    uint256 internal constant PRICE = 1_000;

    /// @notice Baseline Credit Limit. Never engaged: nothing here meters a delivery.
    uint256 internal constant BASELINE = 5_000_000;

    /// @notice Growth factor in basis points.
    uint256 internal constant GROWTH_BPS = 5_000;

    /// @notice Settlement Window the Service registers, in seconds.
    uint32 internal constant WINDOW = 6 hours;

    /// @notice Wall clock the campaign starts from.
    uint64 internal constant START = 1_700_000_000;

    /// @notice Floor on a generated amount, in Asset base units.
    /// @dev Above the binding-amount window of `AgentRegistry`, which ends at 109,999, so a generated
    /// amount can never read as a proof of address control. The payer is bound before the first case
    /// either way, and a bound payer resolves before the amount is looked at, so this is belt and
    /// braces against a generated figure meaning something it was not asked to mean.
    uint256 internal constant MIN_AMOUNT = 1_000_000;

    /// @notice Width of the generated amount range.
    uint256 internal constant AMOUNT_SPAN = 1_000_000_000;

    /// @notice Amount carried by the always-valid Settlement placed beside a generated log.
    uint256 internal constant COMPANION_AMOUNT = 4_000_000;

    /// @notice Amount every cell of the exhaustive sweep carries.
    uint256 internal constant SWEEP_AMOUNT = 7_000_000;

    /// @notice Source Chain block height of the next submission, so replay keys never collide.
    uint64 internal nextHeight = 21_000_000;

    // ------------------------------------------------------------------ setup

    /// @notice Deploys and wires the tree, etches the precompile, writes the registry, binds the payer.
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
        bond.setSettlementVerifier(address(verifier));
        bond.setTabBook(address(book));

        _registerService();
        _registerEmitters();

        _bind(CHAIN_SEPOLIA);
        _bind(CHAIN_MAINNET);
    }

    /// @notice The Asset half of `genRegistry`: five accepted-Asset entries across the two chains.
    /// @dev Each entry authorises its Asset as an `EmitterKind.Asset` emitter on that chain and claims
    /// its Collection Address, which is the pair-plus-collection record the settlement path reads back.
    /// {ASSET_BOTH} appears on both chains with a different Collection Address on each, so an Asset
    /// authorised twice is not the same as an Asset authorised once.
    function _registerService() private {
        uint64[] memory chainKeys = new uint64[](5);
        chainKeys[0] = CHAIN_SEPOLIA;
        chainKeys[1] = CHAIN_SEPOLIA;
        chainKeys[2] = CHAIN_SEPOLIA;
        chainKeys[3] = CHAIN_MAINNET;
        chainKeys[4] = CHAIN_MAINNET;

        address[] memory assets = new address[](5);
        assets[0] = ASSET_SEPOLIA;
        assets[1] = ASSET_BOTH;
        assets[2] = DUAL_ROLE;
        assets[3] = ASSET_MAINNET;
        assets[4] = ASSET_BOTH;

        address[] memory collections = new address[](5);
        collections[0] = COLLECTION_SEPOLIA;
        collections[1] = COLLECTION_BOTH_SEPOLIA;
        collections[2] = COLLECTION_DUAL_SEPOLIA;
        collections[3] = COLLECTION_MAINNET;
        collections[4] = COLLECTION_BOTH_MAINNET;

        bytes32[] memory tools = new bytes32[](1);
        tools[0] = TOOL;

        uint256[] memory prices = new uint256[](5);
        for (uint256 i = 0; i < 5; ++i) {
            prices[i] = PRICE;
        }

        vm.prank(OPERATOR);
        registry.registerService(SERVICE, chainKeys, assets, collections, tools, prices, WINDOW);
    }

    /// @notice The settlement-contract half of `genRegistry`: three one-chain authorisations.
    /// @dev One call per chain, which is what the registry requires and what makes the cross-chain arm
    /// expressible: {SETTLEMENT_SEPOLIA} is authorised on chainKey 1 and nowhere else, and
    /// {SETTLEMENT_MAINNET} on chainKey 3 and nowhere else. {DUAL_ROLE} takes its second authorisation
    /// here, as a settlement contract on chainKey 3, while chainKey 1 already knows it as an Asset.
    function _registerEmitters() private {
        vm.prank(OPERATOR);
        registry.registerSettlementEmitter(SERVICE, CHAIN_SEPOLIA, SETTLEMENT_SEPOLIA, ASSET_SEPOLIA);

        vm.prank(OPERATOR);
        registry.registerSettlementEmitter(SERVICE, CHAIN_MAINNET, SETTLEMENT_MAINNET, ASSET_MAINNET);

        vm.prank(OPERATOR);
        registry.registerSettlementEmitter(SERVICE, CHAIN_MAINNET, DUAL_ROLE, ASSET_MAINNET);
    }

    /// @notice Bind {PAYER} to {AGENT} on one chain by paying the amount the registry issues.
    /// @dev The honest path and the only one there is, so no accepted cell below depends on an
    /// impersonation: the registry hands the Agent an exact amount and a Verified Settlement of that
    /// amount from that address is what proves control of it.
    /// @param chainKey Attested-chain identifier to bind on.
    function _bind(uint64 chainKey) private {
        vm.prank(AGENT);
        (, uint256 amount,) = agents.requestBinding(chainKey, PAYER);

        address asset = chainKey == CHAIN_SEPOLIA ? ASSET_SEPOLIA : ASSET_MAINNET;
        address collection = chainKey == CHAIN_SEPOLIA ? COLLECTION_SEPOLIA : COLLECTION_MAINNET;

        uint64 height = nextHeight++;
        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(asset, PAYER, collection, amount));
        verifier.submitSettlement(_sourceTx(chainKey, height, SourceTxFixture.encode(PAYER, entries)));
    }

    // ------------------------------------------------------------------ the property

    /// @notice Acceptance is exactly the authorised pair carrying its own kind's signature.
    /// @dev The single-log clause. One generated log, alone in the receipt, so the four outcomes are
    /// observable one at a time: an acceptance credits and records, and each refusal is the specific
    /// error the criteria name.
    /// @param chainSel Selects the chainKey over {1, 3}.
    /// @param emitterSel Selects the emitter over the seven addresses.
    /// @param sigSel Selects the signature over `Transfer`, `TabSettled`, and an unregistered word.
    /// @param recipientSel Selects the recipient over matching, other-Asset, and unclaimed.
    /// @param rawAmount Seeds the settled amount.
    function testFuzz_acceptanceIsExactlyTheAuthorisedPairWithItsOwnSignature(
        uint256 chainSel,
        uint256 emitterSel,
        uint256 sigSel,
        uint256 recipientSel,
        uint96 rawAmount
    ) public {
        Submission memory submission = _submission(chainSel, emitterSel, sigSel, recipientSel, rawAmount);
        _submitAlone(submission);
    }

    /// @notice A skipped log never strands the Settlement beside it, and a refused one refuses both.
    /// @dev The companion clause, and the half of the pair rule that must not revert. An emitter
    /// authorised nowhere is somebody else's event, so the sweep passes over it and the real Settlement
    /// in the same receipt still lands (R4.5). An emitter authorised elsewhere is the opposite case and
    /// takes the whole submission down with it (R5.3), which is what the two arms below separate.
    /// @param chainSel Selects the chainKey over {1, 3}.
    /// @param emitterSel Selects the emitter over the seven addresses.
    /// @param sigSel Selects the signature over `Transfer`, `TabSettled`, and an unregistered word.
    /// @param recipientSel Selects the recipient over matching, other-Asset, and unclaimed.
    /// @param rawAmount Seeds the settled amount.
    function testFuzz_aSkippedLogDoesNotStrandTheSettlementBesideIt(
        uint256 chainSel,
        uint256 emitterSel,
        uint256 sigSel,
        uint256 recipientSel,
        uint96 rawAmount
    ) public {
        Submission memory submission = _submission(chainSel, emitterSel, sigSel, recipientSel, rawAmount);
        _submitBesideASettlement(submission);
    }

    /// @notice Only chainKey 1 and chainKey 3 are settled from, and the refusal precedes the proof.
    /// @dev The admissibility half of the pair, which is R5.6. A pair whose chain half is not attested
    /// by Tab is refused in the base before any external call, so an unsupported identifier cannot even
    /// reach the emitter table.
    /// @param chainKey Any attested-chain identifier other than the two Tab settles from.
    function testFuzz_anUnsupportedChainKeyIsRefusedBeforeAnyProofCall(uint64 chainKey) public {
        vm.assume(chainKey != CHAIN_SEPOLIA && chainKey != CHAIN_MAINNET);

        uint256 verifyCallsBefore = prover.verifyCalls();
        uint64 height = nextHeight++;
        EvmV1Decoder.LogEntryTuple[] memory entries = SourceTxFixture.one(
            SourceTxFixture.transferLog(ASSET_MAINNET, PAYER, COLLECTION_MAINNET, MIN_AMOUNT)
        );

        vm.expectRevert(abi.encodeWithSelector(TabAscBase.UnsupportedChainKey.selector, chainKey));
        verifier.submitSettlement(_sourceTx(chainKey, height, SourceTxFixture.encode(PAYER, entries)));

        assertEq(prover.verifyCalls(), verifyCallsBefore, "no proof call for an unsupported chainKey");
    }

    /// @notice Every cell of the generated space is walked once, and all five outcomes occur.
    /// @dev The completeness pass over the same property and the same oracle. The fuzz clauses draw
    /// from a space of 126 cells, so they reach every cell with high probability and no guarantee; this
    /// walks the product exhaustively, and the tallies at the end are what make a vacuous pass
    /// impossible. `WrongChain` alone spans four cells — an Asset and a settlement contract, each
    /// presented under the other chain — and each of them is asserted to carry the mask naming where
    /// the emitter really is authorised.
    function test_everyCellOfTheGeneratedSpaceIsWalkedAndEveryOutcomeOccurs() public {
        uint256[5] memory tally;

        for (uint256 chainSel = 0; chainSel < 2; ++chainSel) {
            for (uint256 emitterSel = 0; emitterSel < EMITTER_COUNT; ++emitterSel) {
                for (uint256 sigSel = 0; sigSel < 3; ++sigSel) {
                    for (uint256 recipientSel = 0; recipientSel < RECIPIENT_COUNT; ++recipientSel) {
                        Submission memory submission =
                            _sweepSubmission(chainSel, emitterSel, sigSel, recipientSel);
                        ++tally[uint256(submission.outcome)];
                        _submitAlone(submission);
                    }
                }
            }
        }

        assertGt(tally[uint256(Outcome.Accepted)], 0, "no cell was accepted");
        assertGt(tally[uint256(Outcome.Skipped)], 0, "no cell was skipped");
        assertGt(tally[uint256(Outcome.WrongChain)], 0, "no cell was presented under the wrong chain");
        assertGt(tally[uint256(Outcome.NoCollection)], 0, "no cell named an unclaimed recipient");
        assertGt(tally[uint256(Outcome.WrongAsset)], 0, "no cell disagreed about the Asset");
    }

    /// @notice The registry the campaign quantifies over is the pair table it claims to be.
    /// @dev The precondition guard on `genRegistry`, and it is not decoration. Every refusal above is
    /// asserted against a registry this contract wrote, so a registration that silently did something
    /// else would turn acceptance cells into skips and the campaign would pass while proving less than
    /// it says. Each pair is checked for authorisation, kind, and Asset, and each address for the mask
    /// of chains it is authorised on. (R5.2)
    function test_theRegistryIsThePairTableTheCampaignQuantifiesOver() public view {
        uint64 sepoliaBit = uint64(1) << CHAIN_SEPOLIA;
        uint64 mainnetBit = uint64(1) << CHAIN_MAINNET;

        _assertPair(CHAIN_SEPOLIA, ASSET_SEPOLIA, IServiceRegistry.EmitterKind.Asset, ASSET_SEPOLIA);
        _assertPair(CHAIN_SEPOLIA, ASSET_BOTH, IServiceRegistry.EmitterKind.Asset, ASSET_BOTH);
        _assertPair(CHAIN_MAINNET, ASSET_BOTH, IServiceRegistry.EmitterKind.Asset, ASSET_BOTH);
        _assertPair(CHAIN_MAINNET, ASSET_MAINNET, IServiceRegistry.EmitterKind.Asset, ASSET_MAINNET);
        _assertPair(CHAIN_SEPOLIA, DUAL_ROLE, IServiceRegistry.EmitterKind.Asset, DUAL_ROLE);
        _assertPair(CHAIN_MAINNET, DUAL_ROLE, IServiceRegistry.EmitterKind.SettlementContract, ASSET_MAINNET);
        _assertPair(
            CHAIN_SEPOLIA, SETTLEMENT_SEPOLIA, IServiceRegistry.EmitterKind.SettlementContract, ASSET_SEPOLIA
        );
        _assertPair(
            CHAIN_MAINNET, SETTLEMENT_MAINNET, IServiceRegistry.EmitterKind.SettlementContract, ASSET_MAINNET
        );

        assertFalse(registry.emitterFor(CHAIN_MAINNET, ASSET_SEPOLIA).authorised, "Sepolia Asset on 3");
        assertFalse(registry.emitterFor(CHAIN_SEPOLIA, ASSET_MAINNET).authorised, "Mainnet Asset on 1");
        assertFalse(
            registry.emitterFor(CHAIN_MAINNET, SETTLEMENT_SEPOLIA).authorised, "Sepolia settlement on 3"
        );
        assertFalse(
            registry.emitterFor(CHAIN_SEPOLIA, SETTLEMENT_MAINNET).authorised, "Mainnet settlement on 1"
        );
        assertFalse(registry.emitterFor(CHAIN_SEPOLIA, UNKNOWN_EMITTER).authorised, "unknown on 1");
        assertFalse(registry.emitterFor(CHAIN_MAINNET, UNKNOWN_EMITTER).authorised, "unknown on 3");

        assertEq(registry.emitterChainMask(ASSET_SEPOLIA), sepoliaBit, "Sepolia Asset mask");
        assertEq(registry.emitterChainMask(ASSET_MAINNET), mainnetBit, "Mainnet Asset mask");
        assertEq(registry.emitterChainMask(ASSET_BOTH), sepoliaBit | mainnetBit, "both-chain Asset mask");
        assertEq(registry.emitterChainMask(DUAL_ROLE), sepoliaBit | mainnetBit, "dual-role mask");
        assertEq(registry.emitterChainMask(SETTLEMENT_SEPOLIA), sepoliaBit, "Sepolia settlement mask");
        assertEq(registry.emitterChainMask(SETTLEMENT_MAINNET), mainnetBit, "Mainnet settlement mask");
        assertEq(registry.emitterChainMask(UNKNOWN_EMITTER), 0, "unknown emitter is authorised nowhere");

        assertFalse(registry.collectionFor(CHAIN_SEPOLIA, UNCLAIMED_COLLECTION).exists, "unclaimed on 1");
        assertFalse(registry.collectionFor(CHAIN_MAINNET, UNCLAIMED_COLLECTION).exists, "unclaimed on 3");
        assertEq(agents.agentOf(CHAIN_SEPOLIA, PAYER), AGENT, "payer bound on chainKey 1");
        assertEq(agents.agentOf(CHAIN_MAINNET, PAYER), AGENT, "payer bound on chainKey 3");
    }

    // ------------------------------------------------------------------ generators

    /// @notice `genSubmission` crossed with `genSignature`: one submission from four free choices.
    /// @param chainSel Selects the chainKey over {1, 3}.
    /// @param emitterSel Selects the emitter over the seven addresses.
    /// @param sigSel Selects the signature over `Transfer`, `TabSettled`, and an unregistered word.
    /// @param recipientSel Selects the recipient over matching, other-Asset, and unclaimed.
    /// @param rawAmount Seeds the settled amount.
    /// @return submission The submission, with the outcome the criteria give it already resolved.
    function _submission(
        uint256 chainSel,
        uint256 emitterSel,
        uint256 sigSel,
        uint256 recipientSel,
        uint96 rawAmount
    ) internal view returns (Submission memory submission) {
        submission.amount = MIN_AMOUNT + (uint256(rawAmount) % AMOUNT_SPAN);
        submission = _fill(submission, chainSel, emitterSel, sigSel, recipientSel);
    }

    /// @notice The same generator at a fixed amount, for the exhaustive walk.
    /// @param chainSel Selects the chainKey over {1, 3}.
    /// @param emitterSel Selects the emitter over the seven addresses.
    /// @param sigSel Selects the signature over `Transfer`, `TabSettled`, and an unregistered word.
    /// @param recipientSel Selects the recipient over matching, other-Asset, and unclaimed.
    /// @return submission The submission, with the outcome the criteria give it already resolved.
    function _sweepSubmission(uint256 chainSel, uint256 emitterSel, uint256 sigSel, uint256 recipientSel)
        internal
        view
        returns (Submission memory submission)
    {
        submission.amount = SWEEP_AMOUNT;
        submission = _fill(submission, chainSel, emitterSel, sigSel, recipientSel);
    }

    /// @notice Fill the four generated dimensions and resolve the oracle.
    /// @param submission The submission, carrying its amount already.
    /// @param chainSel Selects the chainKey over {1, 3}.
    /// @param emitterSel Selects the emitter over the seven addresses.
    /// @param sigSel Selects the signature over `Transfer`, `TabSettled`, and an unregistered word.
    /// @param recipientSel Selects the recipient over matching, other-Asset, and unclaimed.
    /// @return filled The same submission, complete.
    function _fill(
        Submission memory submission,
        uint256 chainSel,
        uint256 emitterSel,
        uint256 sigSel,
        uint256 recipientSel
    ) internal view returns (Submission memory filled) {
        submission.chainKey = chainSel % 2 == 0 ? CHAIN_SEPOLIA : CHAIN_MAINNET;
        submission.emitter = _emitterAt(emitterSel % EMITTER_COUNT);
        // casting to 'uint8' is safe because the modulus puts the value in `[0, 2]`.
        // forge-lint: disable-next-line(unsafe-typecast)
        submission.signature = Sig(uint8(sigSel % 3));
        submission.signatureTopic = _signatureTopic(submission.signature, submission.amount);

        address matching = _matchingCollection(submission.chainKey, submission.emitter);
        uint256 which = recipientSel % RECIPIENT_COUNT;
        if (which == 0) {
            submission.recipient = matching;
        } else if (which == 1) {
            submission.recipient = _otherCollection(submission.chainKey, matching);
        } else {
            submission.recipient = UNCLAIMED_COLLECTION;
        }

        _resolveOracle(submission);
        filled = submission;
    }

    /// @notice The emitter set: registered on one chain, on both, in two kinds, and nowhere.
    /// @param index Position in the set, below {EMITTER_COUNT}.
    /// @return emitter The address at that position.
    function _emitterAt(uint256 index) internal pure returns (address emitter) {
        if (index == 0) return ASSET_SEPOLIA;
        if (index == 1) return ASSET_MAINNET;
        if (index == 2) return ASSET_BOTH;
        if (index == 3) return SETTLEMENT_SEPOLIA;
        if (index == 4) return SETTLEMENT_MAINNET;
        if (index == 5) return DUAL_ROLE;
        emitter = UNKNOWN_EMITTER;
    }

    /// @notice `genSignature`: the two registered signature words and one that is registered nowhere.
    /// @dev The unregistered word is derived from the amount so it varies across the campaign, and it
    /// is asserted different from both registered words before it is submitted.
    /// @param signature Which signature to produce.
    /// @param salt Seed for the unregistered word.
    /// @return topic The word the log carries in `topics[0]`.
    function _signatureTopic(Sig signature, uint256 salt) internal pure returns (bytes32 topic) {
        if (signature == Sig.Transfer) return keccak256("Transfer(address,address,uint256)");
        if (signature == Sig.TabSettled) return keccak256("TabSettled(address,address,uint256,bytes32)");
        topic = keccak256(abi.encode("pair-authentication-unregistered-signature", salt));
    }

    /// @notice The Collection Address an accepted log from this pair would resolve to.
    /// @dev For an `Asset` emitter the Asset is the emitter itself, so the matching recipient is the
    /// address registered for that Asset on that chain. For a settlement contract the Asset comes off
    /// the recipient instead, so the chain's canonical Collection Address matches by construction.
    /// @param chainKey Attested-chain identifier of the submission.
    /// @param emitter Address that emits the log.
    /// @return collection The matching Collection Address.
    function _matchingCollection(uint64 chainKey, address emitter)
        internal
        view
        returns (address collection)
    {
        IServiceRegistry.EmitterRecord memory record = registry.emitterFor(chainKey, emitter);
        if (record.authorised && record.kind == IServiceRegistry.EmitterKind.Asset) {
            return _collectionForAsset(chainKey, emitter);
        }
        collection = chainKey == CHAIN_SEPOLIA ? COLLECTION_SEPOLIA : COLLECTION_MAINNET;
    }

    /// @notice The Collection Address registered for one Asset on one chain.
    /// @param chainKey Attested-chain identifier of the record.
    /// @param asset Asset the address collects.
    /// @return collection The registered address, or the zero address for an Asset with no entry.
    function _collectionForAsset(uint64 chainKey, address asset) internal pure returns (address collection) {
        if (chainKey == CHAIN_SEPOLIA) {
            if (asset == ASSET_SEPOLIA) return COLLECTION_SEPOLIA;
            if (asset == ASSET_BOTH) return COLLECTION_BOTH_SEPOLIA;
            if (asset == DUAL_ROLE) return COLLECTION_DUAL_SEPOLIA;
            return address(0);
        }
        if (asset == ASSET_MAINNET) return COLLECTION_MAINNET;
        if (asset == ASSET_BOTH) return COLLECTION_BOTH_MAINNET;
        collection = address(0);
    }

    /// @notice A claimed Collection Address on the same chain that collects a different Asset.
    /// @dev What makes R2.5 reachable: the recipient resolves, so the submission gets past R2.4, and
    /// then the emitting Asset and the collected Asset disagree.
    /// @param chainKey Attested-chain identifier of the submission.
    /// @param matching The matching Collection Address, which this one must differ from.
    /// @return collection A different claimed address on the same chain.
    function _otherCollection(uint64 chainKey, address matching) internal pure returns (address collection) {
        if (chainKey == CHAIN_SEPOLIA) {
            return matching == COLLECTION_BOTH_SEPOLIA ? COLLECTION_SEPOLIA : COLLECTION_BOTH_SEPOLIA;
        }
        collection = matching == COLLECTION_BOTH_MAINNET ? COLLECTION_MAINNET : COLLECTION_BOTH_MAINNET;
    }

    // ------------------------------------------------------------------ the oracle

    /// @notice Decide, from the criteria, what becomes of one generated submission.
    /// @dev Written from Requirement 2, Requirement 5, and Requirement 6 rather than from the contract,
    /// with the registry facts as inputs. The order is the order the criteria impose, and it is why a
    /// cross-chain emitter carrying an unregistered signature still reverts: authentication is on the
    /// pair and is decided before the signature is looked at (R5.1, R5.3).
    /// @param submission The submission to decide, written through in place.
    function _resolveOracle(Submission memory submission) internal view {
        IServiceRegistry.EmitterRecord memory emitter =
            registry.emitterFor(submission.chainKey, submission.emitter);
        submission.mask = registry.emitterChainMask(submission.emitter);

        // Pair authentication, and the two negative answers are different answers. Authorised
        // elsewhere is an event from one chain presented as an event from another (R5.3); authorised
        // nowhere is an unrelated contract's event, which is skipped (R4.5).
        if (!emitter.authorised) {
            submission.outcome = submission.mask == 0 ? Outcome.Skipped : Outcome.WrongChain;
            return;
        }

        // The signature is admissible only for the kind that produces it, and `TabSettled` only on
        // chainKey 1, where Tab deploys a settlement contract at all. (R6.1, R6.4, R6.5)
        bool transferByAsset =
            submission.signature == Sig.Transfer && emitter.kind == IServiceRegistry.EmitterKind.Asset;
        bool settledByContract = submission.signature == Sig.TabSettled
            && submission.chainKey == CHAIN_SEPOLIA
            && emitter.kind == IServiceRegistry.EmitterKind.SettlementContract;
        if (!transferByAsset && !settledByContract) {
            submission.outcome = Outcome.Skipped;
            return;
        }

        IServiceRegistry.CollectionRecord memory collection =
            registry.collectionFor(submission.chainKey, submission.recipient);
        submission.collectionAsset = collection.asset;

        // The recipient names the Service, so an unclaimed recipient names nobody. (R2.3, R2.4)
        if (!collection.exists) {
            submission.outcome = Outcome.NoCollection;
            return;
        }

        // The emitting Asset is part of the authenticated identity of a `Transfer`, so it must be the
        // Asset that recipient collects. A `TabSettled` takes its Asset from the recipient instead, so
        // there is nothing for it to disagree with. (R2.5)
        if (submission.signature == Sig.Transfer && collection.asset != submission.emitter) {
            submission.outcome = Outcome.WrongAsset;
            return;
        }

        submission.outcome = Outcome.Accepted;
        submission.creditedAsset =
            submission.signature == Sig.Transfer ? submission.emitter : collection.asset;
    }

    // ------------------------------------------------------------------ execution

    /// @notice Submit one generated log alone in its receipt and assert the outcome.
    /// @param submission The decided submission.
    function _submitAlone(Submission memory submission) internal {
        _assertUnregisteredSignatureIsUnregistered(submission);

        uint64 height = nextHeight++;
        bytes memory encoded = SourceTxFixture.encode(PAYER, SourceTxFixture.one(_logOf(submission)));
        bytes32 key = verifier.replayKey(submission.chainKey, height, 0, 0);

        if (submission.outcome != Outcome.Accepted) {
            _expectRefusal(submission, height);
            verifier.submitSettlement(_sourceTx(submission.chainKey, height, encoded));
            assertFalse(verifier.claimedLog(key), "a refused log is never claimed");
            return;
        }

        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, submission.creditedAsset);
        uint128 prepaidBefore = book.tabOf(tabId).prepaid;

        uint256 ingested = verifier.submitSettlement(_sourceTx(submission.chainKey, height, encoded));

        assertEq(ingested, 1, "the authorised pair ingested exactly its own log");
        assertTrue(verifier.claimedLog(key), "the accepted log is claimed");

        // The chainKey the proof established travels onto the entry the book keeps, which is what
        // makes a Sepolia Settlement and a Mainnet Settlement different records. (R5.4, R5.5)
        ITabBook.Clearing memory record = book.clearingOf(key);
        assertEq(record.chainKey, submission.chainKey, "the entry records the submitted chainKey");
        assertEq(record.serviceId, SERVICE, "the entry names the Service the recipient resolved to");
        assertEq(record.asset, submission.creditedAsset, "the entry names the authenticated Asset");
        assertEq(record.amount, submission.amount, "the entry carries the settled amount");
        assertEq(uint8(record.state), uint8(ITabBook.ClearingState.Confirmed), "the entry is confirmed");
        assertEq(
            book.tabOf(tabId).prepaid - prepaidBefore, submission.amount, "the settled amount reached the tab"
        );
    }

    /// @notice Submit one generated log beside an always-valid Settlement and assert both fates.
    /// @param submission The decided submission.
    function _submitBesideASettlement(Submission memory submission) internal {
        _assertUnregisteredSignatureIsUnregistered(submission);

        uint64 height = nextHeight++;
        EvmV1Decoder.LogEntryTuple[] memory entries = new EvmV1Decoder.LogEntryTuple[](2);
        entries[0] = _logOf(submission);
        entries[1] = _companionLog(submission.chainKey);

        bytes memory encoded = SourceTxFixture.encode(PAYER, entries);
        bytes32 generatedKey = verifier.replayKey(submission.chainKey, height, 0, 0);
        bytes32 companionKey = verifier.replayKey(submission.chainKey, height, 0, 1);

        if (
            submission.outcome == Outcome.WrongChain || submission.outcome == Outcome.NoCollection
                || submission.outcome == Outcome.WrongAsset
        ) {
            _expectRefusal(submission, height);
            verifier.submitSettlement(_sourceTx(submission.chainKey, height, encoded));
            assertFalse(verifier.claimedLog(generatedKey), "a refused log is never claimed");
            assertFalse(verifier.claimedLog(companionKey), "a refusal takes the whole submission down");
            return;
        }

        uint256 ingested = verifier.submitSettlement(_sourceTx(submission.chainKey, height, encoded));

        assertEq(
            ingested,
            submission.outcome == Outcome.Accepted ? 2 : 1,
            "one credit per recognised log and no more"
        );
        assertTrue(verifier.claimedLog(companionKey), "the Settlement beside a skipped log still lands");
        assertEq(
            verifier.claimedLog(generatedKey),
            submission.outcome == Outcome.Accepted,
            "the generated log is claimed exactly when the criteria accept it"
        );
    }

    /// @notice Expect the specific refusal the criteria give this submission.
    /// @dev Four distinct refusals, and the distinctions are the property. A skip leaves the receipt
    /// with no Settlement in it, which is `NoRecognisedSettlement` from the base; the other three name
    /// the pair, the recipient, and the Asset respectively.
    /// @param submission The decided submission.
    /// @param height Source Chain block height the submission is made at.
    function _expectRefusal(Submission memory submission, uint64 height) internal {
        if (submission.outcome == Outcome.Skipped) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    TabAscBase.NoRecognisedSettlement.selector, submission.chainKey, height, uint64(0)
                )
            );
            return;
        }

        if (submission.outcome == Outcome.WrongChain) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    SettlementVerifier.UnauthorizedSourceChain.selector,
                    submission.chainKey,
                    submission.emitter,
                    submission.mask
                )
            );
            return;
        }

        if (submission.outcome == Outcome.NoCollection) {
            // The `Transfer` handler names the emitting Asset in the error and the `TabSettled` handler
            // has none to name, because its Asset would have come from the record that does not exist.
            address named = submission.signature == Sig.Transfer ? submission.emitter : address(0);
            vm.expectRevert(
                abi.encodeWithSelector(
                    SettlementVerifier.UnknownCollectionAddress.selector,
                    submission.chainKey,
                    submission.recipient,
                    named
                )
            );
            return;
        }

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementVerifier.AssetMismatch.selector, submission.emitter, submission.collectionAsset
            )
        );
    }

    /// @notice The generated log itself.
    /// @dev The unregistered-signature arm is shaped exactly like a `Transfer` — three topics and a
    /// 32-byte amount — so the only thing that can refuse it is the signature word.
    /// @param submission The decided submission.
    /// @return entry The log entry.
    function _logOf(Submission memory submission)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple memory entry)
    {
        if (submission.signature == Sig.Transfer) {
            return
                SourceTxFixture.transferLog(
                    submission.emitter, PAYER, submission.recipient, submission.amount
                );
        }
        if (submission.signature == Sig.TabSettled) {
            return SourceTxFixture.tabSettledLog(
                submission.emitter,
                PAYER,
                submission.recipient,
                submission.amount,
                keccak256(abi.encode("tab", submission.amount))
            );
        }

        bytes32[] memory topics = new bytes32[](3);
        topics[0] = submission.signatureTopic;
        topics[1] = bytes32(uint256(uint160(PAYER)));
        topics[2] = bytes32(uint256(uint160(submission.recipient)));
        entry = SourceTxFixture.logEntry(submission.emitter, topics, abi.encode(submission.amount));
    }

    /// @notice An always-valid Settlement for one chain, to sit beside a generated log.
    /// @param chainKey Attested-chain identifier of the submission.
    /// @return entry The log entry.
    function _companionLog(uint64 chainKey) internal pure returns (EvmV1Decoder.LogEntryTuple memory entry) {
        address asset = chainKey == CHAIN_SEPOLIA ? ASSET_SEPOLIA : ASSET_MAINNET;
        address collection = chainKey == CHAIN_SEPOLIA ? COLLECTION_SEPOLIA : COLLECTION_MAINNET;
        entry = SourceTxFixture.transferLog(asset, PAYER, collection, COMPANION_AMOUNT);
    }

    /// @notice One Source Chain transaction with its proof material, ready to submit.
    /// @dev The proof is inert, because the etched stand-in is what decides whether a proof holds. The
    /// struct is populated exactly as a submission would be so the mock decodes real fields.
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

    // ------------------------------------------------------------------ guards

    /// @notice The unregistered signature word is genuinely neither registered word.
    /// @param submission The decided submission.
    function _assertUnregisteredSignatureIsUnregistered(Submission memory submission) internal pure {
        if (submission.signature != Sig.Random) return;
        assertTrue(
            submission.signatureTopic != keccak256("Transfer(address,address,uint256)")
                && submission.signatureTopic != keccak256("TabSettled(address,address,uint256,bytes32)"),
            "the unregistered signature collided with a registered one"
        );
    }

    /// @notice One authorised pair carries the kind and Asset the campaign assumes of it.
    /// @param chainKey Attested-chain identifier of the pair.
    /// @param emitter Address half of the pair.
    /// @param kind Kind the pair must hold.
    /// @param asset Asset the pair must name.
    function _assertPair(uint64 chainKey, address emitter, IServiceRegistry.EmitterKind kind, address asset)
        internal
        view
    {
        IServiceRegistry.EmitterRecord memory record = registry.emitterFor(chainKey, emitter);
        assertTrue(record.authorised, "pair is authorised");
        assertEq(uint8(record.kind), uint8(kind), "pair kind");
        assertEq(record.asset, asset, "pair Asset");
    }
}
