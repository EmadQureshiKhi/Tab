/**
 * `GET /adoption`: the measured adoption split (R29.2, R29.3, R29.4, R29.5).
 *
 * The figures are the point, and so is what they are not. Two are exact and one is a
 * lower bound, and the body says which is which in its own words rather than leaving a
 * reader to infer it from a footnote elsewhere. A count of Metered Deliveries served
 * without that caveat would be a smaller number presented as a total, which is the one
 * mistake this route exists to make impossible.
 *
 * Unauthenticated, like every other read here: the rows restate public chain facts.
 *
 * The counting rule lives in `adoption.ts` and the allowlist in `team-addresses.json`
 * at the repository root, both deliberately outside this file. R29.5 asks that a third
 * party reproduce every published figure, and a rule that only exists inside a route
 * handler is a rule nobody reproduces. The response carries the basis string for each
 * figure so the reader has the derivation in front of them.
 *
 * Requirements: 29.1, 29.2, 29.3, 29.4, 29.5
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
    const [index, volumes, draws] = await Promise.all([
      reads.horizon(DEFAULT_STREAM),
      reads.settlementVolumeByAgentAsset(),
      reads.prepaidDraws(),
    ]);

    const metrics = computeAdoption(
      classifier,
      volumes.map((row) => ({
        agent: row.agent,
        asset: row.asset,
        amount: BigInt(row.amount),
        settlementCount: row.settlementCount,
      })),
      draws,
      allowlistPath,
    );

    return context.json({ index, ...metrics });
  });

  return app;
}

export { createClassifier };
