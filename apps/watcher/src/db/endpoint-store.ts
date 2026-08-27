/**
 * Persisting endpoint rotation (R20.11).
 *
 * `endpoint_health` is seeded by discovery with one row per configured endpoint
 * and the first one active. Rotation owns the rows from then on: the failure
 * count is written on every failure, and a rotation writes both the endpoint
 * that lost the active flag and the one that gained it. Persisting the count is
 * what stops a restart from handing a known-bad endpoint a clean slate.
 *
 * Requirements: 20.11
 */

import { and, eq } from "drizzle-orm";

import { ok, toChainKey, wrap, type ChainKey, type Result } from "@tabai/shared";

import { endpointHealth } from "./schema.js";
import { describeCause } from "../errors.js";
import type { WatcherDb } from "./client.js";
import type { RotationStore } from "../endpoints.js";

/** One persisted endpoint row, as the rotation reads it back. */
export interface PersistedEndpoint {
  readonly chainKey: ChainKey;
  readonly endpointUrl: string;
  readonly consecutiveFailures: number;
  readonly active: boolean;
}

/** Every endpoint row, so a restart resumes on the endpoint it was using. */
export async function loadEndpointHealth(db: WatcherDb): Promise<Result<readonly PersistedEndpoint[]>> {
  const rows = await wrap(
    () => db.select().from(endpointHealth),
    (error) => ({
      category: "UPSTREAM",
      code: "ENDPOINT_HEALTH_READ_FAILED",
      message: "endpoint_health could not be read",
      retryable: true,
      cause: describeCause(error),
    }),
  );
  if (!rows.ok) return rows;
  const persisted: PersistedEndpoint[] = [];
  for (const row of rows.value) {
    const chainKey = toChainKey(row.chainKey);
    if (chainKey === undefined) continue;
    persisted.push({
      chainKey,
      endpointUrl: row.endpointUrl,
      consecutiveFailures: row.consecutiveFailures,
      active: row.active,
    });
  }
  return ok(persisted);
}

/** The persisted active endpoint and its failure count for one chain, if any. */
export function activeEndpointOf(
  rows: readonly PersistedEndpoint[],
  chainKey: ChainKey,
): { readonly url: string; readonly failures: number } | undefined {
  const active = rows.find((row) => row.chainKey === chainKey && row.active);
  return active === undefined ? undefined : { url: active.endpointUrl, failures: active.consecutiveFailures };
}

/** A `RotationStore` over `endpoint_health`. Upserts, so an endpoint discovery never seeded still lands. */
export function createEndpointStore(db: WatcherDb): RotationStore {
  return {
    async record(chainKey, endpointUrl, consecutiveFailures, active) {
      return wrap(
        async () => {
          await db
            .insert(endpointHealth)
            .values({ chainKey: BigInt(chainKey), endpointUrl, consecutiveFailures, active })
            .onConflictDoUpdate({
              target: [endpointHealth.chainKey, endpointHealth.endpointUrl],
              set: { consecutiveFailures, active },
            });
        },
        (error) => ({
          category: "UPSTREAM",
          code: "ENDPOINT_HEALTH_WRITE_FAILED",
          message: `the rotation state of ${endpointUrl} on chainKey ${chainKey} could not be written`,
          retryable: true,
          cause: describeCause(error),
        }),
      );
    },
  };
}

/** Which endpoint rows exist for a chain, for the read-only report. */
export const endpointsOf = (rows: readonly PersistedEndpoint[], chainKey: ChainKey): readonly PersistedEndpoint[] =>
  rows.filter((row) => row.chainKey === chainKey);

