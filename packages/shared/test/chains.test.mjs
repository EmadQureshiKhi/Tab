/**
 * Chain, Asset and third-party contract constants.
 *
 * Every address here is a published fact about Monad rather than a Tab
 * deployment output, which is why it lives in code and not in
 * `deployments.json`. The ERC-8004 topics are checked against digests computed
 * independently with `cast sig-event`.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  ERC8004_EVENT_TOPIC0,
  ERC8004_IDENTITY_REGISTRY_ABI,
  ERC8004_REGISTRIES,
  ERC8004_REPUTATION_REGISTRY_ABI,
  MAINNET_ASSETS,
  METERING_DELEGATES,
  METERING_DELEGATES_ABI,
  TAB_SETTLEMENT_FEEDBACK,
  MONAD_MAINNET,
  MONAD_TESTNET,
  TESTNET_ASSETS,
  X402_FACILITATOR_URL,
  erc8004RegistriesFor,
  meteringDelegatesFor,
  isAddress,
  keccak256Ascii,
} from "../dist/index.js";

test("the testnet USDC is Circle's, six decimals, beside the mainnet Assets", () => {
  assert.equal(TESTNET_ASSETS.USDC.address, "0x534b2f3A21130d7a60830c2Df862319e593943A3");
  assert.equal(TESTNET_ASSETS.USDC.decimals, 6);
  assert.equal(TESTNET_ASSETS.USDC.symbol, "USDC");
  assert.equal(MAINNET_ASSETS.USDC.decimals, TESTNET_ASSETS.USDC.decimals);
  assert.notEqual(MAINNET_ASSETS.USDC.address, TESTNET_ASSETS.USDC.address);
});

test("the ERC-8004 registries are keyed by chain id and resolve by number or bigint", () => {
  assert.deepEqual(ERC8004_REGISTRIES[MONAD_MAINNET.chainId], {
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  });
  assert.deepEqual(ERC8004_REGISTRIES[MONAD_TESTNET.chainId], {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  });
  assert.equal(erc8004RegistriesFor(10143n), ERC8004_REGISTRIES[10143]);
  assert.equal(erc8004RegistriesFor(143), ERC8004_REGISTRIES[143]);
  assert.equal(erc8004RegistriesFor(1), undefined);
  for (const registries of Object.values(ERC8004_REGISTRIES)) {
    assert.ok(isAddress(registries.identity));
    assert.ok(isAddress(registries.reputation));
  }
});

test("the x402 facilitator is an https origin", () => {
  assert.equal(X402_FACILITATOR_URL, "https://x402-facilitator.molandak.org");
  assert.equal(new URL(X402_FACILITATOR_URL).origin, X402_FACILITATOR_URL);
});

test("the ERC-8004 event topics match cast sig-event", () => {
  assert.equal(
    ERC8004_EVENT_TOPIC0.Registered,
    "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a",
  );
  assert.equal(
    ERC8004_EVENT_TOPIC0.URIUpdated,
    "0x3a2c7fffc2cba7582c690e3b82c453ea02a308326a98a3ad7576c606336409fb",
  );
  assert.equal(
    ERC8004_EVENT_TOPIC0.NewFeedback,
    "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc",
  );
});

test("the ERC-8004 fragments carry what the scripts and the indexer call", () => {
  const has = (abi, prefix) => abi.some((fragment) => fragment.startsWith(prefix));
  assert.ok(has(ERC8004_IDENTITY_REGISTRY_ABI, "function register(string agentURI)"));
  assert.ok(has(ERC8004_IDENTITY_REGISTRY_ABI, "function setAgentURI(uint256 agentId, string newURI)"));
  assert.ok(has(ERC8004_IDENTITY_REGISTRY_ABI, "function tokenURI(uint256 tokenId)"));
  assert.ok(has(ERC8004_IDENTITY_REGISTRY_ABI, "function ownerOf(uint256 tokenId)"));
  assert.ok(has(ERC8004_IDENTITY_REGISTRY_ABI, "event Registered(uint256 indexed agentId"));
  assert.ok(has(ERC8004_REPUTATION_REGISTRY_ABI, "function giveFeedback(uint256 agentId, int128 value"));
  assert.ok(has(ERC8004_REPUTATION_REGISTRY_ABI, "function getSummary(uint256 agentId"));
  assert.ok(has(ERC8004_REPUTATION_REGISTRY_ABI, "event NewFeedback(uint256 indexed agentId"));
  // Every fragment is a single declaration with balanced parentheses.
  for (const fragment of [...ERC8004_IDENTITY_REGISTRY_ABI, ...ERC8004_REPUTATION_REGISTRY_ABI]) {
    assert.match(fragment, /^(function|event) [A-Za-z0-9_]+\(/);
    assert.equal(fragment.split("(").length, fragment.split(")").length);
  }
});

test("MeteringDelegates is known on a network exactly when deployments.json records it there", () => {
  const path = resolve(import.meta.dirname, "..", "..", "..", "deployments.json");
  if (!existsSync(path)) return;
  const networks = JSON.parse(readFileSync(path, "utf8")).networks;
  for (const chainId of [MONAD_MAINNET.chainId, MONAD_TESTNET.chainId]) {
    const recorded = networks[String(chainId)]?.contracts?.MeteringDelegates;
    const known = METERING_DELEGATES[chainId];
    if (recorded === undefined) {
      assert.equal(known, undefined, `chain ${chainId}: no MeteringDelegates is recorded, so none may be assumed`);
    } else {
      assert.ok(known !== undefined, `chain ${chainId}: deployments.json records MeteringDelegates; fill it in here`);
      assert.equal(known.toLowerCase(), recorded.address.toLowerCase(), `chain ${chainId}`);
      assert.equal(recorded.envKey, "METERING_DELEGATES_ADDRESS");
    }
    assert.equal(meteringDelegatesFor(chainId), known);
    assert.equal(meteringDelegatesFor(BigInt(chainId)), known);
  }
  assert.equal(meteringDelegatesFor(1), undefined, "not a Monad network");
});

test("the MeteringDelegates fragments carry what the gateway and the plugin call", () => {
  const has = (prefix) => METERING_DELEGATES_ABI.some((fragment) => fragment.startsWith(prefix));
  assert.ok(has("function setDelegate(address delegate, uint64 expiry)"));
  assert.ok(has("function revokeDelegate(address delegate)"));
  assert.ok(has("function isDelegate(address agent, address delegate) view returns (bool)"));
  assert.ok(has("function expiryOf(address agent, address delegate) view returns (uint64"));
  for (const fragment of METERING_DELEGATES_ABI) {
    assert.match(fragment, /^(function|event|error) [A-Za-z0-9_]+\(/);
    assert.equal(fragment.split("(").length, fragment.split(")").length);
  }
});

test("the Reputation calls Tab makes are the selectors the deployed 2.0.0 implementation dispatches", () => {
  // Read off the implementation behind both canonical proxies (EIP-1967 slot
  // 0x360894...382bbc -> 0x16e0fa7f7c56b9a767e34b192b51f921be31da34, the same
  // runtime bytecode on Monad Mainnet, Monad Testnet and Ethereum, where it is
  // verified). Each selector below appears as a PUSH4 in that bytecode.
  const selector = (signature) => keccak256Ascii(signature).slice(0, 10);
  assert.equal(selector("giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)"), "0x3c036a7e");
  assert.equal(selector("getSummary(uint256,address[],string,string)"), "0x81bbba58");
  assert.equal(selector("readAllFeedback(uint256,address[],string,string,bool)"), "0xd9d84224");
  assert.equal(selector("getClients(uint256)"), "0x42dd519c");
});

test("the settlement feedback is one fixed positive value under two short tags", () => {
  assert.equal(TAB_SETTLEMENT_FEEDBACK.value, 100n);
  assert.equal(TAB_SETTLEMENT_FEEDBACK.valueDecimals, 0);
  assert.equal(TAB_SETTLEMENT_FEEDBACK.tag1, "tab");
  assert.equal(TAB_SETTLEMENT_FEEDBACK.tag2, "settled");
});
