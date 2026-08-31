/**
 * The Ethereum USDC payment strategy, on `ethers` v6 (R23.1, R23.7).
 *
 * One factory, two Settlement surfaces, and they are separate code paths rather
 * than one path behind a flag — because they are separate transactions:
 *
 * | | `direct-transfer` | `settlement-contract` |
 * | --- | --- | --- |
 * | where | Ethereum Mainnet, chainKey 3 | Ethereum Sepolia, chainKey 1 |
 * | called | `USDC.transfer(collection, amount)` | `TabSettlement.settle(instruction)` |
 * | log | `Transfer`, emitted by USDC | `TabSettled`, emitted by `TabSettlement` |
 * | allowance | none — the payer moves their own balance | required — the contract pulls with `safeTransferFrom` |
 * | intent | inferred from the recipient being a registered Collection Address | explicit: Agent, Service, amount, tabId |
 *
 * On Mainnet Tab deploys nothing, so a plain USDC `Transfer` to a registered
 * Collection Address *is* the Settlement (R2.1). There is no contract to call, no
 * allowance to grant, and no tabId in the log. Collapsing the two into one
 * function with a boolean would mean a single body where half the parameters are
 * meaningless on each branch, and where forgetting the allowance step on the
 * Sepolia branch reverts a real transaction. They are kept apart.
 *
 * `TabSettlement` is live on Ethereum Sepolia at
 * `0x10619F16E1ac73AAe41AA4C1619f1387687EED79`; Sepolia USDC is
 * `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` and Mainnet USDC is
 * `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, both 6 decimals. None of those
 * addresses is hardcoded here: they are configuration, they live in
 * `deployments.json` and the registry, and this factory takes them as arguments so
 * the same code serves every registered Asset.
 *
 * ## What this module does not do
 *
 * It submits and it describes what it submitted. It does not wait for
 * confirmation, does not read the resulting log, and does not build a proof. A
 * Settlement becomes a Verified Settlement on Creditcoin, by proof, and the only
 * thing this strategy owes that pipeline is a {@link SettlementHint} precise
 * enough for the Watcher to find the log.
 *
 * Requirements: 23.1, 23.7, 21.5
 */

import { Interface, MaxUint256, getAddress, isAddress as isEthersAddress } from "ethers";
import type { Signer } from "ethers";
import { causeOf, ok, wrap, type Address, type Bytes32, type Hex, type Result } from "@tabai/shared";
import { defaultLogger, type Logger } from "../logger.js";
import { chainError, upstreamError, validationError } from "../errors.js";
import { ERC20_ABI, TAB_SETTLEMENT_ABI } from "./abi.js";
import {
  addressTopic,
  assetKey,
  eventSignatureFor,
  validateAssetRef,
  validateSettleRequest,
  type AssetRef,
  type ChargeQuote,
  type ChargeRequest,
  type PaymentStrategy,
  type SettleRequest,
  type SettlementHint,
  type SettlementReceipt,
} from "./strategy.js";

/** The default strategy id. Stable, because the registry is keyed by it. */
export const ETHEREUM_USDC_STRATEGY_ID = "ethereum-usdc";

/**
 * The transaction shape this strategy hands to a signer.
 *
 * Structural rather than an import of `ethers`' own `TransactionRequest`: the
 * three fields below are all this strategy sets, and naming only those makes the
 * signer trivially substitutable in a test. An `ethers.Signer` satisfies
 * {@link EthersV6Signer} — the assertion below the interface is checked by the
 * compiler, so this cannot drift from R23.7's requirement.
 */
export interface EthersV6TransactionRequest {
  readonly to: string;
  readonly data: string;
  readonly value?: bigint;
}

export interface EthersV6TransactionResponse {
  readonly hash: string;
}

/** The read half. `provider` is null on a signer with no connection. */
export interface EthersV6CallProvider {
  call(transaction: { readonly to: string; readonly data: string }): Promise<string>;
}

export interface EthersV6Signer {
  getAddress(): Promise<string>;
  sendTransaction(transaction: EthersV6TransactionRequest): Promise<EthersV6TransactionResponse>;
  readonly provider?: EthersV6CallProvider | null;
}

/** Compile-time proof that a real `ethers` v6 `Signer` is accepted here. */
type Assert<T extends true> = T;
type SignerIsAccepted = Assert<Signer extends EthersV6Signer ? true : false>;
/** Referenced so the assertion above is not mistaken for dead code. */
export type EthersV6SignerAcceptsEthersSigner = SignerIsAccepted;

export interface EthereumUsdcStrategyConfig {
  /** An `ethers` v6 signer. Its address is the payer, and so is `topics[1]`. */
  readonly signer: EthersV6Signer;
  /** `TabSettlement` on this chain. Required for `settlement-contract`, unused otherwise. */
  readonly settlementContract?: Address;
  /**
   * The Assets this strategy settles, keyed by `${chainKey}:${address}`.
   *
   * The **value** is the truth. A key that disagrees with the `AssetRef` it points
   * at is reported through the logger and the value is indexed under its own
   * derived key, because a lookup table where one Asset appears under two
   * spellings is a strategy that silently fails to support the Asset it was
   * configured for.
   */
  readonly assets: Readonly<Record<string, AssetRef>>;
  /** Overrides {@link ETHEREUM_USDC_STRATEGY_ID}, for a second instance on another chain. */
  readonly id?: string;
  /**
   * How much allowance to grant when topping up for `settlement-contract`.
   * `exact` grants the Settlement amount and leaves nothing standing; `unlimited`
   * grants `uint256` max once and never pays for a second approval.
   */
  readonly approval?: "exact" | "unlimited";
  /**
   * `read` checks the current allowance before topping up, and needs a provider.
   * `skip` submits the Settlement without reading, for a caller that manages
   * allowance itself.
   */
  readonly allowanceCheck?: "read" | "skip";
  readonly logger?: Logger;
  /** Injectable clock, so `submittedAt` is testable. Defaults to `Date.now`. */
  readonly now?: () => number;
}

const erc20 = new Interface(ERC20_ABI);
const tabSettlement = new Interface(TAB_SETTLEMENT_ABI);

/**
 * Builds the strategy.
 *
 * Construction is total: it cannot fail and returns a `PaymentStrategy`, not a
 * `Result`. Every fallible thing — an Asset that is not configured, a mode that
 * needs a contract address that was not supplied, an allowance read with no
 * provider, a transaction that will not submit — is a `Result` from the call that
 * needs it, which is the only place a caller can do anything about it.
 */
export function createEthereumUsdcStrategy(config: EthereumUsdcStrategyConfig): PaymentStrategy {
  const logger = config.logger ?? defaultLogger;
  const id = config.id ?? ETHEREUM_USDC_STRATEGY_ID;
  const now = config.now ?? (() => Date.now());
  const approval = config.approval ?? "exact";
  const allowanceCheck = config.allowanceCheck ?? "read";

  const assets = indexAssets(config.assets, id, logger);
  const chainKeys = [...new Set([...assets.values()].map((asset) => asset.chainKey))].sort(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  );

  const known = (asset: AssetRef): AssetRef | undefined => assets.get(assetKey(asset));

  const requireKnown = (asset: AssetRef): Result<AssetRef> => {
    const shape = validateAssetRef(asset, "request.asset");
    if (!shape.ok) return shape;
    const found = known(shape.value);
    if (found === undefined) {
      return validationError(
        "ASSET_NOT_CONFIGURED",
        `strategy \`${id}\` is not configured for asset ${assetKey(shape.value)}`,
        {
          details: {
            asset: assetKey(shape.value),
            configured: [...assets.keys()].join(", "),
          },
        },
      );
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

  const send = async (
    to: Address,
    data: string,
    what: string,
  ): Promise<Result<Hex>> => {
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
      return chainError(
        "SETTLEMENT_HASH_MISSING",
        `strategy \`${id}\` submitted ${what} but the signer returned no transaction hash`,
      );
    }
    return ok(hash as Hex);
  };

  /** Grants the allowance `TabSettlement.safeTransferFrom` needs, when short. */
  const ensureAllowance = async (
    asset: AssetRef,
    owner: Address,
    spender: Address,
    needed: bigint,
  ): Promise<Result<void>> => {
    if (allowanceCheck === "skip") return ok(undefined);

    const provider = config.signer.provider;
    if (provider === undefined || provider === null) {
      return upstreamError(
        "PROVIDER_REQUIRED",
        `strategy \`${id}\` needs a connected signer to read the allowance before a settlement-contract settlement; connect one or set allowanceCheck to "skip"`,
      );
    }

    const current = await wrap(
      async () => {
        const raw = await provider.call({
          to: asset.address,
          data: erc20.encodeFunctionData("allowance", [owner, spender]),
        });
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

    // USDC permits raising an allowance in one call, so no zero-first dance.
    const amount = approval === "unlimited" ? MaxUint256 : needed;
    const approved = await send(
      asset.address,
      erc20.encodeFunctionData("approve", [spender, amount]),
      `the allowance top-up for ${spender} on ${assetKey(asset)}`,
    );
    if (!approved.ok) return approved;
    logger.debug("allowance topped up", {
      strategyId: id,
      asset: assetKey(asset),
      spender,
      amount: amount.toString(10),
      txHash: approved.value,
    });
    return ok(undefined);
  };

  const requireSettlementContract = (): Result<Address> => {
    const address = config.settlementContract;
    if (address === undefined) {
      return validationError(
        "SETTLEMENT_CONTRACT_REQUIRED",
        `strategy \`${id}\` was given no settlementContract, and mode "settlement-contract" has nothing to call; use mode "direct-transfer" on a chain where Tab deploys no contract`,
      );
    }
    if (!isEthersAddress(address)) {
      return validationError(
        "SETTLEMENT_CONTRACT_INVALID",
        `strategy \`${id}\` was given \`${address}\` as its settlementContract, which is not an address`,
      );
    }
    return ok(getAddress(address) as Address);
  };

  const receiptFor = (
    request: SettleRequest,
    asset: AssetRef,
    payerAddress: Address,
    emitter: Address,
    sourceTxHash: Hex,
    batchIndex?: number,
  ): SettlementReceipt => ({
    strategyId: id,
    chainKey: asset.chainKey,
    sourceTxHash,
    asset,
    amount: request.amount,
    payerAddress,
    submittedAt: now(),
    mode: request.mode,
    collectionAddress: request.collectionAddress,
    tabId: request.tabId,
    emitter,
    ...(batchIndex === undefined ? {} : { batchIndex }),
  });

  const strategy: PaymentStrategy = {
    id,
    chainKeys,

    supports(asset) {
      return known(asset) !== undefined;
    },

    async quote(request: ChargeRequest): Promise<Result<ChargeQuote>> {
      const asset = requireKnown(request.asset);
      if (!asset.ok) return asset;
      if (typeof request.amount !== "bigint") {
        return validationError(
          "CHARGE_INVALID",
          "request.amount must be a bigint count of Asset base units, never a number",
        );
      }
      if (request.amount <= 0n) {
        return validationError(
          "AMOUNT_NOT_POSITIVE",
          "request.amount must be greater than zero base units",
        );
      }
      return ok({
        amount: request.amount,
        asset: asset.value,
        feeNote:
          "USDC settles one-for-one in base units: the amount charged is the amount transferred, with no rate and no protocol fee. Gas is paid separately in the chain's native asset and is never deducted from the Settlement amount.",
      });
    },

    async settle(request: SettleRequest): Promise<Result<SettlementReceipt>> {
      const validated = validateSettleRequest(request);
      if (!validated.ok) return validated;
      const asset = requireKnown(request.asset);
      if (!asset.ok) return asset;
      const from = await payer();
      if (!from.ok) return from;

      if (request.mode === "direct-transfer") {
        // The Settlement is the token transfer itself. Nothing else is called.
        const hash = await send(
          asset.value.address,
          erc20.encodeFunctionData("transfer", [request.collectionAddress, request.amount]),
          `a direct-transfer settlement of ${request.amount.toString(10)} ${asset.value.symbol} base units`,
        );
        if (!hash.ok) return hash;
        return ok(receiptFor(request, asset.value, from.value, asset.value.address, hash.value));
      }

      const contract = requireSettlementContract();
      if (!contract.ok) return contract;

      const allowance = await ensureAllowance(asset.value, from.value, contract.value, request.amount);
      if (!allowance.ok) return allowance;

      const hash = await send(
        contract.value,
        tabSettlement.encodeFunctionData("settle", [
          instructionOf(request, asset.value),
        ]),
        `a settlement-contract settlement of ${request.amount.toString(10)} ${asset.value.symbol} base units`,
      );
      if (!hash.ok) return hash;
      return ok(receiptFor(request, asset.value, from.value, contract.value, hash.value));
    },

    /**
     * One transaction, one `TabSettled` log per instruction, one receipt per log.
     *
     * Batching exists on the `settlement-contract` surface alone. A plain Asset
     * `Transfer` has no batch form at all, so a batch naming `direct-transfer` is
     * refused rather than quietly submitted as N transactions — the caller asked
     * for one transaction and would be charged gas for N.
     */
    async settleBatch(requests: readonly SettleRequest[]): Promise<Result<readonly SettlementReceipt[]>> {
      if (requests.length === 0) {
        return validationError("EMPTY_BATCH", "settleBatch was given no settlements");
      }

      const validatedAssets: AssetRef[] = [];
      for (const [index, request] of requests.entries()) {
        const validated = validateSettleRequest(request);
        if (!validated.ok) return validated;
        if (request.mode !== "settlement-contract") {
          return validationError(
            "BATCH_MODE_UNSUPPORTED",
            `settleBatch entry ${index} names mode "${request.mode}"; only "settlement-contract" has a batch form, because a plain Asset Transfer has none`,
            { details: { index, mode: request.mode } },
          );
        }
        const asset = requireKnown(request.asset);
        if (!asset.ok) return asset;
        validatedAssets.push(asset.value);
      }

      const first = validatedAssets[0];
      if (first === undefined) {
        return validationError("EMPTY_BATCH", "settleBatch was given no settlements");
      }
      for (const [index, asset] of validatedAssets.entries()) {
        if (asset.chainKey !== first.chainKey) {
          return validationError(
            "BATCH_CHAIN_MIXED",
            `settleBatch entry ${index} settles on chainKey ${asset.chainKey.toString(10)} and entry 0 on ${first.chainKey.toString(10)}; one transaction settles on one chain`,
            { details: { index } },
          );
        }
      }

      const contract = requireSettlementContract();
      if (!contract.ok) return contract;
      const from = await payer();
      if (!from.ok) return from;

      // Allowance is granted per Asset for the total that Asset owes, because the
      // contract pulls each instruction separately from the same account.
      const owed = new Map<string, { asset: AssetRef; total: bigint }>();
      for (const [index, asset] of validatedAssets.entries()) {
        const request = requests[index];
        if (request === undefined) continue;
        const key = assetKey(asset);
        const running = owed.get(key);
        owed.set(key, { asset, total: (running?.total ?? 0n) + request.amount });
      }
      for (const { asset, total } of owed.values()) {
        const allowance = await ensureAllowance(asset, from.value, contract.value, total);
        if (!allowance.ok) return allowance;
      }

      const instructions = requests.map((request, index) =>
        instructionOf(request, validatedAssets[index] ?? request.asset),
      );
      const hash = await send(
        contract.value,
        tabSettlement.encodeFunctionData("settleBatch", [instructions]),
        `a batch of ${requests.length} settlement-contract settlements`,
      );
      if (!hash.ok) return hash;

      return ok(
        requests.map((request, index) =>
          receiptFor(
            request,
            validatedAssets[index] ?? request.asset,
            from.value,
            contract.value,
            hash.value,
            index,
          ),
        ),
      );
    },

    /**
     * What the Watcher needs to find this Settlement's log.
     *
     * Pure, synchronous, and total: it reads the receipt and touches nothing else,
     * so a receipt can be persisted, handed across a process boundary, and turned
     * into a filter later. The payer topic is here because the payer is resolved
     * from `topics[1]`; the collection topic is here because the observation filter
     * matches `topics[2]`; the tabId topic is here on the `settlement-contract`
     * surface because that is what tells two logs of one batch apart.
     */
    watchHint(receipt: SettlementReceipt): SettlementHint {
      return {
        chainKey: receipt.chainKey,
        sourceTxHash: receipt.sourceTxHash,
        expectedEventSignature: eventSignatureFor(receipt.mode),
        expectedEmitter: receipt.emitter,
        expectedPayerTopic: addressTopic(receipt.payerAddress),
        expectedCollectionTopic: addressTopic(receipt.collectionAddress),
        ...(receipt.mode === "settlement-contract"
          ? { expectedTabIdTopic: receipt.tabId as Bytes32 }
          : {}),
        asset: receipt.asset,
        amount: receipt.amount,
      };
    },
  };

  return strategy;
}

/** The `SettlementInstruction` tuple, positionally, in the contract's field order. */
const instructionOf = (
  request: SettleRequest,
  asset: AssetRef,
): readonly [Address, Address, bigint, Bytes32] => [
  asset.address,
  request.collectionAddress,
  request.amount,
  request.tabId,
];

/**
 * Indexes the configured Assets under their derived keys, reporting any entry
 * that is malformed or filed under a key that disagrees with its value.
 */
function indexAssets(
  assets: Readonly<Record<string, AssetRef>>,
  id: string,
  logger: Logger,
): Map<string, AssetRef> {
  const indexed = new Map<string, AssetRef>();
  for (const [declaredKey, value] of Object.entries(assets)) {
    const validated = validateAssetRef(value, `assets["${declaredKey}"]`);
    if (!validated.ok) {
      logger.error("payment strategy asset entry ignored", {
        strategyId: id,
        key: declaredKey,
        message: validated.error.message,
      });
      continue;
    }
    const derived = assetKey(validated.value);
    if (declaredKey.toLowerCase() !== derived) {
      logger.warn("payment strategy asset key disagrees with its value and the value wins", {
        strategyId: id,
        declaredKey,
        derivedKey: derived,
      });
    }
    indexed.set(derived, validated.value);
  }
  return indexed;
}
