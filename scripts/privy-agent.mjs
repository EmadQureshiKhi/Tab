#!/usr/bin/env node
/**
 * An Agent whose key lives in a Privy server wallet, under a Privy policy.
 *
 * Three modes, one per run:
 *
 *   node --env-file=.env scripts/privy-agent.mjs --create
 *       Prints the policy the wallet would be created under. Nothing is sent.
 *   node --env-file=.env scripts/privy-agent.mjs --create --broadcast [--chain 143] [--owner-public-key <base64>]
 *       Generates the owner key (unless one is given) and the Agent's signer
 *       key, writes both to --keys-dir (default ~/.tab/privy, mode 0600), and
 *       creates the policy, the signer quorum and the wallet on Privy. Prints
 *       the wallet id and address, never a key. `--x402-max <base units>`
 *       also allows x402 prepaid payments up to that amount each.
 *   node --env-file=.env scripts/privy-agent.mjs --loop [--broadcast] [--strategy monad-relayed] [--calls 3] [--hub /api/v2/chains]
 *       The same loop as scripts/agent-loop.mjs, signed by the Privy wallet:
 *       metering claims by personal_sign, Permit2 by eth_signTypedData_v4,
 *       authorise, approve and settle by eth_signTransaction. Without
 *       --broadcast, no transaction is sent and the settlement is a dry run;
 *       the metered call is still signed and made.
 *   node --env-file=.env scripts/privy-agent.mjs --denied [--broadcast]
 *       Asks Privy to sign a transfer of the Asset to an address the policy
 *       does not name, and prints Privy's refusal. Without --broadcast it only
 *       prints the request. The transaction is never broadcast, even if Privy
 *       were to sign it.
 *
 * Needs PRIVY_APP_ID and PRIVY_APP_SECRET (the Privy dashboard, App settings),
 * and for --loop and --denied PRIVY_WALLET_ID and PRIVY_AUTHORIZATION_KEY,
 * which --create --broadcast produces. The chain is MONAD_CHAIN_ID unless
 * --chain names another for --create; the addresses come from deployments.json.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Interface, JsonRpcProvider } from "ethers";

import {
  buildPrivyAgentPolicy,
  createPrivyAgentSigner,
  createPrivyAgentWallet,
  generatePrivyAuthorizationKeyPair,
  isPrivyPublicKey,
} from "@tabai/sdk";

import { runAgentLoop } from "./lib/agent-loop.mjs";

const LABEL = "privy-agent";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STRANGER = "0x000000000000000000000000000000000000dEaD";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 || index + 1 >= args.length ? fallback : args[index + 1];
};
const env = process.env;
const broadcast = flag("broadcast");

const fail = (message, code = 2) => {
  console.error(`${LABEL}: ${message}`);
  process.exit(code);
};
const step = (title) => console.log(`\n== ${title}`);
const show = (label, text) => console.log(`   ${label.padEnd(14)} ${text}`);
const set = (name) => typeof env[name] === "string" && env[name].trim().length > 0;
/** Warnings and errors to stderr; the steps above are the script's own account of what happened. */
const quiet = { debug() {}, info() {}, warn: console.warn, error: console.error };

const modes = ["create", "loop", "denied"].filter(flag);
if (modes.length !== 1) {
  fail("name exactly one of --create, --loop or --denied; the header of scripts/privy-agent.mjs shows each");
}
const [mode] = modes;

const chainId = BigInt(value("chain", env.MONAD_CHAIN_ID ?? "10143"));
const deployments = JSON.parse(readFileSync(join(ROOT, "deployments.json"), "utf8"));
const network = deployments.networks?.[chainId.toString(10)];
if (network === undefined) fail(`deployments.json records nothing on chain ${chainId}`);
const addresses = {
  tabSettlement: network.contracts.TabSettlement.address,
  tabBook: network.contracts.TabBook.address,
  permit2: network.permit2.address,
  assets: network.demo.assets,
};

/** The credentials, or a message naming each one missing and where it comes from. */
function requireCredentials(names) {
  const missing = names.filter((name) => !set(name));
  if (missing.length === 0) return;
  const where = {
    PRIVY_APP_ID: "the Privy dashboard, App settings > Basics",
    PRIVY_APP_SECRET: "the Privy dashboard, App settings > Basics; keep it out of any tracked file",
    PRIVY_WALLET_ID: "the output of --create --broadcast",
    PRIVY_AUTHORIZATION_KEY: "the agent key file --create --broadcast writes",
  };
  fail(`not set: ${missing.map((name) => `${name} (${where[name]})`).join("; ")}`);
}

function privySigner(provider) {
  const built = createPrivyAgentSigner({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    walletId: env.PRIVY_WALLET_ID,
    chainId,
    provider,
    ...(set("PRIVY_AUTHORIZATION_KEY") ? { authorizationKey: env.PRIVY_AUTHORIZATION_KEY } : {}),
    ...(set("PRIVY_API_URL") ? { apiUrl: env.PRIVY_API_URL.trim() } : {}),
    logger: quiet,
  });
  if (!built.ok) fail(built.error.message);
  return built.value;
}

function rpcProvider() {
  const rpcUrl = set("MONAD_RPC_URL") && BigInt(env.MONAD_CHAIN_ID ?? "0") === chainId ? env.MONAD_RPC_URL.trim() : network.rpcUrl;
  return new JsonRpcProvider(rpcUrl, Number(chainId), { staticNetwork: true });
}

// ------------------------------------------------------------ --create

async function create() {
  const x402 = value("x402-max", undefined);
  const policyInput = { chainId, addresses, ...(x402 === undefined ? {} : { x402MaxBaseUnits: BigInt(x402) }) };
  const policy = buildPrivyAgentPolicy(policyInput);
  if (!policy.ok) fail(policy.error.message);

  step(`The policy for an Agent on chain ${chainId} (${network.network ?? "Monad"})`);
  show("TabSettlement", addresses.tabSettlement);
  show("TabBook", addresses.tabBook);
  show("Permit2", addresses.permit2);
  show("Assets", addresses.assets.join(", "));
  for (const rule of policy.value.rules) show(rule.action, `${rule.method.padEnd(21)} ${rule.name}`);
  show("otherwise", "refused: Privy denies a request no rule allows");

  if (!broadcast) {
    step("Dry run");
    show("sent", "nothing; pass --broadcast to create the policy, the signer quorum and the wallet on Privy");
    return 0;
  }
  requireCredentials(["PRIVY_APP_ID", "PRIVY_APP_SECRET"]);

  const keysDir = value("keys-dir", join(homedir(), ".tab", "privy"));
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  chmodSync(keysDir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const written = (name, contents) => {
    const path = join(keysDir, `${chainId}-${stamp}-${name}`);
    if (existsSync(path)) fail(`${path} already exists; refusing to overwrite a key`);
    writeFileSync(path, `${contents}\n`, { mode: 0o600, flag: "wx" });
    return path;
  };

  const givenOwner = value("owner-public-key", undefined);
  if (givenOwner !== undefined && !isPrivyPublicKey(givenOwner)) fail("--owner-public-key must be a base64 SPKI DER P-256 public key");
  const owner = givenOwner === undefined ? generatePrivyAuthorizationKeyPair() : { publicKey: givenOwner };
  const agentKey = generatePrivyAuthorizationKeyPair();
  // Written before Privy is asked, so a key that becomes a wallet's owner or
  // signer can never be lost to a failure halfway through.
  const ownerPath = owner.privateKey === undefined ? null : written("owner.key", owner.privateKey);
  const agentPath = written("agent.key", agentKey.privateKey);

  const created = await createPrivyAgentWallet({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    ownerPublicKey: owner.publicKey,
    signerPublicKey: agentKey.publicKey,
    ...policyInput,
    ...(set("PRIVY_API_URL") ? { apiUrl: env.PRIVY_API_URL.trim() } : {}),
    logger: quiet,
  });
  if (!created.ok) fail(`${created.error.code}: ${created.error.message}`, 1);

  step("Created on Privy");
  show("wallet id", created.value.walletId);
  show("address", created.value.address);
  show("policy id", created.value.policyId);
  show("signer id", created.value.signerId);
  if (ownerPath !== null) show("owner key", `${ownerPath} (owns the wallet and the policy; keep it off the Agent's machine)`);
  show("agent key", `${agentPath} (the Agent's PRIVY_AUTHORIZATION_KEY)`);

  step("Next");
  const envFile = chainId === 143n ? ".env.mainnet" : ".env";
  const next = [
    [
      `Put these in the Agent's environment (${envFile} is gitignored):`,
      `     PRIVY_WALLET_ID=${created.value.walletId}`,
      `     PRIVY_AUTHORIZATION_KEY=<the single line in ${agentPath}>`,
    ],
  ];
  if (chainId === 10143n) {
    const mock = network.contracts.MockUsdc?.address ?? addresses.assets.at(-1);
    next.push([`Fund ${created.value.address} with testnet MON for gas, from the Monad testnet faucet or any funded key.`]);
    next.push([
      "Mint it mUSDC; MockUsdc's mint is open, so any funded key can send it:",
      `     cast send ${mock} "mint(address,uint256)" ${created.value.address} 100000000 --rpc-url ${network.rpcUrl} --private-key <a funded key>`,
    ]);
  } else {
    next.push([`Send ${created.value.address} MON for gas and the USDC or AUSD it will settle in.`]);
  }
  next.push([
    `node --env-file=${envFile} scripts/privy-agent.mjs --denied --broadcast   (the policy refusing a transfer)`,
    `   node --env-file=${envFile} scripts/privy-agent.mjs --loop --broadcast     (the whole loop)`,
  ]);
  next.forEach(([first, ...rest], index) => {
    console.log(`   ${index + 1}. ${first}`);
    for (const line of rest) console.log(`   ${line}`);
  });
  return 0;
}

// ------------------------------------------------------------ --denied

async function denied() {
  const asset = addresses.assets.at(-1);
  const data = new Interface(["function transfer(address to, uint256 amount) returns (bool)"]).encodeFunctionData("transfer", [STRANGER, 1n]);

  step("A transaction the policy does not allow");
  show("wallet", set("PRIVY_WALLET_ID") ? env.PRIVY_WALLET_ID.trim() : "PRIVY_WALLET_ID, once set");
  show("asks", `eth_signTransaction of transfer(${STRANGER}, 1) on ${asset}, chain ${chainId}`);
  show("why refused", "the policy lets the Asset be approved to TabSettlement or Permit2 and nothing else");
  if (!broadcast) {
    step("Dry run");
    show("sent", "nothing; pass --broadcast to ask Privy to sign it. It is never broadcast either way.");
    return 0;
  }

  requireCredentials(["PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_WALLET_ID"]);
  const provider = rpcProvider();
  const signer = privySigner(provider);
  const address = await signer.getAddress();
  const fees = await provider.getFeeData();
  const request = {
    to: asset,
    data,
    value: 0n,
    chainId,
    nonce: await provider.getTransactionCount(address, "pending"),
    gasLimit: 100_000n,
    type: 2,
    maxFeePerGas: fees.maxFeePerGas ?? 0n,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
  };
  try {
    await signer.signTransaction(request);
  } catch (error) {
    if (error?.code === "PRIVY_POLICY_DENIED") {
      step("Privy refused it, as the policy says");
      show("code", error.code);
      show("privy code", String(error.privyCode));
      show("privy said", String(error.privyMessage));
      console.log(`\n   ${error.message}`);
      return 0;
    }
    step("Privy did not sign, for a reason other than the policy");
    show("code", String(error?.code ?? error?.name));
    console.log(`\n   ${error?.message ?? String(error)}`);
    return 1;
  }
  step("Privy signed it");
  show("broadcast", "no; the signed transaction was discarded");
  show("check", `the policies on wallet ${signer.walletId}: this transfer should have been refused`);
  return 1;
}

// ------------------------------------------------------------ --loop

async function loop() {
  requireCredentials(["PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_WALLET_ID"]);
  if (BigInt(env.MONAD_CHAIN_ID ?? "0") !== chainId) {
    fail(`the loop runs on the network the environment names (MONAD_CHAIN_ID ${env.MONAD_CHAIN_ID ?? "unset"}); use .env.mainnet for chain 143`);
  }
  const provider = rpcProvider();
  const agent = privySigner(provider);
  return runAgentLoop({
    agent,
    provider,
    env,
    broadcast,
    authorise: "broadcast",
    strategyId: value("strategy", undefined),
    calls: Number.parseInt(value("calls", "1"), 10),
    hubPath: value("hub", undefined),
    label: LABEL,
  });
}

const code = await (mode === "create" ? create() : mode === "denied" ? denied() : loop());
process.exit(code);
