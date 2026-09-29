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
 * **An Asset is only named where it is known.** The launch scope is USDC and
 * AUSD (design decision 1), but an unrecognised Asset renders as its own
 * address rather than being labelled USDC on the assumption that it must be.
 */

import { MAINNET_ASSETS, TESTNET_ASSETS } from "@tabai/shared";

import type {
  AgentAssetRow,
  IdentityAgentRow,
  IdentityRow,
  LabelsRow,
  SettlementRow,
} from "./client.js";

/** Symbol and scale for rendering an amount. Mirrors the composites' `AssetUnit`. */
export interface AssetUnitView {
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * Assets this Dashboard can name, keyed by lowercase address.
 *
 * The Mainnet stablecoins and Circle's Testnet USDC come from `@tabai/shared`.
 * The mock token the deploy script ships to Testnet is deployment output, so
 * it is registered at startup through {@link registerAsset} from the
 * deployment table in `deployments.ts` rather than written here.
 */
const KNOWN_ASSETS = new Map<string, AssetUnitView>(
  [...Object.values(MAINNET_ASSETS), ...Object.values(TESTNET_ASSETS)].map((asset) => [
    asset.address.toLowerCase(),
    { symbol: asset.symbol, decimals: asset.decimals },
  ]),
);

/** Names an Asset this deployment settles in, such as the Testnet mock token. */
export function registerAsset(address: string, unit: AssetUnitView): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return;
  KNOWN_ASSETS.set(address.toLowerCase(), unit);
}

/**
 * The Asset a row is denominated in.
 *
 * An unknown Asset is rendered by its address at zero decimals, so the figure
 * shown is the exact base-unit integer and is not scaled by a guess. Labelling
 * it USDC would be inventing a fact, and scaling by 6 would print a wrong number.
 */
export function assetUnitFor(address: string): AssetUnitView {
  const known = KNOWN_ASSETS.get(address.toLowerCase());
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

/** One Settlement, shaped for `SettlementCard` and the tables. */
export interface SettlementView {
  readonly settlementId: string;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly agent: string;
  readonly serviceId: string;
  readonly serviceName?: string | undefined;
  readonly tier: "permissionless" | "curated";
  readonly asset: AssetUnitView;
  readonly assetAddress: string;
  readonly amountBaseUnits: bigint;
  readonly appliedBaseUnits: bigint;
  readonly prepaidBaseUnits: bigint;
  /** The Open Tab after the Settlement applied, where the index observed it. */
  readonly openAfterBaseUnits?: bigint | undefined;
  readonly collection: string;
  readonly blockTime: string | null;
}

/**
 * Decodes one settlement row.
 *
 * Returns `undefined` where a field the identity depends on will not convert,
 * because a settlement whose figures cannot be read is not a settlement a reader
 * can check against a block, and showing it with zeroes would be worse than not
 * showing it.
 *
 * The tier is taken from the caller rather than the row, because the read API
 * serves tier on the Service and not on each settlement. A caller that has not
 * resolved the Service passes the Permissionless default, which is the tier
 * every Service holds on registration and therefore the safe assumption:
 * it understates credit weight rather than overstating it.
 */
export function toSettlementView(
  row: SettlementRow,
  tier: "permissionless" | "curated" = "permissionless",
): SettlementView | undefined {
  const amount = toBigInt(row.amount);
  const applied = toBigInt(row.applied);
  const prepaid = toBigInt(row.toPrepaid);
  if (amount === undefined || applied === undefined || prepaid === undefined) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(row.settlementId)) return undefined;

  const serviceName = serviceNameOf(row.serviceId);
  const openAfter = toBigInt(row.openAfter);

  return {
    settlementId: row.settlementId.toLowerCase(),
    txHash: row.monad.txHash,
    blockNumber: row.monad.blockNumber,
    logIndex: row.monad.logIndex,
    agent: row.agent,
    serviceId: row.serviceId,
    ...(serviceName === undefined ? {} : { serviceName }),
    tier,
    asset: assetUnitFor(row.asset),
    assetAddress: row.asset,
    amountBaseUnits: amount,
    appliedBaseUnits: applied,
    prepaidBaseUnits: prepaid,
    ...(openAfter === undefined ? {} : { openAfterBaseUnits: openAfter }),
    collection: row.collection,
    blockTime: row.monad.blockTime,
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

/* ----------------------------------------------------------- ERC-8004 identity */

/** One service an ERC-8004 registration file names, reduced to what is shown. */
export interface IdentityServiceView {
  readonly name: string;
  readonly endpoint: string | undefined;
}

/** The reputation summary, as sentences and figures a card can print. */
export interface ReputationView {
  /** Feedback entries the summary spans, as text. Absent where withheld. */
  readonly count: string | undefined;
  readonly clientCount: string | undefined;
  /** The mean, scaled to a decimal by `summaryValueDecimals`. Absent where withheld. */
  readonly summary: string | undefined;
  readonly registry: string | undefined;
  /** Why the summary is absent, in the registry's own words. */
  readonly unavailable: string | undefined;
}

/** One ERC-8004 agent, shaped for `IdentityCard`. Every field is display text. */
export interface IdentityAgentView {
  readonly agentId: string;
  /** The card's `name`, where the card carries one. */
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly owner: string;
  readonly agentWallet: string | undefined;
  readonly matchedBy: readonly ("owner" | "agentWallet")[];
  /** The full URI, for `title` and for copying. */
  readonly agentURI: string | undefined;
  /** The same, shortened for a line of type. */
  readonly agentURIShort: string | undefined;
  /** Where the URI was read, in words: "the index" or "a live tokenURI read". */
  readonly agentURISource: string | undefined;
  /** Why the card is absent, where it is. */
  readonly cardUnavailable: string | undefined;
  readonly cardFetchedAt: string | undefined;
  /** The card's `services` (or `endpoints`) entries that name a service. */
  readonly services: readonly IdentityServiceView[];
  readonly reputation: ReputationView;
  /** The block the agent was registered in, where the index saw it. */
  readonly registeredBlock: number | undefined;
}

/**
 * The identity section of an Agent or a Service operator.
 *
 * `configured` is false where the registry served `null`, which means the
 * Identity registry is switched off for the deployment. That is a different
 * fact from an empty list, and `statement` says which it is.
 */
export interface IdentityView {
  readonly configured: boolean;
  readonly registry: string | undefined;
  readonly basis: string | undefined;
  readonly agents: readonly IdentityAgentView[];
  /** The sentence to show where `agents` is empty. */
  readonly statement: string;
}

/** A string field of an object, or nothing. Never coerces. */
function stringField(record: unknown, key: string): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * The services a registration file names.
 *
 * ERC-8004 registration files list them under `services`; earlier drafts used
 * `endpoints`. Both are read, and an entry with no `name` is not a service a
 * reader can be pointed at, so it is left out rather than shown blank.
 */
function cardServices(card: unknown): readonly IdentityServiceView[] {
  if (typeof card !== "object" || card === null) return [];
  const record = card as Record<string, unknown>;
  const list = Array.isArray(record["services"])
    ? record["services"]
    : Array.isArray(record["endpoints"])
      ? record["endpoints"]
      : [];
  const services: IdentityServiceView[] = [];
  for (const entry of list) {
    const name = stringField(entry, "name");
    if (name === undefined) continue;
    services.push({ name, endpoint: stringField(entry, "endpoint") });
  }
  return services;
}

/**
 * A URI cut down to a line of type, with the scheme kept so a reader knows
 * where the card lives. A `data:` URI is inline JSON and is named as such
 * rather than printed, because its body is the card itself.
 */
export function shortenUri(uri: string): string {
  if (/^data:/i.test(uri)) return `data: URI, ${uri.length} characters inline`;
  if (uri.length <= 56) return uri;
  return `${uri.slice(0, 36)}…${uri.slice(-14)}`;
}

/**
 * A fixed-point integer as decimal text, exactly.
 *
 * String arithmetic on the digits, never a float, so `"45"` at one decimal is
 * `"4.5"` and `"12345"` at four is `"1.2345"`. A value that is not an integer,
 * or a scale that is not a small non-negative integer, yields nothing rather
 * than a guess.
 */
export function fixedPointText(value: string, decimals: number): string | undefined {
  if (!/^-?\d+$/.test(value.trim())) return undefined;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return undefined;
  const negative = value.trim().startsWith("-");
  const digits = value.trim().replace(/^-/, "").replace(/^0+(?=\d)/, "");
  if (decimals === 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction.length === 0 ? "" : `.${fraction}`}`;
}

function toReputationView(row: IdentityAgentRow["reputation"]): ReputationView {
  const summary =
    row.summaryValue === null || row.summaryValueDecimals === null
      ? undefined
      : fixedPointText(row.summaryValue, row.summaryValueDecimals);
  return {
    count: row.count === null ? undefined : String(row.count),
    clientCount: row.clientCount === null ? undefined : String(row.clientCount),
    summary,
    registry: row.registry ?? undefined,
    unavailable: row.unavailable?.message,
  };
}

function toIdentityAgentView(row: IdentityAgentRow): IdentityAgentView {
  const uri = row.agentURI !== null && row.agentURI.length > 0 ? row.agentURI : undefined;
  return {
    agentId: row.agentId,
    name: stringField(row.card, "name"),
    description: stringField(row.card, "description"),
    owner: row.owner,
    agentWallet: row.agentWallet ?? undefined,
    matchedBy: row.matchedBy,
    agentURI: uri,
    agentURIShort: uri === undefined ? undefined : shortenUri(uri),
    agentURISource:
      uri === undefined
        ? undefined
        : row.agentURISource === "chain"
          ? "a live tokenURI read"
          : row.agentURISource === "index"
            ? "the index"
            : undefined,
    cardUnavailable: row.cardUnavailable?.message,
    cardFetchedAt: row.cardFetchedAt ?? undefined,
    services: cardServices(row.card),
    reputation: toReputationView(row.reputation),
    registeredBlock: row.blocks.registered ?? undefined,
  };
}

/** The sentence for an address with no ERC-8004 agent. Exported so a page and a test share one wording. */
export const NO_IDENTITY_STATEMENT = "No ERC-8004 identity is registered for this address.";

/** The sentence for a deployment whose Identity registry is switched off. */
export const IDENTITY_UNCONFIGURED_STATEMENT =
  "No ERC-8004 Identity registry is configured on this deployment, so no registration could be looked up.";

/** The sentence for a registry that served no identity block at all. */
export const IDENTITY_NOT_SERVED_STATEMENT =
  "The registry served no identity block for this address, so nothing is known about an ERC-8004 registration.";

/**
 * Decodes the identity block of an Agent or Service read.
 *
 * `null` and an empty list are kept apart on purpose. `null` means nothing was
 * looked up, because the deployment has no Identity registry; an empty list
 * means the index looked under the stated basis and found no agent. A reader
 * deciding whether an address is somebody's registered agent needs to know
 * which of those they are looking at.
 */
export function toIdentityView(row: IdentityRow | null | undefined): IdentityView {
  if (row === undefined) {
    return { configured: false, registry: undefined, basis: undefined, agents: [], statement: IDENTITY_NOT_SERVED_STATEMENT };
  }
  if (row === null) {
    return { configured: false, registry: undefined, basis: undefined, agents: [], statement: IDENTITY_UNCONFIGURED_STATEMENT };
  }
  return {
    configured: true,
    registry: row.registry,
    basis: row.basis,
    agents: row.agents.map(toIdentityAgentView),
    statement: NO_IDENTITY_STATEMENT,
  };
}

/** One line naming an operator's identity, for a directory row. */
export interface IdentitySummary {
  /** The line to print: a name, or a stated absence. */
  readonly text: string;
  /** True where the line names a registered agent rather than an absence. */
  readonly named: boolean;
}

/**
 * The identity as one line, for the Service directory.
 *
 * The first agent's card name where there is one, the agent id where the card
 * carries no name, and a stated absence otherwise. More than one agent is said
 * in a count rather than listed, because a directory row is not the place for
 * a list.
 */
export function toIdentitySummary(view: IdentityView): IdentitySummary {
  const first = view.agents[0];
  if (first === undefined) {
    return {
      text: view.configured ? "no ERC-8004 identity" : "ERC-8004 identity not configured",
      named: false,
    };
  }
  const label = first.name ?? `ERC-8004 agent #${first.agentId}`;
  const more = view.agents.length > 1 ? ` and ${view.agents.length - 1} more` : "";
  return {
    text: first.name === undefined ? `${label}${more}` : `${label} (ERC-8004 agent #${first.agentId})${more}`,
    named: true,
  };
}

/* ------------------------------------------------------------ Nansen labels */

/** One Nansen label, as chip text. */
export interface LabelView {
  readonly label: string;
  readonly category: string | undefined;
  /** The kinds, joined, where Nansen typed the label. */
  readonly kind: string | undefined;
}

/**
 * The labels strip.
 *
 * `status` says which of five things happened, and `statement` is the sentence
 * for it. A missing key is the normal state of a fresh deployment and reads as
 * a configuration fact, never as a failure.
 */
export interface LabelsView {
  readonly source: "nansen";
  readonly status: "served" | "empty" | "not-configured" | "unavailable" | "not-served";
  readonly statement: string;
  readonly chain: string | undefined;
  readonly fetchedAt: string | undefined;
  readonly entity: string | undefined;
  readonly labels: readonly LabelView[];
}

/** The sentence for a deployment with no Nansen key. */
export const LABELS_UNCONFIGURED_STATEMENT = "Nansen labels are not configured on this deployment.";

/** The sentence every labels strip carries about what labels are not. */
export const LABELS_OFFCHAIN_STATEMENT =
  "Labels are an offchain signal and change nothing in the Credit Limit, which is computed only from onchain history.";

export function toLabelsView(row: LabelsRow | undefined): LabelsView {
  const none = { chain: undefined, fetchedAt: undefined, entity: undefined, labels: [] } as const;
  if (row === undefined) {
    return {
      source: "nansen",
      status: "not-served",
      statement: "The registry served no labels block for this address, so nothing is known from Nansen.",
      ...none,
    };
  }
  if ("unavailable" in row) {
    if (row.unavailable.code === "NANSEN_KEY_MISSING") {
      return { source: "nansen", status: "not-configured", statement: LABELS_UNCONFIGURED_STATEMENT, ...none };
    }
    return {
      source: "nansen",
      status: "unavailable",
      statement: `Nansen labels could not be read: ${row.unavailable.message}.`,
      ...none,
    };
  }
  const labels = row.labels.map((label) => ({
    label: label.label,
    category: label.category,
    kind:
      label.kind === undefined
        ? undefined
        : typeof label.kind === "string"
          ? label.kind
          : label.kind.length === 0
            ? undefined
            : label.kind.join(", "),
  }));
  const where = row.chain === "all" ? "on any chain it covers" : `on ${row.chain}`;
  return {
    source: "nansen",
    status: labels.length === 0 ? "empty" : "served",
    statement:
      labels.length === 0
        ? `Nansen answered and holds no label for this address ${where}.`
        : `${labels.length} Nansen ${labels.length === 1 ? "label" : "labels"} ${where}.`,
    chain: row.chain,
    fetchedAt: row.fetchedAt,
    entity: row.entity,
    labels,
  };
}

/** Default explorer, matching `MONAD_EXPLORER_URL` in the environment contract. */
export const DEFAULT_EXPLORER_URL = "https://testnet.monadvision.com";

/** The decoded name, or the word itself where it does not carry one. */
export function nameOrWord(word: string): string {
  return serviceNameOf(word) ?? word;
}
