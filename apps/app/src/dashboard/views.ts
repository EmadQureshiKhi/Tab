/**
 * View models: the one place an API row becomes something a composite can render.
 *
 * The composites in `components/custom-ui` take precise types, `bigint` amounts
 * and closed unions, while the read API serves decimal text and open strings on
 * purpose so nothing loses precision in transit. This module is the seam between
 * the two, and it is deliberately the only one: a route that decoded a row
 * itself would be a second decoder to keep in step.
 *
 * Three rules hold across everything below.
 *
 * **A conversion that cannot be made is reported, not guessed.** A malformed row
 * yields `undefined` and the caller drops it, rather than rendering a zero that
 * a reader would take for a real figure.
 *
 * **Money is `bigint` from the first moment it stops being text.** No amount
 * passes through `number`, at any width, ever.
 *
 * **An Asset is only named where it is known.** The launch scope is USDC on both
 * chains (design decision 1), but an unrecognised Asset renders as its own
 * address rather than being labelled USDC on the assumption that it must be.
 *
 * Requirements: 24.1, 24.4, 15.7
 */

import { toChainKey, type ChainKey } from "@tabai/shared";

import type { AgentAssetRow, SettlementRow } from "./client.js";

/** Symbol and scale for rendering an amount. Mirrors the composites' `AssetUnit`. */
export interface AssetUnitView {
  readonly symbol: string;
  readonly decimals: number;
}

/** The clearing states the composites accept. Mirrors their `ClearingState`. */
export type ClearingStateView =
  | "provisional"
  | "confirmed"
  | "reversed"
  | "declined"
  | "superseded";

/**
 * Assets this Dashboard can name, keyed by lowercase address.
 *
 * Sepolia USDC is listed here rather than read from `@tabai/shared`'s chain table,
 * because that table still carries the placeholder address with `addressPending`
 * set while `deployments.json` records the real one. Reading `usdcFor(1).address`
 * would yield the zero address and match nothing. That inconsistency belongs to
 * `packages/shared` and is noted rather than worked around silently.
 */
const KNOWN_ASSETS: Readonly<Record<string, AssetUnitView>> = {
  "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": { symbol: "USDC", decimals: 6 },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
};

/**
 * The Asset a row is denominated in.
 *
 * An unknown Asset is rendered by its address at zero decimals, so the figure
 * shown is the exact base-unit integer and is not scaled by a guess. Labelling
 * it USDC would be inventing a fact, and scaling by 6 would print a wrong number.
 */
export function assetUnitFor(address: string): AssetUnitView {
  const known = KNOWN_ASSETS[address.toLowerCase()];
  if (known !== undefined) return known;
  return { symbol: `${address.slice(0, 6)}…${address.slice(-4)}`, decimals: 0 };
}

/**
 * A `bytes32` name is ASCII, right-padded with zeroes. Decoded for display only.
 *
 * `ServiceRegistry` keys a Service by one of these and prices a tool by another,
 * and the SDK's `toolKeyOf` writes both the same way, so one decoder reads both.
 * A word that does not decode is not a name: a Service may key a tool by a hash,
 * and inventing a label for one would be worse than showing the identifier the
 * chain actually holds.
 */
export function serviceNameOf(serviceId: string): string | undefined {
  const body = serviceId.startsWith("0x") ? serviceId.slice(2) : serviceId;
  if (body.length !== 64) return undefined;
  let text = "";
  for (let index = 0; index < body.length; index += 2) {
    const byte = Number.parseInt(body.slice(index, index + 2), 16);
    if (Number.isNaN(byte)) return undefined;
    if (byte === 0) break;
    // Printable ASCII only. Anything else means this id is not a name.
    if (byte < 0x20 || byte > 0x7e) return undefined;
    text += String.fromCharCode(byte);
  }
  return text.length === 0 ? undefined : text;
}

/** A decimal string to `bigint`, or `undefined` where it is not one. */
export function toBigInt(value: string | null | undefined): bigint | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  return BigInt(trimmed);
}

/**
 * The clearing state a settlement's badge shows.
 *
 * `null` from the read API means no Provisional Clearing was ever opened under
 * this replay key, and design section 6.1 draws exactly that transition:
 * `None -> Confirmed` on `applyVerifiedSettlement` with no active clearing. So a
 * settlement that arrived without a provisional stage is confirmed, which is
 * what the badge should say. It is not "unknown" and it is certainly not
 * provisional.
 */
export function clearingStateOf(state: string | null | undefined): ClearingStateView {
  const name = (state ?? "").trim().toLowerCase();
  switch (name) {
    case "applied":
    case "provisional":
      return "provisional";
    case "reversed":
      return "reversed";
    case "declined":
      return "declined";
    case "superseded":
      return "superseded";
    default:
      return "confirmed";
  }
}

/** One Verified Settlement, shaped for `ProofCard`. Mirrors `VerifiedSettlementView`. */
export interface SettlementView {
  readonly replayKey: string;
  readonly chainKey: ChainKey;
  readonly blockHeight: bigint;
  readonly txIndex: bigint;
  readonly logIndex: bigint;
  readonly agent: string;
  readonly serviceId: string;
  readonly serviceName?: string | undefined;
  readonly tier: "permissionless" | "curated";
  readonly asset: AssetUnitView;
  readonly amountBaseUnits: bigint;
  readonly clearing: ClearingStateView;
  readonly creditcoinTxHash?: string | undefined;
  /** Present once a `SettlementApplied` is indexed for the same key. */
  readonly appliedBaseUnits?: bigint | undefined;
  readonly prepaidBaseUnits?: bigint | undefined;
  readonly blockTime: string | null;
}

/**
 * Decodes one settlement row.
 *
 * Returns `undefined` where a field the identity depends on will not convert,
 * because a settlement whose coordinates cannot be read is not a settlement a
 * reader can check against a block, and showing it with zeroes would be worse
 * than not showing it.
 *
 * The tier is taken from the caller rather than the row, because the read API
 * serves tier on the Service and not on each settlement. A caller that has not
 * resolved the Service passes the Permissionless default, which is the tier
 * every Service holds on registration (R11.2) and therefore the safe assumption:
 * it understates credit weight rather than overstating it.
 */
export function toSettlementView(
  row: SettlementRow,
  tier: "permissionless" | "curated" = "permissionless",
  clearingState?: string | null,
): SettlementView | undefined {
  const chainKeyRaw = toBigInt(row.chainKey);
  if (chainKeyRaw === undefined) return undefined;
  const chainKey = toChainKey(chainKeyRaw);
  if (chainKey === undefined) return undefined;

  const blockHeight = toBigInt(row.sourceBlockHeight);
  const txIndex = toBigInt(row.sourceTxIndex);
  const logIndex = toBigInt(row.sourceLogIndex);
  const amount = toBigInt(row.amount);
  if (
    blockHeight === undefined ||
    txIndex === undefined ||
    logIndex === undefined ||
    amount === undefined
  ) {
    return undefined;
  }

  const serviceName = serviceNameOf(row.serviceId);
  const applied = toBigInt(row.application?.applied);
  const prepaid = toBigInt(row.application?.toPrepaid);

  return {
    replayKey: row.replayKey,
    chainKey,
    blockHeight,
    txIndex,
    logIndex,
    agent: row.agent,
    serviceId: row.serviceId,
    ...(serviceName === undefined ? {} : { serviceName }),
    tier,
    asset: assetUnitFor(row.asset),
    amountBaseUnits: amount,
    clearing: clearingStateOf(clearingState),
    creditcoinTxHash: row.creditcoin.txHash,
    ...(applied === undefined ? {} : { appliedBaseUnits: applied }),
    ...(prepaid === undefined ? {} : { prepaidBaseUnits: prepaid }),
    blockTime: row.creditcoin.blockTime,
  };
}

/** Decodes a page of settlements, dropping any row that will not convert. */
export function toSettlementViews(rows: readonly SettlementRow[]): readonly SettlementView[] {
  const views: SettlementView[] = [];
  for (const row of rows) {
    const view = toSettlementView(row);
    if (view !== undefined) views.push(view);
  }
  return views;
}

/** One Asset's credit picture, shaped for `CreditGauge` plus the reasons behind it. */
export interface CreditView {
  readonly asset: AssetUnitView;
  readonly assetAddress: string;
  /** Absent where the index will not serve a figure it cannot cross-check. */
  readonly creditLimitBaseUnits?: bigint | undefined;
  readonly headroomBaseUnits?: bigint | undefined;
  readonly openTabBaseUnits: bigint;
  readonly delinquent: boolean;
  /** Why a figure is absent, in the read API's own words. */
  readonly unavailable?: string | undefined;
  /** True where the served figure was checked against the contract and agreed. */
  readonly crossChecked: boolean;
  readonly settlementCount: number;
  readonly settledTotalBaseUnits: bigint;
  readonly prepaidTotalBaseUnits: bigint;
}

/**
 * Decodes one Asset row of an Agent's credit.
 *
 * The Credit Limit is served only where the read API's own recomputation agreed
 * with `TabBook.creditLimit` on chain, so an absent figure here is a refusal to
 * guess rather than a gap. The refusal is carried through to the view, because
 * "we will not state a number the chain disagrees with" is a stronger thing to
 * show a reader than a plausible number would be.
 */
export function toCreditView(row: AgentAssetRow): CreditView {
  const limit = toBigInt(row.creditLimit.value);
  const headroom = toBigInt(row.headroom.value);
  const openTab = toBigInt(row.openTab.observed) ?? 0n;
  const unavailable = row.creditLimit.unavailable?.message ?? row.headroom.unavailable?.message;

  return {
    asset: assetUnitFor(row.asset),
    assetAddress: row.asset,
    ...(limit === undefined ? {} : { creditLimitBaseUnits: limit }),
    ...(headroom === undefined ? {} : { headroomBaseUnits: headroom }),
    openTabBaseUnits: openTab,
    delinquent: row.delinquency.delinquent,
    ...(unavailable === undefined ? {} : { unavailable }),
    crossChecked: row.creditLimit.crossCheck?.agrees === true,
    settlementCount: row.settlements?.settlementCount ?? 0,
    settledTotalBaseUnits: toBigInt(row.settlements?.settledTotal) ?? 0n,
    prepaidTotalBaseUnits: toBigInt(row.settlements?.prepaidTotal) ?? 0n,
  };
}

/** The Blockscout link for a Creditcoin transaction. */
export function blockscoutTxUrl(txHash: string, explorerUrl: string): string {
  return `${explorerUrl.replace(/\/+$/, "")}/tx/${txHash}`;
}

/** Default explorer, matching `CREDITCOIN_EXPLORER_URL` in the environment contract. */
export const DEFAULT_EXPLORER_URL = "https://creditcoin-testnet.blockscout.com";

/** The decoded name, or the word itself where it does not carry one. */
export function nameOrWord(word: string): string {
  return serviceNameOf(word) ?? word;
}
