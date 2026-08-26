// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeploymentBase} from "./DeploymentBase.sol";
import {console} from "forge-std/console.sol";

/// @title DeployDecoder
/// @notice Step 1. Deploys `EvmV1Decoder`, the pinned decoding library every consumer links against.
/// @dev The library is deployed on its own, first, and by a script rather than as a side effect of
/// deploying its consumer, for one reason: its address has to be a recorded, reusable fact. Twelve
/// public functions in `EvmV1Decoder` mean twelve `delegatecall` sites in
/// `SettlementVerifier`, so the linker needs an address at deployment time. Letting Foundry deploy the
/// library implicitly alongside the verifier would produce a fresh copy on every run, leave that copy
/// out of the deployment record, and make the verifier's bytecode unreproducible from the record.
///
/// The creation code comes from the compiled artefact rather than from `new`, because Solidity offers
/// no expression that instantiates a library. `vm.getCode` reads the artefact Foundry just built, so
/// the bytes deployed here are the bytes the pinned dependency version compiles to and nothing else.
/// (R26.4, R26.5)
///
/// Run, from `packages/contracts`:
///
/// ```
/// forge script script/01_DeployDecoder.s.sol:DeployDecoder --rpc-url creditcoin --sig "run()"
/// ```
///
/// Adding `--broadcast --account <name>` to that command performs the deployment. Without it the run
/// is a simulation against the endpoint's current state and sends nothing. Record the printed address
/// as `DECODER_LIBRARY_ADDRESS`; step 3 passes it to `--libraries`.
///
/// Requirements: 26.1, 26.2, 26.5
contract DeployDecoder is DeploymentBase {
    /// @notice Artefact identifier of the pinned decoding library. (R26.5)
    /// @dev The scoped package resolves through the workspace remapping in `foundry.toml`, so the
    /// artefact lands under the file's own basename regardless of the remapped source path.
    string internal constant DECODER_ARTIFACT = "EvmV1Decoder.sol:EvmV1Decoder";

    /// @notice The library creation code came back empty, so nothing would be deployed.
    error EmptyCreationCode();

    /// @notice The create failed, so the library is not deployed.
    error DeploymentFailed();

    /// @notice Deploys the decoding library against the configured Creditcoin chain.
    /// @return decoder Address of the deployed library.
    function run() external returns (address decoder) {
        _requireCreditcoinChain(vm.envUint("CREDITCOIN_CHAIN_ID"));

        vm.startBroadcast();
        decoder = deployDecoder();
        vm.stopBroadcast();

        _heading("Step 1 of 7 - decoding library");
        _report("EvmV1Decoder", decoder);
        console.log("Pass this to step 3 as:");
        console.log("  --libraries ../../node_modules/@gluwa/usc-contracts/contracts/decoding/");
        console.log("  EvmV1Decoder.sol:EvmV1Decoder:<address printed above>");
    }

    /// @notice Deploys the decoding library and nothing else.
    /// @dev Takes no arguments and reads no environment, so the test suite deploys the same bytes the
    /// deployment does.
    /// @return decoder Address of the deployed library.
    function deployDecoder() public returns (address decoder) {
        bytes memory creationCode = vm.getCode(DECODER_ARTIFACT);
        if (creationCode.length == 0) revert EmptyCreationCode();

        // A plain create from this contract, which is the same mechanism `new` uses, so the broadcast
        // recorder captures it exactly as it captures every other deployment in this directory.
        assembly ("memory-safe") {
            decoder := create(0, add(creationCode, 0x20), mload(creationCode))
        }
        if (decoder == address(0)) revert DeploymentFailed();
    }
}
