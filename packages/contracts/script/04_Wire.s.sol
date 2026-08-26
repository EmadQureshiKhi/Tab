// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeploymentBase} from "./DeploymentBase.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Bond} from "../src/Bond.sol";
import {TabBook} from "../src/TabBook.sol";
import {console} from "forge-std/console.sol";

/// @title Wire
/// @notice Step 4. Points the three wirable contracts at the verifier, and the book at the Watcher.
/// @dev Five calls, and every one of them is one-shot in the contract that receives it:
/// `AgentRegistry.setSettlementVerifier`, `TabBook.setSettlementVerifier`, `TabBook.setWatcher`,
/// `Bond.setTabBook`, and `Bond.setSettlementVerifier`. Each reverts `AlreadyWired` once its target is
/// non-zero, so a deployment cannot be re-pointed at a different verifier afterwards and the deployer's
/// entire power over the rail is the ability to mis-wire it once, in public, at deployment. The
/// deployer is in the trusted set for exactly that and nothing more.
///
/// The one-shot rule lives in the contracts, not here. What this script adds is a read before every
/// write, which turns the three outcomes into three different, legible ones:
///
///  - the slot is zero, so the call is made;
///  - the slot already holds the intended address, so the call is skipped and reported as already
///    wired, which makes a resumed or repeated run safe rather than a guaranteed revert;
///  - the slot holds a different address, so the script reverts with both addresses named instead of
///    letting the contract's own `AlreadyWired` report only the one already there.
///
/// That third case is the one worth naming. It means an earlier run wired this deployment to a
/// different verifier, and no further call can fix it — the correct response is a fresh deployment of
/// whichever side is wrong, which is a decision for a human and not for a retry.
///
/// The caller must be the wiring authority recorded in step 2, which is the account that deployed the
/// three contracts. Nothing here is gated on the curation authority: curation and wiring are separate
/// powers and share no path.
///
/// Run, from `packages/contracts`:
///
/// ```
/// forge script script/04_Wire.s.sol:Wire --rpc-url creditcoin --sig "run()"
/// ```
///
/// Requirements: 26.1, 26.2, 11.6
contract Wire is DeploymentBase {
    /// @notice A one-shot slot already holds an address other than the intended one.
    /// @dev Reported instead of the contract's own `AlreadyWired`, which names only the address already
    /// present and so cannot say what was intended.
    /// @param slot Name of the slot, in `Contract.field` form.
    /// @param current Address the slot already holds, permanently.
    /// @param intended Address this run would have written.
    error WiredElsewhere(string slot, address current, address intended);

    /// @notice Result of one wiring call.
    /// @dev Returned so the test asserts the difference between "written now" and "already correct",
    /// rather than only that the end state is right. A deployment that reports five writes and a resumed
    /// run that reports five skips are both correct, and a run that reports a write it did not make is
    /// not.
    struct WiringReport {
        /// @dev True when `AgentRegistry.settlementVerifier` was written by this run.
        bool agentsVerifierWritten;
        /// @dev True when `TabBook.settlementVerifier` was written by this run.
        bool bookVerifierWritten;
        /// @dev True when `TabBook.watcher` was written by this run.
        bool bookWatcherWritten;
        /// @dev True when `Bond.tabBook` was written by this run.
        bool bondBookWritten;
        /// @dev True when `Bond.settlementVerifier` was written by this run.
        bool bondVerifierWritten;
    }

    /// @notice Wires the deployment named by the environment.
    /// @return report Which of the five slots this run wrote.
    function run() external returns (WiringReport memory report) {
        _requireCreditcoinChain(vm.envUint("CREDITCOIN_CHAIN_ID"));

        CoreAddresses memory core = CoreAddresses({
            serviceRegistry: _requireCode(
                "SERVICE_REGISTRY_ADDRESS", vm.envAddress("SERVICE_REGISTRY_ADDRESS")
            ),
            agentRegistry: _requireCode("AGENT_REGISTRY_ADDRESS", vm.envAddress("AGENT_REGISTRY_ADDRESS")),
            bond: _requireCode("BOND_ADDRESS", vm.envAddress("BOND_ADDRESS")),
            tabBook: _requireCode("TAB_BOOK_ADDRESS", vm.envAddress("TAB_BOOK_ADDRESS"))
        });
        address verifier =
            _requireCode("SETTLEMENT_VERIFIER_ADDRESS", vm.envAddress("SETTLEMENT_VERIFIER_ADDRESS"));
        // The Watcher is an ordinary account rather than a contract, so code length says nothing here.
        address watcherAddress = _requireAddress("WATCHER_ADDRESS", vm.envAddress("WATCHER_ADDRESS"));

        vm.startBroadcast();
        report = wire(core, verifier, watcherAddress);
        vm.stopBroadcast();

        _heading("Step 4 of 7 - one-shot wiring");
        _report("SettlementVerifier", verifier);
        _report("Watcher           ", watcherAddress);
        _reportSlot("AgentRegistry.settlementVerifier", report.agentsVerifierWritten);
        _reportSlot("TabBook.settlementVerifier      ", report.bookVerifierWritten);
        _reportSlot("TabBook.watcher                 ", report.bookWatcherWritten);
        _reportSlot("Bond.tabBook                    ", report.bondBookWritten);
        _reportSlot("Bond.settlementVerifier         ", report.bondVerifierWritten);
    }

    /// @notice Performs the five one-shot wiring calls, skipping any slot already holding its target.
    /// @dev Reads no environment and opens no broadcast. `msg.sender` must be the wiring authority the
    /// three contracts were constructed with.
    /// @param core Addresses produced by step 2.
    /// @param verifier Address produced by step 3.
    /// @param watcherAddress Account permitted to apply Provisional Clearings and report reorgs.
    /// @return report Which of the five slots this call wrote.
    function wire(CoreAddresses memory core, address verifier, address watcherAddress)
        public
        returns (WiringReport memory report)
    {
        AgentRegistry agents = AgentRegistry(core.agentRegistry);
        TabBook book = TabBook(core.tabBook);
        Bond bond = Bond(core.bond);

        if (_needsWiring("AgentRegistry.settlementVerifier", agents.settlementVerifier(), verifier)) {
            agents.setSettlementVerifier(verifier);
            report.agentsVerifierWritten = true;
        }
        if (_needsWiring("TabBook.settlementVerifier", book.settlementVerifier(), verifier)) {
            book.setSettlementVerifier(verifier);
            report.bookVerifierWritten = true;
        }
        if (_needsWiring("TabBook.watcher", book.watcher(), watcherAddress)) {
            book.setWatcher(watcherAddress);
            report.bookWatcherWritten = true;
        }
        // The book before the verifier, matching the deployment order: the Bond's own gate on a
        // clearing is the book, so wiring it first leaves no interval in which the Bond will credit a
        // proven deposit while still refusing to reserve against it.
        if (_needsWiring("Bond.tabBook", bond.tabBook(), core.tabBook)) {
            bond.setTabBook(core.tabBook);
            report.bondBookWritten = true;
        }
        if (_needsWiring("Bond.settlementVerifier", bond.settlementVerifier(), verifier)) {
            bond.setSettlementVerifier(verifier);
            report.bondVerifierWritten = true;
        }
    }

    /// @notice Decides whether a one-shot slot still needs writing, and refuses a contradiction.
    /// @param slot Name of the slot, for the revert.
    /// @param current Address the slot holds now.
    /// @param intended Address this run wants it to hold.
    /// @return needed True when the slot is empty and the call should be made.
    function _needsWiring(string memory slot, address current, address intended)
        internal
        pure
        returns (bool needed)
    {
        if (current == address(0)) return true;
        if (current != intended) revert WiredElsewhere(slot, current, intended);
        return false;
    }

    /// @notice Prints one slot's outcome.
    /// @param slot Name of the slot.
    /// @param written True when this run wrote it.
    function _reportSlot(string memory slot, bool written) internal pure {
        if (written) console.log(slot, "wired now");
        else console.log(slot, "already wired");
    }
}
