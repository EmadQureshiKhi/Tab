// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/01_Deploy.s.sol";
import {VerifyDeployment} from "../script/02_VerifyDeployment.s.sol";
import {RegisterIdentity} from "../script/03_RegisterIdentity.s.sol";
import {RegisterDemoService} from "../script/04_RegisterDemoService.s.sol";
import {DeployCuration} from "../script/00_DeployCuration.s.sol";
import {PriceFrontedTools} from "../script/05_PriceFrontedTools.s.sol";
import {DeploymentBase} from "../script/DeploymentBase.sol";
import {Bond} from "../src/Bond.sol";
import {LimitLib} from "../src/LimitLib.sol";
import {CurationMultisig} from "../src/CurationMultisig.sol";
import {IServiceRegistry, ServiceRegistry} from "../src/ServiceRegistry.sol";
import {ITabBook, TabBook} from "../src/TabBook.sol";
import {TabSettlement} from "../src/TabSettlement.sol";
import {MockUsdc} from "../src/test/MockUsdc.sol";
import {MockIdentityRegistry} from "./helpers/MockIdentityRegistry.sol";
import {Permit2Code} from "./helpers/Permit2Code.sol";

/// @dev Runs the deployment scripts' own code paths, so what is tested is what gets broadcast.
///
/// Every `run()` entry point reads the environment, and `vm.setEnv` is process-wide while forge runs
/// test functions in parallel. So every exercise of a `run()` lives in the one sequential test at the
/// bottom, and everything else goes through the scripts' public functions, which take their inputs as
/// arguments and touch no environment.
contract DeploymentScriptsTest is Test {
    uint256 internal constant BASELINE = 5_000_000;
    uint256 internal constant GROWTH_BPS = 5_000;
    bytes32 internal constant DEMO_SERVICE = bytes32("tab.demo");
    bytes32 internal constant DEMO_TOOL = bytes32("quote.generate");
    string internal constant SERVICE_URI = "https://tab.example/service.json";
    string internal constant AGENT_URI = "https://tab.example/agent.json";
    address internal curation = makeAddr("curation");
    address internal agent = makeAddr("agent");
    address internal operator = makeAddr("operator");
    address internal permit2;

    function setUp() public {
        permit2 = Permit2Code.etch(vm);
    }

    function _deploy(Deploy script, address curationAuthority)
        internal
        returns (DeploymentBase.Deployment memory)
    {
        return script.deploy(address(script), curationAuthority, BASELINE, GROWTH_BPS, permit2);
    }

    // ------------------------------------------------------------------ 01 and 02

    function test_deployWiresEverySlotAndVerifyAgrees() public {
        Deploy script = new Deploy();
        DeploymentBase.Deployment memory d = _deploy(script, curation);

        TabBook book = TabBook(d.tabBook);
        assertEq(book.settlementSurface(), d.tabSettlement, "surface wired");
        assertEq(address(book.REGISTRY()), d.serviceRegistry, "registry wired");
        assertEq(address(book.BOND()), d.bond, "bond wired");
        assertEq(book.BASELINE(), BASELINE, "baseline");
        assertEq(book.GROWTH_FACTOR_BPS(), GROWTH_BPS, "growth");
        assertEq(book.WIRING_AUTHORITY(), address(script), "the script was the wiring authority");
        assertEq(ServiceRegistry(d.serviceRegistry).curationAuthority(), curation, "curation authority");
        assertEq(address(TabSettlement(d.tabSettlement).BOOK()), d.tabBook, "surface knows the book");
        assertEq(
            address(TabSettlement(d.tabSettlement).REGISTRY()), d.serviceRegistry, "surface knows registry"
        );
        assertEq(address(TabSettlement(d.tabSettlement).PERMIT2()), permit2, "surface knows Permit2");
        assertEq(d.permit2, permit2, "Permit2 recorded");

        VerifyDeployment verifier = new VerifyDeployment();
        assertTrue(verifier.verify(d), "verification passes on an honest deployment");

        // The one-shot authority is spent: nobody, including the script, can rewire.
        vm.prank(address(script));
        vm.expectRevert(abi.encodeWithSelector(ITabBook.AlreadyWired.selector, d.tabSettlement));
        book.setSettlementSurface(address(0xBEEF));
    }

    function test_verifyRejectsAMismatchedSlot() public {
        Deploy script = new Deploy();
        DeploymentBase.Deployment memory d = _deploy(script, curation);
        address impostor = address(new TabSettlement(d.serviceRegistry, d.tabBook, permit2));
        DeploymentBase.Deployment memory lying = DeploymentBase.Deployment({
            serviceRegistry: d.serviceRegistry,
            bond: d.bond,
            tabBook: d.tabBook,
            tabSettlement: impostor,
            permit2: permit2
        });
        VerifyDeployment verifier = new VerifyDeployment();
        vm.expectRevert(
            abi.encodeWithSelector(
                VerifyDeployment.SlotMismatch.selector, "TabBook.settlementSurface", impostor, d.tabSettlement
            )
        );
        verifier.verify(lying);
    }

    function test_verifyRejectsTheWrongPermit2() public {
        Deploy script = new Deploy();
        DeploymentBase.Deployment memory d = _deploy(script, curation);
        DeploymentBase.Deployment memory lying = DeploymentBase.Deployment({
            serviceRegistry: d.serviceRegistry,
            bond: d.bond,
            tabBook: d.tabBook,
            tabSettlement: d.tabSettlement,
            permit2: address(0xBEEF)
        });
        VerifyDeployment verifier = new VerifyDeployment();
        vm.expectRevert(
            abi.encodeWithSelector(
                VerifyDeployment.SlotMismatch.selector, "TabSettlement.PERMIT2", address(0xBEEF), permit2
            )
        );
        verifier.verify(lying);
    }

    /// @dev The whole product on a fresh deployment: a curated, bonded Service meters a delivery,
    /// the Agent settles through the surface, and the Service is paid.
    function test_endToEndOnAFreshDeployment() public {
        Deploy script = new Deploy();
        DeploymentBase.Deployment memory d = _deploy(script, curation);
        ServiceRegistry registry = ServiceRegistry(d.serviceRegistry);
        Bond bond = Bond(d.bond);
        TabBook book = TabBook(d.tabBook);
        TabSettlement settlement = TabSettlement(d.tabSettlement);
        MockUsdc usdc = new MockUsdc();

        bytes32 tool = bytes32("echo");
        address[] memory assets = new address[](1);
        assets[0] = address(usdc);
        address[] memory collections = new address[](1);
        collections[0] = operator;
        bytes32[] memory tools = new bytes32[](1);
        tools[0] = tool;
        uint256[] memory prices = new uint256[](1);
        prices[0] = 1_000;
        vm.prank(operator);
        registry.registerService(DEMO_SERVICE, assets, collections, tools, prices, 1 hours);

        vm.prank(curation);
        (bytes32 changeId,) = registry.queueChange(
            DEMO_SERVICE, IServiceRegistry.ChangeKind.Tier, abi.encode(uint256(IServiceRegistry.Tier.Curated))
        );
        vm.warp(block.timestamp + 48 hours);
        vm.prank(curation);
        registry.applyChange(changeId);

        usdc.mint(operator, 10_000_000);
        vm.startPrank(operator);
        usdc.approve(address(bond), 10_000_000);
        bond.deposit(address(usdc), 10_000_000);
        vm.stopPrank();

        vm.prank(agent);
        book.authorise(DEMO_SERVICE, address(usdc), 1_000_000, uint64(block.timestamp) + 1 days);
        // A fresh Agent has no history; the witness names its one counterparty so the bond cap applies.
        ITabBook.LimitWitness memory witness;
        witness.bonds = new LimitLib.BondEntry[](1);
        witness.bonds[0] = LimitLib.BondEntry({serviceId: DEMO_SERVICE, asset: address(usdc), amount: 0});
        vm.prank(operator);
        (uint256 charged, uint128 openAfter,) =
            book.recordDelivery(agent, DEMO_SERVICE, address(usdc), tool, 3, 1_000, witness);
        assertEq(charged, 3_000, "three units metered on credit");
        assertEq(openAfter, 3_000, "tab open");

        usdc.mint(agent, 3_000);
        vm.startPrank(agent);
        usdc.approve(address(settlement), 3_000);
        (, uint128 applied,) = settlement.settle(DEMO_SERVICE, address(usdc), 3_000);
        vm.stopPrank();
        assertEq(applied, 3_000, "tab paid down");
        assertEq(usdc.balanceOf(operator), 3_000, "the Service received the money");
        assertEq(book.assetOpen(agent, address(usdc)), 0, "nothing owed");
        (, uint32 count) = book.historyCommitment(agent, address(usdc));
        assertEq(count, 1, "one settlement in the history");
    }

    function test_curationMultisigCanBeTheCurationAuthority() public {
        address[] memory owners = new address[](2);
        owners[0] = makeAddr("ownerOne");
        owners[1] = makeAddr("ownerTwo");
        CurationMultisig multisig = new CurationMultisig(owners, 2);
        Deploy script = new Deploy();
        DeploymentBase.Deployment memory d = _deploy(script, address(multisig));
        assertEq(
            ServiceRegistry(d.serviceRegistry).curationAuthority(), address(multisig), "multisig curates"
        );
    }

    // ------------------------------------------------------------------ 03

    function test_ensureMintsWhenNothingIsRecordedAndKeepsARecordedIdentity() public {
        MockIdentityRegistry identity = new MockIdentityRegistry();
        // Somebody else registered first, so the demo id is not zero.
        vm.prank(makeAddr("somebody"));
        identity.register("https://elsewhere.example/agent.json");
        RegisterIdentity script = new RegisterIdentity();
        address owner = address(script);

        RegisterIdentity.Outcome memory outcome =
            script.ensure(identity, owner, "ERC8004_AGENT_ID", false, 0, AGENT_URI);
        assertTrue(outcome.minted, "minted");
        assertEq(outcome.agentId, 1, "took the next id");
        assertEq(identity.ownerOf(1), owner, "owned by the registrant");
        assertEq(identity.getAgentWallet(1), owner, "the wallet is the registrant");
        assertEq(identity.tokenURI(1), AGENT_URI, "URI set");

        // Recorded and owned: kept, nothing minted.
        outcome = script.ensure(identity, owner, "ERC8004_AGENT_ID", true, 1, AGENT_URI);
        assertFalse(outcome.minted, "nothing minted");
        assertFalse(outcome.uriUpdated, "nothing rewritten");
        assertEq(outcome.agentId, 1, "id kept");
        assertEq(identity.balanceOf(owner), 1, "still one identity");

        // Recorded with a changed URI: brought up to date in place.
        outcome =
            script.ensure(identity, owner, "ERC8004_AGENT_ID", true, 1, "https://tab.example/agent-v2.json");
        assertFalse(outcome.minted, "still nothing minted");
        assertTrue(outcome.uriUpdated, "URI rewritten");
        assertEq(identity.tokenURI(1), "https://tab.example/agent-v2.json", "new URI");
        assertEq(identity.balanceOf(owner), 1, "still one identity");
    }

    function test_ensureRefusesARecordedIdTheOwnerDoesNotHold() public {
        MockIdentityRegistry identity = new MockIdentityRegistry();
        address somebody = makeAddr("somebody");
        vm.prank(somebody);
        identity.register("https://elsewhere.example/agent.json");
        RegisterIdentity script = new RegisterIdentity();
        address owner = address(script);

        vm.expectRevert(
            abi.encodeWithSelector(
                RegisterIdentity.RecordedIdentityNotOwned.selector,
                "ERC8004_SERVICE_AGENT_ID",
                0,
                owner,
                somebody
            )
        );
        script.ensure(identity, owner, "ERC8004_SERVICE_AGENT_ID", true, 0, SERVICE_URI);
        // An id nobody holds reads the same way.
        vm.expectRevert(
            abi.encodeWithSelector(
                RegisterIdentity.RecordedIdentityNotOwned.selector, "ERC8004_AGENT_ID", 99, owner, address(0)
            )
        );
        script.ensure(identity, owner, "ERC8004_AGENT_ID", true, 99, AGENT_URI);
        assertEq(identity.balanceOf(owner), 0, "nothing minted over a stale record");
    }

    // ------------------------------------------------------------------ 04

    function _assets(address first, address second) internal pure returns (address[] memory assets) {
        assets = new address[](2);
        assets[0] = first;
        assets[1] = second;
    }

    function test_registerAndFundDoTheirWorkOnceAndThenLeaveThingsAlone() public {
        Deploy deployScript = new Deploy();
        DeploymentBase.Deployment memory d = _deploy(deployScript, curation);
        ServiceRegistry registry = ServiceRegistry(d.serviceRegistry);
        Bond bond = Bond(d.bond);
        MockUsdc usdc = new MockUsdc();
        MockUsdc mockUsdc = new MockUsdc();
        RegisterDemoService script = new RegisterDemoService();
        // Called directly, the script contract is the account acting, so it is the operator too.
        address self = address(script);
        address[] memory assets = _assets(address(usdc), address(mockUsdc));

        assertTrue(
            script.register(registry, DEMO_SERVICE, assets, self, DEMO_TOOL, 10_000, 21_600),
            "registered on the first call"
        );
        IServiceRegistry.Service memory service = registry.serviceOf(DEMO_SERVICE);
        assertEq(service.operator, self, "operator");
        assertEq(service.bondAccount, self, "bond account");
        assertEq(service.settlementWindow, 21_600, "window");
        assertEq(
            uint256(service.tier), uint256(IServiceRegistry.Tier.Permissionless), "starts permissionless"
        );
        assertEq(registry.collectionOf(DEMO_SERVICE, address(usdc)), self, "USDC collection");
        assertEq(registry.collectionOf(DEMO_SERVICE, address(mockUsdc)), self, "test token collection");
        assertEq(registry.priceOf(DEMO_SERVICE, address(usdc), DEMO_TOOL), 10_000, "USDC price");
        assertEq(registry.priceOf(DEMO_SERVICE, address(mockUsdc), DEMO_TOOL), 10_000, "test token price");

        assertTrue(script.fund(bond, mockUsdc, self), "bonded on the first call");
        assertEq(bond.freeOf(bond.partyOf(self), address(mockUsdc)), script.DEMO_BOND_BASE_UNITS(), "staked");
        assertEq(mockUsdc.balanceOf(d.bond), script.DEMO_BOND_BASE_UNITS(), "held by the escrow");
        assertEq(mockUsdc.balanceOf(self), 0, "all of the mint was staked");
        assertEq(bond.freeOf(bond.partyOf(self), address(usdc)), 0, "nothing staked in USDC");

        // Again: nothing changes.
        assertFalse(
            script.register(registry, DEMO_SERVICE, assets, self, DEMO_TOOL, 10_000, 21_600),
            "not registered twice"
        );
        assertFalse(script.fund(bond, mockUsdc, self), "not bonded twice");
        assertEq(registry.serviceCount(), 1, "one Service");
        assertEq(
            bond.freeOf(bond.partyOf(self), address(mockUsdc)), script.DEMO_BOND_BASE_UNITS(), "unchanged"
        );
        assertEq(mockUsdc.balanceOf(self), 0, "nothing minted again");
    }

    function test_theCurationMultisigIsDeployedOverItsOwnersAndRefusesABadThreshold() public {
        DeployCuration script = new DeployCuration();
        address[] memory owners = new address[](3);
        owners[0] = address(0xA11CE);
        owners[1] = address(0xB0B);
        owners[2] = address(0xCA401);

        address deployed = script.deploy(owners, 2);
        CurationMultisig multisig = CurationMultisig(payable(deployed));
        assertEq(multisig.THRESHOLD(), 2, "threshold");
        assertEq(multisig.owners().length, 3, "owner count");
        for (uint256 i = 0; i < owners.length; ++i) {
            assertTrue(multisig.isOwner(owners[i]), "owner");
        }
        assertFalse(multisig.isOwner(address(0xDEAD)), "a stranger is not an owner");

        // The constructor is what refuses, and the script does not paper over it:
        // a threshold nobody could ever meet must not reach a chain.
        vm.expectRevert(abi.encodeWithSelector(CurationMultisig.InvalidThreshold.selector, 4, 3));
        script.deploy(owners, 4);
        vm.expectRevert(abi.encodeWithSelector(CurationMultisig.InvalidThreshold.selector, 0, 3));
        script.deploy(owners, 0);
    }

    function test_frontedToolsArePricedOnceAndTheHoldIsRespected() public {
        Deploy deployScript = new Deploy();
        DeploymentBase.Deployment memory d = _deploy(deployScript, curation);
        ServiceRegistry registry = ServiceRegistry(d.serviceRegistry);
        MockUsdc mockUsdc = new MockUsdc();
        PriceFrontedTools script = new PriceFrontedTools();
        address[] memory assets = new address[](1);
        assets[0] = address(mockUsdc);

        // The script must be the Service's operator, because the registry lets
        // nobody else queue a Price change for it, and a prank on the test does
        // not reach a call the script makes on its own behalf.
        address[] memory collections = new address[](1);
        collections[0] = address(script);
        uint256[] memory prices = new uint256[](1);
        prices[0] = 10_000;
        bytes32[] memory registered = new bytes32[](1);
        registered[0] = DEMO_TOOL;
        vm.prank(address(script));
        registry.registerService(DEMO_SERVICE, assets, collections, registered, prices, 21_600);

        bytes32[] memory tools = new bytes32[](2);
        tools[0] = bytes32("apihub.run");
        tools[1] = bytes32("nansen.query");

        PriceFrontedTools.Queued memory queued = script.queue(registry, DEMO_SERVICE, assets, tools, 1);
        assertEq(queued.changeIds.length, 2, "one change per fronted tool");
        assertEq(queued.alreadyPriced, 0, "neither was priced");

        // Before the hold passes nothing is applied, and no price exists yet.
        assertEq(script.applyAll(registry, queued.changeIds), 0, "the timelock holds");
        vm.expectRevert(
            abi.encodeWithSelector(
                IServiceRegistry.UnknownTool.selector, DEMO_SERVICE, address(mockUsdc), tools[0]
            )
        );
        registry.priceOf(DEMO_SERVICE, address(mockUsdc), tools[0]);

        vm.warp(block.timestamp + registry.timelock() + 1);
        assertEq(script.applyAll(registry, queued.changeIds), 2, "both applied once the hold passed");
        assertEq(registry.priceOf(DEMO_SERVICE, address(mockUsdc), tools[0]), 1, "one base unit a unit");
        assertEq(registry.priceOf(DEMO_SERVICE, address(mockUsdc), tools[1]), 1, "and the other");

        // Again: both are already at the intended price, so nothing is queued.
        PriceFrontedTools.Queued memory second = script.queue(registry, DEMO_SERVICE, assets, tools, 1);
        assertEq(second.changeIds.length, 0, "nothing queued twice");
        assertEq(second.alreadyPriced, 2, "both counted as already priced");
    }

    // ------------------------------------------------------------------ run() entry points

    /// @dev One sequential pass over every environment-reading entry point. See the contract note.
    function test_runEntryPointsReadTheEnvironment() public {
        _runDeploy();
        _runRegisterIdentity();
        _runRegisterDemoService();
    }

    function _runDeploy() internal {
        Deploy script = new Deploy();
        vm.setEnv("MONAD_CHAIN_ID", "10143");
        vm.setEnv("CURATION_AUTHORITY_ADDRESS", vm.toString(curation));
        vm.setEnv("CREDIT_BASELINE_BASE_UNITS", vm.toString(BASELINE));
        vm.setEnv("GROWTH_FACTOR_BPS", vm.toString(GROWTH_BPS));
        vm.setEnv("PERMIT2_ADDRESS", vm.toString(address(0xBEEF)));
        vm.setEnv("DEPLOY_MOCK_USDC", "true");
        vm.expectRevert(abi.encodeWithSelector(DeploymentBase.WrongChain.selector, 10143, block.chainid));
        script.run();

        vm.chainId(10143);
        vm.expectRevert(
            abi.encodeWithSelector(DeploymentBase.NotDeployed.selector, "PERMIT2_ADDRESS", address(0xBEEF))
        );
        script.run();

        vm.setEnv("PERMIT2_ADDRESS", vm.toString(permit2));
        (DeploymentBase.Deployment memory d, address mock) = script.run();
        assertTrue(d.tabBook != address(0) && mock != address(0), "deployed with a mock token");
        assertEq(MockUsdc(mock).decimals(), 6, "six decimals like USDC");
        // The broadcaster, not the caller of `run()`, held and spent the wiring authority.
        assertEq(TabBook(d.tabBook).WIRING_AUTHORITY(), DEFAULT_SENDER, "broadcaster wired it");
        assertEq(TabBook(d.tabBook).settlementSurface(), d.tabSettlement, "and the slot is wired");
        assertEq(address(TabSettlement(d.tabSettlement).PERMIT2()), permit2, "Permit2 from the environment");
        vm.chainId(31337);
    }

    function _runRegisterIdentity() internal {
        MockIdentityRegistry identity = new MockIdentityRegistry();
        vm.setEnv("MONAD_CHAIN_ID", vm.toString(block.chainid));
        vm.setEnv("ERC8004_IDENTITY_REGISTRY_ADDRESS", vm.toString(address(identity)));
        vm.setEnv("ERC8004_SERVICE_AGENT_URI", SERVICE_URI);
        vm.setEnv("ERC8004_AGENT_URI", "");
        vm.setEnv("ERC8004_SERVICE_AGENT_ID", "");
        vm.setEnv("ERC8004_AGENT_ID", "");
        RegisterIdentity script = new RegisterIdentity();

        vm.expectRevert(abi.encodeWithSelector(RegisterIdentity.EmptyAgentURI.selector, "ERC8004_AGENT_URI"));
        script.run();

        // An empty registry setting means the canonical one, and the local chain has none.
        vm.setEnv("ERC8004_AGENT_URI", AGENT_URI);
        vm.setEnv("ERC8004_IDENTITY_REGISTRY_ADDRESS", "");
        vm.expectRevert(
            abi.encodeWithSelector(
                DeploymentBase.MissingAddress.selector, "ERC8004_IDENTITY_REGISTRY_ADDRESS"
            )
        );
        script.run();
        vm.setEnv("ERC8004_IDENTITY_REGISTRY_ADDRESS", vm.toString(address(identity)));

        (RegisterIdentity.Outcome memory service, RegisterIdentity.Outcome memory demoAgent) = script.run();
        assertTrue(service.minted && demoAgent.minted, "both minted on the first run");
        assertEq(service.agentId, 0, "the Service took the first id");
        assertEq(demoAgent.agentId, 1, "the Agent the next");
        assertEq(identity.ownerOf(0), DEFAULT_SENDER, "the broadcaster owns the Service identity");
        assertEq(identity.ownerOf(1), DEFAULT_SENDER, "and the Agent identity");
        assertEq(identity.tokenURI(0), SERVICE_URI, "Service URI");
        assertEq(identity.tokenURI(1), AGENT_URI, "Agent URI");

        // Recorded, the second run mints nothing.
        vm.setEnv("ERC8004_SERVICE_AGENT_ID", "0");
        vm.setEnv("ERC8004_AGENT_ID", "1");
        (service, demoAgent) = script.run();
        assertFalse(service.minted || demoAgent.minted, "nothing minted");
        assertEq(identity.balanceOf(DEFAULT_SENDER), 2, "still two identities");

        // A stale record stops the run before anything is minted.
        vm.setEnv("ERC8004_AGENT_ID", "7");
        vm.expectRevert(
            abi.encodeWithSelector(
                RegisterIdentity.RecordedIdentityNotOwned.selector,
                "ERC8004_AGENT_ID",
                7,
                DEFAULT_SENDER,
                address(0)
            )
        );
        script.run();
        // The reverted run left its broadcast open; close it so the next entry point can start one.
        vm.stopBroadcast();
        assertEq(identity.balanceOf(DEFAULT_SENDER), 2, "nothing minted over a stale record");
    }

    function _runRegisterDemoService() internal {
        Deploy deployScript = new Deploy();
        DeploymentBase.Deployment memory d = _deploy(deployScript, curation);
        MockUsdc usdc = new MockUsdc();
        MockUsdc mockUsdc = new MockUsdc();
        vm.setEnv("MONAD_CHAIN_ID", vm.toString(block.chainid));
        vm.setEnv("SERVICE_REGISTRY_ADDRESS", vm.toString(d.serviceRegistry));
        vm.setEnv("BOND_ADDRESS", vm.toString(d.bond));
        vm.setEnv("USDC_ADDRESS", vm.toString(address(0)));
        vm.setEnv("MOCK_USDC_ADDRESS", vm.toString(address(0)));
        vm.setEnv("GATEWAY_SERVICE_ID", vm.toString(DEMO_SERVICE));
        vm.setEnv("GATEWAY_TOOL", "a-tool-name-that-runs-past-thirty-two-bytes");
        vm.setEnv("GATEWAY_PRICE_BASE_UNITS", "10000");
        vm.setEnv("DEFAULT_SETTLEMENT_WINDOW_S", "21600");
        RegisterDemoService script = new RegisterDemoService();

        vm.expectRevert(
            abi.encodeWithSelector(
                RegisterDemoService.ToolNameTooLong.selector, "a-tool-name-that-runs-past-thirty-two-bytes"
            )
        );
        script.run();

        vm.setEnv("GATEWAY_TOOL", "quote.generate");
        vm.expectRevert(RegisterDemoService.NoAssetConfigured.selector);
        script.run();

        // Only the canonical USDC: registered, nothing to stake.
        vm.setEnv("USDC_ADDRESS", vm.toString(address(usdc)));
        RegisterDemoService.Outcome memory outcome = script.run();
        assertTrue(outcome.registered, "registered");
        assertFalse(outcome.bonded, "no test token to stake");
        assertEq(outcome.serviceId, DEMO_SERVICE, "service id");
        assertEq(outcome.operator, DEFAULT_SENDER, "the broadcaster operates it");
        assertEq(outcome.assets.length, 1, "one Asset");
        assertEq(outcome.assets[0], address(usdc), "the canonical USDC");

        // With the test token as well: the Service is kept, the Bond is posted.
        vm.setEnv("MOCK_USDC_ADDRESS", vm.toString(address(mockUsdc)));
        outcome = script.run();
        assertFalse(outcome.registered, "not registered twice");
        assertTrue(outcome.bonded, "bonded");
        assertEq(outcome.assets.length, 2, "two Assets");
        assertEq(outcome.assets[0], address(usdc), "the canonical USDC first");
        assertEq(outcome.assets[1], address(mockUsdc), "the test token second");
        Bond bond = Bond(d.bond);
        assertEq(
            bond.freeOf(bond.partyOf(DEFAULT_SENDER), address(mockUsdc)),
            script.DEMO_BOND_BASE_UNITS(),
            "50 test USDC staked by the broadcaster"
        );
        ServiceRegistry registry = ServiceRegistry(d.serviceRegistry);
        assertEq(registry.serviceOf(DEMO_SERVICE).operator, DEFAULT_SENDER, "operated by the broadcaster");
        assertEq(registry.priceOf(DEMO_SERVICE, address(usdc), DEMO_TOOL), 10_000, "price");
        assertEq(registry.settlementWindowOf(DEMO_SERVICE), 21_600, "window");
    }
}
