// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeploymentBase} from "./DeploymentBase.sol";
import {TabBook} from "../src/TabBook.sol";
import {TabSettlement} from "../src/TabSettlement.sol";
import {console} from "forge-std/console.sol";

/// @title VerifyDeployment
/// @notice Reads a deployment back off the chain and checks that every wired slot agrees from both
/// ends. Holds no key and sends nothing, so anyone with the repository and an RPC URL can run it.
///
///   forge script script/02_VerifyDeployment.s.sol:VerifyDeployment --rpc-url monad_testnet --sig "run()"
contract VerifyDeployment is DeploymentBase {
    error SlotMismatch(string slot, address expected, address actual);

    function run() external view returns (bool ok) {
        _requireMonadChain();
        Deployment memory d = Deployment({
            serviceRegistry: _requireCode(
                "SERVICE_REGISTRY_ADDRESS", vm.envAddress("SERVICE_REGISTRY_ADDRESS")
            ),
            bond: _requireCode("BOND_ADDRESS", vm.envAddress("BOND_ADDRESS")),
            tabBook: _requireCode("TAB_BOOK_ADDRESS", vm.envAddress("TAB_BOOK_ADDRESS")),
            tabSettlement: _requireCode("TAB_SETTLEMENT_ADDRESS", vm.envAddress("TAB_SETTLEMENT_ADDRESS")),
            permit2: _requireCode("PERMIT2_ADDRESS", vm.envAddress("PERMIT2_ADDRESS"))
        });
        ok = verify(d);
        _heading("Deployment verified");
        console.log("every wired slot agrees from both ends:", ok);
    }

    function verify(Deployment memory d) public view returns (bool ok) {
        TabBook book = TabBook(d.tabBook);
        TabSettlement settlement = TabSettlement(d.tabSettlement);
        _expect("TabBook.settlementSurface", d.tabSettlement, book.settlementSurface());
        _expect("TabBook.REGISTRY", d.serviceRegistry, address(book.REGISTRY()));
        _expect("TabBook.BOND", d.bond, address(book.BOND()));
        _expect("TabSettlement.BOOK", d.tabBook, address(settlement.BOOK()));
        _expect("TabSettlement.REGISTRY", d.serviceRegistry, address(settlement.REGISTRY()));
        _expect("TabSettlement.PERMIT2", d.permit2, address(settlement.PERMIT2()));
        ok = true;
    }

    function _expect(string memory slot, address expected, address actual) internal pure {
        if (expected != actual) revert SlotMismatch(slot, expected, actual);
    }
}
