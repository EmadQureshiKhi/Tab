// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title MockUsdc
/// @notice A six-decimal, mintable stand-in for USDC on Monad Testnet, with the same signature surface
/// as the real thing.
/// @dev The OpenZeppelin `ERC20` with `decimals()` overridden to 6, an open `mint`, and EIP-3009
/// (`transferWithAuthorization`, `receiveWithAuthorization`, `cancelAuthorization`) under the EIP-712
/// domain Circle's USDC uses, name "USDC" and version "2". That last part is what lets an x402
/// facilitator settle this token exactly as it settles the canonical USDC: the client signs the same
/// typed data, the facilitator submits the same call. Shipped to Testnet by the deploy script so the
/// rail can be exercised without a faucet for the Asset; never part of a Mainnet deployment.
contract MockUsdc is ERC20, EIP712 {
    // ------------------------------------------------------------------ EIP-3009 constants

    /// @dev The typehashes are those the EIP publishes, derived here rather than pasted so a typo in
    /// the type string cannot leave a stale constant behind.
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    /// @notice An authorization was spent.
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    /// @notice An authorization was cancelled before it could be spent.
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationNotYetValid(uint256 validAfter, uint256 nowTs);
    error AuthorizationExpired(uint256 validBefore, uint256 nowTs);
    error AuthorizationUsedOrCanceled(address authorizer, bytes32 nonce);
    error InvalidSignature(address authorizer);
    error CallerMustBePayee(address to, address caller);

    /// @dev authorizer => nonce => spent or cancelled.
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    // ------------------------------------------------------------------ token

    /// @notice Deploys the double.
    constructor() ERC20("USDC", "USDC") EIP712("USDC", "2") {}

    /// @notice USDC carries 6 decimals, so every amount in the tests is an integer count of base units.
    /// @return The token's decimal count.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice The EIP-712 domain version, as the canonical USDC reports it.
    function version() external pure returns (string memory) {
        return "2";
    }

    /// @notice The EIP-712 domain separator, under the same name the canonical USDC reports it.
    // forge-lint: disable-next-line(mixed-case-function)
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Mints base units to an account. Open by design; this is a test double.
    /// @param to Account credited.
    /// @param amount Amount in base units.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // ------------------------------------------------------------------ EIP-3009

    /// @notice Whether `nonce` has been spent or cancelled by `authorizer`.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @notice Execute a transfer `from` has signed for, submitted by anyone.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
    }

    /// @notice `transferWithAuthorization` with the signature split into its parts.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    /// @notice Like `transferWithAuthorization`, but only the payee may submit it, which closes the
    /// front-running window a contract payee would otherwise have to guard against.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        _receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
    }

    /// @notice `receiveWithAuthorization` with the signature split into its parts.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    /// @notice Retire an unused `nonce` so the authorization that carries it can never be spent.
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) external {
        _cancelAuthorization(authorizer, nonce, signature);
    }

    /// @notice `cancelAuthorization` with the signature split into its parts.
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        _cancelAuthorization(authorizer, nonce, abi.encodePacked(r, s, v));
    }

    // ------------------------------------------------------------------ internals

    function _transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) internal {
        _requireValidAuthorization(from, nonce, validAfter, validBefore);
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
                )
            )
        );
        _requireValidSignature(from, digest, signature);
        _markAuthorizationAsUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) internal {
        if (to != msg.sender) revert CallerMustBePayee(to, msg.sender);
        _requireValidAuthorization(from, nonce, validAfter, validBefore);
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
                )
            )
        );
        _requireValidSignature(from, digest, signature);
        _markAuthorizationAsUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) internal {
        _requireUnusedAuthorization(authorizer, nonce);
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)));
        _requireValidSignature(authorizer, digest, signature);
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _requireValidAuthorization(
        address authorizer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore
    ) internal view {
        if (block.timestamp <= validAfter) {
            revert AuthorizationNotYetValid(validAfter, block.timestamp);
        }
        if (block.timestamp >= validBefore) revert AuthorizationExpired(validBefore, block.timestamp);
        _requireUnusedAuthorization(authorizer, nonce);
    }

    function _requireUnusedAuthorization(address authorizer, bytes32 nonce) internal view {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationUsedOrCanceled(authorizer, nonce);
    }

    /// @dev An externally owned account recovers by ECDSA; a contract account answers ERC-1271. Both
    /// are what the canonical USDC accepts.
    function _requireValidSignature(address signer, bytes32 digest, bytes memory signature) internal view {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return;
        (bool ok, bytes memory answer) =
            signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
        if (ok && answer.length >= 32 && abi.decode(answer, (bytes4)) == IERC1271.isValidSignature.selector) {
            return;
        }
        revert InvalidSignature(signer);
    }

    function _markAuthorizationAsUsed(address authorizer, bytes32 nonce) internal {
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationUsed(authorizer, nonce);
    }
}
