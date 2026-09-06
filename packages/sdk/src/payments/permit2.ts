/**
 * Gasless Settlement: the Agent signs, somebody else sends.
 *
 * `TabSettlement.settleWithPermit2` takes a Permit2 `PermitWitnessTransferFrom`
 * signature from the Agent and lets any account submit it. The witness binds
 * the Service, the Asset, the amount, the settlement surface and the chain, so
 * a relayer cannot redirect or resize what the Agent authorised; the nonce
 * stops a replay; the deadline bounds how long the signature is good for. What
 * the relayer contributes is gas, and the natural relayer is the Service's own
 * gateway, which wants to be paid.
 *
 * Two pieces live here. {@link signSettlementPermit} produces the signature
 * and the exact arguments the contract takes, for any code that holds an
 * Agent's signer. {@link createRelayedMonadStrategy} is a `PaymentStrategy`
 * that signs and posts to a relay endpoint, so `tab_settle` needs no MON in
 * the Agent's account at all once the one-time Permit2 approval is in place.
 *
 * The one prerequisite is that approval: Permit2 pulls the Asset with
 * `transferFrom`, so the Agent must have approved Permit2 once on the Asset.
 * That is one gas-paid transaction per Asset for the life of the account, and
 * the strategy says so by name when it is missing rather than posting a
 * signature the relayer would only watch revert.
 */
import { Interface, MaxUint256, getAddress, hexlify, randomBytes } from "ethers";
import {
  PERMIT2_ADDRESS,
  PERMIT2_WITNESS_TRANSFER_FROM_PRIMARY_TYPE,
  PERMIT2_WITNESS_TRANSFER_FROM_TYPES,
  TAB_SETTLEMENT_PERMIT2_ABI,
  causeOf,
  isAddress,
  ok,
  permit2Domain,
  wrap,
  type Address,
  type Bytes32,
  type Hex,
  type Result,
} from "@tabai/shared";
import { defaultLogger, type Logger } from "../logger.js";
import { chainError, upstreamError, validationError } from "../errors.js";
import { ERC20_ABI } from "./abi.js";
import {
  indexAssets,
  type EthersV6CallProvider,
  type EthersV6Signer,
  type EthersV6TransactionRequest,
  type EthersV6TransactionResponse,
} from "./monad.js";
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

export const RELAYED_MONAD_STRATEGY_ID = "monad-relayed";

/** How long a signature stays valid when the caller names no deadline: ten minutes. */
export const DEFAULT_PERMIT_TTL_SECONDS = 600;

/** A signer that can produce EIP-712 signatures, which an ethers `Signer` can. */
export interface Permit2Signer {
  getAddress(): Promise<string>;
  signTypedData(
    domain: { name: string; chainId: bigint; verifyingContract: string },
    types: Record<string, readonly { name: string; type: string }[]>,
    value: Record<string, unknown>,
  ): Promise<string>;
  readonly provider?: EthersV6CallProvider | null;
  sendTransaction?(transaction: EthersV6TransactionRequest): Promise<EthersV6TransactionResponse>;
}

export interface SettlementPermitInput {
  readonly signer: Permit2Signer;
  readonly chainId: bigint | number;
  /** The deployed `TabSettlement`, which is the `spender` Permit2 sees. */
  readonly tabSettlement: Address;
  readonly serviceId: Bytes32;
  readonly asset: Address;
  readonly amount: bigint;
  /** The canonical Permit2 unless a deployment overrides it. */
  readonly permit2?: Address;
  /** A Permit2 unordered nonce. Random when omitted, which is what Permit2 is built for. */
  readonly nonce?: bigint;
  /** Unix seconds. Defaults to now plus {@link DEFAULT_PERMIT_TTL_SECONDS}. */
  readonly deadline?: bigint;
  readonly now?: () => number;
}

/** Exactly what `settleWithPermit2` takes, plus what was signed, for the record. */
export interface SettlementPermit {
  readonly agent: Address;
  readonly serviceId: Bytes32;
  readonly asset: Address;
  readonly amount: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly signature: Hex;
  readonly chainId: bigint;
  readonly tabSettlement: Address;
  readonly permit2: Address;
}

const permitInterface = new Interface(TAB_SETTLEMENT_PERMIT2_ABI);
const erc20 = new Interface(ERC20_ABI);

/** A random 256-bit unordered nonce. Permit2 keys them per owner in a bitmap. */
export const randomPermitNonce = (): bigint => BigInt(hexlify(randomBytes(32)));

/**
 * Signs one Settlement under Permit2's domain.
 *
 * The typed data is `PermitWitnessTransferFrom` with `TabSettlement` as the
 * witness struct, field for field what the contract rebuilds before it hands
 * Permit2 the signature. Nothing is sent.
 */
export async function signSettlementPermit(input: SettlementPermitInput): Promise<Result<SettlementPermit>> {
  if (!isAddress(input.tabSettlement)) {
    return validationError("SETTLEMENT_CONTRACT_INVALID", `\`${String(input.tabSettlement)}\` is not the address of a TabSettlement`);
  }
  if (!isAddress(input.asset)) return validationError("ASSET_REF_INVALID", "asset must be a 20-byte 0x address");
  if (typeof input.amount !== "bigint" || input.amount <= 0n || input.amount >= 1n << 128n) {
    return validationError("AMOUNT_OUT_OF_RANGE", "amount must be a positive bigint that fits a uint128");
  }
  const permit2 = (input.permit2 ?? PERMIT2_ADDRESS) as Address;
  const chainId = BigInt(input.chainId);
  const nonce = input.nonce ?? randomPermitNonce();
  const now = input.now ?? (() => Date.now());
  const deadline = input.deadline ?? BigInt(Math.floor(now() / 1000) + DEFAULT_PERMIT_TTL_SECONDS);
  const tabSettlement = getAddress(input.tabSettlement) as Address;
  const asset = getAddress(input.asset) as Address;

  const agent = await wrap(
    async () => getAddress(await input.signer.getAddress()) as Address,
    (error) => ({
      category: "UPSTREAM",
      code: "SIGNER_ADDRESS_UNAVAILABLE",
      message: "the Agent's address could not be read from its signer",
      retryable: true,
      cause: causeOf(error),
    }),
  );
  if (!agent.ok) return agent;

  const signature = await wrap(
    async () =>
      input.signer.signTypedData(
        permit2Domain(chainId, permit2),
        PERMIT2_WITNESS_TRANSFER_FROM_TYPES as unknown as Record<string, readonly { name: string; type: string }[]>,
        {
          permitted: { token: asset, amount: input.amount },
          spender: tabSettlement,
          nonce,
          deadline,
          witness: { serviceId: input.serviceId, asset, amount: input.amount, surface: tabSettlement, chainId },
        },
      ),
    (error) => ({
      category: "UPSTREAM",
      code: "PERMIT_SIGNATURE_REFUSED",
      message: "the signer did not produce a Permit2 signature",
      retryable: false,
      cause: causeOf(error),
    }),
  );
  if (!signature.ok) return signature;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature.value)) {
    return chainError("PERMIT_SIGNATURE_MALFORMED", "the signer returned something that is not a 65-byte signature");
  }
  return ok({
    agent: agent.value,
    serviceId: input.serviceId,
    asset,
    amount: input.amount,
    nonce,
    deadline,
    signature: signature.value as Hex,
    chainId,
    tabSettlement,
    permit2,
  });
}

/** Calldata for `settleWithPermit2`, for a relayer that submits it itself. */
export function encodeSettleWithPermit2(permit: SettlementPermit): Hex {
  return permitInterface.encodeFunctionData("settleWithPermit2", [
    permit.agent,
    permit.serviceId,
    permit.asset,
    permit.amount,
    permit.nonce,
    permit.deadline,
    permit.signature,
  ]) as Hex;
}

/** The JSON body a relay endpoint takes: the permit with every integer as decimal text. */
export interface RelaySettleBody {
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly amount: string;
  readonly nonce: string;
  readonly deadline: string;
  readonly signature: string;
  readonly chainId: string;
  readonly tabSettlement: string;
}

export function toRelayBody(permit: SettlementPermit): RelaySettleBody {
  return {
    agent: permit.agent,
    serviceId: permit.serviceId,
    asset: permit.asset,
    amount: permit.amount.toString(10),
    nonce: permit.nonce.toString(10),
    deadline: permit.deadline.toString(10),
    signature: permit.signature,
    chainId: permit.chainId.toString(10),
    tabSettlement: permit.tabSettlement,
  };
}

/** Reads a relay body back into a permit, refusing anything that is not one. */
export function fromRelayBody(value: unknown, permit2: Address = PERMIT2_ADDRESS as Address): Result<SettlementPermit> {
  if (typeof value !== "object" || value === null) {
    return validationError("RELAY_BODY_INVALID", "the relay body must be a JSON object");
  }
  const body = value as Partial<RelaySettleBody>;
  const digits = (field: keyof RelaySettleBody): Result<bigint> => {
    const raw = body[field];
    if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
      return validationError("RELAY_BODY_INVALID", `${field} must be a decimal string`, { details: { field } });
    }
    return ok(BigInt(raw));
  };
  if (!isAddress(body.agent) || !isAddress(body.asset) || !isAddress(body.tabSettlement)) {
    return validationError("RELAY_BODY_INVALID", "agent, asset and tabSettlement must be 20-byte 0x addresses");
  }
  if (typeof body.serviceId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.serviceId)) {
    return validationError("RELAY_BODY_INVALID", "serviceId must be a 32-byte 0x word");
  }
  if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) {
    return validationError("RELAY_BODY_INVALID", "signature must be a 65-byte 0x hex string");
  }
  const amount = digits("amount");
  if (!amount.ok) return amount;
  if (amount.value <= 0n || amount.value >= 1n << 128n) {
    return validationError("RELAY_BODY_INVALID", "amount must be a positive uint128");
  }
  const nonce = digits("nonce");
  if (!nonce.ok) return nonce;
  const deadline = digits("deadline");
  if (!deadline.ok) return deadline;
  const chainId = digits("chainId");
  if (!chainId.ok) return chainId;
  return ok({
    agent: getAddress(body.agent) as Address,
    serviceId: body.serviceId.toLowerCase() as Bytes32,
    asset: getAddress(body.asset) as Address,
    amount: amount.value,
    nonce: nonce.value,
    deadline: deadline.value,
    signature: body.signature as Hex,
    chainId: chainId.value,
    tabSettlement: getAddress(body.tabSettlement) as Address,
    permit2,
  });
}

/** What a relay answers once the Settlement is mined. */
export interface RelaySettleReply {
  readonly ok: true;
  readonly txHash: string;
  readonly settlementId: string | null;
  readonly applied: string | null;
  readonly toPrepaid: string | null;
}

/** The little of `fetch` the strategy uses. */
export type RelayFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

export interface RelayedMonadStrategyConfig {
  readonly signer: Permit2Signer;
  readonly tabSettlement: Address;
  /** The relay endpoint, for example `https://gateway.example/relay/settle`. */
  readonly relayUrl: string;
  readonly assets: Readonly<Record<string, AssetRef>>;
  readonly permit2?: Address;
  readonly id?: string;
  /**
   * What to do when the Agent has not approved Permit2 on the Asset. `require`
   * refuses with `PERMIT2_ALLOWANCE_MISSING`; `approve` sends the one-time
   * unlimited approval first, which needs MON once; `skip` does not read it.
   */
  readonly allowance?: "require" | "approve" | "skip";
  readonly fetchImpl?: RelayFetch;
  readonly logger?: Logger;
  readonly now?: () => number;
}

function hostFetch(): RelayFetch | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as RelayFetch) : undefined;
}

/**
 * A strategy that settles by signature and a relay, never by a transaction of
 * the Agent's own.
 */
export function createRelayedMonadStrategy(config: RelayedMonadStrategyConfig): PaymentStrategy {
  const logger = config.logger ?? defaultLogger;
  const id = config.id ?? RELAYED_MONAD_STRATEGY_ID;
  const now = config.now ?? (() => Date.now());
  const allowanceMode = config.allowance ?? "require";
  const permit2 = (config.permit2 ?? PERMIT2_ADDRESS) as Address;
  const assets = indexAssets(config.assets, id, logger);
  const chainIds = [...new Set([...assets.values()].map((asset) => asset.chainId))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  const requireKnown = (asset: AssetRef): Result<AssetRef> => {
    const shape = validateAssetRef(asset, "request.asset");
    if (!shape.ok) return shape;
    const found = assets.get(assetKey(shape.value));
    if (found === undefined) {
      return validationError("ASSET_NOT_CONFIGURED", `strategy \`${id}\` is not configured for asset ${assetKey(shape.value)}`, {
        details: { asset: assetKey(shape.value), configured: [...assets.keys()].join(", ") },
      });
    }
    return ok(found);
  };

  const ensurePermit2Allowance = async (asset: AssetRef, owner: Address, needed: bigint): Promise<Result<void>> => {
    if (allowanceMode === "skip") return ok(undefined);
    const provider = config.signer.provider;
    if (provider === undefined || provider === null) {
      return upstreamError(
        "PROVIDER_REQUIRED",
        `strategy \`${id}\` needs a connected signer to read the Permit2 allowance; connect one or set allowance to "skip"`,
      );
    }
    const current = await wrap(
      async () => {
        const raw = await provider.call({ to: asset.address, data: erc20.encodeFunctionData("allowance", [owner, permit2]) });
        return erc20.decodeFunctionResult("allowance", raw)[0] as bigint;
      },
      (error) => ({
        category: "UPSTREAM",
        code: "ALLOWANCE_READ_FAILED",
        message: `strategy \`${id}\` could not read the Permit2 allowance on ${assetKey(asset)}`,
        retryable: true,
        cause: causeOf(error),
      }),
    );
    if (!current.ok) return current;
    if (current.value >= needed) return ok(undefined);
    if (allowanceMode === "require" || typeof config.signer.sendTransaction !== "function") {
      return validationError(
        "PERMIT2_ALLOWANCE_MISSING",
        `the Agent has not approved Permit2 (${permit2}) on ${assetKey(asset)}; approve it once, with gas, and every Settlement after that is a signature`,
        { details: { asset: assetKey(asset), permit2, allowance: current.value.toString(10), needed: needed.toString(10) } },
      );
    }
    const sent = await wrap(
      async () => config.signer.sendTransaction!({ to: asset.address, data: erc20.encodeFunctionData("approve", [permit2, MaxUint256]) }),
      (error) => ({
        category: "CHAIN",
        code: "SETTLEMENT_SUBMISSION_FAILED",
        message: `strategy \`${id}\` could not submit the one-time Permit2 approval on ${assetKey(asset)}`,
        retryable: true,
        cause: causeOf(error),
      }),
    );
    if (!sent.ok) return sent;
    if (typeof sent.value.wait === "function") {
      const landed = await wrap(
        async () => sent.value.wait?.() ?? null,
        (error) => ({
          category: "CHAIN",
          code: "APPROVAL_RECEIPT_UNAVAILABLE",
          message: `strategy \`${id}\` could not confirm the Permit2 approval ${sent.value.hash}`,
          retryable: true,
          cause: causeOf(error),
        }),
      );
      if (!landed.ok) return landed;
    }
    logger.info("Permit2 approved once for gasless settlement", { strategyId: id, asset: assetKey(asset), txHash: sent.value.hash });
    return ok(undefined);
  };

  const relay = async (permit: SettlementPermit): Promise<Result<RelaySettleReply>> => {
    const send = config.fetchImpl ?? hostFetch();
    if (send === undefined) return upstreamError("FETCH_UNAVAILABLE", "this host has no global fetch, so the relay cannot be reached");
    const response = await wrap(
      async () =>
        send(config.relayUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(toRelayBody(permit)),
        }),
      (error) => ({
        category: "UPSTREAM",
        code: "RELAY_UNREACHABLE",
        message: `the relay at ${config.relayUrl} did not answer`,
        retryable: true,
        cause: causeOf(error),
      }),
    );
    if (!response.ok) return response;
    const body = await wrap(
      async () => response.value.json(),
      (error) => ({
        category: "UPSTREAM",
        code: "RELAY_UNPARSEABLE",
        message: "the relay answered with something that is not JSON",
        retryable: true,
        cause: causeOf(error),
      }),
    );
    if (!body.ok) return body;
    const reply = body.value as Partial<RelaySettleReply> & { error?: { code?: string; message?: string; category?: string } };
    if (response.value.status >= 400 || reply.ok !== true || typeof reply.txHash !== "string") {
      return {
        ok: false,
        error: {
          category: response.value.status >= 500 ? "UPSTREAM" : "CHAIN",
          code: reply.error?.code ?? "RELAY_REFUSED",
          message: reply.error?.message ?? `the relay answered ${response.value.status} without a transaction hash`,
          retryable: response.value.status >= 500,
        },
      };
    }
    return ok({
      ok: true,
      txHash: reply.txHash,
      settlementId: typeof reply.settlementId === "string" ? reply.settlementId : null,
      applied: typeof reply.applied === "string" ? reply.applied : null,
      toPrepaid: typeof reply.toPrepaid === "string" ? reply.toPrepaid : null,
    });
  };

  return {
    id,
    chainIds,
    supports(asset) {
      return assets.get(assetKey(asset)) !== undefined;
    },
    async quote(request: ChargeRequest): Promise<Result<ChargeQuote>> {
      const asset = requireKnown(request.asset);
      if (!asset.ok) return asset;
      if (typeof request.amount !== "bigint" || request.amount <= 0n) {
        return validationError("AMOUNT_NOT_POSITIVE", "request.amount must be a positive bigint of base units");
      }
      return ok({
        amount: request.amount,
        asset: asset.value,
        feeNote:
          "The amount charged is the amount transferred. The Agent signs and the relay pays the gas, so nothing in MON leaves the Agent's account.",
      });
    },
    async settle(request: SettleRequest): Promise<Result<SettlementReceipt>> {
      const validated = validateSettleRequest(request);
      if (!validated.ok) return validated;
      const asset = requireKnown(request.asset);
      if (!asset.ok) return asset;
      const owner = await wrap(
        async () => getAddress(await config.signer.getAddress()) as Address,
        (error) => ({
          category: "UPSTREAM",
          code: "SIGNER_ADDRESS_UNAVAILABLE",
          message: `strategy \`${id}\` could not read the payer address from its signer`,
          retryable: true,
          cause: causeOf(error),
        }),
      );
      if (!owner.ok) return owner;
      const allowance = await ensurePermit2Allowance(asset.value, owner.value, request.amount);
      if (!allowance.ok) return allowance;
      const permit = await signSettlementPermit({
        signer: config.signer,
        chainId: asset.value.chainId,
        tabSettlement: config.tabSettlement,
        serviceId: request.serviceId,
        asset: asset.value.address,
        amount: request.amount,
        permit2,
        now,
      });
      if (!permit.ok) return permit;
      const relayed = await relay(permit.value);
      if (!relayed.ok) return relayed;
      return ok({
        strategyId: id,
        chainId: asset.value.chainId,
        txHash: relayed.value.txHash as Hex,
        asset: asset.value,
        amount: request.amount,
        payer: owner.value,
        serviceId: request.serviceId,
        settlementId: relayed.value.settlementId === null ? null : (relayed.value.settlementId.toLowerCase() as Bytes32),
        applied: relayed.value.applied === null ? null : BigInt(relayed.value.applied),
        toPrepaid: relayed.value.toPrepaid === null ? null : BigInt(relayed.value.toPrepaid),
        submittedAt: now(),
      });
    },
  };
}
