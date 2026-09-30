/**
 * The payment-strategy seam.
 *
 * A strategy is how an Agent pays down an Open Tab. Every Settlement lands through
 * `TabSettlement`, which moves the Asset to the Service and applies the Settlement
 * in the same transaction, by one of two entry points: `settle`, sent by the Agent
 * after an approval (`createMonadStrategy`), or `settleWithPermit2`, signed by the
 * Agent and sent by a relayer (`createRelayedMonadStrategy`).
 * `createKuruFundedStrategy` wraps either one and swaps the Asset in first when
 * the Agent is short, and `createIntentsFundedStrategy` brings a USDC shortfall
 * to Monad from another chain through NEAR Intents first. Either way the
 * Settlement stays one Monad transaction. The seam also lets a different signer, a smart account, a
 * session key, or a test double stand behind the same call without the SDK
 * caring which.
 *
 * ## What a strategy does not do
 *
 * It does not meter, it does not read tabs, and it does not decide amounts. It is
 * handed a fully specified charge and returns either a receipt or a typed error.
 * Every figure crossing this seam is a `bigint` count of Asset base units, never a
 * number and never a decimal string.
 */
import { isAddress, isBytes32, ok, type Address, type Bytes32, type Hex, type Result } from "@tabai/shared";
import { validationError } from "../errors.js";

/** One Asset a tab can be denominated in. `chainId` is the EVM chain id. */
export interface AssetRef {
  readonly chainId: bigint;
  readonly address: Address;
  readonly decimals: number;
  readonly symbol: string;
}

/** What a Service is asking to be paid, before any strategy is chosen. */
export interface ChargeRequest {
  readonly agent: Address;
  readonly serviceId: Bytes32;
  readonly asset: AssetRef;
  readonly amount: bigint;
}

/** A charge the strategy has been asked to pay. The surface resolves where the money goes. */
export type SettleRequest = ChargeRequest;

export interface ChargeQuote {
  readonly amount: bigint;
  readonly asset: AssetRef;
  readonly feeNote: string;
}

/**
 * What came back from a Settlement.
 *
 * `settlementId`, `applied` and `toPrepaid` are read from the `Settled` event in the
 * transaction receipt. They are `null` only when the signer could not wait for the
 * receipt, in which case the transaction hash still names the payment and the registry
 * will carry the figures once it indexes the block.
 */
export interface SettlementReceipt {
  readonly strategyId: string;
  readonly chainId: bigint;
  readonly txHash: Hex;
  readonly asset: AssetRef;
  readonly amount: bigint;
  readonly payer: Address;
  readonly serviceId: Bytes32;
  readonly settlementId: Bytes32 | null;
  readonly applied: bigint | null;
  readonly toPrepaid: bigint | null;
  readonly submittedAt: number;
  readonly batchIndex?: number;
}

export interface PaymentStrategy {
  readonly id: string;
  /** The chain ids this strategy can settle on. */
  readonly chainIds: readonly bigint[];
  supports(asset: AssetRef): boolean;
  quote(request: ChargeRequest): Promise<Result<ChargeQuote>>;
  settle(request: SettleRequest): Promise<Result<SettlementReceipt>>;
  settleBatch?(requests: readonly SettleRequest[]): Promise<Result<readonly SettlementReceipt[]>>;
}

/** The registry key for an Asset: `<chainId>:<address>`, lower-cased. */
export const assetKey = (asset: AssetRef): string =>
  `${asset.chainId.toString(10)}:${asset.address.toLowerCase()}`;

export const sameAsset = (a: AssetRef, b: AssetRef): boolean => assetKey(a) === assetKey(b);

/** A 20-byte address as a 32-byte topic. */
export const addressTopic = (address: Address): Bytes32 =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

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

export function validateAssetRef(value: unknown, label: string): Result<AssetRef> {
  if (typeof value !== "object" || value === null) {
    return validationError("ASSET_REF_INVALID", `${label} must be an object describing one Asset`);
  }
  const candidate = value as Partial<AssetRef>;
  if (typeof candidate.chainId !== "bigint" || candidate.chainId <= 0n) {
    return validationError("ASSET_REF_INVALID", `${label}.chainId must be a positive bigint EVM chain id`);
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

export function validatePaymentStrategy(value: unknown, label = "strategy"): Result<PaymentStrategy> {
  if (typeof value !== "object" || value === null) {
    return validationError("STRATEGY_INVALID", `${label} must be an object implementing PaymentStrategy`);
  }
  const candidate = value as Partial<PaymentStrategy>;
  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
    return validationError("STRATEGY_INVALID", `${label}.id must be a non-empty string`);
  }
  const id = candidate.id;
  if (!Array.isArray(candidate.chainIds) || candidate.chainIds.length === 0) {
    return validationError("STRATEGY_INVALID", `${label} \`${id}\` must declare at least one chain id in chainIds`);
  }
  for (const chainId of candidate.chainIds) {
    if (typeof chainId !== "bigint") {
      return validationError(
        "STRATEGY_INVALID",
        `${label} \`${id}\` must declare every chain id as a bigint, received ${typeof chainId}`,
      );
    }
  }
  for (const method of ["supports", "quote", "settle"] as const) {
    if (typeof candidate[method] !== "function") {
      return validationError("STRATEGY_INVALID", `${label} \`${id}\` must implement ${method}()`);
    }
  }
  if (candidate.settleBatch !== undefined && typeof candidate.settleBatch !== "function") {
    return validationError(
      "STRATEGY_INVALID",
      `${label} \`${id}\` declares settleBatch but it is not a function; leave it undefined when there is no batch form`,
    );
  }
  return ok(candidate as PaymentStrategy);
}

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
  if (request.amount > (1n << 128n) - 1n) {
    return validationError("AMOUNT_OUT_OF_RANGE", "request.amount must fit a uint128");
  }
  return ok(request);
}

export const validateSettleRequest = validateChargeRequest;
