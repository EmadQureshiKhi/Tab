// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Bond, IBond} from "../src/Bond.sol";
import {LimitLib} from "../src/LimitLib.sol";
import {IServiceRegistry, ServiceRegistry} from "../src/ServiceRegistry.sol";
import {ITabBook, TabBook} from "../src/TabBook.sol";
import {TabSettlement} from "../src/TabSettlement.sol";
import {MockUsdc} from "../src/test/MockUsdc.sol";
import {Permit2Code} from "./helpers/Permit2Code.sol";

/// @dev Shared fixture: a registry, a bond escrow, a book, the settlement surface over the canonical
/// Permit2, two six-decimal Assets, one curated and bonded Service, and one authorised Agent.
/// Settlements here move real tokens through `TabSettlement`, exactly as they do on Monad.
contract TabBookFixture is Test {
    ServiceRegistry internal registry;
    Bond internal bond;
    TabBook internal book;
    TabSettlement internal settlement;
    address internal permit2;
    MockUsdc internal usdc;
    MockUsdc internal usdt;
    address internal USDC;
    address internal USDT;

    address internal constant AGENT = address(0xA6E7);
    address internal constant OTHER_AGENT = address(0xA6E8);
    address internal constant OPERATOR = address(0x0FE1);
    address internal constant OPERATOR_TWO = address(0x0FE2);
    address internal constant OPERATOR_THREE = address(0x0FE3);
    address internal constant OPERATOR_SHORT = address(0x0FE4);
    address internal constant STRANGER = address(0xDEAD);
    address internal constant COLLECTION = address(0xC011);
    address internal constant COLLECTION_TWO = address(0xC012);
    address internal constant COLLECTION_THREE = address(0xC013);
    address internal constant COLLECTION_FOUR = address(0xC014);
    address internal constant COLLECTION_FIVE = address(0xC015);
    address internal constant COLLECTION_SIX = address(0xC016);
    address internal constant COLLECTION_SEVEN = address(0xC017);
    address internal constant COLLECTION_EIGHT = address(0xC018);
    bytes32 internal constant SERVICE = keccak256("service-one");
    bytes32 internal constant SERVICE_TWO = keccak256("service-two");
    bytes32 internal constant SERVICE_THREE = keccak256("service-three");
    bytes32 internal constant SERVICE_SHORT = keccak256("service-short");
    bytes32 internal constant TOOL = keccak256("proof");
    bytes32 internal constant UNKNOWN_TOOL = keccak256("nope");
    uint256 internal constant PRICE = 1_000;
    uint256 internal constant PRICE_TWO = 2_000;
    uint256 internal constant BASELINE = 5_000_000;
    uint256 internal constant GROWTH_BPS = 5_000;
    uint128 internal constant BOND_STAKE = 10_000_000;
    uint128 internal constant AUTH_MAX = 100_000_000;
    uint32 internal constant WINDOW = 6 hours;
    uint32 internal constant SHORT_WINDOW = 1 hours;
    uint64 internal constant START = 1_700_000_000;
    uint64 internal constant TIMELOCK = 48 hours;

    /// @dev Off-chain mirror of the history the book commits to, per Asset, so witnesses can be built.
    mapping(address => LimitLib.SettlementRecord[]) internal _mirror;
    bytes32[] internal _counterparties;

    function setUp() public virtual {
        vm.warp(START);
        usdc = new MockUsdc();
        usdt = new MockUsdc();
        USDC = address(usdc);
        USDT = address(usdt);
        registry = new ServiceRegistry(address(this));
        bond = new Bond();
        book = new TabBook(address(this), address(registry), address(bond), BASELINE, GROWTH_BPS);
        permit2 = Permit2Code.etch(vm);
        settlement = new TabSettlement(address(registry), address(book), permit2);
        book.setSettlementSurface(address(settlement));
        _registerService(SERVICE, OPERATOR, COLLECTION, COLLECTION_TWO);
        _curate(SERVICE);
        _fundBond(OPERATOR, USDC, BOND_STAKE);
        _fundBond(OPERATOR, USDT, BOND_STAKE);
        _counterparties.push(SERVICE);
        _authorise(AGENT, SERVICE, USDC, AUTH_MAX);
        _authorise(AGENT, SERVICE, USDT, AUTH_MAX);
    }

    // ------------------------------------------------------------------ registry helpers

    function _registerService(
        bytes32 serviceId,
        address operator,
        address collectionOne,
        address collectionTwo
    ) internal {
        _registerServiceOn(serviceId, operator, collectionOne, collectionTwo, WINDOW);
    }

    function _registerServiceOn(
        bytes32 serviceId,
        address operator,
        address collectionOne,
        address collectionTwo,
        uint32 window
    ) internal {
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
        registry.registerService(serviceId, assets, collections, tools, prices, window);
    }

    function _curate(bytes32 serviceId) internal {
        (bytes32 changeId,) = registry.queueChange(
            serviceId, IServiceRegistry.ChangeKind.Tier, abi.encode(uint256(IServiceRegistry.Tier.Curated))
        );
        vm.warp(block.timestamp + TIMELOCK);
        registry.applyChange(changeId);
    }

    function _fundBond(address account, address asset, uint128 amount) internal {
        MockUsdc(asset).mint(account, amount);
        vm.startPrank(account);
        MockUsdc(asset).approve(address(bond), amount);
        bond.deposit(asset, amount);
        vm.stopPrank();
    }

    function _authorise(address agent, bytes32 serviceId, address asset, uint128 maxCumulative) internal {
        vm.prank(agent);
        book.authorise(serviceId, asset, maxCumulative, uint64(block.timestamp) + 365 days);
    }

    // ------------------------------------------------------------------ witness helpers

    function _witness(address asset) internal view returns (ITabBook.LimitWitness memory witness) {
        return _witnessFor(asset, asset);
    }

    function _witnessFor(address asset, address bondAsset)
        internal
        view
        returns (ITabBook.LimitWitness memory witness)
    {
        LimitLib.SettlementRecord[] memory history = _mirror[asset];
        LimitLib.BondEntry[] memory bonds = new LimitLib.BondEntry[](_counterparties.length);
        for (uint256 i = 0; i < _counterparties.length; ++i) {
            bonds[i] = LimitLib.BondEntry({serviceId: _counterparties[i], asset: bondAsset, amount: 0});
        }
        witness = ITabBook.LimitWitness({history: history, bonds: bonds});
    }

    // ------------------------------------------------------------------ delivery helpers

    function _deliver(uint32 units) internal returns (uint256 charged) {
        return _deliverAs(OPERATOR, SERVICE, USDC, units, PRICE);
    }

    function _deliverAs(address operator, bytes32 serviceId, address asset, uint32 units, uint256 unitPrice)
        internal
        returns (uint256 charged)
    {
        vm.prank(operator);
        (charged,,) = book.recordDelivery(AGENT, serviceId, asset, TOOL, units, unitPrice, _witness(asset));
    }

    function _deliverExpectingSuccess(uint32 units)
        internal
        returns (uint256 charged, uint128 openAfter, uint256 headroomAfter)
    {
        vm.prank(OPERATOR);
        return book.recordDelivery(AGENT, SERVICE, USDC, TOOL, units, PRICE, _witness(USDC));
    }

    // ------------------------------------------------------------------ settlement helpers

    /// @dev The Agent pays `amount` of `asset` towards its tab with `SERVICE`, through the surface.
    function _settle(address asset, uint128 amount) internal returns (bytes32 settlementId) {
        return _settleFull(SERVICE, asset, amount);
    }

    function _settleFull(bytes32 serviceId, address asset, uint128 amount)
        internal
        returns (bytes32 settlementId)
    {
        _fundAndApprove(serviceId, asset, amount);
        return _settleFunded(serviceId, asset, amount);
    }

    /// @dev Mints, approves and mirrors, without settling. Lets a test set an event expectation
    /// between the funding and the settlement call.
    function _fundAndApprove(bytes32 serviceId, address asset, uint128 amount) internal {
        _mirrorAppend(serviceId, asset, amount);
        MockUsdc(asset).mint(AGENT, amount);
        vm.prank(AGENT);
        MockUsdc(asset).approve(address(settlement), amount);
    }

    function _settleFunded(bytes32 serviceId, address asset, uint128 amount)
        internal
        returns (bytes32 settlementId)
    {
        vm.prank(AGENT);
        (settlementId,,) = settlement.settle(serviceId, asset, amount);
    }

    function _mirrorAppend(bytes32 serviceId, address asset, uint128 amount) internal {
        address bondAccount = registry.serviceOf(serviceId).bondAccount;
        _mirror[asset].push(
            LimitLib.SettlementRecord({
                serviceId: serviceId,
                asset: asset,
                amount: amount,
                settledAt: uint64(block.timestamp),
                firstDeliveryAt: book.firstDeliveryAtOf(AGENT, serviceId, asset),
                curated: registry.tierOf(serviceId) == IServiceRegistry.Tier.Curated,
                bonded: bond.freeOf(bond.partyOf(bondAccount), asset) > 0
            })
        );
    }

    // ------------------------------------------------------------------ bond helpers

    function _ledgerFigures(address account, address asset)
        internal
        view
        returns (uint256[3] memory figures)
    {
        bytes32 party = bond.partyOf(account);
        IBond.Ledger memory ledger = bond.ledgerOf(party, asset);
        figures[0] = ledger.staked;
        figures[1] = ledger.withdrawn;
        figures[2] = bond.freeOf(party, asset);
    }

    function _assertFiguresEqual(uint256[3] memory expected, uint256[3] memory actual, string memory label)
        internal
        pure
    {
        assertEq(actual[0], expected[0], string.concat(label, ": staked unmoved"));
        assertEq(actual[1], expected[1], string.concat(label, ": withdrawn unmoved"));
        assertEq(actual[2], expected[2], string.concat(label, ": free unmoved"));
    }

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

    function _delinquentEventCount(Vm.Log[] memory logs) internal pure returns (uint256 count) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == ITabBook.TabDelinquent.selector) ++count;
        }
    }
}

contract TabBookTest is TabBookFixture {
    // ------------------------------------------------------------------ construction and wiring

    function test_constructorRefusesZeroAddresses() public {
        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        new TabBook(address(0), address(registry), address(bond), BASELINE, GROWTH_BPS);
        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        new TabBook(address(this), address(0), address(bond), BASELINE, GROWTH_BPS);
        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        new TabBook(address(this), address(registry), address(0), BASELINE, GROWTH_BPS);
    }

    function test_wiringIsOneShotRestrictedAndNonZero() public {
        vm.expectRevert(abi.encodeWithSelector(ITabBook.AlreadyWired.selector, address(settlement)));
        book.setSettlementSurface(STRANGER);
        TabBook fresh = new TabBook(address(this), address(registry), address(bond), BASELINE, GROWTH_BPS);
        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        fresh.setSettlementSurface(address(0));
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.NotWiringAuthority.selector, STRANGER));
        fresh.setSettlementSurface(address(settlement));
    }

    function test_unwiredBookAcceptsNoSettlement() public {
        TabBook fresh = new TabBook(address(this), address(registry), address(bond), BASELINE, GROWTH_BPS);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.NotSettlementSurface.selector, address(this)));
        fresh.applySettlement(AGENT, SERVICE, USDC, 1);
    }

    // ------------------------------------------------------------------ authorisation

    function test_authoriseIsWrittenUnderTheCallersOwnIdentity() public {
        vm.prank(OTHER_AGENT);
        book.authorise(SERVICE, USDC, 42, uint64(block.timestamp) + 1 days);
        ITabBook.Authorisation memory mine = book.authorisationOf(OTHER_AGENT, SERVICE, USDC);
        assertEq(mine.maxCumulative, 42, "ceiling stored");
        assertEq(mine.spent, 0, "nothing spent yet");
        assertTrue(mine.exists, "record exists");
        assertEq(book.authorisationOf(AGENT, SERVICE, USDC).maxCumulative, AUTH_MAX, "untouched");
    }

    function test_reauthorisingResetsSpend() public {
        _deliver(10);
        assertEq(book.authorisationOf(AGENT, SERVICE, USDC).spent, 10 * PRICE, "spend accrued");
        _authorise(AGENT, SERVICE, USDC, AUTH_MAX);
        assertEq(book.authorisationOf(AGENT, SERVICE, USDC).spent, 0, "spend reset");
    }

    function test_authoriseRefusesPastExpiryAndZeroAsset() public {
        uint64 nowTs = uint64(block.timestamp);
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.AuthorisationExpired.selector, nowTs, nowTs));
        book.authorise(SERVICE, USDC, 1, nowTs);
        vm.prank(AGENT);
        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        book.authorise(SERVICE, address(0), 1, nowTs + 1 days);
    }

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

    // ------------------------------------------------------------------ delivery

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

    function test_firstDeliveryTimestampIsWrittenOnce() public {
        _deliver(1);
        uint64 first = book.firstDeliveryAtOf(AGENT, SERVICE, USDC);
        vm.warp(block.timestamp + 1 hours);
        _deliver(1);
        assertEq(book.firstDeliveryAtOf(AGENT, SERVICE, USDC), first, "unchanged by a later delivery");
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).oldestUnsettledAt, first, "window unmoved");
    }

    function test_deliveryRejectsStrangerAndZeroUnits() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.NotServiceOperator.selector, SERVICE, STRANGER));
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, 1, PRICE, _witness(USDC));
        vm.prank(OPERATOR);
        vm.expectRevert(ITabBook.ZeroUnits.selector);
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, 0, PRICE, _witness(USDC));
    }

    function test_priceListChangedMidCallRejectsAStaleQuote() public {
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITabBook.PriceListChangedMidCall.selector, SERVICE, USDC, TOOL, PRICE - 1, PRICE
            )
        );
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, 1, PRICE - 1, _witness(USDC));
    }

    function test_quoteFollowsTheAppliedPriceAcrossTheTimelock() public {
        uint256 newPrice = PRICE * 2;
        vm.prank(OPERATOR);
        (bytes32 changeId,) =
            registry.queueChange(SERVICE, IServiceRegistry.ChangeKind.Price, abi.encode(USDC, TOOL, newPrice));
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

    function test_unpricedToolCannotBeMetered() public {
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(IServiceRegistry.UnknownTool.selector, SERVICE, USDC, UNKNOWN_TOOL)
        );
        book.recordDelivery(AGENT, SERVICE, USDC, UNKNOWN_TOOL, 1, PRICE, _witness(USDC));
    }

    // ------------------------------------------------------------------ credit limit

    function test_baselineLimitAndHeadroom() public {
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), BASELINE, "bond-capped baseline");
        assertEq(book.headroom(AGENT, USDC, _witness(USDC)), BASELINE, "full headroom");
        _deliver(1_000);
        assertEq(book.headroom(AGENT, USDC, _witness(USDC)), BASELINE - 1_000 * PRICE, "headroom used");
    }

    function test_deliveryAtHeadroomLandsAndOneUnitAboveReverts() public {
        uint32 exact = uint32(BASELINE / PRICE);
        (uint256 charged,, uint256 headroomAfter) = _deliverExpectingSuccess(exact);
        assertEq(charged, BASELINE, "charged the whole limit");
        assertEq(headroomAfter, 0, "no headroom left");
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.LimitExceeded.selector, AGENT, USDC, PRICE, 0));
        book.recordDelivery(AGENT, SERVICE, USDC, TOOL, 1, PRICE, _witness(USDC));
    }

    function test_witnessTamperingIsRefused() public {
        _deliver(1);
        _settle(USDC, 500);
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
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), BASELINE, "honest witness accepted");
        assertTrue(storedRoot != bytes32(0), "commitment advanced");
    }

    function test_witnessBondAmountsAreIgnored() public {
        ITabBook.LimitWitness memory inflated = _witness(USDC);
        inflated.bonds[0].amount = type(uint128).max;
        assertEq(book.creditLimit(AGENT, USDC, inflated), BASELINE, "cap taken from the ledger");
        Bond emptyBond = new Bond();
        TabBook poor = new TabBook(address(this), address(registry), address(emptyBond), BASELINE, GROWTH_BPS);
        vm.prank(AGENT);
        poor.authorise(SERVICE, USDC, AUTH_MAX, uint64(block.timestamp) + 1 days);
        assertEq(poor.creditLimit(AGENT, USDC, _witness(USDC)), 0, "no stake, no credit");
    }

    function test_withdrawnStakeNoLongerBacksCredit() public {
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), BASELINE, "backed while staked");
        vm.prank(OPERATOR);
        bond.withdraw(USDC, BOND_STAKE);
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), 0, "nothing at risk, no credit");
        assertEq(usdc.balanceOf(OPERATOR), BOND_STAKE, "stake really left the escrow");
    }

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

    function test_counterpartyProvenByHistoryAloneIsEligible() public {
        _registerService(SERVICE_TWO, OPERATOR_TWO, COLLECTION_THREE, COLLECTION_FOUR);
        _curate(SERVICE_TWO);
        _fundBond(OPERATOR_TWO, USDC, BOND_STAKE);
        assertFalse(book.authorisationOf(AGENT, SERVICE_TWO, USDC).exists, "no authorisation granted");
        _settleFull(SERVICE_TWO, USDC, 1_000);
        _counterparties.push(SERVICE_TWO);
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), BASELINE, "history-proven counterparty");
    }

    function test_outOfScopeBondEntryIsFilteredRatherThanRejected() public view {
        ITabBook.LimitWitness memory witness = _witnessFor(USDC, USDT);
        assertEq(book.creditLimit(AGENT, USDC, witness), 0, "no in-scope bond, no credit");
    }

    function test_readsRequireNoSignature() public {
        _deliver(2);
        bytes32 settlementId = _settle(USDC, 1_000);
        vm.startPrank(address(0));
        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        assertEq(book.tabOf(tabId).open, 2 * PRICE - 1_000, "tab readable");
        assertEq(book.assetOpen(AGENT, USDC), 2 * PRICE - 1_000, "aggregate readable");
        (, uint32 count) = book.historyCommitment(AGENT, USDC);
        assertEq(count, 1, "commitment readable");
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), BASELINE, "limit readable");
        assertEq(book.headroom(AGENT, USDC, _witness(USDC)), BASELINE - (2 * PRICE - 1_000), "headroom");
        assertEq(book.settlementOf(settlementId).applied, 1_000, "settlement readable");
        assertEq(book.delinquentTabCount(AGENT, USDC), 0, "delinquency readable");
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ settlement

    function test_settlementReducesTheTabAndRestoresHeadroom() public {
        _deliver(1_000);
        uint256 openBefore = book.assetOpen(AGENT, USDC);
        _fundAndApprove(SERVICE, USDC, 400_000);
        vm.expectEmit(false, true, true, true, address(book));
        emit ITabBook.SettlementApplied(
            bytes32(0), AGENT, SERVICE, USDC, 400_000, 0, uint128(openBefore - 400_000)
        );
        _settleFunded(SERVICE, USDC, 400_000);
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, openBefore - 400_000, "tab reduced");
        assertEq(book.assetOpen(AGENT, USDC), openBefore - 400_000, "aggregate reduced");
        assertEq(
            book.headroom(AGENT, USDC, _witness(USDC)), BASELINE - (openBefore - 400_000), "headroom back"
        );
    }

    function test_settlementMovesTheAssetToTheServiceCollection() public {
        _deliver(10);
        assertEq(usdc.balanceOf(COLLECTION), 0, "nothing collected yet");
        _settle(USDC, uint128(4 * PRICE));
        assertEq(usdc.balanceOf(COLLECTION), 4 * PRICE, "the Service was paid at its Collection address");
        assertEq(usdc.balanceOf(AGENT), 0, "the Agent paid exactly the amount");
        assertEq(usdc.balanceOf(address(settlement)), 0, "the surface holds nothing");
        assertEq(usdc.balanceOf(address(book)), 0, "the book holds nothing");
    }

    function test_settlementIsRecordedUnderAFreshIdentity() public {
        _deliver(10);
        bytes32 first = _settle(USDC, 1_000);
        bytes32 second = _settle(USDC, 1_000);
        assertTrue(first != second, "each settlement has its own identity");
        assertEq(book.settlementCount(), 2, "two settlements counted");
        ITabBook.Settlement memory s = book.settlementOf(second);
        assertEq(s.agent, AGENT, "agent recorded");
        assertEq(s.serviceId, SERVICE, "service recorded");
        assertEq(s.asset, USDC, "asset recorded");
        assertEq(s.amount, 1_000, "amount recorded");
        assertEq(s.applied, 1_000, "applied recorded");
        assertEq(s.settledAt, uint64(block.timestamp), "time recorded");
    }

    function test_excessSettlementBecomesPrepaidCredit() public {
        _deliver(1);
        _settle(USDC, uint128(PRICE + 777));
        ITabBook.Tab memory tab = book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC));
        assertEq(tab.open, 0, "tab settled to zero");
        assertEq(tab.prepaid, 777, "excess banked as prepaid credit");
        assertEq(tab.oldestUnsettledAt, 0, "window clock cleared");
        assertEq(book.assetOpen(AGENT, USDC), 0, "aggregate zeroed");
        assertEq(usdc.balanceOf(COLLECTION), PRICE + 777, "the Service received the whole payment");
    }

    function test_settlementWithNoOpenTabIsAllPrepaid() public {
        _settle(USDC, 5_000);
        ITabBook.Tab memory tab = book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC));
        assertEq(tab.open, 0, "nothing to reduce");
        assertEq(tab.prepaid, 5_000, "all prepaid");
    }

    function test_historyCommitmentAdvancesOncePerSettlement() public {
        _deliver(1);
        (bytes32 rootBefore, uint32 countBefore) = book.historyCommitment(AGENT, USDC);
        assertEq(rootBefore, bytes32(0), "no history yet");
        assertEq(countBefore, 0, "no records yet");
        _settle(USDC, 100);
        (bytes32 rootOne, uint32 countOne) = book.historyCommitment(AGENT, USDC);
        assertEq(countOne, 1, "one record");
        assertTrue(rootOne != bytes32(0), "root advanced");
        _settle(USDC, 100);
        (bytes32 rootTwo, uint32 countTwo) = book.historyCommitment(AGENT, USDC);
        assertEq(countTwo, 2, "two records");
        assertTrue(rootTwo != rootOne, "root advanced again");
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), BASELINE, "witness accepted");
    }

    function test_onlyTheWiredSurfaceMayApplyASettlement() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.NotSettlementSurface.selector, STRANGER));
        book.applySettlement(AGENT, SERVICE, USDC, 1);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.NotSettlementSurface.selector, OPERATOR));
        book.applySettlement(AGENT, SERVICE, USDC, 1);
    }

    function test_settlementGuards() public {
        vm.prank(address(settlement));
        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        book.applySettlement(address(0), SERVICE, USDC, 1);
        vm.prank(address(settlement));
        vm.expectRevert(ITabBook.ZeroAddressField.selector);
        book.applySettlement(AGENT, SERVICE, address(0), 1);
        vm.prank(address(settlement));
        vm.expectRevert(ITabBook.ZeroAmount.selector);
        book.applySettlement(AGENT, SERVICE, USDC, 0);
    }

    function test_settlementRefusesAnUnacceptedAssetBeforeMovingAnything() public {
        MockUsdc other = new MockUsdc();
        other.mint(AGENT, 1_000);
        vm.startPrank(AGENT);
        other.approve(address(settlement), 1_000);
        vm.expectRevert(
            abi.encodeWithSelector(IServiceRegistry.AssetNotAccepted.selector, SERVICE, address(other))
        );
        settlement.settle(SERVICE, address(other), 1_000);
        vm.stopPrank();
        assertEq(other.balanceOf(AGENT), 1_000, "nothing moved");
        assertEq(book.settlementCount(), 0, "nothing recorded");
    }

    function test_aFailedTransferUnwindsTheLedgerEntry() public {
        _deliver(10);
        vm.startPrank(AGENT);
        usdc.approve(address(settlement), 5_000);
        vm.expectRevert();
        settlement.settle(SERVICE, USDC, 5_000);
        vm.stopPrank();
        assertEq(book.tabOf(book.tabIdOf(AGENT, SERVICE, USDC)).open, 10 * PRICE, "tab untouched");
        assertEq(book.settlementCount(), 0, "no settlement recorded");
        (, uint32 count) = book.historyCommitment(AGENT, USDC);
        assertEq(count, 0, "history untouched");
    }

    function test_batchSettlementPaysSeveralTabsAtOnce() public {
        _deliverAs(OPERATOR, SERVICE, USDC, 3, PRICE);
        _deliverAs(OPERATOR, SERVICE, USDT, 2, PRICE_TWO);
        _mirrorAppend(SERVICE, USDC, uint128(3 * PRICE));
        _mirrorAppend(SERVICE, USDT, uint128(2 * PRICE_TWO));
        usdc.mint(AGENT, 3 * PRICE);
        usdt.mint(AGENT, 2 * PRICE_TWO);
        TabSettlement.Instruction[] memory batch = new TabSettlement.Instruction[](2);
        batch[0] = TabSettlement.Instruction({serviceId: SERVICE, asset: USDC, amount: uint128(3 * PRICE)});
        batch[1] =
            TabSettlement.Instruction({serviceId: SERVICE, asset: USDT, amount: uint128(2 * PRICE_TWO)});
        vm.startPrank(AGENT);
        usdc.approve(address(settlement), 3 * PRICE);
        usdt.approve(address(settlement), 2 * PRICE_TWO);
        bytes32[] memory ids = settlement.settleBatch(batch);
        vm.stopPrank();
        assertEq(ids.length, 2, "two identities");
        assertTrue(ids[0] != ids[1], "distinct");
        assertEq(book.assetOpen(AGENT, USDC), 0, "first tab closed");
        assertEq(book.assetOpen(AGENT, USDT), 0, "second tab closed");
        assertEq(usdc.balanceOf(COLLECTION), 3 * PRICE, "first Collection paid");
        assertEq(usdt.balanceOf(COLLECTION_TWO), 2 * PRICE_TWO, "second Collection paid");
        TabSettlement.Instruction[] memory empty = new TabSettlement.Instruction[](0);
        vm.expectRevert(TabSettlement.EmptyBatch.selector);
        settlement.settleBatch(empty);
    }

    // ------------------------------------------------------------------ delinquency

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

    function test_delinquencyClearsWhenTheTabSettlesToZero() public {
        _deliver(1_000);
        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        vm.warp(book.tabOf(tabId).oldestUnsettledAt + WINDOW);
        book.markDelinquent(tabId);
        _settle(USDC, 400_000);
        assertTrue(book.tabOf(tabId).delinquent, "still delinquent while open");
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), 0, "still suppressed");
        _fundAndApprove(SERVICE, USDC, 600_000);
        vm.expectEmit(true, true, true, true, address(book));
        emit ITabBook.TabDelinquencyCleared(tabId, AGENT, USDC);
        _settleFunded(SERVICE, USDC, 600_000);
        assertFalse(book.tabOf(tabId).delinquent, "flag lifted");
        assertEq(book.delinquentTabCount(AGENT, USDC), 0, "count back to zero");
        assertEq(book.creditLimit(AGENT, USDC, _witness(USDC)), BASELINE, "credit restored");
    }

    function test_delinquencyCrankGuards() public {
        bytes32 unknown = book.tabIdOf(OTHER_AGENT, SERVICE, USDC);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.UnknownTab.selector, unknown));
        book.markDelinquent(unknown);
        _deliver(1);
        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        _settle(USDC, uint128(PRICE));
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.NothingUnsettled.selector, tabId));
        book.markDelinquent(tabId);
        _deliver(1);
        vm.warp(block.timestamp + WINDOW);
        book.markDelinquent(tabId);
        vm.expectRevert(abi.encodeWithSelector(ITabBook.AlreadyDelinquent.selector, tabId));
        book.markDelinquent(tabId);
    }

    function test_delinquencyCrankIsPermissionless() public {
        _deliver(1_000);
        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        vm.warp(book.tabOf(tabId).oldestUnsettledAt + WINDOW);
        vm.prank(STRANGER);
        book.markDelinquent(tabId);
        assertTrue(book.tabOf(tabId).delinquent, "a stranger cranked it");
    }

    // ------------------------------------------------------------------ prepaid credit

    function test_aDeliveryWithinPrepaidCreditBorrowsNothing() public {
        _settle(USDC, 50_000);
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

    function test_aDeliveryBeyondPrepaidCreditBorrowsOnlyTheShortfall() public {
        _settle(USDC, 2_500);
        bytes32 tabId = book.tabIdOf(AGENT, SERVICE, USDC);
        assertEq(book.tabOf(tabId).prepaid, 2_500, "banked");
        uint256 charged = _deliver(4);
        assertEq(charged, 4 * PRICE, "the full charge is reported");
        assertEq(book.tabOf(tabId).prepaid, 0, "prepaid credit is drained first");
        assertEq(book.tabOf(tabId).open, 4 * PRICE - 2_500, "only the shortfall is borrowed");
        assertEq(book.assetOpen(AGENT, USDC), 4 * PRICE - 2_500, "aggregate agrees with the tab");
        assertTrue(book.tabOf(tabId).oldestUnsettledAt != 0, "a partly borrowed delivery starts the window");
    }

    function test_spendingPrepaidCreditConsumesNoHeadroom() public {
        _settle(USDC, 40_000);
        (,, uint256 headroomBefore) = _deliverExpectingSuccess(1);
        (,, uint256 headroomAfter) = _deliverExpectingSuccess(1);
        assertEq(headroomAfter, headroomBefore, "headroom did not move while prepaid credit paid");
        assertEq(book.assetOpen(AGENT, USDC), 0, "nothing was borrowed");
    }

    // ------------------------------------------------------------------ per-asset isolation

    function test_perAssetIsolation() public {
        _deliver(1_000);
        _settle(USDC, 400_000);
        AssetSnapshot memory before = _snapshot(USDC);
        _runFullRoundInSecondAsset();
        bytes32 tabUsdt = book.tabIdOf(AGENT, SERVICE, USDT);
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

    function test_recordsFilteredOutOnAssetLeaveTheLaunchLimitAlone() public {
        _buildThreeCounterpartyLaunchHistory();
        AssetSnapshot memory before = _snapshot(USDC);
        uint256[3] memory secondCounterparty = _ledgerFigures(OPERATOR_TWO, USDC);
        uint256[3] memory thirdCounterparty = _ledgerFigures(OPERATOR_THREE, USDC);
        assertEq(before.limit, ISOLATION_LIMIT, "launch limit is growth-derived and uncapped");
        _settleThreeCounterpartiesInSecondAsset();
        assertEq(book.creditLimit(AGENT, USDT, _witness(USDT)), ISOLATION_LIMIT, "second Asset earns it");
        _assertSnapshotUnchanged(before, _snapshot(USDC));
        _assertFiguresEqual(secondCounterparty, _ledgerFigures(OPERATOR_TWO, USDC), "second counterparty");
        _assertFiguresEqual(thirdCounterparty, _ledgerFigures(OPERATOR_THREE, USDC), "third counterparty");
        _settleFull(SERVICE, USDC, ISOLATION_AMOUNT);
        assertEq(
            book.creditLimit(AGENT, USDC, _witness(USDC)),
            ISOLATION_LIMIT + ISOLATION_CONTRIBUTION,
            "the same record in the launch Asset does move the limit"
        );
    }

    uint128 internal constant ISOLATION_AMOUNT = 8_000_000;
    uint256 internal constant ISOLATION_CONTRIBUTION = 1_000_000;
    uint256 internal constant ISOLATION_LIMIT = BASELINE + 3 * ISOLATION_CONTRIBUTION;

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
        _settleFull(SERVICE, USDC, ISOLATION_AMOUNT);
        _settleFull(SERVICE_TWO, USDC, ISOLATION_AMOUNT);
        _settleFull(SERVICE_THREE, USDC, ISOLATION_AMOUNT);
    }

    function _settleThreeCounterpartiesInSecondAsset() internal {
        _settleFull(SERVICE, USDT, ISOLATION_AMOUNT);
        _settleFull(SERVICE_TWO, USDT, ISOLATION_AMOUNT);
        _settleFull(SERVICE_THREE, USDT, ISOLATION_AMOUNT);
    }

    function _crankAssertingOneEventAndNoBondMovement(bytes32 tabId) internal {
        uint256[3] memory launchBefore = _ledgerFigures(OPERATOR, USDC);
        uint256[3] memory secondBefore = _ledgerFigures(OPERATOR, USDT);
        uint256[3] memory shortLaunchBefore = _ledgerFigures(OPERATOR_SHORT, USDC);
        uint256[3] memory shortSecondBefore = _ledgerFigures(OPERATOR_SHORT, USDT);
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
    }

    struct AssetSnapshot {
        uint128 open;
        uint128 prepaid;
        uint32 deliveryCount;
        bool delinquent;
        uint256 aggregate;
        bytes32 root;
        uint32 count;
        uint256 limit;
        uint32 delinquentTabs;
        uint256[3] bondFigures;
    }

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

    function _runFullRoundInSecondAsset() internal {
        _deliverAs(OPERATOR, SERVICE, USDT, 1, PRICE_TWO);
        _settleFull(SERVICE, USDT, uint128(PRICE_TWO + 9));
        _deliverAs(OPERATOR, SERVICE, USDT, 5, PRICE_TWO);
        bytes32 tabUsdt = book.tabIdOf(AGENT, SERVICE, USDT);
        vm.warp(book.tabOf(tabUsdt).oldestUnsettledAt + WINDOW);
        book.markDelinquent(tabUsdt);
    }
}
