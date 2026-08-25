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
import {SourceTxFixture} from "../mocks/SourceTxFixture.sol";

// Feature: tab, Property 12: Batch settlement equals sequential settlement

// ---------------------------------------------------------------- shared constants
//
// File-level rather than inherited, so the etched precompile stand-in and the campaign below name the
// same figures by construction. Plain comments rather than natspec, because solc rejects
// documentation tags on file-level variables.

// Address the BlockProver Precompile lives at, which is where the trace-recording stand-in is etched.
address constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;

// Attested-chain identifier of Ethereum Mainnet, where a Settlement is a plain ERC-20 `Transfer`.
uint64 constant CHAIN_MAINNET = 3;

// The one Agent whose figures the two submission shapes are compared over.
address constant AGENT = address(0xA6E7);

// Creditcoin address that operates the one Service, and so the party its stake sits under.
address constant OPERATOR = address(0x0FE1);

// Wired Watcher. Present only because `TabBook` takes one; no clearing is applied here.
address constant WATCHER = address(0x3A7C);

// Source Chain address bound to {AGENT}, and the `topics[1]` payer of every generated Settlement.
address constant PAYER = address(0x9A7E);

// Source Chain address bound to {OPERATOR}, which funds the Service's Bond by proven deposit.
address constant FUNDER = address(0x9A7F);

// The one Asset in scope.
address constant USDC = address(0x05DC);

// Collection Address that receives tab payments in {USDC} on Ethereum Mainnet.
address constant TAB_COLLECTION = address(0xC011);

// Collection Address that receives the Service's own Bond deposit in {USDC}.
address constant BOND_COLLECTION = address(0xC0B1);

// Emitter of the padding logs. Its authorisation is irrelevant: a log with no topics is skipped
// before recognition runs at all.
address constant PAD_EMITTER = address(0x0BAD);

// Reason an armed tripwire reverts with. File-level so the stand-in that raises it and the campaign
// that expects it name the same string.
string constant TRIPWIRE = "the precompile was called";

// The one Service in scope.
bytes32 constant SERVICE = bytes32("batch-equivalence-service");

// The one named priced tool in scope.
bytes32 constant TOOL = bytes32("batch-equivalence-tool");

// Price of one unit of the tool in Asset base units.
uint256 constant PRICE = 1_000;

// Units metered in `setUp`, so an Open Tab exists for the generated Settlements to reduce.
uint32 constant DELIVERY_UNITS = 2_000;

// What those units cost, in Asset base units. Stated rather than multiplied so the fixture assertion
// compares two figures of the same width.
uint128 constant DELIVERY_CHARGE = 2_000_000;

// Baseline Credit Limit in Asset base units.
uint256 constant BASELINE = 5_000_000;

// Growth factor in basis points.
uint256 constant GROWTH_BPS = 5_000;

// Stake the Service funds by proven deposit, which is what makes a Credit Limit non-zero at all.
uint128 constant BOND_STAKE = 10_000_000;

// Settlement Window the Service registers, in seconds.
uint32 constant WINDOW = 6 hours;

// Wall clock the campaign runs at. Never advanced, which is what lets `settledAt` be a constant in
// the reconstructed witness.
uint64 constant START = 1_700_000_000;

// Source Chain block height the lowest member of a generated set sits at.
uint64 constant BASE_HEIGHT = 21_000_000;

// Heights the two `setUp` bindings and the Bond deposit are proved at, below every generated member
// so no fixture submission can collide with a generated replay key.
uint64 constant SETUP_HEIGHT = 20_999_000;

// Largest generated set. Above the contract's bound of 10 on purpose: 11 through 14 are the region
// where `BatchTooLarge` must fire, so the generator has to reach past the bound to test it.
uint256 constant MAX_MEMBERS = 14;

// Widest generated block span. Above the contract's bound of 1000 for the same reason.
uint256 constant MAX_SPAN = 1_500;

// The contract's own bounds, restated here so the campaign asserts against figures it names itself
// rather than against whatever the contract happens to hold.
uint256 constant BATCH_LIMIT = 10;
uint64 constant SPAN_LIMIT = 1_000;

// Largest generated Settlement amount. Ten members at this figure total 4,000,000 against an Open Tab
// near 2,000,000, so a generated set reaches both the reducing branch and the prepaid-credit branch.
uint128 constant MAX_AMOUNT = 400_000;

/// @notice The shared-proof batch shape acceptance criterion 9.7 forbids, declared so that its
/// absence from the ABI can be established by calling for it rather than by reading the source.
/// @dev Nothing implements this interface. It exists to be encoded against
/// `SettlementVerifier`'s address, where a dispatcher with no such function and no fallback rejects
/// the selector. The member struct deliberately stops at the Merkle Proof, because that is exactly
/// the shape the forbidden overload would need: proof material per member, one Continuity Proof
/// beside the array.
interface ISharedProofBatch {
    /// @notice One batch member with no Continuity Proof of its own.
    struct SourceTxWithoutProof {
        /// @dev Attested-chain identifier the transaction belongs to.
        uint64 chainKey;
        /// @dev Source Chain block height holding the transaction.
        uint64 blockHeight;
        /// @dev The transaction as published on the Source Chain.
        bytes encodedTransaction;
        /// @dev Inclusion proof against the block's transaction-trie root.
        INativeQueryVerifier.MerkleProof merkleProof;
    }

    /// @notice The forbidden overload: a settlement array plus one proof for the whole batch.
    /// @param sourceTxs The batch members.
    /// @param sharedProof The one Continuity Proof the batch would share.
    /// @return ingestedLogs Total Settlement logs the call would ingest.
    function submitSettlementBatch(
        SourceTxWithoutProof[] calldata sourceTxs,
        INativeQueryVerifier.ContinuityProof calldata sharedProof
    ) external returns (uint256 ingestedLogs);
}

/// @title BatchTraceProver
/// @notice Stand-in for the BlockProver Precompile that records what each verification call carried.
/// @dev Two properties of this contract are the instrument, not decoration.
///
/// **It implements exactly the two functions `INativeQueryVerifier` declares, and no array-shaped
/// overload.** The live precompile does publish array-shaped `verify` and `verifyAndEmit` overloads,
/// and R9.7 forbids `SettlementVerifier` from calling them because a batch-wide boolean cannot name
/// the Settlement that failed. Here the forbidden overload simply does not exist, so a contract that
/// reached for it would hit an unknown selector on a dispatcher with no fallback and the submission
/// would revert. The campaign therefore establishes R9.7's behavioural half by observing that every
/// batch completes through N single-proof calls.
///
/// **It records per call rather than only the last call.** One Continuity Proof per member is the
/// corrected shape, so the interesting question is not whether a proof arrived but whether the proof
/// that arrived at step `i` was member `i`'s own. Recording the `lowerEndpointDigest` of every call in
/// order answers that: a shared proof would show one digest repeated, and per-member proofs show the
/// distinct digests the generator built.
///
/// Etched rather than mocked per call, because a real ABI decoder is generated for it: a `SourceTx`
/// field ordering that did not match would fail to decode here and the campaign would go red.
/// Storage starts all-zero after an etch, which is the useful default — an empty trace, and a
/// `rejectRoot` of zero that no keccak-derived root can equal, so proofs verify until one is named.
contract BatchTraceProver is INativeQueryVerifier {
    /// @notice Transaction-trie root whose verification answers `false`.
    /// @dev A `false` return rather than a revert, because `ProofRejected` is the branch R9.5 covers.
    bytes32 public rejectRoot;

    /// @notice While armed, any verification call at all reverts with {TRIPWIRE}.
    /// @dev How "an ill-formed batch costs no proof call" is established rather than assumed. A
    /// revert rolls the trace back along with everything else, so comparing the recorded trace across
    /// a reverted submission cannot see whether a call was made — the arrays are restored either way.
    /// The tripwire turns the absence into something observable: with it armed, one verification call
    /// changes the revert data the submission produces, and the rejecting campaigns assert the revert
    /// data exactly. Getting `BatchTooLarge` or `BatchRangeExceeded` back is therefore evidence that
    /// the precompile was never reached. (R9.3, R9.4)
    bool public tripwire;

    /// @notice Source Chain block height of each verification call, in call order.
    uint64[] internal _heights;

    /// @notice Claimed transaction-trie root of each call, in call order.
    bytes32[] internal _roots;

    /// @notice Lower endpoint digest of each call's Continuity Proof, in call order.
    bytes32[] internal _endpoints;

    /// @notice Root count of each call's Continuity Proof, in call order.
    uint256[] internal _rootCounts;

    /// @notice Digest of the encoded transaction each call carried, in call order.
    bytes32[] internal _txDigests;

    /// @notice Attested-chain identifier each call carried, in call order.
    uint64[] internal _chainKeys;

    /// @notice Name the one proof that must fail, or clear the naming with a zero.
    /// @param root Transaction-trie root to reject.
    function setRejectRoot(bytes32 root) external {
        rejectRoot = root;
    }

    /// @notice Arm or disarm the tripwire.
    /// @param armed True to make every verification call revert.
    function setTripwire(bool armed) external {
        tripwire = armed;
    }

    /// @inheritdoc INativeQueryVerifier
    /// @dev Records the whole call before answering, so a rejected proof is still visible in the
    /// trace of any submission that survives. The transaction digest is recorded alongside the proof
    /// material because the pairing is the point: member `i`'s proof has to arrive with member `i`'s
    /// transaction, and nothing weaker than recording both establishes that.
    function verifyAndEmit(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external override returns (bool verified) {
        require(!tripwire, TRIPWIRE);

        _chainKeys.push(chainKey);
        _heights.push(height);
        _roots.push(merkleProof.root);
        _endpoints.push(continuityProof.lowerEndpointDigest);
        _rootCounts.push(continuityProof.roots.length);
        _txDigests.push(keccak256(encodedTransaction));
        return merkleProof.root != rejectRoot;
    }

    /// @inheritdoc INativeQueryVerifier
    /// @dev A constant zero. The live precompile derives the index from the sibling laterality of the
    /// proof; what this campaign needs is a fixed index, so that replay-key distinctness across
    /// members rests on the log ordinal alone and two members may legitimately share a height.
    function calculateTxIndex(MerkleProof calldata) external pure override returns (uint64 txIndex) {
        return 0;
    }

    /// @notice How many verification calls have been made.
    /// @return count The call count.
    function callCount() external view returns (uint256 count) {
        return _heights.length;
    }

    /// @notice Source Chain block height of every call so far, in call order.
    /// @return heights_ The heights.
    function heights() external view returns (uint64[] memory heights_) {
        return _heights;
    }

    /// @notice Claimed transaction-trie root of every call so far, in call order.
    /// @return roots_ The roots.
    function roots() external view returns (bytes32[] memory roots_) {
        return _roots;
    }

    /// @notice Continuity Proof endpoint digest of every call so far, in call order.
    /// @return endpoints_ The digests.
    function endpoints() external view returns (bytes32[] memory endpoints_) {
        return _endpoints;
    }

    /// @notice Continuity Proof root count of every call so far, in call order.
    /// @return counts_ The counts.
    function rootCounts() external view returns (uint256[] memory counts_) {
        return _rootCounts;
    }

    /// @notice Digest of the encoded transaction of every call so far, in call order.
    /// @return digests_ The digests.
    function txDigests() external view returns (bytes32[] memory digests_) {
        return _txDigests;
    }

    /// @notice Attested-chain identifier of every call so far, in call order.
    /// @return chainKeys_ The identifiers.
    function chainKeys() external view returns (uint64[] memory chainKeys_) {
        return _chainKeys;
    }
}

/// @notice One generated member of a settlement set.
/// @dev `logIndex` is the ordinal the member's Settlement log sits at inside its own receipt, and it
/// is what keeps replay keys distinct when the generated span is narrower than the member count. The
/// proof material is per member and distinct by construction: `root` and `endpoint` are derived from
/// the member's position, so a shared Continuity Proof would be visible as a repeated digest.
struct Member {
    /// @dev Source Chain block height the member is proved at.
    uint64 height;
    /// @dev Ordinal of the Settlement log within the member's receipt.
    uint64 logIndex;
    /// @dev Settled amount in Asset base units.
    uint128 amount;
    /// @dev Lower endpoint digest of this member's own Continuity Proof.
    bytes32 endpoint;
    /// @dev Transaction-trie root this member's Merkle Proof claims.
    bytes32 root;
}

/// @notice Every figure the two submission shapes are compared on, at one instant.
/// @dev Collapsed into memory structs because the comparison names more locals than the legacy code
/// generator has stack for, and `via_ir` stays false here as it does in production.
struct Figures {
    /// @dev Total Settlement logs the submission or submissions reported ingesting.
    uint256 ingestedLogs;
    /// @dev Open Tab for the Agent, Service, and Asset triple.
    uint128 open;
    /// @dev Prepaid credit held on the tab, from settlement in excess of the Open Tab.
    uint128 prepaid;
    /// @dev Aggregate Open Tab for the Agent across every Service in the Asset.
    uint256 assetOpen;
    /// @dev Rolling Verified Settlement history commitment.
    bytes32 historyRoot;
    /// @dev Number of records the commitment covers.
    uint32 historyCount;
    /// @dev Credit Limit, computed through the witness the commitment validates.
    uint256 creditLimit;
    /// @dev Stake the Service holds in the Asset.
    uint128 staked;
    /// @dev Stake currently covering Provisional Clearings.
    uint128 reserved;
    /// @dev Cumulative slashed stake.
    uint128 slashed;
    /// @dev Withdrawal-eligible stake.
    uint128 released;
    /// @dev Prepaid credit held for the Agent inside `Bond`, from slashed pledges.
    uint128 bondPrepaid;
    /// @dev Delinquent tabs suppressing the Agent's credit in the Asset.
    uint32 delinquentTabs;
}

/// @notice What the precompile stand-in observed while the shape under test ran.
struct Trace {
    /// @dev Attested-chain identifier of each verification call, in call order.
    uint64[] chainKeys;
    /// @dev Source Chain block height of each verification call, in call order.
    uint64[] heights;
    /// @dev Claimed transaction-trie root of each call.
    bytes32[] roots;
    /// @dev Continuity Proof endpoint digest of each call.
    bytes32[] endpoints;
    /// @dev Continuity Proof root count of each call.
    uint256[] rootCounts;
    /// @dev Digest of the encoded transaction each call carried.
    bytes32[] txDigests;
}

/// @notice Per-member state, so equality is asserted member for member rather than only in aggregate.
struct PerMember {
    /// @dev Whether the member's replay key is recorded as claimed.
    bool[] claimed;
    /// @dev Creditcoin block the member's log was ingested in.
    uint64[] ingestedAt;
    /// @dev Settled amount on the member's settlement record.
    uint128[] recordAmount;
    /// @dev Amount the Open Tab was reduced by on the member's record.
    uint128[] recordReduced;
    /// @dev Lifecycle position of the member's record.
    uint8[] recordState;
}

/// @notice The whole terminal position, aggregate and per member.
struct Terminal {
    /// @dev Aggregate figures.
    Figures figures;
    /// @dev What the precompile stand-in observed.
    Trace trace;
    /// @dev Per-member state, one entry per generated member.
    PerMember members;
}

/// @title BatchEquivalenceTest
/// @notice Property 12: batch settlement equals sequential settlement.
///
/// ## What the campaign establishes
///
/// For any generated set of 1 to 10 Settlements whose Source Chain block heights span at most 1000
/// blocks, the terminal position after one `submitSettlementBatch` call equals the terminal position
/// after `submitSettlement` on the same members, in the same order, one call at a time. Equal is
/// asserted member for member and figure for figure: the Open Tab and its prepaid credit, the
/// per-Asset aggregate, the rolling Verified Settlement commitment and its record count, the Credit
/// Limit computed through the witness that commitment validates, every field of the Service's Bond
/// ledger, the Agent's prepaid credit inside `Bond`, the delinquency count, and for each member its
/// replay-key claim, its ingestion block, and the amount, reduction, and lifecycle position of its
/// settlement record. The verification trace is compared too, so the two shapes are shown to have
/// proved the same things in the same order rather than merely to have arrived at the same figures.
///
/// The two shapes are run from one snapshot, so they start from a state that is identical rather than
/// merely constructed to look identical. That matters here more than usual: the replay ledger makes a
/// second submission of the same member an `AlreadyClaimed` revert, so the comparison is only
/// expressible if the first shape is genuinely undone before the second runs.
///
/// For any generated set above 10 members, and for any set of at least 2 members spanning more than
/// 1000 blocks, the batch is refused with its own distinct error and no verification call is made at
/// all. That last part is checked rather than read off the source: the precompile stand-in carries a
/// tripwire that makes any verification call revert, it is armed across the refusal, and the refusal's
/// revert data is asserted exactly — so one proof call would change the revert and fail the campaign.
/// Each refused set is then submitted member by member and lands, which is the Watcher's documented
/// recovery and the evidence that the revert consumed no replay key.
///
/// ## The generators, and why they reach past the bounds
///
/// `genSettlementSet` produces 1 to 14 members and `genBlockSpan` 0 to 1500 blocks. Both ceilings sit
/// above the contract's bounds on purpose: a generator that stopped at 10 and 1000 would exercise the
/// accepting half twice and the rejecting half never, and R9.3 and R9.4 would be assumed rather than
/// tested. {testFuzz_everyGeneratedSetLandsInExactlyOneOutcome} drives the whole range and dispatches
/// on the region, which is the property as stated; three further campaigns pin each region with the
/// full run count so neither half depends on the fuzzer's luck.
///
/// One consequence of the span bound's definition is worth stating rather than hiding. The span is
/// `highest - lowest`, so a single-member batch spans zero blocks whatever the generated span figure
/// says, and `BatchRangeExceeded` therefore needs at least two members to be reachable. The span
/// campaign generates 2 to 10 members for that reason.
///
/// ## Why every member carries its own Continuity Proof
///
/// Because `SourceTx` is the only place a proof can travel, so the shared-proof pairing is not
/// expressible in this ABI at all. That is the corrected shape from the task 1.4 spike: the precompile
/// reads a Continuity Proof's first root as the root of the height being proved, so ten sequential
/// calls sharing one proof verify the batch's lowest height and revert `"Merkle root mismatch"` from
/// the second call onward. The generator gives each member a distinct endpoint digest and a distinct
/// root, and the campaign asserts that the digests the precompile stand-in observed are those
/// distinct per-member digests in member order. A shared proof would show one digest repeated, so this
/// is a positive check rather than a restatement of the type.
///
/// R9.7 is checked two ways, both mechanical rather than by review.
/// {test_theAbiExposesNoProofBesideTheSettlementArray} pins the batch selector to the signature whose
/// only parameter is the settlement array, with the Continuity Proof inside each member's tuple, and
/// then calls for the forbidden overload — a settlement array plus one proof beside it — and shows the
/// dispatcher rejects the selector outright. And `BatchTraceProver` implements no array-shaped
/// overload, so if `SettlementVerifier` ever reached for the precompile's array-shaped
/// `verifyAndEmit` the call would land on an unknown selector and every campaign here would revert.
///
/// ## What the campaign does not establish
///
/// It does not establish anything about proof validity. The BlockProver Precompile does not exist
/// locally, so a stand-in decides whether a proof holds, and the campaign's claim is conditional on
/// that decision: given that these proofs verify, the two submission shapes agree. Whether a
/// Continuity Proof for a given height actually verifies against a Creditcoin attestation is the live
/// network's business, and the measurement that fixed this requirement's shape came from there.
///
/// It does not establish the gas comparison recorded in Requirement 9. That figure was measured on
/// the live network against the real precompile, and a local stand-in would report the cost of itself.
///
/// It does not establish that a batch cannot exceed the block gas limit. The bound of 10 is a
/// proof-availability and blast-radius bound rather than a gas bound, so there is no gas claim here to
/// check.
///
/// It says nothing about which Settlements the Watcher chooses to batch together. Proof availability
/// and attestation-window proximity decide that off chain, and R9.6 is the SDK's criterion, not this
/// contract's.
contract BatchEquivalenceTest is Test {
    /// @notice Registry of emitters, Collection Addresses, prices, and tiers.
    ServiceRegistry internal registry;

    /// @notice Registry that binds Source Chain payer addresses to Agents.
    AgentRegistry internal agents;

    /// @notice Bond the Service's stake sits in.
    Bond internal bond;

    /// @notice Book the verifier applies Verified Settlements to.
    TabBook internal book;

    /// @notice Contract under test.
    SettlementVerifier internal verifier;

    /// @notice The etched, trace-recording stand-in for the BlockProver Precompile.
    BatchTraceProver internal prover;

    /// @notice Amount the Agent settled to prove control of {PAYER}, which is history record one.
    uint128 internal bindingAmount;

    /// @notice ABI signature the batch entrypoint must have: one settlement array, nothing beside it.
    /// @dev The last component of the member tuple is `(bytes32,bytes32[])`, which is the Continuity
    /// Proof, sitting inside the member rather than beside the array. That placement is the whole of
    /// R9.7 written as a string, and comparing the selector against it is how the criterion is checked
    /// mechanically.
    string internal constant BATCH_SIGNATURE =
        "submitSettlementBatch((uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))[])";

    /// @notice ABI signature the single-settlement entrypoint must have.
    string internal constant SINGLE_SIGNATURE =
        "submitSettlement((uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[])))";

    // ------------------------------------------------------------------ setup

    /// @notice Deploys and wires the tree, funds the Bond by proven deposit, meters one delivery, and
    /// binds the payer every generated Settlement pays from.
    /// @dev No caller is impersonated anywhere in here. The Bond is funded the way a fresh deployment
    /// funds it — a bound funder pays a proven `Transfer` to a Bond Collection Address — because stake
    /// has to exist before a Credit Limit is non-zero, before a delivery can be metered, and therefore
    /// before there is an Open Tab for the generated Settlements to reduce. The only stand-in is the
    /// precompile, which does not exist locally.
    function setUp() public {
        vm.warp(START);

        BatchTraceProver implementation = new BatchTraceProver();
        vm.etch(PRECOMPILE, address(implementation).code);
        prover = BatchTraceProver(PRECOMPILE);

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
        _fundBondByProvenDeposit();
        _meterOneDelivery();
        bindingAmount = _bind(AGENT, PAYER, SETUP_HEIGHT + 2);

        _assertFixture();
    }

    /// @notice Register the Service, its accepted Asset, and the address its own Bond is funded at.
    function _registerService() private {
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

    /// @notice Create the Service's stake by proving a deposit to its Bond Collection Address.
    /// @dev Two proved submissions, in the order a real operator performs them: the funder's address
    /// is bound by paying the amount the registry issues, and then the deposit itself is proved. A
    /// deposit from an unbound address is refused, which is why the binding cannot be skipped.
    function _fundBondByProvenDeposit() private {
        _bind(OPERATOR, FUNDER, SETUP_HEIGHT);
        _submitTransfer(FUNDER, BOND_COLLECTION, BOND_STAKE, SETUP_HEIGHT + 1, 0);
    }

    /// @notice Authorise the Service and meter one delivery, so an Open Tab exists.
    function _meterOneDelivery() private {
        vm.prank(AGENT);
        book.authorise(SERVICE, USDC, type(uint128).max, START + 365 days);

        LimitLib.BondEntry[] memory bonds = new LimitLib.BondEntry[](1);
        bonds[0] = LimitLib.BondEntry({serviceId: SERVICE, asset: USDC, amount: 0});

        ITabBook.LimitWitness memory witness =
            ITabBook.LimitWitness({history: new LimitLib.SettlementRecord[](0), bonds: bonds});

        vm.prank(OPERATOR);
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, DELIVERY_UNITS, PRICE, witness);
    }

    /// @notice Pin the starting position, so no campaign below can pass on an inert fixture.
    /// @dev Four things have to hold before the property is even meaningful: stake exists, the payer
    /// is bound, exactly one history record precedes the generated members, and the Open Tab is
    /// large enough that a generated set can both reduce it and overshoot it.
    function _assertFixture() private view {
        assertEq(_ledger().staked, BOND_STAKE, "stake was created by proven deposit");
        assertEq(agents.agentOf(CHAIN_MAINNET, PAYER), AGENT, "the payer is bound by payment");

        (, uint32 count) = book.historyCommitment(AGENT, USDC);
        assertEq(count, 1, "the binding settlement is history record one");

        ITabBook.Tab memory tab = book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC));
        assertEq(tab.open, DELIVERY_CHARGE - bindingAmount, "the Open Tab is open");
        assertGt(tab.open, MAX_AMOUNT, "one member alone cannot settle the whole tab");
        assertLt(uint256(tab.open), BATCH_LIMIT * uint256(MAX_AMOUNT), "a full set can overshoot it");
    }

    // ------------------------------------------------------------------ generators

    /// @notice Generate a settlement set of 1 to 14 members spanning 0 to 1500 Source Chain blocks.
    /// @dev Both ranges reach past the contract's bounds deliberately; see the contract note.
    ///
    /// Heights are spread so that the lowest member sits at {BASE_HEIGHT} and the highest sits exactly
    /// `span` above it, which makes the generated span the span the contract measures rather than an
    /// approximation of it. Narrow spans therefore repeat heights, and that is not a defect: two
    /// Settlements in one Source Chain block is ordinary, and the replay key stays distinct because
    /// each member's Settlement log sits at its own ordinal inside its own receipt.
    ///
    /// Amounts are derived per member rather than shared, so an off-by-one in ingestion order would
    /// change the rolling history commitment and be caught rather than cancel out.
    /// @param countSeed Seed for the member count.
    /// @param spanSeed Seed for the block span, drawn by {genBlockSpan}.
    /// @param amountSeed Seed for the amounts.
    /// @param minCount Lowest member count to generate.
    /// @param maxCount Highest member count to generate.
    /// @param minSpan Narrowest span to generate.
    /// @param maxSpan Widest span to generate.
    /// @return members The generated set, in submission order.
    function genSettlementSet(
        uint256 countSeed,
        uint256 spanSeed,
        uint256 amountSeed,
        uint256 minCount,
        uint256 maxCount,
        uint256 minSpan,
        uint256 maxSpan
    ) internal pure returns (Member[] memory members) {
        // `_bound` rather than `bound`, which logs its result: at 256 runs times three draws the
        // logging is pure noise, and the mapping is the same.
        uint256 count = _bound(countSeed, minCount, maxCount);
        uint64 span = genBlockSpan(spanSeed, minSpan, maxSpan);

        members = new Member[](count);
        for (uint256 i = 0; i < count; ++i) {
            // casting to 'uint64' is safe because the offset is at most {MAX_SPAN} and the ordinal at
            // most {MAX_MEMBERS}, both of which are three-digit figures.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 offset = count == 1 ? 0 : uint64((uint256(span) * i) / (count - 1));
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 logIndex = uint64(i);

            members[i] = Member({
                height: BASE_HEIGHT + offset,
                logIndex: logIndex,
                amount: genAmount(amountSeed, i),
                endpoint: keccak256(abi.encode("continuity-endpoint", amountSeed, i)),
                root: keccak256(abi.encode("transaction-trie-root", amountSeed, i))
            });
        }
    }

    /// @notice Generate the Source Chain block span a settlement set covers, in blocks.
    /// @dev Drawn over 0 to {MAX_SPAN} by the campaign that dispatches on the outcome, and over
    /// {SPAN_LIMIT} + 1 to {MAX_SPAN} by the campaign that pins the rejecting region. Reaching past
    /// {SPAN_LIMIT} is the whole reason the ceiling is 1500 rather than 1000: R9.4's window is a
    /// bound to be crossed, not a range to stay inside.
    /// @param seed Seed to map.
    /// @param minSpan Narrowest span to generate.
    /// @param maxSpan Widest span to generate.
    /// @return span The span, in Source Chain blocks.
    function genBlockSpan(uint256 seed, uint256 minSpan, uint256 maxSpan)
        internal
        pure
        returns (uint64 span)
    {
        // casting to 'uint64' is safe because {MAX_SPAN} is a four-digit figure and every caller
        // bounds `maxSpan` at or below it.
        // forge-lint: disable-next-line(unsafe-typecast)
        span = uint64(_bound(seed, minSpan, maxSpan));
    }

    /// @notice One member's settled amount, in Asset base units.
    /// @dev At least one base unit, so every member is a real Settlement, and at most {MAX_AMOUNT}, so
    /// a full set overshoots the Open Tab and the prepaid-credit branch is reached.
    /// @param amountSeed Seed for the set.
    /// @param index Position of the member within the set.
    /// @return amount The amount.
    function genAmount(uint256 amountSeed, uint256 index) internal pure returns (uint128 amount) {
        uint256 drawn = uint256(keccak256(abi.encode("amount", amountSeed, index)));
        // casting to 'uint128' is safe because the modulus is {MAX_AMOUNT}, a six-digit figure.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(1 + (drawn % MAX_AMOUNT));
    }

    // ------------------------------------------------------------------ submission material

    /// @notice Turn a generated set into submission material, one `SourceTx` per member.
    /// @dev The Continuity Proof travels inside each member's own struct, because that is the only
    /// place this ABI has for it. Its single root is the member's own transaction-trie root, which
    /// mirrors what the live precompile does with a Continuity Proof's first root: it reads it as the
    /// root of the height under proof, which is exactly why one proof cannot serve a batch.
    /// @param members The generated set.
    /// @return sourceTxs The submission material, in member order.
    function _sourceTxs(Member[] memory members)
        internal
        pure
        returns (TabAscBase.SourceTx[] memory sourceTxs)
    {
        sourceTxs = new TabAscBase.SourceTx[](members.length);
        for (uint256 i = 0; i < members.length; ++i) {
            bytes32[] memory continuityRoots = new bytes32[](1);
            continuityRoots[0] = members[i].root;

            sourceTxs[i] = TabAscBase.SourceTx({
                chainKey: CHAIN_MAINNET,
                blockHeight: members[i].height,
                encodedTransaction: SourceTxFixture.encode(PAYER, _entries(members[i])),
                merkleProof: INativeQueryVerifier.MerkleProof({
                    root: members[i].root, siblings: new INativeQueryVerifier.MerkleProofEntry[](0)
                }),
                continuityProof: INativeQueryVerifier.ContinuityProof({
                    lowerEndpointDigest: members[i].endpoint, roots: continuityRoots
                })
            });
        }
    }

    /// @notice Receipt logs of one member: its Settlement log at its own ordinal, padded before it.
    /// @dev The padding is what keeps replay keys distinct when two members share a height, since the
    /// transaction index is fixed and the ordinal is the only remaining field. Zero-topic logs are the
    /// right padding because they carry no event signature at all, so they are skipped before
    /// recognition runs and cannot be mistaken for a second Settlement.
    /// @param member The member.
    /// @return entries The receipt logs, in receipt order.
    function _entries(Member memory member)
        internal
        pure
        returns (EvmV1Decoder.LogEntryTuple[] memory entries)
    {
        entries = new EvmV1Decoder.LogEntryTuple[](uint256(member.logIndex) + 1);
        for (uint256 j = 0; j < uint256(member.logIndex); ++j) {
            entries[j] = SourceTxFixture.zeroTopicLog(PAD_EMITTER);
        }
        entries[uint256(member.logIndex)] =
            SourceTxFixture.transferLog(USDC, PAYER, TAB_COLLECTION, member.amount);
    }

    /// @notice Replay key of one member, as the contract packs it.
    /// @param member The member.
    /// @return key The packed key.
    function _replayKey(Member memory member) internal view returns (bytes32 key) {
        return verifier.replayKey(CHAIN_MAINNET, member.height, 0, member.logIndex);
    }

    // ------------------------------------------------------------------ fixture submissions

    /// @notice Bind a Source Chain address to a Creditcoin identity by paying the amount issued.
    /// @dev The honest path and the only one there is: the registry hands out an exact amount, and a
    /// Verified Settlement of that amount from that address proves control of it.
    /// @param identity Creditcoin address requesting the binding.
    /// @param ethAddress Source Chain address to bind.
    /// @param height Source Chain block height to prove the payment at.
    /// @return amount The amount that was settled.
    function _bind(address identity, address ethAddress, uint64 height) private returns (uint128 amount) {
        vm.prank(identity);
        (, uint256 required,) = agents.requestBinding(CHAIN_MAINNET, ethAddress);

        // casting to 'uint128' is safe because the required amount encodes a `uint16` nonce in the low
        // digits of a figure the registry bounds far below 2^128.
        // forge-lint: disable-next-line(unsafe-typecast)
        amount = uint128(required);
        _submitTransfer(ethAddress, TAB_COLLECTION, amount, height, 0);
    }

    /// @notice Prove one ERC-20 `Transfer` outside the generated sets, for fixture purposes.
    /// @param payer Sender, which lands in `topics[1]` and is the payer.
    /// @param recipient Recipient, which lands in `topics[2]`.
    /// @param amount Transferred amount.
    /// @param height Source Chain block height to prove it at.
    /// @param logIndex Ordinal the Settlement log sits at in its receipt.
    function _submitTransfer(address payer, address recipient, uint128 amount, uint64 height, uint64 logIndex)
        private
    {
        bytes32 root = keccak256(abi.encode("fixture-root", height, logIndex));
        bytes32[] memory continuityRoots = new bytes32[](1);
        continuityRoots[0] = root;

        EvmV1Decoder.LogEntryTuple[] memory entries = new EvmV1Decoder.LogEntryTuple[](uint256(logIndex) + 1);
        for (uint256 j = 0; j < uint256(logIndex); ++j) {
            entries[j] = SourceTxFixture.zeroTopicLog(PAD_EMITTER);
        }
        entries[uint256(logIndex)] = SourceTxFixture.transferLog(USDC, payer, recipient, amount);

        verifier.submitSettlement(
            TabAscBase.SourceTx({
                chainKey: CHAIN_MAINNET,
                blockHeight: height,
                encodedTransaction: SourceTxFixture.encode(payer, entries),
                merkleProof: INativeQueryVerifier.MerkleProof({
                    root: root, siblings: new INativeQueryVerifier.MerkleProofEntry[](0)
                }),
                continuityProof: INativeQueryVerifier.ContinuityProof({
                    lowerEndpointDigest: keccak256(abi.encode("fixture-endpoint", height, logIndex)),
                    roots: continuityRoots
                })
            })
        );
    }

    // ------------------------------------------------------------------ terminal position

    /// @notice Read the whole terminal position: aggregate figures, verification trace, per-member state.
    /// @param members The generated set, whose replay keys are read whether or not they landed.
    /// @param landed How many members reached the book, which is what the witness has to cover.
    /// @param ingestedLogs Total the submission or submissions reported.
    /// @param base Verification call count before the shape under test ran.
    /// @return terminal The position.
    function _terminal(Member[] memory members, uint256 landed, uint256 ingestedLogs, uint256 base)
        internal
        view
        returns (Terminal memory terminal)
    {
        terminal = Terminal({
            figures: _figures(members, landed, ingestedLogs),
            trace: _trace(base),
            members: _perMember(members)
        });
    }

    /// @notice Every aggregate figure the property is stated over.
    /// @dev The Credit Limit is read through a witness reconstructed from the amounts that landed, so
    /// this call is self-checking: `TabBook` folds the witness into the same rolling hash the
    /// settlement path wrote and reverts `HistoryCommitmentMismatch` on any disagreement. A
    /// reconstruction that had the order, the count, or any committed field wrong would therefore fail
    /// here rather than quietly compare two zeroes.
    /// @param members The generated set.
    /// @param landed How many members reached the book.
    /// @param ingestedLogs Total the submission or submissions reported.
    /// @return figures The figures.
    function _figures(Member[] memory members, uint256 landed, uint256 ingestedLogs)
        internal
        view
        returns (Figures memory figures)
    {
        ITabBook.Tab memory tab = book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC));
        (bytes32 root, uint32 count) = book.historyCommitment(AGENT, USDC);
        IBond.Ledger memory ledger = _ledger();

        figures = Figures({
            ingestedLogs: ingestedLogs,
            open: tab.open,
            prepaid: tab.prepaid,
            assetOpen: book.assetOpen(AGENT, USDC),
            historyRoot: root,
            historyCount: count,
            creditLimit: book.creditLimit(AGENT, USDC, _witness(members, landed)),
            staked: ledger.staked,
            reserved: ledger.reserved,
            slashed: ledger.slashed,
            released: ledger.released,
            bondPrepaid: bond.prepaidCreditOf(AGENT, USDC),
            delinquentTabs: book.delinquentTabCount(AGENT, USDC)
        });
    }

    /// @notice The Service's Bond ledger in the Asset.
    /// @return ledger The four stored figures.
    function _ledger() internal view returns (IBond.Ledger memory ledger) {
        return bond.ledgerOf(bond.partyOf(registry.serviceOf(SERVICE).bondAccount), USDC);
    }

    /// @notice What the precompile stand-in observed after call `base`.
    /// @param base Call count before the shape under test ran.
    /// @return trace The observations, in call order.
    function _trace(uint256 base) internal view returns (Trace memory trace) {
        uint64[] memory allChainKeys = prover.chainKeys();
        uint64[] memory allHeights = prover.heights();
        bytes32[] memory allRoots = prover.roots();
        bytes32[] memory allEndpoints = prover.endpoints();
        uint256[] memory allRootCounts = prover.rootCounts();
        bytes32[] memory allTxDigests = prover.txDigests();

        uint256 n = allHeights.length - base;
        trace = Trace({
            chainKeys: new uint64[](n),
            heights: new uint64[](n),
            roots: new bytes32[](n),
            endpoints: new bytes32[](n),
            rootCounts: new uint256[](n),
            txDigests: new bytes32[](n)
        });

        for (uint256 i = 0; i < n; ++i) {
            trace.chainKeys[i] = allChainKeys[base + i];
            trace.heights[i] = allHeights[base + i];
            trace.roots[i] = allRoots[base + i];
            trace.endpoints[i] = allEndpoints[base + i];
            trace.rootCounts[i] = allRootCounts[base + i];
            trace.txDigests[i] = allTxDigests[base + i];
        }
    }

    /// @notice Per-member state, read under each member's own replay key.
    /// @param members The generated set.
    /// @return perMember One entry per member, in member order.
    function _perMember(Member[] memory members) internal view returns (PerMember memory perMember) {
        uint256 n = members.length;
        perMember = PerMember({
            claimed: new bool[](n),
            ingestedAt: new uint64[](n),
            recordAmount: new uint128[](n),
            recordReduced: new uint128[](n),
            recordState: new uint8[](n)
        });

        for (uint256 i = 0; i < n; ++i) {
            bytes32 key = _replayKey(members[i]);
            ITabBook.Clearing memory record = book.clearingOf(key);

            perMember.claimed[i] = verifier.claimedLog(key);
            perMember.ingestedAt[i] = verifier.ingestedAt(key);
            perMember.recordAmount[i] = record.amount;
            perMember.recordReduced[i] = record.reduced;
            perMember.recordState[i] = uint8(record.state);
        }
    }

    /// @notice The witness the Credit Limit is computed through, for a set of which `landed` landed.
    /// @dev Every field is reconstructed rather than read back, because reading it back from the same
    /// storage the assertion is about would make the check circular. The reconstruction is exact and
    /// the fields are constants of this fixture: one Service, one Asset, the Permissionless Tier that
    /// registration assigns, stake that exists before the first Settlement, a clock that never
    /// advances, and a first delivery that precedes every Settlement in scope.
    /// @param members The generated set.
    /// @param landed How many of its members reached the book.
    /// @return witness The binding record followed by the landed members, in order.
    function _witness(Member[] memory members, uint256 landed)
        internal
        view
        returns (ITabBook.LimitWitness memory witness)
    {
        LimitLib.SettlementRecord[] memory history = new LimitLib.SettlementRecord[](landed + 1);
        history[0] = _record(bindingAmount);
        for (uint256 i = 0; i < landed; ++i) {
            history[i + 1] = _record(members[i].amount);
        }

        LimitLib.BondEntry[] memory bonds = new LimitLib.BondEntry[](1);
        bonds[0] = LimitLib.BondEntry({serviceId: SERVICE, asset: USDC, amount: 0});

        witness = ITabBook.LimitWitness({history: history, bonds: bonds});
    }

    /// @notice One committed history record, as the book authors it for this fixture.
    /// @param amount Settled amount in Asset base units.
    /// @return record The record.
    function _record(uint128 amount) internal pure returns (LimitLib.SettlementRecord memory record) {
        record = LimitLib.SettlementRecord({
            serviceId: SERVICE,
            asset: USDC,
            amount: amount,
            settledAt: START,
            firstDeliveryAt: START,
            chainKey: CHAIN_MAINNET,
            curated: false,
            bonded: true
        });
    }

    // ------------------------------------------------------------------ comparison

    /// @notice Assert two terminal positions are equal, figure for figure and member for member.
    /// @param batched Position after the batch submission.
    /// @param sequential Position after the same members submitted one at a time.
    function _assertSameTerminal(Terminal memory batched, Terminal memory sequential) internal pure {
        _assertSameFigures(batched.figures, sequential.figures);
        _assertSameTrace(batched.trace, sequential.trace);
        _assertSamePerMember(batched.members, sequential.members);
    }

    /// @notice Assert the aggregate figures agree.
    /// @param batched Figures after the batch submission.
    /// @param sequential Figures after the sequential submissions.
    function _assertSameFigures(Figures memory batched, Figures memory sequential) internal pure {
        assertEq(batched.ingestedLogs, sequential.ingestedLogs, "ingested log count");
        assertEq(batched.open, sequential.open, "Open Tab");
        assertEq(batched.prepaid, sequential.prepaid, "prepaid credit on the tab");
        assertEq(batched.assetOpen, sequential.assetOpen, "aggregate Open Tab for the Asset");
        assertEq(batched.historyRoot, sequential.historyRoot, "Verified Settlement commitment");
        assertEq(batched.historyCount, sequential.historyCount, "committed record count");
        assertEq(batched.creditLimit, sequential.creditLimit, "Credit Limit");
        assertEq(batched.staked, sequential.staked, "Bond staked");
        assertEq(batched.reserved, sequential.reserved, "Bond reserved");
        assertEq(batched.slashed, sequential.slashed, "Bond slashed");
        assertEq(batched.released, sequential.released, "Bond released");
        assertEq(batched.bondPrepaid, sequential.bondPrepaid, "prepaid credit inside Bond");
        assertEq(batched.delinquentTabs, sequential.delinquentTabs, "delinquent tab count");
    }

    /// @notice Assert the two shapes proved the same material in the same order.
    /// @param batched Trace of the batch submission.
    /// @param sequential Trace of the sequential submissions.
    function _assertSameTrace(Trace memory batched, Trace memory sequential) internal pure {
        assertEq(batched.heights.length, sequential.heights.length, "verification call count");

        for (uint256 i = 0; i < batched.heights.length; ++i) {
            assertEq(batched.chainKeys[i], sequential.chainKeys[i], "proved chainKey");
            assertEq(batched.heights[i], sequential.heights[i], "proved height");
            assertEq(batched.roots[i], sequential.roots[i], "proved transaction-trie root");
            assertEq(batched.endpoints[i], sequential.endpoints[i], "Continuity Proof endpoint");
            assertEq(batched.rootCounts[i], sequential.rootCounts[i], "Continuity Proof root count");
            assertEq(batched.txDigests[i], sequential.txDigests[i], "proved transaction");
        }
    }

    /// @notice Assert the per-member state agrees under every member's own replay key.
    /// @param batched Per-member state after the batch submission.
    /// @param sequential Per-member state after the sequential submissions.
    function _assertSamePerMember(PerMember memory batched, PerMember memory sequential) internal pure {
        assertEq(batched.claimed.length, sequential.claimed.length, "member count");

        for (uint256 i = 0; i < batched.claimed.length; ++i) {
            assertEq(batched.claimed[i], sequential.claimed[i], "replay key claimed");
            assertEq(batched.ingestedAt[i], sequential.ingestedAt[i], "ingestion block");
            assertEq(batched.recordAmount[i], sequential.recordAmount[i], "settled amount on record");
            assertEq(batched.recordReduced[i], sequential.recordReduced[i], "reduction on record");
            assertEq(uint256(batched.recordState[i]), uint256(sequential.recordState[i]), "record state");
        }
    }

    // ------------------------------------------------------------------ drivers

    /// @notice Drive one generated set through both submission shapes and assert they agree.
    /// @dev The snapshot is what makes the comparison expressible at all. Submitting the same members
    /// twice in one state would revert `AlreadyClaimed` on the second shape, because the replay ledger
    /// is exactly what a Settlement consumes, so the first shape has to be genuinely undone rather
    /// than compensated for.
    ///
    /// Beyond equality, the accepting half also pins three things about the batch itself: one
    /// verification call per Merkle Proof, in member order, and each call carrying that member's own
    /// Continuity Proof and that member's own transaction. Those are R9.1 and R9.2, and they are the
    /// behavioural half of R9.7 — a batch served by the precompile's array-shaped overload would show
    /// one call, or none, rather than one per member.
    /// @param members The generated set.
    function _assertShapesAgree(Member[] memory members) internal {
        TabAscBase.SourceTx[] memory sourceTxs = _sourceTxs(members);
        uint256 base = prover.callCount();
        uint256 snapshot = vm.snapshotState();

        uint256 batchedLogs = verifier.submitSettlementBatch(sourceTxs);
        Terminal memory batched = _terminal(members, members.length, batchedLogs, base);

        assertTrue(vm.revertToState(snapshot), "the snapshot was restored");
        assertEq(prover.callCount(), base, "restoring the snapshot restored the verification trace");

        uint256 sequentialLogs;
        for (uint256 i = 0; i < sourceTxs.length; ++i) {
            sequentialLogs += verifier.submitSettlement(sourceTxs[i]);
        }
        Terminal memory sequential = _terminal(members, members.length, sequentialLogs, base);

        _assertSameTerminal(batched, sequential);
        _assertProvedMemberByMember(members, batched.trace);
        _assertProvedMemberByMember(members, sequential.trace);

        assertEq(batched.figures.ingestedLogs, members.length, "one Settlement log per member");
    }

    /// @notice Assert the trace is one call per member, in order, each with that member's own proof.
    /// @param members The generated set.
    /// @param trace What the precompile stand-in observed.
    function _assertProvedMemberByMember(Member[] memory members, Trace memory trace) internal pure {
        assertEq(trace.heights.length, members.length, "one verifyAndEmit call per Merkle Proof");

        for (uint256 i = 0; i < members.length; ++i) {
            assertEq(trace.chainKeys[i], CHAIN_MAINNET, "the proved chainKey");
            assertEq(trace.heights[i], members[i].height, "call order follows member order");
            assertEq(trace.roots[i], members[i].root, "each call carries its member's Merkle Proof");
            assertEq(trace.endpoints[i], members[i].endpoint, "each call carries its own Continuity Proof");
            assertEq(trace.rootCounts[i], 1, "one root, which is the root of the height under proof");
        }
    }

    /// @notice Assert an out-of-bounds batch is refused before any proof call and stays recoverable.
    /// @dev Three claims, and they are not of equal strength, so it is worth saying which is which.
    ///
    /// The revert data is asserted exactly, which is R9.3 and R9.4's distinct errors and their
    /// operands. The tripwire is armed across it, so a submission that reached the precompile even
    /// once would carry the tripwire's reason instead and fail here: that is what establishes both
    /// bounds are checked before the first proof, rather than leaving it to be read off the source.
    ///
    /// The terminal comparison across the reverted call is the weakest of the three and is kept for
    /// what it would catch rather than for what it proves. A revert unwinds every write, so equality
    /// holds by EVM semantics once the call reverts at all; it would only bite if a future change
    /// swallowed the failure and returned normally, which `vm.expectRevert` already forbids.
    ///
    /// The recovery is the one that matters operationally. R9.5 makes a batch all-or-nothing and the
    /// Watcher's documented recovery is to resubmit the members individually, which is only a recovery
    /// if the refused batch consumed no replay key. So the same members are submitted one at a time
    /// afterwards, with the tripwire disarmed, and every one of them lands.
    /// @param members The generated set.
    /// @param expectedRevert The revert data the batch must produce.
    function _assertBatchRejectedWholesale(Member[] memory members, bytes memory expectedRevert) internal {
        TabAscBase.SourceTx[] memory sourceTxs = _sourceTxs(members);
        uint256 base = prover.callCount();
        Terminal memory before = _terminal(members, 0, 0, base);

        prover.setTripwire(true);
        vm.expectRevert(expectedRevert);
        verifier.submitSettlementBatch(sourceTxs);

        // The tripwire is the instrument, so it is checked in the same state it was just relied on: a
        // lone in-bounds submission does reach the precompile, and while armed it comes back with the
        // tripwire's reason. Without this the absence of a proof call above would rest on the tripwire
        // working, which is exactly the kind of thing that quietly stops being true.
        vm.expectRevert(abi.encodeWithSignature("Error(string)", TRIPWIRE));
        verifier.submitSettlement(sourceTxs[0]);
        prover.setTripwire(false);

        Terminal memory post = _terminal(members, 0, 0, base);
        _assertSameTerminal(before, post);

        uint256 recovered;
        for (uint256 i = 0; i < sourceTxs.length; ++i) {
            recovered += verifier.submitSettlement(sourceTxs[i]);
        }
        assertEq(recovered, members.length, "every member stayed claimable after the wholesale revert");
    }

    // ------------------------------------------------------------------ the property

    /// @notice For any set of 1 to 14 members spanning 0 to 1500 blocks, exactly one outcome holds.
    /// @dev Property 12 as stated, over the whole generated range: above 10 members the batch is
    /// rejected as too large, above a 1000-block span it is rejected as too wide, and otherwise the two
    /// submission shapes reach the same terminal position. The size bound is checked before the span
    /// bound, so an oversized batch reports its size whatever its span.
    /// @param countSeed Seed for the member count.
    /// @param spanSeed Seed for the block span.
    /// @param amountSeed Seed for the amounts.
    function testFuzz_everyGeneratedSetLandsInExactlyOneOutcome(
        uint256 countSeed,
        uint256 spanSeed,
        uint256 amountSeed
    ) public {
        Member[] memory members =
            genSettlementSet(countSeed, spanSeed, amountSeed, 1, MAX_MEMBERS, 0, MAX_SPAN);

        uint64 lowest = members[0].height;
        uint64 highest = members[members.length - 1].height;

        if (members.length > BATCH_LIMIT) {
            _assertBatchRejectedWholesale(
                members,
                abi.encodeWithSelector(TabAscBase.BatchTooLarge.selector, members.length, BATCH_LIMIT)
            );
        } else if (highest - lowest > SPAN_LIMIT) {
            _assertBatchRejectedWholesale(
                members,
                abi.encodeWithSelector(TabAscBase.BatchRangeExceeded.selector, lowest, highest, SPAN_LIMIT)
            );
        } else {
            _assertShapesAgree(members);
        }
    }

    /// @notice Inside the bounds, the two submission shapes agree on every figure and every member.
    /// @dev The accepting region with the full run count, so the equality claim does not depend on how
    /// often the dispatcher above happens to land in it. (R9.1, R9.2)
    /// @param countSeed Seed for the member count, 1 to 10.
    /// @param spanSeed Seed for the block span, 0 to 1000.
    /// @param amountSeed Seed for the amounts.
    function testFuzz_theTwoShapesReachTheSameTerminalPosition(
        uint256 countSeed,
        uint256 spanSeed,
        uint256 amountSeed
    ) public {
        Member[] memory members =
            genSettlementSet(countSeed, spanSeed, amountSeed, 1, BATCH_LIMIT, 0, SPAN_LIMIT);
        _assertShapesAgree(members);
    }

    /// @notice A batch of 11 to 14 members is rejected whole, before any proof call. (R9.3)
    /// @param countSeed Seed for the member count, 11 to 14.
    /// @param spanSeed Seed for the block span.
    /// @param amountSeed Seed for the amounts.
    function testFuzz_aBatchAboveTenMembersIsRejectedWholesale(
        uint256 countSeed,
        uint256 spanSeed,
        uint256 amountSeed
    ) public {
        Member[] memory members = genSettlementSet(
            countSeed, spanSeed, amountSeed, BATCH_LIMIT + 1, MAX_MEMBERS, 0, MAX_SPAN
        );

        assertGt(members.length, BATCH_LIMIT, "the generated set reaches past the batch bound");
        _assertBatchRejectedWholesale(
            members, abi.encodeWithSelector(TabAscBase.BatchTooLarge.selector, members.length, BATCH_LIMIT)
        );
    }

    /// @notice A batch spanning more than 1000 blocks is rejected whole, before any proof call. (R9.4)
    /// @dev At least two members, because the span the contract measures is `highest - lowest` and a
    /// single-member batch spans zero blocks however wide the generated figure is.
    /// @param countSeed Seed for the member count, 2 to 10.
    /// @param spanSeed Seed for the block span, 1001 to 1500.
    /// @param amountSeed Seed for the amounts.
    function testFuzz_aSpanAboveOneThousandBlocksIsRejectedWholesale(
        uint256 countSeed,
        uint256 spanSeed,
        uint256 amountSeed
    ) public {
        Member[] memory members = genSettlementSet(
            countSeed, spanSeed, amountSeed, 2, BATCH_LIMIT, SPAN_LIMIT + 1, MAX_SPAN
        );

        uint64 lowest = members[0].height;
        uint64 highest = members[members.length - 1].height;
        assertGt(highest - lowest, SPAN_LIMIT, "the generated span reaches past the span bound");

        _assertBatchRejectedWholesale(
            members,
            abi.encodeWithSelector(TabAscBase.BatchRangeExceeded.selector, lowest, highest, SPAN_LIMIT)
        );
    }

    /// @notice One rejected proof reverts the whole batch and names the member it belongs to. (R9.5)
    /// @dev The named member is never the first, so the error is attributing a failure rather than
    /// reporting the head of the array. Naming the failing Settlement is the entire reason Requirement
    /// 9 chose sequential single-proof verification over the cheaper array-shaped overload, and it is
    /// what makes the all-or-nothing revert recoverable: the Watcher resubmits the members
    /// individually, which the driver then does.
    /// @param countSeed Seed for the member count, 2 to 10.
    /// @param spanSeed Seed for the block span, 0 to 1000.
    /// @param amountSeed Seed for the amounts.
    /// @param targetSeed Seed selecting which member's proof is rejected.
    function testFuzz_aRejectedMemberRevertsTheWholeBatchAndNamesIt(
        uint256 countSeed,
        uint256 spanSeed,
        uint256 amountSeed,
        uint256 targetSeed
    ) public {
        Member[] memory members =
            genSettlementSet(countSeed, spanSeed, amountSeed, 2, BATCH_LIMIT, 0, SPAN_LIMIT);

        uint256 target = _bound(targetSeed, 1, members.length - 1);
        prover.setRejectRoot(members[target].root);

        // The error's operands have to single the member out, so the figures it reports must not be
        // the head's. The root is what discriminates: heights repeat freely when the generated span is
        // narrower than the member count, and a per-member root is the field that never collides.
        assertTrue(members[target].root != members[0].root, "the named root belongs to one member only");

        _assertBatchRejectedWholesaleThenRecovered(members, target);
    }

    /// @notice The rejected-proof case, split out so the campaign above stays inside the stack.
    /// @param members The generated set.
    /// @param target Index of the member whose proof is rejected.
    function _assertBatchRejectedWholesaleThenRecovered(Member[] memory members, uint256 target) private {
        TabAscBase.SourceTx[] memory sourceTxs = _sourceTxs(members);
        uint256 base = prover.callCount();
        Terminal memory before = _terminal(members, 0, 0, base);

        vm.expectRevert(
            abi.encodeWithSelector(
                TabAscBase.ProofRejected.selector, CHAIN_MAINNET, members[target].height, members[target].root
            )
        );
        verifier.submitSettlementBatch(sourceTxs);

        Terminal memory post = _terminal(members, 0, 0, base);
        _assertSameTerminal(before, post);

        prover.setRejectRoot(bytes32(0));

        uint256 recovered;
        for (uint256 i = 0; i < sourceTxs.length; ++i) {
            recovered += verifier.submitSettlement(sourceTxs[i]);
        }
        assertEq(recovered, members.length, "every member stayed claimable after the wholesale revert");
    }

    /// @notice The batch ABI takes a settlement array and nothing beside it. (R9.7)
    /// @dev The mechanical check of R9.7, in three parts.
    ///
    /// First, the selector of the only batch entrypoint is pinned to the signature whose sole parameter
    /// is the settlement array, with the Continuity Proof as the last component of each member's own
    /// tuple. The single-settlement entrypoint is pinned the same way. A future change that lifted a
    /// proof out of the member and set it beside the array would move both selectors and fail here.
    ///
    /// Second, the forbidden overload is called for: a settlement array carrying only Merkle Proofs,
    /// plus one Continuity Proof beside it. `SettlementVerifier` has no such function and no fallback,
    /// so the dispatcher rejects the selector and returns no data at all — which is what distinguishes
    /// an absent function from a present one that refused its arguments.
    ///
    /// Third, and asserted by every other campaign in this file rather than here: the etched
    /// precompile stand-in implements no array-shaped `verifyAndEmit`, so a contract that reached for
    /// the precompile's own batch overload would hit an unknown selector and every submission would
    /// revert. R9.7 forbids that call because a batch-wide boolean cannot name the failing Settlement,
    /// and the traces above show N single-proof calls instead, one per member.
    function test_theAbiExposesNoProofBesideTheSettlementArray() public {
        assertEq(
            verifier.submitSettlementBatch.selector,
            bytes4(keccak256(bytes(BATCH_SIGNATURE))),
            "the batch entrypoint takes the settlement array and nothing else"
        );
        assertEq(
            verifier.submitSettlement.selector,
            bytes4(keccak256(bytes(SINGLE_SIGNATURE))),
            "the single entrypoint takes one settlement and nothing else"
        );

        bytes4 forbidden = ISharedProofBatch.submitSettlementBatch.selector;
        assertTrue(forbidden != verifier.submitSettlementBatch.selector, "the shapes are distinct");
        assertTrue(forbidden != verifier.submitSettlement.selector, "the shapes are distinct");

        (bool answered, bytes memory returned) = address(verifier).call(_sharedProofCalldata());
        assertFalse(answered, "no shared-proof batch overload answers");
        assertEq(returned.length, 0, "the selector is unknown, so the dispatcher returns no data");
    }

    /// @notice Well-formed calldata for the forbidden shared-proof overload.
    /// @dev Well-formed on purpose. Malformed arguments would revert with no data too, so encoding
    /// them properly is what makes the empty rejection above mean the function is absent rather than
    /// merely unhappy.
    /// @return data The encoded call.
    function _sharedProofCalldata() private pure returns (bytes memory data) {
        ISharedProofBatch.SourceTxWithoutProof[] memory shaped =
            new ISharedProofBatch.SourceTxWithoutProof[](1);
        shaped[0] = ISharedProofBatch.SourceTxWithoutProof({
            chainKey: CHAIN_MAINNET,
            blockHeight: BASE_HEIGHT,
            encodedTransaction: hex"",
            merkleProof: INativeQueryVerifier.MerkleProof({
                root: keccak256("forbidden-root"), siblings: new INativeQueryVerifier.MerkleProofEntry[](0)
            })
        });

        bytes32[] memory sharedRoots = new bytes32[](1);
        sharedRoots[0] = keccak256("forbidden-root");

        data = abi.encodeCall(
            ISharedProofBatch.submitSettlementBatch,
            (
                shaped,
                INativeQueryVerifier.ContinuityProof({
                    lowerEndpointDigest: keccak256("forbidden-endpoint"), roots: sharedRoots
                })
            )
        );
    }

    // ------------------------------------------------------- the accepting edge

    /*
     * The two batch bounds, pinned at the value that is still legal.
     *
     * Everything above already establishes that 11 members and 1001 blocks are
     * refused. That is only half a boundary: a contract that rejected 10 as well
     * would pass every one of those tests and would be wrong. The fuzz campaign
     * draws from 1 to 10 and 0 to 1000 and so reaches both limits eventually,
     * which is not the same as asserting them - a run that never drew the top of
     * the range would be green on a build that had moved it.
     *
     * These two are deterministic and land exactly on the limit.
     */

    /// @notice A batch of exactly 10 members is accepted, which is the bound's legal edge. (R9.3)
    function test_aBatchOfExactlyTenMembersIsAccepted() public {
        Member[] memory members = genSettlementSet(0, 0, 0, BATCH_LIMIT, BATCH_LIMIT, 0, 0);
        assertEq(members.length, BATCH_LIMIT, "the generated set sits on the batch bound");
        _assertShapesAgree(members);
    }

    /// @notice A batch spanning exactly 1000 blocks is accepted, which is the span bound's legal edge. (R9.4)
    /// @dev Two members, because the span the contract measures is `highest - lowest` and one member
    /// spans zero blocks whatever figure the generator was given.
    function test_aSpanOfExactlyOneThousandBlocksIsAccepted() public {
        Member[] memory members = genSettlementSet(0, 0, 0, 2, 2, SPAN_LIMIT, SPAN_LIMIT);
        assertEq(members.length, 2, "two members, so the span is measurable");
        assertEq(
            uint256(members[members.length - 1].height) - uint256(members[0].height),
            uint256(SPAN_LIMIT),
            "the generated set sits on the span bound"
        );
        _assertShapesAgree(members);
    }

    /*
     * One past each bound, deterministically.
     *
     * The fuzz campaigns above draw a range past each limit; these land exactly
     * one member and exactly one block past it, which is what makes the pair with
     * the two acceptances above a boundary rather than a slope.
     *
     * Separate tests rather than one, because each rejection leaves the harness
     * with the history it built for its own set, and a second set in the same
     * test is measured against the first one's witness.
     */

    /// @notice Exactly one member past the batch bound is refused. (R9.3)
    function test_oneMemberPastTheBatchBoundIsRefused() public {
        Member[] memory members = genSettlementSet(0, 0, 0, BATCH_LIMIT + 1, BATCH_LIMIT + 1, 0, 0);
        assertEq(members.length, BATCH_LIMIT + 1, "one past the batch bound");
        _assertBatchRejectedWholesale(
            members, abi.encodeWithSelector(TabAscBase.BatchTooLarge.selector, members.length, BATCH_LIMIT)
        );
    }

    /// @notice Exactly one block past the span bound is refused. (R9.4)
    function test_oneBlockPastTheSpanBoundIsRefused() public {
        Member[] memory members =
            genSettlementSet(0, 0, 0, 2, 2, uint256(SPAN_LIMIT) + 1, uint256(SPAN_LIMIT) + 1);
        assertEq(
            uint256(members[members.length - 1].height) - uint256(members[0].height),
            uint256(SPAN_LIMIT) + 1,
            "one past the span bound"
        );
        _assertBatchRejectedWholesale(
            members,
            abi.encodeWithSelector(
                TabAscBase.BatchRangeExceeded.selector,
                members[0].height,
                members[members.length - 1].height,
                SPAN_LIMIT
            )
        );
    }
}
