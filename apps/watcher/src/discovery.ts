/**
 * Startup chain discovery, and the degraded mode that falls out of it.
 *
 * The Watcher does not decide which Source Chains it monitors. The ChainInfo
 * Precompile does. At startup — and on every refresh — this module reads
 * `get_supported_chains()` and, for each reported chain,
 * `get_latest_attestation_height_and_hash(chainKey)`, and monitors only the chains
 * that are actively attesting (R20.1, design section 8.1).
 *
 * ## Configuration cannot override discovery
 *
 * Endpoints are an offer, not a declaration. A chainKey the precompile does not
 * report is not monitored however many endpoints are configured for it — the
 * configuration is recorded as inert in {@link Discovery.ignoredConfiguration} and
 * nothing else happens. There is deliberately no flag, no override, and no
 * "force" path: the only input that adds a chain to the monitored set is the
 * precompile read.
 *
 * ## Sepolia-only is a supported mode, not a failure
 *
 * If Mainnet attestation is unavailable, chainKey 3 drops out of the monitored
 * set, everything on chainKey 1 keeps working, and {@link Discovery.mode} reports
 * `DEGRADED` with a reason per excluded chain. Nothing throws and no chain is
 * assumed. The same machinery covers the reverse case and the case where nothing
 * is monitorable at all.
 *
 * ## A chain going quiet is a state, not a crash
 *
 * Two separate questions are asked of every reported chain, and they fail
 * differently:
 *
 * - *Does a frontier exist?* `exists: false`, or an existing record that is a
 *   checkpoint rather than an attestation, means the chain has nothing provable
 *   yet.
 * - *Is the frontier moving?* Attestations land on a stride of 10 source-chain
 *   blocks, roughly every 2 minutes, so a frontier that has not advanced since
 *   the last persisted cursor within {@link ATTESTATION_STALE_AFTER_MS} has gone
 *   quiet. That is `FRONTIER_STALE`: an observable exclusion, reported on the
 *   health endpoint, with the other chain unaffected.
 *
 * The staleness window is 15 minutes, the conservative end of the documented
 * 13-to-15-minute attestation figure. The measured head-to-attested lag is 7 to
 * 8.6 minutes, but that came from samples 155 seconds apart on one day, which
 * establishes liveness and stride rather than a service level — so the window is
 * not tuned to it.
 *
 * Requirements: 20.1, 20.6, 20.12
 */

import {
  CHAINS,
  CHAIN_KEYS,
  err,
  ok,
  toChainKey,
  type ChainKey,
  type Result,
} from "@tabai/shared";

import { endpointsFor, MIN_ENDPOINTS_PER_CHAIN, type WatcherConfig } from "./config.js";
import type { ChainInfoReader, SupportedChain } from "./chain-info.js";

/**
 * How long an unmoved attested frontier may stand before the chain counts as
 * quiet. The conservative documented figure, deliberately not the measured one.
 */
export const ATTESTATION_STALE_AFTER_MS = 15 * 60 * 1000;

/** Why a chain the precompile knows about, or configuration offered, is not monitored. */
export type ExclusionReason =
  /** configuration offered endpoints for a chainKey the precompile does not report */
  | "NOT_REPORTED"
  /** reported, but outside the closed chainKey set Tab has descriptors for */
  | "UNSUPPORTED_BY_TAB"
  /** reported, but the native chain id disagrees with Tab's descriptor for that chainKey */
  | "CHAIN_ID_MISMATCH"
  /** the frontier read itself failed; the other chains are unaffected */
  | "FRONTIER_UNREADABLE"
  /** no attestation record exists for the chain */
  | "NO_ATTESTATION"
  /** the frontier record is a checkpoint, which no proof can be built against */
  | "CHECKPOINT_ONLY"
  /** the frontier has not advanced within the staleness window */
  | "FRONTIER_STALE"
  /** attesting, but no RPC endpoint is configured, so it cannot be observed */
  | "NO_ENDPOINTS"
  /** attesting, but too few endpoints to satisfy the failover rule (R20.11) */
  | "INSUFFICIENT_ENDPOINTS";

/** A chain the Watcher will monitor. */
export interface MonitoredChain {
  readonly chainKey: ChainKey;
  /** Tab's name for the chain. */
  readonly name: string;
  /** The name the precompile reports, kept because the two are independent. */
  readonly attestedName: string;
  readonly evmChainId: number;
  readonly attestedHeight: bigint;
  readonly attestedDigest: string;
  /**
   * The transaction encoding this chain's leaves use, as the precompile reports
   * it. Carried rather than pinned because it decides how a transaction and its
   * receipt are serialised into a Merkle leaf: the raw proof path needs it, and a
   * chain added later with a different encoding must be refused loudly rather than
   * silently producing a wrong root. Both chains report 1 today.
   */
  readonly chainEncoding: number;
  /** Configured endpoints in priority order, ordered by measured range capability. */
  readonly endpoints: readonly string[];
}

/** A chain that will not be monitored, and why. */
export interface ExcludedChain {
  readonly chainKey: bigint;
  readonly reason: ExclusionReason;
  /** One sentence an operator can act on. */
  readonly detail: string;
}

/** Endpoints configured for a chain that discovery will not monitor. */
export interface InertConfiguration {
  readonly chainKey: ChainKey;
  readonly endpointCount: number;
}

/**
 * The attested frontier as last persisted, used to tell "moving slowly" from
 * "stopped". Supplied from `chain_cursor`; an absent entry simply means the
 * question cannot be asked yet.
 */
export interface PersistedFrontier {
  readonly chainKey: ChainKey;
  readonly lastAttestedHeight: bigint;
  /**
   * When this frontier was last observed to **advance**, not when the row was last
   * written. The staleness window is measured from here, so a caller supplying
   * "last touched" instead would report every chain as fresh forever.
   */
  readonly updatedAt: Date;
}

/** Whether every chain Tab knows is monitored, some are, or none are. */
export type DiscoveryMode = "FULL" | "DEGRADED" | "NO_CHAIN_MONITORABLE";

export interface Discovery {
  readonly discoveredAt: Date;
  /** Every chain the precompile reported, undigested, so the raw read stays visible. */
  readonly reported: readonly SupportedChain[];
  readonly monitored: readonly MonitoredChain[];
  readonly excluded: readonly ExcludedChain[];
  readonly ignoredConfiguration: readonly InertConfiguration[];
  readonly mode: DiscoveryMode;
  /**
   * True when Sepolia is the only monitored chain. Named for the mode the design
   * calls out by name, so the health endpoint and the logs can say it plainly.
   */
  readonly sepoliaOnly: boolean;
}

export interface DiscoveryOptions {
  /** Frontiers as last persisted, for the staleness check. */
  readonly previousFrontiers?: readonly PersistedFrontier[];
  /** Injected so the staleness check is testable without waiting. */
  readonly now?: Date;
  /** Overridable so a test can exercise the window without a 15-minute wait. */
  readonly staleAfterMs?: number;
}

/**
 * Reads the precompile and returns the monitored set.
 *
 * Fails as a whole only when `get_supported_chains()` cannot be read: without it
 * nothing is known and monitoring an assumed chain would be worse than stopping.
 * Every per-chain problem is an exclusion instead, so one quiet chain never takes
 * the other down.
 */
export async function discoverChains(
  reader: ChainInfoReader,
  config: WatcherConfig,
  options: DiscoveryOptions = {},
): Promise<Result<Discovery>> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? ATTESTATION_STALE_AFTER_MS;
  const previousByChainKey = new Map<ChainKey, PersistedFrontier>(
    (options.previousFrontiers ?? []).map((entry) => [entry.chainKey, entry]),
  );

  const supported = await reader.getSupportedChains();
  if (!supported.ok) return err(supported.error);

  const reported = supported.value;
  const monitored: MonitoredChain[] = [];
  const excluded: ExcludedChain[] = [];

  for (const entry of reported) {
    const chainKey = toChainKey(entry.chainKey);
    if (chainKey === undefined) {
      excluded.push({
        chainKey: entry.chainKey,
        reason: "UNSUPPORTED_BY_TAB",
        detail: `the precompile reports chainKey ${entry.chainKey} (${entry.chainName}), which Tab holds no chain descriptor or Asset for`,
      });
      continue;
    }

    const descriptor = CHAINS[chainKey];
    if (BigInt(descriptor.evmChainId) !== entry.chainId) {
      excluded.push({
        chainKey: entry.chainKey,
        reason: "CHAIN_ID_MISMATCH",
        detail: `chainKey ${chainKey} is Tab's ${descriptor.name} with chain id ${descriptor.evmChainId}, but the precompile reports chain id ${entry.chainId}`,
      });
      continue;
    }

    const frontier = await reader.getLatestAttestation(entry.chainKey);
    if (!frontier.ok) {
      excluded.push({
        chainKey: entry.chainKey,
        reason: "FRONTIER_UNREADABLE",
        detail: `the attested frontier of chainKey ${chainKey} could not be read: ${frontier.error.message}`,
      });
      continue;
    }

    if (!frontier.value.exists) {
      excluded.push({
        chainKey: entry.chainKey,
        reason: "NO_ATTESTATION",
        detail: `chainKey ${chainKey} is reported but carries no attestation record, so nothing on it is provable yet`,
      });
      continue;
    }

    if (!frontier.value.isAttestation) {
      excluded.push({
        chainKey: entry.chainKey,
        reason: "CHECKPOINT_ONLY",
        detail: `the newest record for chainKey ${chainKey} at height ${frontier.value.height} is a checkpoint rather than an attestation, and checkpoints carry no proof material`,
      });
      continue;
    }

    const previous = previousByChainKey.get(chainKey);
    if (previous !== undefined && previous.lastAttestedHeight >= frontier.value.height) {
      const quietForMs = now.getTime() - previous.updatedAt.getTime();
      if (quietForMs >= staleAfterMs) {
        excluded.push({
          chainKey: entry.chainKey,
          reason: "FRONTIER_STALE",
          detail: `the attested frontier of chainKey ${chainKey} has stood at height ${frontier.value.height} for ${Math.round(quietForMs / 1000)}s, past the ${Math.round(staleAfterMs / 1000)}s staleness window, so the chain has gone quiet`,
        });
        continue;
      }
    }

    const endpoints = endpointsFor(config, chainKey);
    if (endpoints.length === 0) {
      excluded.push({
        chainKey: entry.chainKey,
        reason: "NO_ENDPOINTS",
        detail: `chainKey ${chainKey} is attesting at height ${frontier.value.height} but no RPC endpoint is configured for it, so its Settlements cannot be observed`,
      });
      continue;
    }
    if (endpoints.length < MIN_ENDPOINTS_PER_CHAIN) {
      excluded.push({
        chainKey: entry.chainKey,
        reason: "INSUFFICIENT_ENDPOINTS",
        detail: `chainKey ${chainKey} has ${endpoints.length} configured endpoint, below the ${MIN_ENDPOINTS_PER_CHAIN} the failover rule needs, so a single endpoint failure would stall it silently`,
      });
      continue;
    }

    monitored.push({
      chainKey,
      name: descriptor.name,
      attestedName: entry.chainName,
      evmChainId: descriptor.evmChainId,
      attestedHeight: frontier.value.height,
      attestedDigest: frontier.value.digest,
      chainEncoding: entry.chainEncoding,
      endpoints,
    });
  }

  const reportedChainKeys = new Set(reported.map((entry) => entry.chainKey));
  const ignoredConfiguration: InertConfiguration[] = [];
  for (const chainKey of CHAIN_KEYS) {
    const endpointCount = endpointsFor(config, chainKey).length;
    if (endpointCount === 0) continue;
    if (reportedChainKeys.has(BigInt(chainKey))) continue;
    ignoredConfiguration.push({ chainKey, endpointCount });
    excluded.push({
      chainKey: BigInt(chainKey),
      reason: "NOT_REPORTED",
      detail: `${endpointCount} endpoint(s) are configured for chainKey ${chainKey}, but the precompile does not report it, so it is not monitored — discovery decides the monitored set, not configuration`,
    });
  }

  const monitoredKeys = monitored.map((chain) => chain.chainKey);
  const mode: DiscoveryMode =
    monitoredKeys.length === 0
      ? "NO_CHAIN_MONITORABLE"
      : CHAIN_KEYS.every((chainKey) => monitoredKeys.includes(chainKey))
        ? "FULL"
        : "DEGRADED";

  return ok({
    discoveredAt: now,
    reported,
    monitored,
    excluded,
    ignoredConfiguration,
    mode,
    sepoliaOnly: monitoredKeys.length === 1 && monitoredKeys[0] === 1,
  });
}

/** The chainKeys the Watcher will monitor, in the order discovery found them. */
export function monitoredChainKeys(discovery: Discovery): readonly ChainKey[] {
  return discovery.monitored.map((chain) => chain.chainKey);
}

/**
 * One human-readable line per discovery, so a degraded mode is stated rather than
 * inferred from an absence of log lines.
 */
export function describeDiscovery(discovery: Discovery): string {
  const monitored =
    discovery.monitored.length === 0
      ? "monitoring no chain"
      : `monitoring ${discovery.monitored
          .map(
            (chain) =>
              `chainKey ${chain.chainKey} (${chain.name}) attested to height ${chain.attestedHeight} across ${chain.endpoints.length} endpoints`,
          )
          .join(", ")}`;

  const excluded =
    discovery.excluded.length === 0
      ? ""
      : `; excluded ${discovery.excluded
          .map((chain) => `chainKey ${chain.chainKey} (${chain.reason})`)
          .join(", ")}`;

  // Plain ASCII: this string lands in operator logs and Windows consoles.
  const degraded = discovery.sepoliaOnly
    ? "; Sepolia-only degraded mode, which is supported: everything on chainKey 1 keeps working"
    : "";

  return `discovery ${discovery.mode}: ${monitored}${excluded}${degraded}`;
}
