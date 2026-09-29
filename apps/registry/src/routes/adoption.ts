/**
 * `GET /adoption`: the measured adoption split between this project's own addresses
 * and everyone else's.
 *
 * Every figure is exact at the index horizon, and the body says how each was derived
 * in its own words rather than leaving a reader to infer it from a footnote elsewhere.
 *
 * Unauthenticated, like every other read here: the rows restate public chain facts.
 *
 * The counting rule lives in `adoption.ts` and the allowlist in `team-addresses.json`
 * at the repository root, both deliberately outside this file. A third party has to be
 * able to reproduce every published figure, and a rule that only exists inside a route
 * handler is a rule nobody reproduces. The response carries the basis string for each
 * figure so the reader has the derivation in front of them.
 */

import { Hono } from "hono";

import { computeAdoption, createClassifier, type Classifier } from "../adoption.js";
import type { RegistryReads } from "../queries.js";
import { DEFAULT_STREAM } from "../sink.js";

/**
 * Builds the route.
 *
 * The classifier is passed in rather than loaded here, because a route that read a
 * file per request would turn an allowlist edit into a silent mid-flight change of the
 * counting rule. It is loaded once at start, and a start that cannot load it refuses
 * to serve this route at all rather than serving figures under an empty allowlist,
 * which would report every address as external.
 */
export function createAdoptionRoutes(
  reads: RegistryReads,
  classifier: Classifier,
  allowlistPath: string,
): Hono {
  const app = new Hono();

  app.get("/adoption", async (context) => {
    const [index, volumes, deliveries] = await Promise.all([
      reads.horizon(DEFAULT_STREAM),
      reads.settlementVolumeByAgentAsset(),
      reads.deliveryCountsByAgentAsset(),
    ]);

    const metrics = computeAdoption(
      classifier,
      volumes.map((row) => ({
        agent: row.agent,
        asset: row.asset,
        amount: BigInt(row.amount),
        settlementCount: row.settlementCount,
      })),
      deliveries,
      allowlistPath,
    );

    return context.json({ index, ...metrics });
  });

  return app;
}

export { createClassifier };
