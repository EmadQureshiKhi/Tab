/**
 * Resolving the cast, and every way it can refuse.
 *
 * These are the failures a person actually hits: a `.env` copied from the
 * template and not filled in, an address with a typo, a second Agent that was
 * never given its own identity. Each refusal has to name the variable, because
 * the alternative is an `eth_call` against an account with no code half a minute
 * into a live run.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { agentNamed, address, firstEndpoint, resolveCast, serviceIdOf } from "../dist/cast.js";

const COMPLETE = {
  CREDITCOIN_RPC_URL: "https://rpc.example.invalid",
  ETHEREUM_SEPOLIA_RPC_URLS: "https://one.example.invalid,https://two.example.invalid",
  TAB_BOOK_ADDRESS: "0x047ECFB428FE706eA391B626872Ce8Deb8756c5f",
  AGENT_REGISTRY_ADDRESS: "0x4721f24974be89287F5C34aeE4D15D20389A2a8B",
  SERVICE_REGISTRY_ADDRESS: "0xF6Bb0d068698e504e2F21ca61c48167634a1fcAC",
  BOND_ADDRESS: "0xDbB6C19A4236ACdd8535E993C5fA93E6Ff1f173A",
  SEPOLIA_USDC_ADDRESS: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  PROOF_SERVICE_COLLECTION_ADDRESS: "0x952AcC70E6f54Ce87Dca963193A5957BCb27729e",
  GATEWAY_SERVICE_ID: "tab.proof-service",
  GATEWAY_PORT: "8788",
  DEMO_AGENT_ONE_CREDITCOIN_ADDRESS: "0x1F6f797Edc2EECb02BD54009B805fb2E99F80542",
  DEMO_AGENT_ONE_ETHEREUM_ADDRESS: "0xA302940db97345c5aDAF8dA23Ff46Ae63613d728",
  DEMO_AGENT_TWO_CREDITCOIN_ADDRESS: "0xE5eaB26CaE0855BcCaBBb9A64faFce28C8432b37",
  DEMO_AGENT_TWO_ETHEREUM_ADDRESS: "0xE5eaB26CaE0855BcCaBBb9A64faFce28C8432b37",
  DEMO_AGENT_TWO_SMART_ACCOUNT_ADDRESS: "0x623B7059c9E67C690594085D280d50449Eb7D1d9",
};

const without = (name) => {
  const copy = { ...COMPLETE };
  delete copy[name];
  return copy;
};

test("a complete environment resolves both agents and the smart account", () => {
  const resolved = resolveCast(COMPLETE);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.value.agents.length, 2);
  assert.equal(resolved.value.agents[0].name, "Ada");
  assert.equal(resolved.value.agents[0].smartAccount, undefined);
  assert.equal(resolved.value.agents[1].name, "Bex");
  assert.equal(
    resolved.value.agents[1].smartAccount,
    "0x623B7059c9E67C690594085D280d50449Eb7D1d9",
  );
  assert.equal(resolved.value.asset.symbol, "USDC");
  assert.equal(resolved.value.asset.decimals, 6);
  assert.equal(resolved.value.asset.chainKey, 1n);
});

test("the first endpoint of a comma-separated list is the one used", () => {
  const resolved = resolveCast(COMPLETE);
  assert.equal(resolved.value.sourceRpcUrl, "https://one.example.invalid");
});

test("a missing variable is refused by name", () => {
  for (const name of [
    "CREDITCOIN_RPC_URL",
    "ETHEREUM_SEPOLIA_RPC_URLS",
    "TAB_BOOK_ADDRESS",
    "AGENT_REGISTRY_ADDRESS",
    "SERVICE_REGISTRY_ADDRESS",
    "BOND_ADDRESS",
    "SEPOLIA_USDC_ADDRESS",
    "PROOF_SERVICE_COLLECTION_ADDRESS",
    "GATEWAY_SERVICE_ID",
    "DEMO_AGENT_ONE_CREDITCOIN_ADDRESS",
    "DEMO_AGENT_ONE_ETHEREUM_ADDRESS",
    "DEMO_AGENT_TWO_CREDITCOIN_ADDRESS",
    "DEMO_AGENT_TWO_ETHEREUM_ADDRESS",
  ]) {
    const resolved = resolveCast(without(name));
    assert.equal(resolved.ok, false, `${name} should be required`);
    assert.match(resolved.error.message, new RegExp(name));
  }
});

test("the zero-address placeholder is refused rather than dialled", () => {
  const resolved = resolveCast({
    ...COMPLETE,
    TAB_BOOK_ADDRESS: "0x0000000000000000000000000000000000000000",
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.error.code, "DEMO_ENV_ZERO_ADDRESS");
});

test("a malformed address is refused and quoted back", () => {
  const resolved = resolveCast({ ...COMPLETE, BOND_ADDRESS: "0xnope" });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.error.code, "DEMO_ENV_NOT_ADDRESS");
  assert.match(resolved.error.message, /0xnope/);
});

test("two agents that are the same Agent are refused", () => {
  const resolved = resolveCast({
    ...COMPLETE,
    DEMO_AGENT_TWO_CREDITCOIN_ADDRESS: COMPLETE.DEMO_AGENT_ONE_CREDITCOIN_ADDRESS.toLowerCase(),
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.error.code, "DEMO_AGENTS_NOT_DISTINCT");
});

test("the smart account is optional, and malformed only when present", () => {
  const absent = resolveCast(without("DEMO_AGENT_TWO_SMART_ACCOUNT_ADDRESS"));
  assert.equal(absent.ok, true);
  assert.equal(absent.value.agents[1].smartAccount, undefined);

  const blank = resolveCast({ ...COMPLETE, DEMO_AGENT_TWO_SMART_ACCOUNT_ADDRESS: "   " });
  assert.equal(blank.ok, true);
  assert.equal(blank.value.agents[1].smartAccount, undefined);

  const wrong = resolveCast({ ...COMPLETE, DEMO_AGENT_TWO_SMART_ACCOUNT_ADDRESS: "0x12" });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, "DEMO_ENV_NOT_ADDRESS");
});

test("the gateway port falls back when it is absent or blank", () => {
  assert.equal(resolveCast(without("GATEWAY_PORT")).value.gatewayBaseUrl, "http://127.0.0.1:8788");
  assert.equal(
    resolveCast({ ...COMPLETE, GATEWAY_PORT: "" }).value.gatewayBaseUrl,
    "http://127.0.0.1:8788",
  );
  assert.equal(
    resolveCast({ ...COMPLETE, GATEWAY_PORT: "9001" }).value.gatewayBaseUrl,
    "http://127.0.0.1:9001",
  );
});

test("a serviceId is accepted as a short name or as the word it encodes", () => {
  const fromName = serviceIdOf({ ID: "tab.proof-service" }, "ID");
  assert.equal(
    fromName.value,
    "0x7461622e70726f6f662d73657276696365000000000000000000000000000000",
  );
  const fromWord = serviceIdOf({ ID: fromName.value }, "ID");
  assert.equal(fromWord.value, fromName.value);
});

test("a serviceId longer than 32 bytes is refused rather than truncated", () => {
  const tooLong = serviceIdOf({ ID: "x".repeat(33) }, "ID");
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error.code, "DEMO_SERVICE_ID_TOO_LONG");
});

test("an empty endpoint list is refused", () => {
  const empty = firstEndpoint({ LIST: " , " }, "LIST");
  assert.equal(empty.ok, false);
});

test("address refuses an absent value before it inspects it", () => {
  assert.equal(address({}, "NOPE").ok, false);
  assert.equal(address({ NOPE: "  " }, "NOPE").error.code, "DEMO_ENV_ABSENT");
});

test("agents are findable by name, case-insensitively, and absent names return nothing", () => {
  const cast = resolveCast(COMPLETE).value;
  assert.equal(agentNamed(cast, "ada").creditcoin, COMPLETE.DEMO_AGENT_ONE_CREDITCOIN_ADDRESS);
  assert.equal(agentNamed(cast, "  BEX ").creditcoin, COMPLETE.DEMO_AGENT_TWO_CREDITCOIN_ADDRESS);
  assert.equal(agentNamed(cast, "carol"), undefined);
});
