/**
 * Settle in any asset through Kuru: a strategy that tops the Agent's balance of
 * the Asset up from another token before delegating the Settlement.
 *
 * ## What it does
 *
 * `TabSettlement.settle` moves the Asset the tab is denominated in, and an
 * Agent that holds MON, or a different stablecoin, cannot settle until it holds
 * enough of that Asset. {@link createKuruFundedStrategy} wraps the Monad
 * strategy: before every `settle` it reads the Agent's balance of the Asset,
 * and when it is short, swaps the shortfall in from a configured source token
 * through Kuru, Monad's on-chain order book, and only then settles. The
 * Settlement itself is still the inner strategy's transaction, so the receipt,
 * the `Settled` event and the atomic apply are unchanged.
 *
 * ## The swap is a seam
 *
 * The swap runs through a {@link KuruRouter}: `quote` says how much of the
 * source token buys the shortfall, `swap` executes it. {@link createKuruOnchainRouter}
 * is the shipped implementation over Kuru's `Router.anyToAnySwap`, which is
 * the same entry point on Testnet and Mainnet, driven with a configured route
 * of market addresses. A test hands in a fake router and exercises the whole
 * decision without a chain.
 *
 * ## Why not Kuru's own SDK or its aggregator API
 *
 * `@kuru-labs/kuru-sdk` pins ethers 5 and takes swap amounts as floating
 * point numbers, and the Kuru Flow aggregator API (`ws.kuru.io/api/quote`)
 * needs a bearer token and returns a transaction in a shape the docs do not
 * define. Amounts here are `bigint` base units end to end, so the router talks
 * to the contract directly, with the amounts it was given.
 *
 * ## Amounts
 *
 * `amountOut` is the exact shortfall and is passed as the swap's minimum, so
 * the Settlement is either fully funded or the swap reverts. `amountIn` is a
 * ceiling: the on-chain router quotes by simulation at that ceiling, and the
 * Agent's slippage tolerance sets how much above the quoted price it will pay.
 * Anything the swap returns above the shortfall stays in the Agent's balance.
 */

import { Interface, getAddress } from "ethers";
import { causeOf, isAddress, ok, wrap, type Address, type Hex, type Result } from "@tabai/shared";

import { chainError, upstreamError, validationError } from "../errors.js";
import { defaultLogger, type Logger } from "../logger.js";
import { ERC20_ABI } from "./abi.js";
import { batchSettledBy, extendFeeNote, settledBy } from "./wrapping.js";
import type { EthersV6Signer, EthersV6TransactionResponse } from "./monad.js";
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

/** The address Kuru's router reads as the native token, MON. */
export const KURU_NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

/** Kuru's deployments, from its Contract Addresses page. The Router is what `anyToAnySwap` lives on. */
export const KURU_DEPLOYMENTS = {
  mainnet: {
    chainId: 143n,
    router: "0xd651346d7c789536ebf06dc72aE3C8502cd695CC" as Address,
    marginAccount: "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5" as Address,
    /** The aggregator entry point. Mainnet only: the docs list none for Testnet. */
    flowEntrypoint: "0xb3e6778480b2E488385E8205eA05E20060B813cb" as Address,
    wmon: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Address,
    markets: {
      "MON-USDC": "0x065C9d28E428A0db40191a54d33d5b7c71a9C394" as Address,
      "MON-AUSD": "0x131a2e70a5b31a517a74b8c567149bc294470da9" as Address,
    },
  },
  testnet: {
    chainId: 10143n,
    router: "0x7EFbE105Ca7415dE98F96622173458ac1c054630" as Address,
    marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" as Address,
    /** Kuru's own test USDC on Testnet, which is not Tab's `MockUsdc`. */
    usdc: "0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570" as Address,
  },
} as const;

/** The source token a swap draws from. `address` is {@link KURU_NATIVE_TOKEN} for MON. */
export interface KuruSourceToken {
  readonly address: Address;
  readonly decimals: number;
  readonly symbol: string;
}

/** What the router is asked for. */
export interface KuruSwapRequest {
  readonly chainId: bigint;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** The exact shortfall in `tokenOut` base units. The swap must return at least this. */
  readonly amountOut: bigint;
  /** The most `tokenIn` the caller will spend. */
  readonly maxAmountIn: bigint;
  /** Where the output lands. The Agent, always. */
  readonly recipient: Address;
}

export interface KuruQuote {
  readonly request: KuruSwapRequest;
  /** How much `tokenIn` the swap will be sent with. At most `request.maxAmountIn`. */
  readonly amountIn: bigint;
  /** What the router expects back. At least `request.amountOut`. */
  readonly expectedOut: bigint;
}

export interface KuruSwapReceipt {
  readonly txHash: Hex;
  readonly amountIn: bigint;
  /** What the swap returned, when the router could read it; the quote's expectation otherwise. */
  readonly amountOut: bigint;
}

/** The swap seam. Both methods return a `Result`, never throw. */
export interface KuruRouter {
  quote(request: KuruSwapRequest): Promise<Result<KuruQuote>>;
  swap(quote: KuruQuote): Promise<Result<KuruSwapReceipt>>;
}

export interface KuruConfig {
  readonly router: KuruRouter;
  readonly source: KuruSourceToken;
  /**
   * Reads the Agent's balance of an Asset. Defaults to `balanceOf` through the
   * inner signer's provider when `signer` is given; required otherwise.
   */
  readonly balanceOf?: (asset: AssetRef, owner: Address) => Promise<Result<bigint>>;
  /** The most of the source token one Settlement may spend. Omitted sets no ceiling. */
  readonly maxSourceAmount?: bigint;
  /** Called with every swap that funded a Settlement. */
  readonly onFunded?: (event: KuruFundingEvent) => void;
}

/** One top-up, as reported after the Settlement it funded. */
export interface KuruFundingEvent {
  readonly agent: Address;
  readonly asset: AssetRef;
  readonly balanceBefore: bigint;
  readonly shortfall: bigint;
  readonly quote: KuruQuote;
  readonly swap: KuruSwapReceipt;
}

export interface KuruFundedStrategyConfig {
  /** The strategy that settles once the balance is there. The Monad strategy, ordinarily. */
  readonly inner: PaymentStrategy;
  readonly kuru: KuruConfig;
  /**
   * The Agent's signer, for the default `balanceOf`. Its `provider` is what the
   * balance is read through. Not needed when `kuru.balanceOf` is supplied.
   */
  readonly signer?: EthersV6Signer;
  readonly id?: string;
  readonly logger?: Logger;
}

const erc20 = new Interface(ERC20_ABI);

/**
 * Builds the funded strategy. Construction is total.
 *
 * `supports`, `chainIds` and `quote` are the inner strategy's, so registering
 * this in place of it changes nothing about which Assets resolve to it.
 */
export function createKuruFundedStrategy(config: KuruFundedStrategyConfig): PaymentStrategy {
  const logger = config.logger ?? defaultLogger;
  const id = config.id ?? `${config.inner.id}+kuru`;
  const { inner, kuru } = config;

  const balanceOf: (asset: AssetRef, owner: Address) => Promise<Result<bigint>> =
    kuru.balanceOf ??
    (async (asset, owner) => {
      const provider = config.signer?.provider;
      if (provider === undefined || provider === null) {
        return upstreamError(
          "KURU_BALANCE_UNREADABLE",
          `strategy \`${id}\` needs a connected signer, or a balanceOf function, to read the Agent's balance before settling`,
        );
      }
      return wrap(
        async () => {
          const raw = await provider.call({ to: asset.address, data: erc20.encodeFunctionData("balanceOf", [owner]) });
          return erc20.decodeFunctionResult("balanceOf", raw)[0] as bigint;
        },
        (error) => ({
          category: "UPSTREAM" as const,
          code: "KURU_BALANCE_UNREADABLE",
          message: `strategy \`${id}\` could not read the balance of ${owner} on ${assetKey(asset)}`,
          retryable: true,
          cause: causeOf(error),
        }),
      );
    });

  const fund = async (request: SettleRequest): Promise<Result<void>> => {
    const agent = getAddress(request.agent) as Address;
    const before = await balanceOf(request.asset, agent);
    if (!before.ok) return before;
    if (before.value >= request.amount) return ok(undefined);

    const shortfall = request.amount - before.value;
    if (kuru.source.address.toLowerCase() === request.asset.address.toLowerCase()) {
      return chainError(
        "KURU_SOURCE_IS_ASSET",
        `strategy \`${id}\` cannot fund ${assetKey(request.asset)} from itself; the Agent holds ${before.value.toString(10)} and needs ${request.amount.toString(10)}`,
        { details: { asset: assetKey(request.asset), balance: before.value.toString(10), required: request.amount.toString(10) } },
      );
    }
    const swapRequest: KuruSwapRequest = {
      chainId: request.asset.chainId,
      tokenIn: kuru.source.address,
      tokenOut: request.asset.address,
      amountOut: shortfall,
      maxAmountIn: kuru.maxSourceAmount ?? (1n << 128n) - 1n,
      recipient: agent,
    };

    const quoted = await wrap(
      async () => kuru.router.quote(swapRequest),
      (error) => ({
        category: "UPSTREAM" as const,
        code: "KURU_ROUTER_THREW",
        message: `strategy \`${id}\`: the Kuru router threw while quoting`,
        retryable: false,
        cause: causeOf(error),
      }),
    );
    if (!quoted.ok) return quoted;
    if (!quoted.value.ok) return quoted.value;
    const quote = quoted.value.value;
    if (quote.amountIn > swapRequest.maxAmountIn) {
      return chainError(
        "KURU_SOURCE_CEILING",
        `strategy \`${id}\`: funding ${shortfall.toString(10)} base units of ${request.asset.symbol} needs ${quote.amountIn.toString(10)} of ${kuru.source.symbol}, above the ceiling of ${swapRequest.maxAmountIn.toString(10)}`,
        { details: { shortfall: shortfall.toString(10), amountIn: quote.amountIn.toString(10), ceiling: swapRequest.maxAmountIn.toString(10) } },
      );
    }
    if (quote.expectedOut < shortfall) {
      return chainError(
        "KURU_QUOTE_SHORT",
        `strategy \`${id}\`: the Kuru route returns ${quote.expectedOut.toString(10)} for the shortfall of ${shortfall.toString(10)}`,
        { details: { shortfall: shortfall.toString(10), expectedOut: quote.expectedOut.toString(10) } },
      );
    }

    logger.info("topping the Agent's balance up through Kuru before settling", {
      strategyId: id,
      asset: assetKey(request.asset),
      shortfall: shortfall.toString(10),
      source: kuru.source.symbol,
      amountIn: quote.amountIn.toString(10),
    });
    const swapped = await wrap(
      async () => kuru.router.swap(quote),
      (error) => ({
        category: "CHAIN" as const,
        code: "KURU_ROUTER_THREW",
        message: `strategy \`${id}\`: the Kuru router threw while swapping`,
        retryable: false,
        cause: causeOf(error),
      }),
    );
    if (!swapped.ok) return swapped;
    if (!swapped.value.ok) return swapped.value;

    const after = await balanceOf(request.asset, agent);
    if (!after.ok) return after;
    if (after.value < request.amount) {
      return chainError(
        "KURU_SWAP_SHORT",
        `strategy \`${id}\`: after the swap the Agent holds ${after.value.toString(10)} base units of ${request.asset.symbol}, still short of ${request.amount.toString(10)}`,
        { details: { balance: after.value.toString(10), required: request.amount.toString(10), txHash: swapped.value.value.txHash } },
      );
    }
    if (kuru.onFunded !== undefined) {
      try {
        kuru.onFunded({ agent, asset: request.asset, balanceBefore: before.value, shortfall, quote, swap: swapped.value.value });
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
    supports: (asset: AssetRef) => inner.supports(asset),
    async quote(request: ChargeRequest): Promise<Result<ChargeQuote>> {
      const quoted = await inner.quote(request);
      if (!quoted.ok) return quoted;
      return ok({
        ...quoted.value,
        feeNote: extendFeeNote(quoted.value.feeNote, `a shortfall in ${request.asset.symbol} is swapped in from ${kuru.source.symbol} through Kuru first`),
      });
    },
    async settle(request: SettleRequest): Promise<Result<SettlementReceipt>> {
      const valid = validateSettleRequest(request);
      if (!valid.ok) return valid;
      if (!inner.supports(request.asset)) {
        return validationError("ASSET_NOT_CONFIGURED", `strategy \`${id}\` cannot settle ${assetKey(request.asset)}: the inner strategy does not support it`);
      }
      const funded = await fund(request);
      if (!funded.ok) return funded;
      return settledBy(id, await inner.settle(request));
    },
    ...(innerBatch === undefined
      ? {}
      : {
          async settleBatch(requests: readonly SettleRequest[]): Promise<Result<readonly SettlementReceipt[]>> {
            for (const request of requests) {
              const valid = validateSettleRequest(request);
              if (!valid.ok) return valid;
              const funded = await fund(request);
              if (!funded.ok) return funded;
            }
            return batchSettledBy(id, await innerBatch.call(inner, requests));
          },
        }),
  };
}

// ---------------------------------------------------------------- the on-chain router

/** Kuru's `Router.anyToAnySwap`, the multi-hop swap entry point. */
export const KURU_ROUTER_ABI = [
  "function anyToAnySwap(address[] _marketAddresses, bool[] _isBuy, bool[] _nativeSend, address _debitToken, address _creditToken, uint256 _amount, uint256 _minAmountOut) payable returns (uint256 _amountOut)",
] as const;

/**
 * One route through Kuru's markets, as `anyToAnySwap` takes it.
 *
 * Every array is per hop. `isBuy` says whether the hop buys the market's base
 * with its quote, `nativeSend` whether the hop is paid in MON. The MON-USDC
 * market on Mainnet, selling MON for USDC, is one hop: `{ markets: [MON_USDC],
 * isBuy: [false], nativeSend: [true] }`.
 */
export interface KuruRoute {
  readonly markets: readonly Address[];
  readonly isBuy: readonly boolean[];
  readonly nativeSend: readonly boolean[];
}

/** What the on-chain router needs of a signer: a call for the quote, a send for the swap. An `ethers.Signer` satisfies it. */
export type KuruSigner = EthersV6Signer;

export interface KuruOnchainRouterOptions {
  readonly signer: KuruSigner;
  /** Kuru's Router on the chain the signer is on. */
  readonly router: Address;
  /** Routes keyed by `${tokenIn}->${tokenOut}`, lower-cased. */
  readonly routes: Readonly<Record<string, KuruRoute>>;
  /** How far above the simulated price the swap may pay. Defaults to 100, one percent. */
  readonly slippageBps?: number;
  /**
   * The `tokenIn` amount the price is probed at. Defaults to `maxAmountIn`.
   * Probing at the size to be swapped keeps the quote honest about depth.
   */
  readonly probeAmountIn?: bigint;
  readonly logger?: Logger;
}

const routerInterface = new Interface(KURU_ROUTER_ABI);

/** The key `routes` is looked up by. */
export const kuruRouteKey = (tokenIn: string, tokenOut: string): string => `${tokenIn.toLowerCase()}->${tokenOut.toLowerCase()}`;

/**
 * A router over `anyToAnySwap`.
 *
 * Quoting is a simulation: the swap is `eth_call`ed at a probe size, the
 * price it implies is scaled to the shortfall, and the slippage margin is
 * added. Two probes at most, the second at the computed size, so the quote is
 * checked at the amount that will be sent. The swap is then sent with the
 * shortfall as `_minAmountOut`, which is what makes over-quoting harmless and
 * under-quoting a revert rather than a short Settlement.
 */
export function createKuruOnchainRouter(options: KuruOnchainRouterOptions): KuruRouter {
  const logger = options.logger ?? defaultLogger;
  const slippageBps = BigInt(options.slippageBps ?? 100);

  const routeFor = (request: KuruSwapRequest): Result<KuruRoute> => {
    const route = options.routes[kuruRouteKey(request.tokenIn, request.tokenOut)];
    if (route === undefined) {
      return validationError("KURU_ROUTE_UNKNOWN", `no Kuru route is configured from ${request.tokenIn} to ${request.tokenOut}`, {
        details: { tokenIn: request.tokenIn, tokenOut: request.tokenOut, configured: Object.keys(options.routes).join(", ") },
      });
    }
    if (route.markets.length === 0 || route.isBuy.length !== route.markets.length || route.nativeSend.length !== route.markets.length) {
      return validationError("KURU_ROUTE_INVALID", "a Kuru route needs one market, one isBuy and one nativeSend per hop");
    }
    for (const market of route.markets) {
      if (!isAddress(market)) return validationError("KURU_ROUTE_INVALID", `market \`${market}\` is not a 20-byte address`);
    }
    return ok(route);
  };

  const calldata = (route: KuruRoute, request: KuruSwapRequest, amountIn: bigint, minOut: bigint): string =>
    routerInterface.encodeFunctionData("anyToAnySwap", [
      [...route.markets],
      [...route.isBuy],
      [...route.nativeSend],
      request.tokenIn,
      request.tokenOut,
      amountIn,
      minOut,
    ]);

  const native = (route: KuruRoute): boolean => route.nativeSend[0] === true;

  const simulate = async (route: KuruRoute, request: KuruSwapRequest, amountIn: bigint): Promise<Result<bigint>> => {
    const provider = options.signer.provider;
    if (provider === undefined || provider === null) {
      return upstreamError("KURU_QUOTE_UNAVAILABLE", "the Kuru router needs a connected signer to simulate a swap");
    }
    return wrap(
      async () => {
        const raw = await provider.call({
          to: options.router,
          data: calldata(route, request, amountIn, 0n),
          ...(native(route) ? { value: amountIn, from: await options.signer.getAddress() } : { from: await options.signer.getAddress() }),
        } as { to: string; data: string });
        return routerInterface.decodeFunctionResult("anyToAnySwap", raw)[0] as bigint;
      },
      (error) => ({
        category: "UPSTREAM" as const,
        code: "KURU_QUOTE_FAILED",
        message: `the Kuru router at ${options.router} could not simulate the swap`,
        retryable: true,
        details: { amountIn: amountIn.toString(10) },
        cause: causeOf(error),
      }),
    );
  };

  const ceilDiv = (numerator: bigint, denominator: bigint): bigint => (numerator + denominator - 1n) / denominator;

  return {
    async quote(request) {
      const route = routeFor(request);
      if (!route.ok) return route;
      if (request.amountOut <= 0n) return validationError("KURU_AMOUNT_INVALID", "amountOut must be positive");
      const probe = options.probeAmountIn ?? request.maxAmountIn;
      if (probe <= 0n) return validationError("KURU_AMOUNT_INVALID", "the probe amount must be positive; set maxSourceAmount or probeAmountIn");

      const outAtProbe = await simulate(route.value, request, probe);
      if (!outAtProbe.ok) return outAtProbe;
      if (outAtProbe.value <= 0n) {
        return chainError("KURU_QUOTE_SHORT", `the Kuru route returns nothing for ${probe.toString(10)} of ${request.tokenIn}`, {
          details: { probe: probe.toString(10) },
        });
      }

      // Price implied at the probe, scaled to the shortfall, then the margin.
      let amountIn = ceilDiv(request.amountOut * probe, outAtProbe.value);
      amountIn = ceilDiv(amountIn * (10_000n + slippageBps), 10_000n);
      if (amountIn > request.maxAmountIn) amountIn = request.maxAmountIn;

      const expected = amountIn === probe ? outAtProbe : await simulate(route.value, request, amountIn);
      if (!expected.ok) return expected;
      if (expected.value < request.amountOut) {
        // Depth is worse at the size to be sent than the probe implied. One
        // more step up, bounded by the ceiling; past that it is not fundable.
        const stepped = amountIn >= request.maxAmountIn ? amountIn : ceilDiv(amountIn * request.amountOut, expected.value);
        const bounded = stepped > request.maxAmountIn ? request.maxAmountIn : stepped;
        const again = bounded === amountIn ? expected : await simulate(route.value, request, bounded);
        if (!again.ok) return again;
        if (again.value < request.amountOut) {
          return chainError("KURU_QUOTE_SHORT", `the Kuru route returns ${again.value.toString(10)} for ${bounded.toString(10)} of ${request.tokenIn}, short of ${request.amountOut.toString(10)}`, {
            details: { amountIn: bounded.toString(10), expectedOut: again.value.toString(10), amountOut: request.amountOut.toString(10) },
          });
        }
        return ok({ request, amountIn: bounded, expectedOut: again.value });
      }
      return ok({ request, amountIn, expectedOut: expected.value });
    },

    async swap(quote) {
      const route = routeFor(quote.request);
      if (!route.ok) return route;
      const { request } = quote;

      if (!native(route.value)) {
        const owner = await options.signer.getAddress();
        const approved = await wrap(
          async () => options.signer.sendTransaction({ to: request.tokenIn, data: erc20.encodeFunctionData("approve", [options.router, quote.amountIn]) }),
          (error) => ({
            category: "CHAIN" as const,
            code: "KURU_APPROVE_FAILED",
            message: `the allowance for Kuru's router on ${request.tokenIn} could not be set`,
            retryable: false,
            details: { owner },
            cause: causeOf(error),
          }),
        );
        if (!approved.ok) return approved;
        await settleTx(approved.value, logger);
      }

      const sent = await wrap(
        async () =>
          options.signer.sendTransaction({
            to: options.router,
            data: calldata(route.value, request, quote.amountIn, request.amountOut),
            ...(native(route.value) ? { value: quote.amountIn } : {}),
          }),
        (error) => ({
          category: "CHAIN" as const,
          code: "KURU_SWAP_FAILED",
          message: `the Kuru swap through ${options.router} could not be sent`,
          retryable: false,
          cause: causeOf(error),
        }),
      );
      if (!sent.ok) return sent;
      const receipt = await settleTx(sent.value, logger);
      if (receipt !== null && receipt.status === 0) {
        return chainError("KURU_SWAP_REVERTED", `the Kuru swap ${sent.value.hash} reverted`, { details: { txHash: sent.value.hash } });
      }
      return ok({ txHash: sent.value.hash as Hex, amountIn: quote.amountIn, amountOut: quote.expectedOut });
    },
  };
}

/** Waits for a transaction where the signer can, and shrugs where it cannot. */
async function settleTx(response: EthersV6TransactionResponse, logger: Logger): Promise<{ status: number | null } | null> {
  if (typeof response.wait !== "function") return null;
  try {
    return await response.wait();
  } catch (error) {
    logger.warn("could not wait for a Kuru transaction", { txHash: response.hash, error: causeOf(error).message });
    return null;
  }
}
