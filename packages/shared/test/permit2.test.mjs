/**
 * Gasless Settlement constants.
 *
 * The Solidity side pins `TabSettlement.WITNESS_TYPEHASH` and the full
 * `PermitWitnessTransferFrom` typehash to the two digests below in
 * `packages/contracts/test/TabSettlement.t.sol`. Pinning the TypeScript
 * constants to the same digests makes the two sides agree by construction: a
 * change to either type string fails one of the two suites.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_TOPIC0,
  PERMIT2_ADDRESS,
  PERMIT2_DOMAIN_NAME,
  PERMIT2_WITNESS_TRANSFER_FROM_PRIMARY_TYPE,
  PERMIT2_WITNESS_TRANSFER_FROM_STUB,
  PERMIT2_WITNESS_TRANSFER_FROM_TYPE,
  PERMIT2_WITNESS_TRANSFER_FROM_TYPEHASH,
  PERMIT2_WITNESS_TRANSFER_FROM_TYPES,
  PERMIT2_WITNESS_TYPE_STRING,
  TAB_SETTLEMENT_WITNESS_TYPE,
  TAB_SETTLEMENT_WITNESS_TYPEHASH,
  permit2Domain,
} from "../dist/index.js";

test("the witness typehash is the one the contract pins", () => {
  assert.equal(
    TAB_SETTLEMENT_WITNESS_TYPEHASH,
    "0xb444b2cac7d73fdf2a7a66647cdd116e206f326d63d5acc48510ff8daffd9a1b",
  );
});

test("the full primary typehash is the one Permit2 will hash", () => {
  assert.equal(
    PERMIT2_WITNESS_TRANSFER_FROM_TYPE,
    "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline," +
      "TabSettlement witness)" +
      "TabSettlement(bytes32 serviceId,address asset,uint128 amount,address surface,uint256 chainId)" +
      "TokenPermissions(address token,uint256 amount)",
  );
  assert.equal(
    PERMIT2_WITNESS_TRANSFER_FROM_TYPEHASH,
    "0xda0044b708b71ff59860e59a72c2eb5add58df8942faf130a94017fe9e640197",
  );
  assert.equal(PERMIT2_WITNESS_TRANSFER_FROM_STUB + PERMIT2_WITNESS_TYPE_STRING, PERMIT2_WITNESS_TRANSFER_FROM_TYPE);
});

test("the typed-data layout encodes to the same primary type", () => {
  // EIP-712: the primary type, then every referenced struct, sorted by name.
  const encode = (name) =>
    `${name}(${PERMIT2_WITNESS_TRANSFER_FROM_TYPES[name].map((f) => `${f.type} ${f.name}`).join(",")})`;
  const referenced = Object.keys(PERMIT2_WITNESS_TRANSFER_FROM_TYPES)
    .filter((name) => name !== PERMIT2_WITNESS_TRANSFER_FROM_PRIMARY_TYPE)
    .sort();
  const encoded = [PERMIT2_WITNESS_TRANSFER_FROM_PRIMARY_TYPE, ...referenced].map(encode).join("");
  assert.equal(encoded, PERMIT2_WITNESS_TRANSFER_FROM_TYPE);
  assert.deepEqual(referenced, ["TabSettlement", "TokenPermissions"]);
  assert.equal(TAB_SETTLEMENT_WITNESS_TYPE, encode("TabSettlement"));
});

test("Permit2's domain has a name, a chain and an address, and no version", () => {
  assert.equal(PERMIT2_ADDRESS, "0x000000000022D473030F116dDEE9F6B43aC78BA3");
  assert.equal(PERMIT2_DOMAIN_NAME, "Permit2");
  const domain = permit2Domain(10143, PERMIT2_ADDRESS);
  assert.deepEqual(domain, { name: "Permit2", chainId: 10143n, verifyingContract: PERMIT2_ADDRESS });
  assert.equal(permit2Domain(143n, PERMIT2_ADDRESS).chainId, 143n);
  assert.equal("version" in domain, false);
});

test("the SettledGasless topic is pinned", () => {
  assert.equal(
    EVENT_TOPIC0.SettledGasless,
    "0x792054b5aaf8637a0f2a1f6e854f955143ecddcfee733ff315cd9ea88f924cb2",
  );
});
