/**
 * The demonstration configuration for this deployment.
 *
 * `tab_call` and `tab_settle` need three things the chain does not carry: whose
 * Open Tab a call is metered to, where a Service can be reached, and a key to
 * sign a Settlement with. The first two are here. The third is never here: the
 * strategy is built with a signer read from the environment at load, so no key
 * is written to a file that is tracked.
 *
 * ## Why the endpoint is in a config file and not on chain
 *
 * `ServiceRegistry.Service` records an operator, a tier, a Settlement Window, a
 * bond account and a timestamp, and no URL. That is deliberate: the chain is the
 * billing rail, not a directory of hosts. `service-endpoints.json` publishes the
 * same address for the Dashboard, and this file is its counterpart for the SDK.
 *
 * ## Nothing here is authoritative about money
 *
 * Prices, tiers and Bonds are read from the chain by `tab_discover`. What this
 * file supplies is addressing, so a wrong value here means a call goes nowhere,
 * never that a charge is wrong.
 */

import { Wallet, JsonRpcProvider } from "ethers";

import { agentSignedMetering, createMonadStrategy, createRelayedMonadStrategy } from "@tabai/sdk";

/** Testnet unless the environment says otherwise. */
const CHAIN_ID = BigInt(process.env.MONAD_CHAIN_ID ?? "10143");
const RPC_URL = process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";

/**
 * The Asset a Settlement is paid in, resolved the way the gateway resolves the
 * Asset it meters in, so the two agree: `GATEWAY_ASSET_ADDRESS` when set, then
 * the mock token the deploy script shipped on Testnet, then `USDC_ADDRESS`, then
 * Circle's USDC on the chain named above, so the chain id and the Asset always
 * belong to the same network.
 */
const ASSET_ADDRESS = (
  process.env.GATEWAY_ASSET_ADDRESS ??
  process.env.MOCK_USDC_ADDRESS ??
  process.env.USDC_ADDRESS ??
  (CHAIN_ID === 143n ? "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" : "0x534b2f3A21130d7a60830c2Df862319e593943A3")
).toLowerCase();

/**
 * The one Asset both strategies below settle in, named `chainId:address`. The
 * mock token is called `mUSDC` so a receipt in it is never mistaken for one in
 * Circle's USDC.
 */
const ASSETS = {
  [`${CHAIN_ID}:${ASSET_ADDRESS}`]: {
    chainId: CHAIN_ID,
    address: ASSET_ADDRESS,
    decimals: 6,
    symbol: ASSET_ADDRESS === (process.env.MOCK_USDC_ADDRESS ?? "").toLowerCase() ? "mUSDC" : "USDC",
  },
};

/**
 * A signer from the Agent's key, or nothing. Shared by the settlement
 * strategy and the x402 factory below, and called by neither until something
 * has to sign: `doctor`, `tab_discover` and `tab_status` never reach it.
 */
const agentSigner = () => {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (key === undefined || key.trim().length === 0 || key.startsWith("0xREPLACE")) return undefined;
  return new Wallet(key.trim(), new JsonRpcProvider(RPC_URL, Number(CHAIN_ID), { staticNetwork: true }));
};

export default {
  /** The Agent whose Open Tab a metered call lands on. */
  agent: process.env.TRY_IT_AGENT,

  // Point the variable at a local indexer to develop against one.
  registryUrl: process.env.NEXT_PUBLIC_REGISTRY_API_URL ?? "http://localhost:8787",

  services: [
    {
      serviceId:
        process.env.GATEWAY_SERVICE_ID ?? "0x7461622e64656d6f000000000000000000000000000000000000000000000000",
      name: "tab.demo",
      endpoint: process.env.GATEWAY_URL ?? "http://localhost:8788",
      /*
        Every metered call is signed by the Agent, so the gateway knows the
        party paying for the call is the one that asked for it. The factory is
        called per call and never for a read.
      */
      headers: agentSignedMetering(agentSigner),
      /*
        The API Hub provider the demo Service fronts at `/hub/apihub`. With
        this, `tab_discover` fetches the provider's manifest and lists its
        endpoints under the Service as tools bought on credit: the gateway pays
        the Hub and meters the Open Tab for the price plus its margin. The
        gateway's GATEWAY_HUB_UPSTREAMS declares the mount; this names what to
        list under it.
      */
      hub: { provider: "defillama", prefix: "apihub" },
    },
  ],

  /*
    The x402 signer, for the prepaid fallback. When a Service refuses a call
    on credit and its 402 carries an x402 offer, `tab_call` signs an EIP-3009
    authorization for that one call with this signer and sends the request
    once more. A factory, for the same reason the strategies are: the key is
    read only at that moment. Returning undefined declines, and the refusal
    stays the LIMIT_EXCEEDED it was. Delete this entry to never prepay.
  */
  x402: agentSigner,

  /*
    A factory rather than an object, so the signer is built only if something
    actually needs to settle. `doctor` and `tab_discover` never call it, which is
    what keeps every read on this rail keyless.
  */
  strategies: [
    () => {
      const signer = agentSigner();
      const surface = process.env.TAB_SETTLEMENT_ADDRESS;
      if (signer === undefined) return undefined;
      if (surface === undefined || !/^0x[0-9a-fA-F]{40}$/.test(surface)) return undefined;
      // To settle from MON instead of holding the Asset, wrap this in
      // `createKuruFundedStrategy({ inner, signer, kuru: { router, source } })`;
      // the SDK README shows the route configuration.
      return createMonadStrategy({ signer, tabSettlement: surface, assets: ASSETS });
    },
    /*
      The gasless path. The Agent signs a Permit2 permit and the Service's
      gateway submits it and pays the gas, so the Agent needs no MON. Second in
      the list, so `tab_settle` takes the direct path unless it is asked for
      this one by id (`--strategy monad-relayed`) or the direct one declines.
      Needs the one-time Permit2 approval on the Asset; the strategy names it
      when it is missing.
    */
    () => {
      const signer = agentSigner();
      const surface = process.env.TAB_SETTLEMENT_ADDRESS;
      const gateway = process.env.GATEWAY_URL ?? "http://localhost:8788";
      if (signer === undefined) return undefined;
      if (surface === undefined || !/^0x[0-9a-fA-F]{40}$/.test(surface)) return undefined;
      return createRelayedMonadStrategy({
        signer,
        tabSettlement: surface,
        relayUrl: `${gateway.replace(/\/+$/, "")}/relay/settle`,
        assets: ASSETS,
      });
    },
  ],
};
