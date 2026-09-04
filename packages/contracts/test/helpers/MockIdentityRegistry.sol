// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IIdentityRegistry} from "../../script/IIdentityRegistry.sol";

/// @dev A local stand-in for the ERC-8004 Identity Registry, with the behaviour the registration
/// script relies on: sequential ids from zero, `register` minting to the caller and recording it as the
/// agent's wallet, `setAgentURI` gated to the owner, and `ownerOf` reverting for an id nobody holds,
/// with the same error the OpenZeppelin ERC-721 behind the real registry raises. Upstream mints with
/// `_safeMint`; here the mint is plain so tests can call the script's public entry points directly,
/// which makes the script contract the registrant. On chain the registrant is the broadcasting
/// account, which the receiver check never touches.
contract MockIdentityRegistry is IIdentityRegistry {
    error ERC721NonexistentToken(uint256 tokenId);
    error NotAuthorized(uint256 agentId, address caller);

    uint256 internal _lastId;
    mapping(uint256 => address) internal _owners;
    mapping(address => uint256) internal _balances;
    mapping(uint256 => string) internal _uris;
    mapping(uint256 => address) internal _wallets;

    function register(string memory agentURI) external returns (uint256 agentId) {
        agentId = _lastId++;
        _owners[agentId] = msg.sender;
        _balances[msg.sender] += 1;
        _uris[agentId] = agentURI;
        _wallets[agentId] = msg.sender;
        emit Registered(agentId, agentURI, msg.sender);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        if (msg.sender != ownerOf(agentId)) revert NotAuthorized(agentId, msg.sender);
        _uris[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = _owners[tokenId];
        if (owner == address(0)) revert ERC721NonexistentToken(tokenId);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory uri) {
        ownerOf(tokenId);
        return _uris[tokenId];
    }

    function balanceOf(address owner) external view returns (uint256 balance) {
        return _balances[owner];
    }

    function getAgentWallet(uint256 agentId) external view returns (address wallet) {
        return _wallets[agentId];
    }
}
