// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title IIdentityRegistry
/// @notice The slice of the ERC-8004 Identity Registry the registration script uses.
/// @dev Signatures copied from `IdentityRegistryUpgradeable` in erc-8004/erc-8004-contracts, the
/// contract behind the canonical proxies (`getVersion()` reports 2.0.0). An identity is an ERC-721 token
/// whose id is the agentId and whose `tokenURI` is the agent's registration file. `register` mints to
/// `msg.sender` and records it as the agent's wallet; `agentId`s are sequential from zero.
interface IIdentityRegistry {
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    function register(string memory agentURI) external returns (uint256 agentId);
    function setAgentURI(uint256 agentId, string calldata newURI) external;
    function ownerOf(uint256 tokenId) external view returns (address owner);
    function tokenURI(uint256 tokenId) external view returns (string memory uri);
    function balanceOf(address owner) external view returns (uint256 balance);
    function getAgentWallet(uint256 agentId) external view returns (address wallet);
}
