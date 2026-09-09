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
 * ## What can and cannot be counted
 *
 * A Settlement emits `Settled` from the surface that moved the money, so the count of
 * distinct external Agents holding at least one Settlement and the settled volume per
 * Asset attributable to them are both exact at the index horizon.
 *
 * The delivery figure counts prepaid-funded deliveries through `PrepaidConsumed` and
 * is a **lower bound** on all deliveries. It is served as one, named as one, and must
 * not be published as a total.
 *
 * ## Attribution
 *
 * Deliveries are classified by the Agent whose tab was charged, and Settlements by the
 * Agent the book names, which on Monad is the account that signed the settlement
 * transaction. There is one address space, so one allowlist.
 */

import { access } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { causeOf, err, ok, type Result } from "@tabai/shared";

/** One address this project controls, with the reason it is ours. */
export interface InternalAddress {
  readonly address: string;
  readonly role: string;
  readonly why: string;
}

/** The allowlist as it is served, addresses already lowercased. */
export interface TeamAddresses {
  readonly network: string;
  readonly chainId: number;
  readonly internal: readonly InternalAddress[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function parseEntries(raw: unknown, field: string): Result<InternalAddress[]> {
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
    entries.push({ address: item.address.toLowerCase(), role: item.role, why: item.why });
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

  const internal = parseEntries(parsed.internal, "internal");
  if (!internal.ok) return internal;

  return ok({
    network: typeof parsed.network === "string" ? parsed.network : "unknown",
    chainId: typeof parsed.chainId === "number" ? parsed.chainId : 0,
    internal: internal.value,
  });
}

/** The classification: everything outside the allowlist is external. */
export interface Classifier {
  isInternal(address: string): boolean;
  isExternal(address: string): boolean;
  /** The role, when the address is ours. Undefined for an external address. */
  roleOf(address: string): string | undefined;
  readonly internalCount: number;
}

/**
 * Builds the classifier over the allowlist. Lookups are case-insensitive, because an
 * address arrives checksummed from some sources and lower-case from the index.
 */
export function createClassifier(team: TeamAddresses): Classifier {
  const roles = new Map(team.internal.map((entry) => [entry.address, entry.role]));
  return {
    isInternal: (address) => roles.has(address.toLowerCase()),
    isExternal: (address) => !roles.has(address.toLowerCase()),
    roleOf: (address) => roles.get(address.toLowerCase()),
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

/** One indexed prepaid draw, which stands in for a Metered Delivery. */
export interface DeliveryDraw {
  readonly agent: string;
  readonly asset: string;
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
  /** Metered Deliveries from external Agents. A LOWER BOUND, see `deliveryBasis`. */
  readonly externalDeliveryLowerBound: number;
  readonly internalDeliveryLowerBound: number;
  /** How each figure was derived, so a third party can reproduce it. */
  readonly basis: {
    readonly agents: string;
    readonly settlements: string;
    readonly volume: string;
    readonly deliveries: string;
    readonly classification: string;
  };
  readonly allowlist: {
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
  "count of indexed PrepaidConsumed events, which fire only on a delivery paid wholly or partly out of prepaid credit. DeliveryRecorded is not indexed, so this is a LOWER BOUND on Metered Deliveries and must not be published as a total";
const CLASSIFICATION_BASIS =
  "every Monad address absent from the `internal` list in team-addresses.json is external. The allowlist is exhaustive by intent, so an omission inflates the external figures rather than suppressing them";

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
  draws: readonly DeliveryDraw[],
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

  let externalDraws = 0;
  let internalDraws = 0;
  for (const draw of draws) {
    if (classifier.isExternal(draw.agent)) externalDraws += 1;
    else internalDraws += 1;
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
    externalDeliveryLowerBound: externalDraws,
    internalDeliveryLowerBound: internalDraws,
    basis: {
      agents: AGENT_BASIS,
      settlements: SETTLEMENT_BASIS,
      volume: VOLUME_BASIS,
      deliveries: DELIVERY_BASIS,
      classification: CLASSIFICATION_BASIS,
    },
    allowlist: { internalCount: classifier.internalCount, path: allowlistPath },
  };
}
