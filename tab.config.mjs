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

import { createEthereumUsdcStrategy } from "@tabai/sdk";

const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

export default {
  /** The Agent whose Open Tab a metered call lands on. */
  agent: process.env.DEMO_AGENT_ONE_CREDITCOIN_ADDRESS,

  registryUrl: process.env.NEXT_PUBLIC_REGISTRY_API_URL ?? "http://localhost:8787",

  services: [
    {
      serviceId: "0x7461622e70726f6f662d73657276696365000000000000000000000000000000",
      name: "tab.proof-service",
      endpoint: process.env.GATEWAY_URL ?? "http://localhost:8788",
    },
  ],

  /*
    A factory rather than an object, so the signer is built only if something
    actually needs to settle. `doctor` and `tab_discover` never call it, which is
    what keeps every read on this rail keyless.
  */
  strategies: [
    () => {
      const key = process.env.AGENT_ETHEREUM_PRIVATE_KEY;
      if (key === undefined || key.trim().length === 0) return undefined;
      /*
        The declared variable is the comma-separated `_URLS` list the whole rail
        uses, because endpoints disagree about `eth_getLogs` ranges and one of
        them is never enough. Broadcasting a Settlement needs only one, so this
        takes the first. Reading the singular name here was a real defect: it is
        not the declared variable, so anyone who set the documented one found it
        ignored and the public fallback used instead, silently.
      */
      const endpoint =
        (process.env.ETHEREUM_SEPOLIA_RPC_URLS ?? "")
          .split(",")
          .map((url) => url.trim())
          .find((url) => url.length > 0) ?? "https://ethereum-sepolia-rpc.publicnode.com";
      const provider = new JsonRpcProvider(endpoint);
      return createEthereumUsdcStrategy({
        signer: new Wallet(key.trim(), provider),
        assets: {
          [`1:${SEPOLIA_USDC}`]: {
            chainKey: 1n,
            address: SEPOLIA_USDC,
            decimals: 6,
            symbol: "USDC",
          },
        },
      });
    },
  ],
};
