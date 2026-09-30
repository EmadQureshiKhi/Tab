#!/usr/bin/env node
/**
 * One Agent through the whole loop, against a live deployment, with the
 * Agent's key from the environment.
 *
 * Authorise the demo Service, discover it, buy a metered call on credit, read
 * the tab, settle it, read it again. The steps live in `scripts/lib/agent-loop.mjs`,
 * shared with `scripts/privy-agent.mjs`, which runs them with the key in a
 * Privy server wallet instead.
 *
 *   node --env-file=.env scripts/agent-loop.mjs                    # dry run: settles nothing
 *   node --env-file=.env scripts/agent-loop.mjs --broadcast        # settles with the Agent's key
 *   node --env-file=.env scripts/agent-loop.mjs --broadcast --strategy monad-relayed
 *                                                                  # settles by Permit2 signature through the gateway relay
 *   node --env-file=.env scripts/agent-loop.mjs --calls 3          # more than one metered call
 *   node --env-file=.env scripts/agent-loop.mjs --hub /api/v2/chains
 *                                                                  # one API Hub endpoint, fronted on credit
 *
 * Needs `AGENT_PRIVATE_KEY` for the Agent, the gateway on `GATEWAY_URL`, the
 * registry on `NEXT_PUBLIC_REGISTRY_API_URL`, and the deployment's addresses.
 * A dry run still sends `TabBook.authorise` when no authorisation stands, as
 * it always has. Nothing here prints a key.
 */

import { JsonRpcProvider, Wallet } from "ethers";

import { runAgentLoop } from "./lib/agent-loop.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 || index + 1 >= args.length ? fallback : args[index + 1];
};

const env = process.env;
const need = (name) => {
  const found = env[name];
  if (found === undefined || found.trim().length === 0) {
    console.error(`agent-loop: ${name} is not set`);
    process.exit(2);
  }
  return found.trim();
};

// The SDK's tools find the Agent's signer through tab.config.mjs, which prefers
// a Privy wallet when one is named; this script is the raw-key path.
delete env.PRIVY_WALLET_ID;

const chainId = BigInt(need("MONAD_CHAIN_ID"));
const provider = new JsonRpcProvider(need("MONAD_RPC_URL"), Number(chainId), { staticNetwork: true });
const agent = new Wallet(need("AGENT_PRIVATE_KEY"), provider);

const code = await runAgentLoop({
  agent,
  provider,
  env,
  broadcast: flag("broadcast"),
  authorise: "always",
  strategyId: value("strategy", undefined),
  calls: Number.parseInt(value("calls", "1"), 10),
  hubPath: value("hub", undefined),
  label: "agent-loop",
});
process.exit(code);
