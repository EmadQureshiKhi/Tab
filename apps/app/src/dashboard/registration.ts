/**
 * Building the `registerService` call, and checking it before a wallet sees it.
 *
 * ## Why this is encoded rather than assembled by hand
 *
 * Every other write this Dashboard makes is `requestBinding(uint64,address)`,
 * two static words, and `src/dashboard/binding.ts` lays those out in place
 * because doing so is exact and obvious. `registerService` takes five dynamic
 * arrays, which means a head of offsets and five tails, and the offsets are
 * relative to different origins depending on nesting. Hand-rolling that to send
 * a transaction that registers a business is the wrong place to save a
 * dependency, so this uses the encoder the rest of the repository already uses.
 *
 * `ethers` rather than a second library: the watcher, the registry indexer and
 * the SDK all encode with `ethers.Interface`, and a repository with two ABI
 * encoders is a repository where two encoders can disagree.
 *
 * ## Nothing here throws
 *
 * A form is a hostile input. Every check returns a `Result` carrying the sentence
 * a reader needs, and the encoder is only reached once every field has passed,
 * so a malformed value is reported beside the field rather than as a failed
 * transaction after a wallet prompt.
 *
 * Requirements: 11.1, 24.5, 24.10
 */

import { Interface, encodeBytes32String } from "ethers";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = <T>(message: string): Result<T> => ({ ok: false, message });

/**
 * The one function this file encodes.
 *
 * Written out rather than imported from the shared ABI so the shape the wizard
 * sends is visible next to the form that fills it in.
 */
const REGISTER_SERVICE_ABI = [
  "function registerService(bytes32 serviceId, uint64[] chainKeys, address[] assets, address[] collections, bytes32[] tools, uint256[] prices, uint32 settlementWindow)",
] as const;

/** One Asset the Service accepts, and where it collects that Asset. */
export interface AssetTerm {
  /** Tab's own chain key. 1 is Ethereum Sepolia, 3 is Ethereum Mainnet. */
  readonly chainKey: string;
  readonly asset: string;
  readonly collection: string;
}

/** One tool and what it costs, in the Asset's own base units. */
export interface ToolTerm {
  readonly tool: string;
  /** Decimal base units as typed, so nothing passes through a float. */
  readonly priceBaseUnits: string;
}

export interface Registration {
  readonly serviceName: string;
  readonly settlementWindowSeconds: string;
  readonly assets: readonly AssetTerm[];
  readonly tools: readonly ToolTerm[];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** An ascii name the registry can hold, as its 32-byte word. */
export function toWord(name: string, what: string): Result<string> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return bad(`The ${what} cannot be empty.`);
  if (trimmed.length > 31) {
    return bad(
      `The ${what} is stored as 31 bytes of ascii, and "${trimmed}" is ${trimmed.length} characters.`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (!/^[\x20-\x7e]+$/.test(trimmed)) {
    return bad(`The ${what} must be printable ascii, because that is what the registry stores.`);
  }
  try {
    return ok(encodeBytes32String(trimmed));
  } catch {
    return bad(`"${trimmed}" cannot be stored as a 32-byte name.`);
  }
}

/** A whole number of base units, as a `bigint`. Never a decimal. */
export function toBaseUnits(value: string, what: string): Result<bigint> {
  const trimmed = value.trim().replace(/_/g, "");
  if (!/^\d+$/.test(trimmed)) {
    return bad(
      `${what} must be a whole number of the Asset's smallest unit. USDC has six decimals, so one cent is 10000.`,
    );
  }
  return ok(BigInt(trimmed));
}

/**
 * The Settlement Window, in the range the contract accepts.
 *
 * `ServiceRegistry` takes 1 to 86400 inclusive, and zero to mean the registry
 * default. Rejecting an out-of-range value here rather than on chain is the
 * difference between a sentence under a field and a reverted transaction that
 * cost gas.
 */
export function toWindow(value: string): Result<number> {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return bad("The Settlement Window is a whole number of seconds.");
  const seconds = Number.parseInt(trimmed, 10);
  if (seconds !== 0 && (seconds < 1 || seconds > 86_400)) {
    return bad(
      "The Settlement Window must be between 1 second and 24 hours, or zero to take the registry default.",
    );
  }
  return ok(seconds);
}

export interface EncodedRegistration {
  readonly data: string;
  readonly serviceId: string;
  /** Every argument, for the preview the wizard shows before anything is signed. */
  readonly summary: {
    readonly serviceId: string;
    readonly chainKeys: readonly string[];
    readonly assets: readonly string[];
    readonly collections: readonly string[];
    readonly tools: readonly string[];
    readonly prices: readonly string[];
    readonly settlementWindow: number;
  };
}

/**
 * Turns a filled form into calldata.
 *
 * The prices array is Asset-major: for each Asset in order, one price per tool in
 * order. That is what the contract's `tools`/`prices` pairing means, and getting
 * it wrong would price the right tools in the wrong Assets without failing.
 */
export function encodeRegistration(input: Registration): Result<EncodedRegistration> {
  const serviceId = toWord(input.serviceName, "Service name");
  if (!serviceId.ok) return serviceId;

  const window = toWindow(input.settlementWindowSeconds);
  if (!window.ok) return window;

  if (input.assets.length === 0) return bad("A Service must accept at least one Asset.");
  if (input.tools.length === 0) return bad("A Service must price at least one tool.");

  const chainKeys: bigint[] = [];
  const assets: string[] = [];
  const collections: string[] = [];
  for (const term of input.assets) {
    if (!/^\d+$/.test(term.chainKey.trim())) return bad("Each chain key is a whole number.");
    if (!ADDRESS.test(term.asset.trim())) return bad(`"${term.asset}" is not an Asset address.`);
    if (!ADDRESS.test(term.collection.trim())) {
      return bad(`"${term.collection}" is not a Collection Address.`);
    }
    chainKeys.push(BigInt(term.chainKey.trim()));
    assets.push(term.asset.trim().toLowerCase());
    collections.push(term.collection.trim().toLowerCase());
  }

  const tools: string[] = [];
  for (const term of input.tools) {
    const word = toWord(term.tool, "tool name");
    if (!word.ok) return word;
    tools.push(word.value);
  }

  const prices: bigint[] = [];
  for (const term of input.assets) {
    for (const tool of input.tools) {
      const amount = toBaseUnits(
        tool.priceBaseUnits,
        `The price of ${tool.tool.trim()} in ${term.asset.trim().slice(0, 10)}…`,
      );
      if (!amount.ok) return amount;
      prices.push(amount.value);
    }
  }

  const iface = new Interface([...REGISTER_SERVICE_ABI]);
  const data = iface.encodeFunctionData("registerService", [
    serviceId.value,
    chainKeys,
    assets,
    collections,
    tools,
    prices,
    window.value,
  ]);

  return ok({
    data,
    serviceId: serviceId.value,
    summary: {
      serviceId: serviceId.value,
      chainKeys: chainKeys.map(String),
      assets,
      collections,
      tools,
      prices: prices.map(String),
      settlementWindow: window.value,
    },
  });
}

/**
 * Where a Service collects the deposit that becomes its Bond.
 *
 * A Bond collection is registered per chain and per Asset, exactly like a
 * settlement Collection Address and for the same reason: a deposit is proved by
 * the Settlement that paid it, and a Settlement is only meaningful on the chain
 * it happened on.
 */
const BOND_COLLECTION_ABI = [
  "function registerBondCollection(bytes32 serviceId, uint64 chainKey, address asset, address collection)",
] as const;

/** A plain ERC-20 transfer, which is how a deposit reaches the collection. */
const ERC20_ABI = ["function transfer(address to, uint256 amount) returns (bool)"] as const;

export function encodeBondCollection(input: {
  readonly serviceId: string;
  readonly chainKey: string;
  readonly asset: string;
  readonly collection: string;
}): Result<string> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.serviceId.trim())) {
    return bad("The serviceId is the 32-byte word the registry keys the Service by.");
  }
  if (!/^\d+$/.test(input.chainKey.trim())) return bad("The chain key is a whole number.");
  if (!ADDRESS.test(input.asset.trim())) return bad(`"${input.asset}" is not an Asset address.`);
  if (!ADDRESS.test(input.collection.trim())) {
    return bad(`"${input.collection}" is not a Collection Address.`);
  }
  const iface = new Interface([...BOND_COLLECTION_ABI]);
  return ok(
    iface.encodeFunctionData("registerBondCollection", [
      input.serviceId.trim().toLowerCase(),
      BigInt(input.chainKey.trim()),
      input.asset.trim().toLowerCase(),
      input.collection.trim().toLowerCase(),
    ]),
  );
}

export function encodeTransfer(to: string, baseUnits: string): Result<string> {
  if (!ADDRESS.test(to.trim())) return bad(`"${to}" is not an address.`);
  const amount = toBaseUnits(baseUnits, "The deposit");
  if (!amount.ok) return amount;
  if (amount.value === 0n) return bad("A deposit of nothing would prove nothing.");
  const iface = new Interface([...ERC20_ABI]);
  return ok(iface.encodeFunctionData("transfer", [to.trim().toLowerCase(), amount.value]));
}
