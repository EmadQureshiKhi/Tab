// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeploymentBase} from "./DeploymentBase.sol";
import {IIdentityRegistry} from "./IIdentityRegistry.sol";
import {console} from "forge-std/console.sol";

/// @title RegisterIdentity
/// @notice Registers the demo Service and the demo Agent on the chain's ERC-8004 Identity Registry, once.
///
/// Reads from the environment:
///  - `MONAD_CHAIN_ID`                    the chain this run is allowed to touch
///  - `ERC8004_IDENTITY_REGISTRY_ADDRESS` optional; empty means the canonical Identity Registry for
///                                       that chain
///  - `ERC8004_SERVICE_AGENT_URI`         the Service's registration file
///  - `ERC8004_AGENT_URI`                 the Agent's registration file
///  - `ERC8004_SERVICE_AGENT_ID`          optional; the agentId a previous run minted for the Service
///  - `ERC8004_AGENT_ID`                  optional; the agentId a previous run minted for the Agent
///
/// The registry has no lookup from an owner to its agentIds, so idempotency rests on the two recorded
/// ids: when one is set and the broadcaster owns it, that identity is kept (its URI brought up to date
/// if it drifted) and nothing is minted. When one is set and the broadcaster does not own it, the run
/// stops rather than minting a duplicate, because a stale record is something to fix by hand. When one
/// is unset, the identity is minted and its id printed so it can be recorded.
///
/// Both identities are minted to the broadcasting account, which is also the demo Service's operator.
///
///   forge script script/03_RegisterIdentity.s.sol:RegisterIdentity --rpc-url monad_testnet --broadcast
contract RegisterIdentity is DeploymentBase {
    string constant SERVICE_ID_KEY = "ERC8004_SERVICE_AGENT_ID";
    string constant AGENT_ID_KEY = "ERC8004_AGENT_ID";

    /// @notice The canonical ERC-8004 Identity Registry on each Monad network.
    address internal constant MAINNET_IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant TESTNET_IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    /// @notice The outcome for one identity.
    struct Outcome {
        uint256 agentId;
        /// @dev True when this run minted it; false when a recorded id was kept.
        bool minted;
        /// @dev True when a recorded identity's URI was rewritten to the configured one.
        bool uriUpdated;
    }

    error RecordedIdentityNotOwned(string key, uint256 agentId, address expected, address actual);
    error EmptyAgentURI(string key);

    function run() external returns (Outcome memory service, Outcome memory agent) {
        _requireMonadChain();
        IIdentityRegistry registry = IIdentityRegistry(
            _requireCode(
                "ERC8004_IDENTITY_REGISTRY_ADDRESS",
                _orCanonical(vm.envOr("ERC8004_IDENTITY_REGISTRY_ADDRESS", address(0)))
            )
        );
        string memory serviceUri =
            _requireUri("ERC8004_SERVICE_AGENT_URI", vm.envString("ERC8004_SERVICE_AGENT_URI"));
        string memory agentUri = _requireUri("ERC8004_AGENT_URI", vm.envString("ERC8004_AGENT_URI"));
        (bool serviceRecorded, uint256 serviceRecordedId) = _recordedId(vm.envOr(SERVICE_ID_KEY, string("")));
        (bool agentRecorded, uint256 agentRecordedId) = _recordedId(vm.envOr(AGENT_ID_KEY, string("")));

        vm.startBroadcast();
        address owner = _broadcaster();
        service = ensure(registry, owner, SERVICE_ID_KEY, serviceRecorded, serviceRecordedId, serviceUri);
        agent = ensure(registry, owner, AGENT_ID_KEY, agentRecorded, agentRecordedId, agentUri);
        vm.stopBroadcast();

        _heading("ERC-8004 identities");
        console.log("chainId                 ", block.chainid);
        _report("identityRegistry        ", address(registry));
        _report("owner                   ", owner);
        _print("Service", SERVICE_ID_KEY, service, serviceUri);
        _print("Agent  ", AGENT_ID_KEY, agent, agentUri);
    }

    /// @notice Keep a recorded identity or mint a new one. Public so tests can exercise the exact code
    /// the run executed.
    function ensure(
        IIdentityRegistry registry,
        address owner,
        string memory key,
        bool recorded,
        uint256 recordedId,
        string memory agentURI
    ) public returns (Outcome memory outcome) {
        if (!recorded) {
            outcome.agentId = registry.register(agentURI);
            outcome.minted = true;
            return outcome;
        }
        address actual = _ownerOf(registry, recordedId);
        if (actual != owner) revert RecordedIdentityNotOwned(key, recordedId, owner, actual);
        outcome.agentId = recordedId;
        if (keccak256(bytes(registry.tokenURI(recordedId))) != keccak256(bytes(agentURI))) {
            registry.setAgentURI(recordedId, agentURI);
            outcome.uriUpdated = true;
        }
    }

    /// @dev An empty or zero setting means the canonical registry for the chain this run is on.
    function _orCanonical(address configured) internal view returns (address registry) {
        if (configured != address(0)) return configured;
        if (block.chainid == MONAD_MAINNET_CHAIN_ID) return MAINNET_IDENTITY_REGISTRY;
        if (block.chainid == MONAD_TESTNET_CHAIN_ID) return TESTNET_IDENTITY_REGISTRY;
        return address(0);
    }

    /// @dev `ownerOf` reverts for an id nobody holds; that reads as "owned by nobody" here.
    function _ownerOf(IIdentityRegistry registry, uint256 agentId) internal view returns (address owner) {
        try registry.ownerOf(agentId) returns (address holder) {
            owner = holder;
        } catch {
            owner = address(0);
        }
    }

    /// @dev An unset or empty variable means "not recorded"; anything else must parse as an id.
    function _recordedId(string memory raw) internal pure returns (bool recorded, uint256 agentId) {
        if (bytes(raw).length == 0) return (false, 0);
        return (true, vm.parseUint(raw));
    }

    function _requireUri(string memory key, string memory uri) internal pure returns (string memory checked) {
        if (bytes(uri).length == 0) revert EmptyAgentURI(key);
        checked = uri;
    }

    function _print(string memory label, string memory key, Outcome memory outcome, string memory uri)
        internal
        pure
    {
        console.log("");
        string memory verdict = "kept";
        if (outcome.minted) verdict = "minted";
        if (outcome.uriUpdated) verdict = "kept, URI updated";
        console.log(label, verdict);
        console.log("  agentId ", outcome.agentId);
        console.log("  agentURI", uri);
        if (outcome.minted) console.log("  record it as", key);
    }
}
