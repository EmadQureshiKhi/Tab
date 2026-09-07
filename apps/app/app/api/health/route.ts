/**
 * `GET /api/health` - build info, and whether the two upstreams answer.
 *
 * A thin adapter and nothing else, matching `/api/settlements`: every decision
 * lives in `serveHealth`, which is a pure function from two probes to a status,
 * headers and a body, so the interesting behaviour is tested without standing up
 * a server or an upstream.
 *
 * Requirements: 24.8, 24.9
 */

import { serveHealth } from "../../../src/dashboard/api-health";
import { toResponse } from "../../../src/dashboard/api-settlements";
import { chain, registry } from "../../_lib/context";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const client = registry();
  const result = await serveHealth({
    chain: chain(),
    registry: { probe: () => client.health() },
  });
  return toResponse(result) as Response;
}
