// Copied verbatim from `apps/app/src/dashboard/overdue.ts`. Apps may not depend
// on apps, and the keeper must judge a tab exactly as the Dashboard does, so
// the file is duplicated rather than imported. `test/copies.test.mjs` fails
// when this copy and the original diverge below this header.
/**
 * Overdue tabs, and the call an outsider would make.
 *
 * ## Why this page exists
 *
 * `TabBook.markDelinquent` is permissionless. The reason is in the contract: the
 * Service that metered a tab is also the party whose Credit Limit weight
 * benefits from the Agent staying in good standing, so delinquency liveness must
 * not depend on it. Anyone may mark a tab once its Settlement Window has passed,
 * and the mark zeroes the Agent's Credit Limit in that Asset until it settles.
 *
 * That guarantee is worth nothing while no outsider can see which tabs are
 * overdue. A permissionless call nobody can discover the arguments for is a
 * permission in practice. This module is the discovery half.
 *
 * ## Where each figure comes from
 *
 * A tab exists from its first delivery and nothing else creates one, so the
 * candidates are the distinct `(agent, serviceId, asset)` triples that ever had
 * a `DeliveryRecorded`. The registry indexes those and serves them on
 * `/deliveries`, which is where the Dashboard takes them from; {@link
 * scanTabCandidates} reads the same logs straight off the chain for a reader who
 * wants to trust nothing but a node. Monad produces a block every few hundred
 * milliseconds and its public RPC serves a hundred blocks per `eth_getLogs`, so
 * the scan is the slow path by construction and the index is the one a page
 * uses.
 *
 * The state and the window are then read from `tabOf` and
 * `ServiceRegistry.settlementWindowOf` against the chain, at one named block,
 * and never from a stored copy. Somebody else may have marked or settled a tab a
 * moment ago, which makes any cached state stale in a way no indexer can be
 * quick enough to prevent, and a reader deciding whether to send a transaction
 * needs the figure the contract will compare against.
 *
 * ## The clock is the chain's
 *
 * `markDelinquent` compares the window end against `block.timestamp`. So the
 * verdict here compares it against the timestamp of the block the state was read
 * at, not against the viewer's clock. A browser whose clock runs fast would
 * otherwise show a tab as markable a few seconds early and send a reader to spend
 * gas on a certain `SettlementWindowOpen` revert.
 *
 * Every verdict carries the block it was computed at, so a reader can tell how
 * fresh it is instead of assuming.
 */

import { eventTopic0, ok, type Result } from "@tabai/shared";

import {
  addressArg,
  addressFromWord,
  bytes32Arg,
  bytes32FromWord,
  selectorOf,
  uintFromWord,
  wordAt,
  type ChainReader,
} from "./chain.js";

/** `topics[0]` for `DeliveryRecorded`, from the shared table so it cannot drift. */
export const DELIVERY_RECORDED_TOPIC0 = eventTopic0("DeliveryRecorded");

/** `TabBook.tabIdOf(address,bytes32,address)`. */
export const TAB_ID_OF_SELECTOR = selectorOf("tabIdOf(address,bytes32,address)");
/** `TabBook.tabOf(bytes32)`. */
export const TAB_OF_SELECTOR = selectorOf("tabOf(bytes32)");
/** `TabBook.tabRefOf(bytes32)`. */
export const TAB_REF_OF_SELECTOR = selectorOf("tabRefOf(bytes32)");
/** `ServiceRegistry.settlementWindowOf(bytes32)`. */
export const SETTLEMENT_WINDOW_OF_SELECTOR = selectorOf("settlementWindowOf(bytes32)");

/** One tab as `tabOf` reports it. Amounts stay `bigint` until they are rendered. */
export interface TabRecord {
  readonly open: bigint;
  readonly prepaid: bigint;
  readonly oldestUnsettledAt: bigint;
  readonly lastDeliveryAt: bigint;
  readonly deliveryCount: number;
  readonly delinquent: boolean;
}

/** The six-word layout of `Tab`, by position in the returned tuple. */
const TAB_FIELD = {
  open: 0,
  prepaid: 1,
  oldestUnsettledAt: 2,
  lastDeliveryAt: 3,
  deliveryCount: 4,
  delinquent: 5,
} as const;

const shortReturn = (what: string, data: string, words: number): Result<never> => ({
  ok: false,
  error: {
    category: "UPSTREAM",
    code: "TAB_RETURN_SHORT",
    message: `${what} returned ${data.length} characters, too few for a ${words}-word struct`,
    retryable: false,
  },
});

/**
 * Decodes `tabOf` return data.
 *
 * `Tab` is entirely static, so the returned tuple is six words laid out in place
 * with no head offset. That is what makes this six slices rather than a decoder.
 */
export function decodeTab(data: string): Result<TabRecord> {
  const words: string[] = [];
  for (let index = 0; index <= TAB_FIELD.delinquent; index += 1) {
    const word = wordAt(data, index);
    if (word === undefined) return shortReturn("tabOf", data, 6);
    words.push(word);
  }
  return ok({
    open: uintFromWord(words[TAB_FIELD.open] as string),
    prepaid: uintFromWord(words[TAB_FIELD.prepaid] as string),
    oldestUnsettledAt: uintFromWord(words[TAB_FIELD.oldestUnsettledAt] as string),
    lastDeliveryAt: uintFromWord(words[TAB_FIELD.lastDeliveryAt] as string),
    deliveryCount: Number(uintFromWord(words[TAB_FIELD.deliveryCount] as string)),
    delinquent: uintFromWord(words[TAB_FIELD.delinquent] as string) !== 0n,
  });
}

/** One tab's identity, as `tabRefOf` reports it. */
export interface TabRef {
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly exists: boolean;
}

/** Decodes `tabRefOf` return data: four static words. */
export function decodeTabRef(data: string): Result<TabRef> {
  const words: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const word = wordAt(data, index);
    if (word === undefined) return shortReturn("tabRefOf", data, 4);
    words.push(word);
  }
  return ok({
    agent: addressFromWord(words[0] as string),
    serviceId: bytes32FromWord(words[1] as string),
    asset: addressFromWord(words[2] as string),
    exists: uintFromWord(words[3] as string) !== 0n,
  });
}

/** One tab, with the verdict this page exists to publish. */
export interface OverdueTabView {
  readonly tabId: string;
  readonly ref: TabRef;
  readonly tab: TabRecord;
  /** The Service's Settlement Window, in seconds, as the registry holds it now. */
  readonly settlementWindowSeconds: number;
  /** When the window closes, as a chain timestamp. */
  readonly windowEnd: bigint;
  /** Seconds until the window closes against the chain's clock. Negative once passed. */
  readonly secondsUntilWindowEnd: number;
  /** True where the contract would accept a mark at the block this was read at. */
  readonly markable: boolean;
}

/** One tab, named by what `TabBook.tabIdOf` hashes. */
export interface TabCandidate {
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
}

/** Everything the overdue view renders, including how it was arrived at. */
export interface OverdueReport {
  /** The block every state and every verdict below was read at. */
  readonly at: { readonly blockNumber: number; readonly timestamp: number };
  /** Open tabs whose window has passed and that are not yet marked. Markable, oldest first. */
  readonly overdue: readonly OverdueTabView[];
  /** Open tabs whose window has not passed. Not yet markable. */
  readonly pending: readonly OverdueTabView[];
  /** How many distinct tabs were offered, before the state read narrowed them. */
  readonly candidates: number;
}

export interface ScanOptions {
  readonly chain: ChainReader;
  readonly tabBook: string;
  /** First block to scan for candidates. */
  readonly fromBlock: number;
  /** Last block to scan. Defaults to the head at the time of the call. */
  readonly toBlock?: number;
}

/** The distinct tabs a range of blocks opened, plus the range that was read. */
export interface ScannedCandidates {
  readonly candidates: readonly TabCandidate[];
  readonly scanned: { readonly fromBlock: number; readonly toBlock: number };
}

/**
 * Reads every `DeliveryRecorded` off the chain and names the distinct tabs.
 *
 * `DeliveryRecorded` indexes the Agent, the Service and the Asset, which is
 * exactly what names a tab, so a tab with a hundred deliveries appears once.
 * This is the keyless, index-free path; it costs one `eth_getLogs` per hundred
 * blocks and grows with the chain, which is why a page prefers the index.
 */
export async function scanTabCandidates(options: ScanOptions): Promise<Result<ScannedCandidates>> {
  let toBlock = options.toBlock;
  if (toBlock === undefined) {
    const head = await options.chain.latestBlock();
    if (!head.ok) return head;
    toBlock = head.value.number;
  }
  const logs = await options.chain.logs({
    address: options.tabBook,
    topics: [DELIVERY_RECORDED_TOPIC0],
    fromBlock: options.fromBlock,
    toBlock,
  });
  if (!logs.ok) return logs;
  const candidates: TabCandidate[] = [];
  const seen = new Set<string>();
  for (const log of logs.value) {
    const agentTopic = log.topics[1];
    const serviceTopic = log.topics[2];
    const assetTopic = log.topics[3];
    if (agentTopic === undefined || serviceTopic === undefined || assetTopic === undefined) continue;
    const candidate: TabCandidate = {
      agent: addressFromWord(agentTopic.slice(2)),
      serviceId: bytes32FromWord(serviceTopic.slice(2)),
      asset: addressFromWord(assetTopic.slice(2)),
    };
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return ok({ candidates, scanned: { fromBlock: options.fromBlock, toBlock } });
}

/** One tab per `(agent, serviceId, asset)`, whatever case the addresses arrived in. */
export const candidateKey = (candidate: TabCandidate): string =>
  `${candidate.agent.toLowerCase()}:${candidate.serviceId.toLowerCase()}:${candidate.asset.toLowerCase()}`;

/** The distinct tabs among any list of candidates, in first-appearance order. */
export function distinctCandidates(candidates: readonly TabCandidate[]): readonly TabCandidate[] {
  const seen = new Set<string>();
  const out: TabCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

export interface OverdueOptions {
  readonly chain: ChainReader;
  readonly tabBook: string;
  readonly serviceRegistry: string;
  /** The tabs to judge. Duplicates are collapsed. */
  readonly candidates: readonly TabCandidate[];
}

/**
 * Finds every tab among the candidates that an outsider could mark delinquent
 * right now.
 *
 * Every state is read at the one block the head answered, so the verdicts cannot
 * disagree about which block they describe. A tab opened after that block is
 * simply not in this answer.
 */
export async function readOverdueTabs(options: OverdueOptions): Promise<Result<OverdueReport>> {
  const head = await options.chain.latestBlock();
  if (!head.ok) return head;

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of distinctCandidates(options.candidates)) {
    const returned = await options.chain.call(
      options.tabBook,
      `${TAB_ID_OF_SELECTOR}${addressArg(candidate.agent)}${bytes32Arg(candidate.serviceId)}${addressArg(candidate.asset)}`,
      head.value.number,
    );
    if (!returned.ok) return returned;
    const word = wordAt(returned.value, 0);
    if (word === undefined) return shortReturn("tabIdOf", returned.value, 1);
    const tabId = bytes32FromWord(word).toLowerCase();
    if (seen.has(tabId)) continue;
    seen.add(tabId);
    ids.push(tabId);
  }

  const overdue: OverdueTabView[] = [];
  const pending: OverdueTabView[] = [];
  const windows = new Map<string, number>();

  for (const tabId of ids) {
    const tabData = await options.chain.call(options.tabBook, `${TAB_OF_SELECTOR}${bytes32Arg(tabId)}`, head.value.number);
    if (!tabData.ok) return tabData;
    const tab = decodeTab(tabData.value);
    if (!tab.ok) return tab;

    // Only an open, unmarked tab with something unsettled can be marked. Everything
    // else would send a reader to a certain revert.
    if (tab.value.delinquent || tab.value.open === 0n || tab.value.oldestUnsettledAt === 0n) continue;

    const refData = await options.chain.call(options.tabBook, `${TAB_REF_OF_SELECTOR}${bytes32Arg(tabId)}`, head.value.number);
    if (!refData.ok) return refData;
    const ref = decodeTabRef(refData.value);
    if (!ref.ok) return ref;
    if (!ref.value.exists) continue;

    let window = windows.get(ref.value.serviceId);
    if (window === undefined) {
      const windowData = await options.chain.call(
        options.serviceRegistry,
        `${SETTLEMENT_WINDOW_OF_SELECTOR}${bytes32Arg(ref.value.serviceId)}`,
        head.value.number,
      );
      if (!windowData.ok) return windowData;
      const word = wordAt(windowData.value, 0);
      if (word === undefined) return shortReturn("settlementWindowOf", windowData.value, 1);
      window = Number(uintFromWord(word));
      windows.set(ref.value.serviceId, window);
    }

    const windowEnd = tab.value.oldestUnsettledAt + BigInt(window);
    const secondsUntilWindowEnd = Number(windowEnd) - head.value.timestamp;
    const view: OverdueTabView = {
      tabId,
      ref: ref.value,
      tab: tab.value,
      settlementWindowSeconds: window,
      windowEnd,
      secondsUntilWindowEnd,
      // `block.timestamp < windowEnd` reverts, so the end is inclusive: a tab is
      // markable at the window-end second itself.
      markable: secondsUntilWindowEnd <= 0,
    };
    (view.markable ? overdue : pending).push(view);
  }

  const byWindowEnd = (left: OverdueTabView, right: OverdueTabView): number => Number(left.windowEnd - right.windowEnd);

  return ok({
    at: { blockNumber: head.value.number, timestamp: head.value.timestamp },
    overdue: [...overdue].sort(byWindowEnd),
    pending: [...pending].sort(byWindowEnd),
    candidates: ids.length,
  });
}

/**
 * How long ago a window closed, in words.
 *
 * Rendered from the chain's own clock rather than the viewer's, for the reason the
 * module header gives, so this takes seconds rather than reading a clock itself.
 */
export function overdueBy(seconds: number): string {
  const total = Math.abs(Math.trunc(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The exact call an outsider would make, as `cast` would take it.
 *
 * Printed rather than described, and printed with the address and the identifier
 * filled in, because the whole claim of this page is that somebody who did not
 * build Tab can act on what it shows. A reader who has to assemble the calldata
 * themselves has been told about a permissionless mark rather than given one.
 */
export function markCommand(tabBook: string, tabId: string): string {
  return `cast send ${tabBook} "markDelinquent(bytes32)" ${tabId} --rpc-url $MONAD_RPC_URL --private-key $YOUR_KEY`;
}
