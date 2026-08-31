/**
 * The payment-strategy seam.
 *
 * A Service or an Agent settles through a `PaymentStrategy` and never against a
 * chain directly, which is what lets a third party add a chain or an Asset Tab
 * has never heard of without a line of this package changing (R23.6). This
 * module defines the shapes; `ethereum-usdc.ts` is the one implementation this
 * package ships (R23.1), and `registry.ts` and `config.ts` are the three ways a
 * consumer supplies more.
 *
 * ## Three domain facts the types enforce
 *
 * **1. Amounts are integer Asset base units, always `bigint`.** No amount in
 * this file is a `number`. USDC is 6 decimals on both Source Chains, a
 * Settlement amount routinely exceeds what a float represents exactly, and a
 * rounded amount that still looks plausible is worse than one that fails to
 * compile. There are no rates and no conversions anywhere in the seam.
 *
 * **2. A Settlement's identity is its replay key, not its transaction hash.**
 * The identity of a Verified Settlement is the tuple
 * `(chainKey, blockHeight, txIndex, logIndex)` packed into one 32-byte word by
 * `packReplayKey` in `@tabai/shared`. {@link SettlementReceipt} carries a
 * `sourceTxHash`, and that field is a *submission locator* — what the Agent just
 * broadcast, useful for a block explorer link and for finding the log again. It
 * is not the identity. One transaction can carry many Settlements
 * (`settleBatch`), so a transaction hash does not identify one of them; the log
 * index does. {@link settlementReplayKey} is the only way to name a Settlement
 * once its log position is known, and it exists here so no consumer invents a
 * second identity.
 *
 * **3. The payer comes from `topics[1]`, never from the transaction sender.**
 * Both Settlement surfaces put the paying account in `topics[1]` of the log —
 * `TabSettled(address indexed agent, ...)` on chainKey 1 and
 * `Transfer(address indexed from, ...)` on chainKey 3. The transaction `from`
 * field is a different thing: with a relayer, a smart account, or ERC-4337 it is
 * the account that paid *gas*, which is not the account that paid the
 * Settlement. {@link SettlementHint} therefore carries
 * {@link SettlementHint.expectedPayerTopic} so the Watcher matches the topic,
 * and its observation filter matches
 * {@link SettlementHint.expectedCollectionTopic} on `topics[2]`.
 *
 * Requirements: 23.1, 23.6
 */

import {
  eventTopic0,
  isAddress,
  isBytes32,
  ok,
  packReplayKey,
  type Address,
  type Bytes32,
  type Hex,
  type Result,
} from "@tabai/shared";
import { validationError } from "../errors.js";

/**
 * One Asset on one Source Chain.
 *
 * `chainKey` is Tab's own chain identifier (`1` Ethereum Sepolia, `3` Ethereum
 * Mainnet), not the EVM chain id, and it is a `bigint` because it is a `uint64`
 * field of the replay key everywhere else in the system.
 */
export interface AssetRef {
  readonly chainKey: bigint;
  readonly address: Address;
  /** Decimals of the Asset. Informational: every amount here is already base units. */
  readonly decimals: number;
  readonly symbol: string;
}

/** What a Service charged, or what an Agent is about to settle. */
export interface ChargeRequest {
  /** The Agent's Creditcoin address — its identity on the rail. */
  readonly agent: Address;
  readonly serviceId: Bytes32;
  readonly asset: AssetRef;
  /** Integer Asset base units. Never a float, never a `number`. */
  readonly amount: bigint;
}

/**
 * How a Settlement reaches its Source Chain.
 *
 * Two modes rather than one code path with a flag, because the two surfaces are
 * genuinely different transactions against different contracts producing
 * different logs:
 *
 * - `direct-transfer` — a plain Asset `Transfer` to a registered Collection
 *   Address *is* the Settlement. Tab deploys no contract on chainKey 3 at all,
 *   so there is nothing to call. (R2.1)
 * - `settlement-contract` — `TabSettlement.settle` moves the Asset and emits
 *   `TabSettled`, carrying explicit intent: Agent, Service, amount, and tab
 *   identifier. (R1.2)
 */
export type SettlementMode = "direct-transfer" | "settlement-contract";

export interface SettleRequest extends ChargeRequest {
  /** The Collection Address the Service registered for this Asset. `topics[2]` of the log. */
  readonly collectionAddress: Address;
  readonly tabId: Bytes32;
  readonly mode: SettlementMode;
}

/** What a strategy says a charge will cost before anything is submitted. */
export interface ChargeQuote {
  readonly amount: bigint;
  readonly asset: AssetRef;
  /** Plain-language note on anything the amount does not include, such as gas. */
  readonly feeNote: string;
}

/**
 * What one submitted Settlement looks like from the submitting side.
 *
 * A superset of the four fields design section 9.1 lists, and the extra fields
 * are load-bearing rather than convenience: `watchHint(receipt)` takes the
 * receipt and nothing else, so unless the receipt records which surface was used
 * and which contract, Collection Address, and tabId were named,
 * {@link PaymentStrategy.watchHint} would have to re-derive intent — exactly
 * what design section 9.2 says it must not do.
 *
 * This is a submission receipt, not a Verified Settlement. It proves nothing. It
 * becomes a Verified Settlement only once the log it describes is proven on
 * Creditcoin, at which point it is named by its replay key
 * ({@link settlementReplayKey}) rather than by `sourceTxHash`.
 */
export interface SettlementReceipt {
  readonly strategyId: string;
  readonly chainKey: bigint;
  /**
   * The Source Chain transaction just broadcast. A locator for finding the log
   * and for an explorer link — never the identity of the Settlement, because one
   * transaction can carry many.
   */
  readonly sourceTxHash: Hex;
  readonly asset: AssetRef;
  readonly amount: bigint;
  /**
   * The account the Asset moved out of, resolved from the signer. This is the
   * address that will appear in `topics[1]` of the Settlement log, and the
   * Watcher reads it from there rather than trusting this field.
   */
  readonly payerAddress: Address;
  /** Milliseconds since the epoch, at submission. */
  readonly submittedAt: number;
  readonly mode: SettlementMode;
  readonly collectionAddress: Address;
  readonly tabId: Bytes32;
  /** The contract whose log carries this Settlement: the Asset, or `TabSettlement`. */
  readonly emitter: Address;
  /** Position within a `settleBatch` call, absent for a single Settlement. */
  readonly batchIndex?: number;
}

/**
 * Everything the Watcher needs to find one Settlement's log and nothing it does
 * not.
 *
 * A superset of design section 9.1's four fields. The three topic fields are
 * required by the Watcher's observation filter, which matches
 * `topics[0] == expectedEventSignature`, `topics[2] == expectedCollectionTopic`,
 * and resolves the payer from `topics[1]`. A hint carrying only the transaction
 * hash and the event signature would leave the Watcher to guess which of a
 * batch's logs it is looking at, and would leave the payer to be read from the
 * transaction sender — the one place it must never come from.
 */
export interface SettlementHint {
  readonly chainKey: bigint;
  /** Where to start looking. Not the Settlement's identity. */
  readonly sourceTxHash: Hex;
  /** `topics[0]`: the Keccak-256 hash of the event's canonical signature. */
  readonly expectedEventSignature: Bytes32;
  /** The log's `address`: the Asset on `direct-transfer`, `TabSettlement` on `settlement-contract`. */
  readonly expectedEmitter: Address;
  /** `topics[1]`: the payer, left-padded to 32 bytes. The payer is resolved from here. */
  readonly expectedPayerTopic: Bytes32;
  /** `topics[2]`: the Collection Address, left-padded to 32 bytes. */
  readonly expectedCollectionTopic: Bytes32;
  /** `topics[3]`: the tabId. Present on the `settlement-contract` surface alone. */
  readonly expectedTabIdTopic?: Bytes32;
  readonly asset: AssetRef;
  readonly amount: bigint;
}

/**
 * Where a Settlement log sits on its Source Chain. The four fields of the replay
 * key, and the whole of a Verified Settlement's identity.
 */
export interface SettlementLogPosition {
  readonly chainKey: bigint;
  readonly blockHeight: bigint;
  readonly txIndex: bigint;
  readonly logIndex: bigint;
}

export interface PaymentStrategy {
  /** Stable across versions; the registry is keyed by it. For example `ethereum-usdc`. */
  readonly id: string;
  readonly chainKeys: readonly bigint[];
  supports(asset: AssetRef): boolean;
  quote(request: ChargeRequest): Promise<Result<ChargeQuote>>;
  settle(request: SettleRequest): Promise<Result<SettlementReceipt>>;
  /**
   * Settles many charges in one Source Chain transaction, one log per
   * Settlement (R1.4). Optional: a surface with no batch form — a plain Asset
   * `Transfer` has none — leaves it undefined rather than faking one.
   */
  settleBatch?(requests: readonly SettleRequest[]): Promise<Result<readonly SettlementReceipt[]>>;
  watchHint(receipt: SettlementReceipt): SettlementHint;
}

/**
 * The identity of a Verified Settlement: `(chainKey, blockHeight, txIndex,
 * logIndex)` packed into one 32-byte word.
 *
 * A thin pass-through to `packReplayKey` in `@tabai/shared`, exported here so a
 * consumer holding a receipt and an observed log position never reaches for the
 * transaction hash instead. The packing lives in one place for the contracts,
 * the Watcher, and the SDK, and this is not a second copy of it.
 */
export const settlementReplayKey = (position: SettlementLogPosition): Bytes32 =>
  packReplayKey(position);

/**
 * The registry key for an Asset: `${chainKey}:${address}` with the address
 * lower-cased.
 *
 * Lower-cased deliberately. An Asset address arrives checksummed from one source
 * and lower-case from another, and two spellings of one Asset in a lookup table
 * is a strategy that silently fails to support the Asset it was configured for.
 */
export const assetKey = (asset: AssetRef): string =>
  `${asset.chainKey.toString(10)}:${asset.address.toLowerCase()}`;

/** True when both refs name the same Asset on the same chain, spelling aside. */
export const sameAsset = (a: AssetRef, b: AssetRef): boolean => assetKey(a) === assetKey(b);

/** Left-pads an address into the 32-byte word an indexed `address` topic holds. */
export const addressTopic = (address: Address): Bytes32 =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/** `topics[0]` of the log each mode produces, taken from `@tabai/shared`. */
export const eventSignatureFor = (mode: SettlementMode): Bytes32 =>
  mode === "settlement-contract" ? eventTopic0("TabSettled") : eventTopic0("Transfer");

/**
 * Calls `supports` on a consumer-supplied strategy without letting it throw.
 *
 * A third-party strategy is code this package did not write, and resolution runs
 * it. A `supports` implementation that throws would otherwise take down a charge
 * through a code path that returns `Result` everywhere else, so a throw is read
 * as "does not support" and logged.
 */
export function supportsAsset(
  strategy: PaymentStrategy,
  asset: AssetRef,
  onThrow?: (error: unknown) => void,
): boolean {
  try {
    return strategy.supports(asset) === true;
  } catch (error) {
    onThrow?.(error);
    return false;
  }
}

/** Validates an `AssetRef` that arrived as `unknown`. */
export function validateAssetRef(value: unknown, label: string): Result<AssetRef> {
  if (typeof value !== "object" || value === null) {
    return validationError("ASSET_REF_INVALID", `${label} must be an object describing one Asset`);
  }
  const candidate = value as Partial<AssetRef>;
  if (typeof candidate.chainKey !== "bigint" || candidate.chainKey < 0n) {
    return validationError(
      "ASSET_REF_INVALID",
      `${label}.chainKey must be a non-negative bigint; a chainKey is a uint64 field of the replay key`,
    );
  }
  if (!isAddress(candidate.address)) {
    return validationError("ASSET_REF_INVALID", `${label}.address must be a 20-byte 0x address`);
  }
  if (
    typeof candidate.decimals !== "number" ||
    !Number.isInteger(candidate.decimals) ||
    candidate.decimals < 0
  ) {
    return validationError("ASSET_REF_INVALID", `${label}.decimals must be a non-negative integer`);
  }
  if (typeof candidate.symbol !== "string" || candidate.symbol.length === 0) {
    return validationError("ASSET_REF_INVALID", `${label}.symbol must be a non-empty string`);
  }
  return ok(candidate as AssetRef);
}

/**
 * Validates that an `unknown` — a config-file entry, a dynamically imported
 * module's default export — implements {@link PaymentStrategy}.
 *
 * Structural rather than nominal on purpose: R23.6 is only satisfied if a
 * strategy written against no import of this package still registers.
 */
export function validatePaymentStrategy(value: unknown, label = "strategy"): Result<PaymentStrategy> {
  if (typeof value !== "object" || value === null) {
    return validationError("STRATEGY_INVALID", `${label} must be an object implementing PaymentStrategy`);
  }
  const candidate = value as Partial<PaymentStrategy>;
  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
    return validationError("STRATEGY_INVALID", `${label}.id must be a non-empty string`);
  }
  const id = candidate.id;
  if (!Array.isArray(candidate.chainKeys) || candidate.chainKeys.length === 0) {
    return validationError(
      "STRATEGY_INVALID",
      `${label} \`${id}\` must declare at least one chainKey in chainKeys`,
    );
  }
  for (const chainKey of candidate.chainKeys) {
    if (typeof chainKey !== "bigint") {
      return validationError(
        "STRATEGY_INVALID",
        `${label} \`${id}\` must declare every chainKey as a bigint, received ${typeof chainKey}`,
      );
    }
  }
  for (const method of ["supports", "quote", "settle", "watchHint"] as const) {
    if (typeof candidate[method] !== "function") {
      return validationError("STRATEGY_INVALID", `${label} \`${id}\` must implement ${method}()`);
    }
  }
  if (candidate.settleBatch !== undefined && typeof candidate.settleBatch !== "function") {
    return validationError(
      "STRATEGY_INVALID",
      `${label} \`${id}\` declares settleBatch but it is not a function; leave it undefined when the surface has no batch form`,
    );
  }
  return ok(candidate as PaymentStrategy);
}

/** Validates the fields every charge carries. */
export function validateChargeRequest(request: ChargeRequest): Result<ChargeRequest> {
  if (!isAddress(request.agent)) {
    return validationError("CHARGE_INVALID", "request.agent must be a 20-byte 0x address");
  }
  if (!isBytes32(request.serviceId)) {
    return validationError("CHARGE_INVALID", "request.serviceId must be a 32-byte 0x word");
  }
  const asset = validateAssetRef(request.asset, "request.asset");
  if (!asset.ok) return asset;
  if (typeof request.amount !== "bigint") {
    return validationError(
      "CHARGE_INVALID",
      "request.amount must be a bigint count of Asset base units, never a number",
    );
  }
  if (request.amount <= 0n) {
    return validationError("AMOUNT_NOT_POSITIVE", "request.amount must be greater than zero base units");
  }
  return ok(request);
}

/** Validates the fields a Settlement adds on top of a charge. */
export function validateSettleRequest(request: SettleRequest): Result<SettleRequest> {
  const charge = validateChargeRequest(request);
  if (!charge.ok) return charge;
  if (!isAddress(request.collectionAddress)) {
    return validationError("SETTLE_INVALID", "request.collectionAddress must be a 20-byte 0x address");
  }
  if (!isBytes32(request.tabId)) {
    return validationError("SETTLE_INVALID", "request.tabId must be a 32-byte 0x word");
  }
  if (request.mode !== "direct-transfer" && request.mode !== "settlement-contract") {
    return validationError(
      "SETTLE_INVALID",
      'request.mode must be "direct-transfer" or "settlement-contract"',
    );
  }
  return ok(request);
}
