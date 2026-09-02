/**
 * Who may charge, and who may be charged.
 *
 * The signature cases matter because the gateway holds the key that can charge any
 * Agent up to its whole authorisation ceiling. A signature bound only to a path
 * would be a bearer token that replays against a different Agent for a different
 * amount, so the tests below check that changing any bound field invalidates it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";

import {
  authorisationCovers,
  meteringDigest,
  verifyMeteringRequest,
  SIGNATURE_WINDOW_MS,
} from "../dist/authorisation.js";
import { loadGatewayConfig } from "../dist/config.js";

const OPERATOR = new Wallet(`0x${"11".repeat(32)}`);
const STRANGER = new Wallet(`0x${"22".repeat(32)}`);
const NOW = 1_788_700_000_000;

const CLAIM = {
  method: "POST",
  path: "/meter/proof",
  agent: "0x1f6f797edc2eecb02bd54009b805fb2e99f80542",
  tool: `0x${"33".repeat(32)}`,
  units: 1,
  issuedAt: NOW,
};

const sign = (claim, wallet = OPERATOR) => wallet.signMessage(meteringDigest(claim));

test("a request signed by the operator inside the window is accepted", async () => {
  const verified = verifyMeteringRequest(CLAIM, await sign(CLAIM), OPERATOR.address, NOW);
  assert.equal(verified.ok, true);
  assert.equal(verified.value.signer, OPERATOR.address.toLowerCase());
});

test("a signature from anyone else is refused, however well formed", async () => {
  const verified = verifyMeteringRequest(CLAIM, await sign(CLAIM, STRANGER), OPERATOR.address, NOW);
  assert.equal(verified.ok, false);
  assert.equal(verified.error.code, "METERING_SIGNATURE_NOT_OPERATOR");
});

test("every bound field is bound: changing one invalidates the signature", async () => {
  const signature = await sign(CLAIM);
  const mutations = [
    ["agent", { ...CLAIM, agent: `0x${"99".repeat(20)}` }],
    ["units", { ...CLAIM, units: 100 }],
    ["tool", { ...CLAIM, tool: `0x${"44".repeat(32)}` }],
    ["path", { ...CLAIM, path: "/meter/other" }],
    ["method", { ...CLAIM, method: "GET" }],
  ];
  for (const [name, claim] of mutations) {
    const verified = verifyMeteringRequest(claim, signature, OPERATOR.address, NOW);
    assert.equal(verified.ok, false, `${name} is not bound by the digest`);
    assert.equal(verified.error.code, "METERING_SIGNATURE_NOT_OPERATOR");
  }
});

test("a stale signature is refused, and so is one dated into the future", async () => {
  const past = { ...CLAIM, issuedAt: NOW - SIGNATURE_WINDOW_MS - 1000 };
  const future = { ...CLAIM, issuedAt: NOW + SIGNATURE_WINDOW_MS + 1000 };
  for (const claim of [past, future]) {
    const verified = verifyMeteringRequest(claim, await sign(claim), OPERATOR.address, NOW);
    assert.equal(verified.ok, false);
    assert.equal(verified.error.code, "METERING_SIGNATURE_STALE");
  }
});

test("a malformed signature is an error rather than a throw", () => {
  const verified = verifyMeteringRequest(CLAIM, "0xnotasignature", OPERATOR.address, NOW);
  assert.equal(verified.ok, false);
  assert.equal(verified.error.code, "METERING_SIGNATURE_MALFORMED");
});

// ------------------------------------------------------------- authorisation

const authorisation = (over = {}) => ({
  maxCumulative: 4_000_000n,
  spent: 0n,
  expiry: 1_791_000_000n,
  exists: true,
  remaining: 4_000_000n,
  ...over,
});

test("an authorisation with room covers the charge", () => {
  assert.equal(authorisationCovers(authorisation(), 10_000n, 1_788_700_000n).ok, true);
});

test("no authorisation names the call the Agent itself has to make", () => {
  const covered = authorisationCovers(authorisation({ exists: false }), 10_000n, 1_788_700_000n);
  assert.equal(covered.ok, false);
  assert.equal(covered.error.code, "AUTHORISATION_MISSING");
  assert.match(covered.error.message, /the Agent itself must call TabBook.authorise/);
});

test("an expired authorisation is refused even with room left", () => {
  const covered = authorisationCovers(authorisation({ expiry: 1n }), 10_000n, 1_788_700_000n);
  assert.equal(covered.ok, false);
  assert.equal(covered.error.code, "AUTHORISATION_EXPIRED");
});

test("a charge past the remaining ceiling is refused and names both figures", () => {
  const covered = authorisationCovers(
    authorisation({ spent: 3_999_000n, remaining: 1_000n }),
    10_000n,
    1_788_700_000n,
  );
  assert.equal(covered.ok, false);
  assert.equal(covered.error.code, "AUTHORISATION_EXCEEDED");
  assert.match(covered.error.message, /1000 left/);
});

// -------------------------------------------------------------------- config

const ENV = {
  CREDITCOIN_RPC_URL: "https://rpc.example",
  CREDITCOIN_CHAIN_ID: "102031",
  TAB_BOOK_ADDRESS: `0x${"11".repeat(20)}`,
  SERVICE_REGISTRY_ADDRESS: `0x${"22".repeat(20)}`,
  BOND_ADDRESS: `0x${"33".repeat(20)}`,
};

test("a complete environment loads, and batching defaults to one", () => {
  const config = loadGatewayConfig(ENV);
  assert.equal(config.ok, true);
  assert.equal(config.value.batchMaxCount, 1);
  assert.equal(config.value.baseline, 5_000_000n);
  assert.equal(config.value.operatorKey, undefined);
});

test("a zero-address contract is refused by name, because it is not deployed", () => {
  const config = loadGatewayConfig({ ...ENV, TAB_BOOK_ADDRESS: `0x${"0".repeat(40)}` });
  assert.equal(config.ok, false);
  assert.equal(config.error.details.variable, "TAB_BOOK_ADDRESS");
  assert.match(config.error.message, /zero-address placeholder/);
});

test("the template's non-hexadecimal key placeholder reads as absent, not as a key", () => {
  const config = loadGatewayConfig({ ...ENV, GATEWAY_PRIVATE_KEY: "0xREPLACE_WITH_YOUR_OWN_64_HEX_CHARACTER_KEY" });
  assert.equal(config.ok, true);
  assert.equal(config.value.operatorKey, undefined);
});

test("a real key is carried through", () => {
  const config = loadGatewayConfig({ ...ENV, GATEWAY_PRIVATE_KEY: `0x${"ab".repeat(32)}` });
  assert.equal(config.ok, true);
  assert.equal(config.value.operatorKey, `0x${"ab".repeat(32)}`);
});
