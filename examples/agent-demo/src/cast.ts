/**
 * The cast: who is in this demo, and where each of them exists.
 *
 * Two agents trade over the rail, and the demo is only legible if it is obvious
 * at every moment which of them is acting and which account of theirs is doing
 * it. Each Agent has **three** addresses and they are not interchangeable:
 *
 * - `creditcoin` is the identity. It is what a tab is keyed by, what a spending
 *   authorisation is granted to, and the only address a Service ever names.
 * - `ethereum` is a bound Source Chain address. It holds the Asset for a plain
 *   settlement, and for that shape it is both the transaction sender and
 *   `topics[1]` of the `Transfer`, because a wallet moving its own tokens is
 *   necessarily the holder.
 * - `smartAccount` is a bound Source Chain address that holds the Asset but is
 *   not a wallet. Somebody else sends the transaction; the contract is still the
 *   token holder, so the sender and `topics[1]` diverge. That divergence is the
 *   whole of act four (R8.1, R8.2, R8.3).
 *
 * **Reading the environment and interpreting it are separated on purpose.**
 * {@link processDemoEnv} is the only thing here that touches `process.env`, and
 * {@link resolveCast} is a pure function of the record it returns, so every
 * refusal below is reachable from a test with no environment at all.
 *
 * Requirements: 8.1, 8.2, 8.3, 12.1, 16.1, 21.2, 22.4, 23.1
 */

import type { Address, Bytes32, Result } from "@tabai/shared";
import { err, isAddress, isBytes32, ok } from "@tabai/shared";

/** Ethereum Sepolia. Both agents settle here, and both are bound on it. */
export const DEMO_CHAIN_KEY = 1n;

/** USDC on Sepolia carries six decimals, as it does everywhere. */
export const USDC_DECIMALS = 6;

/** What this demo reads from the environment, flattened to one record. */
export interface DemoEnv {
  readonly [name: string]: string | undefined;
}

/** An Asset as the SDK's payment strategies name one. */
export interface DemoAsset {
  readonly chainKey: bigint;
  readonly address: Address;
  readonly decimals: number;
  readonly symbol: string;
}

/** One Agent, and every address it acts through. */
export interface AgentIdentity {
  /** Short name used in narration. Not an on-chain thing. */
  readonly name: string;
  /** One line on what this Agent is doing in the story. */
  readonly role: string;
  /** Identity on the rail. Tabs, authorisations and credit are keyed by it. */
  readonly creditcoin: Address;
  /** Bound Source Chain wallet. Holder and sender for a plain settlement. */
  readonly ethereum: Address;
  /** Bound Source Chain contract that holds the Asset. Present for at most one Agent. */
  readonly smartAccount?: Address;
}

/** Everything the acts need, resolved once. */
export interface Cast {
  readonly creditcoinRpcUrl: string;
  readonly sourceRpcUrl: string;
  readonly tabBook: Address;
  readonly agentRegistry: Address;
  readonly serviceRegistry: Address;
  readonly bond: Address;
  readonly serviceId: Bytes32;
  readonly asset: DemoAsset;
  /** The Collection Address the Service registered for this Asset. `topics[2]`. */
  readonly collectionAddress: Address;
  /** Where the metered gateway is listening, for the act that goes over HTTP. */
  readonly gatewayBaseUrl: string;
  /** Exactly two, in narration order. */
  readonly agents: readonly [AgentIdentity, AgentIdentity];
}

/**
 * The single point where this package touches `process.env`.
 *
 * Every name appears as a literal member read on `process.env`, because the
 * repository's environment gate extracts those literally and a computed lookup
 * would pass the gate while reading a variable nobody declared.
 */
export function processDemoEnv(): DemoEnv {
  return {
    CREDITCOIN_RPC_URL: process.env.CREDITCOIN_RPC_URL,
    ETHEREUM_SEPOLIA_RPC_URLS: process.env.ETHEREUM_SEPOLIA_RPC_URLS,
    TAB_BOOK_ADDRESS: process.env.TAB_BOOK_ADDRESS,
    AGENT_REGISTRY_ADDRESS: process.env.AGENT_REGISTRY_ADDRESS,
    SERVICE_REGISTRY_ADDRESS: process.env.SERVICE_REGISTRY_ADDRESS,
    BOND_ADDRESS: process.env.BOND_ADDRESS,
    SEPOLIA_USDC_ADDRESS: process.env.SEPOLIA_USDC_ADDRESS,
    PROOF_SERVICE_COLLECTION_ADDRESS: process.env.PROOF_SERVICE_COLLECTION_ADDRESS,
    GATEWAY_SERVICE_ID: process.env.GATEWAY_SERVICE_ID,
    GATEWAY_PORT: process.env.GATEWAY_PORT,
    DEMO_AGENT_ONE_CREDITCOIN_ADDRESS: process.env.DEMO_AGENT_ONE_CREDITCOIN_ADDRESS,
    DEMO_AGENT_ONE_ETHEREUM_ADDRESS: process.env.DEMO_AGENT_ONE_ETHEREUM_ADDRESS,
    DEMO_AGENT_TWO_CREDITCOIN_ADDRESS: process.env.DEMO_AGENT_TWO_CREDITCOIN_ADDRESS,
    DEMO_AGENT_TWO_ETHEREUM_ADDRESS: process.env.DEMO_AGENT_TWO_ETHEREUM_ADDRESS,
    DEMO_AGENT_TWO_SMART_ACCOUNT_ADDRESS: process.env.DEMO_AGENT_TWO_SMART_ACCOUNT_ADDRESS,
  };
}

const missing = (name: string): Result<never> =>
  err({
    category: "VALIDATION",
    code: "DEMO_ENV_ABSENT",
    message: `${name} is not set; copy .env.example to .env and fill it in`,
    retryable: false,
  });

const notAnAddress = (name: string, raw: string): Result<never> =>
  err({
    category: "VALIDATION",
    code: "DEMO_ENV_NOT_ADDRESS",
    message: `${name} must be a 20-byte 0x address, received \`${raw}\``,
    retryable: false,
  });

/** A required plain string. */
function text(env: DemoEnv, name: string): Result<string> {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return missing(name);
  return ok(raw.trim());
}

/**
 * A required address, refusing the zero address as well as a malformed one.
 *
 * The zero address is refused because `.env.example` ships every deployment slot
 * as zero, so an unfilled `.env` copied from it would otherwise resolve and then
 * fail much later as an `eth_call` against an account with no code.
 */
export function address(env: DemoEnv, name: string): Result<Address> {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return missing(name);
  const trimmed = raw.trim();
  if (!isAddress(trimmed)) return notAnAddress(name, trimmed);
  if (/^0x0{40}$/i.test(trimmed)) {
    return err({
      category: "VALIDATION",
      code: "DEMO_ENV_ZERO_ADDRESS",
      message: `${name} is still the zero-address placeholder; fill it in from deployments.json`,
      retryable: false,
    });
  }
  return ok(trimmed);
}

/** The first endpoint of a comma-separated list, which is how the Watcher reads the same variable. */
export function firstEndpoint(env: DemoEnv, name: string): Result<string> {
  const list = text(env, name);
  if (!list.ok) return list;
  const first = list.value.split(",")[0]?.trim() ?? "";
  if (first === "") return missing(name);
  return ok(first);
}

/** A `serviceId`, accepting either the 32-byte word or the short name it encodes. */
export function serviceIdOf(env: DemoEnv, name: string): Result<Bytes32> {
  const raw = text(env, name);
  if (!raw.ok) return raw;
  if (isBytes32(raw.value)) return ok(raw.value);
  const bytes = Buffer.from(raw.value, "utf8");
  if (bytes.length > 32) {
    return err({
      category: "VALIDATION",
      code: "DEMO_SERVICE_ID_TOO_LONG",
      message: `${name} is ${String(bytes.length)} bytes as UTF-8 and a serviceId holds 32`,
      retryable: false,
    });
  }
  return ok(`0x${Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]).toString("hex")}` as Bytes32);
}

/**
 * Resolves the cast, or names the first thing that is missing.
 *
 * Pure in `env`. The optional smart account is the one field allowed to be
 * absent: acts one to three run without it, and act four refuses by name rather
 * than by a failure to start.
 */
export function resolveCast(env: DemoEnv): Result<Cast> {
  const creditcoinRpcUrl = text(env, "CREDITCOIN_RPC_URL");
  if (!creditcoinRpcUrl.ok) return creditcoinRpcUrl;
  const sourceRpcUrl = firstEndpoint(env, "ETHEREUM_SEPOLIA_RPC_URLS");
  if (!sourceRpcUrl.ok) return sourceRpcUrl;

  const tabBook = address(env, "TAB_BOOK_ADDRESS");
  if (!tabBook.ok) return tabBook;
  const agentRegistry = address(env, "AGENT_REGISTRY_ADDRESS");
  if (!agentRegistry.ok) return agentRegistry;
  const serviceRegistry = address(env, "SERVICE_REGISTRY_ADDRESS");
  if (!serviceRegistry.ok) return serviceRegistry;
  const bond = address(env, "BOND_ADDRESS");
  if (!bond.ok) return bond;

  const usdc = address(env, "SEPOLIA_USDC_ADDRESS");
  if (!usdc.ok) return usdc;
  const collectionAddress = address(env, "PROOF_SERVICE_COLLECTION_ADDRESS");
  if (!collectionAddress.ok) return collectionAddress;
  const serviceId = serviceIdOf(env, "GATEWAY_SERVICE_ID");
  if (!serviceId.ok) return serviceId;

  const oneCreditcoin = address(env, "DEMO_AGENT_ONE_CREDITCOIN_ADDRESS");
  if (!oneCreditcoin.ok) return oneCreditcoin;
  const oneEthereum = address(env, "DEMO_AGENT_ONE_ETHEREUM_ADDRESS");
  if (!oneEthereum.ok) return oneEthereum;
  const twoCreditcoin = address(env, "DEMO_AGENT_TWO_CREDITCOIN_ADDRESS");
  if (!twoCreditcoin.ok) return twoCreditcoin;
  const twoEthereum = address(env, "DEMO_AGENT_TWO_ETHEREUM_ADDRESS");
  if (!twoEthereum.ok) return twoEthereum;

  if (oneCreditcoin.value.toLowerCase() === twoCreditcoin.value.toLowerCase()) {
    return err({
      category: "VALIDATION",
      code: "DEMO_AGENTS_NOT_DISTINCT",
      message:
        "both agents resolve to the same Creditcoin address, so nothing in this demo would be observable",
      retryable: false,
    });
  }

  const rawSmart = env.DEMO_AGENT_TWO_SMART_ACCOUNT_ADDRESS;
  let smartAccount: Address | undefined;
  if (rawSmart !== undefined && rawSmart.trim() !== "") {
    const resolved = address(env, "DEMO_AGENT_TWO_SMART_ACCOUNT_ADDRESS");
    if (!resolved.ok) return resolved;
    smartAccount = resolved.value;
  }

  // Matches the port `.env.example` declares, so a `.env` that never mentioned
  // the gateway still reaches the one this repository starts.
  const port = env.GATEWAY_PORT?.trim();
  const gatewayBaseUrl = `http://127.0.0.1:${port === undefined || port === "" ? "8788" : port}`;

  const first: AgentIdentity = {
    name: "Ada",
    role: "buys proofs on credit and settles from her own wallet",
    creditcoin: oneCreditcoin.value,
    ethereum: oneEthereum.value,
  };
  const second: AgentIdentity = {
    name: "Bex",
    role: "buys proofs on credit and settles through a smart account",
    creditcoin: twoCreditcoin.value,
    ethereum: twoEthereum.value,
    ...(smartAccount === undefined ? {} : { smartAccount }),
  };

  return ok({
    creditcoinRpcUrl: creditcoinRpcUrl.value,
    sourceRpcUrl: sourceRpcUrl.value,
    tabBook: tabBook.value,
    agentRegistry: agentRegistry.value,
    serviceRegistry: serviceRegistry.value,
    bond: bond.value,
    serviceId: serviceId.value,
    asset: { chainKey: DEMO_CHAIN_KEY, address: usdc.value, decimals: USDC_DECIMALS, symbol: "USDC" },
    collectionAddress: collectionAddress.value,
    gatewayBaseUrl,
    agents: [first, second],
  });
}

/** The Agent in the cast with the given short name, case-insensitively. */
export function agentNamed(cast: Cast, name: string): AgentIdentity | undefined {
  const wanted = name.trim().toLowerCase();
  return cast.agents.find((agent) => agent.name.toLowerCase() === wanted);
}
