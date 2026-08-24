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

// Feature: tab, Property 2: Payer resolution ignores the gas payer
//
// **Validates: Requirements 8.1, 8.2, 8.3, 8.5**
//
// For any Settlement log with an arbitrary `topics[1]` payer address and an arbitrary, independently
// chosen transaction `from` address — including the equal case and the case where both are bound to
// distinct Agents — the credited Agent is the Agent bound to `topics[1]`, and the Agent bound to
// `from` receives zero credit whenever `from` differs from `topics[1]`.
//
// Three arms, one per {Shape}: two distinct bound addresses, one address in both fields, and a
// `topics[1]` bound nowhere while `from` is bound to an Agent. The third is the one that leaves a
// `from`-reading resolver nowhere to go, because there is a creditable Agent one field away and the
// correct outcome is still `UnboundPayer`.

/// @notice Which of the three arrangements of payer and gas payer a generated pair carries.
/// @dev Named rather than left as a raw seed so that a counterexample reads as one of the three cases
/// the property statement names, instead of as a number somebody has to decode first.
enum Shape {
    // `topics[1]` and `from` are different addresses bound to two different Agents. This is relayed
    // and smart-account settlement, and it is the case the property exists for.
    Distinct,
    // `topics[1]` and `from` are the same address, so the payer happens to have paid its own gas. A
    // resolver that read `from` would pass this case, which is why it cannot be the only case
    // generated.
    Equal,
    // `topics[1]` is bound to nobody while `from` is bound to an Agent. A resolver that fell back to
    // `from` would credit that Agent instead of refusing the submission.
    PayerUnbound
}

/// @notice One generated address pair, together with the Agents the generator bound them to.
/// @dev A struct rather than four returns because the legacy code generator is what this project
/// compiles with (`via_ir = false`), and the arms below carry a pair, a case, and four position
/// snapshots at once.
struct Pair {
    /// @dev Source Chain address that lands in `topics[1]` of the Settlement log, so the payer.
    address payerAddress;
    /// @dev Source Chain address that lands in the transaction's `from` field, so the gas payer.
    address gasPayerAddress;
    /// @dev Agent bound to {payerAddress}, or the zero address under {Shape.PayerUnbound}.
    address payerAgent;
    /// @dev Agent bound to {gasPayerAddress}. Equal to {payerAgent} under {Shape.Equal}.
    address gasPayerAgent;
}

/// @notice The Settlement one generated submission carries, on one of the two Source Chains.
/// @dev Both Settlement shapes put the payer in `topics[1]` — ERC-20 `Transfer` by the standard, and
/// `TabSettled` because the Source Chain contract emits `msg.sender` there — so one payer-resolution
/// rule serves both handlers and the generator reaches both rather than assuming they agree.
struct Case {
    /// @dev Attested-chain identifier the proof establishes: 3 for the `Transfer` shape, 1 for
    /// `TabSettled`.
    uint64 chainKey;
    /// @dev Contract that emits the log: the Asset contract, or the Source Chain settlement contract.
    address emitter;
    /// @dev Asset the Settlement is denominated in, which is also the Asset its tab is kept in.
    address asset;
    /// @dev Collection Address the log names as recipient, which resolves the Service.
    address collection;
    /// @dev `TabSettled.tabId`, and zero on the `Transfer` shape which carries none.
    bytes32 tabId;
    /// @dev Settled amount in Asset base units.
    uint256 amount;
}

/// @notice Everything one Agent's crediting is judged on, at one instant.
/// @dev Read back from chain state on both sides of a submission. Nothing here is mirrored locally,
/// so no bookkeeping of this suite's own can drift away from what the contracts did.
struct Position {
    /// @dev Open Tab for the Agent, the one Service, and the Asset.
    uint128 open;
    /// @dev Prepaid credit held on that tab, which is where settled value above the Open Tab lands.
    uint128 prepaid;
    /// @dev Aggregate Open Tab across every Service for the Asset, which is its own storage word.
    /// @dev Read as well as the per-tab figure because a miscredit that moved only the aggregate would
    /// be invisible in the tab alone, and "untouched" has to mean every location the credit could reach.
    uint256 assetOpen;
    /// @dev Rolling commitment over the Agent's Verified Settlement history for the Asset.
    bytes32 historyRoot;
    /// @dev Number of Verified Settlement records that commitment covers.
    uint32 historyCount;
}

/// @title PayerResolutionTest
/// @notice Property 2: payer resolution ignores the gas payer.
///
/// ## What this campaign establishes
///
/// For an arbitrary `topics[1]` payer address and an arbitrary, independently generated transaction
/// `from` address, the Verified Settlement is credited to the Agent bound to `topics[1]`, and the
/// Agent bound to `from` receives nothing whenever the two addresses differ. Three arms, one per
/// {Shape}, and all three assert the same statement:
///
///  - **Distinct.** Two different addresses bound to two different Agents. The whole settled amount
///    reaches the `topics[1]` Agent's tab, whether it lands as a reduction of the Open Tab or as
///    prepaid credit above it, and the `from` Agent is left untouched rather than merely uncredited:
///    its Open Tab, its prepaid credit, its aggregate Open Tab for the Asset, and both halves of its
///    history commitment are all exactly what they were. Asserting only that the `topics[1]` Agent was
///    credited would pass a system that credited both, which is the defect this arm exists to catch.
///    (R8.1, R8.2, R8.3)
///  - **Equal.** The coincidental case, where the payer paid its own gas. It is generated because a
///    resolver that read `from` would pass it, so a campaign that only ever produced divergent pairs
///    would be measuring the wrong thing by omission.
///  - **PayerUnbound.** `topics[1]` is bound to nobody *while `from` is bound to an Agent*. The
///    submission reverts `UnboundPayer` naming the `topics[1]` address, and the bound gas payer's
///    Agent is credited nothing. This is the sharpest available statement that `from` is not
///    consulted: there is a perfectly good Agent one field away and it is not reached for. (R8.4)
///
/// Every accepted arm additionally pins the `SettlementRecorded` event field by field, which is where
/// R8.5 is established: the resolved Agent identity, the resolving Ethereum address, and the chainKey
/// are all recorded on the entry, and the payer address recorded is the one from `topics[1]`.
///
/// The fixture is a real tree — a `ServiceRegistry` with one Service accepting an Asset on each Source
/// Chain, an `AgentRegistry` whose bindings are established by paying the amounts it issues, a `Bond`
/// funded by a proven deposit, and a `TabBook` carrying a metered Open Tab for both Agents. So the
/// figures asserted are produced by the code that would run on chain, and the `from` field the
/// property is about is read out of the fixture by `EvmV1Decoder` rather than asserted about in the
/// abstract. The only stand-in is the BlockProver Precompile, which does not exist locally and is
/// etched at the address its own address library names.
///
/// **Both Agents hold a metered Open Tab before any arm runs, and that is load-bearing.** With a zero
/// tab every credit would land in prepaid, and "nothing reached the gas payer's Agent" would be a
/// statement about a figure that started at zero and could only go up. A positive Open Tab makes a
/// miscredit visible in two directions at once: the wrong tab would fall, and the right one would not.
///
/// ## What this campaign does not establish
///
/// It does not establish that the payer is authentic. `topics[1]` is trusted here because the proof
/// established it, and what makes an address *belong* to an Agent is the proven binding in
/// `AgentRegistry` — the subject of its own suites, not of this one.
///
/// It says nothing about which log in a receipt is recognised, about `(chainKey, emitter)` pair
/// authentication, about receipt status, or about replay scoping. Those are Properties 1, 3, and 4,
/// and this campaign deliberately submits one already-recognised Settlement per run so a failure here
/// can only be about payer resolution.
///
/// It does not reach the zero address as a payer. A transfer whose sender is the zero address is a
/// mint rather than a Settlement, and no key controls that address, so it can never be a payer whose
/// binding is in question. Generated addresses therefore start above every address this fixture
/// names, which also keeps a generated payer from colliding with a Collection Address or an emitter.
///
/// It does not establish anything about amounts beyond their arrival. A settled amount larger than the
/// Open Tab is generated and asserted to arrive in full, split across the reduction and prepaid credit,
/// but where the split falls is Property 15's subject.
///
/// Runs come from the `[profile.default.fuzz]` block in `foundry.toml`, currently 256 per arm.
///
/// Requirements: 8.1, 8.2, 8.3, 8.5
contract PayerResolutionTest is Test {
    // ------------------------------------------------------------------ the tree

    /// @notice Registry of emitters, Collection Addresses, prices, and tiers.
    ServiceRegistry internal registry;

    /// @notice Registry that turns a Source Chain payer address into an Agent identity.
    AgentRegistry internal agents;

    /// @notice Bond whose stake is what gives the two Agents a Credit Limit to meter against.
    Bond internal bond;

    /// @notice Book the Verified Settlement is applied to, and the source of every asserted figure.
    TabBook internal book;

    /// @notice Contract under test.
    SettlementVerifier internal verifier;

    /// @notice The etched stand-in for the BlockProver Precompile.
    MockBlockProver internal prover;

    // ------------------------------------------------------------------ constants

    /// @notice Address the BlockProver Precompile lives at, which is where the mock is etched.
    address internal constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;

    /// @notice Attested-chain identifier of Ethereum Sepolia, which carries the `TabSettled` shape.
    uint64 internal constant CHAIN_SEPOLIA = 1;

    /// @notice Attested-chain identifier of Ethereum Mainnet, where a plain `Transfer` is the shape.
    uint64 internal constant CHAIN_MAINNET = 3;

    /// @notice Transaction index the etched precompile derives, asserted in {setUp} rather than
    /// assumed, because every expected event below carries it.
    uint64 internal constant TX_INDEX = 0;

    /// @notice First of the two Agents a generated address is bound to.
    address internal constant AGENT_ONE = address(0xA6E7);

    /// @notice Second of the two. Which Agent takes the payer's address is itself generated, so no arm
    /// can pass by accident of always crediting the same identity.
    address internal constant AGENT_TWO = address(0xA6E8);

    /// @notice Creditcoin address that operates the Service, and therefore its Bond party.
    address internal constant OPERATOR = address(0x0FE1);

    /// @notice The wired Watcher. Present only because the book takes one.
    address internal constant WATCHER = address(0x3A7C);

    /// @notice Source Chain address the operator binds and funds the Service's Bond from.
    address internal constant FUNDER = address(0x9A7E);

    /// @notice Launch Asset on Ethereum Mainnet.
    address internal constant USDC = address(0x05DC);

    /// @notice The Asset accepted on Ethereum Sepolia.
    address internal constant SEPOLIA_ASSET = address(0x05D1);

    /// @notice Collection Address for {USDC}, whose Settlements reduce an Open Tab.
    address internal constant COLLECTION_MAINNET = address(0xC011);

    /// @notice Collection Address for {SEPOLIA_ASSET}, whose Settlements reduce an Open Tab.
    address internal constant COLLECTION_SEPOLIA = address(0xC013);

    /// @notice Bond Collection Address for {USDC}, whose Settlements credit stake instead.
    address internal constant BOND_COLLECTION_MAINNET = address(0xC0B3);

    /// @notice Bond Collection Address for {SEPOLIA_ASSET}.
    address internal constant BOND_COLLECTION_SEPOLIA = address(0xC0B1);

    /// @notice The Source Chain settlement contract authorised on chainKey 1.
    address internal constant SETTLEMENT_SEPOLIA = address(0x5E71);

    /// @notice The one Service in scope, which owns every Collection Address above.
    bytes32 internal constant SERVICE = keccak256("payer-resolution-service");

    /// @notice The named priced tool.
    bytes32 internal constant TOOL = keccak256("proof");

    /// @notice Price of one unit of {TOOL} in Asset base units.
    uint256 internal constant PRICE = 1_000;

    /// @notice Units each Agent's metered delivery buys, so each opens a tab of 200,000 base units.
    /// @dev Chosen above the largest binding amount the registry can issue, 109,999, so that the tab
    /// an arm measures against is still positive after the generated addresses have been bound by
    /// payment. Both sides of the reduction-versus-prepaid split therefore stay reachable.
    uint32 internal constant UNITS = 200;

    /// @notice Baseline Credit Limit in Asset base units.
    uint256 internal constant BASELINE = 5_000_000;

    /// @notice Growth factor in basis points.
    uint256 internal constant GROWTH_BPS = 5_000;

    /// @notice Settlement Window the Service registers, in seconds.
    uint32 internal constant WINDOW = 6 hours;

    /// @notice Stake one proven deposit creates in each Asset, which is what makes a Credit Limit
    /// non-zero and therefore makes the metered deliveries in {setUp} possible at all.
    uint128 internal constant DEPOSIT = 10_000_000;

    /// @notice Lowest generated address, one above every address this fixture names.
    /// @dev The fixture's own addresses all sit below `0x10000`, so generating above that line means a
    /// generated payer can never collide with a Collection Address, an Asset contract, a settlement
    /// contract, or an Agent. The alternative — rejecting collisions with `vm.assume` — would throw
    /// away generated runs to avoid a case that carries no information about payer resolution.
    uint256 internal constant FIRST_GENERATED = 0x10000;

    /// @notice Largest generated Settlement amount in Asset base units.
    /// @dev Above the Open Tab a delivery leaves standing, so the generator reaches amounts smaller
    /// than the tab, amounts equal to it, and amounts that overflow into prepaid credit. The property
    /// is about where value lands, so the generator has to reach both places it can land.
    uint256 internal constant MAX_AMOUNT = 250_000;

    /// @notice Wall clock the suite starts from.
    uint64 internal constant START = 1_700_000_000;

    /// @notice Source Chain block height of the next submission, so replay keys never collide.
    uint64 internal nextHeight = 21_000_000;

    // ------------------------------------------------------------------ setup

    /// @notice Deploys and wires the tree, registers the Service, funds the Bond by proof, and opens a
    /// metered tab for both Agents in both Assets.
    /// @dev Everything here is fixed rather than generated, so it runs once and every generated run
    /// starts from the same state. What is generated is what the property is about: the two addresses,
    /// their arrangement, which Agent holds which, the Settlement shape, and the amount.
    function setUp() public {
        vm.warp(START);

        MockBlockProver implementation = new MockBlockProver();
        vm.etch(PRECOMPILE, address(implementation).code);
        prover = MockBlockProver(PRECOMPILE);
        assertEq(prover.txIndex(), TX_INDEX, "the etched precompile derives the index the events name");

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
        _fundBondByProof();
        _openTab(AGENT_ONE);
        _openTab(AGENT_TWO);
    }

    /// @notice Registers the one Service: an Asset on each Source Chain, and the Sepolia settlement
    /// contract as an emitter so the `TabSettled` shape is recognised on chainKey 1.
    /// @dev Two accepted-Asset entries and one named tool, so the price array is Asset-major with one
    /// row each. The Bond Collection Addresses are claimed separately, because registration cannot
    /// nominate one by accident and stake has to arrive at an address the registry knows collects it.
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

        vm.prank(OPERATOR);
        registry.registerBondCollection(SERVICE, CHAIN_MAINNET, USDC, BOND_COLLECTION_MAINNET);

        vm.prank(OPERATOR);
        registry.registerBondCollection(SERVICE, CHAIN_SEPOLIA, SEPOLIA_ASSET, BOND_COLLECTION_SEPOLIA);
    }

    /// @notice Creates stake in both Assets the only way stake can be created: by proven deposit.
    /// @dev The verifier is never impersonated. The operator binds a Source Chain address of its own by
    /// paying the amount the registry issues, then transfers to the Bond Collection Address, and the
    /// same ingestion path this campaign is about is what credits the stake. That matters here for a
    /// reason beyond hygiene: the deposit is itself a Settlement whose `from` and `topics[1]` are the
    /// same address, so setUp would fail outright if the recipient's kind or the payer were misread.
    function _fundBondByProof() private {
        _bind(CHAIN_MAINNET, OPERATOR, FUNDER);
        _bind(CHAIN_SEPOLIA, OPERATOR, FUNDER);

        _submitTransfer(CHAIN_MAINNET, USDC, FUNDER, BOND_COLLECTION_MAINNET, DEPOSIT);
        _submitTransfer(CHAIN_SEPOLIA, SEPOLIA_ASSET, FUNDER, BOND_COLLECTION_SEPOLIA, DEPOSIT);

        bytes32 party = bond.partyOf(registry.serviceOf(SERVICE).bondAccount);
        assertEq(bond.ledgerOf(party, USDC).staked, DEPOSIT, "Mainnet stake credited by proof");
        assertEq(bond.ledgerOf(party, SEPOLIA_ASSET).staked, DEPOSIT, "Sepolia stake credited by proof");
    }

    /// @notice Meters one delivery for `agent` in each Asset, so each arm measures against a real tab.
    /// @dev Both deliveries precede every binding of a generated address, so the witness carries no
    /// history and the rolling commitment is empty at this point. Ordering it the other way round would
    /// mean rebuilding the witness from records this suite would have to mirror locally.
    /// @param agent Agent to open a tab for.
    function _openTab(address agent) private {
        _authoriseAndDeliver(agent, USDC);
        _authoriseAndDeliver(agent, SEPOLIA_ASSET);
    }

    /// @notice Grant the Agent's own spending authorisation, then meter one delivery under it.
    /// @param agent Agent being charged.
    /// @param asset Asset the charge is denominated in.
    function _authoriseAndDeliver(address agent, address asset) private {
        vm.prank(agent);
        // casting to 'uint64' is safe because this suite's clock is a fixed constant far below 2^64.
        // forge-lint: disable-next-line(unsafe-typecast)
        book.authorise(SERVICE, asset, type(uint128).max, uint64(block.timestamp) + 365 days);

        LimitLib.BondEntry[] memory bonds = new LimitLib.BondEntry[](1);
        bonds[0] = LimitLib.BondEntry({serviceId: SERVICE, asset: asset, amount: 0});

        ITabBook.LimitWitness memory witness =
            ITabBook.LimitWitness({history: new LimitLib.SettlementRecord[](0), bonds: bonds});

        vm.prank(OPERATOR);
        (uint256 charged,,) = book.recordDelivery(agent, SERVICE, asset, TOOL, UNITS, PRICE, witness);
        assertEq(charged, uint256(UNITS) * PRICE, "the delivery metered its priced charge");
    }

    // ------------------------------------------------------------------ generators

    /// @notice Generate the `topics[1]` payer and the transaction `from` address, and bind them.
    /// @dev **The two addresses are drawn from independent seeds, and that independence is the
    /// property.** Nothing about the payer constrains the gas payer, so a run can produce two unrelated
    /// addresses, or the same address twice, or a payer nothing has ever bound. {Shape} selects which,
    /// and `swapAgents` decides which Agent holds the payer's address, so no arm can pass by the
    /// accident of one Agent always being the credited one.
    ///
    /// Binding happens here, by payment, because an address's Agent is not something a test may assert
    /// into existence: the registry issues an exact amount and a Verified Settlement of that amount
    /// from that address is the whole proof of control. Under {Shape.Equal} the single address is bound
    /// once, since a second binding of the same address on the same chain is refused — which is itself
    /// why the equal case can only ever name one Agent.
    /// @param chainKey Attested-chain identifier to bind on, which is the chain the arm submits from.
    /// @param payerSeed Seed for the address that lands in `topics[1]`.
    /// @param gasPayerSeed Seed for the address that lands in the transaction's `from` field.
    /// @param shape Which of the three arrangements to produce.
    /// @param swapAgents True to give the payer's address to {AGENT_TWO} rather than {AGENT_ONE}.
    /// @return pair The two addresses and the Agents they resolve to.
    function genBoundAddressPair(
        uint64 chainKey,
        uint256 payerSeed,
        uint256 gasPayerSeed,
        Shape shape,
        bool swapAgents
    ) internal returns (Pair memory pair) {
        address first = swapAgents ? AGENT_TWO : AGENT_ONE;
        address second = swapAgents ? AGENT_ONE : AGENT_TWO;

        pair.payerAddress = _genAddress(payerSeed);
        pair.gasPayerAddress =
            shape == Shape.Equal ? pair.payerAddress : _genDistinctAddress(gasPayerSeed, pair.payerAddress);

        if (shape != Shape.PayerUnbound) {
            pair.payerAgent = first;
            _bind(chainKey, first, pair.payerAddress);
        }

        if (shape == Shape.Equal) {
            pair.gasPayerAgent = pair.payerAgent;
        } else {
            pair.gasPayerAgent = second;
            _bind(chainKey, second, pair.gasPayerAddress);
        }
    }

    /// @notice One generated Source Chain address, above every address this fixture names.
    /// @dev `bound` rather than a hash, so the fuzzer's shrinking still reports a minimal
    /// counterexample. The top of the range is one below the maximum so that {_genDistinctAddress} can
    /// step up by one without overflowing.
    /// @param seed Seed to draw from.
    /// @return generated The address.
    function _genAddress(uint256 seed) internal pure returns (address generated) {
        // casting to 'uint160' is safe because `bound` returned a value inside the address range.
        // forge-lint: disable-next-line(unsafe-typecast)
        generated = address(uint160(bound(seed, FIRST_GENERATED, uint256(type(uint160).max) - 1)));
    }

    /// @notice One generated address that is not `avoid`.
    /// @dev Stepping up by one on a collision rather than rejecting the draw. A rejection would throw
    /// away a generated run to avoid a case the {Shape.Equal} arm covers deliberately anyway, and the
    /// step keeps the result inside the generated range.
    /// @param seed Seed to draw from.
    /// @param avoid Address the result must differ from.
    /// @return generated The address.
    function _genDistinctAddress(uint256 seed, address avoid) internal pure returns (address generated) {
        generated = _genAddress(seed);
        // `uint160(avoid)` widens nothing and loses nothing, and the range {_genAddress} draws from
        // excludes the maximum, so the increment cannot overflow.
        if (generated == avoid) generated = address(uint160(avoid) + 1);
    }

    /// @notice Generate the Settlement one run submits: its shape, its chain, and its amount.
    /// @dev The two shapes are generated rather than chosen because the design's claim is that one
    /// payer-resolution rule serves both handlers. Asserting it on the `Transfer` shape alone would
    /// leave the `TabSettled` handler's own reading of `topics[1]` unmeasured.
    /// @param sepoliaShape True for `TabSettled` on chainKey 1, false for `Transfer` on chainKey 3.
    /// @param amountSeed Seed for the settled amount.
    /// @return generated The case.
    function _genCase(bool sepoliaShape, uint256 amountSeed) internal pure returns (Case memory generated) {
        if (sepoliaShape) {
            generated.chainKey = CHAIN_SEPOLIA;
            generated.emitter = SETTLEMENT_SEPOLIA;
            generated.asset = SEPOLIA_ASSET;
            generated.collection = COLLECTION_SEPOLIA;
            generated.tabId = keccak256(abi.encode("payer-resolution-tab", amountSeed));
        } else {
            generated.chainKey = CHAIN_MAINNET;
            generated.emitter = USDC;
            generated.asset = USDC;
            generated.collection = COLLECTION_MAINNET;
            generated.tabId = bytes32(0);
        }

        generated.amount = bound(amountSeed, 1, MAX_AMOUNT);
    }

    // ------------------------------------------------------------------ submission helpers

    /// @notice Encode one generated case as a decodable Source Chain transaction.
    /// @dev The payer goes into `topics[1]` of the Settlement log and the gas payer goes into the
    /// transaction's own `from` field, which is the one field of the composite that payer resolution
    /// must never read. `SourceTxFixture` keeps them separate by construction, so the divergence
    /// survives `getTransactionType`, `decodeReceiptFields`, and `getLogsByEventSignature` unaltered.
    /// @param generated The case to encode.
    /// @param payerAddress Address that lands in `topics[1]`.
    /// @param gasPayerAddress Address that lands in the transaction's `from` field.
    /// @return encoded The bytes a submission carries as `SourceTx.encodedTransaction`.
    function _encode(Case memory generated, address payerAddress, address gasPayerAddress)
        internal
        pure
        returns (bytes memory encoded)
    {
        EvmV1Decoder.LogEntryTuple[] memory entries;
        if (generated.chainKey == CHAIN_SEPOLIA) {
            entries = SourceTxFixture.one(
                SourceTxFixture.tabSettledLog(
                    generated.emitter, payerAddress, generated.collection, generated.amount, generated.tabId
                )
            );
        } else {
            entries = SourceTxFixture.one(
                SourceTxFixture.transferLog(
                    generated.emitter, payerAddress, generated.collection, generated.amount
                )
            );
        }

        encoded = SourceTxFixture.encode(gasPayerAddress, entries);
    }

    /// @notice One Source Chain transaction with its proof material, ready to submit.
    /// @dev The proof material is inert, because the etched precompile is what decides whether a proof
    /// holds and this campaign is not about proofs. The struct is still populated exactly as a real
    /// submission would be, so the precompile decodes real fields.
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

    /// @notice Submit one ERC-20 `Transfer` whose payer is also its gas payer.
    /// @dev The fixture path, used for bindings and for the Bond deposits. The divergent case is what
    /// the arms below submit, through {_submitCase}.
    /// @param chainKey Attested-chain identifier to submit under.
    /// @param asset Asset contract that emits the log.
    /// @param payer Sender, which lands in `topics[1]`.
    /// @param recipient Recipient, which lands in `topics[2]`.
    /// @param amount Transferred amount.
    function _submitTransfer(uint64 chainKey, address asset, address payer, address recipient, uint256 amount)
        internal
    {
        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(asset, payer, recipient, amount));
        verifier.submitSettlement(_sourceTx(chainKey, nextHeight++, SourceTxFixture.encode(payer, entries)));
    }

    /// @notice Bind a Source Chain address to an Agent by paying the amount the registry issues.
    /// @dev The honest path and the only one there is. No operator signature exists anywhere in it.
    /// @param chainKey Attested-chain identifier to bind on.
    /// @param agent Agent to bind to.
    /// @param payer Source Chain address to bind.
    function _bind(uint64 chainKey, address agent, address payer) internal {
        vm.prank(agent);
        (, uint256 amount,) = agents.requestBinding(chainKey, payer);

        if (chainKey == CHAIN_MAINNET) {
            _submitTransfer(chainKey, USDC, payer, COLLECTION_MAINNET, amount);
        } else {
            _submitTransfer(chainKey, SEPOLIA_ASSET, payer, COLLECTION_SEPOLIA, amount);
        }

        assertEq(agents.agentOf(chainKey, payer), agent, "the payment bound the address to the Agent");
    }

    /// @notice Submit the generated Settlement, expecting it to be credited to the payer's Agent.
    /// @dev Three things happen here and each is part of the property. The fixture is interrogated
    /// through the decoder, so the `from` field really is the gas payer rather than assumed to be. The
    /// `SettlementRecorded` event is matched field by field, which is where the resolved Agent, the
    /// resolving Ethereum address, and the chainKey recorded on the entry are pinned (R8.5). And the
    /// submission is made through the ordinary entrypoint, with nothing supplied that the proof did not
    /// carry.
    /// @param generated The case to submit.
    /// @param pair The generated addresses and their Agents.
    /// @return key Replay key of the ingested log.
    function _submitCase(Case memory generated, Pair memory pair) internal returns (bytes32 key) {
        bytes memory encoded = _encode(generated, pair.payerAddress, pair.gasPayerAddress);
        assertEq(
            EvmV1Decoder.decodeCommonTxFields(encoded).from,
            pair.gasPayerAddress,
            "the transaction's from field carries the generated gas payer"
        );

        uint64 height = nextHeight++;
        key = verifier.replayKey(generated.chainKey, height, TX_INDEX, 0);

        vm.expectEmit(true, true, true, true, address(verifier));
        emit SettlementVerifier.SettlementRecorded(
            key,
            generated.chainKey,
            height,
            TX_INDEX,
            0,
            pair.payerAgent,
            SERVICE,
            generated.asset,
            generated.amount,
            pair.payerAddress,
            generated.tabId
        );
        verifier.submitSettlement(_sourceTx(generated.chainKey, height, encoded));

        // The written entry, not just the event: the Agent it names is the one bound to `topics[1]`, and
        // the chainKey stored beside it is the chain the proof established. (R8.5)
        ITabBook.Clearing memory entry = book.clearingOf(key);
        assertEq(entry.agent, pair.payerAgent, "the entry names the Agent bound to topics[1]");
        assertEq(entry.chainKey, generated.chainKey, "and the chainKey the Settlement was proven on");
        assertEq(entry.amount, generated.amount, "for the amount the log carried");
    }

    // ------------------------------------------------------------------ reads

    /// @notice Everything one Agent's crediting is judged on, read back from chain state.
    /// @param agent Agent to read.
    /// @param asset Asset to read.
    /// @return position The Open Tab, the prepaid credit, the Asset aggregate, and the commitment.
    function _position(address agent, address asset) internal view returns (Position memory position) {
        ITabBook.Tab memory tab = book.tabOf(book.tabIdOf(agent, SERVICE, asset));
        (bytes32 root, uint32 count) = book.historyCommitment(agent, asset);
        position = Position({
            open: tab.open,
            prepaid: tab.prepaid,
            assetOpen: book.assetOpen(agent, asset),
            historyRoot: root,
            historyCount: count
        });
    }

    /// @notice Assert that a Settlement left an Agent's position exactly as it found it.
    /// @dev Every location a credit can reach, compared field by field. The two tab figures are where
    /// value lands, the Asset aggregate is a separate word that headroom is computed from, and the
    /// commitment is what a later Credit Limit is proven against — so a miscredit that touched any one
    /// of them is caught here rather than only the one that happened to be looked at.
    /// @param earlier Position before the submission.
    /// @param later Position after it.
    function _assertUntouched(Position memory earlier, Position memory later) internal pure {
        assertEq(later.open, earlier.open, "the uncredited Agent's Open Tab did not move");
        assertEq(later.prepaid, earlier.prepaid, "the uncredited Agent gained no prepaid credit");
        assertEq(later.assetOpen, earlier.assetOpen, "nor did its Asset aggregate move");
        assertEq(later.historyRoot, earlier.historyRoot, "nor its credit history commitment");
        assertEq(later.historyCount, earlier.historyCount, "and it gained no credit history record");
    }

    /// @notice Value one Verified Settlement delivered to an Agent's tab, however it was applied.
    /// @dev Both places settled value can land, added together: the reduction of the Open Tab, and the
    /// prepaid credit it overflows into once the tab is exhausted. Summing them is what lets the arms
    /// assert that the *whole* amount arrived without also asserting where the split fell, which is a
    /// different property.
    /// @param earlier Position before the submission.
    /// @param later Position after it.
    /// @return value Base units the Settlement delivered.
    function _credited(Position memory earlier, Position memory later) internal pure returns (uint256 value) {
        assertLe(later.open, earlier.open, "a Settlement never raises an Open Tab");
        assertGe(later.prepaid, earlier.prepaid, "a Settlement never lowers prepaid credit");
        value = uint256(earlier.open - later.open) + uint256(later.prepaid - earlier.prepaid);
    }

    /// @notice The Agent that is not `agent`, so an arm can name a party with nothing to do with it.
    /// @param agent One of the two Agents.
    /// @return other The other one.
    function _otherAgent(address agent) internal pure returns (address other) {
        other = agent == AGENT_ONE ? AGENT_TWO : AGENT_ONE;
    }

    /// @notice Submit the generated Settlement, expecting it to be refused for an unbound payer.
    /// @dev The revert is matched on its arguments as well as its selector, so the address named is
    /// asserted to be the one from `topics[1]`. Naming the gas payer instead would be a different
    /// failure wearing the same error.
    /// @param generated The case to submit.
    /// @param pair The generated addresses and their Agents.
    /// @return key Replay key the submission would have ingested under.
    function _submitCaseExpectingUnboundPayer(Case memory generated, Pair memory pair)
        internal
        returns (bytes32 key)
    {
        bytes memory encoded = _encode(generated, pair.payerAddress, pair.gasPayerAddress);
        uint64 height = nextHeight++;
        key = verifier.replayKey(generated.chainKey, height, TX_INDEX, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementVerifier.UnboundPayer.selector, generated.chainKey, pair.payerAddress
            )
        );
        verifier.submitSettlement(_sourceTx(generated.chainKey, height, encoded));
    }

    // ------------------------------------------------------------------ the property

    /// @notice The credit lands on the `topics[1]` Agent, and the gas payer's Agent receives nothing.
    /// @dev The arm the property exists for: two independently generated addresses, bound to two
    /// different Agents, with the gas payer carried in the transaction's own `from` field. A resolver
    /// that read `from` would credit the wrong Agent and fail on both halves of the assertion at once —
    /// the value would be missing from one tab and present in the other. (R8.1, R8.2, R8.3, R8.5)
    /// @param payerSeed Seed for the `topics[1]` address.
    /// @param gasPayerSeed Seed for the transaction `from` address, drawn independently.
    /// @param amountSeed Seed for the settled amount, which reaches both sides of the Open Tab.
    /// @param sepoliaShape True to submit the `TabSettled` shape on chainKey 1, false for `Transfer`.
    /// @param swapAgents True to give the payer's address to {AGENT_TWO} rather than {AGENT_ONE}.
    function testFuzz_theCreditLandsOnTheTopicsOneAgentAndNotOnTheGasPayers(
        uint256 payerSeed,
        uint256 gasPayerSeed,
        uint256 amountSeed,
        bool sepoliaShape,
        bool swapAgents
    ) public {
        Case memory generated = _genCase(sepoliaShape, amountSeed);
        Pair memory pair =
            genBoundAddressPair(generated.chainKey, payerSeed, gasPayerSeed, Shape.Distinct, swapAgents);

        assertTrue(pair.payerAddress != pair.gasPayerAddress, "the generated addresses differ");
        assertTrue(pair.payerAgent != pair.gasPayerAgent, "and they belong to different Agents");

        Position memory payerBefore = _position(pair.payerAgent, generated.asset);
        Position memory gasPayerBefore = _position(pair.gasPayerAgent, generated.asset);

        // Both tabs are live, so a miscredit is visible in two directions: the wrong Open Tab would
        // fall and the right one would not. Without this the arm could pass on figures that started at
        // zero and could only rise.
        assertGt(payerBefore.open, 0, "the payer's Agent owes something");
        assertGt(gasPayerBefore.open, 0, "and so does the gas payer's");

        _submitCase(generated, pair);

        Position memory payerAfter = _position(pair.payerAgent, generated.asset);
        assertEq(_credited(payerBefore, payerAfter), generated.amount, "the payer's Agent got it all");
        assertEq(payerAfter.historyCount, payerBefore.historyCount + 1, "and one history record");
        assertTrue(payerAfter.historyRoot != payerBefore.historyRoot, "which moved its commitment");

        // The gas payer's Agent is not merely uncredited, it is untouched: both tab figures, the Asset
        // aggregate, and the credit history commitment are all exactly what they were. Asserting only
        // that the payer's Agent was credited would pass a system that credited both.
        _assertUntouched(gasPayerBefore, _position(pair.gasPayerAgent, generated.asset));
    }

    /// @notice A payer that paid its own gas is credited by the same rule, not by a coincidence.
    /// @dev The equal case, generated deliberately because it is the one a `from`-reading resolver would
    /// also pass. What it adds is that the shared rule has no special case in it: one address, one Agent,
    /// the whole amount, and an unrelated Agent left alone. (R8.1, R8.3, R8.5)
    /// @param payerSeed Seed for the single address, which occupies both fields.
    /// @param amountSeed Seed for the settled amount.
    /// @param sepoliaShape True to submit the `TabSettled` shape on chainKey 1, false for `Transfer`.
    /// @param swapAgents True to bind the address to {AGENT_TWO} rather than {AGENT_ONE}.
    function testFuzz_anEqualFromAndTopicsOneCreditsTheOneBoundAgent(
        uint256 payerSeed,
        uint256 amountSeed,
        bool sepoliaShape,
        bool swapAgents
    ) public {
        Case memory generated = _genCase(sepoliaShape, amountSeed);
        Pair memory pair =
            genBoundAddressPair(generated.chainKey, payerSeed, payerSeed, Shape.Equal, swapAgents);

        assertEq(pair.gasPayerAddress, pair.payerAddress, "the payer paid its own gas");
        assertEq(pair.gasPayerAgent, pair.payerAgent, "so one Agent holds both roles");

        Position memory payerBefore = _position(pair.payerAgent, generated.asset);
        Position memory strangerBefore = _position(_otherAgent(pair.payerAgent), generated.asset);

        assertGt(payerBefore.open, 0, "the bound Agent owes something");
        assertGt(strangerBefore.open, 0, "and so does the unrelated one");

        _submitCase(generated, pair);

        Position memory payerAfter = _position(pair.payerAgent, generated.asset);
        assertEq(_credited(payerBefore, payerAfter), generated.amount, "the bound Agent got it all");
        assertEq(payerAfter.historyCount, payerBefore.historyCount + 1, "and one history record");
        assertTrue(payerAfter.historyRoot != payerBefore.historyRoot, "which moved its commitment");

        _assertUntouched(strangerBefore, _position(_otherAgent(pair.payerAgent), generated.asset));
    }

    /// @notice An unbound `topics[1]` is refused even though the gas payer is bound to an Agent.
    /// @dev The arm that leaves a resolver nowhere to hide. There is a bound Agent one field away, and
    /// the honest answer is still to refuse the submission and name the `topics[1]` address, because the
    /// party whose balance authorised the transfer is the only party a Settlement may be credited to.
    ///
    /// The refusal is `UnboundPayer` and there is no other error in play. A binding is proven by a
    /// Settlement of the exact amount the registry issued, and an amount that matches no open request
    /// identifies no request at all, so the registry resolves the payer to the zero address and this
    /// contract — the one that knows the submission is being rejected — is what names the failure.
    /// (R8.2, R8.4)
    /// @param payerSeed Seed for the unbound `topics[1]` address.
    /// @param gasPayerSeed Seed for the bound transaction `from` address.
    /// @param amountSeed Seed for the settled amount.
    /// @param sepoliaShape True to submit the `TabSettled` shape on chainKey 1, false for `Transfer`.
    /// @param swapAgents True to bind the gas payer's address to {AGENT_ONE} rather than {AGENT_TWO}.
    function testFuzz_anUnboundTopicsOneIsRefusedThoughTheGasPayerIsBound(
        uint256 payerSeed,
        uint256 gasPayerSeed,
        uint256 amountSeed,
        bool sepoliaShape,
        bool swapAgents
    ) public {
        Case memory generated = _genCase(sepoliaShape, amountSeed);
        Pair memory pair =
            genBoundAddressPair(generated.chainKey, payerSeed, gasPayerSeed, Shape.PayerUnbound, swapAgents);

        assertEq(agents.agentOf(generated.chainKey, pair.payerAddress), address(0), "payer bound nowhere");
        assertEq(
            agents.agentOf(generated.chainKey, pair.gasPayerAddress),
            pair.gasPayerAgent,
            "while the gas payer is bound"
        );

        Position memory gasPayerBefore = _position(pair.gasPayerAgent, generated.asset);
        assertGt(gasPayerBefore.open, 0, "the gas payer's Agent owes something to be credited against");

        bytes32 key = _submitCaseExpectingUnboundPayer(generated, pair);

        _assertUntouched(gasPayerBefore, _position(pair.gasPayerAgent, generated.asset));
        assertFalse(verifier.claimedLog(key), "and the refused log was never claimed");
    }
}
