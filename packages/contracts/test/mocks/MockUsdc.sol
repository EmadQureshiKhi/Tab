// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUsdc
/// @notice Minimal 6-decimal ERC-20 test double standing in for USDC on Ethereum Sepolia.
/// @dev The pinned OpenZeppelin release ships no mock token under a path this project can reach through
/// its remapping, so the double is the OpenZeppelin `ERC20` implementation with `decimals()` overridden
/// to 6 and an open `mint`. Nothing here is deployed: it exists only so tests move real balances and
/// real allowances rather than stubbing the transfer out.
contract MockUsdc is ERC20 {
    /// @notice Deploys the double.
    constructor() ERC20("USD Coin", "USDC") {}

    /// @notice USDC carries 6 decimals, so every amount in the tests is an integer count of base units.
    /// @return The token's decimal count.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mints base units to an account. Open by design; this is a test double.
    /// @param to Account credited.
    /// @param amount Amount in base units.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
