/**
 * The reads. Nothing here signs anything or costs anything.
 *
 * Every Creditcoin read in one pass is pinned to a single block, so a reading is
 * a consistent picture rather than a set of values gathered while the chain moved
 * under it. That matters more here than it would in a service: the demo's whole
 * output is differences between two readings, and a tab read one block after the
 * authorisation it is compared against would show a movement nothing caused.
 *
 * The pinned tag is `latest`, not `finalized`. The Watcher and the gateway pin to
 * `finalized` because they act on what they read and must not act on a block that
 * may vanish. This narrates a transaction it has just watched land, and pinning to
 * `finalized` here would report "nothing moved" for a minute after every write -
 * exactly the lag behind the two false readings recorded in the gateway and
 * Watcher notes.
 *
 * Calls go through `Interface` and `provider.call` rather than through `Contract`
 * method sugar, as the gateway's own readers do. The sugar is dynamically typed,
 * so a misspelled function name is a runtime failure inside a demo somebody is
 * watching; encoding explicitly makes it a compile error.
 */

import { Interface, JsonRpcProvider, type Provider } from "ethers";

import type { Address, Bytes32 } from "@tabai/shared";

import type { AgentIdentity, Cast } from "./cast.js";
import type { AgentLedger } from "./ledger.js";

/** Only the views this demo reads. The write surface lives with the acts that use it. */
export const TAB_BOOK_READ_ABI = [
  "function tabIdOf(address agent, bytes32 serviceId, address asset) pure returns (bytes32)",
  "function tabOf(bytes32 tabId) view returns ((uint128 open, uint128 prepaid, uint64 oldestUnsettledAt, uint64 lastDeliveryAt, uint32 deliveryCount, bool delinquent))",
  "function authorisationOf(address agent, bytes32 serviceId, address asset) view returns ((uint128 maxCumulative, uint128 spent, uint64 expiry, bool exists))",
  "function historyCommitment(address agent, address asset) view returns (bytes32 commitment, uint32 count)",
  "function clearingOf(bytes32 clearingId) view returns ((address agent, bytes32 serviceId, address asset, uint128 amount, uint128 reduced, uint64 chainKey, uint64 appliedAt, uint64 deadline, bytes32 sourceTxHash, bytes32 attestedDigestAtApply, uint8 state))",
] as const;

export const AGENT_REGISTRY_READ_ABI = [
  "function agentOf(uint64 chainKey, address ethAddress) view returns (address)",
  "function boundAddresses(address agent, uint64 chainKey) view returns (address[])",
] as const;

export const ERC20_READ_ABI = ["function balanceOf(address) view returns (uint256)"] as const;

export const TAB_BOOK_INTERFACE = new Interface([...TAB_BOOK_READ_ABI]);
export const AGENT_REGISTRY_INTERFACE = new Interface([...AGENT_REGISTRY_READ_ABI]);
export const ERC20_INTERFACE = new Interface([...ERC20_READ_ABI]);

/** The two providers a pass needs, built once. */
export interface DemoProviders {
  readonly creditcoin: JsonRpcProvider;
  readonly source: JsonRpcProvider;
}

export function createProviders(cast: Cast): DemoProviders {
  return {
    creditcoin: new JsonRpcProvider(cast.creditcoinRpcUrl),
    source: new JsonRpcProvider(cast.sourceRpcUrl),
  };
}

/**
 * One `eth_call`, encoded and decoded through a stated interface.
 *
 * Throws rather than returning a `Result`, and deliberately: a view that reverts
 * against a deployed address means the address is wrong or the chain is
 * unreachable, which is a condition to stop the whole run on rather than one for
 * every caller to branch over.
 */
export async function callView(
  provider: Provider,
  to: string,
  iface: Interface,
  fn: string,
  args: readonly unknown[],
  blockTag?: number,
): Promise<readonly unknown[]> {
  const data = iface.encodeFunctionData(fn, [...args]);
  const raw = await provider.call({ to, data, ...(blockTag === undefined ? {} : { blockTag }) });
  return iface.decodeFunctionResult(fn, raw) as unknown as readonly unknown[];
}

/** The `tabId` for an Agent under this demo's Service and Asset. */
export async function tabIdFor(provider: Provider, cast: Cast, agent: Address): Promise<Bytes32> {
  const [id] = await callView(provider, cast.tabBook, TAB_BOOK_INTERFACE, "tabIdOf", [
    agent,
    cast.serviceId,
    cast.asset.address,
  ]);
  return id as Bytes32;
}

/** The Asset balance of one Source Chain address, at that chain's head. */
export async function assetBalanceOf(
  providers: DemoProviders,
  cast: Cast,
  holder: Address,
): Promise<bigint> {
  const [balance] = await callView(providers.source, cast.asset.address, ERC20_INTERFACE, "balanceOf", [
    holder,
  ]);
  return balance as bigint;
}

/**
 * One consistent reading of everything the rail holds about one Agent.
 *
 * The Source Chain balances are read at that chain's own head rather than at a
 * pinned height. The two chains have no shared clock, so pinning both would be a
 * false precision; what the balances are here for is the human check that the
 * money left one place and arrived at another, and for that the head is right.
 */
export async function readLedger(
  providers: DemoProviders,
  cast: Cast,
  agent: AgentIdentity,
): Promise<AgentLedger> {
  const atBlock = await providers.creditcoin.getBlockNumber();
  const tabId = await tabIdFor(providers.creditcoin, cast, agent.creditcoin);

  const [tab, authorisation, history, walletBalance] = await Promise.all([
    callView(providers.creditcoin, cast.tabBook, TAB_BOOK_INTERFACE, "tabOf", [tabId], atBlock),
    callView(
      providers.creditcoin,
      cast.tabBook,
      TAB_BOOK_INTERFACE,
      "authorisationOf",
      [agent.creditcoin, cast.serviceId, cast.asset.address],
      atBlock,
    ),
    callView(
      providers.creditcoin,
      cast.tabBook,
      TAB_BOOK_INTERFACE,
      "historyCommitment",
      [agent.creditcoin, cast.asset.address],
      atBlock,
    ),
    assetBalanceOf(providers, cast, agent.ethereum),
  ]);

  const tabFields = tab[0] as readonly unknown[];
  const authFields = authorisation[0] as readonly unknown[];

  const smartAccountBalance =
    agent.smartAccount === undefined
      ? undefined
      : await assetBalanceOf(providers, cast, agent.smartAccount);

  return {
    agent: agent.creditcoin,
    tabId,
    open: tabFields[0] as bigint,
    prepaid: tabFields[1] as bigint,
    deliveryCount: Number(tabFields[4]),
    authorisationCeiling: authFields[0] as bigint,
    authorisationSpent: authFields[1] as bigint,
    authorisationExpiry: Number(authFields[2]),
    authorised: authFields[3] as boolean,
    historyCount: Number(history[1]),
    historyCommitment: history[0] as Bytes32,
    walletBalance,
    ...(smartAccountBalance === undefined ? {} : { smartAccountBalance }),
    atBlock,
  };
}

/** Which Agent a Source Chain address is bound to, or the zero address for none. */
export async function boundAgentOf(
  providers: DemoProviders,
  cast: Cast,
  sourceAddress: Address,
): Promise<Address> {
  const [agent] = await callView(
    providers.creditcoin,
    cast.agentRegistry,
    AGENT_REGISTRY_INTERFACE,
    "agentOf",
    [cast.asset.chainKey, sourceAddress],
  );
  return agent as Address;
}

/**
 * `TabBook.SettlementApplied`, the event that says which Agent one Settlement paid for.
 *
 * The replay key and the Agent are both indexed, so this is a topic filter rather
 * than a scan, and the answer is the rail's own public statement about one
 * Settlement rather than an inference from two readings of a tab.
 */
export const SETTLEMENT_APPLIED_ABI = [
  "event SettlementApplied(bytes32 indexed replayKey, address indexed agent, bytes32 indexed serviceId, address asset, uint256 applied, uint256 toPrepaid, uint128 openAfter)",
] as const;

export const SETTLEMENT_APPLIED_INTERFACE = new Interface([...SETTLEMENT_APPLIED_ABI]);

export const SETTLEMENT_APPLIED_TOPIC =
  SETTLEMENT_APPLIED_INTERFACE.getEvent("SettlementApplied")?.topicHash ?? "";

/**
 * The per-receipt ordinal of a log, which is what a replay key packs.
 *
 * **Never the block-wide `logIndex`.** The two agree only for the first
 * transaction in a block, and the whole identity of a Settlement rests on this
 * number, so taking the wrong one produces a key that names a different log or
 * no log at all.
 */
export function receiptOrdinalOf(
  receiptLogs: readonly { readonly index: number }[],
  logIndex: number,
): number {
  const ordinal = receiptLogs.findIndex((entry) => entry.index === logIndex);
  if (ordinal === -1) {
    throw new Error(`log ${String(logIndex)} is not in the receipt it was taken from`);
  }
  return ordinal;
}

/**
 * How much of a Settlement a Provisional Clearing had already taken off the tab.
 *
 * Load-bearing for any check on the amount. When a clearing covered the tab,
 * `applyVerifiedSettlement` takes the confirming branch and emits
 * `SettlementApplied` with `applied = 0` and `toPrepaid = amount - reduced`,
 * because the `reduced` part came off the Open Tab at clearing time against
 * pledged Bond. So `applied + toPrepaid` is short by exactly `reduced`, and a
 * check that ignored this would fail every Settlement the Watcher cleared first -
 * which is the ordinary path, not an edge case.
 */
export async function clearingReductionOf(
  providers: DemoProviders,
  cast: Cast,
  replayKey: Bytes32,
): Promise<bigint> {
  const [clearing] = await callView(
    providers.creditcoin,
    cast.tabBook,
    TAB_BOOK_INTERFACE,
    "clearingOf",
    [replayKey],
  );
  return (clearing as readonly unknown[])[4] as bigint;
}

/** How the rail attributed the Settlement at `replayKey`, or undefined until it has. */
export async function settlementAttributionOf(
  providers: DemoProviders,
  cast: Cast,
  replayKey: Bytes32,
  fromBlock: number,
): Promise<
  | {
      readonly creditedAgent: Address;
      readonly applied: bigint;
      readonly toPrepaid: bigint;
      readonly coveredByClearing: bigint;
    }
  | undefined
> {
  const logs = await providers.creditcoin.getLogs({
    address: cast.tabBook,
    topics: [SETTLEMENT_APPLIED_TOPIC, replayKey],
    fromBlock,
    toBlock: "latest",
  });
  const found = logs[0];
  if (found === undefined) return undefined;
  const parsed = SETTLEMENT_APPLIED_INTERFACE.decodeEventLog(
    "SettlementApplied",
    found.data,
    found.topics,
  );
  return {
    creditedAgent: parsed[1] as Address,
    applied: parsed[4] as bigint,
    toPrepaid: parsed[5] as bigint,
    coveredByClearing: await clearingReductionOf(providers, cast, replayKey),
  };
}
