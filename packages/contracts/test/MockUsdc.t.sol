// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {MockUsdc} from "../src/test/MockUsdc.sol";

/// @dev A contract account that answers ERC-1271 for one key, the way a smart wallet does.
contract MockWallet is IERC1271 {
    address internal immutable OWNER;

    constructor(address owner) {
        OWNER = owner;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == OWNER) {
            return IERC1271.isValidSignature.selector;
        }
        return bytes4(0);
    }
}

/// @dev The test token must sign and settle exactly like Circle's USDC, because an x402 facilitator
/// will treat it as one: same domain, same typehashes, same call shapes, same refusals.
contract MockUsdcTest is Test {
    /// @dev The values EIP-3009 publishes.
    bytes32 internal constant PUBLISHED_TRANSFER_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
    bytes32 internal constant PUBLISHED_RECEIVE_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;
    bytes32 internal constant PUBLISHED_CANCEL_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    address internal constant PAYEE = address(0xFACE);
    address internal constant SUBMITTER = address(0x5AB1);
    uint256 internal constant VALUE = 1_500_000;
    bytes32 internal constant NONCE = keccak256("nonce-one");
    uint64 internal constant START = 1_700_000_000;

    MockUsdc internal usdc;
    address internal payer;
    uint256 internal payerKey;
    uint256 internal validAfter;
    uint256 internal validBefore;

    function setUp() public {
        vm.warp(START);
        usdc = new MockUsdc();
        (payer, payerKey) = makeAddrAndKey("payer");
        usdc.mint(payer, 10 * VALUE);
        validAfter = block.timestamp - 1;
        validBefore = block.timestamp + 1 hours;
    }

    // ------------------------------------------------------------------ helpers

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("USDC"), keccak256("2"), block.chainid, address(usdc))
        );
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _transferDigest(address from, address to, uint256 value, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        return _digest(
            keccak256(
                abi.encode(PUBLISHED_TRANSFER_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
            )
        );
    }

    function _receiveDigest(address from, address to, uint256 value, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        return _digest(
            keccak256(abi.encode(PUBLISHED_RECEIVE_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        );
    }

    function _cancelDigest(address authorizer, bytes32 nonce) internal view returns (bytes32) {
        return _digest(keccak256(abi.encode(PUBLISHED_CANCEL_TYPEHASH, authorizer, nonce)));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        signature = abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------------ identity

    function test_looksExactlyLikeTheCanonicalUsdc() public view {
        assertEq(usdc.name(), "USDC", "name");
        assertEq(usdc.symbol(), "USDC", "symbol");
        assertEq(usdc.version(), "2", "version");
        assertEq(usdc.decimals(), 6, "decimals");
        assertEq(usdc.DOMAIN_SEPARATOR(), _domainSeparator(), "domain: name USDC, version 2, chain, address");
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            usdc.eip712Domain();
        assertEq(name, "USDC", "ERC-5267 name");
        assertEq(version, "2", "ERC-5267 version");
        assertEq(chainId, block.chainid, "ERC-5267 chain");
        assertEq(verifyingContract, address(usdc), "ERC-5267 contract");
        assertEq(
            usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), PUBLISHED_TRANSFER_TYPEHASH, "transfer typehash"
        );
        assertEq(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), PUBLISHED_RECEIVE_TYPEHASH, "receive typehash");
        assertEq(usdc.CANCEL_AUTHORIZATION_TYPEHASH(), PUBLISHED_CANCEL_TYPEHASH, "cancel typehash");
    }

    function test_mintIsOpen() public {
        usdc.mint(PAYEE, 5);
        assertEq(usdc.balanceOf(PAYEE), 5, "minted");
    }

    // ------------------------------------------------------------------ transferWithAuthorization

    function test_anyoneMaySubmitATransferThePayerSigned() public {
        bytes memory signature = _sign(payerKey, _transferDigest(payer, PAYEE, VALUE, NONCE));
        assertFalse(usdc.authorizationState(payer, NONCE), "unused");
        vm.expectEmit(true, true, false, false, address(usdc));
        emit MockUsdc.AuthorizationUsed(payer, NONCE);
        vm.prank(SUBMITTER);
        usdc.transferWithAuthorization(payer, PAYEE, VALUE, validAfter, validBefore, NONCE, signature);
        assertEq(usdc.balanceOf(PAYEE), VALUE, "paid");
        assertEq(usdc.balanceOf(payer), 9 * VALUE, "debited");
        assertTrue(usdc.authorizationState(payer, NONCE), "spent");
    }

    function test_theSplitSignatureFormIsTheSameCall() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, _transferDigest(payer, PAYEE, VALUE, NONCE));
        vm.prank(SUBMITTER);
        usdc.transferWithAuthorization(payer, PAYEE, VALUE, validAfter, validBefore, NONCE, v, r, s);
        assertEq(usdc.balanceOf(PAYEE), VALUE, "paid");
        assertTrue(usdc.authorizationState(payer, NONCE), "spent");
    }

    function test_aTransferAuthorizationCannotBeReplayed() public {
        bytes memory signature = _sign(payerKey, _transferDigest(payer, PAYEE, VALUE, NONCE));
        usdc.transferWithAuthorization(payer, PAYEE, VALUE, validAfter, validBefore, NONCE, signature);
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.AuthorizationUsedOrCanceled.selector, payer, NONCE));
        usdc.transferWithAuthorization(payer, PAYEE, VALUE, validAfter, validBefore, NONCE, signature);
        assertEq(usdc.balanceOf(PAYEE), VALUE, "paid once");
    }

    function test_aTransferAuthorizationIsOnlyGoodInsideItsWindow() public {
        bytes memory signature = _sign(payerKey, _transferDigest(payer, PAYEE, VALUE, NONCE));
        vm.warp(validAfter);
        vm.expectRevert(
            abi.encodeWithSelector(MockUsdc.AuthorizationNotYetValid.selector, validAfter, block.timestamp)
        );
        usdc.transferWithAuthorization(payer, PAYEE, VALUE, validAfter, validBefore, NONCE, signature);
        vm.warp(validBefore);
        vm.expectRevert(
            abi.encodeWithSelector(MockUsdc.AuthorizationExpired.selector, validBefore, block.timestamp)
        );
        usdc.transferWithAuthorization(payer, PAYEE, VALUE, validAfter, validBefore, NONCE, signature);
        vm.warp(validBefore - 1);
        usdc.transferWithAuthorization(payer, PAYEE, VALUE, validAfter, validBefore, NONCE, signature);
        assertEq(usdc.balanceOf(PAYEE), VALUE, "paid inside the window");
    }

    function test_aTransferAuthorizationBindsEveryField() public {
        bytes memory signature = _sign(payerKey, _transferDigest(payer, PAYEE, VALUE, NONCE));
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.InvalidSignature.selector, payer));
        usdc.transferWithAuthorization(payer, PAYEE, VALUE + 1, validAfter, validBefore, NONCE, signature);
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.InvalidSignature.selector, payer));
        usdc.transferWithAuthorization(payer, SUBMITTER, VALUE, validAfter, validBefore, NONCE, signature);
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.InvalidSignature.selector, payer));
        usdc.transferWithAuthorization(
            payer, PAYEE, VALUE, validAfter, validBefore, keccak256("other"), signature
        );
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.InvalidSignature.selector, payer));
        usdc.transferWithAuthorization(payer, PAYEE, VALUE, validAfter, validBefore - 1, NONCE, signature);
        (, uint256 impostorKey) = makeAddrAndKey("impostor");
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.InvalidSignature.selector, payer));
        usdc.transferWithAuthorization(
            payer,
            PAYEE,
            VALUE,
            validAfter,
            validBefore,
            NONCE,
            _sign(impostorKey, _transferDigest(payer, PAYEE, VALUE, NONCE))
        );
        assertEq(usdc.balanceOf(PAYEE), 0, "nothing moved");
        assertFalse(usdc.authorizationState(payer, NONCE), "nothing spent");
    }

    function test_aTransferAuthorizationIsNotAReceiveAuthorization() public {
        bytes memory signature = _sign(payerKey, _receiveDigest(payer, PAYEE, VALUE, NONCE));
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.InvalidSignature.selector, payer));
        usdc.transferWithAuthorization(payer, PAYEE, VALUE, validAfter, validBefore, NONCE, signature);
    }

    function test_aContractAccountSignsThroughErc1271() public {
        (address owner, uint256 ownerKey) = makeAddrAndKey("wallet-owner");
        MockWallet wallet = new MockWallet(owner);
        usdc.mint(address(wallet), VALUE);
        bytes memory signature = _sign(ownerKey, _transferDigest(address(wallet), PAYEE, VALUE, NONCE));
        vm.prank(SUBMITTER);
        usdc.transferWithAuthorization(
            address(wallet), PAYEE, VALUE, validAfter, validBefore, NONCE, signature
        );
        assertEq(usdc.balanceOf(PAYEE), VALUE, "the wallet paid");
        // The same wallet refuses a stranger's signature.
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        bytes32 other = keccak256("nonce-two");
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.InvalidSignature.selector, address(wallet)));
        usdc.transferWithAuthorization(
            address(wallet),
            PAYEE,
            VALUE,
            validAfter,
            validBefore,
            other,
            _sign(strangerKey, _transferDigest(address(wallet), PAYEE, VALUE, other))
        );
    }

    // ------------------------------------------------------------------ receiveWithAuthorization

    function test_onlyThePayeeMaySubmitAReceiveAuthorization() public {
        bytes memory signature = _sign(payerKey, _receiveDigest(payer, PAYEE, VALUE, NONCE));
        vm.prank(SUBMITTER);
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.CallerMustBePayee.selector, PAYEE, SUBMITTER));
        usdc.receiveWithAuthorization(payer, PAYEE, VALUE, validAfter, validBefore, NONCE, signature);
        vm.expectEmit(true, true, false, false, address(usdc));
        emit MockUsdc.AuthorizationUsed(payer, NONCE);
        vm.prank(PAYEE);
        usdc.receiveWithAuthorization(payer, PAYEE, VALUE, validAfter, validBefore, NONCE, signature);
        assertEq(usdc.balanceOf(PAYEE), VALUE, "received");
        assertTrue(usdc.authorizationState(payer, NONCE), "spent");
    }

    function test_theSplitReceiveFormIsTheSameCall() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, _receiveDigest(payer, PAYEE, VALUE, NONCE));
        vm.prank(PAYEE);
        usdc.receiveWithAuthorization(payer, PAYEE, VALUE, validAfter, validBefore, NONCE, v, r, s);
        assertEq(usdc.balanceOf(PAYEE), VALUE, "received");
    }

    function test_aReceiveAuthorizationIsNotATransferAuthorization() public {
        bytes memory signature = _sign(payerKey, _transferDigest(payer, PAYEE, VALUE, NONCE));
        vm.prank(PAYEE);
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.InvalidSignature.selector, payer));
        usdc.receiveWithAuthorization(payer, PAYEE, VALUE, validAfter, validBefore, NONCE, signature);
    }

    // ------------------------------------------------------------------ cancelAuthorization

    function test_aCancelledNonceCanNeverBeSpent() public {
        bytes memory transfer = _sign(payerKey, _transferDigest(payer, PAYEE, VALUE, NONCE));
        bytes memory cancel = _sign(payerKey, _cancelDigest(payer, NONCE));
        vm.expectEmit(true, true, false, false, address(usdc));
        emit MockUsdc.AuthorizationCanceled(payer, NONCE);
        vm.prank(SUBMITTER);
        usdc.cancelAuthorization(payer, NONCE, cancel);
        assertTrue(usdc.authorizationState(payer, NONCE), "retired");
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.AuthorizationUsedOrCanceled.selector, payer, NONCE));
        usdc.transferWithAuthorization(payer, PAYEE, VALUE, validAfter, validBefore, NONCE, transfer);
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.AuthorizationUsedOrCanceled.selector, payer, NONCE));
        usdc.cancelAuthorization(payer, NONCE, cancel);
        assertEq(usdc.balanceOf(PAYEE), 0, "nothing moved");
    }

    function test_theSplitCancelFormIsTheSameCall() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, _cancelDigest(payer, NONCE));
        usdc.cancelAuthorization(payer, NONCE, v, r, s);
        assertTrue(usdc.authorizationState(payer, NONCE), "retired");
    }

    function test_onlyTheAuthorizerMayCancel() public {
        (, uint256 impostorKey) = makeAddrAndKey("impostor");
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.InvalidSignature.selector, payer));
        usdc.cancelAuthorization(payer, NONCE, _sign(impostorKey, _cancelDigest(payer, NONCE)));
        assertFalse(usdc.authorizationState(payer, NONCE), "still open");
    }

    function test_aSpentNonceCannotBeCancelled() public {
        usdc.transferWithAuthorization(
            payer,
            PAYEE,
            VALUE,
            validAfter,
            validBefore,
            NONCE,
            _sign(payerKey, _transferDigest(payer, PAYEE, VALUE, NONCE))
        );
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.AuthorizationUsedOrCanceled.selector, payer, NONCE));
        usdc.cancelAuthorization(payer, NONCE, _sign(payerKey, _cancelDigest(payer, NONCE)));
    }
}
