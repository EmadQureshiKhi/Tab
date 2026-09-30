/**
 * Settle with USDC held on another chain: a strategy that brings the shortfall
 * to Monad through NEAR Intents before delegating the Settlement.
 *
 * ## What it does
 *
 * `TabSettlement.settle` moves the Asset the tab is denominated in, on Monad,
 * from the Agent's own balance. An Agent whose USDC sits on Base, Arbitrum or
 * Ethereum cannot settle until that USDC is on Monad. {@link createIntentsFundedStrategy}
 * wraps the Monad strategy: before every `settle` it reads the Agent's Monad
 * balance of the Asset, and when it is short, asks the 1Click API for an
 * exact-output quote of the shortfall delivered to the Agent's own Monad
 * address, transfers the quoted input to the deposit address on the funding
 * chain, waits for the delivery, checks the Monad balance again, and only then
 * settles.
 *
 * ## Settlement stays same-chain and atomic
 *
 * The funding step is a transfer into the Agent's own account and nothing
 * else. It never touches a tab. The Settlement is still the inner strategy's
 * one Monad transaction, which moves the Asset to the Service and applies it to
 * the tab together, so the receipt, the `Settled` event and the atomic apply
 * are unchanged. A funding step that fails, is refunded or times out returns a
 * `Result` naming the deposit address and the last status, and no Settlement is
 * sent.
 *
 * ## The 1Click API is a seam
 *
 * The funding runs through a {@link OneClickClient}: `quote`, `submitDeposit`
 * and `status`, each a `Result`. {@link createOneClickClient} is the shipped
 * implementation over `https://1click.chaindefuser.com/v0`, with an injectable
 * `fetch`, so a test drives the whole decision without a network.
 *
 * ## Planning never moves funds
 *
 * `quote`, which is what a dry run of `tab settle` and `tab_settle` calls,
 * reads the Monad balance and, when it is short, asks for a `dry: true` quote:
 * the API answers with the input it would take and creates no deposit address.
 * Only `settle` transfers anything.
 *
 * ## Amounts
 *
 * The quote is `EXACT_OUTPUT` for the shortfall, so what reaches Monad is fixed
 * and the slippage tolerance is applied to the input side. The strategy sends
 * the quote's `amountIn`, which carries that tolerance, and the API refunds any
 * excess to the Agent's address on the funding chain. A shortfall below the
 * smallest delivery the API accepts is raised to that minimum once, and the
 * difference stays in the Agent's Monad balance. `maxFundingAmount` is a
 * ceiling on the input, checked before anything is transferred.
 */

import { Interface, getAddress, isAddress as isEthersAddress } from "ethers";
import type { Signer } from "ethers";
import { causeOf, ok, wrap, type Address, type Hex, type Result } from "@tabai/shared";

import { chainError, upstreamError, validationError } from "../errors.js";
import { defaultLogger, type Logger } from "../logger.js";
import { ERC20_ABI } from "./abi.js";
import type { EthersV6CallProvider, EthersV6Signer, EthersV6TransactionResponse } from "./monad.js";
import {
  assetKey,
  validateSettleRequest,
  type AssetRef,
  type ChargeQuote,
  type ChargeRequest,
  type PaymentStrategy,
  type SettleRequest,
  type SettlementReceipt,
} from "./strategy.js";

/** The default id, which `tab settle --strategy intents-funded` names. */
export const INTENTS_FUNDED_STRATEGY_ID = "intents-funded";

/** The 1Click API. Every endpoint lives under `/v0`. */
export const ONE_CLICK_API_URL = "https://1click.chaindefuser.com";

/**
 * The Monad Assets 1Click can deliver, keyed by `assetKey`, valued by 1Click's
 * asset id. USDC on Monad Mainnet is the one Tab settles in; `GET /v0/tokens`
 * lists it at exactly Tab's Mainnet USDC address. Nothing on Testnet is listed.
 */
export const ONE_CLICK_MONAD_ASSETS: Readonly<Record<string, string>> = {
  "143:0x754704bc059f8c67012fed69bc8a327a5aafb603": "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
};

/** The token the funding step spends, on the chain it is held on. */
export interface IntentsFundingAsset {
  /** 1Click's id for the token, as `GET /v0/tokens` lists it. */
  readonly assetId: string;
  /** The EVM chain id of the funding chain. */
  readonly chainId: bigint;
  /** The ERC-20 the deposit is a transfer of. */
  readonly token: Address;
  readonly decimals: number;
  readonly symbol: string;
}

/** USDC on the funding chains 1Click lists it on, read from `GET /v0/tokens`. */
export const ONE_CLICK_USDC_FUNDING = {
  ethereum: {
    assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    chainId: 1n,
    token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
    symbol: "USDC",
  },
  arbitrum: {
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    chainId: 42161n,
    token: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    decimals: 6,
    symbol: "USDC",
  },
  base: {
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    chainId: 8453n,
    token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    decimals: 6,
    symbol: "USDC",
  },
  optimism: {
    assetId: "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ",
    chainId: 10n,
    token: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
    decimals: 6,
    symbol: "USDC",
  },
  polygon: {
    assetId: "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L",
    chainId: 137n,
    token: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    decimals: 6,
    symbol: "USDC",
  },
  avalanche: {
    assetId: "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o",
    chainId: 43114n,
    token: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
    decimals: 6,
    symbol: "USDC",
  },
} as const satisfies Readonly<Record<string, IntentsFundingAsset>>;

// ---------------------------------------------------------------- the 1Click client

/** The little of `fetch` the client uses. */
export type OneClickFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

/** `POST /v0/quote`, as far as this package fills it in. */
export interface OneClickQuoteRequest {
  /** `true` answers the amounts and creates no deposit address. */
  readonly dry: boolean;
  readonly swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
  /** Basis points. */
  readonly slippageTolerance: number;
  readonly originAsset: string;
  readonly depositType: "ORIGIN_CHAIN";
  readonly destinationAsset: string;
  /** Base units, as a decimal integer string. */
  readonly amount: string;
  readonly refundTo: string;
  readonly refundType: "ORIGIN_CHAIN";
  readonly recipient: string;
  readonly recipientType: "DESTINATION_CHAIN";
  /** ISO timestamp after which an unfilled deposit is refunded. */
  readonly deadline: string;
}

/** The amounts in a quote. Every figure is a base-unit decimal string. */
export interface OneClickQuote {
  /** Absent on a dry quote. */
  readonly depositAddress?: string;
  readonly depositMemo?: string;
  /** What to send: the minimum plus the slippage tolerance. */
  readonly amountIn: string;
  readonly minAmountIn: string;
  readonly amountOut: string;
  readonly minAmountOut: string;
  readonly deadline?: string;
  /** Seconds from a confirmed deposit to delivery, as estimated. */
  readonly timeEstimate: number;
}

export interface OneClickQuoteResponse {
  readonly correlationId: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly quoteRequest: OneClickQuoteRequest;
  readonly quote: OneClickQuote;
}

/** Where a funding step stands. `SUCCESS`, `REFUNDED` and `FAILED` are terminal. */
export type OneClickStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export interface OneClickStatusResponse {
  readonly correlationId?: string;
  readonly status: OneClickStatus;
  readonly updatedAt?: string;
  readonly swapDetails?: {
    readonly amountIn?: string;
    readonly amountOut?: string;
    readonly refundedAmount?: string;
    readonly refundReason?: string;
    readonly originChainTxHashes?: readonly { readonly hash: string }[];
    readonly destinationChainTxHashes?: readonly { readonly hash: string }[];
  };
}

/** The API seam. Every method returns a `Result`, never throws. */
export interface OneClickClient {
  quote(request: OneClickQuoteRequest): Promise<Result<OneClickQuoteResponse>>;
  submitDeposit(deposit: { readonly txHash: string; readonly depositAddress: string }): Promise<Result<OneClickStatusResponse>>;
  status(depositAddress: string): Promise<Result<OneClickStatusResponse>>;
}

export interface OneClickClientOptions {
  /** Defaults to {@link ONE_CLICK_API_URL}. */
  readonly baseUrl?: string;
  /**
   * A partner key, sent as `X-API-Key`. Optional: the API answers without
   * one and charges an extra fee on each quote instead.
   */
  readonly apiKey?: string;
  /** A partner JWT, sent as a bearer token. The older form of the same key. */
  readonly jwt?: string;
  readonly fetchImpl?: OneClickFetch;
}

const TERMINAL_FAILURES: ReadonlySet<OneClickStatus> = new Set(["REFUNDED", "FAILED"]);

function hostFetch(): OneClickFetch | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as OneClickFetch) : undefined;
}

/** Reads the minimum out of the API's `Amount is too low ..., try at least N` refusal. */
const minimumFrom = (message: string): bigint | undefined => {
  const match = /at least (\d+)/i.exec(message);
  return match?.[1] === undefined ? undefined : BigInt(match[1]);
};

/** A client over the 1Click HTTP API. */
export function createOneClickClient(options: OneClickClientOptions = {}): OneClickClient {
  const base = (options.baseUrl ?? ONE_CLICK_API_URL).replace(/\/+$/, "");
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    ...(options.apiKey === undefined || options.apiKey.length === 0 ? {} : { "x-api-key": options.apiKey }),
    ...(options.jwt === undefined || options.jwt.length === 0 ? {} : { authorization: `Bearer ${options.jwt}` }),
  };

  const call = async <T>(method: "GET" | "POST", path: string, what: string, body?: unknown): Promise<Result<T>> => {
    const send = options.fetchImpl ?? hostFetch();
    if (send === undefined) return upstreamError("FETCH_UNAVAILABLE", "this host has no global fetch, so the 1Click API cannot be reached");
    const url = `${base}${path}`;
    const response = await wrap(
      async () => send(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      (error) => ({
        category: "UPSTREAM" as const,
        code: "ONE_CLICK_UNREACHABLE",
        message: `the 1Click API did not answer ${what}`,
        retryable: true,
        details: { url },
        cause: causeOf(error),
      }),
    );
    if (!response.ok) return response;
    const parsed = await wrap(
      async () => response.value.json(),
      (error) => ({
        category: "UPSTREAM" as const,
        code: "ONE_CLICK_UNPARSEABLE",
        message: `the 1Click API answered ${what} with something that is not JSON`,
        retryable: true,
        details: { url, status: response.value.status },
        cause: causeOf(error),
      }),
    );
    if (!parsed.ok) return parsed;
    const status = response.value.status;
    if (status < 200 || status >= 300) {
      const message = (parsed.value as { message?: unknown } | null)?.message;
      const text = typeof message === "string" ? message : `status ${status}`;
      const minimum = minimumFrom(text);
      return upstreamError("ONE_CLICK_REFUSED", `the 1Click API refused ${what}: ${text}`, {
        retryable: status === 429 || status >= 500,
        details: {
          status,
          apiMessage: text,
          ...(minimum === undefined ? {} : { minimumAmount: minimum.toString(10) }),
        },
      });
    }
    return ok(parsed.value as T);
  };

  const checkStatus = (value: OneClickStatusResponse, what: string): Result<OneClickStatusResponse> =>
    typeof value?.status === "string"
      ? ok(value)
      : upstreamError("ONE_CLICK_UNPARSEABLE", `the 1Click API answered ${what} without a status`);

  return {
    async quote(request) {
      const answered = await call<OneClickQuoteResponse>("POST", "/v0/quote", "the quote", request);
      if (!answered.ok) return answered;
      const quote = answered.value?.quote;
      for (const field of ["amountIn", "minAmountIn", "amountOut", "minAmountOut"] as const) {
        if (typeof quote?.[field] !== "string" || !/^\d+$/.test(quote[field])) {
          return upstreamError("ONE_CLICK_UNPARSEABLE", `the 1Click quote carries no integer \`${field}\``);
        }
      }
      return answered;
    },
    async submitDeposit(deposit) {
      const answered = await call<OneClickStatusResponse>("POST", "/v0/deposit/submit", "the deposit notice", deposit);
      return answered.ok ? checkStatus(answered.value, "the deposit notice") : answered;
    },
    async status(depositAddress) {
      const answered = await call<OneClickStatusResponse>(
        "GET",
        `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
        "the status read",
      );
      return answered.ok ? checkStatus(answered.value, "the status read") : answered;
    },
  };
}

// ---------------------------------------------------------------- the strategy

/** What the funding signer's provider may offer beyond a call: its chain id, checked before a transfer. */
export interface IntentsFundingProvider extends EthersV6CallProvider {
  getNetwork?(): Promise<{ readonly chainId: bigint }>;
}

/**
 * The Agent's signer on the funding chain. An `ethers.Signer` connected to that
 * chain's RPC satisfies it; the same private key is the same address on every
 * EVM chain.
 */
export interface IntentsFundingSigner extends Omit<EthersV6Signer, "provider"> {
  readonly provider?: IntentsFundingProvider | null;
}

type Assert<T extends true> = T;
type FundingSignerIsAccepted = Assert<Signer extends IntentsFundingSigner ? true : false>;
export type IntentsFundingSignerAcceptsEthersSigner = FundingSignerIsAccepted;

export interface IntentsFundingConfig {
  readonly funding: IntentsFundingAsset;
  readonly fundingSigner: IntentsFundingSigner;
  /** The API seam. Defaults to {@link createOneClickClient} over the fields below. */
  readonly client?: OneClickClient;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly jwt?: string;
  readonly fetchImpl?: OneClickFetch;
  /**
   * Reads the Agent's Monad balance of an Asset. Defaults to `balanceOf`
   * through the Monad signer's provider when `signer` is given.
   */
  readonly balanceOf?: (asset: AssetRef, owner: Address) => Promise<Result<bigint>>;
  /** The most of the funding token one funding step may spend, in its base units. Omitted sets no ceiling. */
  readonly maxFundingAmount?: bigint;
  /** Slippage tolerance on the input, in basis points. Defaults to 100, one percent. */
  readonly slippageBps?: number;
  /** Monad Asset to 1Click asset id. Defaults to {@link ONE_CLICK_MONAD_ASSETS}. */
  readonly destinationAssets?: Readonly<Record<string, string>>;
  /** How long an unfilled deposit waits before the API refunds it. Defaults to 30 minutes. */
  readonly deadlineMs?: number;
  /** How often the status is read. Defaults to 5 seconds. */
  readonly pollIntervalMs?: number;
  /** How long the strategy waits for the delivery before giving up. Defaults to 10 minutes. */
  readonly timeoutMs?: number;
  /** Tell the API the deposit hash to speed it up. Defaults to true; a failed notice is only logged. */
  readonly submitDeposit?: boolean;
  /** Called with every funding step that preceded a Settlement. */
  readonly onFunded?: (event: IntentsFundingEvent) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** One funding step, as reported once the Monad balance covers the Settlement. */
export interface IntentsFundingEvent {
  readonly agent: Address;
  readonly asset: AssetRef;
  readonly balanceBefore: bigint;
  readonly shortfall: bigint;
  /** What was asked of the API; at least the shortfall. */
  readonly amountOut: bigint;
  readonly amountIn: bigint;
  readonly depositAddress: string;
  readonly depositTxHash: Hex;
  readonly correlationId: string;
  readonly status: OneClickStatusResponse;
}

export interface IntentsFundedStrategyConfig {
  /** The strategy that settles on Monad once the balance is there. The Monad strategy, ordinarily. */
  readonly inner: PaymentStrategy;
  readonly intents: IntentsFundingConfig;
  /**
   * The Agent's Monad signer, for the default `balanceOf`. Not needed when
   * `intents.balanceOf` is supplied.
   */
  readonly signer?: EthersV6Signer;
  /** Defaults to {@link INTENTS_FUNDED_STRATEGY_ID}. */
  readonly id?: string;
  readonly logger?: Logger;
}

const erc20 = new Interface(ERC20_ABI);

/** The plan for one shortfall: the quote that would fund it, or nothing when none is needed. */
interface FundingPlan {
  readonly agent: Address;
  readonly balanceBefore: bigint;
  readonly shortfall: bigint;
  readonly refundTo: Address;
  readonly quote?: OneClickQuoteResponse;
}

/**
 * Builds the funded strategy. Construction is total.
 *
 * `chainIds` and the Settlement are the inner strategy's. `supports` is the
 * inner strategy's narrowed to the Assets 1Click delivers on Monad, so an Asset
 * it cannot fund, such as Testnet mUSDC, resolves to another strategy.
 */
export function createIntentsFundedStrategy(config: IntentsFundedStrategyConfig): PaymentStrategy {
  const logger = config.logger ?? defaultLogger;
  const id = config.id ?? INTENTS_FUNDED_STRATEGY_ID;
  const { inner, intents } = config;
  const { funding, fundingSigner } = intents;
  const destinations = intents.destinationAssets ?? ONE_CLICK_MONAD_ASSETS;
  const slippageBps = intents.slippageBps ?? 100;
  const deadlineMs = intents.deadlineMs ?? 30 * 60_000;
  const pollIntervalMs = intents.pollIntervalMs ?? 5_000;
  const timeoutMs = intents.timeoutMs ?? 10 * 60_000;
  const now = intents.now ?? (() => Date.now());
  const sleep = intents.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const client =
    intents.client ??
    createOneClickClient({
      ...(intents.baseUrl === undefined ? {} : { baseUrl: intents.baseUrl }),
      ...(intents.apiKey === undefined ? {} : { apiKey: intents.apiKey }),
      ...(intents.jwt === undefined ? {} : { jwt: intents.jwt }),
      ...(intents.fetchImpl === undefined ? {} : { fetchImpl: intents.fetchImpl }),
    });

  const destinationOf = (asset: AssetRef): string | undefined => destinations[assetKey(asset)];
  const fundable = (asset: AssetRef): boolean => destinationOf(asset) !== undefined && inner.supports(asset);

  const readBalance = async (provider: EthersV6CallProvider, token: string, owner: string, code: string, where: string): Promise<Result<bigint>> =>
    wrap(
      async () => {
        const raw = await provider.call({ to: token, data: erc20.encodeFunctionData("balanceOf", [owner]) });
        return erc20.decodeFunctionResult("balanceOf", raw)[0] as bigint;
      },
      (error) => ({
        category: "UPSTREAM" as const,
        code,
        message: `strategy \`${id}\` could not read the balance of ${owner} on ${where}`,
        retryable: true,
        cause: causeOf(error),
      }),
    );

  const balanceOf: (asset: AssetRef, owner: Address) => Promise<Result<bigint>> =
    intents.balanceOf ??
    (async (asset, owner) => {
      const provider = config.signer?.provider;
      if (provider === undefined || provider === null) {
        return upstreamError(
          "INTENTS_BALANCE_UNREADABLE",
          `strategy \`${id}\` needs a connected Monad signer, or a balanceOf function, to read the Agent's balance before settling`,
        );
      }
      return readBalance(provider, asset.address, owner, "INTENTS_BALANCE_UNREADABLE", assetKey(asset));
    });

  const unsupported = (asset: AssetRef): Result<never> =>
    validationError(
      "INTENTS_ASSET_UNSUPPORTED",
      `strategy \`${id}\` cannot bring ${asset.symbol} (${assetKey(asset)}) to Monad: NEAR Intents delivers ${Object.keys(destinations).join(", ") || "no Asset"} and the inner strategy must settle it`,
      { details: { asset: assetKey(asset), deliverable: Object.keys(destinations).join(", ") } },
    );

  /** One quote, raised once to the API's minimum delivery when the shortfall is below it. */
  const requestQuote = async (
    destinationAsset: string,
    amountOut: bigint,
    recipient: Address,
    refundTo: Address,
    dry: boolean,
  ): Promise<Result<OneClickQuoteResponse>> => {
    const ask = (amount: bigint) =>
      wrap(
        async () =>
          client.quote({
            dry,
            swapType: "EXACT_OUTPUT",
            slippageTolerance: slippageBps,
            originAsset: funding.assetId,
            depositType: "ORIGIN_CHAIN",
            destinationAsset,
            amount: amount.toString(10),
            refundTo,
            refundType: "ORIGIN_CHAIN",
            recipient,
            recipientType: "DESTINATION_CHAIN",
            deadline: new Date(now() + deadlineMs).toISOString(),
          }),
        (error) => ({
          category: "UPSTREAM" as const,
          code: "ONE_CLICK_CLIENT_THREW",
          message: `strategy \`${id}\`: the 1Click client threw while quoting`,
          retryable: false,
          cause: causeOf(error),
        }),
      );
    const first = await ask(amountOut);
    if (!first.ok) return first;
    if (first.value.ok) return first.value;
    const minimum = first.value.error.details?.["minimumAmount"];
    if (typeof minimum === "string" && /^\d+$/.test(minimum) && BigInt(minimum) > amountOut) {
      logger.info("the shortfall is below the smallest delivery NEAR Intents accepts; asking for the minimum instead", {
        strategyId: id,
        shortfall: amountOut.toString(10),
        minimum,
      });
      const raised = await ask(BigInt(minimum));
      if (!raised.ok) return raised;
      return raised.value;
    }
    return first.value;
  };

  /** Reads the balance and, when short, quotes the shortfall. Moves nothing. */
  const plan = async (request: SettleRequest, dry: boolean): Promise<Result<FundingPlan>> => {
    const destinationAsset = destinationOf(request.asset);
    if (destinationAsset === undefined || !inner.supports(request.asset)) return unsupported(request.asset);
    const agent = getAddress(request.agent) as Address;
    const before = await balanceOf(request.asset, agent);
    if (!before.ok) return before;
    const refundTo = await wrap(
      async () => getAddress(await fundingSigner.getAddress()) as Address,
      (error) => ({
        category: "UPSTREAM" as const,
        code: "SIGNER_ADDRESS_UNAVAILABLE",
        message: `strategy \`${id}\` could not read the Agent's address from its funding-chain signer`,
        retryable: true,
        cause: causeOf(error),
      }),
    );
    if (!refundTo.ok) return refundTo;
    if (before.value >= request.amount) {
      return ok({ agent, balanceBefore: before.value, shortfall: 0n, refundTo: refundTo.value });
    }

    const shortfall = request.amount - before.value;
    const quoted = await requestQuote(destinationAsset, shortfall, agent, refundTo.value, dry);
    if (!quoted.ok) return quoted;
    const quote = quoted.value.quote;
    const amountIn = BigInt(quote.amountIn);
    const amountOut = BigInt(quote.amountOut);
    const facts = {
      shortfall: shortfall.toString(10),
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      correlationId: quoted.value.correlationId,
    };
    if (amountOut < shortfall) {
      return chainError(
        "INTENTS_QUOTE_SHORT",
        `strategy \`${id}\`: NEAR Intents quotes ${quote.amountOut} base units of ${request.asset.symbol} on Monad for a shortfall of ${shortfall.toString(10)}`,
        { details: facts },
      );
    }
    if (intents.maxFundingAmount !== undefined && amountIn > intents.maxFundingAmount) {
      return chainError(
        "INTENTS_FUNDING_CEILING",
        `strategy \`${id}\`: bringing ${shortfall.toString(10)} base units of ${request.asset.symbol} to Monad needs ${quote.amountIn} of ${funding.symbol} on chain ${funding.chainId.toString(10)}, above the ceiling of ${intents.maxFundingAmount.toString(10)}`,
        { details: { ...facts, ceiling: intents.maxFundingAmount.toString(10) } },
      );
    }
    return ok({ agent, balanceBefore: before.value, shortfall, refundTo: refundTo.value, quote: quoted.value });
  };

  /** Waits for a transaction where the signer can, and shrugs where it cannot. */
  const landed = async (response: EthersV6TransactionResponse): Promise<{ status: number | null } | null> => {
    if (typeof response.wait !== "function") return null;
    try {
      return await response.wait();
    } catch (error) {
      logger.warn("could not wait for the funding-chain deposit", { txHash: response.hash, error: causeOf(error).message });
      return null;
    }
  };

  /** The deposit on the funding chain: checks the chain and the balance, then transfers. */
  const deposit = async (depositAddress: Address, amountIn: bigint): Promise<Result<Hex>> => {
    const provider = fundingSigner.provider;
    if (provider !== undefined && provider !== null) {
      if (typeof provider.getNetwork === "function") {
        const network = await wrap(
          async () => (await provider.getNetwork?.())?.chainId,
          (error) => ({
            category: "UPSTREAM" as const,
            code: "INTENTS_FUNDING_CHAIN_UNREADABLE",
            message: `strategy \`${id}\` could not read the funding signer's chain id`,
            retryable: true,
            cause: causeOf(error),
          }),
        );
        if (!network.ok) return network;
        if (network.value !== undefined && BigInt(network.value) !== funding.chainId) {
          return validationError(
            "INTENTS_FUNDING_CHAIN_MISMATCH",
            `strategy \`${id}\`: the funding signer is on chain ${String(network.value)} and ${funding.symbol} is configured on chain ${funding.chainId.toString(10)}; nothing was sent`,
            { details: { signerChainId: String(network.value), fundingChainId: funding.chainId.toString(10) } },
          );
        }
      }
      const owner = await fundingSigner.getAddress();
      const held = await readBalance(provider, funding.token, owner, "INTENTS_FUNDING_BALANCE_UNREADABLE", `${funding.symbol} on chain ${funding.chainId.toString(10)}`);
      if (!held.ok) return held;
      if (held.value < amountIn) {
        return chainError(
          "INTENTS_FUNDING_BALANCE_SHORT",
          `strategy \`${id}\`: the Agent holds ${held.value.toString(10)} base units of ${funding.symbol} on chain ${funding.chainId.toString(10)} and the funding step needs ${amountIn.toString(10)}; nothing was sent`,
          { details: { balance: held.value.toString(10), required: amountIn.toString(10), owner } },
        );
      }
    }

    const sent = await wrap(
      async () => fundingSigner.sendTransaction({ to: funding.token, data: erc20.encodeFunctionData("transfer", [depositAddress, amountIn]) }),
      (error) => ({
        category: "CHAIN" as const,
        code: "INTENTS_DEPOSIT_FAILED",
        message: `strategy \`${id}\` could not send the ${funding.symbol} deposit to ${depositAddress} on chain ${funding.chainId.toString(10)}`,
        retryable: false,
        details: { depositAddress },
        cause: causeOf(error),
      }),
    );
    if (!sent.ok) return sent;
    const hash = sent.value.hash;
    if (typeof hash !== "string" || !hash.startsWith("0x")) {
      return chainError("INTENTS_DEPOSIT_FAILED", `strategy \`${id}\` sent the deposit but the funding signer returned no transaction hash`, {
        details: { depositAddress },
      });
    }
    const receipt = await landed(sent.value);
    if (receipt !== null && receipt.status === 0) {
      return chainError("INTENTS_DEPOSIT_REVERTED", `the ${funding.symbol} deposit ${hash} to ${depositAddress} reverted on chain ${funding.chainId.toString(10)}`, {
        details: { depositAddress, depositTxHash: hash },
      });
    }
    return ok(hash as Hex);
  };

  /** Polls the status until the delivery lands, is refunded, fails, or the wait runs out. */
  const awaitDelivery = async (depositAddress: string, depositTxHash: Hex, until: number): Promise<Result<OneClickStatusResponse>> => {
    let last: OneClickStatusResponse | undefined;
    let lastError: string | undefined;
    for (;;) {
      const read = await wrap(
        async () => client.status(depositAddress),
        (error) => ({
          category: "UPSTREAM" as const,
          code: "ONE_CLICK_CLIENT_THREW",
          message: "the 1Click client threw while reading the status",
          retryable: true,
          cause: causeOf(error),
        }),
      );
      const outcome = read.ok ? read.value : read;
      if (outcome.ok) {
        last = outcome.value;
        lastError = undefined;
        if (last.status === "SUCCESS") return ok(last);
        if (TERMINAL_FAILURES.has(last.status)) {
          const refunded = last.status === "REFUNDED";
          return upstreamError(
            refunded ? "INTENTS_FUNDING_REFUNDED" : "INTENTS_FUNDING_FAILED",
            refunded
              ? `the funding step through deposit address ${depositAddress} was refunded to the Agent on chain ${funding.chainId.toString(10)}${last.swapDetails?.refundReason === undefined ? "" : ` (${last.swapDetails.refundReason})`}; nothing was settled`
              : `the funding step through deposit address ${depositAddress} failed; check its status with the 1Click API before retrying; nothing was settled`,
            {
              details: {
                depositAddress,
                depositTxHash,
                status: last.status,
                ...(last.swapDetails?.refundedAmount === undefined ? {} : { refundedAmount: last.swapDetails.refundedAmount }),
                ...(last.swapDetails?.refundReason === undefined ? {} : { refundReason: last.swapDetails.refundReason }),
              },
            },
          );
        }
      } else {
        // A status read that fails is not the funding step failing: keep asking until the wait runs out.
        lastError = outcome.error.message;
        logger.warn("could not read the funding status; will ask again", { depositAddress, error: lastError });
      }
      if (now() >= until) {
        return upstreamError(
          "INTENTS_FUNDING_TIMEOUT",
          `the funding step through deposit address ${depositAddress} did not complete in ${timeoutMs} ms (last status ${last?.status ?? "unknown"}); the deposit ${depositTxHash} is sent, so check its status with the 1Click API before retrying; nothing was settled`,
          {
            details: {
              depositAddress,
              depositTxHash,
              status: last?.status ?? "unknown",
              ...(lastError === undefined ? {} : { lastError }),
            },
          },
        );
      }
      await sleep(pollIntervalMs);
    }
  };

  /** Brings the shortfall to Monad, if there is one. Resolves once the Monad balance covers `request.amount`. */
  const fund = async (request: SettleRequest): Promise<Result<void>> => {
    const planned = await plan(request, false);
    if (!planned.ok) return planned;
    const { agent, balanceBefore, shortfall, quote } = planned.value;
    if (quote === undefined) return ok(undefined);

    const depositAddress = quote.quote.depositAddress;
    if (depositAddress === undefined || !isEthersAddress(depositAddress)) {
      return upstreamError("INTENTS_DEPOSIT_ADDRESS_INVALID", `strategy \`${id}\`: the 1Click quote carries no EVM deposit address for chain ${funding.chainId.toString(10)}; nothing was sent`, {
        details: { correlationId: quote.correlationId, depositAddress: String(depositAddress) },
      });
    }
    if (quote.quote.depositMemo !== undefined && quote.quote.depositMemo.length > 0) {
      return upstreamError("INTENTS_DEPOSIT_MEMO_REQUIRED", `strategy \`${id}\`: the 1Click quote requires a deposit memo, which an ERC-20 transfer cannot carry; nothing was sent`, {
        details: { correlationId: quote.correlationId, depositAddress },
      });
    }
    const amountIn = BigInt(quote.quote.amountIn);
    const amountOut = BigInt(quote.quote.amountOut);

    logger.info("bringing the shortfall to Monad through NEAR Intents before settling", {
      strategyId: id,
      asset: assetKey(request.asset),
      shortfall: shortfall.toString(10),
      funding: `${funding.symbol} on chain ${funding.chainId.toString(10)}`,
      amountIn: amountIn.toString(10),
      depositAddress,
      correlationId: quote.correlationId,
    });
    const until = now() + timeoutMs;
    const sent = await deposit(getAddress(depositAddress) as Address, amountIn);
    if (!sent.ok) {
      return { ok: false, error: { ...sent.error, details: { ...sent.error.details, depositAddress, correlationId: quote.correlationId } } };
    }
    const depositTxHash = sent.value;

    if (intents.submitDeposit !== false) {
      const noticed = await wrap(
        async () => client.submitDeposit({ txHash: depositTxHash, depositAddress }),
        (error) => ({
          category: "UPSTREAM" as const,
          code: "ONE_CLICK_CLIENT_THREW",
          message: "the 1Click client threw while submitting the deposit",
          retryable: true,
          cause: causeOf(error),
        }),
      );
      const outcome = noticed.ok ? noticed.value : noticed;
      if (!outcome.ok) logger.warn("the deposit notice was not accepted; the API will still see the deposit", { depositAddress, error: outcome.error.message });
    }

    const delivered = await awaitDelivery(depositAddress, depositTxHash, until);
    if (!delivered.ok) return delivered;

    // The API says delivered; the Monad balance is what the Settlement spends, so wait for it too.
    for (;;) {
      const after = await balanceOf(request.asset, agent);
      if (after.ok && after.value >= request.amount) break;
      if (now() >= until) {
        return chainError(
          "INTENTS_FUNDING_SHORT",
          `strategy \`${id}\`: NEAR Intents reports the delivery through ${depositAddress} complete, but the Agent's Monad balance of ${request.asset.symbol} is ${after.ok ? after.value.toString(10) : "unreadable"}, short of ${request.amount.toString(10)}; nothing was settled`,
          {
            details: {
              depositAddress,
              depositTxHash,
              status: delivered.value.status,
              required: request.amount.toString(10),
              ...(after.ok ? { balance: after.value.toString(10) } : { balanceError: after.error.message }),
            },
          },
        );
      }
      await sleep(pollIntervalMs);
    }

    if (intents.onFunded !== undefined) {
      try {
        intents.onFunded({
          agent,
          asset: request.asset,
          balanceBefore,
          shortfall,
          amountOut,
          amountIn,
          depositAddress,
          depositTxHash,
          correlationId: quote.correlationId,
          status: delivered.value,
        });
      } catch (error) {
        logger.warn("onFunded threw and was ignored", causeOf(error));
      }
    }
    return ok(undefined);
  };

  const innerBatch = inner.settleBatch;

  return {
    id,
    chainIds: inner.chainIds,
    supports: fundable,
    async quote(request: ChargeRequest): Promise<Result<ChargeQuote>> {
      const valid = validateSettleRequest(request);
      if (!valid.ok) return valid;
      if (!fundable(request.asset)) return unsupported(request.asset);
      const quoted = await inner.quote(request);
      if (!quoted.ok) return quoted;
      const planned = await plan(request, true);
      if (!planned.ok) return planned;
      const { balanceBefore, shortfall, quote } = planned.value;
      if (quote === undefined) {
        return ok({
          ...quoted.value,
          feeNote: `${quoted.value.feeNote}; the Agent already holds ${balanceBefore.toString(10)} base units of ${request.asset.symbol} on Monad, so nothing is brought in first`,
        });
      }
      return ok({
        ...quoted.value,
        feeNote:
          `${quoted.value.feeNote}; the Agent is short ${shortfall.toString(10)} base units of ${request.asset.symbol} on Monad, ` +
          `so about ${quote.quote.amountIn} base units of ${funding.symbol} on chain ${funding.chainId.toString(10)} are brought to Monad through NEAR Intents first ` +
          `(about ${quote.quote.timeEstimate} s), and the Settlement is then one Monad transaction as usual`,
      });
    },
    async settle(request: SettleRequest): Promise<Result<SettlementReceipt>> {
      const valid = validateSettleRequest(request);
      if (!valid.ok) return valid;
      if (!fundable(request.asset)) return unsupported(request.asset);
      const funded = await fund(request);
      if (!funded.ok) return funded;
      return inner.settle(request);
    },
    ...(innerBatch === undefined
      ? {}
      : {
          async settleBatch(requests: readonly SettleRequest[]): Promise<Result<readonly SettlementReceipt[]>> {
            // One funding step per Agent and Asset, for the batch's total, so
            // every Settlement in the one transaction is covered.
            const totals = new Map<string, SettleRequest>();
            for (const request of requests) {
              const valid = validateSettleRequest(request);
              if (!valid.ok) return valid;
              if (!fundable(request.asset)) return unsupported(request.asset);
              const key = `${request.agent.toLowerCase()}|${assetKey(request.asset)}`;
              const seen = totals.get(key);
              totals.set(key, seen === undefined ? request : { ...seen, amount: seen.amount + request.amount });
            }
            for (const total of totals.values()) {
              const funded = await fund(total);
              if (!funded.ok) return funded;
            }
            return innerBatch.call(inner, requests);
          },
        }),
  };
}
