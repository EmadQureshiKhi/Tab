// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
import {SignatureVerification} from "permit2/src/libraries/SignatureVerification.sol";
import {ITabBook} from "../src/TabBook.sol";
import {TabSettlement} from "../src/TabSettlement.sol";
import {Permit2Code} from "./helpers/Permit2Code.sol";
import {TabBookFixture} from "./TabBook.t.sol";

/// @dev Gasless Settlement through the canonical Permit2. The Agent here is a key the test holds, so
/// every signature is a real EIP-712 signature over the exact typed data an SDK would produce, and the
/// verifier is Permit2's own deployed bytecode. Direct `settle` and `settleBatch` are covered alongside
/// the book in `TabBook.t.sol`.
contract TabSettlementTest is TabBookFixture {
    /// @dev Permit2's own constants, restated here so a drift in the surface's type string is caught
    /// against the verifier rather than against itself.
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");
    string internal constant PERMIT_WITNESS_TRANSFER_FROM_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";
    bytes32 internal constant PERMIT2_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");

    /// @notice The published hash of `WITNESS_TYPE`, so the TypeScript side can pin the same value.
    bytes32 internal constant EXPECTED_WITNESS_TYPEHASH =
        0xb444b2cac7d73fdf2a7a66647cdd116e206f326d63d5acc48510ff8daffd9a1b;
    /// @notice The published hash of the full primary type Permit2 verifies against.
    bytes32 internal constant EXPECTED_PERMIT_WITNESS_TYPEHASH =
        0xda0044b708b71ff59860e59a72c2eb5add58df8942faf130a94017fe9e640197;

    address internal constant RELAYER = address(0x4E1A);
    uint256 internal constant NONCE = 7;
    /// @dev `PRICE` as a uint128, so amounts need no cast.
    uint128 internal constant UNIT = 1_000;

    address internal signer;
    uint256 internal signerKey;
    uint256 internal deadline;

    function setUp() public override {
        super.setUp();
        assertEq(UNIT, PRICE, "UNIT mirrors PRICE");
        (signer, signerKey) = makeAddrAndKey("signing-agent");
        _authorise(signer, SERVICE, USDC, AUTH_MAX);
        // A second Service, so a redirected signature reaches Permit2 rather than the registry.
        _registerService(SERVICE_TWO, OPERATOR_TWO, COLLECTION_THREE, COLLECTION_FOUR);
        deadline = block.timestamp + 1 hours;
        // Permit2 needs one ERC-20 approval, ever; after that the Agent only ever signs.
        vm.prank(signer);
        usdc.approve(permit2, type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _deliverToSigner(uint32 units) internal returns (uint256 charged) {
        vm.prank(OPERATOR);
        (charged,,) = book.recordDelivery(signer, SERVICE, USDC, TOOL, units, PRICE, _witness(USDC));
    }

    /// @dev Exactly what Permit2's `PermitHash.hashWithWitness` computes, then wrapped in its domain.
    function _digest(address asset, uint256 amount, uint256 nonce, uint256 deadline_, bytes32 witness)
        internal
        view
        returns (bytes32)
    {
        bytes32 typeHash =
            keccak256(abi.encodePacked(PERMIT_WITNESS_TRANSFER_FROM_STUB, settlement.WITNESS_TYPE_STRING()));
        bytes32 tokenPermissions = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, asset, amount));
        bytes32 structHash =
            keccak256(abi.encode(typeHash, tokenPermissions, address(settlement), nonce, deadline_, witness));
        return
            keccak256(
                abi.encodePacked("\x19\x01", ISignatureTransfer(permit2).DOMAIN_SEPARATOR(), structHash)
            );
    }

    /// @dev Permit2 keeps unordered nonces as bitmaps: word `nonce >> 8`, bit `nonce & 0xff`.
    function _nonceSpent(address owner, uint256 nonce) internal view returns (bool spent) {
        uint256 word = ISignatureTransfer(permit2).nonceBitmap(owner, nonce >> 8);
        return (word >> (nonce & 0xff)) & 1 == 1;
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        signature = abi.encodePacked(r, s, v);
    }

    /// @dev The Agent signs a Settlement of `amount` USDC towards `SERVICE`.
    function _signSettlement(uint128 amount, uint256 nonce, uint256 deadline_)
        internal
        view
        returns (bytes memory signature)
    {
        bytes32 witness = settlement.witnessHash(SERVICE, USDC, amount);
        return _sign(signerKey, _digest(USDC, amount, nonce, deadline_, witness));
    }

    // ------------------------------------------------------------------ the fixture is the real thing

    function test_permit2IsTheCanonicalDeploymentAtTheCanonicalAddress() public view {
        assertEq(permit2, Permit2Code.ADDRESS, "canonical address");
        assertEq(keccak256(Permit2Code.RUNTIME), Permit2Code.CODEHASH, "vendored bytes match the pin");
        assertEq(permit2.codehash, Permit2Code.CODEHASH, "and that is what was etched");
        assertEq(address(settlement.PERMIT2()), permit2, "the surface verifies against it");
        // The domain an SDK must sign under: name "Permit2", the chain id, Permit2's address, no version.
        bytes32 expected =
            keccak256(abi.encode(PERMIT2_DOMAIN_TYPEHASH, keccak256("Permit2"), block.chainid, permit2));
        assertEq(ISignatureTransfer(permit2).DOMAIN_SEPARATOR(), expected, "domain separator");
    }

    function test_witnessTypeStringIsWhatPermit2Expects() public view {
        assertEq(settlement.WITNESS_TYPEHASH(), EXPECTED_WITNESS_TYPEHASH, "witness typehash pinned");
        assertEq(
            settlement.WITNESS_TYPEHASH(),
            keccak256(bytes(settlement.WITNESS_TYPE())),
            "witness typehash is the hash of the witness type"
        );
        // The type string opens with the witness field and closes with the referenced structs in
        // EIP-712 order, so Permit2's stub plus this string is one well-formed primary type.
        assertEq(
            settlement.WITNESS_TYPE_STRING(),
            string.concat(
                "TabSettlement witness)",
                settlement.WITNESS_TYPE(),
                "TokenPermissions(address token,uint256 amount)"
            ),
            "type string composed from the witness type"
        );
        assertEq(
            keccak256(abi.encodePacked(PERMIT_WITNESS_TRANSFER_FROM_STUB, settlement.WITNESS_TYPE_STRING())),
            EXPECTED_PERMIT_WITNESS_TYPEHASH,
            "full primary typehash pinned"
        );
    }

    function test_witnessHashBindsTheThreeFactsToThisSurfaceAndChain() public {
        bytes32 expected = keccak256(
            abi.encode(
                EXPECTED_WITNESS_TYPEHASH, SERVICE, USDC, uint128(1_000), address(settlement), block.chainid
            )
        );
        assertEq(settlement.witnessHash(SERVICE, USDC, 1_000), expected, "witness hash");
        assertTrue(
            settlement.witnessHash(SERVICE, USDC, 1_000) != settlement.witnessHash(SERVICE, USDC, 1_001),
            "amount bound"
        );
        assertTrue(
            settlement.witnessHash(SERVICE, USDC, 1_000) != settlement.witnessHash(SERVICE_TWO, USDC, 1_000),
            "service bound"
        );
        assertTrue(
            settlement.witnessHash(SERVICE, USDC, 1_000) != settlement.witnessHash(SERVICE, AUSD, 1_000),
            "asset bound"
        );
        TabSettlement other = new TabSettlement(address(registry), address(book), permit2);
        assertTrue(other.witnessHash(SERVICE, USDC, 1_000) != expected, "surface bound");
        uint256 chainId = block.chainid;
        vm.chainId(chainId + 1);
        assertTrue(settlement.witnessHash(SERVICE, USDC, 1_000) != expected, "chain bound");
        vm.chainId(chainId);
    }

    function test_constructorRefusesAZeroPermit2() public {
        vm.expectRevert(TabSettlement.ZeroAddressField.selector);
        new TabSettlement(address(registry), address(book), address(0));
    }

    // ------------------------------------------------------------------ happy path

    function test_settleWithPermit2PaysTheTabOnTheAgentsSignatureAlone() public {
        _deliverToSigner(10);
        uint128 amount = 10 * UNIT;
        usdc.mint(signer, amount);
        bytes memory signature = _signSettlement(amount, NONCE, deadline);
        assertEq(usdc.allowance(signer, address(settlement)), 0, "the surface itself was never approved");

        vm.expectEmit(false, true, true, true, address(settlement));
        emit TabSettlement.Settled(bytes32(0), signer, SERVICE, USDC, amount, amount, 0, COLLECTION);
        vm.expectEmit(false, true, false, false, address(settlement));
        emit TabSettlement.SettledGasless(bytes32(0), RELAYER);
        vm.prank(RELAYER);
        (bytes32 settlementId, uint128 applied, uint128 toPrepaid) =
            settlement.settleWithPermit2(signer, SERVICE, USDC, amount, NONCE, deadline, signature);

        assertEq(applied, amount, "the whole payment lowered the tab");
        assertEq(toPrepaid, 0, "nothing left over");
        assertEq(usdc.balanceOf(COLLECTION), amount, "the Service was paid at its Collection address");
        assertEq(usdc.balanceOf(signer), 0, "the Agent paid exactly the amount");
        assertEq(usdc.balanceOf(RELAYER), 0, "the relayer touched nothing");
        assertEq(usdc.balanceOf(address(settlement)), 0, "the surface holds nothing");
        assertEq(usdc.balanceOf(permit2), 0, "Permit2 holds nothing");
        assertEq(book.assetOpen(signer, USDC), 0, "nothing owed");
        ITabBook.Settlement memory s = book.settlementOf(settlementId);
        assertEq(s.agent, signer, "recorded against the Agent, not the relayer");
        (, uint32 count) = book.historyCommitment(signer, USDC);
        assertEq(count, 1, "history extended exactly as a direct Settlement would");
        assertTrue(_nonceSpent(signer, NONCE), "the nonce is spent");
    }

    function test_settleWithPermit2BanksAnOverpaymentAsPrepaidCredit() public {
        _deliverToSigner(1);
        uint128 amount = UNIT + 500;
        usdc.mint(signer, amount);
        vm.prank(RELAYER);
        (, uint128 applied, uint128 toPrepaid) = settlement.settleWithPermit2(
            signer, SERVICE, USDC, amount, NONCE, deadline, _signSettlement(amount, NONCE, deadline)
        );
        assertEq(applied, PRICE, "tab paid down");
        assertEq(toPrepaid, 500, "excess banked");
        assertEq(book.tabOf(book.tabIdOf(signer, SERVICE, USDC)).prepaid, 500, "prepaid credit recorded");
    }

    function test_theAgentMaySubmitItsOwnPermit2Settlement() public {
        _deliverToSigner(2);
        uint128 amount = 2 * UNIT;
        usdc.mint(signer, amount);
        vm.prank(signer);
        settlement.settleWithPermit2(
            signer, SERVICE, USDC, amount, NONCE, deadline, _signSettlement(amount, NONCE, deadline)
        );
        assertEq(book.assetOpen(signer, USDC), 0, "settled");
    }

    // ------------------------------------------------------------------ the signature is the authority

    function test_aRelayerCannotResizeRedirectOrReassignASignedSettlement() public {
        _deliverToSigner(10);
        uint128 amount = 4 * UNIT;
        usdc.mint(signer, 10 * PRICE);
        bytes memory signature = _signSettlement(amount, NONCE, deadline);

        vm.startPrank(RELAYER);
        // More than was signed for.
        vm.expectRevert(SignatureVerification.InvalidSigner.selector);
        settlement.settleWithPermit2(signer, SERVICE, USDC, amount + 1, NONCE, deadline, signature);
        // Less than was signed for: the witness still names the signed amount.
        vm.expectRevert(SignatureVerification.InvalidSigner.selector);
        settlement.settleWithPermit2(signer, SERVICE, USDC, amount - 1, NONCE, deadline, signature);
        // Towards another Service.
        vm.expectRevert(SignatureVerification.InvalidSigner.selector);
        settlement.settleWithPermit2(signer, SERVICE_TWO, USDC, amount, NONCE, deadline, signature);
        // In another Asset.
        vm.expectRevert(SignatureVerification.InvalidSigner.selector);
        settlement.settleWithPermit2(signer, SERVICE, AUSD, amount, NONCE, deadline, signature);
        // On somebody else's behalf.
        vm.expectRevert(SignatureVerification.InvalidSigner.selector);
        settlement.settleWithPermit2(AGENT, SERVICE, USDC, amount, NONCE, deadline, signature);
        // With a different nonce or deadline.
        vm.expectRevert(SignatureVerification.InvalidSigner.selector);
        settlement.settleWithPermit2(signer, SERVICE, USDC, amount, NONCE + 1, deadline, signature);
        vm.expectRevert(SignatureVerification.InvalidSigner.selector);
        settlement.settleWithPermit2(signer, SERVICE, USDC, amount, NONCE, deadline + 1, signature);
        vm.stopPrank();

        assertEq(book.assetOpen(signer, USDC), 10 * PRICE, "nothing applied");
        assertEq(usdc.balanceOf(signer), 10 * PRICE, "nothing moved");
        assertEq(book.settlementCount(), 0, "nothing recorded");
    }

    function test_aWitnessForAnotherSurfaceIsRefused() public {
        _deliverToSigner(1);
        uint128 amount = UNIT;
        usdc.mint(signer, amount);
        // Signed with the right facts but a witness bound to a different surface.
        TabSettlement other = new TabSettlement(address(registry), address(book), permit2);
        bytes memory signature = _sign(
            signerKey, _digest(USDC, amount, NONCE, deadline, other.witnessHash(SERVICE, USDC, amount))
        );
        vm.prank(RELAYER);
        vm.expectRevert(SignatureVerification.InvalidSigner.selector);
        settlement.settleWithPermit2(signer, SERVICE, USDC, amount, NONCE, deadline, signature);
    }

    function test_aSignatureFromAnyoneButTheAgentIsRefused() public {
        _deliverToSigner(1);
        uint128 amount = UNIT;
        usdc.mint(signer, amount);
        (, uint256 impostorKey) = makeAddrAndKey("impostor");
        bytes memory signature = _sign(
            impostorKey, _digest(USDC, amount, NONCE, deadline, settlement.witnessHash(SERVICE, USDC, amount))
        );
        vm.prank(RELAYER);
        vm.expectRevert(SignatureVerification.InvalidSigner.selector);
        settlement.settleWithPermit2(signer, SERVICE, USDC, amount, NONCE, deadline, signature);
    }

    function test_aReplayedNonceIsRefused() public {
        _deliverToSigner(4);
        uint128 amount = UNIT;
        usdc.mint(signer, 4 * PRICE);
        bytes memory signature = _signSettlement(amount, NONCE, deadline);
        vm.prank(RELAYER);
        settlement.settleWithPermit2(signer, SERVICE, USDC, amount, NONCE, deadline, signature);
        vm.prank(RELAYER);
        vm.expectRevert(abi.encodeWithSignature("InvalidNonce()"));
        settlement.settleWithPermit2(signer, SERVICE, USDC, amount, NONCE, deadline, signature);
        assertEq(book.assetOpen(signer, USDC), 3 * PRICE, "applied once");
        assertEq(usdc.balanceOf(COLLECTION), PRICE, "paid once");
        // A fresh nonce over the same facts is a fresh Settlement.
        vm.prank(RELAYER);
        settlement.settleWithPermit2(
            signer, SERVICE, USDC, amount, NONCE + 1, deadline, _signSettlement(amount, NONCE + 1, deadline)
        );
        assertEq(book.assetOpen(signer, USDC), 2 * PRICE, "applied again under its own nonce");
    }

    function test_anExpiredDeadlineIsRefused() public {
        _deliverToSigner(1);
        uint128 amount = UNIT;
        usdc.mint(signer, amount);
        bytes memory signature = _signSettlement(amount, NONCE, deadline);
        vm.warp(deadline + 1);
        vm.prank(RELAYER);
        vm.expectRevert(abi.encodeWithSignature("SignatureExpired(uint256)", deadline));
        settlement.settleWithPermit2(signer, SERVICE, USDC, amount, NONCE, deadline, signature);
        // The deadline itself is still good.
        vm.warp(deadline);
        vm.prank(RELAYER);
        settlement.settleWithPermit2(signer, SERVICE, USDC, amount, NONCE, deadline, signature);
        assertEq(book.assetOpen(signer, USDC), 0, "settled at the deadline");
    }

    // ------------------------------------------------------------------ atomicity

    function test_aFailedPermit2TransferUnwindsTheLedgerEntry() public {
        _deliverToSigner(10);
        uint128 amount = 10 * UNIT;
        // A valid signature, but the Agent holds nothing, so Permit2's transfer fails.
        bytes memory signature = _signSettlement(amount, NONCE, deadline);
        vm.prank(RELAYER);
        vm.expectRevert();
        settlement.settleWithPermit2(signer, SERVICE, USDC, amount, NONCE, deadline, signature);
        assertEq(book.tabOf(book.tabIdOf(signer, SERVICE, USDC)).open, 10 * PRICE, "tab untouched");
        assertEq(book.settlementCount(), 0, "no settlement recorded");
        (, uint32 count) = book.historyCommitment(signer, USDC);
        assertEq(count, 0, "history untouched");
        assertFalse(_nonceSpent(signer, NONCE), "the nonce is still unspent");
        // Funded, the same signature settles.
        usdc.mint(signer, amount);
        vm.prank(RELAYER);
        settlement.settleWithPermit2(signer, SERVICE, USDC, amount, NONCE, deadline, signature);
        assertEq(book.assetOpen(signer, USDC), 0, "settled once funded");
    }

    function test_aRefusedSettlementSpendsNoNonce() public {
        // The book refuses before Permit2 is reached: an unaccepted Asset.
        uint128 amount = UNIT;
        bytes memory signature =
            _sign(signerKey, _digest(address(0xBAD), amount, NONCE, deadline, bytes32(0)));
        vm.prank(RELAYER);
        vm.expectRevert();
        settlement.settleWithPermit2(signer, SERVICE, address(0xBAD), amount, NONCE, deadline, signature);
        assertFalse(_nonceSpent(signer, NONCE), "nonce untouched");
        assertEq(book.settlementCount(), 0, "nothing recorded");
    }

    function test_withoutAPermit2ApprovalTheSignatureAloneMovesNothing() public {
        (address unapproved, uint256 unapprovedKey) = makeAddrAndKey("unapproved");
        _authorise(unapproved, SERVICE, USDC, AUTH_MAX);
        uint128 amount = UNIT;
        usdc.mint(unapproved, amount);
        bytes32 witness = settlement.witnessHash(SERVICE, USDC, amount);
        bytes memory signature = _sign(unapprovedKey, _digest(USDC, amount, NONCE, deadline, witness));
        vm.prank(RELAYER);
        vm.expectRevert();
        settlement.settleWithPermit2(unapproved, SERVICE, USDC, amount, NONCE, deadline, signature);
        assertEq(usdc.balanceOf(unapproved), amount, "nothing moved");
    }
}
