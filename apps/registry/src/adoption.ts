/**
 * Adoption measurement, and the one rule everything here rests on.
 *
 * **An address is external unless this project controls it.** The allowlist lives at
 * the repository root in `team-addresses.json`, and the direction of the rule is the
 * whole design: an incomplete allowlist can only ever count an insider as an outsider,
 * so every omission inflates a published figure. Defaulting the other way would let a
 * missing entry quietly suppress real adoption, which is the less honest failure but
 * the more flattering one, and that is exactly why it is not the default here.
 *
 * ## What is counted
 *
 * A Settlement emits `Settled` from the surface that moved the money, and a Metered
 * Delivery emits `DeliveryRecorded` from `TabBook`. Both are indexed, so the count of
 * distinct external Agents holding at least one Settlement, the settled volume per
 * Asset attributable to them, and the count of their Metered Deliveries are all exact
 * at the index horizon.
 *
 * ## Attribution
 *
 * Deliveries are classified by the Agent whose tab was charged, and Settlements by the
 * Agent the book names, which on Monad is the account that signed the settlement
 * transaction.
 *
 * ## One file, two networks
 *
 * The same key controls the same address on Mainnet and Testnet, but a contract such
 * as the Mainnet `CurationMultisig` exists on one network only. So every entry names
 * the chain ids it holds on, either itself (`chainIds`) or through the file-wide
 * `networks` list, and the classifier is built for the one chain this process indexes.
 * A file carrying a single top-level `chainId` reads as a one-network allowlist.
 */

import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { causeOf, err, ok, type Result } from "@tabai/shared";

/** One address this project controls, with the reason it is ours. */
export interface InternalAddress {
  readonly address: string;
  readonly role: string;
  readonly why: string;
  /** The Monad chain ids this address is ours on. Never empty. */
  readonly chainIds: readonly number[];
}

/** The allowlist as it is served, addresses already lowercased. */
export interface TeamAddresses {
  readonly network: string;
  /** Every chain id the file covers, ascending. */
  readonly chainIds: readonly number[];
  readonly internal: readonly InternalAddress[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const malformed = (message: string): Result<never> =>
  err({ category: "VALIDATION", code: "TEAM_ADDRESSES_MALFORMED", message, retryable: false });

const isChainId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** A non-empty list of distinct chain ids, or `undefined` when the value is not one. */
function chainIdList(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isChainId)) return undefined;
  return [...new Set(value)];
}

/**
 * The file-wide chain ids an entry without its own inherits: `networks` when present,
 * else the single `chainId`, else none, in which case every entry must name its own.
 */
function fileChainIds(parsed: Record<string, unknown>): Result<number[]> {
  if (parsed.networks !== undefined) {
    const networks = chainIdList(parsed.networks);
    if (networks === undefined) {
      return malformed('team-addresses.json field "networks" must be a non-empty array of chain ids');
    }
    return ok(networks);
  }
  if (parsed.chainId !== undefined) {
    if (!isChainId(parsed.chainId)) return malformed('team-addresses.json field "chainId" must be a positive integer');
    return ok([parsed.chainId]);
  }
  return ok([]);
}

function parseEntries(raw: unknown, field: string, inherited: readonly number[]): Result<InternalAddress[]> {
  if (!Array.isArray(raw)) {
    return err({
      category: "VALIDATION",
      code: "TEAM_ADDRESSES_MALFORMED",
      message: `team-addresses.json field "${field}" must be an array`,
      retryable: false,
    });
  }
  const entries: InternalAddress[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.address !== "string" || !ADDRESS.test(item.address)) {
      return err({
        category: "VALIDATION",
        code: "TEAM_ADDRESSES_MALFORMED",
        message: `team-addresses.json field "${field}" holds an entry with no valid address`,
        retryable: false,
      });
    }
    // The reason is required, not decorative. An entry nobody can check is an entry
    // nobody notices going stale, and a stale allowlist silently understates adoption.
    if (typeof item.role !== "string" || item.role.length === 0 || typeof item.why !== "string" || item.why.length === 0) {
      return err({
        category: "VALIDATION",
        code: "TEAM_ADDRESSES_UNEXPLAINED",
        message: `team-addresses.json entry ${item.address} must carry a non-empty "role" and "why"`,
        retryable: false,
      });
    }
    // An entry scoped to no network would classify nothing anywhere, which reads as an
    // insider list that silently shrank. So it is refused rather than dropped.
    let chainIds: readonly number[] = inherited;
    if (item.chainIds !== undefined) {
      const own = chainIdList(item.chainIds);
      if (own === undefined) {
        return malformed(`team-addresses.json entry ${item.address} has a "chainIds" that is not a non-empty array of chain ids`);
      }
      chainIds = own;
    }
    if (chainIds.length === 0) {
      return malformed(
        `team-addresses.json entry ${item.address} names no chain id, and the file has no "networks" or "chainId" to inherit`,
      );
    }
    entries.push({ address: item.address.toLowerCase(), role: item.role, why: item.why, chainIds });
  }
  return ok(entries);
}

/**
 * Finds `team-addresses.json` by walking up from a starting directory.
 *
 * The file lives at the repository root and this service is started from its own
 * workspace, so resolving against `process.cwd()` finds nothing. Walking up is robust
 * to that and to the `src` and `dist` depth difference, which a path counted in `..`
 * segments is not. Bounded, so a service started outside the repository fails quickly
 * rather than walking to the filesystem root.
 */
export async function findTeamAddresses(startDir: string, maxDepth = 6): Promise<string | undefined> {
  let current = resolve(startDir);
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = resolve(current, "team-addresses.json");
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
  return undefined;
}

/** Reads and validates the allowlist. Never throws; a malformed file is an error value. */
export async function loadTeamAddresses(path: string): Promise<Result<TeamAddresses>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    return err({
      // INTERNAL rather than VALIDATION: the allowlist ships with the repository, so
      // its absence is this project's bug and not a caller's mistake.
      category: "INTERNAL",
      code: "TEAM_ADDRESSES_UNREADABLE",
      message: `team-addresses.json could not be read at ${path}`,
      retryable: false,
      cause: causeOf(error),
    });
  }
  if (!isRecord(parsed)) {
    return err({
      category: "VALIDATION",
      code: "TEAM_ADDRESSES_MALFORMED",
      message: "team-addresses.json must be a JSON object",
      retryable: false,
    });
  }

  const inherited = fileChainIds(parsed);
  if (!inherited.ok) return inherited;

  const internal = parseEntries(parsed.internal, "internal", inherited.value);
  if (!internal.ok) return internal;

  const covered = new Set([...inherited.value, ...internal.value.flatMap((entry) => entry.chainIds)]);
  return ok({
    network: typeof parsed.network === "string" ? parsed.network : "unknown",
    chainIds: [...covered].sort((left, right) => left - right),
    internal: internal.value,
  });
}

/** The classification: everything outside the allowlist is external. */
export interface Classifier {
  isInternal(address: string): boolean;
  isExternal(address: string): boolean;
  /** The role, when the address is ours. Undefined for an external address. */
  roleOf(address: string): string | undefined;
  /** The chain the classifier was built for. */
  readonly chainId: number;
  /** Addresses classified as ours on that chain. */
  readonly internalCount: number;
}

/**
 * Builds the classifier over the allowlist for one chain. Only entries that name
 * `chainId` count as ours, so an address listed for the other network alone is
 * external here. Lookups are case-insensitive, because an address arrives checksummed
 * from some sources and lower-case from the index.
 */
export function createClassifier(team: TeamAddresses, chainId: number): Classifier {
  const roles = new Map(
    team.internal.filter((entry) => entry.chainIds.includes(chainId)).map((entry) => [entry.address, entry.role]),
  );
  return {
    isInternal: (address) => roles.has(address.toLowerCase()),
    isExternal: (address) => !roles.has(address.toLowerCase()),
    roleOf: (address) => roles.get(address.toLowerCase()),
    chainId,
    internalCount: roles.size,
  };
}

/** One Agent's settled volume in one Asset, as indexed. */
export interface AgentAssetVolume {
  readonly agent: string;
  readonly asset: string;
  readonly amount: bigint;
  readonly settlementCount: number;
}

/** One Agent's Metered Deliveries in one Asset, as indexed. */
export interface AgentAssetDeliveries {
  readonly agent: string;
  readonly asset: string;
  readonly deliveryCount: number;
}

/** Settled volume in one Asset, split by who settled it. */
export interface VolumeSplit {
  readonly asset: string;
  readonly externalBaseUnits: string;
  readonly internalBaseUnits: string;
  readonly totalBaseUnits: string;
}

/** Everything the adoption read serves. */
export interface AdoptionMetrics {
  /** Distinct external Agents holding at least one Settlement. Exact. */
  readonly externalAgentCount: number;
  /** Distinct internal Agents holding at least one. Reported so the split is checkable. */
  readonly internalAgentCount: number;
  /** Settlements credited to external Agents. Exact. */
  readonly externalSettlementCount: number;
  readonly internalSettlementCount: number;
  /** Settled volume per Asset, split. Exact. */
  readonly volumeByAsset: readonly VolumeSplit[];
  /** Metered Deliveries charged to external Agents. Exact. */
  readonly externalDeliveryCount: number;
  readonly internalDeliveryCount: number;
  /** How each figure was derived, so a third party can reproduce it. */
  readonly basis: {
    readonly agents: string;
    readonly settlements: string;
    readonly volume: string;
    readonly deliveries: string;
    readonly classification: string;
  };
  readonly allowlist: {
    readonly chainId: number;
    readonly internalCount: number;
    readonly path: string;
  };
}

const AGENT_BASIS =
  "distinct `agent` values across indexed Settled events, classified against team-addresses.json. Exact at the index horizon: a Settlement cannot exist without this event";
const SETTLEMENT_BASIS =
  "count of indexed Settled events by the Agent the book credits, which is the account that signed the transaction. Exact at the index horizon";
const VOLUME_BASIS =
  "sum of Settled.amount grouped by asset and by the classification of the credited Agent. Exact at the index horizon, in Asset base units";
const DELIVERY_BASIS =
  "count of indexed DeliveryRecorded events by the Agent whose tab was charged, classified against team-addresses.json. Exact at the index horizon: TabBook emits one for every Metered Delivery";
const CLASSIFICATION_BASIS =
  "every Monad address absent from the `internal` list in team-addresses.json for the indexed chain id is external. The allowlist is exhaustive by intent, so an omission inflates the external figures rather than suppressing them";

/**
 * Computes the metrics from already-read rows.
 *
 * Pure, and separate from the queries on purpose: the counting rule is the part a
 * third party has to be able to check, and a rule tangled into SQL is a rule nobody
 * reproduces.
 */
export function computeAdoption(
  classifier: Classifier,
  volumes: readonly AgentAssetVolume[],
  deliveries: readonly AgentAssetDeliveries[],
  allowlistPath: string,
): AdoptionMetrics {
  const externalAgents = new Set<string>();
  const internalAgents = new Set<string>();
  let externalSettlements = 0;
  let internalSettlements = 0;
  const byAsset = new Map<string, { external: bigint; internal: bigint }>();

  for (const row of volumes) {
    const agent = row.agent.toLowerCase();
    const asset = row.asset.toLowerCase();
    const external = classifier.isExternal(agent);
    (external ? externalAgents : internalAgents).add(agent);
    if (external) externalSettlements += row.settlementCount;
    else internalSettlements += row.settlementCount;

    const bucket = byAsset.get(asset) ?? { external: 0n, internal: 0n };
    if (external) bucket.external += row.amount;
    else bucket.internal += row.amount;
    byAsset.set(asset, bucket);
  }

  let externalDeliveries = 0;
  let internalDeliveries = 0;
  for (const row of deliveries) {
    if (classifier.isExternal(row.agent)) externalDeliveries += row.deliveryCount;
    else internalDeliveries += row.deliveryCount;
  }

  const volumeByAsset: VolumeSplit[] = [...byAsset.entries()]
    .map(([asset, bucket]) => ({
      asset,
      externalBaseUnits: bucket.external.toString(),
      internalBaseUnits: bucket.internal.toString(),
      totalBaseUnits: (bucket.external + bucket.internal).toString(),
    }))
    .sort((left, right) => left.asset.localeCompare(right.asset));

  return {
    externalAgentCount: externalAgents.size,
    internalAgentCount: internalAgents.size,
    externalSettlementCount: externalSettlements,
    internalSettlementCount: internalSettlements,
    volumeByAsset,
    externalDeliveryCount: externalDeliveries,
    internalDeliveryCount: internalDeliveries,
    basis: {
      agents: AGENT_BASIS,
      settlements: SETTLEMENT_BASIS,
      volume: VOLUME_BASIS,
      deliveries: DELIVERY_BASIS,
      classification: CLASSIFICATION_BASIS,
    },
    allowlist: { chainId: classifier.chainId, internalCount: classifier.internalCount, path: allowlistPath },
  };
}
