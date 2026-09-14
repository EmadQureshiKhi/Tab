/**
 * Shared fakes: a registry read API, a host context with a recording executor,
 * and the settings every test starts from. Nothing here touches a network.
 */

import { Interface } from "ethers";

import { TESTNET_DEFAULTS } from "../dist/defaults.js";

export const AGENT = "0x1f6f797edc2eecb02bd54009b805fb2e99f80542";
export const SERVICE_ID = "0x7461622e64656d6f000000000000000000000000000000000000000000000000";
export const USDC = "0x5d519a1e8cf4edd7067fd631047e6869e9a7e4fe";
export const OTHER_ASSET = "0x534b2f3a21130d7a60830c2df862319e593943a3";
export const COLLECTION = "0x00000000000000000000000000000000000000c0";
/** The recorded Testnet deployment, so the command-class tests, which run on the defaults, agree with the runners' fixtures. */
export const TAB_SETTLEMENT = TESTNET_DEFAULTS.tabSettlement;
export const TAB_BOOK = TESTNET_DEFAULTS.tabBook;

const provenance = { blockNumber: 5441000, blockHash: `0x${"11".repeat(32)}`, logIndex: 0, txHash: `0x${"22".repeat(32)}`, txIndex: 0, blockTime: null };

export const SERVICES_BODY = {
  index: { stream: "monad", lastBlock: 5441800 },
  services: [
    {
      serviceId: SERVICE_ID,
      operator: "0x00000000000000000000000000000000000000a1",
      tier: { value: 0, name: "Permissionless", creditWeight: 1, source: { appliedBy: "registration", monad: provenance } },
      settlementWindowSeconds: { value: 21600, source: { appliedBy: "registration", monad: provenance } },
      acceptedAssets: [{ asset: USDC, collection: COLLECTION }],
      collections: [{ serviceId: SERVICE_ID, asset: USDC, collection: COLLECTION, monad: provenance }],
      prices: [{ serviceId: SERVICE_ID, asset: USDC, tool: `0x${"33".repeat(32)}`, baseUnits: "10000", monad: provenance }],
      bond: [{ serviceId: SERVICE_ID, party: `0x${"00".repeat(12)}00000000000000000000000000000000000000a1`, asset: USDC, staked: "1000000", withdrawn: "0", free: "1000000", depositCount: 1, lastBlock: 5441000, basis: "summed from Bond events", computedAt: { blockNumber: 5441800 }, crossCheck: null, unavailable: null }],
      pendingChanges: [],
      registeredAt: provenance,
    },
  ],
  nextCursor: null,
};

export const AGENT_BODY = {
  index: { stream: "monad", lastBlock: 5441800 },
  agent: AGENT,
  assets: [
    {
      asset: USDC,
      creditLimit: { value: "4750000", basis: "LimitLib", computedAt: { blockNumber: 5441800 }, witness: null, crossCheck: null, unavailable: null },
      headroom: { value: "4740000", basis: "limit less open", openTab: "10000", crossCheck: null, unavailable: null },
      openTab: { observed: "10000", basis: "sum", liveRead: "TabBook.assetOpen(agent, asset)", tabs: [{ tabId: `0x${"33".repeat(32)}`, agent: AGENT, serviceId: SERVICE_ID, asset: USDC, openAfter: "10000", monad: provenance }] },
      delinquency: { delinquent: false, openCount: 0, basis: "TabDelinquent", tabs: [] },
      settlements: { agent: AGENT, asset: USDC, settlementCount: 1, settledTotal: "10000", appliedTotal: "10000", prepaidTotal: "0", firstBlock: 5400000, lastBlock: 5441000, lastBlockTime: null },
    },
  ],
};

export const SETTLEMENTS_BODY = {
  index: { stream: "monad", lastBlock: 5441800 },
  settlements: [
    { settlementId: `0x${"44".repeat(32)}`, agent: AGENT, serviceId: SERVICE_ID, asset: USDC, amount: "10000", applied: "10000", toPrepaid: "0", collection: COLLECTION, openAfter: "0", monad: provenance },
  ],
  nextCursor: null,
};

const json = (status, body) => ({ status, headers: {}, json: async () => body });

/** A `fetch` for the registry read API that records every URL it was asked. */
export function stubRegistryFetch(overrides = {}) {
  const calls = [];
  const send = async (url) => {
    calls.push(url);
    const path = url.replace("http://registry.test", "");
    const services = overrides.services ?? SERVICES_BODY;
    if (path.startsWith("/services/")) return json(200, { index: services.index, service: services.services[0] });
    if (path.startsWith("/services")) return json(200, services);
    if (path.startsWith("/agents/")) return json(200, overrides.agent ?? AGENT_BODY);
    if (path.startsWith("/settlements")) return json(200, overrides.settlements ?? SETTLEMENTS_BODY);
    return json(404, { error: { category: "NOT_FOUND", code: "ROUTE_UNKNOWN", message: `no route for ${path}` } });
  };
  send.calls = calls;
  return send;
}

export const SETTINGS = {
  chainId: 10143,
  tabBook: TAB_BOOK,
  tabSettlement: TAB_SETTLEMENT,
  registryUrl: "http://registry.test",
  rpcUrl: undefined,
  explorerUrl: "https://testnet.monadvision.com",
  sources: {},
};

export const ENV = { MOCK_USDC_ADDRESS: USDC };

const erc20 = new Interface(["function allowance(address owner, address spender) view returns (uint256)"]);

/**
 * A fake `this.ctx`: one selected wallet, a public client answering `allowance`
 * with a fixed figure, and an executor that records every request and answers
 * with a status of the test's choosing.
 */
export function fakeContext({ allowance = 0n, status = "CONFIRMED", failureCode, wallets, selected } = {}) {
  const requests = [];
  const executorCalls = [];
  let counter = 0;
  const ctx = {
    logger: { debug() {}, warn() {} },
    walletStateManager: {
      read: () => ({
        byokWallets: wallets ?? [{ id: "byok:evm:0", namespace: "evm", address: AGENT, name: "agent" }],
        remoteWallets: [],
        selectedWallet: selected ?? { mode: "byok", namespace: "evm", ref: { id: "byok:evm:0" } },
      }),
    },
    publicClient: (chainId) => ({
      async call({ to, data }) {
        const word = erc20.encodeFunctionResult("allowance", [allowance]);
        return { data: word, chainId, to, calldata: data };
      },
    }),
    walletExecutor: async (io, source) => {
      executorCalls.push({ io, source });
      return async (request, opts) => {
        requests.push({ request, opts });
        counter += 1;
        return { kind: "transaction", hash: `0x${counter.toString(16).padStart(64, "0")}`, status, ...(failureCode === undefined ? {} : { failureCode, failureDescription: "policy said no" }) };
      };
    },
  };
  return { ctx, requests, executorCalls };
}

/** A `CommandIO` that answers `resolveInputs` with canned values and records logs. */
export function fakeIo(values) {
  const logs = [];
  return {
    isInteractive: false,
    signal: new AbortController().signal,
    flags: {},
    ctx: {},
    emit() {},
    yield() {},
    notify() {},
    progress() {},
    log(level, message) {
      logs.push({ level, message });
    },
    async resolveInputs() {
      return values;
    },
    logs,
  };
}
