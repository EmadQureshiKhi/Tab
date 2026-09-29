import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256Ascii } from "@tabai/shared";

import { classifyRevert, createEthersMarker, markCalldata, MARK_DELINQUENT_SELECTOR, SKIP_SELECTORS } from "../dist/marker.js";
import { TAB_BOOK, tabIdFor, AGENT_A, SERVICE, MUSDC } from "./fake-chain.mjs";

const TAB = tabIdFor(AGENT_A, SERVICE, MUSDC);
const selector = (signature) => keccak256Ascii(signature).slice(0, 10);

test("the mark calldata is markDelinquent(bytes32) with the id as its one word", () => {
  assert.equal(MARK_DELINQUENT_SELECTOR, selector("markDelinquent(bytes32)"));
  assert.equal(markCalldata(TAB), `${MARK_DELINQUENT_SELECTOR}${TAB.slice(2)}`);
});

test("the four reverts markDelinquent can raise are classified by selector, and nothing else is", () => {
  assert.equal(classifyRevert(`${selector("AlreadyDelinquent(bytes32)")}${TAB.slice(2)}`), "AlreadyDelinquent");
  assert.equal(classifyRevert(`${selector("NothingUnsettled(bytes32)")}${TAB.slice(2)}`), "NothingUnsettled");
  assert.equal(classifyRevert(`${selector("SettlementWindowOpen(bytes32,uint64)")}${TAB.slice(2)}${"0".repeat(64)}`), "SettlementWindowOpen");
  assert.equal(classifyRevert(`${selector("UnknownTab(bytes32)")}${TAB.slice(2)}`), "UnknownTab");
  assert.equal(classifyRevert(selector("LimitExceeded(address,address,uint256,uint256)")), undefined);
  assert.equal(classifyRevert("0x"), undefined);
  assert.equal(classifyRevert(undefined), undefined);
  assert.equal(Object.keys(SKIP_SELECTORS).length, 4);
});

/** A provider whose `call` throws what ethers throws on a revert. */
const provider = (behaviour) => ({
  async call(tx) {
    return behaviour(tx);
  },
});

test("simulate answers markable on a clean call and a skip on a known revert", async () => {
  const clean = createEthersMarker({ provider: provider(async () => "0x"), tabBook: TAB_BOOK });
  assert.deepEqual(await clean.simulate(TAB), { ok: true, value: { outcome: "markable" } });

  const marked = createEthersMarker({
    provider: provider(async () => {
      throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", data: `${selector("AlreadyDelinquent(bytes32)")}${TAB.slice(2)}` });
    }),
    tabBook: TAB_BOOK,
  });
  assert.deepEqual(await marked.simulate(TAB), { ok: true, value: { outcome: "skip", reason: "AlreadyDelinquent" } });
});

test("an unrecognised revert is a CHAIN error naming the selector; a dead node is UPSTREAM", async () => {
  const strange = createEthersMarker({
    provider: provider(async () => {
      throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", data: `${selector("ZeroAddressField()")}` });
    }),
    tabBook: TAB_BOOK,
  });
  const result = await strange.simulate(TAB);
  assert.ok(!result.ok);
  assert.equal(result.error.code, "MARK_SIMULATION_REVERTED");
  assert.equal(result.error.details.selector, selector("ZeroAddressField()"));

  const dead = createEthersMarker({
    provider: provider(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "NETWORK_ERROR" });
    }),
    tabBook: TAB_BOOK,
  });
  const down = await dead.simulate(TAB);
  assert.equal(down.error.code, "MARK_SIMULATION_FAILED");
  assert.equal(down.error.retryable, true);
});

test("simulate passes the signer's address as `from`, and send without a signer is KEEPER_KEY_MISSING", async () => {
  const seen = [];
  const signer = { getAddress: async () => "0x00000000000000000000000000000000000000ee", sendTransaction: async () => { throw new Error("unused"); } };
  const marker = createEthersMarker({ provider: provider(async (tx) => { seen.push(tx); return "0x"; }), tabBook: TAB_BOOK, signer });
  await marker.simulate(TAB);
  assert.equal(seen[0].from, "0x00000000000000000000000000000000000000ee");
  assert.equal(seen[0].to, TAB_BOOK);

  const keyless = createEthersMarker({ provider: provider(async () => "0x"), tabBook: TAB_BOOK });
  const sent = await keyless.send(TAB);
  assert.equal(sent.error.code, "KEEPER_KEY_MISSING");
});

test("send returns the hash and block, and reports a mined revert as MARK_REVERTED", async () => {
  const good = { getAddress: async () => "0x00000000000000000000000000000000000000ee", sendTransaction: async () => ({ hash: `0x${"ab".repeat(32)}`, wait: async () => ({ status: 1, blockNumber: 7 }) }) };
  const marker = createEthersMarker({ provider: provider(async () => "0x"), tabBook: TAB_BOOK, signer: good });
  assert.deepEqual(await marker.send(TAB), { ok: true, value: { txHash: `0x${"ab".repeat(32)}`, blockNumber: 7 } });

  const reverting = { ...good, sendTransaction: async () => ({ hash: `0x${"cd".repeat(32)}`, wait: async () => ({ status: 0, blockNumber: 8 }) }) };
  const bad = createEthersMarker({ provider: provider(async () => "0x"), tabBook: TAB_BOOK, signer: reverting });
  const result = await bad.send(TAB);
  assert.equal(result.error.code, "MARK_REVERTED");
});
