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

/// @title BondFundingTest
/// @notice Proves that a fresh deployment can create stake, and therefore that it can meter anything
/// at all.
/// @dev **This suite exists because no other one could have caught the gap it covers.** Stake is
/// denominated in the Settlement Asset and the Asset lives on a Source Chain, so the only way stake
/// can come into existence is a proven deposit arriving through `SettlementVerifier`. That call was
/// missing: `Bond.fundFromVerifiedSettlement` was written, gated, and never called, so every ledger
/// sat at zero, every bond cap was zero, every Credit Limit was zero, and no delivery could be
/// metered. Every existing suite hid it by funding the Bond with `vm.prank(address(verifier))`, which
/// is a shortcut that can make a contract look wired when nothing wires it.
///
/// So the rule here is that the verifier is never impersonated. Every figure this suite asserts is
/// produced by submitting a real decodable `Transfer` through `submitSettlement` and letting the
/// contracts decide what it means. The only stand-in anywhere is the BlockProver Precompile, which
/// does not exist locally and is etched at the address the address library names.
///
/// Requirements: 2.2, 2.3, 11.6, 14.1, 14.2, 18.6
contract BondFundingTest is Test {
    // ------------------------------------------------------------------ the tree

    /// @notice Registry of emitters, Collection Addresses, prices, and tiers.
    ServiceRegistry internal registry;

    /// @notice Registry that binds Source Chain payer addresses to Creditcoin identities.
    AgentRegistry internal agents;

    /// @notice Bond the proven deposit credits stake in.
    Bond internal bond;

    /// @notice Book a tab payment is applied to, and which reads stake to bound a Credit Limit.
    TabBook internal book;

    /// @notice Contract under test, in the sense that it is the thing that routes.
    SettlementVerifier internal verifier;

    /// @notice The etched stand-in for the BlockProver Precompile.
    MockBlockProver internal prover;

    // ------------------------------------------------------------------ constants

    /// @notice Address the BlockProver Precompile lives at, which is where the mock is etched.
    address internal constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;

    /// @notice Attested-chain identifier of Ethereum Mainnet, where Tab deploys nothing.
    uint64 internal constant CHAIN_MAINNET = 3;

    /// @notice Creditcoin address that operates the Service, and therefore its Bond party.
    address internal constant OPERATOR = address(0x0FE1);

    /// @notice The Agent whose delivery is metered.
    address internal constant AGENT = address(0xA6E7);

    /// @notice The wired Watcher. Present only because the book takes one.
    address internal constant WATCHER = address(0x3A7C);

    /// @notice Source Chain address the Service operator binds and funds its Bond from.
    address internal constant FUNDER = address(0x9A7E);

    /// @notice Source Chain address the Agent binds and settles its own tab from.
    address internal constant AGENT_PAYER = address(0x9A7F);

    /// @notice A Source Chain address bound to nobody, used to prove a deposit still needs a binding.
    address internal constant STRANGER = address(0x9A80);

    /// @notice Launch Asset on Ethereum Mainnet.
    address internal constant USDC = address(0x05DC);

    /// @notice The Service's ordinary Collection Address, whose Settlements reduce an Open Tab.
    address internal constant TAB_COLLECTION = address(0xC011);

    /// @notice The Service's Bond Collection Address, whose Settlements credit stake.
    address internal constant BOND_COLLECTION = address(0xC0B0);

    /// @notice An address claimed by nobody, used for the second half of the both-kinds rule.
    address internal constant SPARE_COLLECTION = address(0xC0FF);

    /// @notice The Service under test.
    bytes32 internal constant SERVICE = keccak256("proof-service");

    /// @notice A second Service, present only to contest a claim.
    bytes32 internal constant OTHER_SERVICE = keccak256("other-service");

    /// @notice The named priced tool.
    bytes32 internal constant TOOL = keccak256("proof.merkle");

    /// @notice Price of one unit of {TOOL} in Asset base units.
    uint256 internal constant PRICE = 1_000;

    /// @notice Units the metered delivery buys.
    uint32 internal constant UNITS = 200;

    /// @notice Baseline Credit Limit in Asset base units.
    uint256 internal constant BASELINE = 5_000_000;

    /// @notice Growth factor in basis points.
    uint256 internal constant GROWTH_BPS = 5_000;

    /// @notice Settlement Window the Service registers, in seconds.
    uint32 internal constant WINDOW = 6 hours;

    /// @notice The stake one proven deposit creates, in Asset base units.
    uint128 internal constant DEPOSIT = 10_000_000;

    /// @notice Wall clock the suite starts from.
    uint64 internal constant START = 1_700_000_000;

    /// @notice Source Chain block height of the next submission, so replay keys never collide.
    uint64 internal nextHeight = 21_000_000;

    // ------------------------------------------------------------------ setup

    /// @notice Deploys and wires the tree, registers the Service, and claims both kinds of address.
    /// @dev Deliberately stops short of funding anything. The first assertion every case here makes is
    /// that a fresh deployment holds no stake, so setUp must leave it that way.
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

        _registerService(SERVICE, TAB_COLLECTION);

        vm.prank(OPERATOR);
        registry.registerBondCollection(SERVICE, CHAIN_MAINNET, USDC, BOND_COLLECTION);
    }

    // ------------------------------------------------------------------ the sequence that matters

    /// @notice A fresh deployment is not inert: register, fund by proven deposit, then meter.
    /// @dev This is the sequence a real deployment performs, in the order it performs it, and every
    /// step is a call an operator or an Agent actually makes. The two assertions in the middle are the
    /// ones that would have failed before this task: with no stake there is no bond cap, so the Credit
    /// Limit is zero and the delivery is refused, and the only thing that can change that is a proven
    /// deposit. (R14.1, R14.2, R18.6)
    function test_aFreshDeploymentCanFundItsBondAndOnlyThenMeter() public {
        bytes32 party = _party();
        _bindFunder();

        // 1. No stake exists yet, because nothing has been deposited.
        assertEq(bond.ledgerOf(party, USDC).staked, 0, "fresh deployment holds no stake");

        // 2. So the Credit Limit is zero and a delivery cannot be metered.
        _authorise();
        assertEq(book.creditLimit(AGENT, USDC, _witness()), 0, "no stake, no Credit Limit");

        uint256 charge = uint256(UNITS) * PRICE;
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(ITabBook.LimitExceeded.selector, AGENT, USDC, charge, uint256(0))
        );
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, UNITS, PRICE, _witness());

        // 3. Fund the Bond by submitting a real proven Transfer to the Bond Collection Address.
        (uint128 openBefore, uint128 prepaidBefore) = _serviceTab();
        _submitTransfer(FUNDER, BOND_COLLECTION, DEPOSIT);

        // 4. The stake rose, and the Service's own tab gained nothing.
        assertEq(bond.ledgerOf(party, USDC).staked, DEPOSIT, "stake credited from the proof");
        assertEq(bond.freeOf(party, USDC), DEPOSIT, "the whole deposit is free");

        (uint128 openAfter, uint128 prepaidAfter) = _serviceTab();
        assertEq(openAfter, openBefore, "the deposit did not touch the Open Tab");
        assertEq(prepaidAfter, prepaidBefore, "the deposit did not become prepaid credit");

        // 5. And now a delivery meters, because there is a Credit Limit to meter it against.
        assertEq(book.creditLimit(AGENT, USDC, _witness()), BASELINE, "baseline under the bond cap");

        vm.prank(OPERATOR);
        (uint256 charged, uint128 openNow,) =
            book.recordDelivery(AGENT, SERVICE, USDC, TOOL, UNITS, PRICE, _witness());

        assertEq(charged, charge, "metered charge");
        assertEq(openNow, uint128(charge), "the tab opened");
    }

    /// @notice A proven Bond deposit says so in its own event, and never as a tab reduction.
    /// @dev A stake credit and a tab reduction are different economic facts, so an indexer that summed
    /// one event for both would count collateral as revenue. The Bond's own `BondFunded` is emitted
    /// too, carrying the replay key of the proof that created the stake. (R14.1)
    function test_aBondDepositEmitsItsOwnEvent() public {
        bytes32 party = _party();
        _bindFunder();

        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, FUNDER, BOND_COLLECTION, DEPOSIT));
        uint64 height = nextHeight++;
        bytes32 key = verifier.replayKey(CHAIN_MAINNET, height, 0, 0);

        vm.expectEmit(true, true, false, true, address(bond));
        emit IBond.BondFunded(party, USDC, DEPOSIT, key);

        vm.expectEmit(true, true, true, true, address(verifier));
        emit SettlementVerifier.BondDepositRecorded(
            key, CHAIN_MAINNET, height, 0, 0, OPERATOR, SERVICE, USDC, DEPOSIT, FUNDER, party
        );

        verifier.submitSettlement(_sourceTx(height, SourceTxFixture.encode(FUNDER, entries)));
    }

    /// @notice A deposit from an address bound to nobody is refused, exactly as a tab payment is.
    /// @dev Payer resolution runs before the branch and not inside one arm of it. A Service funds its
    /// Bond from an address it has bound, so an unbound funder is the same fault on both paths — and
    /// skipping the check here would let any stranger's transfer to a published Bond Collection Address
    /// credit that Service's collateral. (R8.4, R14.1)
    function test_aBondDepositFromAnUnboundAddressReverts() public {
        bytes32 party = _party();

        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, STRANGER, BOND_COLLECTION, DEPOSIT));

        vm.expectRevert(
            abi.encodeWithSelector(SettlementVerifier.UnboundPayer.selector, CHAIN_MAINNET, STRANGER)
        );
        verifier.submitSettlement(_sourceTx(nextHeight, SourceTxFixture.encode(STRANGER, entries)));

        assertEq(bond.ledgerOf(party, USDC).staked, 0, "no stake from an unbound funder");
    }

    /// @notice A deposit wider than the ledger's own figures is refused rather than narrowed.
    /// @dev The bound `TabBook` applies to a Verified Settlement, applied on the branch that does not
    /// go through `TabBook`, so the two crediting paths agree on what an amount may be. (R14.2)
    function test_aBondDepositBeyondTheLedgerWidthReverts() public {
        _bindFunder();

        uint256 tooLarge = uint256(type(uint128).max) + 1;
        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, FUNDER, BOND_COLLECTION, tooLarge));

        vm.expectRevert(abi.encodeWithSelector(SettlementVerifier.BondDepositOutOfRange.selector, tooLarge));
        verifier.submitSettlement(_sourceTx(nextHeight, SourceTxFixture.encode(FUNDER, entries)));
    }

    /// @notice An ordinary Collection Address still reduces an Open Tab and still creates no stake.
    /// @dev The regression the branch has to avoid. `Tab` is the zero value of the kind, so a record
    /// written without one reads as what it always meant, and the whole existing settlement suite is
    /// the wider version of this assertion. (R2.3, R12.4, R12.5)
    function test_aTabCollectionStillReducesTheOpenTabAndCreatesNoStake() public {
        bytes32 party = _party();
        _bindFunder();
        _submitTransfer(FUNDER, BOND_COLLECTION, DEPOSIT);

        _authorise();
        uint256 charge = uint256(UNITS) * PRICE;
        vm.prank(OPERATOR);
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, UNITS, PRICE, _witness());

        // The Agent's own Source Chain address, bound by paying the amount the registry issues, which
        // is itself a Verified Settlement and therefore already reduces the tab it lands on.
        vm.prank(AGENT);
        (, uint256 bindingAmount,) = agents.requestBinding(CHAIN_MAINNET, AGENT_PAYER);
        _submitTransfer(AGENT_PAYER, TAB_COLLECTION, bindingAmount);
        _submitTransfer(AGENT_PAYER, TAB_COLLECTION, charge - bindingAmount);

        ITabBook.Tab memory tab = book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC));
        assertEq(tab.open, 0, "the tab payment reduced the Open Tab");
        assertEq(tab.prepaid, 0, "and did not spill into prepaid credit");
        assertEq(bond.ledgerOf(party, USDC).staked, DEPOSIT, "a tab payment creates no stake");
    }

    // ------------------------------------------------------------------ the registry rule

    /// @notice One address is one kind, in both directions, because one address is one claim.
    /// @dev Per-chain uniqueness already did this work, and routing Bond deposits through the same
    /// claim path is what keeps it doing it. An address that resolved as both kinds would make the
    /// meaning of a deposit depend on which record was read. (R2.2, R14.1)
    function test_anAddressCannotBeClaimedAsBothKinds() public {
        // A tab collection cannot be re-claimed as a Bond Collection Address.
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                IServiceRegistry.CollectionAddressTaken.selector, CHAIN_MAINNET, TAB_COLLECTION, SERVICE
            )
        );
        registry.registerBondCollection(SERVICE, CHAIN_MAINNET, USDC, TAB_COLLECTION);

        // And a Bond Collection Address cannot be re-claimed as a tab collection, by anybody.
        vm.expectRevert(
            abi.encodeWithSelector(
                IServiceRegistry.CollectionAddressTaken.selector, CHAIN_MAINNET, BOND_COLLECTION, SERVICE
            )
        );
        _registerService(OTHER_SERVICE, BOND_COLLECTION);
    }

    /// @notice Claiming a Bond Collection Address is the Service operator's act and nobody else's.
    /// @dev Stronger than registration's own collection claims, and deliberately so: this record names
    /// whose ledger a proven deposit grows, which registration's self-describing Asset claims do not.
    function test_registerBondCollectionIsGatedOnTheOperator() public {
        vm.expectRevert(
            abi.encodeWithSelector(IServiceRegistry.NotServiceOperator.selector, SERVICE, address(this))
        );
        registry.registerBondCollection(SERVICE, CHAIN_MAINNET, USDC, SPARE_COLLECTION);

        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(IServiceRegistry.UnknownService.selector, OTHER_SERVICE));
        registry.registerBondCollection(OTHER_SERVICE, CHAIN_MAINNET, USDC, SPARE_COLLECTION);
    }

    /// @notice The record a Bond claim writes says Bond, and a registration's records say Tab.
    function test_theCollectionRecordCarriesItsKind() public view {
        IServiceRegistry.CollectionRecord memory tab = registry.collectionFor(CHAIN_MAINNET, TAB_COLLECTION);
        assertTrue(tab.exists, "tab collection resolves");
        assertEq(uint256(tab.kind), uint256(IServiceRegistry.CollectionKind.Tab), "registration is Tab");

        IServiceRegistry.CollectionRecord memory stake =
            registry.collectionFor(CHAIN_MAINNET, BOND_COLLECTION);
        assertTrue(stake.exists, "bond collection resolves");
        assertEq(stake.serviceId, SERVICE, "bond collection belongs to the Service");
        assertEq(stake.asset, USDC, "bond collection collects the stake Asset");
        assertEq(uint256(stake.kind), uint256(IServiceRegistry.CollectionKind.Bond), "and it is Bond");
    }

    /// @notice A Collection Address move behind the hold carries the kind across with the Asset.
    /// @dev A move that reset the kind to its zero value would turn a Service's Bond Collection Address
    /// into an ordinary tab collection the moment its operator rotated the address, so the next proven
    /// deposit would arrive as prepaid credit instead of as stake. (R11.6, R11.7, R14.1)
    function test_movingABondCollectionKeepsItABondCollection() public {
        bytes memory payload = abi.encode(uint256(CHAIN_MAINNET), BOND_COLLECTION, SPARE_COLLECTION);

        vm.prank(OPERATOR);
        (bytes32 changeId, uint64 eta) =
            registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Collection, payload);

        vm.warp(eta);
        vm.prank(OPERATOR);
        registry.applyChange(changeId);

        assertFalse(registry.collectionFor(CHAIN_MAINNET, BOND_COLLECTION).exists, "old released");

        IServiceRegistry.CollectionRecord memory moved =
            registry.collectionFor(CHAIN_MAINNET, SPARE_COLLECTION);
        assertEq(moved.asset, USDC, "asset carried across");
        assertEq(uint256(moved.kind), uint256(IServiceRegistry.CollectionKind.Bond), "kind carried across");

        // And it still routes: a deposit to the new address credits stake, not a tab.
        _bindFunder();
        _submitTransfer(FUNDER, SPARE_COLLECTION, DEPOSIT);
        assertEq(bond.ledgerOf(_party(), USDC).staked, DEPOSIT, "the moved address still funds the Bond");
    }

    // ------------------------------------------------------------------ helpers

    /// @notice Register one Service accepting USDC on Mainnet at the given Collection Address.
    /// @param serviceId Identifier to claim.
    /// @param collection Collection Address the registration claims, always as a tab collection.
    function _registerService(bytes32 serviceId, address collection) internal {
        uint64[] memory chainKeys = new uint64[](1);
        chainKeys[0] = CHAIN_MAINNET;

        address[] memory assets = new address[](1);
        assets[0] = USDC;

        address[] memory collections = new address[](1);
        collections[0] = collection;

        bytes32[] memory tools = new bytes32[](1);
        tools[0] = TOOL;

        uint256[] memory prices = new uint256[](1);
        prices[0] = PRICE;

        vm.prank(OPERATOR);
        registry.registerService(serviceId, chainKeys, assets, collections, tools, prices, WINDOW);
    }

    /// @notice The Bond party key the Service's stake sits under.
    /// @dev Read the way `TabBook` reads it, through the registry's `bondAccount` and the Bond's own
    /// embedding, so the test cannot agree with a derivation the contracts do not share.
    /// @return party Key the ledgers are held under.
    function _party() internal view returns (bytes32 party) {
        party = bond.partyOf(registry.serviceOf(SERVICE).bondAccount);
    }

    /// @notice Bind the Service's funding address, by paying the exact amount the registry issues.
    /// @dev The honest path and the only one there is. The binding payment goes to the tab collection
    /// rather than the Bond one, so the Bond ledger is still empty when the first assertion reads it.
    function _bindFunder() internal {
        vm.prank(OPERATOR);
        (, uint256 amount,) = agents.requestBinding(CHAIN_MAINNET, FUNDER);

        _submitTransfer(FUNDER, TAB_COLLECTION, amount);
        assertEq(agents.agentOf(CHAIN_MAINNET, FUNDER), OPERATOR, "funder bound by payment");
    }

    /// @notice Grant a spending authorisation as the Agent, so a delivery may be metered at all.
    function _authorise() internal {
        vm.prank(AGENT);
        // casting to 'uint64' is safe because the suite's clock is a fixed constant far below 2^64.
        // forge-lint: disable-next-line(unsafe-typecast)
        book.authorise(SERVICE, USDC, type(uint128).max, uint64(block.timestamp) + 365 days);
    }

    /// @notice The witness a Credit Limit is computed from: no history, one counterparty entry.
    /// @dev The Bond amount supplied is zero and is discarded either way, because `TabBook` replaces
    /// every entry's amount with the figure the ledger actually holds. That is what makes the
    /// before-and-after assertions in this suite mean something.
    /// @return witness History and Bond figures.
    function _witness() internal pure returns (ITabBook.LimitWitness memory witness) {
        LimitLib.BondEntry[] memory bonds = new LimitLib.BondEntry[](1);
        bonds[0] = LimitLib.BondEntry({serviceId: SERVICE, asset: USDC, amount: 0});

        witness = ITabBook.LimitWitness({history: new LimitLib.SettlementRecord[](0), bonds: bonds});
    }

    /// @notice The tab the Service would wrongly gain prepaid credit on if a deposit were misrouted.
    /// @dev Keyed on the identity the funder resolves to, which is the identity a misrouted deposit
    /// would be credited against.
    /// @return open Open Tab in Asset base units.
    /// @return prepaid Prepaid credit in Asset base units.
    function _serviceTab() internal view returns (uint128 open, uint128 prepaid) {
        ITabBook.Tab memory tab = book.tabOf(book.tabIdOf(OPERATOR, SERVICE, USDC));
        open = tab.open;
        prepaid = tab.prepaid;
    }

    /// @notice One Source Chain transaction with its proof material, ready to submit.
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
            root: keccak256(abi.encode(CHAIN_MAINNET, height)),
            siblings: new INativeQueryVerifier.MerkleProofEntry[](0)
        });
        sourceTx.continuityProof = INativeQueryVerifier.ContinuityProof({
            lowerEndpointDigest: keccak256(abi.encode("endpoint", height)), roots: new bytes32[](0)
        });
    }

    /// @notice Submit one ERC-20 `Transfer` Settlement at the next unused height.
    /// @param payer Sender, which lands in `topics[1]`, and also the transaction sender here.
    /// @param recipient Recipient, which lands in `topics[2]`.
    /// @param amount Transferred amount.
    /// @return height The height the submission was made at.
    function _submitTransfer(address payer, address recipient, uint256 amount)
        internal
        returns (uint64 height)
    {
        EvmV1Decoder.LogEntryTuple[] memory entries =
            SourceTxFixture.one(SourceTxFixture.transferLog(USDC, payer, recipient, amount));

        height = nextHeight++;
        verifier.submitSettlement(_sourceTx(height, SourceTxFixture.encode(payer, entries)));
    }
}
