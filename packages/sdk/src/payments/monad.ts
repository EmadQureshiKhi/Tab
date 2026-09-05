/**
 * The Monad payment strategy: approve the Asset, call `TabSettlement.settle`, and
 * read the Settlement back off the receipt.
 *
 * The transaction is signed by the Agent's own key. Nothing is escrowed and no
 * facilitator is asked: the Asset moves straight to the Service's Collection
 * address and `TabBook` applies the Settlement in the same transaction, so the
 * transaction hash is the whole proof of payment.
 *
 * ## The signer
 *
 * A structural `EthersV6Signer` rather than the `ethers` class, so a test double
 * or any wallet that can sign a transaction satisfies it. An `ethers.Signer`
 * satisfies it as is; the `Assert` below fails to compile if that ever stops
 * being true.
 */
import { Interface, MaxUint256, getAddress, isAddress as isEthersAddress } from "ethers";
import type { Signer } from "ethers";
import { causeOf, ok, wrap, type Address, type Bytes32, type Hex, type Result } from "@tabai/shared";
import { defaultLogger, type Logger } from "../logger.js";
import { chainError, upstreamError, validationError } from "../errors.js";
import { ERC20_ABI, TAB_SETTLEMENT_ABI } from "./abi.js";
import {
  assetKey,
  validateAssetRef,
  validateSettleRequest,
  type AssetRef,
  type ChargeQuote,
  type ChargeRequest,
  type PaymentStrategy,
  type SettleRequest,
  type SettlementReceipt,
} from "./strategy.js";

export const MONAD_STRATEGY_ID = "monad";

export interface EthersV6TransactionRequest {
  readonly to: string;
  readonly data: string;
  readonly value?: bigint;
}

/** One log as the receipt carries it. */
export interface EthersV6Log {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface EthersV6TransactionReceipt {
  readonly hash: string;
  readonly status: number | null;
  readonly logs: readonly EthersV6Log[];
}

export interface EthersV6TransactionResponse {
  readonly hash: string;
  wait?(confirmations?: number): Promise<EthersV6TransactionReceipt | null>;
}

export interface EthersV6CallProvider {
  call(transaction: { readonly to: string; readonly data: string }): Promise<string>;
}

export interface EthersV6Signer {
  getAddress(): Promise<string>;
  sendTransaction(transaction: EthersV6TransactionRequest): Promise<EthersV6TransactionResponse>;
  readonly provider?: EthersV6CallProvider | null;
}

type Assert<T extends true> = T;
type SignerIsAccepted = Assert<Signer extends EthersV6Signer ? true : false>;
export type EthersV6SignerAcceptsEthersSigner = SignerIsAccepted;

export interface MonadStrategyConfig {
  readonly signer: EthersV6Signer;
  /** The deployed `TabSettlement`. */
  readonly tabSettlement: Address;
  /** The Assets this strategy will settle in, keyed by `<chainId>:<address>`. */
  readonly assets: Readonly<Record<string, AssetRef>>;
  readonly id?: string;
  /** `exact` approves each amount; `unlimited` approves once. Default `exact`. */
  readonly approval?: "exact" | "unlimited";
  /** `skip` sends without reading the allowance first, for a signer with no provider. */
  readonly allowanceCheck?: "read" | "skip";
  /** Whether to wait for the receipt and decode the Settlement from it. Default `wait`. */
  readonly receipt?: "wait" | "skip";
  readonly logger?: Logger;
  readonly now?: () => number;
}

const erc20 = new Interface(ERC20_ABI);
const tabSettlement = new Interface(TAB_SETTLEMENT_ABI);
const settledTopic = tabSettlement.getEvent("Settled")?.topicHash.toLowerCase() ?? "";

/** What one `Settled` log says. */
export interface SettledLog {
  readonly settlementId: Bytes32;
  readonly agent: Address;
  readonly serviceId: Bytes32;
  readonly applied: bigint;
  readonly toPrepaid: bigint;
}

/** Reads one `Settled` log emitted by the surface, or null for any other log. */
export function decodeSettled(log: EthersV6Log, surface: Address): SettledLog | null {
  if (log.address.toLowerCase() !== surface.toLowerCase()) return null;
  if ((log.topics[0] ?? "").toLowerCase() !== settledTopic) return null;
  const fragment = tabSettlement.getEvent("Settled");
  if (fragment === null) return null;
  const decoded = tabSettlement.decodeEventLog(fragment, log.data, [...log.topics]);
  return {
    settlementId: String(decoded.settlementId).toLowerCase() as Bytes32,
    agent: getAddress(String(decoded.agent)) as Address,
    serviceId: String(decoded.serviceId).toLowerCase() as Bytes32,
    applied: BigInt(decoded.applied as bigint),
    toPrepaid: BigInt(decoded.toPrepaid as bigint),
  };
}

export function createMonadStrategy(config: MonadStrategyConfig): PaymentStrategy {
  const logger = config.logger ?? defaultLogger;
  const id = config.id ?? MONAD_STRATEGY_ID;
  const now = config.now ?? (() => Date.now());
  const approval = config.approval ?? "exact";
  const allowanceCheck = config.allowanceCheck ?? "read";
  const receiptMode = config.receipt ?? "wait";
  const assets = indexAssets(config.assets, id, logger);
  const chainIds = [...new Set([...assets.values()].map((asset) => asset.chainId))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  const known = (asset: AssetRef): AssetRef | undefined => assets.get(assetKey(asset));

  const requireKnown = (asset: AssetRef): Result<AssetRef> => {
    const shape = validateAssetRef(asset, "request.asset");
    if (!shape.ok) return shape;
    const found = known(shape.value);
    if (found === undefined) {
      return validationError("ASSET_NOT_CONFIGURED", `strategy \`${id}\` is not configured for asset ${assetKey(shape.value)}`, {
        details: { asset: assetKey(shape.value), configured: [...assets.keys()].join(", ") },
      });
    }
    if (found.decimals !== shape.value.decimals) {
      return validationError(
        "ASSET_DECIMALS_MISMATCH",
        `asset ${assetKey(found)} is configured with ${found.decimals} decimals and the request names ${shape.value.decimals}; amounts are base units and the two must agree`,
        { details: { asset: assetKey(found), configured: found.decimals, requested: shape.value.decimals } },
      );
    }
    return ok(found);
  };

  const requireSurface = (): Result<Address> => {
    const address = config.tabSettlement;
    if (typeof address !== "string" || !isEthersAddress(address)) {
      return validationError(
        "SETTLEMENT_CONTRACT_INVALID",
        `strategy \`${id}\` was given \`${String(address)}\` as its tabSettlement, which is not an address`,
      );
    }
    return ok(getAddress(address) as Address);
  };

  const payer = async (): Promise<Result<Address>> =>
    wrap(
      async () => getAddress(await config.signer.getAddress()) as Address,
      (error) => ({
        category: "UPSTREAM",
        code: "SIGNER_ADDRESS_UNAVAILABLE",
        message: `strategy \`${id}\` could not read the payer address from its signer`,
        retryable: true,
        cause: causeOf(error),
      }),
    );

  const send = async (to: Address, data: string, what: string): Promise<Result<EthersV6TransactionResponse>> => {
    const response = await wrap(
      async () => config.signer.sendTransaction({ to, data }),
      (error) => ({
        category: "CHAIN",
        code: "SETTLEMENT_SUBMISSION_FAILED",
        message: `strategy \`${id}\` could not submit ${what}`,
        retryable: true,
        details: { to },
        cause: causeOf(error),
      }),
    );
    if (!response.ok) return response;
    const hash = response.value.hash;
    if (typeof hash !== "string" || !hash.startsWith("0x")) {
      return chainError("SETTLEMENT_HASH_MISSING", `strategy \`${id}\` submitted ${what} but the signer returned no transaction hash`);
    }
    return ok(response.value);
  };

  /** Waits for the receipt and returns every `Settled` log the surface emitted in it. */
  const settledLogs = async (
    response: EthersV6TransactionResponse,
    surface: Address,
  ): Promise<Result<readonly SettledLog[] | null>> => {
    if (receiptMode === "skip" || typeof response.wait !== "function") return ok(null);
    const receipt = await wrap(
      async () => response.wait?.() ?? null,
      (error) => ({
        category: "CHAIN",
        code: "SETTLEMENT_RECEIPT_UNAVAILABLE",
        message: `strategy \`${id}\` submitted ${response.hash} but could not read its receipt`,
        retryable: true,
        details: { txHash: response.hash },
        cause: causeOf(error),
      }),
    );
    if (!receipt.ok) return receipt;
    if (receipt.value === null) return ok(null);
    if (receipt.value.status === 0) {
      return chainError("SETTLEMENT_REVERTED", `settlement ${response.hash} was mined and reverted`, {
        details: { txHash: response.hash },
      });
    }
    const logs: SettledLog[] = [];
    for (const log of receipt.value.logs) {
      const settled = decodeSettled(log, surface);
      if (settled !== null) logs.push(settled);
    }
    return ok(logs);
  };

  const ensureAllowance = async (asset: AssetRef, owner: Address, spender: Address, needed: bigint): Promise<Result<void>> => {
    if (allowanceCheck === "skip") return ok(undefined);
    const provider = config.signer.provider;
    if (provider === undefined || provider === null) {
      return upstreamError(
        "PROVIDER_REQUIRED",
        `strategy \`${id}\` needs a connected signer to read the allowance before settling; connect one or set allowanceCheck to "skip"`,
      );
    }
    const current = await wrap(
      async () => {
        const raw = await provider.call({ to: asset.address, data: erc20.encodeFunctionData("allowance", [owner, spender]) });
        return erc20.decodeFunctionResult("allowance", raw)[0] as bigint;
      },
      (error) => ({
        category: "UPSTREAM",
        code: "ALLOWANCE_READ_FAILED",
        message: `strategy \`${id}\` could not read the allowance of ${owner} for ${spender} on ${assetKey(asset)}`,
        retryable: true,
        cause: causeOf(error),
      }),
    );
    if (!current.ok) return current;
    if (current.value >= needed) return ok(undefined);
    const amount = approval === "unlimited" ? MaxUint256 : needed;
    const approved = await send(
      asset.address,
      erc20.encodeFunctionData("approve", [spender, amount]),
      `the allowance top-up for ${spender} on ${assetKey(asset)}`,
    );
    if (!approved.ok) return approved;
    // The approval has to land before the settlement is sent, or the settle reverts
    // on allowance. Waiting here costs one block and saves a wasted transaction.
    if (typeof approved.value.wait === "function") {
      const landed = await wrap(
        async () => approved.value.wait?.() ?? null,
        (error) => ({
          category: "CHAIN",
          code: "APPROVAL_RECEIPT_UNAVAILABLE",
          message: `strategy \`${id}\` could not confirm the allowance top-up ${approved.value.hash}`,
          retryable: true,
          cause: causeOf(error),
        }),
      );
      if (!landed.ok) return landed;
    }
    logger.debug("allowance topped up", { strategyId: id, asset: assetKey(asset), spender, amount: amount.toString(10), txHash: approved.value.hash });
    return ok(undefined);
  };

  const receiptFor = (
    request: SettleRequest,
    asset: AssetRef,
    payerAddress: Address,
    txHash: Hex,
    settled: SettledLog | null,
    batchIndex?: number,
  ): SettlementReceipt => ({
    strategyId: id,
    chainId: asset.chainId,
    txHash,
    asset,
    amount: request.amount,
    payer: payerAddress,
    serviceId: request.serviceId,
    settlementId: settled?.settlementId ?? null,
    applied: settled?.applied ?? null,
    toPrepaid: settled?.toPrepaid ?? null,
    submittedAt: now(),
    ...(batchIndex === undefined ? {} : { batchIndex }),
  });

  const strategy: PaymentStrategy = {
    id,
    chainIds,
    supports(asset) {
      return known(asset) !== undefined;
    },
    async quote(request: ChargeRequest): Promise<Result<ChargeQuote>> {
      const asset = requireKnown(request.asset);
      if (!asset.ok) return asset;
      if (typeof request.amount !== "bigint") {
        return validationError("CHARGE_INVALID", "request.amount must be a bigint count of Asset base units, never a number");
      }
      if (request.amount <= 0n) {
        return validationError("AMOUNT_NOT_POSITIVE", "request.amount must be greater than zero base units");
      }
      return ok({
        amount: request.amount,
        asset: asset.value,
        feeNote:
          "A stablecoin settles one-for-one in base units: the amount charged is the amount transferred, with no rate and no protocol fee. Gas is paid separately in MON and is never deducted from the Settlement amount.",
      });
    },
    async settle(request: SettleRequest): Promise<Result<SettlementReceipt>> {
      const validated = validateSettleRequest(request);
      if (!validated.ok) return validated;
      const asset = requireKnown(request.asset);
      if (!asset.ok) return asset;
      const surface = requireSurface();
      if (!surface.ok) return surface;
      const from = await payer();
      if (!from.ok) return from;
      const allowance = await ensureAllowance(asset.value, from.value, surface.value, request.amount);
      if (!allowance.ok) return allowance;
      const sent = await send(
        surface.value,
        tabSettlement.encodeFunctionData("settle", [request.serviceId, asset.value.address, request.amount]),
        `a settlement of ${request.amount.toString(10)} ${asset.value.symbol} base units`,
      );
      if (!sent.ok) return sent;
      const logs = await settledLogs(sent.value, surface.value);
      if (!logs.ok) return logs;
      return ok(receiptFor(request, asset.value, from.value, sent.value.hash as Hex, logs.value?.[0] ?? null));
    },
    async settleBatch(requests: readonly SettleRequest[]): Promise<Result<readonly SettlementReceipt[]>> {
      if (requests.length === 0) {
        return validationError("EMPTY_BATCH", "settleBatch was given no settlements");
      }
      const validatedAssets: AssetRef[] = [];
      for (const request of requests) {
        const validated = validateSettleRequest(request);
        if (!validated.ok) return validated;
        const asset = requireKnown(request.asset);
        if (!asset.ok) return asset;
        validatedAssets.push(asset.value);
      }
      const first = validatedAssets[0];
      if (first === undefined) {
        return validationError("EMPTY_BATCH", "settleBatch was given no settlements");
      }
      for (const [index, asset] of validatedAssets.entries()) {
        if (asset.chainId !== first.chainId) {
          return validationError(
            "BATCH_CHAIN_MIXED",
            `settleBatch entry ${index} settles on chain ${asset.chainId.toString(10)} and entry 0 on ${first.chainId.toString(10)}; one transaction settles on one chain`,
            { details: { index } },
          );
        }
      }
      const surface = requireSurface();
      if (!surface.ok) return surface;
      const from = await payer();
      if (!from.ok) return from;
      const owed = new Map<string, { asset: AssetRef; total: bigint }>();
      for (const [index, asset] of validatedAssets.entries()) {
        const request = requests[index];
        if (request === undefined) continue;
        const key = assetKey(asset);
        const running = owed.get(key);
        owed.set(key, { asset, total: (running?.total ?? 0n) + request.amount });
      }
      for (const { asset, total } of owed.values()) {
        const allowance = await ensureAllowance(asset, from.value, surface.value, total);
        if (!allowance.ok) return allowance;
      }
      const instructions = requests.map((request, index) => [
        request.serviceId,
        (validatedAssets[index] ?? request.asset).address,
        request.amount,
      ]);
      const sent = await send(
        surface.value,
        tabSettlement.encodeFunctionData("settleBatch", [instructions]),
        `a batch of ${requests.length} settlements`,
      );
      if (!sent.ok) return sent;
      const logs = await settledLogs(sent.value, surface.value);
      if (!logs.ok) return logs;
      return ok(
        requests.map((request, index) =>
          receiptFor(request, validatedAssets[index] ?? request.asset, from.value, sent.value.hash as Hex, logs.value?.[index] ?? null, index),
        ),
      );
    },
  };
  return strategy;
}

export function indexAssets(assets: Readonly<Record<string, AssetRef>>, id: string, logger: Logger): Map<string, AssetRef> {
  const indexed = new Map<string, AssetRef>();
  for (const [declaredKey, value] of Object.entries(assets)) {
    const validated = validateAssetRef(value, `assets["${declaredKey}"]`);
    if (!validated.ok) {
      logger.error("payment strategy asset entry ignored", { strategyId: id, key: declaredKey, message: validated.error.message });
      continue;
    }
    const derived = assetKey(validated.value);
    if (declaredKey.toLowerCase() !== derived) {
      logger.warn("payment strategy asset key disagrees with its value and the value wins", { strategyId: id, declaredKey, derivedKey: derived });
    }
    indexed.set(derived, validated.value);
  }
  return indexed;
}
