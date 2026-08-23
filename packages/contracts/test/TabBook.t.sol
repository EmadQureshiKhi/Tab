// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Bond, IBond} from "../src/Bond.sol";
import {LimitLib} from "../src/LimitLib.sol";
import {IServiceRegistry, ServiceRegistry} from "../src/ServiceRegistry.sol";
import {ITabBook, TabBook} from "../src/TabBook.sol";

/// @title TabBookFixture
/// @notice Shared deployment, wiring, and witness bookkeeping for the two `TabBook` suites.
/// @dev The whole contract tree is deployed for real: a `ServiceRegistry` with a registered and
/// curated Service, a `Bond` funded through its proven-deposit path, and a `TabBook` wired to both.
/// Nothing is mocked, so every figure asserted downstream is produced by the same code that would run
/// on chain.
///
/// The `_mirror` array is the interesting part. It reproduces, in the test, the settlement record
/// `TabBook._recordOf` builds on chain, and every Credit Limit read in either suite is driven through
/// it. That makes the rolling commitment self-checking: if the fixture and the contract ever disagree
/// about a single field, the commitment check fails and every test that reads a limit goes red.
contract TabBookFixture is Test {
    /// @notice Registry the price list, tier, and Bond account come from.
    ServiceRegistry internal registry;

    /// @notice Bond the clearing lifecycle pledges against.
    Bond internal bond;

    /// @notice Contract under test.
    TabBook internal book;

    /// @notice The Agent every test charges.
    address internal constant AGENT = address(0xA6E7);

    /// @notice A second Agent, used to show figures are per Agent.
    address internal constant OTHER_AGENT = address(0xA6E8);

    /// @notice Creditcoin address that operates the Service under test.
    address internal constant OPERATOR = address(0x0FE1);

    /// @notice Creditcoin address that operates the second Service.
    address internal constant OPERATOR_TWO = address(0x0FE2);

    /// @notice Creditcoin address that operates the third Service.
    address internal constant OPERATOR_THREE = address(0x0FE3);

    /// @notice Creditcoin address that operates the Service registered with a shorter window.
    address internal constant OPERATOR_SHORT = address(0x0FE4);

    /// @notice The wired `SettlementVerifier`.
    address internal constant VERIFIER = address(0x5EF1);

    /// @notice The wired Watcher.
    address internal constant WATCHER = address(0x3A7C);

    /// @notice An address wired to nothing.
    address internal constant STRANGER = address(0xDEAD);

    /// @notice Ethereum address that paid, as it would appear in `topics[1]`.
    address internal constant PAYER = address(0x9A7E);

    /// @notice The Asset in launch scope.
    address internal constant USDC = address(0x05DC);

    /// @notice A second Asset, present in every isolation assertion.
    address internal constant USDT = address(0x05D7);

    /// @notice Collection Address for the launch Asset.
    address internal constant COLLECTION = address(0xC011);

    /// @notice Collection Address for the second Asset.
    address internal constant COLLECTION_TWO = address(0xC012);

    /// @notice Collection Address of the second Service, launch Asset.
    address internal constant COLLECTION_THREE = address(0xC013);

    /// @notice Collection Address of the second Service, second Asset.
    address internal constant COLLECTION_FOUR = address(0xC014);

    /// @notice Collection Address of the third Service, launch Asset.
    address internal constant COLLECTION_FIVE = address(0xC015);

    /// @notice Collection Address of the third Service, second Asset.
    address internal constant COLLECTION_SIX = address(0xC016);

    /// @notice Collection Address of the short-window Service, launch Asset.
    address internal constant COLLECTION_SEVEN = address(0xC017);

    /// @notice Collection Address of the short-window Service, second Asset.
    address internal constant COLLECTION_EIGHT = address(0xC018);

    /// @notice The Service under test.
    bytes32 internal constant SERVICE = keccak256("service-one");

    /// @notice A second Service, used for the per-Service and ineligible-bond cases.
    bytes32 internal constant SERVICE_TWO = keccak256("service-two");

    /// @notice A third Service, so a history can reach the three-counterparty growth path.
    bytes32 internal constant SERVICE_THREE = keccak256("service-three");

    /// @notice A Service registered with a Settlement Window unequal to every other Service's.
    bytes32 internal constant SERVICE_SHORT = keccak256("service-short");

    /// @notice The named priced tool.
    bytes32 internal constant TOOL = keccak256("proof");

    /// @notice A tool no Service prices.
    bytes32 internal constant UNKNOWN_TOOL = keccak256("nope");

    /// @notice Price of one unit of {TOOL} in launch-Asset base units.
    uint256 internal constant PRICE = 1_000;

    /// @notice Price of one unit of {TOOL} in second-Asset base units.
    uint256 internal constant PRICE_TWO = 2_000;

    /// @notice Baseline Credit Limit in Asset base units. (D3)
    uint256 internal constant BASELINE = 5_000_000;

    /// @notice Growth factor in basis points. (D5)
    uint256 internal constant GROWTH_BPS = 5_000;

    /// @notice Stake the Service posts in each Asset.
    uint128 internal constant BOND_STAKE = 10_000_000;

    /// @notice Ceiling every authorisation in these suites carries.
    uint128 internal constant AUTH_MAX = 100_000_000;

    /// @notice Settlement Window the Service registers, in seconds.
    uint32 internal constant WINDOW = 6 hours;

    /// @notice A deliberately different Settlement Window, carried by {SERVICE_SHORT}.
    uint32 internal constant SHORT_WINDOW = 1 hours;

    /// @notice Attested-chain identifier of Ethereum Sepolia.
    uint64 internal constant CHAIN_SEPOLIA = 1;

    /// @notice Attested-chain identifier of Ethereum Mainnet.
    uint64 internal constant CHAIN_MAINNET = 3;

    /// @notice Source Chain transaction hash every observation carries. Audit data only. (R15.8)
    bytes32 internal constant TX_HASH = keccak256("source-tx");

    /// @notice Block digest the Watcher observed for that transaction's block. (D8)
    bytes32 internal constant OBSERVED_DIGEST = keccak256("observed-digest");

    /// @notice Wall clock every suite starts from.
    uint64 internal constant START = 1_700_000_000;

    /// @notice The registry hold every queued change waits out.
    uint64 internal constant TIMELOCK = 48 hours;

    /// @notice Expected Verified Settlement history per Asset, for the launch Agent.
    mapping(address => LimitLib.SettlementRecord[]) internal _mirror;

    /// @notice Counterparties whose Bond entries the witness carries.
    bytes32[] internal _counterparties;

    /// @notice Deploys the tree, completes the wiring, registers and curates the Service, and funds it.
    function setUp() public virtual {
        vm.warp(START);

        registry = new ServiceRegistry(address(this));
        bond = new Bond(address(this));
        book = new TabBook(address(this), address(registry), address(bond), BASELINE, GROWTH_BPS);

        bond.setSettlementVerifier(VERIFIER);
        bond.setTabBook(address(book));
        book.setSettlementVerifier(VERIFIER);
        book.setWatcher(WATCHER);

        _registerService(SERVICE, OPERATOR, COLLECTION, COLLECTION_TWO);
        _curate(SERVICE);
        _fundBond(OPERATOR, USDC, BOND_STAKE);
        _fundBond(OPERATOR, USDT, BOND_STAKE);

        _counterparties.push(SERVICE);
        _authorise(AGENT, SERVICE, USDC, AUTH_MAX);
        _authorise(AGENT, SERVICE, USDT, AUTH_MAX);
    }

    // ------------------------------------------------------------------ fixture helpers

    /// @notice Registers one Service accepting both Assets on Ethereum Mainnet, on {WINDOW}.
    /// @param serviceId Identifier to claim.
    /// @param operator Creditcoin address that will operate it.
    /// @param collectionOne Collection Address for the launch Asset.
    /// @param collectionTwo Collection Address for the second Asset.
    function _registerService(
        bytes32 serviceId,
        address operator,
        address collectionOne,
        address collectionTwo
    ) internal {
        _registerServiceOn(serviceId, operator, collectionOne, collectionTwo, WINDOW);
    }

    /// @notice Registers one Service with its Settlement Window named separately.
    /// @dev Separate from {_registerService} so a suite can register two Services whose windows
    /// differ, which is the only way to tell a window read from the registry apart from a constant.
    /// @param serviceId Identifier to claim.
    /// @param operator Creditcoin address that will operate it.
    /// @param collectionOne Collection Address for the launch Asset.
    /// @param collectionTwo Collection Address for the second Asset.
    /// @param window Settlement Window in seconds.
    function _registerServiceOn(
        bytes32 serviceId,
        address operator,
        address collectionOne,
        address collectionTwo,
        uint32 window
    ) internal {
        uint64[] memory chainKeys = new uint64[](2);
        chainKeys[0] = CHAIN_MAINNET;
        chainKeys[1] = CHAIN_MAINNET;

        address[] memory assets = new address[](2);
        assets[0] = USDC;
        assets[1] = USDT;

        address[] memory collections = new address[](2);
        collections[0] = collectionOne;
        collections[1] = collectionTwo;

        bytes32[] memory tools = new bytes32[](1);
        tools[0] = TOOL;

        uint256[] memory prices = new uint256[](2);
        prices[0] = PRICE;
        prices[1] = PRICE_TWO;

        vm.prank(operator);
        registry.registerService(serviceId, chainKeys, assets, collections, tools, prices, window);
    }

    /// @notice Promotes a Service into the Curated Tier through the 48-hour hold.
    /// @param serviceId Service to promote.
    function _curate(bytes32 serviceId) internal {
        (bytes32 changeId,) = registry.queueChange(
            serviceId, IServiceRegistry.ChangeKind.Tier, abi.encode(uint256(IServiceRegistry.Tier.Curated))
        );
        vm.warp(block.timestamp + TIMELOCK);
        registry.applyChange(changeId);
    }

    /// @notice Credits stake through the proven-deposit path.
    /// @param account The Service's `bondAccount`.
    /// @param asset Asset to credit.
    /// @param amount Amount to credit.
    function _fundBond(address account, address asset, uint128 amount) internal {
        // The party key is resolved first, deliberately. An external call inside the argument list
        // would consume the prank before the funding call ever reached the Bond.
        bytes32 party = bond.partyOf(account);
        bytes32 replayKey = keccak256(abi.encode(account, asset, amount));

        vm.prank(VERIFIER);
        bond.fundFromVerifiedSettlement(party, asset, amount, replayKey);
    }

    /// @notice Sets a spending authorisation as the Agent.
    /// @param agent Agent granting it.
    /// @param serviceId Service it applies to.
    /// @param asset Asset it applies to.
    /// @param maxCumulative Ceiling on total charges.
    function _authorise(address agent, bytes32 serviceId, address asset, uint128 maxCumulative) internal {
        vm.prank(agent);
        book.authorise(serviceId, asset, maxCumulative, uint64(block.timestamp) + 365 days);
    }

    /// @notice The witness for the launch Agent in one Asset.
    /// @param asset Asset to build for.
    /// @return witness History mirrored from this fixture plus one Bond entry per counterparty.
    function _witness(address asset) internal view returns (ITabBook.LimitWitness memory witness) {
        return _witnessFor(asset, asset);
    }

    /// @notice The witness for the launch Agent, with Bond entries denominated in a chosen Asset.
    /// @param asset Asset the history is scoped to.
    /// @param bondAsset Asset the Bond entries name.
    /// @return witness The witness.
    function _witnessFor(address asset, address bondAsset)
        internal
        view
        returns (ITabBook.LimitWitness memory witness)
    {
        LimitLib.SettlementRecord[] memory history = _mirror[asset];

        LimitLib.BondEntry[] memory bonds = new LimitLib.BondEntry[](_counterparties.length);
        for (uint256 i = 0; i < _counterparties.length; ++i) {
            // The amount is deliberately a lie. `TabBook` replaces it with the on-chain figure, and
            // one of the tests below proves it.
            bonds[i] = LimitLib.BondEntry({serviceId: _counterparties[i], asset: bondAsset, amount: 0});
        }

        witness = ITabBook.LimitWitness({history: history, bonds: bonds});
    }

    /// @notice Meters one delivery as the Service operator.
    /// @param units Count of priced units.
    /// @return charged Amount added to the Open Tab.
    function _deliver(uint32 units) internal returns (uint256 charged) {
        return _deliverAs(OPERATOR, SERVICE, USDC, units, PRICE);
    }

    /// @notice Meters one delivery with every parameter named.
    /// @param operator Caller.
    /// @param serviceId Service metering.
    /// @param asset Asset of the charge.
    /// @param units Count of priced units.
    /// @param unitPrice Unit price the caller quotes.
    /// @return charged Amount added to the Open Tab.
    function _deliverAs(address operator, bytes32 serviceId, address asset, uint32 units, uint256 unitPrice)
        internal
        returns (uint256 charged)
    {
        vm.prank(operator);
        (charged,,) = book.recordDelivery(AGENT, serviceId, asset, TOOL, units, unitPrice, _witness(asset));
    }

    /// @notice The packed replay key of one Source Chain log, in `TabAscBase`'s layout. (R4.1)
    /// @dev Reproduced here rather than imported, because `TabBook` does not inherit `TabAscBase` and
    /// the whole point of the packing is that two independent implementations agree on it. The
    /// differential test between this layout and the off-chain one lives in `test/property`.
    /// @param chainKey Attested-chain identifier.
    /// @param blockHeight Source Chain block height.
    /// @param txIndex Index of the transaction within its block.
    /// @param logIndex Receipt-wide ordinal of the log within that transaction.
    /// @return key The packed key.
    function _replayKeyOf(uint64 chainKey, uint64 blockHeight, uint64 txIndex, uint64 logIndex)
        internal
        pure
        returns (bytes32 key)
    {
        key = bytes32(
            (uint256(chainKey) << 192) | (uint256(blockHeight) << 128) | (uint256(txIndex) << 64)
                | uint256(logIndex)
        );
    }

    /// @notice One observed Settlement for the launch Agent and Service, honest in every field.
    /// @dev The `chainKey` is taken from the replay key, so the two agree unless a test sets out to
    /// make them disagree. That is what `_observationOn` is for.
    /// @param replayKey Replay key of the observed log, and the clearing identity.
    /// @param asset Asset of the observation.
    /// @param amount Observed Settlement amount.
    /// @return o The observation.
    function _observation(bytes32 replayKey, address asset, uint128 amount)
        internal
        pure
        returns (ITabBook.ProvisionalObservation memory o)
    {
        return _observationOn(replayKey, asset, amount, uint64(uint256(replayKey) >> 192));
    }

    /// @notice The same observation with the `chainKey` field named separately from the replay key.
    /// @param replayKey Replay key of the observed log.
    /// @param asset Asset of the observation.
    /// @param amount Observed Settlement amount.
    /// @param chainKey Source Chain the observation claims.
    /// @return o The observation.
    function _observationOn(bytes32 replayKey, address asset, uint128 amount, uint64 chainKey)
        internal
        pure
        returns (ITabBook.ProvisionalObservation memory o)
    {
        o = ITabBook.ProvisionalObservation({
            replayKey: replayKey,
            agent: AGENT,
            serviceId: SERVICE,
            asset: asset,
            amount: amount,
            chainKey: chainKey,
            sourceTxHash: TX_HASH,
            attestedDigestAtApply: OBSERVED_DIGEST
        });
    }

    /// @notice Applies a Verified Settlement as the wired verifier and mirrors the committed record.
    /// @param replayKey Replay key of the settling log, which is also the clearing identity.
    /// @param asset Asset settled in.
    /// @param amount Settled amount.
    function _settle(bytes32 replayKey, address asset, uint256 amount) internal {
        _settleFull(replayKey, SERVICE, asset, amount, CHAIN_MAINNET);
    }

    /// @notice Applies a Verified Settlement with every field named.
    /// @param replayKey Replay key of the settling log.
    /// @param serviceId Service paid.
    /// @param asset Asset settled in.
    /// @param amount Settled amount.
    /// @param chainKey Source Chain of the proof.
    function _settleFull(bytes32 replayKey, bytes32 serviceId, address asset, uint256 amount, uint64 chainKey)
        internal
    {
        _mirrorAppend(serviceId, asset, amount, chainKey);
        vm.prank(VERIFIER);
        book.applyVerifiedSettlement(_settlement(replayKey, serviceId, asset, amount, chainKey));
    }

    /// @notice Builds a Verified Settlement entry.
    /// @dev No Source Chain transaction hash, because the struct carries none. The
    /// `SettlementVerifier` holds only the prover's chunked composite, which it cannot honestly hash
    /// into the value the Watcher observed, so the hash lives on the clearing record instead.
    /// @param replayKey Replay key of the settling log.
    /// @param serviceId Service paid.
    /// @param asset Asset settled in.
    /// @param amount Settled amount.
    /// @param chainKey Source Chain of the proof.
    /// @return s The entry.
    function _settlement(bytes32 replayKey, bytes32 serviceId, address asset, uint256 amount, uint64 chainKey)
        internal
        pure
        returns (ITabBook.VerifiedSettlement memory s)
    {
        s = ITabBook.VerifiedSettlement({
            replayKey: replayKey,
            chainKey: chainKey,
            blockHeight: 21_000_000,
            txIndex: 7,
            logIndex: 0,
            agent: AGENT,
            payerAddress: PAYER,
            serviceId: serviceId,
            asset: asset,
            amount: amount,
            sourceTabId: bytes32(0)
        });
    }

    /// @notice Appends the record `TabBook` will commit, so the witness stays in step.
    /// @param serviceId Service paid.
    /// @param asset Asset settled in.
    /// @param amount Settled amount.
    /// @param chainKey Source Chain of the proof.
    function _mirrorAppend(bytes32 serviceId, address asset, uint256 amount, uint64 chainKey) internal {
        address bondAccount = registry.serviceOf(serviceId).bondAccount;
        _mirror[asset].push(
            LimitLib.SettlementRecord({
                serviceId: serviceId,
                asset: asset,
                amount: uint128(amount),
                settledAt: uint64(block.timestamp),
                firstDeliveryAt: book.firstDeliveryAtOf(AGENT, serviceId, asset),
                chainKey: chainKey,
                curated: registry.tierOf(serviceId) == IServiceRegistry.Tier.Curated,
                bonded: bond.ledgerOf(bond.partyOf(bondAccount), asset).staked > 0
            })
        );
    }

    /// @notice Every stored Bond figure for one party in one Asset, plus the derived free amount.
    /// @dev A fixed array rather than a five-tuple so a snapshot costs one stack slot. Two snapshots
    /// as tuples exhaust the legacy code generator's stack inside a test body.
    /// @param account The Service's `bondAccount`.
    /// @param asset Asset to read.
    /// @return figures `staked`, `reserved`, `slashed`, `released`, `free`, in that order.
    function _ledgerFigures(address account, address asset)
        internal
        view
        returns (uint256[5] memory figures)
    {
        bytes32 party = bond.partyOf(account);
        IBond.Ledger memory ledger = bond.ledgerOf(party, asset);
        figures[0] = ledger.staked;
        figures[1] = ledger.reserved;
        figures[2] = ledger.slashed;
        figures[3] = ledger.released;
        figures[4] = bond.freeOf(party, asset);
    }

    /// @notice Asserts two Bond snapshots agree field by field.
    /// @param expected Snapshot taken before the action.
    /// @param actual Snapshot taken after it.
    /// @param label Which Asset the snapshots belong to.
    function _assertFiguresEqual(uint256[5] memory expected, uint256[5] memory actual, string memory label)
        internal
        pure
    {
        assertEq(actual[0], expected[0], string.concat(label, ": staked unmoved"));
        assertEq(actual[1], expected[1], string.concat(label, ": reserved unmoved"));
        assertEq(actual[2], expected[2], string.concat(label, ": slashed unmoved"));
        assertEq(actual[3], expected[3], string.concat(label, ": released unmoved"));
        assertEq(actual[4], expected[4], string.concat(label, ": free unmoved"));
    }

    /// @notice Registers, curates, bonds in both Assets, and authorises one further counterparty.
    /// @dev Everything a Service needs before one of its Settlements can weigh in a Credit Limit:
    /// the Curated Tier (R17.2), a Bond in the Settlement Asset (R17.2), and an Agent authorisation
    /// so its Bond entry is admitted as a counterparty's. Pushed onto {_counterparties} so the
    /// witness carries its Bond entry.
    /// @param serviceId Identifier to claim.
    /// @param operator Creditcoin address that will operate it.
    /// @param collectionOne Collection Address for the launch Asset.
    /// @param collectionTwo Collection Address for the second Asset.
    function _addCounterparty(
        bytes32 serviceId,
        address operator,
        address collectionOne,
        address collectionTwo
    ) internal {
        _registerService(serviceId, operator, collectionOne, collectionTwo);
        _curate(serviceId);
        _fundBond(operator, USDC, BOND_STAKE);
        _fundBond(operator, USDT, BOND_STAKE);
        _authorise(AGENT, serviceId, USDC, AUTH_MAX);
        _authorise(AGENT, serviceId, USDT, AUTH_MAX);
        _counterparties.push(serviceId);
    }

    /// @notice How many `TabDelinquent` events a recorded log set carries.
    /// @dev Counts by `topics[0]` over every emitter rather than matching one expected event, because
    /// the claim under test is a count and `vm.expectEmit` cannot express one: it asserts that a
    /// matching event appears, and stays satisfied when a second identical event appears behind it.
    /// A zero-topic log is possible in a recorded set, so the length is checked before the index.
    /// @param logs Logs recorded across one call.
    /// @return count Number of `TabDelinquent` events in the set.
    function _delinquentEventCount(Vm.Log[] memory logs) internal pure returns (uint256 count) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == ITabBook.TabDelinquent.selector) ++count;
        }
    }
}

/// @title TabBookTest
/// @notice Soundness tests for tabs, authorisations, metering, Verified Settlement application, and
/// the delinquency crank.
/// @dev The clearing lifecycle lives in its own suite; this one covers everything either side of it.
/// Four things are asserted rather than assumed:
///
///  1. every figure on the tab and the aggregate after each step, so the accounting is checked;
///  2. that a witness the caller tampered with is rejected, including the flags the four `LimitLib`
///     filters rest on, which the design's commitment formula would have left forgeable;
///  3. that the delinquency crank zeroes credit, emits exactly one event, and moves no Bond figure,
///     against a full ledger snapshot — **Property 16**;
///  4. that a record filtered out on Asset leaves every figure for the launch Asset alone, including
///     the Credit Limit on the growth path where a leak would show — **Property 9**.
///
/// The last two carry property statements the design demotes from property-based tests to unit tests,
/// so each is tagged with its property number at its declaration.
///
/// Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 13.2, 13.3, 14.2, 14.8, 14.11, 16.4, 18.1, 18.2,
/// 18.3, 18.4, 18.5
contract TabBookTest is TabBookFixture {
    // ------------------------------------------------------------------ construction and wiring

    /// @notice Construction refuses the zero address in all three address slots.
    function test_constructorRefusesZeroAddresses() public {
        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        new TabBook(address(0), address(registry), address(bond), BASELINE, GROWTH_BPS);

        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        new TabBook(address(this), address(0), address(bond), BASELINE, GROWTH_BPS);

        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        new TabBook(address(this), address(registry), address(0), BASELINE, GROWTH_BPS);
    }

    /// @notice Wiring is one-shot in both slots, refuses zero, and is restricted to the authority.
    function test_wiringIsOneShotRestrictedAndNonZero() public {
        vm.expectRevert(abi.encodeWithSelector(ITabBook.AlreadyWired.selector, VERIFIER));
        book.setSettlementVerifier(STRANGER);

        vm.expectRevert(abi.encodeWithSelector(ITabBook.AlreadyWired.selector, WATCHER));
        book.setWatcher(STRANGER);

        TabBook fresh = new TabBook(address(this), address(registry), address(bond), BASELINE, GROWTH_BPS);

        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        fresh.setSettlementVerifier(address(0));
        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        fresh.setWatcher(address(0));

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.NotWiringAuthority.selector, STRANGER));
        fresh.setSettlementVerifier(VERIFIER);

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.NotWiringAuthority.selector, STRANGER));
        fresh.setWatcher(WATCHER);
    }

    /// @notice An unwired book accepts neither a settlement nor a clearing.
    function test_unwiredBookAcceptsNothing() public {
        TabBook fresh = new TabBook(address(this), address(registry), address(bond), BASELINE, GROWTH_BPS);

        vm.expectRevert(abi.encodeWithSelector(ITabBook.NotSettlementVerifier.selector, address(this)));
        fresh.applyVerifiedSettlement(_settlement(bytes32("r"), SERVICE, USDC, 1, CHAIN_MAINNET));

        vm.expectRevert(abi.encodeWithSelector(ITabBook.NotWatcher.selector, address(this)));
        fresh.applyProvisionalClearing(_observation(_replayKeyOf(CHAIN_MAINNET, 1, 0, 0), USDC, 1));
    }

    // ------------------------------------------------------------------ authorisations

    /// @notice Only the Agent writes its own authorisation, and the record carries what it asked for.
    function test_authoriseIsWrittenUnderTheCallersOwnIdentity() public {
        vm.prank(OTHER_AGENT);
        book.authorise(SERVICE, USDC, 42, uint64(block.timestamp) + 1 days);

        ITabBook.Authorisation memory mine = book.authorisationOf(OTHER_AGENT, SERVICE, USDC);
        assertEq(mine.maxCumulative, 42, "ceiling stored");
        assertEq(mine.spent, 0, "nothing spent yet");
        assertTrue(mine.exists, "record exists");

        // The call above could not have touched anybody else's record: the key is derived from
        // `msg.sender`, so there is no parameter through which another Agent could be named.
        assertEq(book.authorisationOf(AGENT, SERVICE, USDC).maxCumulative, AUTH_MAX, "untouched");
    }

    /// @notice Re-authorising replaces the record wholesale, so cumulative spend returns to zero.
    function test_reauthorisingResetsSpend() public {
        _deliver(10);
        assertEq(book.authorisationOf(AGENT, SERVICE, USDC).spent, 10 * PRICE, "spend accrued");

        _authorise(AGENT, SERVICE, USDC, AUTH_MAX);
        assertEq(book.authorisationOf(AGENT, SERVICE, USDC).spent, 0, "spend reset");
    }

    /// @notice An authorisation that has already lapsed cannot be created, nor can a zero Asset.
    function test_authoriseRefusesPastExpiryAndZeroAsset() public {
        uint64 nowTs = uint64(block.timestamp);

        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.AuthorisationExpired.selector, nowTs, nowTs));
        book.authorise(SERVICE, USDC, 1, nowTs);

        vm.prank(AGENT);
        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        book.authorise(SERVICE, address(0), 1, nowTs + 1 days);
    }

    /// @notice Metering without an authorisation, past its expiry, or past its ceiling all revert.
    function test_authorisationGatesEveryDelivery() public {
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(ITabBook.AuthorisationMissing.selector, OTHER_AGENT, SERVICE, USDC)
        );
        book.recordDelivery(OTHER_AGENT, SERVICE, USDC, TOOL, 1, PRICE, _witness(USDC));

        _authorise(AGENT, SERVICE, USDC, 2_000);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.AuthorisationExceeded.selector, 2_000, 0, 3_000));
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, 3, PRICE, _witness(USDC));

        uint64 expiry = uint64(block.timestamp) + 1 hours;
        vm.prank(AGENT);
        book.authorise(SERVICE, USDC, AUTH_MAX, expiry);
        vm.warp(expiry + 1);
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(ITabBook.AuthorisationExpired.selector, expiry, uint64(block.timestamp))
        );
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, 1, PRICE, _witness(USDC));
    }

    // ------------------------------------------------------------------ metering

    /// @notice A delivery charges the applied price and writes every counter the design names.
    function test_deliveryChargesAppliedPriceAndWritesTheTab() public {
        vm.expectEmit(true, true, true, true, address(book));
        emit ITabBook.DeliveryRecorded(AGENT, SERVICE, USDC, TOOL, 3, 3 * PRICE, uint64(block.timestamp));
        uint256 charged = _deliver(3);

        assertEq(charged, 3 * PRICE, "units times applied unit price");

        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        ITabBook.Tab memory tab = book.tabOf(tabId);
        assertEq(tab.open, 3 * PRICE, "open tab");
        assertEq(tab.prepaid, 0, "no prepaid credit");
        assertEq(tab.oldestUnsettledAt, uint64(block.timestamp), "window clock started");
        assertEq(tab.lastDeliveryAt, uint64(block.timestamp), "last delivery");
        assertEq(tab.deliveryCount, 1, "delivery counted");
        assertFalse(tab.delinquent, "not delinquent");

        assertEq(book.assetOpen(AGENT, USDC), 3 * PRICE, "aggregate follows the tab");
        assertEq(book.firstDeliveryAtOf(AGENT, SERVICE, USDC), uint64(block.timestamp), "first delivery");

        ITabBook.TabRef memory ref = book.tabRefOf(tabId);
        assertEq(ref.agent, AGENT, "ref agent");
        assertEq(ref.serviceId, SERVICE, "ref service");
        assertEq(ref.asset, USDC, "ref asset");
        assertTrue(ref.exists, "ref exists");
    }

    /// @notice The first delivery timestamp is written once and never moved.
    function test_firstDeliveryTimestampIsWrittenOnce() public {
        _deliver(1);
        uint64 first = book.firstDeliveryAtOf(AGENT, SERVICE, USDC);

        vm.warp(block.timestamp + 1 hours);
        _deliver(1);

        assertEq(book.firstDeliveryAtOf(AGENT, SERVICE, USDC), first, "unchanged by a later delivery");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).oldestUnsettledAt, first, "window unmoved");
    }

    /// @notice Only the Service operator may meter, and a zero-unit delivery is refused.
    function test_deliveryRejectsStrangerAndZeroUnits() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.NotServiceOperator.selector, SERVICE, STRANGER));
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, 1, PRICE, _witness(USDC));

        vm.prank(OPERATOR);
        vm.expectRevert(ITabBook.ZeroUnits.selector);
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, 0, PRICE, _witness(USDC));
    }

    /// @notice A quote that disagrees with the applied price list is refused. (D10)
    function test_priceListChangedMidCallRejectsAStaleQuote() public {
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITabBook.PriceListChangedMidCall.selector, SERVICE, USDC, TOOL, PRICE - 1, PRICE
            )
        );
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, 1, PRICE - 1, _witness(USDC));
    }

    /// @notice A queued price change does not disturb an in-flight quote until it is applied. (R11.7)
    /// @dev This is the whole point of the quote mechanism. During the 48-hour hold the registry keeps
    /// serving the previous price, so the old quote still charges; once the change lands, the old quote
    /// is refused and the new one charges. A Service therefore cannot re-price inside a call it has
    /// already quoted.
    function test_quoteFollowsTheAppliedPriceAcrossTheTimelock() public {
        uint256 newPrice = PRICE * 2;

        vm.prank(OPERATOR);
        (bytes32 changeId,) =
            registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Price, abi.encode(USDC, TOOL, newPrice));

        // Inside the hold the applied price is still the old one, so the old quote charges.
        assertEq(_deliverAs(OPERATOR, SERVICE, USDC, 1, PRICE), PRICE, "old price still applied");

        vm.warp(block.timestamp + TIMELOCK);
        vm.prank(OPERATOR);
        registry.applyChange(changeId);

        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITabBook.PriceListChangedMidCall.selector, SERVICE, USDC, TOOL, PRICE, newPrice
            )
        );
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, 1, PRICE, _witness(USDC));

        assertEq(_deliverAs(OPERATOR, SERVICE, USDC, 1, newPrice), newPrice, "new price charges");
    }

    /// @notice An unpriced tool is not free; the registry read refuses it.
    function test_unpricedToolCannotBeMetered() public {
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(IServiceRegistry.UnknownTool.selector, SERVICE, USDC, UNKNOWN_TOOL)
        );
        book.recordDelivery(AGENT, SERVICE, USDC, UNKNOWN_TOOL, 1, PRICE, _witness(USDC));
    }

    // ------------------------------------------------------------------ credit limit and headroom

    /// @notice With no history the limit is the bond-capped baseline, and headroom tracks the tab.
    function test_baselineLimitAndHeadroom() public {
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), BASELINE, "bond-capped baseline");
        assertEq(book.headroom(AGENT, USDC, _witness(USDC)), BASELINE, "full headroom");

        _deliver(1_000);
        assertEq(book.headroom(AGENT, USDC, _witness(USDC)), BASELINE - 1_000 * PRICE, "headroom used");
    }

    /// @notice A delivery exactly at headroom lands; one base unit above it is refused. (R12.3)
    function test_deliveryAtHeadroomLandsAndOneUnitAboveReverts() public {
        uint32 exact = uint32(BASELINE / PRICE);
        (uint256 charged,, uint256 headroomAfter) = _deliverExpectingSuccess(exact);
        assertEq(charged, BASELINE, "charged the whole limit");
        assertEq(headroomAfter, 0, "no headroom left");

        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.LimitExceeded.selector, AGENT, USDC, PRICE, 0));
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, 1, PRICE, _witness(USDC));
    }

    /// @notice A tampered history is refused, including the flags the credit filters rest on.
    /// @dev The forged-flag case is the one the design's commitment formula would have let through. It
    /// committed only `(replayKey, serviceId, asset, amount, settledAt, chainKey)`, leaving `curated`,
    /// `bonded`, and `firstDeliveryAt` free for a caller to choose — which is a Credit Limit
    /// manufactured out of an uncurated, unbonded ring. Chaining the whole record closes it.
    function test_witnessTamperingIsRefused() public {
        _deliver(1);
        _settle(bytes32("r1"), USDC, 500);

        (bytes32 storedRoot, uint32 storedCount) = book.historyCommitment(AGENT, USDC);
        assertEq(storedCount, 1, "one record committed");

        ITabBook.LimitWitness memory tampered = _witness(USDC);
        tampered.history[0].amount = 5_000_000;
        vm.expectRevert();
        book.creditLimit(AGENT, USDC, tampered);

        ITabBook.LimitWitness memory forged = _witness(USDC);
        forged.history[0].curated = !forged.history[0].curated;
        vm.expectRevert();
        book.creditLimit(AGENT, USDC, forged);

        ITabBook.LimitWitness memory truncated = _witness(USDC);
        truncated.history = new LimitLib.SettlementRecord[](0);
        vm.expectRevert(
            abi.encodeWithSelector(ITabBook.HistoryLengthMismatch.selector, storedCount, uint256(0))
        );
        book.creditLimit(AGENT, USDC, truncated);

        // The honest witness still resolves, and it is the one that folds to the stored root.
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), BASELINE, "honest witness accepted");
        assertTrue(storedRoot != bytes32(0), "commitment advanced");
    }

    /// @notice Bond amounts in the witness are discarded and read from `Bond` instead.
    /// @dev The bond cap is what keeps credit strictly under real capital, so a caller that could name
    /// its own bond amounts could name its own Credit Limit. Here the witness claims a bond far larger
    /// than the stake actually posted, and the returned limit is unmoved.
    function test_witnessBondAmountsAreIgnored() public {
        ITabBook.LimitWitness memory inflated = _witness(USDC);
        inflated.bonds[0].amount = type(uint128).max;
        assertEq(book.creditLimit(AGENT, USDC, inflated), BASELINE, "cap taken from the ledger");

        // And with no stake at all the cap is zero, so the baseline is unreachable.
        Bond emptyBond = new Bond(address(this));
        emptyBond.setTabBook(address(this));
        TabBook poor = new TabBook(address(this), address(registry), address(emptyBond), BASELINE, GROWTH_BPS);
        vm.prank(AGENT);
        poor.authorise(SERVICE, USDC, AUTH_MAX, uint64(block.timestamp) + 1 days);
        assertEq(poor.creditLimit(AGENT, USDC, _witness(USDC)), 0, "no stake, no credit");
    }

    /// @notice A repeated or unrelated Bond entry is refused.
    function test_bondEntriesMustBeDistinctCounterparties() public {
        ITabBook.LimitWitness memory duplicated = _witness(USDC);
        LimitLib.BondEntry[] memory twice = new LimitLib.BondEntry[](2);
        twice[0] = duplicated.bonds[0];
        twice[1] = duplicated.bonds[0];
        duplicated.bonds = twice;
        vm.expectRevert(abi.encodeWithSelector(ITabBook.DuplicateBondEntry.selector, SERVICE));
        book.creditLimit(AGENT, USDC, duplicated);

        ITabBook.LimitWitness memory stranger = _witness(USDC);
        stranger.bonds[0].serviceId = SERVICE_TWO;
        vm.expectRevert(abi.encodeWithSelector(ITabBook.IneligibleBondEntry.selector, SERVICE_TWO, USDC));
        book.creditLimit(AGENT, USDC, stranger);
    }

    /// @notice A counterparty proven by the committed history alone is eligible, with no authorisation.
    /// @dev The two eligibility clauses are independent. This Service never receives a spending
    /// authorisation — a Verified Settlement needs none — so the only thing admitting its Bond entry is
    /// its appearance in the Agent's committed history.
    function test_counterpartyProvenByHistoryAloneIsEligible() public {
        _registerService(SERVICE_TWO, OPERATOR_TWO, COLLECTION_THREE, COLLECTION_FOUR);
        _curate(SERVICE_TWO);
        _fundBond(OPERATOR_TWO, USDC, BOND_STAKE);

        assertFalse(book.authorisationOf(AGENT, SERVICE_TWO, USDC).exists, "no authorisation granted");
        _settleFull(bytes32("s1"), SERVICE_TWO, USDC, 1_000, CHAIN_MAINNET);
        _counterparties.push(SERVICE_TWO);

        // Both Bond entries are admitted, and the limit is still the bond-capped baseline because the
        // second Service has no Metered Delivery on record and so contributes no weighted history.
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), BASELINE, "history-proven counterparty");
    }

    /// @notice A Bond entry outside the scoped Asset is carried through and filtered, not rejected.
    function test_outOfScopeBondEntryIsFilteredRatherThanRejected() public view {
        // The entry names the second Asset while the computation is scoped to the launch Asset, so it
        // contributes nothing to the cap and needs no counterparty check.
        ITabBook.LimitWitness memory witness = _witnessFor(USDC, USDT);
        assertEq(book.creditLimit(AGENT, USDC, witness), 0, "no in-scope bond, no credit");
    }

    /// @notice Reads answer with no wallet connected at all. (R12.6)
    function test_readsRequireNoSignature() public {
        _deliver(2);
        _settle(bytes32("r1"), USDC, 1_000);

        vm.startPrank(address(0));
        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        assertEq(book.tabOf(tabId).open, 2 * PRICE - 1_000, "tab readable");
        assertEq(book.assetOpen(AGENT, USDC), 2 * PRICE - 1_000, "aggregate readable");
        (, uint32 count) = book.historyCommitment(AGENT, USDC);
        assertEq(count, 1, "commitment readable");
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), BASELINE, "limit readable");
        assertEq(book.headroom(AGENT, USDC, _witness(USDC)), BASELINE - (2 * PRICE - 1_000), "headroom");
        assertEq(uint8(book.clearingOf(bytes32("r1")).state), uint8(ITabBook.ClearingState.Confirmed), "st");
        assertEq(book.delinquentTabCount(AGENT, USDC), 0, "delinquency readable");
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ verified settlement

    /// @notice A Verified Settlement reduces the tab and restores headroom. (R12.4)
    function test_settlementReducesTheTabAndRestoresHeadroom() public {
        _deliver(1_000);
        uint256 openBefore = book.assetOpen(AGENT, USDC);

        vm.prank(VERIFIER);
        vm.expectEmit(true, true, true, true, address(book));
        emit ITabBook.SettlementApplied(
            bytes32("r1"), AGENT, SERVICE, USDC, 400_000, 0, uint128(openBefore - 400_000)
        );
        book.applyVerifiedSettlement(_settlement(bytes32("r1"), SERVICE, USDC, 400_000, CHAIN_MAINNET));
        _mirrorAppend(SERVICE, USDC, 400_000, CHAIN_MAINNET);

        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, openBefore - 400_000, "tab reduced");
        assertEq(book.assetOpen(AGENT, USDC), openBefore - 400_000, "aggregate reduced");
        assertEq(
            book.headroom(AGENT, USDC, _witness(USDC)), BASELINE - (openBefore - 400_000), "headroom back"
        );
    }

    /// @notice Settlement above the Open Tab zeroes it and banks the excess as prepaid credit. (R12.5)
    function test_excessSettlementBecomesPrepaidCredit() public {
        _deliver(1);
        _settle(bytes32("r1"), USDC, PRICE + 777);

        ITabBook.Tab memory tab = book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC));
        assertEq(tab.open, 0, "tab settled to zero");
        assertEq(tab.prepaid, 777, "excess banked, never refunded");
        assertEq(tab.oldestUnsettledAt, 0, "window clock cleared");
        assertEq(book.assetOpen(AGENT, USDC), 0, "aggregate zeroed");
    }

    /// @notice A Settlement against a tab that does not exist lands entirely as prepaid credit.
    function test_settlementWithNoOpenTabIsAllPrepaid() public {
        _settle(bytes32("r1"), USDC, 5_000);

        ITabBook.Tab memory tab = book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC));
        assertEq(tab.open, 0, "nothing to reduce");
        assertEq(tab.prepaid, 5_000, "all prepaid");
    }

    /// @notice The rolling commitment advances once per Settlement and carries the committed record.
    function test_historyCommitmentAdvancesOncePerSettlement() public {
        _deliver(1);

        (bytes32 rootBefore, uint32 countBefore) = book.historyCommitment(AGENT, USDC);
        assertEq(rootBefore, bytes32(0), "no history yet");
        assertEq(countBefore, 0, "no records yet");

        _settle(bytes32("r1"), USDC, 100);
        (bytes32 rootOne, uint32 countOne) = book.historyCommitment(AGENT, USDC);
        assertEq(countOne, 1, "one record");
        assertTrue(rootOne != bytes32(0), "root advanced");

        _settle(bytes32("r2"), USDC, 100);
        (bytes32 rootTwo, uint32 countTwo) = book.historyCommitment(AGENT, USDC);
        assertEq(countTwo, 2, "two records");
        assertTrue(rootTwo != rootOne, "root advanced again");

        // Both witnesses still validate, which is only true if the fixture and the contract agree on
        // every committed field.
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), BASELINE, "witness accepted");
    }

    /// @notice Only the wired verifier may apply, and no replay key may be applied twice.
    function test_settlementAccessControlAndSingleUse() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.NotSettlementVerifier.selector, STRANGER));
        book.applyVerifiedSettlement(_settlement(bytes32("r1"), SERVICE, USDC, 1, CHAIN_MAINNET));

        _settle(bytes32("r1"), USDC, 1);

        vm.prank(VERIFIER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.SettlementAlreadyApplied.selector, bytes32("r1")));
        book.applyVerifiedSettlement(_settlement(bytes32("r1"), SERVICE, USDC, 1, CHAIN_MAINNET));
    }

    /// @notice A malformed Verified Settlement is refused before any figure moves.
    function test_settlementGuards() public {
        vm.prank(VERIFIER);
        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        book.applyVerifiedSettlement(_settlement(bytes32("r1"), SERVICE, address(0), 1, CHAIN_MAINNET));

        ITabBook.VerifiedSettlement memory wide =
            _settlement(bytes32("r2"), SERVICE, USDC, uint256(type(uint128).max) + 1, CHAIN_MAINNET);
        vm.prank(VERIFIER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.AmountOutOfRange.selector, wide.amount));
        book.applyVerifiedSettlement(wide);

        ITabBook.VerifiedSettlement memory noAgent =
            _settlement(bytes32("r3"), SERVICE, USDC, 1, CHAIN_MAINNET);
        noAgent.agent = address(0);
        vm.prank(VERIFIER);
        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        book.applyVerifiedSettlement(noAgent);
    }

    // ------------------------------------------------------------------ delinquency

    /// @notice The crank fires at the close of the Settlement Window and not one second earlier.
    function test_delinquencyBoundaryIsExactlyTheWindowEnd() public {
        _deliver(1_000);
        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        uint64 windowEnd = book.tabOf(tabId).oldestUnsettledAt + WINDOW;

        vm.warp(windowEnd - 1);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.SettlementWindowOpen.selector, tabId, windowEnd));
        book.markDelinquent(tabId);

        vm.warp(windowEnd);
        book.markDelinquent(tabId);
        assertTrue(book.tabOf(tabId).delinquent, "delinquent at the boundary");
    }

    /// @notice The crank zeroes the Agent's Credit Limit for the Asset and blocks further metering.
    function test_delinquencyZeroesCreditAndBlocksMetering() public {
        _deliver(1_000);
        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        uint128 unsettled = book.tabOf(tabId).open;
        uint64 windowEnd = book.tabOf(tabId).oldestUnsettledAt + WINDOW;

        vm.warp(windowEnd);
        vm.expectEmit(true, true, true, true, address(book));
        emit ITabBook.TabDelinquent(tabId, AGENT, SERVICE, USDC, unsettled, windowEnd);
        book.markDelinquent(tabId);

        assertEq(book.delinquentTabCount(AGENT, USDC), 1, "one delinquent tab");
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), 0, "credit zeroed for the Asset");
        assertEq(book.headroom(AGENT, USDC, _witness(USDC)), 0, "no headroom");

        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.TabIsDelinquent.selector, tabId));
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, 1, PRICE, _witness(USDC));
    }

    /// @notice **Property 16: Delinquency zeroes credit and never slashes.** (R14.8, R14.11)
    /// @dev Demoted from a property-based test to a unit test by the design's own note — one timeout
    /// transition plus a Bond-ledger snapshot expresses the whole claim — so this test carries it, and
    /// all three conjuncts are asserted here rather than spread across the suite: the Credit Limit for
    /// the Asset is zero, exactly one `TabDelinquent` event is emitted, and every field of every Bond
    /// ledger is unmoved.
    ///
    /// The property is quantified over the Open Tab and the Settlement Window. Two cases are chosen,
    /// because these are the two that catch a real implementation error rather than a convenient one:
    ///
    ///  1. **Two Services whose Settlement Windows differ.** A window held as a constant, or read
    ///     from the wrong Service, passes any single-window test. {SERVICE_SHORT} registers a
    ///     one-hour window against the six hours of the Service under test, both tabs open in the
    ///     same instant, and at the one-hour mark the short tab cranks while the long tab still
    ///     reverts `SettlementWindowOpen` naming the six-hour end. So the transition really is at
    ///     `oldestUnsettledAt + settlementWindow` of that tab's own Service.
    ///  2. **Two delinquency-eligible tabs, cranked separately.** A crank that swept the Agent's tabs
    ///     instead of touching the one named would emit two events, and `vm.expectEmit` would stay
    ///     satisfied, because it asserts an event appears and says nothing about how many. The count
    ///     comes from `vm.recordLogs` and `topics[0]` instead.
    ///
    /// The rest of the quantification adds nothing a case could catch. The Open Tab amount reaches
    /// only the event payload, and every non-zero amount takes the same branch — the zero case is a
    /// `NothingUnsettled` revert, covered in `test_delinquencyCrankGuards`.
    ///
    /// The Bond half is checked by snapshot rather than by review. R14.11 forbids any slashing path
    /// for an Agent that fails to settle, so both Services' stake, reservations, cumulative slashed
    /// value, withdrawal-eligible value, and the free amount derived from all four are captured in
    /// both Assets before each call and compared field by field after it, together with the Agent's
    /// prepaid credit in both Assets.
    function test_delinquencyZeroesCreditEmitsOneEventAndMovesNoBondFigure() public {
        _registerServiceOn(SERVICE_SHORT, OPERATOR_SHORT, COLLECTION_SEVEN, COLLECTION_EIGHT, SHORT_WINDOW);
        _fundBond(OPERATOR_SHORT, USDC, BOND_STAKE);
        _fundBond(OPERATOR_SHORT, USDT, BOND_STAKE);
        _authorise(AGENT, SERVICE_SHORT, USDC, AUTH_MAX);

        _deliver(1_000);
        _deliverAs(OPERATOR_SHORT, SERVICE_SHORT, USDC, 1_000, PRICE);

        bytes32 longTab = book.tabIdOf(AGENT, SERVICE, USDC);
        bytes32 shortTab = book.tabIdOf(AGENT, SERVICE_SHORT, USDC);
        uint64 opened = book.tabOf(longTab).oldestUnsettledAt;
        assertEq(book.tabOf(shortTab).oldestUnsettledAt, opened, "both tabs opened in the same instant");

        // The short window closes first, and the long one is demonstrably still open at that instant.
        vm.warp(opened + SHORT_WINDOW);
        vm.expectRevert(
            abi.encodeWithSelector(ITabBook.SettlementWindowOpen.selector, longTab, opened + WINDOW)
        );
        book.markDelinquent(longTab);

        _crankAssertingOneEventAndNoBondMovement(shortTab);
        assertEq(book.delinquentTabCount(AGENT, USDC), 1, "one delinquent tab");

        vm.warp(opened + WINDOW);
        _crankAssertingOneEventAndNoBondMovement(longTab);
        assertEq(book.delinquentTabCount(AGENT, USDC), 2, "both tabs delinquent");
    }

    /// @notice Delinquency lifts once the tab settles to zero, and credit returns with it.
    function test_delinquencyClearsWhenTheTabSettlesToZero() public {
        _deliver(1_000);
        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        vm.warp(book.tabOf(tabId).oldestUnsettledAt + WINDOW);
        book.markDelinquent(tabId);

        // A partial settlement leaves the flag in place: the tab is still overdue.
        _settle(bytes32("r1"), USDC, 400_000);
        assertTrue(book.tabOf(tabId).delinquent, "still delinquent while open");
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), 0, "still suppressed");

        vm.expectEmit(true, true, true, true, address(book));
        emit ITabBook.TabDelinquencyCleared(tabId, AGENT, USDC);
        _settle(bytes32("r2"), USDC, 600_000);

        assertFalse(book.tabOf(tabId).delinquent, "flag lifted");
        assertEq(book.delinquentTabCount(AGENT, USDC), 0, "count back to zero");
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), BASELINE, "credit restored");
    }

    /// @notice The crank refuses an unknown tab, a tab with nothing unsettled, and a repeat.
    function test_delinquencyCrankGuards() public {
        bytes32 unknown = book.tabIdOf(OTHER_AGENT, SERVICE, USDC);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.UnknownTab.selector, unknown));
        book.markDelinquent(unknown);

        _deliver(1);
        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        _settle(bytes32("r1"), USDC, PRICE);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.NothingUnsettled.selector, tabId));
        book.markDelinquent(tabId);

        _deliver(1);
        vm.warp(block.timestamp + WINDOW);
        book.markDelinquent(tabId);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.AlreadyDelinquent.selector, tabId));
        book.markDelinquent(tabId);
    }

    /// @notice The crank is permissionless.
    function test_delinquencyCrankIsPermissionless() public {
        _deliver(1_000);
        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        vm.warp(book.tabOf(tabId).oldestUnsettledAt + WINDOW);

        vm.prank(STRANGER);
        book.markDelinquent(tabId);
        assertTrue(book.tabOf(tabId).delinquent, "a stranger cranked it");
    }

    // ------------------------------------------------------------------ prepaid credit is spendable

    /// @notice A delivery smaller than the banked credit is paid for entirely out of it. (D11, R12.5)
    /// @dev **The task 12.6 regression.** D11 says excess settlement becomes non-refundable prepaid
    /// credit "consumable against future Metered Delivery". Until this fix nothing in the contract ever
    /// decremented `prepaid`, so every base unit that landed there was stranded for good: already paid
    /// for, never spendable, and not refundable either. Measured on the live network at the time, an
    /// Agent held 111,000 base units it could not reach.
    ///
    /// The Open Tab must not move at all here. The Agent already paid this money, so spending it
    /// borrows nothing and the Settlement Window must not start either.
    function test_aDeliveryWithinPrepaidCreditBorrowsNothing() public {
        _settle(bytes32("p1"), USDC, 50_000);

        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        assertEq(book.tabOf(tabId).prepaid, 50_000, "the whole settlement banked as prepaid credit");
        assertEq(book.tabOf(tabId).open, 0, "nothing was owed to begin with");

        uint256 charged = _deliver(3);

        assertEq(charged, 3 * PRICE, "the full charge is still reported");
        assertEq(book.tabOf(tabId).prepaid, 50_000 - 3 * PRICE, "prepaid credit fell by the charge");
        assertEq(book.tabOf(tabId).open, 0, "the Open Tab did not move");
        assertEq(book.assetOpen(AGENT, USDC), 0, "the aggregate did not move either");
        assertEq(book.tabOf(tabId).oldestUnsettledAt, 0, "a fully prepaid delivery starts no window");
        assertEq(book.tabOf(tabId).deliveryCount, 1, "the delivery is still counted");
    }

    /// @notice A delivery larger than the banked credit borrows only the shortfall. (D11, R12.3)
    /// @dev The partial case, and the one that pins where the boundary sits. Prepaid credit is drained
    /// first and the Open Tab rises by the remainder, so every base unit of the charge is accounted for
    /// exactly once. The Settlement Window starts here, because this delivery does leave something
    /// owed.
    function test_aDeliveryBeyondPrepaidCreditBorrowsOnlyTheShortfall() public {
        _settle(bytes32("p2"), USDC, 2_500);

        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        assertEq(book.tabOf(tabId).prepaid, 2_500, "banked");

        uint256 charged = _deliver(4);

        assertEq(charged, 4 * PRICE, "the full charge is reported");
        assertEq(book.tabOf(tabId).prepaid, 0, "prepaid credit is drained first");
        assertEq(book.tabOf(tabId).open, 4 * PRICE - 2_500, "only the shortfall is borrowed");
        assertEq(book.assetOpen(AGENT, USDC), 4 * PRICE - 2_500, "aggregate agrees with the tab");
        assertTrue(book.tabOf(tabId).oldestUnsettledAt != 0, "a partly borrowed delivery starts the window");
    }

    /// @notice Prepaid credit is spent before credit is, so it consumes no headroom. (R12.3)
    /// @dev Credit and prepaid credit are different things and the Credit Limit must only bound the
    /// first. A delivery covered by money the Agent already paid borrows nothing, so it cannot be
    /// refused for want of headroom, and the headroom it reports back must be unchanged.
    function test_spendingPrepaidCreditConsumesNoHeadroom() public {
        _settle(bytes32("p3"), USDC, 40_000);

        (,, uint256 headroomBefore) = _deliverExpectingSuccess(1);
        (,, uint256 headroomAfter) = _deliverExpectingSuccess(1);

        assertEq(headroomAfter, headroomBefore, "headroom did not move while prepaid credit paid");
        assertEq(book.assetOpen(AGENT, USDC), 0, "nothing was borrowed");
    }

    // ------------------------------------------------------------------ per-Asset isolation

    /// @notice **Property 9: Isolated per-asset accounting** — the operational half. (R18.1, R18.2)
    /// @dev Demoted from a property-based test to a unit test because launch scope is one Asset, so
    /// the claim is discharged by the single-Asset accounting cases here and in
    /// `test_recordsFilteredOutOnAssetLeaveTheLaunchLimitAlone`, which carries the Credit Limit half.
    ///
    /// This half is the operations: metering, settling, banking prepaid credit, and going delinquent
    /// all happen in the second Asset while the launch Asset holds a live tab and a committed history.
    /// Every launch-Asset figure is captured first and compared afterwards, so a leak between Assets
    /// fails a test rather than a review. Nothing anywhere converts between the two, and their prices
    /// differ, so a conversion would be visible.
    function test_perAssetIsolation() public {
        _deliver(1_000);
        _settle(bytes32("r1"), USDC, 400_000);

        AssetSnapshot memory before = _snapshot(USDC);

        _runFullRoundInSecondAsset();

        // The second Asset moved, and the launch Asset did not.
        bytes32 tabUsdt = book.tabIdOf(AGENT, SERVICE, USDT);
        // The round banks 9 base units of excess and then meters 5 more units, so the delivery spends
        // that credit before borrowing anything. This asserted `9` until task 12.6, which was the
        // defect written down as an expectation: prepaid credit was banked and then never spendable.
        assertEq(book.tabOf(tabUsdt).prepaid, 0, "second Asset spent its banked excess");
        assertEq(
            book.tabOf(tabUsdt).open,
            5 * PRICE_TWO - 9,
            "the second delivery borrowed only what the banked credit did not cover"
        );
        assertEq(book.delinquentTabCount(AGENT, USDT), 1, "second Asset delinquent");
        assertEq(book.creditLimit(AGENT, USDT, _witness(USDT)), 0, "second Asset credit suppressed");

        _assertSnapshotUnchanged(before, _snapshot(USDC));
    }

    /// @notice **Property 9: Isolated per-asset accounting** — the Credit Limit half. (R13.3, R18.2)
    /// @dev The sharper form of the claim: a *settlement history record* filtered out on Asset leaves
    /// the launch Asset's Credit Limit exactly where it would be without that record. Three records
    /// identical to the launch Asset's in every field but one are committed in the second Asset, and
    /// the launch limit does not move by a base unit.
    ///
    /// The filter is enforced twice over, and both layers are exercised. The rolling commitment is
    /// kept per Agent and per Asset, so a witness for the launch Asset cannot carry a second-Asset
    /// record at all without failing `_requireWitness`; and `LimitLib` skips a record whose `asset`
    /// differs from the scope regardless. This test drives the first layer, which is the one a caller
    /// would have to defeat.
    ///
    /// **Why these cases and not others.** A universally quantified claim gets a unit test only where
    /// the chosen inputs would catch a real error, and three choices here are load-bearing:
    ///
    ///  1. **Three contributing counterparties, so the growth path is taken.** Below three, `LimitLib`
    ///     returns `min(baseline, bondCap)` — a figure no history can move — so an Asset filter that
    ///     did nothing at all would still pass. On the growth path the answer is a function of the
    ///     history, so a leak is visible.
    ///  2. **Both caps deliberately slack.** Contributions are balanced at 1,000,000 each against a
    ///     limit of 8,000,000, so the 25 percent concentration cap is not binding (4 × 1,000,000 is
    ///     under 8,000,000), and the three 10,000,000 stakes put the bond cap at 28,500,000. Either
    ///     cap, if binding, would clamp a leaked contribution and mask it.
    ///  3. **A control in the opposite direction.** The last two lines settle one further record of
    ///     the same shape and amount in the launch Asset and show the limit move by exactly one
    ///     contribution. That is what makes the equality above evidence rather than a tautology: the
    ///     same record moves the limit when its Asset matches, and does not when it does not.
    ///
    /// The Open Tab, prepaid credit, record count, commitment, delinquency suppression, and all five
    /// Bond figures of all three counterparties in the launch Asset are compared either side of the
    /// second-Asset activity as well, so the Asset scope of the whole accounting is asserted and not
    /// only that of the limit.
    function test_recordsFilteredOutOnAssetLeaveTheLaunchLimitAlone() public {
        _buildThreeCounterpartyLaunchHistory();

        AssetSnapshot memory before = _snapshot(USDC);
        uint256[5] memory secondCounterparty = _ledgerFigures(OPERATOR_TWO, USDC);
        uint256[5] memory thirdCounterparty = _ledgerFigures(OPERATOR_THREE, USDC);

        assertEq(before.limit, ISOLATION_LIMIT, "launch limit is growth-derived and uncapped");

        _settleThreeCounterpartiesInSecondAsset();

        // The filtered records are honest and creditworthy: curated, bonded, delivered against, and
        // strictly later than their Metered Delivery. They earn the identical limit in the Asset they
        // belong to, which is what makes their absence from the launch computation a filter on Asset
        // and not a rejection on some other ground.
        assertEq(book.creditLimit(AGENT, USDT, _witness(USDT)), ISOLATION_LIMIT, "second Asset earns it");

        _assertSnapshotUnchanged(before, _snapshot(USDC));
        _assertFiguresEqual(secondCounterparty, _ledgerFigures(OPERATOR_TWO, USDC), "second counterparty");
        _assertFiguresEqual(thirdCounterparty, _ledgerFigures(OPERATOR_THREE, USDC), "third counterparty");

        _settleFull(bytes32("control"), SERVICE, USDC, ISOLATION_AMOUNT, CHAIN_MAINNET);
        assertEq(
            book.creditLimit(AGENT, USDC, _witness(USDC)),
            ISOLATION_LIMIT + ISOLATION_CONTRIBUTION,
            "the same record in the launch Asset does move the limit"
        );
    }

    // ------------------------------------------------------------------ helpers

    /// @notice Settled amount every record in the Asset-isolation test carries, in base units.
    uint256 internal constant ISOLATION_AMOUNT = 8_000_000;

    /// @notice Growth one such record contributes: `8_000_000 * 2500 / 10000 * 5000 / 10000`.
    /// @dev The 2500 is the day-zero age weight, since every record settles in the block the limit is
    /// read in, and the 5000 is {GROWTH_BPS}.
    uint256 internal constant ISOLATION_CONTRIBUTION = 1_000_000;

    /// @notice Credit Limit three such records earn: `BASELINE + 3 * ISOLATION_CONTRIBUTION`.
    uint256 internal constant ISOLATION_LIMIT = BASELINE + 3 * ISOLATION_CONTRIBUTION;

    /// @notice Brings the launch Asset onto the growth path with three contributing counterparties.
    /// @dev Every Metered Delivery is recorded before the single one-second warp and every Settlement
    /// after it, so each record carries a `firstDeliveryAt` strictly earlier than its `settledAt` and
    /// passes the precedence filter (R17.3). Deliveries are recorded in both Assets, so the
    /// second-Asset records added later are eligible in their own Asset rather than inert.
    function _buildThreeCounterpartyLaunchHistory() internal {
        _addCounterparty(SERVICE_TWO, OPERATOR_TWO, COLLECTION_THREE, COLLECTION_FOUR);
        _addCounterparty(SERVICE_THREE, OPERATOR_THREE, COLLECTION_FIVE, COLLECTION_SIX);

        _deliverAs(OPERATOR, SERVICE, USDC, 1, PRICE);
        _deliverAs(OPERATOR_TWO, SERVICE_TWO, USDC, 1, PRICE);
        _deliverAs(OPERATOR_THREE, SERVICE_THREE, USDC, 1, PRICE);
        _deliverAs(OPERATOR, SERVICE, USDT, 1, PRICE_TWO);
        _deliverAs(OPERATOR_TWO, SERVICE_TWO, USDT, 1, PRICE_TWO);
        _deliverAs(OPERATOR_THREE, SERVICE_THREE, USDT, 1, PRICE_TWO);

        vm.warp(block.timestamp + 1);

        _settleFull(bytes32("launch-1"), SERVICE, USDC, ISOLATION_AMOUNT, CHAIN_MAINNET);
        _settleFull(bytes32("launch-2"), SERVICE_TWO, USDC, ISOLATION_AMOUNT, CHAIN_MAINNET);
        _settleFull(bytes32("launch-3"), SERVICE_THREE, USDC, ISOLATION_AMOUNT, CHAIN_MAINNET);
    }

    /// @notice Commits the same three records in the second Asset, at the same instant.
    /// @dev No warp anywhere in here, deliberately. Both limits are read at the timestamp every record
    /// settled at, so every age weight is the day-zero weight and the two Assets are compared on
    /// identical arithmetic rather than on figures that drifted apart with the clock.
    function _settleThreeCounterpartiesInSecondAsset() internal {
        _settleFull(bytes32("second-1"), SERVICE, USDT, ISOLATION_AMOUNT, CHAIN_MAINNET);
        _settleFull(bytes32("second-2"), SERVICE_TWO, USDT, ISOLATION_AMOUNT, CHAIN_MAINNET);
        _settleFull(bytes32("second-3"), SERVICE_THREE, USDT, ISOLATION_AMOUNT, CHAIN_MAINNET);
    }

    /// @notice Cranks one tab, then asserts the three things Property 16 claims about that call.
    /// @dev A helper rather than an inline block because it runs twice, and because four fixed Bond
    /// arrays plus a recorded log set do not fit one test body's stack alongside the rest.
    /// @param tabId Tab to crank.
    function _crankAssertingOneEventAndNoBondMovement(bytes32 tabId) internal {
        uint256[5] memory launchBefore = _ledgerFigures(OPERATOR, USDC);
        uint256[5] memory secondBefore = _ledgerFigures(OPERATOR, USDT);
        uint256[5] memory shortLaunchBefore = _ledgerFigures(OPERATOR_SHORT, USDC);
        uint256[5] memory shortSecondBefore = _ledgerFigures(OPERATOR_SHORT, USDT);
        uint128 prepaidLaunch = bond.prepaidCreditOf(AGENT, USDC);
        uint128 prepaidSecond = bond.prepaidCreditOf(AGENT, USDT);

        vm.recordLogs();
        book.markDelinquent(tabId);
        assertEq(_delinquentEventCount(vm.getRecordedLogs()), 1, "exactly one TabDelinquent event");

        assertTrue(book.tabOf(tabId).delinquent, "the crank did fire");
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), 0, "credit zeroed for the Asset");
        assertEq(book.headroom(AGENT, USDC, _witness(USDC)), 0, "no headroom");

        _assertFiguresEqual(launchBefore, _ledgerFigures(OPERATOR, USDC), "metering Service, launch Asset");
        _assertFiguresEqual(secondBefore, _ledgerFigures(OPERATOR, USDT), "metering Service, second Asset");
        _assertFiguresEqual(
            shortLaunchBefore, _ledgerFigures(OPERATOR_SHORT, USDC), "short-window Service, launch Asset"
        );
        _assertFiguresEqual(
            shortSecondBefore, _ledgerFigures(OPERATOR_SHORT, USDT), "short-window Service, second Asset"
        );

        assertEq(bond.prepaidCreditOf(AGENT, USDC), prepaidLaunch, "no prepaid credit conjured");
        assertEq(bond.prepaidCreditOf(AGENT, USDT), prepaidSecond, "none in the second Asset either");
    }

    /// @notice Every figure the launch Asset is asserted against in the isolation test.
    /// @dev One struct rather than a dozen locals, because a dozen locals plus two reads of them does
    /// not fit the legacy code generator's stack in a single test body.
    struct AssetSnapshot {
        /// @dev Open Tab on the Agent's tab with the Service under test.
        uint128 open;
        /// @dev Prepaid credit on that tab.
        uint128 prepaid;
        /// @dev Delivery counter on that tab.
        uint32 deliveryCount;
        /// @dev Delinquency flag on that tab.
        bool delinquent;
        /// @dev Aggregate Open Tab for the Agent in the Asset.
        uint256 aggregate;
        /// @dev Rolling history commitment for the Agent in the Asset.
        bytes32 root;
        /// @dev Number of records the commitment covers.
        uint32 count;
        /// @dev Credit Limit for the Agent in the Asset.
        uint256 limit;
        /// @dev How many delinquent tabs suppress the Agent's credit in the Asset.
        uint32 delinquentTabs;
        /// @dev The five Bond figures of the Service in the Asset.
        uint256[5] bondFigures;
    }

    /// @notice Captures every launch-Asset figure in one value.
    /// @param asset Asset to capture.
    /// @return snapshot The captured figures.
    function _snapshot(address asset) internal view returns (AssetSnapshot memory snapshot) {
        ITabBook.Tab memory tab = book.tabOf(book.tabIdOf(AGENT, SERVICE, asset));
        (bytes32 root, uint32 count) = book.historyCommitment(AGENT, asset);

        snapshot.open = tab.open;
        snapshot.prepaid = tab.prepaid;
        snapshot.deliveryCount = tab.deliveryCount;
        snapshot.delinquent = tab.delinquent;
        snapshot.aggregate = book.assetOpen(AGENT, asset);
        snapshot.root = root;
        snapshot.count = count;
        snapshot.limit = book.creditLimit(AGENT, asset, _witness(asset));
        snapshot.delinquentTabs = book.delinquentTabCount(AGENT, asset);
        snapshot.bondFigures = _ledgerFigures(OPERATOR, asset);
    }

    /// @notice Asserts two Asset snapshots agree field by field.
    /// @param expected Snapshot taken before the action.
    /// @param actual Snapshot taken after it.
    function _assertSnapshotUnchanged(AssetSnapshot memory expected, AssetSnapshot memory actual)
        internal
        pure
    {
        assertEq(actual.open, expected.open, "open tab untouched");
        assertEq(actual.prepaid, expected.prepaid, "prepaid untouched");
        assertEq(actual.deliveryCount, expected.deliveryCount, "delivery count untouched");
        assertEq(actual.delinquent, expected.delinquent, "delinquency flag untouched");
        assertEq(actual.aggregate, expected.aggregate, "aggregate untouched");
        assertEq(actual.root, expected.root, "commitment untouched");
        assertEq(actual.count, expected.count, "record count untouched");
        assertEq(actual.limit, expected.limit, "credit limit untouched");
        assertEq(actual.delinquentTabs, expected.delinquentTabs, "suppression untouched");
        _assertFiguresEqual(expected.bondFigures, actual.bondFigures, "launch Asset bond");
    }

    /// @notice Meters, over-settles, meters again, and goes delinquent, all in the second Asset.
    function _runFullRoundInSecondAsset() internal {
        _deliverAs(OPERATOR, SERVICE, USDT, 1, PRICE_TWO);
        _settleFull(bytes32("u1"), SERVICE, USDT, PRICE_TWO + 9, CHAIN_MAINNET);
        _deliverAs(OPERATOR, SERVICE, USDT, 5, PRICE_TWO);

        bytes32 tabUsdt = book.tabIdOf(AGENT, SERVICE, USDT);
        vm.warp(book.tabOf(tabUsdt).oldestUnsettledAt + WINDOW);
        book.markDelinquent(tabUsdt);
    }

    /// @notice Meters one delivery and returns all three of its outputs.
    /// @param units Count of priced units.
    /// @return charged Amount added to the Open Tab.
    /// @return openAfter Open Tab after the charge.
    /// @return headroomAfter Headroom remaining.
    function _deliverExpectingSuccess(uint32 units)
        internal
        returns (uint256 charged, uint128 openAfter, uint256 headroomAfter)
    {
        vm.prank(OPERATOR);
        return book.recordDelivery(AGENT, SERVICE, USDC, TOOL, units, PRICE, _witness(USDC));
    }
}
