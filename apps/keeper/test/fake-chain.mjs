/**
 * A fake Monad node: answers the four reads the keeper makes over JSON-RPC, from
 * a table of tabs, so `readOverdueTabs` runs unchanged against it.
 */

import { keccak256Ascii } from "@tabai/shared";

import {
  SETTLEMENT_WINDOW_OF_SELECTOR,
  TAB_ID_OF_SELECTOR,
  TAB_OF_SELECTOR,
  TAB_REF_OF_SELECTOR,
} from "../dist/overdue.js";
import { addressArg, bytes32Arg, uintArg } from "../dist/chain.js";

export const TAB_BOOK = "0x00000000000000000000000000000000000000b0";
export const SERVICE_REGISTRY = "0x00000000000000000000000000000000000000c0";
export const SERVICE = "0x7461622e64656d6f000000000000000000000000000000000000000000000000";
/** The Testnet `MockUsdc`, named `mUSDC` everywhere the rail prints a symbol. */
export const MUSDC = "0x480209747417f5c830fda188a9b9acfa70bc4083";
export const AGENT_A = "0x00000000000000000000000000000000000000a1";
export const AGENT_B = "0x00000000000000000000000000000000000000a2";
export const AGENT_C = "0x00000000000000000000000000000000000000a3";
export const AGENT_D = "0x00000000000000000000000000000000000000a4";

export const WINDOW = 21_600;
export const NOW = 1_800_000_000;

/** A tab id that is a pure function of the triple, as `tabIdOf` is. */
export const tabIdFor = (agent, serviceId, asset) => keccak256Ascii(`${agent.toLowerCase()}:${serviceId.toLowerCase()}:${asset.toLowerCase()}`);

/**
 * Four tabs: A overdue, B still inside its window, C already marked, D settled.
 */
export function defaultTabs() {
  return [
    { agent: AGENT_A, serviceId: SERVICE, asset: MUSDC, open: 10_000n, prepaid: 0n, oldestUnsettledAt: NOW - WINDOW - 60, lastDeliveryAt: NOW - 100, deliveryCount: 3, delinquent: false },
    { agent: AGENT_B, serviceId: SERVICE, asset: MUSDC, open: 5_000n, prepaid: 0n, oldestUnsettledAt: NOW - 100, lastDeliveryAt: NOW - 100, deliveryCount: 1, delinquent: false },
    { agent: AGENT_C, serviceId: SERVICE, asset: MUSDC, open: 7_000n, prepaid: 0n, oldestUnsettledAt: NOW - WINDOW - 5_000, lastDeliveryAt: NOW - 5_000, deliveryCount: 2, delinquent: true },
    { agent: AGENT_D, serviceId: SERVICE, asset: MUSDC, open: 0n, prepaid: 2_000n, oldestUnsettledAt: 0, lastDeliveryAt: NOW - 9_000, deliveryCount: 4, delinquent: false },
  ];
}

const word = (value) => uintArg(value);

/** The `fetch` a `ChainReader` posts to, answering from the table. */
export function fakeRpc({ tabs = defaultTabs(), blockNumber = 100, timestamp = NOW, windows = { [SERVICE]: WINDOW } } = {}) {
  const byId = new Map(tabs.map((tab) => [tabIdFor(tab.agent, tab.serviceId, tab.asset), tab]));
  const calls = [];
  const send = async (_url, init) => {
    const request = JSON.parse(init.body);
    calls.push(request);
    const reply = (result) => ({ status: 200, json: async () => ({ jsonrpc: "2.0", id: request.id, result }) });
    if (request.method === "eth_chainId") return reply("0x279f");
    if (request.method === "eth_getBlockByNumber") return reply({ number: `0x${blockNumber.toString(16)}`, timestamp: `0x${timestamp.toString(16)}` });
    if (request.method === "eth_call") {
      const { to, data } = request.params[0];
      const selector = data.slice(0, 10);
      const arg = (index) => data.slice(10 + index * 64, 10 + (index + 1) * 64);
      if (to.toLowerCase() === TAB_BOOK && selector === TAB_ID_OF_SELECTOR) {
        const id = tabIdFor(`0x${arg(0).slice(24)}`, `0x${arg(1)}`, `0x${arg(2).slice(24)}`);
        return reply(id);
      }
      if (to.toLowerCase() === TAB_BOOK && selector === TAB_OF_SELECTOR) {
        const tab = byId.get(`0x${arg(0)}`);
        if (tab === undefined) return reply(`0x${"0".repeat(64 * 6)}`);
        return reply(`0x${word(tab.open)}${word(tab.prepaid)}${word(tab.oldestUnsettledAt)}${word(tab.lastDeliveryAt)}${word(tab.deliveryCount)}${word(tab.delinquent ? 1 : 0)}`);
      }
      if (to.toLowerCase() === TAB_BOOK && selector === TAB_REF_OF_SELECTOR) {
        const tab = byId.get(`0x${arg(0)}`);
        if (tab === undefined) return reply(`0x${"0".repeat(64 * 4)}`);
        return reply(`0x${addressArg(tab.agent)}${bytes32Arg(tab.serviceId)}${addressArg(tab.asset)}${word(1)}`);
      }
      if (to.toLowerCase() === SERVICE_REGISTRY && selector === SETTLEMENT_WINDOW_OF_SELECTOR) {
        return reply(`0x${word(windows[`0x${arg(0)}`] ?? 0)}`);
      }
      return { status: 200, json: async () => ({ jsonrpc: "2.0", id: request.id, error: { message: `unexpected call ${selector} to ${to}` } }) };
    }
    return { status: 200, json: async () => ({ jsonrpc: "2.0", id: request.id, error: { message: `unexpected method ${request.method}` } }) };
  };
  send.calls = calls;
  return send;
}

/** A marker that answers from a table and records what it sent. */
export function fakeMarker({ verdicts = {}, sendError } = {}) {
  const sent = [];
  const simulated = [];
  return {
    sent,
    simulated,
    async simulate(tabId) {
      simulated.push(tabId);
      const verdict = verdicts[tabId];
      if (verdict === undefined) return { ok: true, value: { outcome: "markable" } };
      if (verdict.error) return { ok: false, error: verdict.error };
      return { ok: true, value: verdict };
    },
    async send(tabId) {
      sent.push(tabId);
      if (sendError !== undefined) return { ok: false, error: sendError };
      return { ok: true, value: { txHash: `0x${sent.length.toString(16).padStart(64, "0")}`, blockNumber: 101 } };
    },
  };
}
