/**
 * The write side: `TabBook.markDelinquent(bytes32)`, simulated before it is sent.
 *
 * ## Why simulate when the verdict was just computed
 *
 * The verdict in `overdue.ts` is computed at one block from the same fields the
 * contract compares, so a markable tab is markable at that block. It may not be
 * at the next one: somebody else may have marked it, the Agent may have settled,
 * or the read and the send may straddle a reorg. A simulation with `eth_call`
 * costs nothing and turns each of those into a named skip instead of a reverted
 * transaction that spent gas to say the same thing.
 *
 * The four reverts `markDelinquent` can raise are matched by selector, from the
 * same `keccak256` the Dashboard's copied helpers use, so the classification
 * cannot drift from the contract's error signatures without this file changing.
 */

import { causeOf, err, ok, type Result } from "@tabai/shared";
import type { JsonRpcProvider, Signer } from "ethers";

import { bytes32Arg, selectorOf } from "./chain.js";

/** `TabBook.markDelinquent(bytes32)`. */
export const MARK_DELINQUENT_SELECTOR = selectorOf("markDelinquent(bytes32)");

/** The reverts a mark can meet, each a reason to skip rather than a failure. */
export const SKIP_SELECTORS: Readonly<Record<string, SkipReason>> = {
  [selectorOf("AlreadyDelinquent(bytes32)")]: "AlreadyDelinquent",
  [selectorOf("NothingUnsettled(bytes32)")]: "NothingUnsettled",
  [selectorOf("SettlementWindowOpen(bytes32,uint64)")]: "SettlementWindowOpen",
  [selectorOf("UnknownTab(bytes32)")]: "UnknownTab",
};

export type SkipReason = "AlreadyDelinquent" | "NothingUnsettled" | "SettlementWindowOpen" | "UnknownTab";

export type MarkVerdict = { readonly outcome: "markable" } | { readonly outcome: "skip"; readonly reason: SkipReason };

export interface MarkReceipt {
  readonly txHash: string;
  /** Null when the receipt could not be waited for. */
  readonly blockNumber: number | null;
}

export interface Marker {
  /** Runs the call without sending it. A known revert is a verdict, not an error. */
  simulate(tabId: string): Promise<Result<MarkVerdict>>;
  /** Sends the call and waits for its receipt. */
  send(tabId: string): Promise<Result<MarkReceipt>>;
}

/** The calldata for one mark. */
export const markCalldata = (tabId: string): string => `${MARK_DELINQUENT_SELECTOR}${bytes32Arg(tabId)}`;

/** Names the skip a revert payload encodes, or undefined for anything else. */
export function classifyRevert(data: unknown): SkipReason | undefined {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{8}/.test(data)) return undefined;
  return SKIP_SELECTORS[data.slice(0, 10).toLowerCase()];
}

export interface EthersMarkerOptions {
  readonly provider: JsonRpcProvider;
  readonly tabBook: string;
  /** Absent on a dry run: `simulate` still works, `send` refuses. */
  readonly signer?: Signer | undefined;
}

/** A revert as ethers surfaces it: a thrown error carrying the return data. */
const revertDataOf = (error: unknown): unknown => {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { data?: unknown; code?: unknown; error?: { data?: unknown } };
  if (typeof candidate.data === "string") return candidate.data;
  return candidate.error?.data;
};

export function createEthersMarker(options: EthersMarkerOptions): Marker {
  const from = options.signer;
  return {
    async simulate(tabId) {
      const call = { to: options.tabBook, data: markCalldata(tabId) };
      try {
        const sender = from === undefined ? undefined : await from.getAddress();
        await options.provider.call(sender === undefined ? call : { ...call, from: sender });
        return ok({ outcome: "markable" });
      } catch (error) {
        const data = revertDataOf(error);
        const reason = classifyRevert(data);
        if (reason !== undefined) return ok({ outcome: "skip", reason });
        const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
        if (code === "CALL_EXCEPTION" || typeof data === "string") {
          return err({
            category: "CHAIN",
            code: "MARK_SIMULATION_REVERTED",
            message: `markDelinquent(${tabId}) reverted with a selector this keeper does not recognise`,
            retryable: false,
            details: { tabId, selector: typeof data === "string" ? data.slice(0, 10) : "none" },
            cause: causeOf(error),
          });
        }
        return err({
          category: "UPSTREAM",
          code: "MARK_SIMULATION_FAILED",
          message: `markDelinquent(${tabId}) could not be simulated`,
          retryable: true,
          details: { tabId },
          cause: causeOf(error),
        });
      }
    },
    async send(tabId) {
      if (from === undefined) {
        return err({
          category: "VALIDATION",
          code: "KEEPER_KEY_MISSING",
          message: "no signer is configured, so the mark can be simulated but not sent",
          retryable: false,
          details: { tabId },
        });
      }
      try {
        const response = await from.sendTransaction({ to: options.tabBook, data: markCalldata(tabId) });
        const receipt = await response.wait();
        if (receipt !== null && receipt.status === 0) {
          return err({
            category: "CHAIN",
            code: "MARK_REVERTED",
            message: `markDelinquent(${tabId}) was mined and reverted in ${response.hash}`,
            retryable: false,
            details: { tabId, txHash: response.hash },
          });
        }
        return ok({ txHash: response.hash, blockNumber: receipt?.blockNumber ?? null });
      } catch (error) {
        return err({
          category: "CHAIN",
          code: "MARK_SUBMISSION_FAILED",
          message: `markDelinquent(${tabId}) could not be sent`,
          retryable: true,
          details: { tabId },
          cause: causeOf(error),
        });
      }
    },
  };
}
