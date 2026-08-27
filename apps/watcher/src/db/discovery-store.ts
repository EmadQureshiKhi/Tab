/**
 * Persisting the outcome of chain discovery.
 *
 * Discovery is a read of the precompile; this is what makes its verdict outlive the
 * process. Two things are written:
 *
 * - `chain_cursor.attesting` and `chain_cursor.last_attested_height` for every
 *   chainKey Tab has a descriptor for, monitored or not. Writing the excluded
 *   chains too is the point: it is what turns "chainKey 3 went quiet" into a row
 *   the health endpoint can report, rather than an absence nobody notices (R20.12).
 *
 * ## `chain_cursor.updated_at` is the staleness clock, and that constrains writers
 *
 * It records **when the attested frontier last advanced**, not when the row was
 * last touched. The next discovery subtracts it from the current time to tell a
 * slow chain from a stopped one, so a write that bumps it without the frontier
 * having moved resets the clock and no chain can ever be seen to go quiet. The
 * upsert below therefore bumps it conditionally. Any other writer — observation
 * moving `last_processed_block`, for one — must leave this column alone.
 * - One `endpoint_health` row per configured endpoint of a monitored chain, seeded
 *   once and thereafter owned by the rotation rule (R20.11). The first endpoint in
 *   priority order starts active. Existing rows are left alone, so a restart does
 *   not hand a known-bad endpoint a clean failure count.
 *
 * `last_processed_block` is never written here. Discovery knows the *attested*
 * frontier, not how far logs have been read, and overwriting the read cursor with
 * an attestation height would skip blocks. On insert it starts at 0, which
 * readiness reads as "no cursor yet".
 *
 * Requirements: 20.1, 20.6, 20.12
 */

import { sql } from "drizzle-orm";

import { CHAIN_KEYS, ok, toChainKey, wrap, type ChainKey, type Result } from "@tabai/shared";

import { chainCursor, endpointHealth } from "./schema.js";
import { describeCause } from "../errors.js";
import type { WatcherDb } from "./client.js";
import type { Discovery, PersistedFrontier } from "../discovery.js";

/** What `recordDiscovery` wrote, for the caller's log line. */
export interface DiscoveryWrite {
  readonly attestingChainKeys: readonly ChainKey[];
  readonly quietChainKeys: readonly ChainKey[];
  readonly endpointRowsOffered: number;
}

/**
 * Writes the attesting state of every chain and seeds endpoint health.
 *
 * Idempotent: running it on every discovery refresh converges rather than
 * accumulating.
 */
export async function recordDiscovery(
  db: WatcherDb,
  discovery: Discovery,
): Promise<Result<DiscoveryWrite>> {
  const monitored = new Map<ChainKey, bigint>(
    discovery.monitored.map((chain) => [chain.chainKey, chain.attestedHeight]),
  );

  const cursorRows = CHAIN_KEYS.map((chainKey) => ({
    chainKey: BigInt(chainKey),
    lastProcessedBlock: 0n,
    lastAttestedHeight: monitored.get(chainKey) ?? 0n,
    attesting: monitored.has(chainKey),
    updatedAt: discovery.discoveredAt,
  }));

  const endpointRows = discovery.monitored.flatMap((chain) =>
    chain.endpoints.map((endpointUrl, position) => ({
      chainKey: BigInt(chain.chainKey),
      endpointUrl,
      consecutiveFailures: 0,
      active: position === 0,
    })),
  );

  return wrap(
    async () => {
      await db
        .insert(chainCursor)
        .values(cursorRows)
        .onConflictDoUpdate({
          target: chainCursor.chainKey,
          set: {
            // The read cursor is deliberately absent: only observation moves it.
            //
            // `greatest` rather than assignment: a quiet chain is written with 0,
            // and the last frontier the Watcher actually saw is worth keeping.
            lastAttestedHeight: sql`greatest(${chainCursor.lastAttestedHeight}, excluded.last_attested_height)`,
            attesting: sql`excluded.attesting`,
            // Bumped only when the frontier advances, because this timestamp is
            // the staleness clock. Touching it on every discovery run would reset
            // the clock each time it is read and no chain could ever look quiet.
            updatedAt: sql`case when excluded.last_attested_height > ${chainCursor.lastAttestedHeight} then excluded.updated_at else ${chainCursor.updatedAt} end`,
          },
        });

      if (endpointRows.length > 0) {
        await db.insert(endpointHealth).values(endpointRows).onConflictDoNothing();
      }

      return {
        attestingChainKeys: [...monitored.keys()],
        quietChainKeys: CHAIN_KEYS.filter((chainKey) => !monitored.has(chainKey)),
        endpointRowsOffered: endpointRows.length,
      };
    },
    (error) => ({
      category: "UPSTREAM",
      code: "DISCOVERY_PERSIST_FAILED",
      message: "the discovery outcome could not be written to chain_cursor or endpoint_health",
      retryable: true,
      cause: describeCause(error),
    }),
  );
}

/**
 * The attested frontiers as last written, which is what lets the next discovery
 * tell "advancing slowly" from "stopped".
 *
 * A chain with no row simply yields no entry: the staleness question cannot be
 * asked before there is a previous answer, and inventing one would either invent
 * staleness or hide it.
 */
export async function loadPersistedFrontiers(
  db: WatcherDb,
): Promise<Result<readonly PersistedFrontier[]>> {
  const rows = await wrap(
    () =>
      db
        .select({
          chainKey: chainCursor.chainKey,
          lastAttestedHeight: chainCursor.lastAttestedHeight,
          updatedAt: chainCursor.updatedAt,
        })
        .from(chainCursor),
    (error) => ({
      category: "UPSTREAM",
      code: "CHAIN_CURSOR_READ_FAILED",
      message: "chain_cursor could not be read",
      retryable: true,
      cause: describeCause(error),
    }),
  );
  if (!rows.ok) return rows;

  const frontiers: PersistedFrontier[] = [];
  for (const row of rows.value) {
    const chainKey = toChainKey(row.chainKey);
    // A row for a chainKey Tab has no descriptor for is left where it is rather
    // than deleted: it is somebody else's record of history, not ours to discard.
    if (chainKey === undefined) continue;
    frontiers.push({
      chainKey,
      lastAttestedHeight: row.lastAttestedHeight,
      updatedAt: row.updatedAt,
    });
  }
  return ok(frontiers);
}
