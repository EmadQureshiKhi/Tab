/**
 * Building the `registerService` call, and checking it before a wallet sees it.
 *
 * ## Why this is encoded rather than assembled by hand
 *
 * Every other write this Dashboard makes is a handful of static words, and
 * `src/dashboard/authorisation.ts` lays those out in place because doing so is
 * exact and obvious. `registerService` takes four dynamic arrays, which means a
 * head of offsets and four tails, and the offsets are relative to different
 * origins depending on nesting. Hand-rolling that to send a transaction that
 * registers a business is the wrong place to save a dependency, so this uses
 * the encoder the rest of the repository already uses.
 *
 * `ethers` rather than a second library: the gateway, the registry indexer and
 * the SDK all encode with `ethers.Interface`, and a repository with two ABI
 * encoders is a repository where two encoders can disagree.
 *
 * ## Nothing here throws
 *
 * A form is a hostile input. Every check returns a `Result` carrying the sentence
 * a reader needs, and the encoder is only reached once every field has passed,
 * so a malformed value is reported beside the field rather than as a failed
 * transaction after a wallet prompt.
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
  "function registerService(bytes32 serviceId, address[] assets, address[] collections, bytes32[] tools, uint256[] prices, uint32 settlementWindow)",
] as const;

/** One Asset the Service accepts, and where a Settlement in it is paid to. */
export interface AssetTerm {
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

  const assets: string[] = [];
  const collections: string[] = [];
  for (const term of input.assets) {
    if (!ADDRESS.test(term.asset.trim())) return bad(`"${term.asset}" is not an Asset address.`);
    if (!ADDRESS.test(term.collection.trim())) {
      return bad(`"${term.collection}" is not a Collection Address.`);
    }
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
      assets,
      collections,
      tools,
      prices: prices.map(String),
      settlementWindow: window.value,
    },
  });
}

/**
 * Funding a Bond on Monad is two calls: approve `Bond` to pull the Asset, then
 * `deposit`, which escrows it under the caller's party. `depositFor` lets a
 * treasury fund a Service's bond account without holding its key, and only that
 * account can ever withdraw what is credited.
 */
const BOND_ABI = [
  "function deposit(address asset, uint128 amount)",
  "function depositFor(address account, address asset, uint128 amount)",
  "function withdraw(address asset, uint128 amount) returns (uint128 released)",
] as const;

/** The allowance `Bond` needs before it can pull a deposit. */
const ERC20_ABI = ["function approve(address spender, uint256 amount) returns (bool)"] as const;

export function encodeApprove(spender: string, baseUnits: string): Result<string> {
  if (!ADDRESS.test(spender.trim())) return bad(`"${spender}" is not an address.`);
  const amount = toBaseUnits(baseUnits, "The deposit");
  if (!amount.ok) return amount;
  if (amount.value === 0n) return bad("An approval of nothing would allow nothing.");
  const iface = new Interface([...ERC20_ABI]);
  return ok(iface.encodeFunctionData("approve", [spender.trim().toLowerCase(), amount.value]));
}

export function encodeDeposit(input: {
  readonly asset: string;
  readonly baseUnits: string;
  /** The bond account to credit. Omitted, the caller's own. */
  readonly account?: string | undefined;
}): Result<string> {
  if (!ADDRESS.test(input.asset.trim())) return bad(`"${input.asset}" is not an Asset address.`);
  const amount = toBaseUnits(input.baseUnits, "The deposit");
  if (!amount.ok) return amount;
  if (amount.value === 0n) return bad("A deposit of nothing would back nothing.");
  if (amount.value >= 1n << 128n) return bad("The deposit must fit a uint128.");
  const iface = new Interface([...BOND_ABI]);
  if (input.account === undefined || input.account.trim().length === 0) {
    return ok(iface.encodeFunctionData("deposit", [input.asset.trim().toLowerCase(), amount.value]));
  }
  if (!ADDRESS.test(input.account.trim())) return bad(`"${input.account}" is not an address.`);
  return ok(
    iface.encodeFunctionData("depositFor", [
      input.account.trim().toLowerCase(),
      input.asset.trim().toLowerCase(),
      amount.value,
    ]),
  );
}

export function encodeWithdraw(asset: string, baseUnits: string): Result<string> {
  if (!ADDRESS.test(asset.trim())) return bad(`"${asset}" is not an Asset address.`);
  const amount = toBaseUnits(baseUnits, "The withdrawal");
  if (!amount.ok) return amount;
  if (amount.value === 0n) return bad("A withdrawal of nothing moves nothing.");
  if (amount.value >= 1n << 128n) return bad("The withdrawal must fit a uint128.");
  const iface = new Interface([...BOND_ABI]);
  return ok(iface.encodeFunctionData("withdraw", [asset.trim().toLowerCase(), amount.value]));
}
