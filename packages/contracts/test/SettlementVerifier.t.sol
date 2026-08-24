// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Bond, IBond} from "../src/Bond.sol";
import {IAgentRegistry, SettlementVerifier} from "../src/SettlementVerifier.sol";
import {IServiceRegistry, ServiceRegistry} from "../src/ServiceRegistry.sol";
import {ITabBook, TabBook} from "../src/TabBook.sol";
import {LimitLib} from "../src/LimitLib.sol";
import {TabAscBase} from "../src/asc/TabAscBase.sol";
import {INativeQueryVerifier} from "../src/interfaces/INativeQueryVerifier.sol";
import {MockBlockProver} from "./mocks/MockBlockProver.sol";
import {SourceTxFixture} from "./mocks/SourceTxFixture.sol";

/// @title SettlementVerifierTest
/// @notice Behavioural suite for `SettlementVerifier`: recognition, pair authentication, the two
/// Settlement handlers, and crediting.
/// @dev The whole tree is deployed for real — a `ServiceRegistry` with a registered Service on both
/// Source Chains, an `AgentRegistry` whose bindings are established by paying the amounts it issues,
/// a `Bond`, and a `TabBook` — so every figure asserted here is produced by the code that would run
/// on chain. Nothing is stubbed except the BlockProver Precompile, which does not exist locally.
///
/// **The precompile is etched, not mocked per call.** `TabAscBase` binds it as an immutable read from
/// the address library, so there is no constructor seam, which is deliberate. Placing compiled
/// bytecode at the address the library names means the real ABI encoding of the `verifyAndEmit` call
/// is exercised: a `SourceTx` whose struct layout did not match would fail to decode inside the mock
/// and the test would go red. A per-call return stub would accept any calldata and catch nothing.
///
/// **The transaction fixtures are real.** `SourceTxFixture` builds the prover's chunked composite and
/// every submission below goes through `getTransactionType`, `decodeReceiptFields`, and
/// `getLogsByEventSignature` unmodified. That is what makes the `from`-versus-`topics[1]` test worth
/// anything: the fixture carries both fields, genuinely different, and the decoder reads them.
contract SettlementVerifierTest is Test {
    // ------------------------------------------------------------------ addresses under test

    /// @notice Registry of emitters, Collection Addresses, prices, and tiers.
    ServiceRegistry internal registry;

    /// @notice Registry that binds Source Chain payer addresses to Agents.
    AgentRegistry internal agents;

    /// @notice Bond the book reads stake presence from.
    Bond internal bond;

    /// @notice Book the verifier applies Verified Settlements to.
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

    /// @notice A chainKey this contract settles from nowhere.
    uint64 internal constant CHAIN_UNSUPPORTED = 2;

    /// @notice The Agent every crediting assertion is made against.
    address internal constant AGENT = address(0xA6E7);

    /// @notice A second Agent, bound to a second payer, present so miscrediting is observable.
    address internal constant OTHER_AGENT = address(0xA6E8);

    /// @notice Creditcoin address that operates the Service.
    address internal constant OPERATOR = address(0x0FE1);

    /// @notice The wired Watcher. Present only because the book takes one.
    address internal constant WATCHER = address(0x3A7C);

    /// @notice Source Chain address bound to {AGENT}.
    address internal constant PAYER = address(0x9A7E);

    /// @notice Source Chain address bound to {OTHER_AGENT}.
    address internal constant OTHER_PAYER = address(0x9A7F);

    /// @notice Source Chain address bound to nobody.
    address internal constant UNBOUND_PAYER = address(0x9A80);

    /// @notice Launch Asset on Ethereum Mainnet.
    address internal constant USDC = address(0x05DC);

    /// @notice A second Mainnet Asset, so an Asset mismatch is expressible.
    address internal constant USDT = address(0x05D7);

    /// @notice The Asset accepted on Ethereum Sepolia, authorised on chainKey 1 alone.
    address internal constant SEPOLIA_ASSET = address(0x05D1);

    /// @notice An Asset contract authorised on no chain at all.
    address internal constant UNKNOWN_ASSET = address(0x05FF);

    /// @notice Collection Address for {USDC} on Ethereum Mainnet.
    address internal constant COLLECTION_MAINNET = address(0xC011);

    /// @notice Collection Address for {USDT} on Ethereum Mainnet.
    address internal constant COLLECTION_USDT = address(0xC012);

    /// @notice Collection Address for {SEPOLIA_ASSET} on Ethereum Sepolia.
    address internal constant COLLECTION_SEPOLIA = address(0xC013);

    /// @notice An address no Service has claimed anywhere.
    address internal constant UNCLAIMED_COLLECTION = address(0xC0FF);

    /// @notice The Source Chain settlement contract authorised on chainKey 1.
    address internal constant SETTLEMENT_SEPOLIA = address(0x5E71);

    /// @notice A settlement contract authorised on chainKey 3, where `TabSettled` is not a Settlement.
    address internal constant SETTLEMENT_MAINNET = address(0x5E73);

    /// @notice The Service every Collection Address in this suite belongs to.
    bytes32 internal constant SERVICE = keccak256("service-one");

    /// @notice The named priced tool.
    bytes32 internal constant TOOL = keccak256("proof");

    /// @notice Price of one unit of {TOOL} in launch-Asset base units.
    uint256 internal constant PRICE = 1_000;

    /// @notice Baseline Credit Limit in Asset base units.
    uint256 internal constant BASELINE = 5_000_000;

    /// @notice Growth factor in basis points.
    uint256 internal constant GROWTH_BPS = 5_000;

    /// @notice Settlement Window the Service registers, in seconds.
    uint32 internal constant WINDOW = 6 hours;

    /// @notice Stake the Service holds in each Asset, which is what makes a Credit Limit non-zero.
    uint128 internal constant BOND_STAKE = 10_000_000;

    /// @notice Wall clock the suite starts from.
    uint64 internal constant START = 1_700_000_000;

    /// @notice Measured signature topic of the ERC-20 `Transfer` event.
    bytes32 internal constant MEASURED_TRANSFER_SIG =
        0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;

    /// @notice Measured signature topic of `TabSettlement.TabSettled`, from the compiled artefact.
    bytes32 internal constant MEASURED_TAB_SETTLED_SIG =
        0xc3e17b180e5476ffcdf33da27a6f1d1bdff18cbee72e58913e2a2c1c73c64015;

    /// @notice Source Chain block height of the next submission, so replay keys never collide.
    uint64 internal nextHeight = 21_000_000;

    // ------------------------------------------------------------------ setup

    /// @notice Deploys and wires the tree, etches the precompile, and registers the Service.
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
    }

    /// @notice Credits the Service's stake, so a Credit Limit exists at all.
    /// @dev The bond cap bounds every Credit Limit, and an unbonded Service's counterparties get a cap
    /// of zero. Without stake there is no headroom, so no delivery could be metered and no tab could
    /// be reduced. Credited through the proven-deposit path, which is the only way stake is created.
    ///
    /// The prank is a fixture shortcut and nothing more. `SettlementVerifier` does now route proven
    /// deposits to a Bond Collection Address, so stake can be created the way a real deployment creates
    /// it, and `BondFunding.t.sol` proves that end to end with no impersonation anywhere in it. What
    /// this suite needs is the stake to already be there before its first case runs, so that the
    /// recognition, authentication, and crediting cases below are about those things and not about how
    /// the Bond got funded. Two lines that stand in for the real path are the cheaper way to get it.
    function _fundBond() private {
        address bondAccount = registry.serviceOf(SERVICE).bondAccount;
        bytes32 party = bond.partyOf(bondAccount);

        vm.prank(address(verifier));
        bond.fundFromVerifiedSettlement(party, USDC, BOND_STAKE, keccak256("bond-deposit-usdc"));

        vm.prank(address(verifier));
        bond.fundFromVerifiedSettlement(party, SEPOLIA_ASSET, BOND_STAKE, keccak256("bond-deposit-sepolia"));
    }

    /// @notice Registers the Service with three accepted-Asset entries and two settlement emitters.
    /// @dev The entries are what make every authentication case below expressible from one registry:
    /// `USDC` and `USDT` are authorised on Mainnet, `SEPOLIA_ASSET` on Sepolia alone, and each has its
    /// own Collection Address. A settlement contract is authorised on each chain, so the rule that
    /// `TabSettled` counts on chainKey 1 only can be tested rather than assumed.
    function _registerService() private {
        uint64[] memory chainKeys = new uint64[](3);
        chainKeys[0] = CHAIN_MAINNET;
        chainKeys[1] = CHAIN_MAINNET;
        chainKeys[2] = CHAIN_SEPOLIA;

        address[] memory assets = new address[](3);
        assets[0] = USDC;
        assets[1] = USDT;
        assets[2] = SEPOLIA_ASSET;

        address[] memory collections = new address[](3);
        collections[0] = COLLECTION_MAINNET;
        collections[1] = COLLECTION_USDT;
        collections[2] = COLLECTION_SEPOLIA;

        bytes32[] memory tools = new bytes32[](1);
        tools[0] = TOOL;

        uint256[] memory prices = new uint256[](3);
        prices[0] = PRICE;
        prices[1] = PRICE;
        prices[2] = PRICE;

        vm.prank(OPERATOR);
        registry.registerService(SERVICE, chainKeys, assets, collections, tools, prices, WINDOW);

        vm.prank(OPERATOR);
        registry.registerSettlementEmitter(SERVICE, CHAIN_SEPOLIA, SETTLEMENT_SEPOLIA, SEPOLIA_ASSET);

        vm.prank(OPERATOR);
        registry.registerSettlementEmitter(SERVICE, CHAIN_MAINNET, SETTLEMENT_MAINNET, USDC);
    }

    // ------------------------------------------------------------------ helpers

    /// @notice One Source Chain transaction with its proof material, ready to submit.
    /// @dev The proof itself is inert here, because the etched precompile is what decides whether a
    /// proof holds. What matters is that the struct is populated exactly as a submission would be, so
    /// the mock decodes real fields and can be asserted against.
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

    /// @notice Submit one transaction carrying the given logs, at the next unused height.
    /// @param chainKey Attested-chain identifier to submit under.
    /// @param from The transaction sender, independent of every log's topics.
    /// @param entries Receipt logs, in receipt order.
    /// @return height The height the submission was made at.
    /// @return ingested Number of Settlement logs the submission ingested.
    function _submit(uint64 chainKey, address from, EvmV1Decoder.LogEntryTuple[] memory entries)
        internal
        returns (uint64 height, uint256 ingested)
    {
        height = nextHeight++;
        ingested =
            verifier.submitSettlement(_sourceTx(chainKey, height, SourceTxFixture.encode(from, entries)));
    }

    /// @notice Submit one ERC-20 `Transfer` Settlement.
    /// @param chainKey Attested-chain identifier to submit under.
    /// @param asset Asset contract that emits the log.
    /// @param payer Sender, which lands in `topics[1]`, and also the transaction sender here.
    /// @param recipient Recipient, which lands in `topics[2]`.
    /// @param amount Transferred amount.
    /// @return height The height the submission was made at.
    function _submitTransfer(uint64 chainKey, address asset, address payer, address recipient, uint256 amount)
        internal
        returns (uint64 height)
    {
        (height,) = _submit(
            chainKey, payer, SourceTxFixture.one(SourceTxFixture.transferLog(asset, payer, recipient, amount))
        );
    }

    /// @notice Bind a Source Chain address to an Agent by paying the amount the registry issues.
    /// @dev The honest path and the only one there is: the registry hands the Agent an exact amount,
    /// and a Verified Settlement of that amount from that address is what proves control of it. No
    /// operator signature exists anywhere in this flow.
    /// @param chainKey Attested-chain identifier to bind on.
    /// @param agent Agent to bind to.
    /// @param payer Source Chain address to bind.
    /// @return amount The binding amount that was settled.
    function _bind(uint64 chainKey, address agent, address payer) internal returns (uint256 amount) {
        vm.prank(agent);
        (, amount,) = agents.requestBinding(chainKey, payer);

        if (chainKey == CHAIN_MAINNET) {
            _submitTransfer(chainKey, USDC, payer, COLLECTION_MAINNET, amount);
        } else {
            _submitTransfer(chainKey, SEPOLIA_ASSET, payer, COLLECTION_SEPOLIA, amount);
        }
    }

    /// @notice Grant a spending authorisation as the Agent, so a delivery may be metered.
    /// @param asset Asset the authorisation applies to.
    function _authorise(address asset) internal {
        vm.prank(AGENT);
        // casting to 'uint64' is safe because the suite's clock is a fixed constant far below 2^64.
        // forge-lint: disable-next-line(unsafe-typecast)
        book.authorise(SERVICE, asset, type(uint128).max, uint64(block.timestamp) + 365 days);
    }

    /// @notice Meter one delivery before any Settlement exists, so the witness carries no history.
    /// @param units Count of priced units.
    /// @return charged Amount added to the Open Tab.
    function _deliver(uint32 units) internal returns (uint256 charged) {
        LimitLib.BondEntry[] memory bonds = new LimitLib.BondEntry[](1);
        bonds[0] = LimitLib.BondEntry({serviceId: SERVICE, asset: USDC, amount: 0});

        ITabBook.LimitWitness memory witness =
            ITabBook.LimitWitness({history: new LimitLib.SettlementRecord[](0), bonds: bonds});

        vm.prank(OPERATOR);
        (charged,,) = book.recordDelivery(AGENT, SERVICE, USDC, TOOL, units, PRICE, witness);
    }

    /// @notice The Open Tab for one Agent, Service, and Asset triple.
    /// @param agent Agent to read.
    /// @param asset Asset to read.
    /// @return open Open Tab in Asset base units.
    /// @return prepaid Prepaid credit in Asset base units.
    function _tab(address agent, address asset) internal view returns (uint128 open, uint128 prepaid) {
        ITabBook.Tab memory tab = book.tabOf(book.tabIdOf(agent, SERVICE, asset));
        open = tab.open;
        prepaid = tab.prepaid;
    }
}

/// @title SettlementVerifierRecognitionTest
/// @notice Recognition, pair authentication, and the arity of a recognised log.
/// @dev The two negative answers of pair authentication are the subject: an emitter authorised
/// somewhere else reverts and says where, and an emitter authorised nowhere is skipped so the
/// Settlements beside it still land. Conflating them is the defect this contract exists to avoid.
contract SettlementVerifierRecognitionTest is SettlementVerifierTest {
    /// @notice The two Settlement signatures match the measured topics of the deployed artefacts.
    /// @dev These two words are the cross-chain ABI agreement. A change to either parameter list
    /// moves the hash, and this is where that shows up.
    function test_signatureConstantsMatchTheMeasuredTopics() public view {
        assertEq(verifier.ERC20_TRANSFER_SIG(), MEASURED_TRANSFER_SIG, "transfer signature");
        assertEq(verifier.TAB_SETTLED_SIG(), MEASURED_TAB_SETTLED_SIG, "tab settled signature");
    }

    /// @notice Only chainKey 1 and chainKey 3 are settled from.
    function test_anUnsupportedChainKeyIsRejectedBeforeAnyProofCall() public {
        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_MAINNET, 1_000));

        vm.expectRevert(abi.encodeWithSelector(TabAscBase.UnsupportedChainKey.selector, CHAIN_UNSUPPORTED));
        verifier.submitSettlement(
            _sourceTx(CHAIN_UNSUPPORTED, nextHeight, SourceTxFixture.encode(PAYER, entries))
        );

        assertEq(prover.verifyCalls(), 0, "no proof call for an unsupported chain");
    }

    /// @notice An emitter authorised on another chain reverts and names the chains it is authorised on.
    /// @dev The attack this closes: the same address can hold a different contract on each attested
    /// chain, and a deployer controls its own testnet deployments. Authorising on the emitter alone
    /// would let a Sepolia contract's log be credited as Mainnet value.
    function test_anEmitterAuthorisedOnAnotherChainReverts() public {
        uint64 mask = registry.emitterChainMask(SEPOLIA_ASSET);
        assertEq(mask, uint64(1) << CHAIN_SEPOLIA, "authorised on Sepolia alone");

        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(SEPOLIA_ASSET, PAYER, COLLECTION_MAINNET, 1_000));

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementVerifier.UnauthorizedSourceChain.selector, CHAIN_MAINNET, SEPOLIA_ASSET, mask
            )
        );
        verifier.submitSettlement(
            _sourceTx(CHAIN_MAINNET, nextHeight, SourceTxFixture.encode(PAYER, entries))
        );
    }

    /// @notice An emitter authorised nowhere is skipped, and the Settlement beside it still lands.
    /// @dev The other half of the pair rule. A skip and a revert are different outcomes and this is
    /// the case that must not revert: an unrelated log in the same transaction cannot be allowed to
    /// strand a real payment.
    function test_anEmitterAuthorisedNowhereIsSkippedAndTheSettlementBesideItLands() public {
        _bind(CHAIN_MAINNET, AGENT, PAYER);
        assertEq(registry.emitterChainMask(UNKNOWN_ASSET), 0, "authorised nowhere");

        EvmV1Decoder.LogEntryTuple[] memory entries = new EvmV1Decoder.LogEntryTuple[](2);
        entries[0] = SourceTxFixture.transferLog(UNKNOWN_ASSET, PAYER, COLLECTION_MAINNET, 999);
        entries[1] = SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_MAINNET, 4_000);

        (uint64 height, uint256 ingested) = _submit(CHAIN_MAINNET, PAYER, entries);

        assertEq(ingested, 1, "only the authorised emitter's log is ingested");
        assertFalse(
            verifier.claimedLog(verifier.replayKey(CHAIN_MAINNET, height, 0, 0)), "unknown log unclaimed"
        );
        assertTrue(verifier.claimedLog(verifier.replayKey(CHAIN_MAINNET, height, 0, 1)), "settlement claimed");
    }

    /// @notice A transaction whose only logs are unrecognised is not a Settlement at all.
    function test_aTransactionWithNothingRecognisedReverts() public {
        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(UNKNOWN_ASSET, PAYER, COLLECTION_MAINNET, 999));

        uint64 height = nextHeight;
        vm.expectRevert(
            abi.encodeWithSelector(TabAscBase.NoRecognisedSettlement.selector, CHAIN_MAINNET, height, 0)
        );
        verifier.submitSettlement(_sourceTx(CHAIN_MAINNET, height, SourceTxFixture.encode(PAYER, entries)));
    }

    /// @notice A zero-topic log beside a Settlement is skipped, and processing continues.
    function test_aZeroTopicLogIsSkipped() public {
        _bind(CHAIN_MAINNET, AGENT, PAYER);

        EvmV1Decoder.LogEntryTuple[] memory entries = new EvmV1Decoder.LogEntryTuple[](2);
        entries[0] = SourceTxFixture.zeroTopicLog(UNKNOWN_ASSET);
        entries[1] = SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_MAINNET, 4_000);

        (, uint256 ingested) = _submit(CHAIN_MAINNET, PAYER, entries);
        assertEq(ingested, 1, "the zero-topic log is skipped, the Settlement is not");
    }

    /// @notice `TabSettled` from a settlement contract authorised on Mainnet is not a Settlement there.
    /// @dev Signature resolution is scoped to the emitter kind *and* to chainKey 1. On a chain where
    /// Tab deploys nothing, the only Settlement shape is a plain `Transfer`.
    function test_tabSettledIsNotRecognisedOnMainnet() public {
        IServiceRegistry.EmitterRecord memory emitter = registry.emitterFor(CHAIN_MAINNET, SETTLEMENT_MAINNET);
        assertTrue(emitter.authorised, "the emitter is authorised on Mainnet");

        EvmV1Decoder.LogEntryTuple[] memory entries = SourceTxFixture.one(
            SourceTxFixture.tabSettledLog(
                SETTLEMENT_MAINNET, PAYER, COLLECTION_MAINNET, 4_000, keccak256("tab")
            )
        );

        uint64 height = nextHeight;
        vm.expectRevert(
            abi.encodeWithSelector(TabAscBase.NoRecognisedSettlement.selector, CHAIN_MAINNET, height, 0)
        );
        verifier.submitSettlement(_sourceTx(CHAIN_MAINNET, height, SourceTxFixture.encode(PAYER, entries)));
    }

    /// @notice A `Transfer` signature from a settlement contract is not a Settlement either.
    /// @dev Recognition is kind-scoped in both directions: `Transfer` counts from an Asset contract
    /// only, so a settlement contract emitting one matches nothing.
    function test_aTransferFromASettlementContractIsNotRecognised() public {
        EvmV1Decoder.LogEntryTuple[] memory entries = SourceTxFixture.one(
            SourceTxFixture.transferLog(SETTLEMENT_SEPOLIA, PAYER, COLLECTION_SEPOLIA, 4_000)
        );

        uint64 height = nextHeight;
        vm.expectRevert(
            abi.encodeWithSelector(TabAscBase.NoRecognisedSettlement.selector, CHAIN_SEPOLIA, height, 0)
        );
        verifier.submitSettlement(_sourceTx(CHAIN_SEPOLIA, height, SourceTxFixture.encode(PAYER, entries)));
    }

    /// @notice A `Transfer` log carrying the wrong topic count is rejected rather than credited.
    function test_aMalformedTransferLogReverts() public {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = MEASURED_TRANSFER_SIG;
        topics[1] = bytes32(uint256(uint160(PAYER)));

        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.logEntry(USDC, topics, abi.encode(uint256(4_000))));

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementVerifier.MalformedSettlementLog.selector, MEASURED_TRANSFER_SIG, 2, 32
            )
        );
        verifier.submitSettlement(
            _sourceTx(CHAIN_MAINNET, nextHeight, SourceTxFixture.encode(PAYER, entries))
        );
    }

    /// @notice A `TabSettled` log carrying the wrong topic count is rejected rather than credited.
    /// @dev The failure this guards is quiet: indexing does not enter a signature hash, so a log that
    /// moved `amount` into the topics would match on signature and decode nothing from its data.
    function test_aMalformedTabSettledLogReverts() public {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = MEASURED_TAB_SETTLED_SIG;
        topics[1] = bytes32(uint256(uint160(PAYER)));
        topics[2] = bytes32(uint256(uint160(COLLECTION_SEPOLIA)));

        EvmV1Decoder.LogEntryTuple[] memory entries = SourceTxFixture.one(
            SourceTxFixture.logEntry(SETTLEMENT_SEPOLIA, topics, abi.encode(uint256(4_000)))
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementVerifier.MalformedSettlementLog.selector, MEASURED_TAB_SETTLED_SIG, 3, 32
            )
        );
        verifier.submitSettlement(
            _sourceTx(CHAIN_SEPOLIA, nextHeight, SourceTxFixture.encode(PAYER, entries))
        );
    }

    /// @notice The constructor refuses a zero collaborator in any of its four positions.
    function test_theConstructorRefusesZeroCollaborators() public {
        vm.expectRevert(SettlementVerifier.ZeroAddressField.selector);
        new SettlementVerifier(
            IServiceRegistry(address(0)),
            IAgentRegistry(address(agents)),
            ITabBook(address(book)),
            IBond(address(bond))
        );

        vm.expectRevert(SettlementVerifier.ZeroAddressField.selector);
        new SettlementVerifier(
            IServiceRegistry(address(registry)),
            IAgentRegistry(address(0)),
            ITabBook(address(book)),
            IBond(address(bond))
        );

        vm.expectRevert(SettlementVerifier.ZeroAddressField.selector);
        new SettlementVerifier(
            IServiceRegistry(address(registry)),
            IAgentRegistry(address(agents)),
            ITabBook(address(0)),
            IBond(address(bond))
        );

        vm.expectRevert(SettlementVerifier.ZeroAddressField.selector);
        new SettlementVerifier(
            IServiceRegistry(address(registry)),
            IAgentRegistry(address(agents)),
            ITabBook(address(book)),
            IBond(address(0))
        );
    }
}

/// @title SettlementVerifierCreditingTest
/// @notice The two handlers, payer resolution, and what reaches the book.
/// @dev The centre of this suite is one line that is absent from the contract: nothing on the
/// crediting path reads the transaction's `from` field. Task 1.3 measured a live Mainnet transaction
/// whose `from` and `topics[1]` were different addresses and opposite parties, so reading `from`
/// would credit the recipient of the money. {test_thePayerIsTopicsOneAndNeverTheTransactionFrom}
/// builds exactly that transaction and pins which Agent is credited.
contract SettlementVerifierCreditingTest is SettlementVerifierTest {
    /// @notice Local mirror of the contract's event, declared so `expectEmit` has something to match.
    event SettlementRecorded(
        bytes32 indexed replayKey,
        uint64 chainKey,
        uint64 blockHeight,
        uint64 txIndex,
        uint64 logIndex,
        address indexed agent,
        bytes32 indexed serviceId,
        address asset,
        uint256 amount,
        address payerAddress,
        bytes32 sourceTabId
    );

    /// @notice A Mainnet `Transfer` reduces the Open Tab of the Service that owns the recipient.
    /// @dev End to end, and every figure is produced on chain: the delivery meters a real charge, the
    /// binding is proven by a real payment, and the reduction is what the book did with what the
    /// verifier handed it.
    function test_anErc20TransferReducesTheOpenTab() public {
        _authorise(USDC);
        uint256 charged = _deliver(200);
        assertEq(charged, 200 * PRICE, "metered charge");

        uint256 bindingAmount = _bind(CHAIN_MAINNET, AGENT, PAYER);
        assertEq(agents.agentOf(CHAIN_MAINNET, PAYER), AGENT, "payer bound by payment");

        (uint128 openAfterBinding, uint128 prepaid) = _tab(AGENT, USDC);
        assertEq(openAfterBinding, uint128(charged - bindingAmount), "binding payment reduced the tab");
        assertEq(prepaid, 0, "nothing spilled into prepaid credit");

        _submitTransfer(CHAIN_MAINNET, USDC, PAYER, COLLECTION_MAINNET, openAfterBinding);

        (uint128 open,) = _tab(AGENT, USDC);
        assertEq(open, 0, "the tab is settled");
    }

    /// @notice The payer is `topics[1]`, and the transaction's own `from` field is never read.
    /// @dev Both addresses are bound, to different Agents, and they are genuinely different in the
    /// fixture — asserted through the decoder rather than assumed. If crediting ever read `from`,
    /// this test credits the wrong Agent and fails on both assertions at once.
    function test_thePayerIsTopicsOneAndNeverTheTransactionFrom() public {
        _bind(CHAIN_MAINNET, AGENT, PAYER);
        _bind(CHAIN_MAINNET, OTHER_AGENT, OTHER_PAYER);

        (, uint128 prepaidBefore) = _tab(AGENT, USDC);
        ITabBook.Tab memory otherBefore = book.tabOf(book.tabIdOf(OTHER_AGENT, SERVICE, USDC));

        uint256 amount = 4_000;
        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_MAINNET, amount));

        // The gas payer is the other party, and the decoder confirms the fixture really says so.
        bytes memory encoded = SourceTxFixture.encode(OTHER_PAYER, entries);
        assertEq(EvmV1Decoder.decodeCommonTxFields(encoded).from, OTHER_PAYER, "from is the other party");

        uint64 height = nextHeight++;
        verifier.submitSettlement(_sourceTx(CHAIN_MAINNET, height, encoded));

        (, uint128 prepaidAfter) = _tab(AGENT, USDC);
        ITabBook.Tab memory otherAfter = book.tabOf(book.tabIdOf(OTHER_AGENT, SERVICE, USDC));

        assertEq(prepaidAfter - prepaidBefore, uint128(amount), "the topics[1] Agent is credited");
        assertEq(otherAfter.prepaid, otherBefore.prepaid, "the gas payer's Agent is untouched");
    }

    /// @notice One `SettlementRecorded` event per ingested log, carrying every proven coordinate.
    function test_oneEventPerIngestedLogCarriesTheProvenCoordinates() public {
        _bind(CHAIN_MAINNET, AGENT, PAYER);
        prover.setTxIndex(7);

        uint256 amount = 4_000;
        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_MAINNET, amount));
        uint64 height = nextHeight++;

        vm.expectEmit(true, true, true, true, address(verifier));
        emit SettlementRecorded(
            verifier.replayKey(CHAIN_MAINNET, height, 7, 0),
            CHAIN_MAINNET,
            height,
            7,
            0,
            AGENT,
            SERVICE,
            USDC,
            amount,
            PAYER,
            bytes32(0)
        );
        verifier.submitSettlement(_sourceTx(CHAIN_MAINNET, height, SourceTxFixture.encode(PAYER, entries)));
    }

    /// @notice A `TabSettled` log on chainKey 1 settles, and carries its `tabId` through for audit.
    /// @dev The Asset comes from the Collection Address rather than from the log, because a Collection
    /// Address collects exactly one Asset per chain across the whole registry.
    function test_aTabSettledLogSettlesOnSepolia() public {
        uint256 bindingAmount = _bind(CHAIN_SEPOLIA, AGENT, PAYER);
        assertEq(agents.agentOf(CHAIN_SEPOLIA, PAYER), AGENT, "payer bound on Sepolia");

        bytes32 tabId = keccak256("agent-chosen-tab");
        uint256 amount = 7_500;
        EvmV1Decoder.LogEntryTuple[] memory entries = SourceTxFixture.one(
            SourceTxFixture.tabSettledLog(SETTLEMENT_SEPOLIA, PAYER, COLLECTION_SEPOLIA, amount, tabId)
        );
        uint64 height = nextHeight++;

        vm.expectEmit(true, true, true, true, address(verifier));
        emit SettlementRecorded(
            verifier.replayKey(CHAIN_SEPOLIA, height, 0, 0),
            CHAIN_SEPOLIA,
            height,
            0,
            0,
            AGENT,
            SERVICE,
            SEPOLIA_ASSET,
            amount,
            PAYER,
            tabId
        );
        verifier.submitSettlement(_sourceTx(CHAIN_SEPOLIA, height, SourceTxFixture.encode(PAYER, entries)));

        (, uint128 prepaid) = _tab(AGENT, SEPOLIA_ASSET);
        assertEq(prepaid, uint128(bindingAmount + amount), "both Sepolia Settlements landed");
    }

    /// @notice Two recognised logs in one transaction are both ingested, under distinct replay keys.
    /// @dev This is the case a transaction-scoped replay key loses. The Agent's money moved twice and
    /// both payments have to be creditable.
    function test_twoRecognisedLogsInOneTransactionBothSettle() public {
        _bind(CHAIN_MAINNET, AGENT, PAYER);

        (, uint128 prepaidBefore) = _tab(AGENT, USDC);

        EvmV1Decoder.LogEntryTuple[] memory entries = new EvmV1Decoder.LogEntryTuple[](2);
        entries[0] = SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_MAINNET, 1_500);
        entries[1] = SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_MAINNET, 2_500);

        (uint64 height, uint256 ingested) = _submit(CHAIN_MAINNET, PAYER, entries);

        assertEq(ingested, 2, "both logs ingested");
        assertTrue(verifier.claimedLog(verifier.replayKey(CHAIN_MAINNET, height, 0, 0)), "first claimed");
        assertTrue(verifier.claimedLog(verifier.replayKey(CHAIN_MAINNET, height, 0, 1)), "second claimed");

        (, uint128 prepaidAfter) = _tab(AGENT, USDC);
        assertEq(prepaidAfter - prepaidBefore, 4_000, "both amounts credited");
    }

    // ---------------------------------------------------- task 10.12: one payment, one credit

    /// @notice A `settle` call's `Transfer` and `TabSettled` are one payment and credit once. (R4.3)
    /// @dev **The task 10.12 regression, and the shape that was crediting twice on the live network.**
    /// `TabSettlement.settle` pulls the Asset with `safeTransferFrom`, emitting an ERC-20 `Transfer` to
    /// the Collection Address, and then emits its own `TabSettled` naming the same payer, recipient,
    /// and amount. On chainKey 1 both emitters are authorised, so before the fix both logs were
    /// recognised, took distinct replay keys, and credited a Service twice for money that moved once.
    /// Measured against the deployed contracts at the time: a keyless preflight of a real `settle`
    /// transaction returned `ingestedLogs = 2`.
    ///
    /// `TabSettled` is the statement of intent, so it is the one that survives. The `Transfer` is
    /// skipped and its replay key is deliberately left unclaimed, because nothing was ingested under
    /// it and claiming it would record a Settlement this deployment never credited.
    function test_aSettleCallsTransferAndTabSettledCreditOnce() public {
        _bind(CHAIN_SEPOLIA, AGENT, PAYER);
        (, uint128 prepaidBefore) = _tab(AGENT, SEPOLIA_ASSET);

        EvmV1Decoder.LogEntryTuple[] memory entries = new EvmV1Decoder.LogEntryTuple[](2);
        entries[0] = SourceTxFixture.transferLog(SEPOLIA_ASSET, PAYER, COLLECTION_SEPOLIA, 7_000);
        entries[1] = SourceTxFixture.tabSettledLog(
            SETTLEMENT_SEPOLIA, PAYER, COLLECTION_SEPOLIA, 7_000, bytes32("tab")
        );

        (uint64 height, uint256 ingested) = _submit(CHAIN_SEPOLIA, PAYER, entries);

        assertEq(ingested, 1, "one payment ingests once");
        assertFalse(
            verifier.claimedLog(verifier.replayKey(CHAIN_SEPOLIA, height, 0, 0)),
            "the superseded Transfer claims no replay key"
        );
        assertTrue(
            verifier.claimedLog(verifier.replayKey(CHAIN_SEPOLIA, height, 0, 1)),
            "the TabSettled is the log that credits"
        );

        (, uint128 prepaidAfter) = _tab(AGENT, SEPOLIA_ASSET);
        assertEq(prepaidAfter - prepaidBefore, 7_000, "credited once, not twice");
    }

    /// @notice Two genuinely distinct Settlements in one transaction still both credit. (R4.3)
    /// @dev The other half of the de-duplication, and the one that must not regress. Requirement 4.3
    /// is about two real payments in one transaction, which a `settleBatch` produces, and suppressing
    /// either would lose money in the opposite direction. Two instructions emit two `Transfer` logs and
    /// two `TabSettled` logs, and exactly two Settlements are ingested for two payments.
    function test_twoDistinctSettlementsInOneTransactionBothCredit() public {
        _bind(CHAIN_SEPOLIA, AGENT, PAYER);
        (, uint128 prepaidBefore) = _tab(AGENT, SEPOLIA_ASSET);

        EvmV1Decoder.LogEntryTuple[] memory entries = new EvmV1Decoder.LogEntryTuple[](4);
        entries[0] = SourceTxFixture.transferLog(SEPOLIA_ASSET, PAYER, COLLECTION_SEPOLIA, 1_100);
        entries[1] = SourceTxFixture.tabSettledLog(
            SETTLEMENT_SEPOLIA, PAYER, COLLECTION_SEPOLIA, 1_100, bytes32("one")
        );
        entries[2] = SourceTxFixture.transferLog(SEPOLIA_ASSET, PAYER, COLLECTION_SEPOLIA, 2_200);
        entries[3] = SourceTxFixture.tabSettledLog(
            SETTLEMENT_SEPOLIA, PAYER, COLLECTION_SEPOLIA, 2_200, bytes32("two")
        );

        (, uint256 ingested) = _submit(CHAIN_SEPOLIA, PAYER, entries);

        assertEq(ingested, 2, "two payments ingest twice");
        (, uint128 prepaidAfter) = _tab(AGENT, SEPOLIA_ASSET);
        assertEq(prepaidAfter - prepaidBefore, 3_300, "both amounts credited exactly once");
    }

    /// @notice A genuine `Transfer` beside a `settle` of the identical amount is still credited.
    /// @dev The case that makes count matching worth its complexity. One `settle` and one direct
    /// `Transfer` of the same amount to the same recipient in one transaction is three recognised logs
    /// for **two** payments. Matching on existence alone would skip both `Transfer` logs and credit
    /// once, losing a real payment; matching by count skips exactly one.
    function test_aGenuineTransferBesideAnIdenticalSettleIsStillCredited() public {
        _bind(CHAIN_SEPOLIA, AGENT, PAYER);
        (, uint128 prepaidBefore) = _tab(AGENT, SEPOLIA_ASSET);

        EvmV1Decoder.LogEntryTuple[] memory entries = new EvmV1Decoder.LogEntryTuple[](3);
        entries[0] = SourceTxFixture.transferLog(SEPOLIA_ASSET, PAYER, COLLECTION_SEPOLIA, 5_000);
        entries[1] = SourceTxFixture.tabSettledLog(
            SETTLEMENT_SEPOLIA, PAYER, COLLECTION_SEPOLIA, 5_000, bytes32("tab")
        );
        entries[2] = SourceTxFixture.transferLog(SEPOLIA_ASSET, PAYER, COLLECTION_SEPOLIA, 5_000);

        (, uint256 ingested) = _submit(CHAIN_SEPOLIA, PAYER, entries);

        assertEq(ingested, 2, "two payments survive, one duplicate representation is dropped");
        (, uint128 prepaidAfter) = _tab(AGENT, SEPOLIA_ASSET);
        assertEq(prepaidAfter - prepaidBefore, 10_000, "both payments credited");
    }

    /// @notice A `Transfer` naming a different payment is untouched by the de-duplication.
    /// @dev The rule matches on the whole `(payer, recipient, amount)` triple, so a `TabSettled` for a
    /// different amount supersedes nothing. Without this the fix could silently swallow an unrelated
    /// Settlement that happened to share a transaction.
    function test_aTransferOfADifferentAmountIsNotSuperseded() public {
        _bind(CHAIN_SEPOLIA, AGENT, PAYER);
        (, uint128 prepaidBefore) = _tab(AGENT, SEPOLIA_ASSET);

        EvmV1Decoder.LogEntryTuple[] memory entries = new EvmV1Decoder.LogEntryTuple[](2);
        entries[0] = SourceTxFixture.transferLog(SEPOLIA_ASSET, PAYER, COLLECTION_SEPOLIA, 900);
        entries[1] = SourceTxFixture.tabSettledLog(
            SETTLEMENT_SEPOLIA, PAYER, COLLECTION_SEPOLIA, 4_100, bytes32("tab")
        );

        (, uint256 ingested) = _submit(CHAIN_SEPOLIA, PAYER, entries);

        assertEq(ingested, 2, "different amounts are different payments");
        (, uint128 prepaidAfter) = _tab(AGENT, SEPOLIA_ASSET);
        assertEq(prepaidAfter - prepaidBefore, 5_000, "both credited");
    }

    /// @notice Resubmitting an already ingested log reverts and changes nothing.
    function test_resubmittingAnIngestedLogReverts() public {
        _bind(CHAIN_MAINNET, AGENT, PAYER);

        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_MAINNET, 4_000));
        bytes memory encoded = SourceTxFixture.encode(PAYER, entries);
        uint64 height = nextHeight++;

        verifier.submitSettlement(_sourceTx(CHAIN_MAINNET, height, encoded));
        (, uint128 prepaidAfterFirst) = _tab(AGENT, USDC);

        vm.expectRevert(
            abi.encodeWithSelector(
                TabAscBase.AlreadyClaimed.selector, verifier.replayKey(CHAIN_MAINNET, height, 0, 0)
            )
        );
        verifier.submitSettlement(_sourceTx(CHAIN_MAINNET, height, encoded));

        (, uint128 prepaidNow) = _tab(AGENT, USDC);
        assertEq(prepaidNow, prepaidAfterFirst, "the replay changed nothing");
    }

    /// @notice A recipient no Service has claimed is rejected, not silently dropped.
    function test_anUnclaimedRecipientReverts() public {
        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, PAYER, UNCLAIMED_COLLECTION, 4_000));

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementVerifier.UnknownCollectionAddress.selector,
                CHAIN_MAINNET,
                UNCLAIMED_COLLECTION,
                USDC
            )
        );
        verifier.submitSettlement(
            _sourceTx(CHAIN_MAINNET, nextHeight, SourceTxFixture.encode(PAYER, entries))
        );
    }

    /// @notice A `TabSettled` log naming an unclaimed recipient is rejected too.
    function test_anUnclaimedRecipientOnTheTabSettledPathReverts() public {
        EvmV1Decoder.LogEntryTuple[] memory entries = SourceTxFixture.one(
            SourceTxFixture.tabSettledLog(
                SETTLEMENT_SEPOLIA, PAYER, UNCLAIMED_COLLECTION, 4_000, keccak256("tab")
            )
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementVerifier.UnknownCollectionAddress.selector,
                CHAIN_SEPOLIA,
                UNCLAIMED_COLLECTION,
                address(0)
            )
        );
        verifier.submitSettlement(
            _sourceTx(CHAIN_SEPOLIA, nextHeight, SourceTxFixture.encode(PAYER, entries))
        );
    }

    /// @notice An Asset paying into another Asset's Collection Address is rejected. (R18.4)
    function test_anAssetMismatchReverts() public {
        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_USDT, 4_000));

        vm.expectRevert(abi.encodeWithSelector(SettlementVerifier.AssetMismatch.selector, USDC, USDT));
        verifier.submitSettlement(
            _sourceTx(CHAIN_MAINNET, nextHeight, SourceTxFixture.encode(PAYER, entries))
        );
    }

    /// @notice A payer bound to no Agent is named rather than credited to nobody.
    function test_anUnboundPayerReverts() public {
        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, UNBOUND_PAYER, COLLECTION_MAINNET, 4_000));

        vm.expectRevert(
            abi.encodeWithSelector(SettlementVerifier.UnboundPayer.selector, CHAIN_MAINNET, UNBOUND_PAYER)
        );
        verifier.submitSettlement(
            _sourceTx(CHAIN_MAINNET, nextHeight, SourceTxFixture.encode(UNBOUND_PAYER, entries))
        );
    }

    /// @notice A rejected proof credits nothing, and the tab is exactly as it was.
    function test_aRejectedProofChangesNoState() public {
        _bind(CHAIN_MAINNET, AGENT, PAYER);
        (, uint128 prepaidBefore) = _tab(AGENT, USDC);

        prover.setRejectProofs(true);

        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_MAINNET, 4_000));
        uint64 height = nextHeight++;
        TabAscBase.SourceTx memory sourceTx =
            _sourceTx(CHAIN_MAINNET, height, SourceTxFixture.encode(PAYER, entries));

        vm.expectRevert(
            abi.encodeWithSelector(
                TabAscBase.ProofRejected.selector, CHAIN_MAINNET, height, sourceTx.merkleProof.root
            )
        );
        verifier.submitSettlement(sourceTx);

        (, uint128 prepaidAfter) = _tab(AGENT, USDC);
        assertEq(prepaidAfter, prepaidBefore, "no credit from a rejected proof");
        assertFalse(verifier.claimedLog(verifier.replayKey(CHAIN_MAINNET, height, 0, 0)), "nothing claimed");
    }

    /// @notice A reverted Source Chain transaction credits nothing, whatever its logs say.
    function test_aRevertedSourceTransactionCreditsNothing() public {
        _bind(CHAIN_MAINNET, AGENT, PAYER);
        (, uint128 prepaidBefore) = _tab(AGENT, USDC);

        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_MAINNET, 4_000));
        bytes memory encoded =
            SourceTxFixture.encodeWithStatus(PAYER, SourceTxFixture.STATUS_REVERTED, entries);
        uint64 height = nextHeight++;

        vm.expectRevert(
            abi.encodeWithSelector(TabAscBase.SourceTransactionReverted.selector, CHAIN_MAINNET, height, 0)
        );
        verifier.submitSettlement(_sourceTx(CHAIN_MAINNET, height, encoded));

        (, uint128 prepaidAfter) = _tab(AGENT, USDC);
        assertEq(prepaidAfter, prepaidBefore, "no credit from a reverted transaction");
    }

    /// @notice A batch of two Settlements runs through the identical ingestion path as two singles.
    /// @dev Each member carries its own Continuity Proof, which is the only place a proof can travel:
    /// there is no proof parameter beside the array, so the shared-proof pairing is unexpressible.
    function test_aBatchIngestsEveryMember() public {
        _bind(CHAIN_MAINNET, AGENT, PAYER);
        (, uint128 prepaidBefore) = _tab(AGENT, USDC);

        TabAscBase.SourceTx[] memory batch = new TabAscBase.SourceTx[](2);
        for (uint256 i = 0; i < 2; ++i) {
            EvmV1Decoder.LogEntryTuple[] memory entries =
                SourceTxFixture.one(SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_MAINNET, 1_000 + i));
            batch[i] = _sourceTx(CHAIN_MAINNET, nextHeight++, SourceTxFixture.encode(PAYER, entries));
        }

        uint256 ingested = verifier.submitSettlementBatch(batch);

        assertEq(ingested, 2, "both members ingested");
        (, uint128 prepaidAfter) = _tab(AGENT, USDC);
        assertEq(prepaidAfter - prepaidBefore, 2_001, "both amounts credited");
    }

    /// @notice The proof call carries the submitted struct through unchanged.
    /// @dev Asserted against what the etched precompile decoded, not against what was passed in, so a
    /// `SourceTx` layout that disagreed with the interface would be caught here rather than assumed.
    function test_theProofCallCarriesTheSubmittedStruct() public {
        _bind(CHAIN_MAINNET, AGENT, PAYER);

        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, PAYER, COLLECTION_MAINNET, 4_000));
        bytes memory encoded = SourceTxFixture.encode(PAYER, entries);
        uint64 height = nextHeight++;
        TabAscBase.SourceTx memory sourceTx = _sourceTx(CHAIN_MAINNET, height, encoded);

        verifier.submitSettlement(sourceTx);

        assertEq(prover.lastChainKey(), CHAIN_MAINNET, "chainKey reached the precompile");
        assertEq(prover.lastHeight(), height, "height reached the precompile");
        assertEq(prover.lastMerkleRoot(), sourceTx.merkleProof.root, "merkle root reached the precompile");
        assertEq(
            prover.lastLowerEndpointDigest(),
            sourceTx.continuityProof.lowerEndpointDigest,
            "continuity proof reached the precompile"
        );
        assertEq(prover.lastEncodedTransactionDigest(), keccak256(encoded), "transaction bytes unaltered");
    }
}
