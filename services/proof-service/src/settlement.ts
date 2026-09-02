/**
 * The Proof Service settling its own Open Tabs, as an Agent and nothing more.
 *
 * ## The point of this module is that it takes no shortcut
 *
 * The Proof Service holds the Service operator key, so it could reach for
 * `TabBook` directly and adjust its own tabs. It does not, and that is the whole
 * requirement (R22.4): the operator settles the way every other Agent settles.
 * It pays USDC on a Source Chain through the SDK's {@link PaymentStrategy}, the
 * Watcher observes the log, proves it through the Attestcoin BlockProver Precompile
 * and hands it to `SettlementVerifier`, and `TabBook` clears the tab off the
 * Verified Settlement. Nothing in this file writes to Creditcoin. There is no
 * privileged path, because a rail whose operator has one is not a rail.
 *
 * What this module therefore produces is a Settlement and a
 * {@link SettlementHint} precise enough for the Watcher to find the log, and then
 * it stops. Confirmation, proof and clearing belong to the pipeline that already
 * does them for everyone.
 *
 * ## Two surfaces, chosen by chainKey and never by a flag
 *
 * On chainKey 3 Tab deploys nothing, so a plain USDC `Transfer` to a registered
 * Collection Address is the Settlement. On chainKey 1 the payment goes through
 * `TabSettlement.settle`, which emits a `TabSettled` naming the Agent, the Service,
 * the amount and the tabId outright. The strategy owns both paths; this module
 * picks the one the chain actually supports and refuses rather than guessing.
 *
 * ## The recipient is checked against the registry before anything is paid
 *
 * A Settlement is credited by resolving its recipient through
 * `ServiceRegistry.collectionFor`, so paying an address that is not a registered
 * Tab collection for the right Service and Asset produces a real transfer that is
 * never credited to anything. That is money gone with no tab reduced, so the check
 * runs before the payment and its failure is not retryable.
 *
 * Requirements: 22.4, 2.1, 2.3, 23.1
 */

import { Interface, type JsonRpcProvider } from "ethers";

import { causeOf, err, ok, type Result, type TabError } from "@tabai/shared";
import type {
  AssetRef,
  PaymentStrategy,
  SettlementHint,
  SettlementMode,
  SettlementReceipt,
} from "@tabai/sdk";

import { TAB_BOOK_INTERFACE } from "./tab-book.js";

/**
 * `ServiceRegistry.collectionFor`. Field order is wire order.
 *
 * `CollectionKind` is `Tab = 0` and `Bond = 1`, and the kind is appended after
 * `exists` so an older record decodes correctly. Paying a Bond collection to settle
 * a tab would credit stake instead of reducing the tab, so the kind is checked
 * rather than assumed.
 */
export const COLLECTION_ABI = [
  "function collectionFor(uint64 chainKey, address collection) view returns ((bytes32 serviceId, address asset, uint64 chainKey, bool exists, uint8 kind) record)",
] as const;

export const COLLECTION_INTERFACE = new Interface([...COLLECTION_ABI]);

/** `CollectionKind.Tab`, the only kind a tab Settlement may be paid into. */
export const COLLECTION_KIND_TAB = 0;

/** `CollectionKind.Bond`, named so a wrong-kind refusal can say which it found. */
export const COLLECTION_KIND_BOND = 1;

/** One Open Tab as `TabBook.tabOf` holds it. */
export interface OpenTab {
  readonly tabId: string;
  readonly open: bigint;
  readonly prepaid: bigint;
  readonly oldestUnsettledAt: bigint;
  readonly lastDeliveryAt: bigint;
  readonly deliveryCount: number;
  readonly delinquent: boolean;
}

/** One Collection Address as the registry resolves it. */
export interface CollectionRecord {
  readonly serviceId: string;
  readonly asset: string;
  readonly chainKey: bigint;
  readonly exists: boolean;
  readonly kind: number;
}

/** What the settler needs from Creditcoin, narrow enough for a test to supply. */
export interface SettlementReader {
  /** The Proof Service's own Open Tab with one Service in one Asset. */
  openTab(agent: string, serviceId: string, asset: string): Promise<Result<OpenTab>>;
  /** The registry's resolution of one Collection Address on one chain. */
  collection(chainKey: bigint, collection: string): Promise<Result<CollectionRecord>>;
}

function readFailed(what: string, error: unknown): TabError {
  return {
    category: "UPSTREAM",
    code: "CHAIN_READ_FAILED",
    message: `\`${what}\` could not be read from Creditcoin`,
    retryable: true,
    cause: causeOf(error),
  };
}

/**
 * Builds the reader over a provider pinned to one block tag.
 *
 * Both reads are pinned to the same tag, so a plan is made against one view of the
 * chain rather than against two moments of it.
 */
export function createSettlementReader(
  provider: JsonRpcProvider,
  addresses: { readonly tabBook: string; readonly serviceRegistry: string },
  blockTag: string | number,
): SettlementReader {
  return {
    async openTab(agent, serviceId, asset): Promise<Result<OpenTab>> {
      try {
        const tabIdData = TAB_BOOK_INTERFACE.encodeFunctionData("tabIdOf", [agent, serviceId, asset]);
        const tabId = String(
          TAB_BOOK_INTERFACE.decodeFunctionResult(
            "tabIdOf",
            await provider.call({ to: addresses.tabBook, data: tabIdData, blockTag }),
          )[0],
        ).toLowerCase();

        const tabData = TAB_BOOK_INTERFACE.encodeFunctionData("tabOf", [tabId]);
        const fields = TAB_BOOK_INTERFACE.decodeFunctionResult(
          "tabOf",
          await provider.call({ to: addresses.tabBook, data: tabData, blockTag }),
        )[0] as readonly unknown[];

        return ok({
          tabId,
          open: BigInt(fields[0] as bigint),
          prepaid: BigInt(fields[1] as bigint),
          oldestUnsettledAt: BigInt(fields[2] as bigint),
          lastDeliveryAt: BigInt(fields[3] as bigint),
          deliveryCount: Number(fields[4]),
          delinquent: fields[5] === true,
        });
      } catch (error) {
        return err(readFailed("tabOf", error));
      }
    },

    async collection(chainKey, collection): Promise<Result<CollectionRecord>> {
      try {
        const data = COLLECTION_INTERFACE.encodeFunctionData("collectionFor", [chainKey, collection]);
        const fields = COLLECTION_INTERFACE.decodeFunctionResult(
          "collectionFor",
          await provider.call({ to: addresses.serviceRegistry, data, blockTag }),
        )[0] as readonly unknown[];
        return ok({
          serviceId: String(fields[0]).toLowerCase(),
          asset: String(fields[1]).toLowerCase(),
          chainKey: BigInt(fields[2] as bigint),
          exists: fields[3] === true,
          kind: Number(fields[4]),
        });
      } catch (error) {
        return err(readFailed("collectionFor", error));
      }
    },
  };
}

/**
 * The Settlement surface a chainKey supports.
 *
 * Not configurable, because it is a fact about where Tab has deployed rather than
 * a preference. Mainnet has no Tab contract at all, so `settlement-contract` there
 * would be a call to nothing.
 */
export function modeFor(chainKey: bigint): Result<SettlementMode> {
  if (chainKey === 3n) return ok("direct-transfer");
  if (chainKey === 1n) return ok("settlement-contract");
  return err({
    category: "VALIDATION",
    code: "CHAIN_KEY_UNSUPPORTED",
    message: `chainKey ${chainKey.toString(10)} is not a Source Chain this rail settles on; 1 is Ethereum Sepolia and 3 is Ethereum Mainnet`,
    retryable: false,
    details: { chainKey: chainKey.toString(10) },
  });
}

/** What one Open Tab would be settled with, before anything is paid. */
export interface SettlementPlan {
  /** The Proof Service's own Creditcoin address, acting as the Agent. */
  readonly agent: string;
  /** The Service the tab is owed to. */
  readonly serviceId: string;
  readonly asset: AssetRef;
  readonly tabId: string;
  /** Base units to pay. The Open Tab in full unless the caller asked for less. */
  readonly amount: bigint;
  /** The whole Open Tab, so a partial Settlement is visible as one. */
  readonly openTab: bigint;
  readonly collectionAddress: string;
  readonly mode: SettlementMode;
  /** What the strategy said this costs, in the strategy's own words. */
  readonly feeNote: string;
  /** True when the tab has passed its Settlement Window. */
  readonly delinquent: boolean;
}

/** A submitted Settlement, with the hint the Watcher needs to find its log. */
export interface SubmittedSettlement {
  readonly plan: SettlementPlan;
  readonly receipt: SettlementReceipt;
  readonly hint: SettlementHint;
}

export interface SettlementRequest {
  readonly serviceId: string;
  readonly asset: AssetRef;
  readonly collectionAddress: string;
  /** Base units to pay. Defaults to the whole Open Tab. */
  readonly amount?: bigint | undefined;
}

export interface ProofServiceSettlerOptions {
  /** The Proof Service's own Creditcoin address. It is the Agent here. */
  readonly agent: string;
  readonly reader: SettlementReader;
  readonly strategy: PaymentStrategy;
}

/** Plan first, pay second, and paying is a separate call for a reason. */
export interface ProofServiceSettler {
  /** What would be paid, checked against the chain, spending nothing. */
  plan(request: SettlementRequest): Promise<Result<SettlementPlan>>;
  /**
   * Pays it, through the same strategy every other Agent uses.
   *
   * Guarded by an explicit `broadcast` flag so a caller cannot spend by omission.
   * Without it the call refuses and names the flag, which is what lets a driver
   * default to read-only and still exercise the whole path.
   */
  settle(plan: SettlementPlan, options: { readonly broadcast: boolean }): Promise<Result<SubmittedSettlement>>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** Builds the settler. Construction cannot fail; every fallible thing is a call. */
export function createProofServiceSettler(
  options: ProofServiceSettlerOptions,
): ProofServiceSettler {
  const agent = options.agent.toLowerCase();

  return {
    async plan(request): Promise<Result<SettlementPlan>> {
      if (!BYTES32.test(request.serviceId)) {
        return err({
          category: "VALIDATION",
          code: "SERVICE_ID_MALFORMED",
          message: "the Service the tab is owed to must be named by its 32-byte registry key",
          retryable: false,
        });
      }
      if (!ADDRESS.test(request.collectionAddress)) {
        return err({
          category: "VALIDATION",
          code: "COLLECTION_ADDRESS_MALFORMED",
          message: "the Collection Address must be a 20-byte 0x address",
          retryable: false,
        });
      }

      const mode = modeFor(request.asset.chainKey);
      if (!mode.ok) return mode;

      if (!options.strategy.supports(request.asset)) {
        return err({
          category: "VALIDATION",
          code: "ASSET_NOT_SUPPORTED",
          message: `the payment strategy \`${options.strategy.id}\` does not settle ${request.asset.chainKey.toString(10)}:${request.asset.address}, so this tab cannot be settled through it`,
          retryable: false,
          details: {
            strategy: options.strategy.id,
            asset: `${request.asset.chainKey.toString(10)}:${request.asset.address}`,
          },
        });
      }

      const tab = await options.reader.openTab(agent, request.serviceId, request.asset.address);
      if (!tab.ok) return tab;

      if (tab.value.open === 0n) {
        return err({
          category: "NOT_FOUND",
          code: "NO_OPEN_TAB",
          message: `the Proof Service owes nothing to Service ${request.serviceId} in ${request.asset.symbol}, so there is nothing to settle`,
          retryable: false,
          details: { tabId: tab.value.tabId },
        });
      }

      const amount = request.amount ?? tab.value.open;
      if (amount <= 0n) {
        return err({
          category: "VALIDATION",
          code: "AMOUNT_NOT_POSITIVE",
          message: "a Settlement must move more than zero base units",
          retryable: false,
        });
      }
      if (amount > tab.value.open) {
        return err({
          category: "VALIDATION",
          code: "AMOUNT_EXCEEDS_OPEN_TAB",
          message: `the requested ${amount.toString(10)} base units is more than the ${tab.value.open.toString(10)} this tab holds open; overpaying credits nothing back`,
          retryable: false,
          details: { requested: amount.toString(10), open: tab.value.open.toString(10) },
        });
      }

      // The recipient is checked before the money moves. A transfer to an
      // unregistered address is a real payment that is credited to nothing.
      const collection = await options.reader.collection(
        request.asset.chainKey,
        request.collectionAddress,
      );
      if (!collection.ok) return collection;
      if (!collection.value.exists) {
        return err({
          category: "VALIDATION",
          code: "COLLECTION_UNREGISTERED",
          message: `${request.collectionAddress} is not a registered Collection Address on chainKey ${request.asset.chainKey.toString(10)}, so a Settlement paid there would be credited to nothing`,
          retryable: false,
        });
      }
      if (collection.value.kind !== COLLECTION_KIND_TAB) {
        return err({
          category: "VALIDATION",
          code: "COLLECTION_KIND_WRONG",
          message: `${request.collectionAddress} is registered as a ${collection.value.kind === COLLECTION_KIND_BOND ? "Bond" : `kind ${collection.value.kind}`} collection, so paying it would credit stake rather than reduce this Open Tab`,
          retryable: false,
        });
      }
      if (collection.value.serviceId !== request.serviceId.toLowerCase()) {
        return err({
          category: "VALIDATION",
          code: "COLLECTION_SERVICE_MISMATCH",
          message: `${request.collectionAddress} collects for Service ${collection.value.serviceId} and this tab is owed to ${request.serviceId}, so the Settlement would reduce a different Service's tab`,
          retryable: false,
        });
      }
      if (collection.value.asset !== request.asset.address.toLowerCase()) {
        return err({
          category: "VALIDATION",
          code: "COLLECTION_ASSET_MISMATCH",
          message: `${request.collectionAddress} collects ${collection.value.asset} and this tab is denominated in ${request.asset.address}; one address collects exactly one Asset per chain`,
          retryable: false,
        });
      }

      const quote = await options.strategy.quote({
        agent: agent as `0x${string}`,
        serviceId: request.serviceId as `0x${string}`,
        asset: request.asset,
        amount,
      });
      if (!quote.ok) return quote;

      return ok({
        agent,
        serviceId: request.serviceId.toLowerCase(),
        asset: request.asset,
        tabId: tab.value.tabId,
        amount: quote.value.amount,
        openTab: tab.value.open,
        collectionAddress: request.collectionAddress.toLowerCase(),
        mode: mode.value,
        feeNote: quote.value.feeNote,
        delinquent: tab.value.delinquent,
      });
    },

    async settle(plan, settleOptions): Promise<Result<SubmittedSettlement>> {
      if (!settleOptions.broadcast) {
        return err({
          category: "VALIDATION",
          code: "BROADCAST_NOT_REQUESTED",
          message: `settling this tab moves ${plan.amount.toString(10)} ${plan.asset.symbol} base units on chainKey ${plan.asset.chainKey.toString(10)} and the call was made without \`broadcast\`, so nothing was submitted`,
          retryable: false,
          details: {
            tabId: plan.tabId,
            amount: plan.amount.toString(10),
            collectionAddress: plan.collectionAddress,
          },
        });
      }

      const receipt = await options.strategy.settle({
        agent: plan.agent as `0x${string}`,
        serviceId: plan.serviceId as `0x${string}`,
        asset: plan.asset,
        amount: plan.amount,
        collectionAddress: plan.collectionAddress as `0x${string}`,
        tabId: plan.tabId as `0x${string}`,
        mode: plan.mode,
      });
      if (!receipt.ok) return receipt;

      // The hand-off, and the end of this module's responsibility. From here the
      // Watcher observes the log, builds the proof, and `SettlementVerifier` and
      // `TabBook` do the crediting, exactly as they do for every other Agent.
      return ok({
        plan,
        receipt: receipt.value,
        hint: options.strategy.watchHint(receipt.value),
      });
    },
  };
}
