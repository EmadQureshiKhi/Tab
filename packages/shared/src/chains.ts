/**
 * Chain and Asset constants for Tab on Monad.
 *
 * The Agent's payment and the ledger entry happen in the same Monad
 * transaction. What this module carries is which Monad network a deployment
 * targets and which Assets it settles in.
 *
 * Addresses of Tab's own contracts are deployment output and live in
 * `deployments.json`. The one exception is {@link METERING_DELEGATES}, which
 * the published SDK and the Agent Wallet plugin read at run time on a machine
 * with no copy of the repository; its test holds it to `deployments.json`.
 */
import type { Address, Bytes32 } from "./hex.js";

/** A Monad network a Tab deployment can target. */
export interface ChainDescriptor {
  readonly name: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  /** The MON faucet, testnet only. */
  readonly faucetUrl?: string;
}

export const MONAD_MAINNET = {
  name: "Monad Mainnet",
  chainId: 143,
  rpcUrl: "https://rpc.monad.xyz",
  explorerUrl: "https://monadvision.com",
} as const satisfies ChainDescriptor;

export const MONAD_TESTNET = {
  name: "Monad Testnet",
  chainId: 10143,
  rpcUrl: "https://testnet-rpc.monad.xyz",
  explorerUrl: "https://testnet.monadvision.com",
  faucetUrl: "https://faucet.monad.xyz",
} as const satisfies ChainDescriptor;

export const CHAINS = {
  [MONAD_MAINNET.chainId]: MONAD_MAINNET,
  [MONAD_TESTNET.chainId]: MONAD_TESTNET,
} as const;

export type MonadChainId = keyof typeof CHAINS;

export function isMonadChainId(value: unknown): value is MonadChainId {
  return value === MONAD_MAINNET.chainId || value === MONAD_TESTNET.chainId;
}

export function chainFor(chainId: number | bigint): ChainDescriptor | undefined {
  const narrowed = typeof chainId === "bigint" ? Number(chainId) : chainId;
  return isMonadChainId(narrowed) ? CHAINS[narrowed] : undefined;
}

/** Link to an address or a transaction on the explorer for a chain. */
export function explorerLink(chain: ChainDescriptor, kind: "address" | "tx", hash: string): string {
  return `${chain.explorerUrl}/${kind}/${hash}`;
}

/** A stablecoin Tab settles in. Amounts everywhere are integer base units. */
export interface AssetDescriptor {
  readonly symbol: string;
  readonly decimals: number;
  readonly address: Address;
}

/** Canonical stablecoins on Monad Mainnet. */
export const MAINNET_ASSETS = {
  USDC: {
    symbol: "USDC",
    decimals: 6,
    address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  },
  AUSD: {
    symbol: "AUSD",
    decimals: 6,
    address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
  },
} as const satisfies Readonly<Record<string, AssetDescriptor>>;

/**
 * Stablecoins on Monad Testnet. `USDC` is Circle's own testnet deployment
 * (`name` "USDC", EIP-712 version "2", 20 USDC per address every two hours from
 * https://faucet.circle.com). `MockUsdc`, the mintable test double the deploy
 * script ships, is a deployment output and lives in `deployments.json`.
 */
export const TESTNET_ASSETS = {
  USDC: {
    symbol: "USDC",
    decimals: 6,
    address: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
  },
} as const satisfies Readonly<Record<string, AssetDescriptor>>;

/**
 * Uniswap's Permit2, at its canonical address on every chain it was deployed
 * to, Monad Mainnet and Testnet included. `TabSettlement.settleWithPermit2`
 * verifies an Agent's signature against it, so an Agent approves Permit2 once
 * and signs thereafter.
 */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const satisfies Address;

/** The x402 facilitator that verifies and settles `exact` payments on Monad. */
export const X402_FACILITATOR_URL = "https://x402-facilitator.molandak.org" as const;

/**
 * `MeteringDelegates` on each network, or `undefined` where it is not deployed.
 *
 * An Agent names a session key there to sign its metering claims; a gateway
 * reads it to accept that key's signature. `undefined` means delegates are
 * unsupported on that network, and every consumer treats it that way: the
 * plugin refuses `mm tab delegate` by name and signs no call with a delegate.
 *
 * Filling one in is a one-line change once the contract is deployed and
 * recorded under `contracts.MeteringDelegates` in `deployments.json`; the
 * test in `test/chains.test.mjs` fails until the two agree.
 */
export const METERING_DELEGATES: Readonly<Record<MonadChainId, Address | undefined>> = {
  [MONAD_MAINNET.chainId]: "0x32f04C3e19d6a39f1B8A513ad86Bd8d5c6486F98",
  [MONAD_TESTNET.chainId]: "0xD287900EE0D4415CE4d362Fe8b6a4D4d6413A1a9",
};

/** The `MeteringDelegates` address on a network, or `undefined` where there is none. */
export function meteringDelegatesFor(chainId: number | bigint): Address | undefined {
  const narrowed = typeof chainId === "bigint" ? Number(chainId) : chainId;
  return isMonadChainId(narrowed) ? METERING_DELEGATES[narrowed] : undefined;
}

/** A Service this project hosts, and where it is reached. */
export interface HostedService {
  readonly serviceId: Bytes32;
  readonly name: string;
  readonly endpoint: string;
}

/** What this project hosts on one network: the read API and the demo Service. */
export interface TabHosted {
  readonly registryUrl: string;
  readonly demoService: HostedService;
  /** The test token the hosted deployment prices in, where it ships one: `mUSDC`, 6 decimals. */
  readonly testAsset?: Address;
  /**
   * The deployment's `TabSettlement`, so a fresh install holding `AGENT_PRIVATE_KEY`
   * can settle with no `tab.config` at all. The same address `deployments.json` records.
   */
  readonly tabSettlement: Address;
}

/**
 * The read API and the demo Service this project runs, per network.
 *
 * Defaults, never authority: the chain is the authority on every figure, and a
 * configured `registryUrl` or `services` entry always wins over these. They are
 * here so that a fresh install can discover and call something before its owner
 * has configured anything, which is the first thing anyone tries.
 */
export const TAB_HOSTED = {
  [MONAD_MAINNET.chainId]: {
    registryUrl: "https://registry-mainnet-production.up.railway.app",
    demoService: {
      serviceId: "0x7461622e64656d6f000000000000000000000000000000000000000000000000",
      name: "tab.demo",
      endpoint: "https://gateway-mainnet-production.up.railway.app",
    },
    tabSettlement: "0x32A96bfEABe766B4898b961B333B7B89f079a9a9",
  },
  [MONAD_TESTNET.chainId]: {
    registryUrl: "https://registry-testnet-production.up.railway.app",
    demoService: {
      serviceId: "0x7461622e64656d6f000000000000000000000000000000000000000000000000",
      name: "tab.demo",
      endpoint: "https://gateway-testnet-production-a657.up.railway.app",
    },
    testAsset: "0x480209747417f5c830fDA188a9b9AcFa70Bc4083",
    tabSettlement: "0x654Fac48185e4B71779eEc2457B1F24aEdf46717",
  },
} as const satisfies Readonly<Record<MonadChainId, TabHosted>>;

/** The two ERC-8004 registries a Tab deployment reads and writes. */
export interface Erc8004Registries {
  /** Agent identities: an ERC-721 whose token id is the agentId and whose URI is the registration file. */
  readonly identity: Address;
  /** Feedback about agents, keyed by agentId and client. */
  readonly reputation: Address;
}

/** The canonical ERC-8004 registries, keyed by chain id. */
export const ERC8004_REGISTRIES = {
  [MONAD_MAINNET.chainId]: {
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  },
  [MONAD_TESTNET.chainId]: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
} as const satisfies Readonly<Record<MonadChainId, Erc8004Registries>>;

export function erc8004RegistriesFor(chainId: number | bigint): Erc8004Registries | undefined {
  const narrowed = typeof chainId === "bigint" ? Number(chainId) : chainId;
  return isMonadChainId(narrowed) ? ERC8004_REGISTRIES[narrowed] : undefined;
}

/** Formats an amount in base units at the given decimals for display, without floating point. */
export function formatBaseUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
