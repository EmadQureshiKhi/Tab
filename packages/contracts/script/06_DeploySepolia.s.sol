// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeploymentBase} from "./DeploymentBase.sol";
import {TabSettlement} from "../src/source/TabSettlement.sol";
import {console} from "forge-std/console.sol";

/// @title DeploySepolia
/// @notice Step 6. Deploys `TabSettlement` to Ethereum Sepolia. The only contract Tab puts on a Source
/// Chain.
/// @dev No constructor arguments, no state, no owner, no upgrade path, and no hardcoded Asset. The
/// contract moves an Asset amount from the paying Agent to a Collection Address and emits exactly one
/// `TabSettled` log per Settlement, and that log is the whole of its coupling to Creditcoin. So there is
/// nothing to configure at deployment and nothing to wire afterwards.
///
/// Ethereum Mainnet gets no deployment at all. There, a plain USDC `Transfer` to a registered Collection
/// Address is the Settlement, which is why this file names Sepolia in its own chain guard rather than
/// taking a chain id from the environment: there is no other chain it may run against. (R2.1, D16.2)
///
/// After deployment, record the address as `SEPOLIA_SETTLEMENT_ADDRESS` and authorise it in the registry
/// for chainKey 1 alone, which step 5 does. The one-chain authorisation is what stops the same address
/// on another chain from having its `TabSettled` believed. (R1.1, R5.2, R5.3)
///
/// Run, from `packages/contracts`, against a Sepolia endpoint rather than the Creditcoin one:
///
/// ```
/// forge script script/06_DeploySepolia.s.sol:DeploySepolia --rpc-url <sepolia endpoint> --sig "run()"
/// ```
///
/// Requirements: 1.1, 1.3, 26.2
contract DeploySepolia is DeploymentBase {
    /// @notice Deploys the settlement contract, refusing any chain other than Ethereum Sepolia.
    /// @return settlement Address of the deployed `TabSettlement`.
    function run() external returns (address settlement) {
        _requireChain(ETHEREUM_SEPOLIA_CHAIN_ID);

        vm.startBroadcast();
        settlement = deploySettlement();
        vm.stopBroadcast();

        _heading("Step 6 of 7 - Ethereum Sepolia settlement surface");
        _report("TabSettlement", settlement);
        console.log("Record as SEPOLIA_SETTLEMENT_ADDRESS, then authorise for chainKey 1 in step 5.");
    }

    /// @notice Deploys the settlement contract and nothing else.
    /// @dev Reads no environment and opens no broadcast.
    /// @return settlement Address of the deployed `TabSettlement`.
    function deploySettlement() public returns (address settlement) {
        settlement = address(new TabSettlement());
    }
}
