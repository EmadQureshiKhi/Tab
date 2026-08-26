// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeploymentBase} from "./DeploymentBase.sol";
import {IBond} from "../src/Bond.sol";
import {IServiceRegistry} from "../src/ServiceRegistry.sol";
import {IAgentRegistry, SettlementVerifier} from "../src/SettlementVerifier.sol";
import {ITabBook} from "../src/TabBook.sol";

/// @title DeployVerifier
/// @notice Step 3. Deploys `SettlementVerifier`, linked against the decoding library from step 1.
/// @dev The constructor takes **four** collaborators — registry, Agent registry, book, and Bond — and
/// all four are immutables rather than wired slots. That is stronger than a setter: there is no moment
/// at which the registry a Settlement authenticates against, the book it credits, or the Bond a proven
/// deposit funds is unset or re-pointable. The Bond argument is the one that is easy to leave out and
/// the most costly to leave out, because without it a proven deposit to a Bond Collection Address
/// credits nothing, every ledger stays at zero, `bondCap` stays at zero, and so every Credit Limit
/// stays at zero.
///
/// The BlockProver Precompile is not a constructor argument at all. `TabAscBase` reads it from the
/// address library, so no deployment can aim verification at a contract that merely returns true.
///
/// **Linkage.** `EvmV1Decoder` exposes twelve public functions, so the verifier's bytecode carries five
/// link references to it and the linker needs the step 1 address. The library identifier passed to
/// `--libraries` is the remapped source path exactly as the artefact's `linkReferences` spells it, which
/// is the `../../node_modules/...` form and not the scoped package form the import statement uses. The
/// exact command is in the plain comment directly below this block, kept out of NatSpec because a scoped
/// package name inside a documentation comment reads as a documentation tag and fails to compile.
///
/// Omitting `--libraries` does not fail: Foundry silently deploys a second copy of the library and links
/// against that, which works and leaves the deployment record wrong. The script therefore refuses to run
/// unless `DECODER_LIBRARY_ADDRESS` names an address that holds code, so a forgotten or mistyped flag is
/// caught before the verifier exists rather than after.
///
/// Requirements: 26.1, 26.2, 26.5
contract DeployVerifier is DeploymentBase {
    // Run, from `packages/contracts`, with the address step 1 printed, joined onto one line:
    //
    //   forge script script/03_DeployVerifier.s.sol:DeployVerifier --rpc-url creditcoin
    //     --sig "run()"
    //     --libraries
    //     ../../node_modules/@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol:EvmV1Decoder:0xLIB

    /// @notice Deploys the verifier against the configured Creditcoin chain.
    /// @return verifier Address of the deployed `SettlementVerifier`.
    function run() external returns (address verifier) {
        _requireCreditcoinChain(vm.envUint("CREDITCOIN_CHAIN_ID"));

        // Not passed to the constructor. Checked because the `--libraries` flag that carries it is the
        // one input to this step that fails silently rather than loudly.
        address decoder = _requireCode("DECODER_LIBRARY_ADDRESS", vm.envAddress("DECODER_LIBRARY_ADDRESS"));

        CoreAddresses memory core = CoreAddresses({
            serviceRegistry: _requireCode(
                "SERVICE_REGISTRY_ADDRESS", vm.envAddress("SERVICE_REGISTRY_ADDRESS")
            ),
            agentRegistry: _requireCode("AGENT_REGISTRY_ADDRESS", vm.envAddress("AGENT_REGISTRY_ADDRESS")),
            bond: _requireCode("BOND_ADDRESS", vm.envAddress("BOND_ADDRESS")),
            tabBook: _requireCode("TAB_BOOK_ADDRESS", vm.envAddress("TAB_BOOK_ADDRESS"))
        });

        vm.startBroadcast();
        verifier = deployVerifier(core);
        vm.stopBroadcast();

        _heading("Step 3 of 7 - settlement verifier");
        _report("SettlementVerifier", verifier);
        _report("linked EvmV1Decoder", decoder);
        _report("services", core.serviceRegistry);
        _report("agents  ", core.agentRegistry);
        _report("tabBook ", core.tabBook);
        _report("bond    ", core.bond);
    }

    /// @notice Deploys the verifier over four already-deployed collaborators.
    /// @dev Reads no environment and opens no broadcast.
    /// @param core Addresses produced by step 2.
    /// @return verifier Address of the deployed `SettlementVerifier`.
    function deployVerifier(CoreAddresses memory core) public returns (address verifier) {
        verifier = address(
            new SettlementVerifier(
                IServiceRegistry(core.serviceRegistry),
                IAgentRegistry(core.agentRegistry),
                ITabBook(core.tabBook),
                IBond(core.bond)
            )
        );
    }
}
