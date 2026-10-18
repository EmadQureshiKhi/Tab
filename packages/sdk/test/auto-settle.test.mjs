/**
 * Auto-settle: the policy on its own, and `tab_call` with it on.
 *
 * The policy is pure, so it is checked case by case. `tab_call` is driven with
 * the same Service and strategy doubles the tool tests use: a call that leaves
 * the tab at the Agent's amount is followed by a Settlement of the whole tab, a
 * call the limit refused is settled for and made once more, and with no policy
 * nothing about `tab_call` changes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decideAutoSettle, parseAutoSettleAt } from "../dist/payments/auto-settle.js";
import { createTabToolset } from "../dist/mcp/toolset.js";
import { resolveTabMcpSettings } from "../dist/mcp/settings.js";

const AGENT = "0x00000000000000000000000000000000000a9e17";
const SERVICE_ID = `0x${"5e".repeat(32)}`;
const MUSDC = "0x480209747417f5c830fda188a9b9acfa70bc4083";
const TOOL_KEY = "0x71756f74652e67656e6572617465000000000000000000000000000000000000";
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const ENV = {};

/* ----------------------------------------------------------- the policy */

test("the policy settles the whole tab, for the most urgent reason, and never an empty one", () => {
  const policy = { atBaseUnits: 50_000n, windowShare: 0.5 };
  assert.deepEqual(decideAutoSettle(policy, { openTab: 0n, delinquent: true, declined: true }), { settle: false }, "nothing open is nothing to settle");
  assert.deepEqual(decideAutoSettle(policy, { openTab: 10_000n }), { settle: false });
  assert.deepEqual(decideAutoSettle(policy, { openTab: 50_000n }), { settle: true, amount: 50_000n, reason: "threshold" });
  assert.deepEqual(decideAutoSettle(policy, { openTab: 10_000n, declined: true }), { settle: true, amount: 10_000n, reason: "limit" });
  assert.deepEqual(decideAutoSettle(policy, { openTab: 10_000n, delinquent: true, declined: true }), { settle: true, amount: 10_000n, reason: "delinquent" });
  // Half of a six-hour window: three hours after the oldest charge, and not a second before.
  const aged = { openTab: 10_000n, oldestUnsettledAt: 1_000n, windowSeconds: 21_600n };
  assert.deepEqual(decideAutoSettle(policy, { ...aged, now: 1_000n + 10_799n }), { settle: false });
  assert.deepEqual(decideAutoSettle(policy, { ...aged, now: 1_000n + 10_800n }), { settle: true, amount: 10_000n, reason: "window" });
  assert.deepEqual(decideAutoSettle({ atBaseUnits: 50_000n }, { ...aged, now: 99_999n }), { settle: false }, "without a window share, age alone settles nothing");
});

test("the amount is a whole number of base units, and anything else is refused by name", () => {
  assert.deepEqual(parseAutoSettleAt("500000"), { ok: true, value: { atBaseUnits: 500_000n } });
  assert.deepEqual(parseAutoSettleAt(500000), { ok: true, value: { atBaseUnits: 500_000n } });
  assert.deepEqual(parseAutoSettleAt(undefined), { ok: true, value: undefined });
  assert.deepEqual(parseAutoSettleAt(" "), { ok: true, value: undefined });
  for (const bad of ["0", "1.5", "-3", "half", "1e6"]) {
    const parsed = parseAutoSettleAt(bad);
    assert.equal(parsed.ok, false, bad);
    assert.equal(parsed.error.code, "AUTO_SETTLE_INVALID");
  }
});

test("settings take auto-settle from options, then tab.config, then TAB_AUTO_SETTLE_AT, and an invalid one leaves it off", async () => {
  const base = { agent: AGENT, hostedDefaults: false, logger: silent };
  assert.equal((await resolveTabMcpSettings({ ...base, config: false, env: {} })).autoSettle, undefined, "off unless asked for");
  const fromEnv = await resolveTabMcpSettings({ ...base, config: false, env: { TAB_AUTO_SETTLE_AT: "250000" } });
  assert.deepEqual(fromEnv.autoSettle, { atBaseUnits: 250_000n });
  assert.equal(fromEnv.sources.autoSettle, "env TAB_AUTO_SETTLE_AT");
  const fromConfig = await resolveTabMcpSettings({ ...base, config: { autoSettle: { atBaseUnits: "100000" } }, env: { TAB_AUTO_SETTLE_AT: "250000" } });
  assert.deepEqual(fromConfig.autoSettle, { atBaseUnits: 100_000n }, "tab.config beats the environment");
  const fromOptions = await resolveTabMcpSettings({ ...base, autoSettleAt: 7n, config: { autoSettle: { atBaseUnits: "100000" } }, env: {} });
  assert.deepEqual(fromOptions.autoSettle, { atBaseUnits: 7n });
  const invalid = await resolveTabMcpSettings({ ...base, config: false, env: { TAB_AUTO_SETTLE_AT: "lots" } });
  assert.equal(invalid.autoSettle, undefined);
});

/* ------------------------------------------------------ tab_call with it on */

const settings = (overrides = {}) => ({
  agent: AGENT,
  registryUrl: "http://registry.test",
  rpcUrl: undefined,
  chainId: 10143,
  explorerUrl: "https://testnet.monadvision.com",
  services: [{ serviceId: SERVICE_ID, endpoint: "http://service.test" }],
  strategyId: undefined,
  sources: {},
  ...overrides,
});

/** A Service whose answers come from a script, one per call, recording each. */
function service(script) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const step = script.shift() ?? { status: 200, openTab: "0" };
    return {
      status: step.status,
      headers: {
        "tab-charge-amount": step.amount ?? "10000",
        "tab-charge-asset": `10143:${MUSDC}`,
        "tab-charge-service": SERVICE_ID,
        "tab-charge-tool": TOOL_KEY,
        "tab-open-tab": step.openTab,
        "tab-headroom": step.headroom ?? "4000000",
      },
      json: async () => ({ quote: "a quote" }),
    };
  };
  return { calls, fetchImpl };
}

/** One strategy that records what it settled, and a registry API that lists it as indexed and the Service as accepting mUSDC. */
function strategies() {
  const settled = [];
  const strategy = {
    id: "stub",
    chainIds: [10143n],
    supports: (asset) => asset.chainId === 10143n,
    quote: async (request) => ({ ok: true, value: { amount: request.amount, asset: request.asset, feeNote: "" } }),
    settle: async (request) => {
      settled.push(request);
      return {
        ok: true,
        value: {
          strategyId: "stub",
          chainId: request.asset.chainId,
          txHash: `0x${"33".repeat(32)}`,
          asset: request.asset,
          amount: request.amount,
          payer: request.agent,
          serviceId: request.serviceId,
          settlementId: `0x${"44".repeat(32)}`,
          applied: request.amount,
          toPrepaid: 0n,
          submittedAt: 1,
        },
      };
    },
  };
  return {
    settled,
    registry: {
      register: () => ({ ok: true, value: { strategy, action: "registered" } }),
      unregister: () => false,
      list: () => [strategy],
      clear: () => {},
      resolve: () => ({ ok: true, value: strategy }),
    },
  };
}

const registryFetch = async (url) => {
  const path = new URL(String(url)).pathname;
  const body = path.startsWith("/settlements")
    ? { index: { lastBlock: 1 }, settlements: [{ monad: { txHash: `0x${"33".repeat(32)}` } }], nextCursor: null }
    : { index: { lastBlock: 1 }, service: { serviceId: SERVICE_ID, acceptedAssets: [{ asset: MUSDC, collection: AGENT }] } };
  return { status: 200, json: async () => body };
};

test("a call that leaves the tab at the Agent's amount is followed by a Settlement of the whole tab", async () => {
  const svc = service([{ status: 200, openTab: "50000" }]);
  const s = strategies();
  const toolset = createTabToolset({ settings: settings({ autoSettle: { atBaseUnits: 50_000n } }), fetchImpl: svc.fetchImpl, registryFetch, strategies: s.registry, env: ENV, logger: silent, settleIndexWaitMs: 0 });
  const output = await toolset.call({ serviceId: SERVICE_ID, tool: "quote.generate" });
  assert.equal(output.ok, true);
  assert.equal(output.autoSettle?.reason, "threshold");
  assert.equal(output.autoSettle?.ok, true, JSON.stringify(output.autoSettle));
  assert.equal(output.autoSettle?.amountBaseUnits, "50000", "the whole Open Tab");
  assert.equal(s.settled.length, 1);
  assert.equal(s.settled[0].amount, 50_000n);
  assert.equal(svc.calls.length, 1, "the call itself is made once");
});

test("a call the limit refused is settled for and made once more, and a second refusal stops there", async () => {
  const svc = service([
    { status: 402, amount: "10000", openTab: "5000000", headroom: "0" },
    { status: 200, openTab: "10000" },
  ]);
  const s = strategies();
  const toolset = createTabToolset({ settings: settings({ autoSettle: { atBaseUnits: 9_000_000n } }), fetchImpl: svc.fetchImpl, registryFetch, strategies: s.registry, env: ENV, logger: silent, settleIndexWaitMs: 0 });
  const output = await toolset.call({ serviceId: SERVICE_ID, tool: "quote.generate" });
  assert.equal(output.ok, true, JSON.stringify(output));
  assert.equal(output.autoSettle?.reason, "limit");
  assert.equal(s.settled[0]?.amount, 5_000_000n);
  assert.equal(svc.calls.length, 2);

  const stubborn = service([
    { status: 402, amount: "10000", openTab: "5000000", headroom: "0" },
    { status: 402, amount: "10000", openTab: "5000000", headroom: "0" },
    { status: 200, openTab: "0" },
  ]);
  const again = createTabToolset({ settings: settings({ autoSettle: { atBaseUnits: 9_000_000n } }), fetchImpl: stubborn.fetchImpl, registryFetch, strategies: strategies().registry, env: ENV, logger: silent, settleIndexWaitMs: 0 });
  const refused = await again.call({ serviceId: SERVICE_ID, tool: "quote.generate" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "LIMIT_EXCEEDED");
  assert.equal(stubborn.calls.length, 2, "one retry, never a loop");
});

test("with auto-settle off, tab_call never settles", async () => {
  const svc = service([{ status: 200, openTab: "99000000" }]);
  const s = strategies();
  const toolset = createTabToolset({ settings: settings(), fetchImpl: svc.fetchImpl, registryFetch, strategies: s.registry, env: ENV, logger: silent });
  const output = await toolset.call({ serviceId: SERVICE_ID, tool: "quote.generate" });
  assert.equal(output.ok, true);
  assert.equal(output.autoSettle, undefined);
  assert.equal(s.settled.length, 0);
});
