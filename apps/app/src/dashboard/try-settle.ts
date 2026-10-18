/**
 * The Try it Agent pays its own tab, before a trial call needs it to.
 *
 * Every Try it call lands on one demonstration Agent's Open Tab. Left alone,
 * that tab ages past its Settlement Window, and then anyone may mark it
 * delinquent from the Explorer, after which every trial call on that network
 * is refused until someone settles. So before a call, `/api/try` reads the
 * Agent's tab and, when it should be paid, the Agent settles it with its own
 * key, through the SDK's direct Monad strategy, the same transaction
 * `tab_settle` sends.
 *
 * When to settle is the SDK's auto-settle policy (`@tabai/sdk/settle`): a
 * delinquent tab first, then one whose oldest charge has used half its window,
 * then one that has reached the amount below. Half the window, because a quiet
 * site may go hours between calls and the next caller must still find the tab
 * clear.
 *
 * A Settlement that fails never stops the call: the trial goes ahead on credit
 * and the failure is reported beside it. The key is read per request from the
 * environment and never leaves this module.
 */

import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { createMonadStrategy, decideAutoSettle, type AutoSettlePolicy, type AutoSettleReason } from "@tabai/sdk/settle";
import { MAINNET_ASSETS, MONAD_TESTNET, type MonadChainId } from "@tabai/shared";

import { deploymentFor } from "./deployments.js";
import { AUTO_SETTLE_HEADERS } from "./try-charge.js";

/** Settle at this many base units (0.10 of a six-decimal dollar), or at half the window, whichever comes first. */
export const TRY_SETTLE_POLICY: AutoSettlePolicy = { atBaseUnits: 100_000n, windowShare: 0.5 };


/** The Asset a trial call is metered in: the demo Service's own on each network. */
export function tryAssetOf(chainId: MonadChainId): { address: string; symbol: string; decimals: number } {
  if (chainId === MONAD_TESTNET.chainId) {
    const mock = deploymentFor(chainId).mockUsdc;
    if (mock !== undefined) return { address: mock, symbol: "mUSDC", decimals: 6 };
  }
  return { address: MAINNET_ASSETS.USDC.address, symbol: "USDC", decimals: 6 };
}

export type TrySettleOutcome =
  | { readonly kind: "skipped" }
  | { readonly kind: "settled"; readonly reason: AutoSettleReason; readonly amount: bigint; readonly txHash: string }
  | { readonly kind: "failed"; readonly reason: AutoSettleReason | "read"; readonly message: string };

/** What the decision needs, as the chain holds it. */
export interface TryTabState {
  readonly open: bigint;
  readonly oldestUnsettledAt: bigint;
  readonly delinquent: boolean;
  readonly windowSeconds: bigint;
}

export interface TrySettleDeps {
  readonly readTab: () => Promise<TryTabState>;
  readonly settle: (amount: bigint) => Promise<{ ok: true; txHash: string } | { ok: false; message: string }>;
  readonly now: () => bigint;
}

/** Decides and, when due, settles. Pure over its dependencies, so the tests drive it without a chain. */
export async function settleTryTabIfDue(deps: TrySettleDeps, policy: AutoSettlePolicy = TRY_SETTLE_POLICY): Promise<TrySettleOutcome> {
  let tab: TryTabState;
  try {
    tab = await deps.readTab();
  } catch (cause) {
    return { kind: "failed", reason: "read", message: `the tab could not be read: ${messageOf(cause)}` };
  }
  const decision = decideAutoSettle(policy, {
    openTab: tab.open,
    delinquent: tab.delinquent,
    oldestUnsettledAt: tab.oldestUnsettledAt,
    windowSeconds: tab.windowSeconds,
    now: deps.now(),
  });
  if (!decision.settle) return { kind: "skipped" };
  const sent = await deps.settle(decision.amount);
  return sent.ok
    ? { kind: "settled", reason: decision.reason, amount: decision.amount, txHash: sent.txHash }
    : { kind: "failed", reason: decision.reason, message: sent.message };
}

const TAB_BOOK_ABI = [
  "function tabIdOf(address agent, bytes32 serviceId, address asset) pure returns (bytes32)",
  "function tabOf(bytes32 tabId) view returns (tuple(uint128 open, uint128 prepaid, uint64 oldestUnsettledAt, uint64 lastDeliveryAt, uint32 deliveryCount, bool delinquent))",
];
const REGISTRY_ABI = ["function settlementWindowOf(bytes32 serviceId) view returns (uint32)"];

/**
 * The live dependencies: the Agent's tab and the Service's window off the
 * chain, and a Settlement from the Agent's own key. Undefined when this
 * deployment holds no key for the Try it Agent on the network, or holds one
 * for a different address, in which case nothing is settled and the call goes
 * ahead as before.
 */
export function liveTrySettleDeps(options: {
  readonly chainId: MonadChainId;
  readonly rpcUrl: string;
  readonly agent: string;
  readonly serviceId: string;
  readonly agentKey: string | undefined;
}): TrySettleDeps | undefined {
  const key = options.agentKey?.trim();
  if (key === undefined || key === "" || !/^0x[0-9a-fA-F]{64}$/.test(key)) return undefined;
  const provider = new JsonRpcProvider(options.rpcUrl, options.chainId, { staticNetwork: true });
  const wallet = new Wallet(key, provider);
  if (wallet.address.toLowerCase() !== options.agent.toLowerCase()) return undefined;

  const deployment = deploymentFor(options.chainId);
  const asset = tryAssetOf(options.chainId);
  const tabBook = new Contract(deployment.tabBook, TAB_BOOK_ABI, provider);
  const registry = new Contract(deployment.serviceRegistry, REGISTRY_ABI, provider);

  return {
    now: () => BigInt(Math.floor(Date.now() / 1000)),
    readTab: async () => {
      const tabId = (await tabBook.getFunction("tabIdOf")(options.agent, options.serviceId, asset.address)) as string;
      const [tab, window] = await Promise.all([
        tabBook.getFunction("tabOf")(tabId) as Promise<{ open: bigint; oldestUnsettledAt: bigint; delinquent: boolean }>,
        registry.getFunction("settlementWindowOf")(options.serviceId) as Promise<bigint>,
      ]);
      return { open: tab.open, oldestUnsettledAt: tab.oldestUnsettledAt, delinquent: tab.delinquent, windowSeconds: BigInt(window) };
    },
    settle: async (amount) => {
      const ref = { chainId: BigInt(options.chainId), address: asset.address.toLowerCase() as `0x${string}`, decimals: asset.decimals, symbol: asset.symbol };
      const strategy = createMonadStrategy({
        signer: wallet,
        tabSettlement: deployment.tabSettlement as `0x${string}`,
        assets: { [`${options.chainId}:${ref.address}`]: ref },
      });
      const receipt = await strategy.settle({
        agent: options.agent.toLowerCase() as `0x${string}`,
        serviceId: options.serviceId.toLowerCase() as `0x${string}`,
        asset: ref,
        amount,
      });
      return receipt.ok ? { ok: true, txHash: receipt.value.txHash } : { ok: false, message: receipt.error.message };
    },
  };
}

/** The headers an outcome is reported in. Nothing for a skip, so an ordinary call carries nothing new. */
export function autoSettleHeaders(outcome: TrySettleOutcome): Readonly<Record<string, string>> {
  if (outcome.kind === "settled") {
    return {
      [AUTO_SETTLE_HEADERS.reason]: outcome.reason,
      [AUTO_SETTLE_HEADERS.amount]: outcome.amount.toString(10),
      [AUTO_SETTLE_HEADERS.txHash]: outcome.txHash,
    };
  }
  if (outcome.kind === "failed") {
    return { [AUTO_SETTLE_HEADERS.reason]: outcome.reason, [AUTO_SETTLE_HEADERS.error]: outcome.message.slice(0, 300) };
  }
  return {};
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
